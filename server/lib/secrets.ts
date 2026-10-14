import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.ts';

/**
 * Üçüncü taraf anahtarları (Zernio API anahtarı gibi) veritabanında açık
 * metin durmasın diye AES-256-GCM ile şifrelenir. Anahtar KESIT_SECRET'tan
 * türetilir; secret değişirse eski kayıtlar çözülemez ve yeniden bağlanmaları
 * gerekir.
 */
const key = createHash('sha256').update(`kesit:secrets:${config.secret}`).digest();

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function unseal(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  try {
    const [iv, tag, body] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
