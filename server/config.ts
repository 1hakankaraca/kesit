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

function secret(): string {
  const value = process.env.KESIT_SECRET;
  if (value && value.length >= 32) return value;
  if (production) throw new Error('KESIT_SECRET en az 32 karakter olmalı');
  return 'kesit-gelistirme-anahtari-uretimde-kullanmayin';
}

export const config = {
  production,
  port: Number(process.env.PORT) || 3002,
  baseUrl: (process.env.BASE_URL || 'http://localhost:5174').replace(/\/$/, ''),
  dataDir,
  dbPath: path.join(dataDir, 'kesit.db'),
  clipDir: path.resolve(process.env.CLIP_OUTPUT_DIR),
  archiveDir: path.join(dataDir, 'archive'),
  secret: secret(),
  sessionDays: 30,
  kick: {
    clientId: process.env.KICK_CLIENT_ID || '',
    clientSecret: process.env.KICK_CLIENT_SECRET || '',
    redirectUri: process.env.KICK_REDIRECT_URI || '',
  },
  /** Nöbetçi (yayın takibi) kanal yoklama aralığı. */
  autopilotPollMs: Math.max(20_000, Number(process.env.AUTOPILOT_POLL_SECONDS) * 1000 || 45_000),
} as const;

export const kickLoginEnabled = () => !!(config.kick.clientId && config.kick.clientSecret);
