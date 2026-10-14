import axios from 'axios';
import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { config, kickLoginEnabled } from './config.ts';
import type { Row, Store } from './db/Store.ts';

export const SESSION_COOKIE = 'kesit_sid';
const OAUTH_COOKIE = 'kesit_oauth';
const KICK_AUTHORIZE = 'https://id.kick.com/oauth/authorize';
const KICK_TOKEN = 'https://id.kick.com/oauth/token';
const KICK_API = 'https://api.kick.com/public/v1';
/** Yalnız kimlik ve kanal adı okunur; Kesit kullanıcı adına hiçbir şey yazmaz. */
const KICK_SCOPES = 'user:read channel:read';

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
 *  - GET  /auth/kick           → Kick OAuth (PKCE) başlatır
 *  - GET  /auth/kick/callback  → kodu değiştirir, kullanıcıyı oluşturur/günceller
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

  router.get('/kick', (_req, res) => {
    if (!kickLoginEnabled()) {
      res.redirect('/?giris=kick-kapali');
      return;
    }
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    res.cookie(OAUTH_COOKIE, JSON.stringify({ verifier, state }), { ...cookieBase(), maxAge: 10 * 60_000 });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.kick.clientId,
      redirect_uri: config.kick.redirectUri,
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
    if (!pending || typeof req.query.code !== 'string' || req.query.state !== pending.state) {
      res.redirect('/?giris=gecersiz');
      return;
    }
    try {
      const token = await axios.post(
        KICK_TOKEN,
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: config.kick.clientId,
          client_secret: config.kick.clientSecret,
          redirect_uri: config.kick.redirectUri,
          code_verifier: pending.verifier,
          code: req.query.code,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 },
      );
      const auth = { Authorization: `Bearer ${token.data.access_token}` };
      const me = (await axios.get(`${KICK_API}/users`, { headers: auth, timeout: 10_000 })).data?.data?.[0];
      if (!me?.user_id) throw new Error('Kick kullanıcı bilgisi alınamadı');
      const channel = await axios
        .get(`${KICK_API}/channels`, { headers: auth, params: { broadcaster_user_id: me.user_id }, timeout: 10_000 })
        .then((r) => r.data?.data?.[0]?.slug ?? null)
        .catch(() => null);

      const user = store.upsertKickUser({
        kickUserId: String(me.user_id),
        username: me.name || channel || 'kick',
        avatarUrl: me.profile_picture || null,
        channelSlug: channel,
      });

      endSession(store, req, res);
      startSession(store, res, user.id);
      res.redirect('/');
    } catch (err) {
      console.error('[Kick giriş] Başarısız:', (err as Error).message);
      res.redirect('/?giris=hata');
    }
  });

  router.post('/logout', (req, res) => {
    endSession(store, req, res);
    res.json({ ok: true });
  });

  return router;
}

function parseOAuthCookie(value: unknown): { verifier: string; state: string } | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed.verifier === 'string' && typeof parsed.state === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
