import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { CHAT_FPS, chatPlanKey, chatSourceAt, normalizeChatPlan, type ChatRenderPlan, type ChatSegment } from '../../shared/chat.ts';
import { effectiveChatKeySuffix, effectiveChatLayers, effectiveChatSegments } from '../../shared/frame.ts';
import { FORMAT_SIZE, projectDuration, type Project } from '../../shared/project.ts';

/**
 * Sohbet katmanının dışa aktarması.
 *
 * Arayüz her mesajı çıktı çözünürlüğünde bir "satır" olarak çizip uzun
 * sayfalara (PNG) dizer ve bir plan yükler (bkz. shared/chat.ts →
 * ChatRenderPlan). Burada o satırlardan saydam (RGBA) kareler derlenir ve ham
 * video olarak ffmpeg'in standart girdisine akıtılır; ffmpeg bunu diğer
 * katmanların üstüne bindirir. Hangi anda hangi satırların görüneceği zaman
 * çizelgesi → kaynak zamanı eşlemesinden (chatSegments) gelir; yani kesmeler,
 * hız ve gizleme aralıkları önizlemedekiyle aynı kurala uyar.
 */

export interface RgbaImage {
  data: Buffer;
  width: number;
  height: number;
}

export interface ChatOverlayLayer {
  plan: ChatRenderPlan;
  segments: ChatSegment[];
  /** Sayfayı (satır atlası) ya da arka planı ('bg') RGBA olarak yükler. */
  loadPage: (name: number | 'bg') => Promise<RgbaImage>;
}

/** ffmpeg'e verilecek ham video girdisinin geometrisi (karedeki yeri dahil). */
export interface ChatOverlayGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  fps: number;
}

export interface ChatOverlayStream extends ChatOverlayGeometry {
  frames: number;
  /** Kareleri sırayla yazar; ffmpeg erken kapanırsa sessizce durur. */
  feed: (stdin: Writable) => Promise<void>;
}

/** Zamanı `t` ya da öncesi olan son satırın sırası; yoksa -1. */
export function lastRowAt(rows: ChatRenderPlan['rows'], t: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Kutunun alt kenarından yukarı doğru, tamamı sığan satırlar (alttan üste). */
export function visibleRows(plan: ChatRenderPlan, last: number): { row: number; y: number }[] {
  const out: { row: number; y: number }[] = [];
  let y = plan.height - plan.padY;
  for (let i = last; i >= 0; i--) {
    const h = plan.rows[i][3];
    if (y - h < plan.padY) break;
    y -= h;
    out.push({ row: i, y });
  }
  return out;
}

/** `src` (düz alfa) → `dst` üstüne "over" birleştirme; satır satır, aynı genişlikte. */
function blendOver(dst: Buffer, dstOff: number, src: Buffer, srcOff: number, pixels: number) {
  for (let i = 0; i < pixels; i++) {
    const s = srcOff + i * 4;
    const sa = src[s + 3];
    if (sa === 0) continue;
    const d = dstOff + i * 4;
    const da = dst[d + 3];
    if (sa === 255 || da === 0) {
      dst[d] = src[s];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2];
      dst[d + 3] = sa;
      continue;
    }
    const a = sa / 255;
    const b = (da / 255) * (1 - a);
    const outA = a + b;
    dst[d] = Math.round((src[s] * a + dst[d] * b) / outA);
    dst[d + 1] = Math.round((src[s + 1] * a + dst[d + 1] * b) / outA);
    dst[d + 2] = Math.round((src[s + 2] * a + dst[d + 2] * b) / outA);
    dst[d + 3] = Math.round(outA * 255);
  }
}

/**
 * Sohbet kutusunun (plan.width × plan.height) o andaki görüntüsü: arka plan
 * (varsa) + alttan yukarı dizilmiş satırlar. Saf fonksiyon; sayfalar önceden
 * yüklenmiş olmalı.
 */
export function composeChatBox(plan: ChatRenderPlan, last: number, pages: Map<number, RgbaImage>, bg: RgbaImage | null): Buffer {
  const stride = plan.width * 4;
  const box = Buffer.alloc(stride * plan.height);
  if (bg && bg.width === plan.width && bg.height >= plan.height) bg.data.copy(box, 0, 0, box.length);
  for (const { row, y } of visibleRows(plan, last)) {
    const [, pageNo, py, h] = plan.rows[row];
    const page = pages.get(pageNo);
    if (!page || page.width !== plan.width || py + h > page.height) continue;
    if (!bg) page.data.copy(box, y * stride, py * stride, (py + h) * stride);
    else for (let line = 0; line < h; line++) blendOver(box, (y + line) * stride, page.data, (py + line) * stride, plan.width);
  }
  return box;
}

/** Kutuyu akış tuvaline, karedeki yerine göre (kırparak) kopyalar; opaklık alfaya çarpılır. */
export function blitBox(canvas: Buffer, geo: ChatOverlayGeometry, box: Buffer, plan: ChatRenderPlan) {
  const x0 = Math.max(plan.x, geo.x);
  const y0 = Math.max(plan.y, geo.y);
  const x1 = Math.min(plan.x + plan.width, geo.x + geo.width);
  const y1 = Math.min(plan.y + plan.height, geo.y + geo.height);
  if (x1 <= x0 || y1 <= y0) return;
  const w = x1 - x0;
  for (let y = y0; y < y1; y++) {
    const src = ((y - plan.y) * plan.width + (x0 - plan.x)) * 4;
    const dst = ((y - geo.y) * geo.width + (x0 - geo.x)) * 4;
    box.copy(canvas, dst, src, src + w * 4);
    if (plan.opacity < 0.999) for (let i = 0; i < w; i++) canvas[dst + i * 4 + 3] = Math.round(canvas[dst + i * 4 + 3] * plan.opacity);
  }
}

/** Katmanların kare içindeki birleşik kutusu (ham video bu boyutta akar); kare dışındaysa null. */
export function overlayGeometry(plans: ChatRenderPlan[], frameW: number, frameH: number, fps = CHAT_FPS): ChatOverlayGeometry | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of plans) {
    const a = Math.max(0, p.x);
    const b = Math.max(0, p.y);
    const c = Math.min(frameW, p.x + p.width);
    const d = Math.min(frameH, p.y + p.height);
    if (c - a < 2 || d - b < 2) continue;
    x0 = Math.min(x0, a);
    y0 = Math.min(y0, b);
    x1 = Math.max(x1, c);
    y1 = Math.max(y1, d);
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fps };
}

/**
 * Katmanlardan kare akışı kurar. Kare, yalnız bir katmanın görünen satırları
 * değiştiğinde yeniden derlenir; aradaki karelerde aynı tampon yazılır.
 * Yazılan tampon sonradan değiştirilmez (akış onu hâlâ tutuyor olabilir).
 */
export function chatOverlayStream(layers: ChatOverlayLayer[], frameW: number, frameH: number, totalSec: number, fps = CHAT_FPS): ChatOverlayStream | null {
  const usable = layers.filter((l) => l.segments.length && l.plan.width >= 2 && l.plan.height >= 2);
  const geo = overlayGeometry(usable.map((l) => l.plan), frameW, frameH, fps);
  if (!geo) return null;
  const frames = Math.max(1, Math.ceil(totalSec * fps) + 1);
  const size = geo.width * geo.height * 4;

  const feed = async (stdin: Writable) => {
    let open = true;
    const stop = () => {
      open = false;
    };
    stdin.on('error', stop);
    stdin.on('close', stop);
    // Sayfa önbelleği: satırlar zamana göre sıralı olduğundan son birkaç sayfa yeter.
    const caches = usable.map(() => ({ pages: new Map<number, RgbaImage>(), bg: undefined as RgbaImage | null | undefined }));
    const pageFor = async (li: number, no: number) => {
      const cache = caches[li].pages;
      let page = cache.get(no);
      if (!page) {
        page = await usable[li].loadPage(no);
        cache.set(no, page);
        if (cache.size > 4) cache.delete(cache.keys().next().value!);
      }
      return page;
    };
    // Geri basınç: akış dolunca boşalmasını (ya da kapanmasını) bekle; dinleyiciler her seferinde kaldırılır.
    const drained = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          stdin.off('drain', done);
          stdin.off('close', done);
          resolve();
        };
        stdin.once('drain', done);
        stdin.once('close', done);
      });
    let frame = Buffer.alloc(size);
    let prevKey = '';
    try {
      for (let n = 0; n < frames && open; n++) {
        const t = n / fps;
        // -2: sohbet bu anda görünmüyor · -1: görünüyor ama henüz mesaj yok
        const states = usable.map((l) => {
          const src = chatSourceAt(l.segments, t);
          return src === null ? -2 : lastRowAt(l.plan.rows, src);
        });
        const key = states.join(',');
        if (key !== prevKey) {
          prevKey = key;
          const next = Buffer.alloc(size);
          for (let li = 0; li < usable.length; li++) {
            if (states[li] === -2) continue;
            const { plan } = usable[li];
            const c = caches[li];
            if (c.bg === undefined) c.bg = plan.hasBackground ? await usable[li].loadPage('bg') : null;
            const pages = new Map<number, RgbaImage>();
            for (const { row } of visibleRows(plan, states[li])) {
              const no = plan.rows[row][1];
              if (!pages.has(no)) pages.set(no, await pageFor(li, no));
            }
            blitBox(next, geo, composeChatBox(plan, states[li], pages, c.bg), plan);
          }
          frame = next;
        }
        if (!open) break;
        if (!stdin.write(frame)) await drained();
      }
    } finally {
      if (open) stdin.end();
    }
  };
  return { ...geo, frames, feed };
}

/* ── Diskteki plan ve sayfalar ───────────────────────────────────────────── */

/** PNG'yi ffmpeg ile ham RGBA'ya açar (sunucuda ayrı bir görsel kütüphanesi yok). */
export function decodePng(file: string): Promise<RgbaImage> {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { timeout: 20_000 }, (err, stdout) => {
      if (err) return reject(new Error(`Sohbet sayfası okunamadı: ${path.basename(file)}`));
      const [width, height] = String(stdout).trim().split(',').map(Number);
      if (!(width > 0 && height > 0)) return reject(new Error(`Sohbet sayfası bozuk: ${path.basename(file)}`));
      execFile('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer', maxBuffer: width * height * 4 + 1024, timeout: 30_000 }, (err2, data) => {
        if (err2 || data.length !== width * height * 4) return reject(new Error(`Sohbet sayfası açılamadı: ${path.basename(file)}`));
        resolve({ data, width, height });
      });
    });
  });
}

export const chatPageFile = (dir: string, name: number | 'bg') => path.join(dir, name === 'bg' ? 'bg.png' : `page-${name}.png`);

/**
 * Projedeki sohbet katmanları için yüklenmiş planları okuyup kare akışını
 * kurar. Planı olmayan ya da ayarı sonradan değişmiş katman atlanır (uyarıyla).
 */
export function loadChatOverlay(renderDir: string, project: Project, warnings: string[] = []): ChatOverlayStream | null {
  const { w, h } = FORMAT_SIZE[project.format];
  const layers: ChatOverlayLayer[] = [];
  // Yayın çerçevesi aralığında sohbet panele oturur: o aralıklar için türetilmiş (sanal) katmanlar ayrı planla gelir.
  for (const eff of effectiveChatLayers(project)) {
    const { layer } = eff;
    const segments = effectiveChatSegments(project, eff);
    if (!segments.length || layer.opacity <= 0) continue;
    const dir = path.join(renderDir, layer.id);
    let plan: ChatRenderPlan | null = null;
    try {
      plan = normalizeChatPlan(JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')));
    } catch {
      /* plan yok */
    }
    if (!plan || plan.key !== chatPlanKey(layer, project.format) + effectiveChatKeySuffix(eff)) {
      warnings.push(`Sohbet katmanı ${layer.id} hazırlanmamış, atlandı`);
      continue;
    }
    if (!plan.rows.length && !plan.hasBackground) continue;
    layers.push({ plan, segments, loadPage: (name) => decodePng(chatPageFile(dir, name)) });
  }
  if (!layers.length) return null;
  return chatOverlayStream(layers, w, h, Math.max(0.5, projectDuration(project)));
}
