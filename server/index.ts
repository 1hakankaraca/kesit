import { config, kickLoginEnabled } from './config.ts';

import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { Server as IOServer } from 'socket.io';
import { attachUser, authRouter, requireUser, SESSION_COOKIE, userFromSessionId } from './auth.ts';
import type { AppContext } from './context.ts';
import { Store } from './db/Store.ts';
import { VodScanManager } from './engine.ts';
import { errorHandler } from './http.ts';
import { accountRoutes } from './routes/account.ts';
import { clipRoutes } from './routes/clips.ts';
import { liveRoutes } from './routes/live.ts';
import { recordingRoutes } from './routes/recordings.ts';
import { publicKickRoutes, settingsRoutes } from './routes/settings.ts';
import { studioRoutes } from './routes/studio.ts';
import { vodRoutes } from './routes/vods.ts';
import { ArchiveLedger } from './services/ArchiveLedger.ts';
import { Autopilot } from './services/Autopilot.ts';
import { Captions } from './services/Captions.ts';
import { ClipHarvester } from './services/ClipHarvester.ts';
import { Exporter } from './services/Exporter.ts';
import { KickChat } from './services/KickChat.ts';
import { Storage } from './services/Storage.ts';
import { Publishing } from './services/Publishing.ts';
import { Workspaces } from './services/Workspaces.ts';

const app = express();
const server = createServer(app);
const io = new IOServer(server, { serveClient: false });

const store = new Store(config.dbPath);
const exporter = new Exporter(store);
const archive = new ArchiveLedger(store, exporter);
store.setArchiveHooks(archive);
const vodScanner = new VodScanManager({ db: store, io });
const workspaces = new Workspaces(store, io, vodScanner);
const ctx: AppContext = {
  store,
  io,
  workspaces,
  vodScanner,
  archive,
  publishing: new Publishing(store),
  autopilot: new Autopilot(store, io, workspaces, vodScanner),
  captions: new Captions(store, io),
  exporter,
  storage: new Storage(store, workspaces, vodScanner, exporter),
  kickChat: new KickChat(store),
  harvester: new ClipHarvester(store, io, workspaces),
};
ctx.captions.apply();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});
app.use(cookieParser(config.secret));
app.use(express.json({ limit: '1mb' }));
app.use(attachUser(store));

/** Durum değiştiren isteklerde başka siteden gelen çağrıları reddeder (SameSite çerezin yanında ikinci kat). */
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.get('origin');
  if (req.method === 'GET' || req.method === 'HEAD' || !origin) return next();
  if (new URL(origin).host === req.get('host') || origin === config.baseUrl) return next();
  res.status(403).json({ error: 'Geçersiz istek kaynağı' });
});

app.use('/auth', authRouter(store));

app.get('/api/session', (req, res) => {
  res.json({ user: req.user ?? null, kickOAuth: kickLoginEnabled() });
});
app.use('/api', publicKickRoutes());

app.use('/api', requireUser);
for (const routes of [accountRoutes, settingsRoutes, clipRoutes, studioRoutes, vodRoutes, liveRoutes, recordingRoutes]) {
  app.use('/api', routes(ctx));
}

/**
 * Üretilen dosyalar (klipler, kayıtlar, logo, intro/outro). Motor adresleri
 * `/clips/<kullanıcı>/...` biçiminde üretir; yalnız dosyanın sahibi erişir.
 */
app.use('/clips/:owner', requireUser, (req, res, next) => {
  if (String(req.user!.id) !== req.params.owner) {
    res.status(404).end();
    return;
  }
  express.static(path.join(config.clipDir, req.params.owner), { dotfiles: 'deny', index: false, fallthrough: false })(req, res, next);
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Uç bulunamadı' });
});

// Üretimde derlenmiş arayüz bu süreçten sunulur; diğer yollar SPA'ya düşer.
const dist = path.resolve('dist');
if (config.production && fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api|auth|clips|socket\.io).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use(errorHandler);

/* ── Socket.io: oturum çerezinden kullanıcı, kendi odasına katılır ────── */

io.use((socket, next) => {
  const sid = parseSignedCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
  const user = userFromSessionId(store, sid);
  if (!user) return next(new Error('Oturum yok'));
  socket.data.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  void socket.join(`user:${socket.data.userId}`);
});

function parseSignedCookie(header: string | undefined, name: string): string | false {
  if (!header) return false;
  const raw = header
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`));
  if (!raw) return false;
  const value = decodeURIComponent(raw.slice(name.length + 1));
  return value.startsWith('s:') ? cookieParser.signedCookie(value, config.secret) : false;
}

/* ── Açılış ve kapanış ─────────────────────────────────────────────────── */

vodScanner.start();
await ctx.autopilot.restore();
ctx.harvester.restore();
const purge = setInterval(() => store.purgeExpiredSessions(), 6 * 3_600_000);
purge.unref();

server.listen(config.port, () => {
  console.log(`[Kesit] Sunucu hazır → http://localhost:${config.port}`);
  if (!kickLoginEnabled()) console.log('[Kesit] Kick OAuth tanımlı değil — Kick hesabı kanal adıyla bağlanır');
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[Kesit] ${signal} alındı, kapanıyor…`);
  ctx.autopilot.stopAll();
  ctx.harvester.stopAll();
  await workspaces.destroyAll().catch(() => {});
  await vodScanner.close().catch(() => {});
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
