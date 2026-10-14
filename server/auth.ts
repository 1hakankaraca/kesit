import axios from 'axios';
import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.ts';
import type { Row, Store } from './db/Store.ts';
import { fetchChannel, normalizeSlug } from './lib/kick.ts';

export const SESSION_COOKIE = 'kesit_sid';
const OAUTH_COOKIE = 'kesit_oauth';
const KICK_AUTHORIZE = 'https://id.kick.com/oauth/authorize';
const KICK_TOKEN = 'https://id.kick.com/oauth/token';
const KICK_API = 'https://api.kick.com/public/v1';
/** Yalnız sohbete yazma için: kullanıcı "anlık klip" düğmesine basınca "!clip" yazılır. */
const KICK_SCOPES = 'user:read channel:read chat:write';

export interface SessionUser {
  id: number;
  kind: 'kick' | 'guest';
  username: string;
  avatarUrl: string | null;
  channelSlug: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export function toSessionUser(row: Row): SessionUser {
  return {
    id: row.id,
    kind: row.kind,
    username: row.username,
    avatarUrl: row.avatar_url ?? null,
    channelSlug: row.channel_slug ?? null,
  };
}

const cookieBase = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.production,
  signed: true,
  path: '/',
});

const base64url = (buf: Buffer) => buf.toString('base64url');

/** İmzalı oturum çerezinden kullanıcıyı çözer (HTTP ve socket.io ortak kullanır). */
export function userFromSessionId(store: Store, sid: string | false | undefined): SessionUser | null {
  if (!sid) return null;
  const row = store.getSessionUser(sid);
  return row ? toSessionUser(row) : null;
}

export function attachUser(store: Store) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = userFromSessionId(store, req.signedCookies?.[SESSION_COOKIE]);
    if (user) req.user = user;
    next();
  };
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: 'Oturum açmanız gerekiyor' });
    return;
  }
  next();
}

function startSession(store: Store, res: Response, userId: number) {
  const sid = base64url(randomBytes(32));
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
  store.createSession(sid, userId, expires);
  res.cookie(SESSION_COOKIE, sid, { ...cookieBase(), expires });
}

function endSession(store: Store, req: Request, res: Response) {
  const sid = req.signedCookies?.[SESSION_COOKIE];
  if (sid) store.deleteSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * /auth uçları:
 *  - POST /auth/guest          → misafir hesabı açar
 *  - POST /auth/kick/link      → Kick hesabını kanal adıyla bağlar (giriş)
 *  - GET  /auth/kick/connect   → kullanıcının kendi Kick uygulamasıyla sohbet izni (PKCE)
 *  - GET  /auth/kick/callback  → kodu değiştirir, belirteci kullanıcıya ekler
 *  - POST /auth/logout
 * Misafir hesabın işleri Kick hesabına taşınmaz: motor dosyaları kullanıcı
 * kimliğine bağlı dizinlerde tutar, iki hesap ayrı çalışma alanı olarak kalır.
 */
export function authRouter(store: Store): Router {
  const router = express.Router();

  router.post('/guest', (req, res) => {
    if (req.user) {
      res.json({ user: req.user });
      return;
    }
    const suffix = randomBytes(2).toString('hex').toUpperCase();
    const user = store.createGuestUser(`Misafir ${suffix}`);
    startSession(store, res, user.id);
    res.json({ user: toSessionUser(user) });
  });

  /**
   * Kick hesabını kanal adıyla bağlama. Kesit kurulduğu bilgisayarda
   * çalıştığı ve Kick'e hiçbir şey yazmadığı için geliştirici uygulaması
   * (OAuth) gerektirmeyen yol budur: kanal Kick'ten doğrulanır, profil
   * bilgileri herkese açık uçtan alınır.
   */
  router.post('/kick/link', async (req, res) => {
    const slug = normalizeSlug(req.body?.channel);
    if (!slug) {
      res.status(400).json({ error: 'Geçerli bir Kick kanal adı yaz' });
      return;
    }
    const info = await fetchChannel(slug).catch(() => null);
    if (!info) {
      res.status(404).json({ error: 'Bu adla bir Kick kanalı bulunamadı' });
      return;
    }
    const existing = store.findKickUserByChannel(slug);
    const user = store.upsertKickUser({ kickUserId: existing?.kick_user_id ?? `kanal:${slug}`, username: info.username, avatarUrl: info.avatarUrl, channelSlug: slug });
    endSession(store, req, res);
    startSession(store, res, user.id);
    res.json({ user: toSessionUser(user) });
  });

  /**
   * Sohbete yazma izni (anlık klip için) — kullanıcının KENDİ Kick
   * geliştirici uygulamasıyla OAuth. Giriş değildir: oturum açmış kullanıcının
   * hesabına belirteç ekler. Dönüş adresi tarayıcının açık olduğu yerel
   * adresten türetilir; kullanıcı aynı adresi Kick'te uygulamasına kaydeder.
   */
  router.get('/kick/connect', (req, res) => {
    const origin = localOrigin(req.query.origin);
    const back = origin ?? config.baseUrl;
    if (!req.user) {
      res.redirect(`${back}/`);
      return;
    }
    const app = store.getKickApp(req.user.id);
    if (!app || !origin) {
      res.redirect(`${back}/ayarlar?kick=${app ? 'adres' : 'kurulmadi'}`);
      return;
    }
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    const redirectUri = `${origin}/auth/kick/callback`;
    res.cookie(OAUTH_COOKIE, JSON.stringify({ verifier, state, origin, userId: req.user.id }), { ...cookieBase(), maxAge: 10 * 60_000 });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: app.clientId,
      redirect_uri: redirectUri,
      scope: KICK_SCOPES,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      state,
    });
    res.redirect(`${KICK_AUTHORIZE}?${params}`);
  });

  router.get('/kick/callback', async (req, res) => {
    const pending = parseOAuthCookie(req.signedCookies?.[OAUTH_COOKIE]);
    res.clearCookie(OAUTH_COOKIE, { path: '/' });
    const back = pending?.origin ?? config.baseUrl;
    const app = pending && req.user?.id === pending.userId ? store.getKickApp(pending.userId) : null;
    if (!pending || !app || typeof req.query.code !== 'string' || req.query.state !== pending.state) {
      res.redirect(`${back}/ayarlar?kick=${req.query.error ? 'reddedildi' : 'gecersiz'}`);
      return;
    }
    try {
      const token = await axios.post(
        KICK_TOKEN,
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: app.clientId,
          client_secret: app.clientSecret,
          redirect_uri: `${pending.origin}/auth/kick/callback`,
          code_verifier: pending.verifier,
          code: req.query.code,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 },
      );
      const me = (await axios.get(`${KICK_API}/users`, { headers: { Authorization: `Bearer ${token.data.access_token}` }, timeout: 10_000 })).data?.data?.[0];
      store.setKickTokens(pending.userId, {
        accessToken: token.data.access_token,
        refreshToken: token.data.refresh_token || null,
        expiresAt: Date.now() + (Number(token.data.expires_in) || 3600) * 1000,
        account: me?.name ? String(me.name) : null,
      });
      res.redirect(`${back}/ayarlar?kick=baglandi`);
    } catch (err) {
      console.error('[Kick bağlantısı] Başarısız:', (err as Error).message);
      res.redirect(`${back}/ayarlar?kick=hata`);
    }
  });

  router.post('/logout', (req, res) => {
    endSession(store, req, res);
    res.json({ ok: true });
  });

  return router;
}

interface PendingOAuth {
  verifier: string;
  state: string;
  origin: string;
  userId: number;
}

function parseOAuthCookie(value: unknown): PendingOAuth | null {
  if (typeof value !== 'string') return null;
  try {
    const p = JSON.parse(value);
    return typeof p.verifier === 'string' && typeof p.state === 'string' && typeof p.origin === 'string' && Number.isInteger(p.userId) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Yalnız bu bilgisayarın ya da yerel ağın adresine dönülür (localhost,
 * 127.x, 10.x, 172.16-31.x, 192.168.x) — açık yönlendirme olmasın diye.
 */
export function localOrigin(value: unknown): string | null {
  try {
    const u = new URL(String(value));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const h = u.hostname;
    const local = h === 'localhost' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
    return local ? u.origin : null;
  } catch {
    return null;
  }
}
