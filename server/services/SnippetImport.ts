import fs from 'node:fs';
import { execFile, type ChildProcess } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import axios from 'axios';
import { BROWSER_HEADERS, VideoEncoder } from '../engine.ts';

/**
 * Kesitler'e dışarıdan video alma: bilgisayardan yüklenen dosya ya da
 * bağlantıdan (Google Drive paylaşımı veya doğrudan video adresi) indirme.
 * İndirilen/yüklenen dosya tarayıcının oynatabileceği MP4'e çevrilir; H.264 +
 * AAC ise yeniden kodlanmaz, yalnız kap değişir.
 */

/** Tek dosya sınırı (yükleme ve indirme). */
export const IMPORT_MAX_BYTES = 6 * 1024 * 1024 * 1024;
/** HTML yanıtı (Drive uyarı sayfası) en fazla bu kadar okunur. */
const HTML_MAX_BYTES = 2 * 1024 * 1024;

export type ImportSource = 'file' | 'drive' | 'url';

/** Google Drive paylaşım bağlantısından dosya kimliği; Drive değilse null. */
export function driveFileId(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!/(^|\.)(drive|docs)\.google\.com$/.test(host) && host !== 'drive.usercontent.google.com') return null;
  const inPath = u.pathname.match(/\/(?:file\/d|uc|d)\/([\w-]{10,})/);
  if (inPath) return inPath[1];
  const id = u.searchParams.get('id');
  if (id && /^[\w-]{10,}$/.test(id)) return id;
  return null;
}

/** Bağlantı Drive klasörü mü (desteklenmez, dosya bağlantısı gerekir). */
export function isDriveFolder(raw: string) {
  try {
    const u = new URL(String(raw || '').trim());
    return /(^|\.)drive\.google\.com$/.test(u.hostname) && /\/drive\/(u\/\d+\/)?folders\//.test(u.pathname);
  } catch {
    return false;
  }
}

/** Drive'ın doğrudan indirme adresi (büyük dosyalarda virüs taraması uyarısı `confirm=t` ile geçilir). */
export function driveDownloadUrl(id: string) {
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
}

/**
 * Drive "virüs taraması yapılamadı" sayfasındaki formdan gerçek indirme
 * adresini çıkarır (action + gizli alanlar). Form yoksa null.
 */
export function driveConfirmUrl(html: string): string | null {
  const form = html.match(/<form[^>]*id="download-form"[^>]*>([\s\S]*?)<\/form>/i) || html.match(/<form[^>]*action="https:\/\/drive\.usercontent\.google\.com\/download[^"]*"[^>]*>([\s\S]*?)<\/form>/i);
  if (!form) return null;
  const action = form[0].match(/action="([^"]+)"/i)?.[1];
  if (!action) return null;
  const url = new URL(action.replace(/&amp;/g, '&'));
  for (const m of form[1].matchAll(/<input[^>]*>/gi)) {
    const name = m[0].match(/name="([^"]+)"/i)?.[1];
    const value = m[0].match(/value="([^"]*)"/i)?.[1] ?? '';
    if (name) url.searchParams.set(name, value.replace(/&amp;/g, '&'));
  }
  if (!url.searchParams.get('confirm')) url.searchParams.set('confirm', 't');
  return url.toString();
}

/** Drive HTML yanıtından kullanıcıya gösterilecek neden. */
export function driveHtmlError(html: string) {
  const h = html.toLowerCase();
  if (h.includes('quota') || h.includes('kota')) return 'Google Drive bu dosya için indirme sınırına takıldı; biraz sonra tekrar dene ya da dosyayı kendi Drive’ına kopyalayıp onu paylaş';
  if (h.includes('accounts.google.com') || h.includes('signin') || h.includes('need permission') || h.includes('erişim')) return 'Dosya paylaşıma açık değil: Drive’da "Bağlantıya sahip herkes" görüntüleyebilir yap';
  if (h.includes('not found') || h.includes('bulunamadı') || h.includes('404')) return 'Drive dosyası bulunamadı; bağlantı silinmiş ya da yanlış olabilir';
  return 'Google Drive dosyayı vermedi; paylaşım ayarını ve bağlantıyı kontrol et';
}

/** Content-Disposition içinden dosya adı (UTF-8 biçimi öncelikli). */
export function fileNameFrom(disposition: string | undefined, fallbackUrl?: string): string {
  const d = String(disposition || '');
  const star = d.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* bozuk kodlama — düz ada düş */
    }
  }
  const plain = d.match(/filename\s*=\s*"([^"]+)"/) || d.match(/filename\s*=\s*([^;]+)/);
  if (plain) return plain[1].trim();
  try {
    const last = decodeURIComponent(new URL(fallbackUrl || '').pathname.split('/').pop() || '');
    if (last) return last;
  } catch {
    /* adres yok */
  }
  return '';
}

/** Dosya adından başlık: uzantı düşer, alt çizgiler boşluk olur. */
export function titleFromName(name: string, fallback = 'Dışarıdan video') {
  const t = String(name || '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return t || fallback;
}

/** Bağlantı türü: Drive, doğrudan adres; geçersizse hata. */
export function classifyUrl(raw: string): { source: ImportSource; url: string; driveId: string | null } {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Bağlantı boş');
  if (isDriveFolder(text)) throw new Error('Bu bir Drive klasörü bağlantısı; klasörden dosyayı açıp onun bağlantısını yapıştır');
  const driveId = driveFileId(text);
  if (driveId) return { source: 'drive', url: driveDownloadUrl(driveId), driveId };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error('Geçerli bir bağlantı yapıştır (https://…)');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Yalnız http/https bağlantıları indirilebilir');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$|fc|fd)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error('Yerel ağ adresleri indirilemez');
  if (/(^|\.)google\.com$/.test(host)) throw new Error('Drive bağlantısı tanınmadı; dosyanın "Bağlantıyı kopyala" adresini yapıştır (…/file/d/…)');
  return { source: 'url', url: u.toString(), driveId: null };
}

export interface DownloadResult {
  fileName: string;
  bytes: number;
  contentType: string;
}

/**
 * Bağlantıdaki dosyayı diske akıtır. Drive'da ilk yanıt HTML ise uyarı
 * formu çözülüp ikinci istek atılır. `onProgress` indirilen/toplam bayt verir.
 */
export async function downloadToFile(
  url: string,
  target: string,
  { signal, onProgress, maxBytes = IMPORT_MAX_BYTES, isDrive = false }: { signal?: AbortSignal; onProgress?: (bytes: number, total: number | null) => void; maxBytes?: number; isDrive?: boolean } = {},
): Promise<DownloadResult> {
  let current = url;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await axios.get(current, {
      responseType: 'stream',
      maxRedirects: 5,
      signal,
      timeout: 60_000,
      headers: { ...BROWSER_HEADERS, Accept: '*/*' },
      validateStatus: (s) => s >= 200 && s < 400,
    }).catch((err) => {
      const status = err?.response?.status;
      if (status === 404) throw new Error(isDrive ? 'Drive dosyası bulunamadı; bağlantı silinmiş ya da yanlış olabilir' : 'Bağlantıdaki dosya bulunamadı (404)');
      if (status === 403 || status === 401) throw new Error(isDrive ? 'Dosya paylaşıma açık değil: Drive’da "Bağlantıya sahip herkes" görüntüleyebilir yap' : 'Bağlantı erişime kapalı (403)');
      if (err?.code === 'ERR_CANCELED' || signal?.aborted) throw new Error('İptal edildi');
      throw new Error(`İndirilemedi: ${String(err?.message || err).slice(0, 160)}`);
    });
    const type = String(res.headers['content-type'] || '').toLowerCase();
    if (type.startsWith('text/html')) {
      const html = await readText(res.data, HTML_MAX_BYTES);
      const next = isDrive ? driveConfirmUrl(html) : null;
      if (next && next !== current) {
        current = next;
        continue;
      }
      throw new Error(isDrive ? driveHtmlError(html) : 'Bağlantı bir video dosyası değil, web sayfası döndürdü');
    }
    const total = Number(res.headers['content-length']) || null;
    if (total && total > maxBytes) {
      res.data.destroy();
      throw new Error(`Dosya ${Math.round(maxBytes / 1073741824)} GB sınırını aşıyor`);
    }
    let bytes = 0;
    let lastTick = 0;
    const out = fs.createWriteStream(target);
    res.data.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) res.data.destroy(new Error(`Dosya ${Math.round(maxBytes / 1073741824)} GB sınırını aşıyor`));
      const now = Date.now();
      if (onProgress && now - lastTick > 400) {
        lastTick = now;
        onProgress(bytes, total);
      }
    });
    await pipeline(res.data, out).catch((err) => {
      fs.rmSync(target, { force: true });
      if (signal?.aborted || err?.code === 'ERR_CANCELED') throw new Error('İptal edildi');
      throw new Error(String(err?.message || err).slice(0, 200));
    });
    onProgress?.(bytes, total);
    if (bytes === 0) throw new Error('Boş dosya indi');
    return { fileName: fileNameFrom(res.headers['content-disposition'], current), bytes, contentType: type };
  }
  throw new Error('Drive indirme adresi çözülemedi');
}

function readText(stream: NodeJS.ReadableStream & { destroy?: (e?: Error) => void }, max: number) {
  return new Promise<string>((resolve) => {
    const parts: Buffer[] = [];
    let size = 0;
    stream.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= max) parts.push(c);
      else stream.destroy?.();
    });
    stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    stream.on('close', () => resolve(Buffer.concat(parts).toString('utf8')));
    stream.on('error', () => resolve(Buffer.concat(parts).toString('utf8')));
  });
}

export interface ProbeInfo {
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  format: string;
  duration: number;
  width: number;
  height: number;
}

/** ffprobe ile kap/kodek bilgisi; video akışı yoksa hata. */
export function probeMedia(file: string): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration,format_name', '-of', 'json', file],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`Dosya video olarak okunamadı: ${String(stderr || err.message).slice(0, 160)}`));
        let j: any;
        try {
          j = JSON.parse(stdout);
        } catch {
          return reject(new Error('ffprobe çıktısı okunamadı'));
        }
        const video = (j.streams || []).find((s: any) => s.codec_type === 'video' && !['mjpeg', 'png', 'bmp', 'gif'].includes(s.codec_name));
        const audio = (j.streams || []).find((s: any) => s.codec_type === 'audio');
        if (!video) return reject(new Error('Dosyada video akışı yok'));
        resolve({
          hasVideo: true,
          hasAudio: !!audio,
          videoCodec: video.codec_name || null,
          audioCodec: audio?.codec_name || null,
          format: String(j.format?.format_name || ''),
          duration: parseFloat(j.format?.duration) || 0,
          width: video.width || 0,
          height: video.height || 0,
        });
      },
    );
  });
}

/**
 * Kodekler tarayıcı MP4'üne uyuyorsa yalnız kap değiştirilir (hızlı); değilse
 * yeniden kodlanır. Kodlayıcı verilirse (VideoEncoder) GPU bayrakları ve
 * GPU'da çözme kullanılır; verilmezse işlemci (libx264).
 */
export function mp4Args(info: ProbeInfo, src: string, dst: string, encoder: any = null): { args: string[]; copy: boolean } {
  const copy = info.videoCodec === 'h264' && (!info.hasAudio || info.audioCodec === 'aac');
  const enc = encoder || VideoEncoder.cpu('h264');
  const codec = copy
    ? ['-c', 'copy']
    : [...VideoEncoder.videoArgs(enc, { width: info.width, height: info.height }), '-c:a', 'aac', '-b:a', '160k'];
  const decode: string[] = copy ? [] : VideoEncoder.inputArgs(enc);
  return { copy, args: ['-y', '-loglevel', 'error', ...decode, '-i', src, '-map', '0:v:0', ...(info.hasAudio ? ['-map', '0:a:0'] : []), ...codec, '-movflags', '+faststart', dst] };
}

/**
 * Kaynağı MP4'e çevirir; kap değişimi başarısız olursa yeniden kodlamaya
 * düşer. Süreç `onProc` ile dışarı verilir ki iptalde öldürülebilsin.
 */
export async function toMp4(src: string, dst: string, { onProc }: { onProc?: (p: ChildProcess | null) => void } = {}): Promise<ProbeInfo> {
  const info = await probeMedia(src);
  // Yeniden kodlama GPU'da; GPU hata verirse işlemciyle bir kez daha
  const encode = (i: ProbeInfo) =>
    VideoEncoder.withFallback('h264', (enc: any) => ffmpeg(mp4Args(i, src, dst, enc).args, onProc), { label: 'Video içe alma' });
  const first = mp4Args(info, src, dst);
  try {
    if (first.copy) await ffmpeg(first.args, onProc);
    else await encode(info);
  } catch (err) {
    if (!first.copy || VideoEncoder.isAbort(err)) throw err;
    fs.rmSync(dst, { force: true });
    await encode({ ...info, videoCodec: 'yeniden' });
  }
  return info;
}

function ffmpeg(args: string[], onProc?: (p: ChildProcess | null) => void) {
  return new Promise<void>((resolve, reject) => {
    const proc = execFile('ffmpeg', args, { maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
      onProc?.(null);
      if (err) reject(Object.assign(new Error(err.killed || err.signal ? 'İptal edildi' : `ffmpeg hatası: ${String(stderr || err.message).slice(0, 300)}`), { killed: err.killed, signal: err.signal }));
      else resolve();
    });
    onProc?.(proc);
  });
}
