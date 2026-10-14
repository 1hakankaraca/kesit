import axios from 'axios';
import type { Store } from '../db/Store.ts';
import { HttpError, badRequest } from '../http.ts';
import { fetchChannel } from '../lib/kick.ts';

const KICK_TOKEN = 'https://id.kick.com/oauth/token';
const KICK_CHAT = 'https://api.kick.com/public/v1/chat';
/** Sona bu kadar kala belirteç yenilenir. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export const QUICK_CLIP_SECONDS = [30, 60, 90, 120, 180] as const;

/**
 * Kullanıcının Kick hesabıyla sohbete mesaj yazar. Yalnız anlık klip için
 * kullanılır: takip edilen kanalın sohbetine "!clip <sn>" gönderir; kanalda
 * bu komutu dinleyen bir klip botu varsa klip alınır ve sohbete düşen
 * bağlantı Canlı'daki klip yakalayıcıyla otomatik işlenir.
 */
export class KickChat {
  constructor(private store: Store) {}

  connected(userId: number) {
    return !!this.store.getKickTokens(userId);
  }

  /** Ayarlar için durum: kullanıcının uygulaması kurulu mu, hesap bağlı mı. */
  status(userId: number) {
    const app = this.store.getKickApp(userId);
    const tokens = this.store.getKickTokens(userId);
    return {
      configured: !!app,
      clientIdHint: app ? `${app.clientId.slice(0, 6)}…` : null,
      connected: !!tokens,
      account: tokens?.account ?? null,
    };
  }

  /** Kendi Kick uygulamasının bilgilerini kaydeder; değişirse eski bağlantı düşer. */
  saveApp(userId: number, clientId: string, clientSecret: string) {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw badRequest('Client ID geçersiz görünüyor');
    if (secret.length < 16 || /\s/.test(secret)) throw badRequest('Client Secret geçersiz görünüyor');
    const before = this.store.getKickApp(userId);
    if (before?.clientId !== id) this.store.setKickTokens(userId, null);
    this.store.setKickApp(userId, { clientId: id, clientSecret: secret });
    return this.status(userId);
  }

  removeApp(userId: number) {
    this.store.setKickApp(userId, null);
    this.store.setKickTokens(userId, null);
    return this.status(userId);
  }

  disconnect(userId: number) {
    this.store.setKickTokens(userId, null);
    return this.status(userId);
  }

  async sendClipCommand(userId: number, channel: string, seconds: number) {
    if (!QUICK_CLIP_SECONDS.includes(seconds as (typeof QUICK_CLIP_SECONDS)[number])) throw badRequest('Geçersiz süre');
    const info = await fetchChannel(channel).catch(() => null);
    if (!info?.userId) throw badRequest('Kanal bulunamadı');
    const token = await this.accessToken(userId);
    try {
      await axios.post(
        KICK_CHAT,
        { content: `!clip ${seconds}`, type: 'user', broadcaster_user_id: info.userId },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10_000 },
      );
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 401 || status === 403) throw new HttpError(403, 'Kick sohbete yazma izni vermedi — Ayarlar\'dan hesabını yeniden bağla');
      throw new HttpError(502, 'Mesaj Kick sohbetine gönderilemedi');
    }
    return { channel, seconds, live: info.isLive };
  }

  /** Geçerli erişim belirteci; süresi dolmak üzereyse yeniler. */
  private async accessToken(userId: number): Promise<string> {
    const tokens = this.store.getKickTokens(userId);
    if (!tokens) throw new HttpError(403, 'Anlık klip için Ayarlar\'dan Kick uygulamanı kurup hesabını bağla');
    if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) return tokens.accessToken;
    const app = this.store.getKickApp(userId);
    if (!tokens.refreshToken || !app) throw new HttpError(403, 'Kick bağlantısının süresi doldu — Ayarlar\'dan yeniden bağla');
    try {
      const res = await axios.post(
        KICK_TOKEN,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: app.clientId,
          client_secret: app.clientSecret,
          refresh_token: tokens.refreshToken,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 },
      );
      const next = {
        accessToken: res.data.access_token,
        refreshToken: res.data.refresh_token || tokens.refreshToken,
        expiresAt: Date.now() + (Number(res.data.expires_in) || 3600) * 1000,
        account: tokens.account ?? null,
      };
      this.store.setKickTokens(userId, next);
      return next.accessToken;
    } catch {
      this.store.setKickTokens(userId, null);
      throw new HttpError(403, 'Kick bağlantısı yenilenemedi — Ayarlar\'dan yeniden bağla');
    }
  }
}
