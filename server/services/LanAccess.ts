import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Store } from '../db/Store.ts';
import { HttpError } from '../http.ts';

const KEY_ENABLED = 'lan.enabled';
const KEY_DEVICES = 'lan.devices';
const CODE_TTL_MS = 10 * 60_000;
const DEVICE_TTL_MS = 30 * 86_400_000;
const MAX_ATTEMPTS = 8;

interface Device {
  hash: string;
  name: string;
  pairedAt: string;
  expiresAt: number;
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Yerel ağdan (telefon) erişim. Varsayılan kapalıdır. Açıkken bir cihaz,
 * bilgisayar ekranında gösterilen 6 haneli kodu girerek eşlenir; eşlenen
 * cihaza 30 gün geçerli bir belirteç verilir. Böylece aynı Wi-Fi'daki
 * herkes değil, yalnız bilgisayarın başındakinin izin verdiği cihazlar girer.
 * Kod tahminine karşı deneme sayısı sınırlıdır.
 */
export class LanAccess {
  private code: { value: string; expiresAt: number } | null = null;
  private attempts = 0;

  constructor(private store: Store) {}

  get enabled() {
    return this.store.getAppSetting(KEY_ENABLED) === '1';
  }

  setEnabled(on: boolean) {
    this.store.setAppSetting(KEY_ENABLED, on ? '1' : '0');
    if (!on) {
      this.code = null;
      this.store.setAppSetting(KEY_DEVICES, null);
    }
    return this.status();
  }

  status() {
    const code = this.code && this.code.expiresAt > Date.now() ? this.code : null;
    return {
      enabled: this.enabled,
      code: code?.value ?? null,
      codeExpiresAt: code ? new Date(code.expiresAt).toISOString() : null,
      devices: this.devices().map((d) => ({ name: d.name, pairedAt: d.pairedAt })),
    };
  }

  /** Yeni eşleme kodu üretir (öncekini geçersiz kılar). */
  newCode() {
    if (!this.enabled) throw new HttpError(409, 'Önce telefondan erişimi aç');
    this.code = { value: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + CODE_TTL_MS };
    this.attempts = 0;
    return this.status();
  }

  /** Kodu doğrular; doğruysa cihaz belirteci döner (çereze yazılır). */
  pair(input: unknown, deviceName: string): string {
    if (!this.enabled) throw new HttpError(403, 'Bu bilgisayarda telefondan erişim kapalı');
    const code = this.code;
    if (!code || code.expiresAt < Date.now()) throw new HttpError(403, 'Eşleme kodu yok ya da süresi doldu — bilgisayarda yeni kod üret');
    if (++this.attempts > MAX_ATTEMPTS) {
      this.code = null;
      throw new HttpError(429, 'Çok fazla deneme — bilgisayarda yeni kod üret');
    }
    if (String(input ?? '').replace(/\D/g, '') !== code.value) throw new HttpError(403, 'Kod hatalı');
    this.code = null;
    const token = randomBytes(32).toString('base64url');
    const devices = this.devices();
    devices.push({ hash: hashToken(token), name: deviceName.slice(0, 80) || 'Cihaz', pairedAt: new Date().toISOString(), expiresAt: Date.now() + DEVICE_TTL_MS });
    this.store.setAppSetting(KEY_DEVICES, JSON.stringify(devices.slice(-20)));
    return token;
  }

  isPaired(token: unknown): boolean {
    if (!this.enabled || typeof token !== 'string' || !token) return false;
    const h = hashToken(token);
    return this.devices().some((d) => d.hash === h);
  }

  revokeAll() {
    this.store.setAppSetting(KEY_DEVICES, null);
    return this.status();
  }

  private devices(): Device[] {
    try {
      const list = JSON.parse(this.store.getAppSetting(KEY_DEVICES) || '[]') as Device[];
      return list.filter((d) => d.expiresAt > Date.now());
    } catch {
      return [];
    }
  }
}
