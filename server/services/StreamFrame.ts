import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_FRAME_CHAT, type FrameRegions } from '../../shared/frame.ts';
import { FORMAT_SIZE, normalizeCrop, type Rect } from '../../shared/project.ts';
import { config } from '../config.ts';
import { badRequest } from '../http.ts';
import { probe } from '../lib/media.ts';
import { decodePng } from './ChatOverlay.ts';

const run = promisify(execFile);

/**
 * Yayın çerçevesi dosyaları: `frame.png` (1920×1080 RGBA, saydam video
 * pencereli) ve yanında `frame.json` (bölgeler, karenin oranı). Logo gibi
 * saklanır: genel `clips/<kullanıcı>/`, kanal sekmesine özel
 * `clips/<kullanıcı>/brand/<slug>/`.
 */
export const FRAME_FILE = 'frame.png';
export const FRAME_META = 'frame.json';
export const FRAME_MAX_BYTES = 12 * 1024 * 1024;
/** Bu alfanın altı "saydam" sayılır (pencere tespiti). */
export const FRAME_ALPHA_THRESHOLD = 8;
const { w: FRAME_W, h: FRAME_H } = FORMAT_SIZE.horizontal;

export const NO_WINDOW_MESSAGE = 'Çerçevede saydam video penceresi yok — pencereyi saydam bırakıp PNG olarak dışa aktar.';

/**
 * Ham RGBA tamponda alfası eşiğin altında kalan en büyük BİTİŞİK bölgenin
 * sınır kutusu (piksel); hiç saydam piksel yoksa null. Köşelerdeki ufak
 * saydam kırıntılar değil, pencere bulunur.
 */
export function findTransparentWindow(data: Uint8Array, width: number, height: number, threshold = FRAME_ALPHA_THRESHOLD): { x: number; y: number; w: number; h: number; pixels: number } | null {
  const n = width * height;
  if (data.length < n * 4) return null;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let best: { x: number; y: number; w: number; h: number; pixels: number } | null = null;
  for (let start = 0; start < n; start++) {
    if (seen[start] || data[start * 4 + 3] >= threshold) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    while (top > 0) {
      const i = stack[--top];
      const x = i % width;
      const y = (i - x) / width;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // 4 komşu
      if (x > 0 && !seen[i - 1] && data[(i - 1) * 4 + 3] < threshold) (seen[i - 1] = 1), (stack[top++] = i - 1);
      if (x < width - 1 && !seen[i + 1] && data[(i + 1) * 4 + 3] < threshold) (seen[i + 1] = 1), (stack[top++] = i + 1);
      if (y > 0 && !seen[i - width] && data[(i - width) * 4 + 3] < threshold) (seen[i - width] = 1), (stack[top++] = i - width);
      if (y < height - 1 && !seen[i + width] && data[(i + width) * 4 + 3] < threshold) (seen[i + width] = 1), (stack[top++] = i + width);
    }
    if (!best || count > best.pixels) best = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, pixels: count };
  }
  return best;
}

/** Piksel kutusunu karenin oranına çevirir. */
export const windowToRect = (win: { x: number; y: number; w: number; h: number }, width: number, height: number): Rect => normalizeCrop({ x: win.x / width, y: win.y / height, w: win.w / width, h: win.h / height });

/** Çerçeve PNG'sindeki saydam pencereyi bulur (karenin oranı); yoksa anlaşılır hata. */
export async function detectWindow(file: string): Promise<Rect> {
  const img = await decodePng(file).catch(() => {
    throw badRequest('Çerçeve görseli okunamadı');
  });
  const win = findTransparentWindow(img.data, img.width, img.height);
  // Pencere en azından karenin %5'i olsun; daha küçüğü pencere değil, kırıntıdır.
  if (!win || win.w * win.h < img.width * img.height * 0.05) throw badRequest(NO_WINDOW_MESSAGE);
  return windowToRect(win, img.width, img.height);
}

/** Bölge dosyası okunur; bozuksa null. */
export function readRegions(dir: string): FrameRegions | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, FRAME_META), 'utf8')) as Partial<FrameRegions>;
    if (!raw || typeof raw !== 'object' || !raw.window) return null;
    return { window: normalizeCrop(raw.window), chat: raw.chat == null ? null : normalizeCrop(raw.chat) };
  } catch {
    return null;
  }
}

export function writeRegions(dir: string, regions: FrameRegions) {
  fs.writeFileSync(path.join(dir, FRAME_META), JSON.stringify({ window: regions.window, chat: regions.chat }));
}

export interface FrameInfo extends FrameRegions {
  width: number;
  height: number;
}

/**
 * Yüklenen görseli çerçeve olarak kurar: 16:9 olmalı; 1920×1080 değilse
 * ölçeklenir (saydamlık korunur). Saydam pencere bulunur ve bölgeler yazılır;
 * sohbet alanı için varsayılan oran kullanılır (Stüdyo'da düzeltilir).
 */
export async function installFrame(upload: string, dir: string): Promise<FrameInfo> {
  const target = path.join(dir, FRAME_FILE);
  const tmp = path.join(dir, `${FRAME_FILE}.${Date.now()}.tmp.png`);
  try {
    const info = await probe(upload).catch(() => null);
    if (!info?.hasVideo || !info.width || !info.height) throw badRequest('Görsel okunamadı — PNG yükleyin');
    if (Math.abs(info.width / info.height - 16 / 9) > 0.01) throw badRequest(`Çerçeve 16:9 olmalı (1920×1080); bu dosya ${info.width}×${info.height}`);
    // Her durumda ffmpeg'den geçer: boyut 1920×1080'e, biçim RGBA PNG'ye oturur.
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', upload, '-frames:v', '1', '-vf', `scale=${FRAME_W}:${FRAME_H}:flags=lanczos,format=rgba`, tmp], { timeout: 60_000 }).catch(() => {
      throw badRequest('Görsel çevrilemedi');
    });
    const window = await detectWindow(tmp);
    fs.renameSync(tmp, target);
    const regions: FrameRegions = { window, chat: { ...DEFAULT_FRAME_CHAT } };
    writeRegions(dir, regions);
    return { ...regions, width: FRAME_W, height: FRAME_H };
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(upload, { force: true });
  }
}

export function removeFrameFiles(dir: string) {
  fs.rmSync(path.join(dir, FRAME_FILE), { force: true });
  fs.rmSync(path.join(dir, FRAME_META), { force: true });
}

/**
 * Kullanıcının (varsa kanal sekmesine özel) çerçeve klasörü ve dosyası —
 * logo ve abone kesitiyle aynı kural: sekme profili klasörü varsa yalnız
 * oradaki çerçeve geçerlidir; yoksa genel.
 */
export function framePath(userId: number, channelSlug: string | null): { dir: string; file: string } | null {
  const base = path.join(config.clipDir, String(userId));
  if (channelSlug) {
    const dir = path.join(base, 'brand', String(channelSlug).toLowerCase());
    if (fs.existsSync(dir)) {
      const own = path.join(dir, FRAME_FILE);
      return fs.existsSync(own) ? { dir, file: own } : null;
    }
  }
  const file = path.join(base, FRAME_FILE);
  return fs.existsSync(file) ? { dir: base, file } : null;
}
