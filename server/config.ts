import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ortam değişkenlerinden okunan tek yapılandırma noktası. Motor modülleri
 * (server/engine) kendi değişkenlerini doğrudan process.env'den okur;
 * burada yalnız Kesit'in kendi katmanının ihtiyaçları vardır.
 */
const production = process.env.NODE_ENV === 'production';
const dataDir = path.resolve(process.env.DATA_DIR || 'data');

// Motor klip dosyalarını CLIP_OUTPUT_DIR'a yazar; verilmediyse veri dizininin altı.
process.env.CLIP_OUTPUT_DIR ||= path.join(dataDir, 'clips');

/**
 * Çerez imzası ve anahtar şifrelemesi için gizli değer. KESIT_SECRET yoksa
 * ilk açılışta rastgele üretilip veri dizinine (yalnız sahibinin okuyabileceği
 * izinle) yazılır — her kurulumun anahtarı farklıdır, koda gömülü değildir.
 */
function secret(): string {
  const value = process.env.KESIT_SECRET;
  if (value && value.length >= 32) return value;
  const file = path.join(dataDir, '.secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch {
    /* ilk açılış */
  }
  const generated = randomBytes(48).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

export const config = {
  production,
  port: Number(process.env.PORT) || 3002,
  // Tarayıcının açtığı adres: geliştirmede Vite (5174), üretimde sunucunun kendisi.
  baseUrl: (process.env.BASE_URL || (production ? `http://localhost:${Number(process.env.PORT) || 3002}` : 'http://localhost:5174')).replace(/\/$/, ''),
  dataDir,
  dbPath: path.join(dataDir, 'kesit.db'),
  clipDir: path.resolve(process.env.CLIP_OUTPUT_DIR),
  archiveDir: path.join(dataDir, 'archive'),
  secret: secret(),
  sessionDays: 30,
  /** Nöbetçi (yayın takibi) kanal yoklama aralığı. */
  autopilotPollMs: Math.max(20_000, Number(process.env.AUTOPILOT_POLL_SECONDS) * 1000 || 45_000),
} as const;

