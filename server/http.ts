import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSlug } from './lib/kick.ts';
import { isLoopback } from './lib/network.ts';

/** Rota içinden fırlatılan, kullanıcıya gösterilecek hata. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Yalnız bu bilgisayardan (loopback) gelen istekler: bilgisayar geneli
 * ayarlar (altyazı motoru, çıktı klasörü, önbellek, telefon erişimi).
 * Eşlenmiş bir telefon bile bunları değiştiremez.
 */
export function requireLocal(req: Request, _res: Response, next: NextFunction) {
  if (!isLoopback(req.ip)) throw new HttpError(403, 'Bu ayar yalnız Kesit\'in kurulu olduğu bilgisayardan değiştirilebilir');
  next();
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message = 'Bulunamadı') => new HttpError(404, message);

/** Express 5 async hataları buraya düşer; beklenmeyen hatalar iç ayrıntı sızdırmaz. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...err.extra });
    return;
  }
  const e = err as { status?: number; type?: string; message?: string };
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Dosya çok büyük' });
    return;
  }
  console.error('[API] Beklenmeyen hata:', err);
  res.status(500).json({ error: 'Beklenmeyen bir sunucu hatası oluştu' });
}

/**
 * Motor çağrısı: motorun fırlattığı hatalar kullanıcıya anlamlı Türkçe
 * mesajlar taşır; bunları istenen HTTP durumuyla geri döndürür.
 */
export async function engine<T>(task: () => Promise<T> | T, status = 400): Promise<T> {
  try {
    return await task();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(status, (err as Error).message || 'İşlem başarısız');
  }
}

export function intParam(value: unknown, label = 'Kimlik'): number {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(n) || n <= 0) throw badRequest(`${label} geçersiz`);
  return n;
}

export function slugOrThrow(value: unknown): string {
  const slug = normalizeSlug(value);
  if (!slug) throw badRequest('Geçersiz kanal adı');
  return slug;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Gövdedeki tek seferlik üretim seçenekleri (yoksa null). */
export function clipOptionsFrom(body: any): Record<string, unknown> | null {
  const o = body?.options;
  return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
}

/** {platform, accountId} listesini tekilleştirir ve sınırlar. */
export function accountsFrom(raw: unknown): { platform: string; accountId: string }[] {
  const unique = new Map<string, { platform: string; accountId: string }>();
  for (const a of Array.isArray(raw) ? raw.slice(0, 12) : []) {
    if (!a || typeof a.platform !== 'string' || typeof a.accountId !== 'string') continue;
    const platform = a.platform.trim().toLowerCase();
    const accountId = a.accountId.trim();
    if (platform && accountId) unique.set(`${platform}:${accountId}`, { platform, accountId });
  }
  return [...unique.values()];
}

/** Kesit üzerindeki "tam ekran bölgesi" aralıkları — kesite kıstırılır. */
export function camFullFrom(raw: unknown, start: number, end: number) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 50)
    .map((r) => ({ start: Number(r?.start), end: Number(r?.end) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
    .map((r) => ({ start: Math.max(start, Math.min(r.start, r.end)), end: Math.min(end, Math.max(r.start, r.end)) }))
    .filter((r) => r.end > r.start);
}

/**
 * İstek gövdesini (ham dosya) boyut sınırıyla diske akıtır. JSON/base64
 * yerine ham gövde kullanılır ki büyük videolar belleğe şişmesin.
 */
export async function receiveFile(req: Request, target: string, maxBytes: number): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let written = 0;
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(target);
    req.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > maxBytes) {
        req.unpipe(out);
        out.destroy();
        req.resume();
        reject(new HttpError(413, `Dosya ${Math.round(maxBytes / 1048576)} MB sınırını aşıyor`));
      }
    });
    req.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    req.pipe(out);
  }).catch((err) => {
    fs.rmSync(target, { force: true });
    throw err;
  });
}

/** İndirme adı: Türkçe karakterleri koruyup dosya sistemine uygun hale getirir. */
export function downloadName(title: string | null | undefined, fallback: string, ext = '.mp4') {
  const clean = String(title || '')
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${clean || fallback}${ext}`;
}
