import axios from 'axios';
import { config } from '../config.ts';
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
      if (status === 401 || status === 403) throw new HttpError(403, 'Kick sohbete yazma izni vermedi — çıkış yapıp Kick ile yeniden giriş yap');
      throw new HttpError(502, 'Mesaj Kick sohbetine gönderilemedi');
    }
    return { channel, seconds, live: info.isLive };
  }

  /** Geçerli erişim belirteci; süresi dolmak üzereyse yeniler. */
  private async accessToken(userId: number): Promise<string> {
    const tokens = this.store.getKickTokens(userId);
    if (!tokens) throw new HttpError(403, 'Anlık klip için Kick ile giriş yapman gerekiyor');
    if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) return tokens.accessToken;
    if (!tokens.refreshToken) throw new HttpError(403, 'Kick oturumunun süresi doldu — yeniden giriş yap');
    try {
      const res = await axios.post(
        KICK_TOKEN,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: config.kick.clientId,
          client_secret: config.kick.clientSecret,
          refresh_token: tokens.refreshToken,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 },
      );
      const next = {
        accessToken: res.data.access_token,
        refreshToken: res.data.refresh_token || tokens.refreshToken,
        expiresAt: Date.now() + (Number(res.data.expires_in) || 3600) * 1000,
      };
      this.store.setKickTokens(userId, next);
      return next.accessToken;
    } catch {
      this.store.setKickTokens(userId, null);
      throw new HttpError(403, 'Kick oturumu yenilenemedi — yeniden giriş yap');
    }
  }
}
