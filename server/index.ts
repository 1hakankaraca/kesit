import { config } from './config.ts';

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
import { errorHandler, requireLocal } from './http.ts';
import { isAllowedHost, isLoopback, isPrivateIp, plainIp } from './lib/network.ts';
import { accountRoutes } from './routes/account.ts';
import { clipRoutes } from './routes/clips.ts';
import { liveRoutes } from './routes/live.ts';
import { recordingRoutes } from './routes/recordings.ts';
import { projectRoutes } from './routes/projects.ts';
import { publicKickRoutes, settingsRoutes } from './routes/settings.ts';
import { systemRoutes } from './routes/system.ts';
import { studioRoutes } from './routes/studio.ts';
import { taskRoutes } from './routes/tasks.ts';
import { vodRoutes } from './routes/vods.ts';
import { ArchiveLedger } from './services/ArchiveLedger.ts';
import { Autopilot } from './services/Autopilot.ts';
import { Captions } from './services/Captions.ts';
import { ClipHarvester } from './services/ClipHarvester.ts';
import { Exporter } from './services/Exporter.ts';
import { KickChat } from './services/KickChat.ts';
import { LanAccess } from './services/LanAccess.ts';
import { Retention } from './services/Retention.ts';
import { Storage } from './services/Storage.ts';
import { Projects } from './services/Projects.ts';
import { Publishing } from './services/Publishing.ts';
import { SystemMonitor } from './services/SystemMonitor.ts';
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
const harvester = new ClipHarvester(store, io, workspaces);
const ctx: AppContext = {
  store,
  io,
  workspaces,
  vodScanner,
  archive,
  publishing: new Publishing(store),
  autopilot: new Autopilot(store, io, workspaces, vodScanner, harvester),
  captions: new Captions(store, io),
  exporter,
  storage: new Storage(store, workspaces, vodScanner, exporter),
  kickChat: new KickChat(store),
  harvester,
  projects: new Projects(store, io),
  system: new SystemMonitor(),
};
ctx.captions.apply();
ctx.system.start();
const lan = new LanAccess(store);
const retention = new Retention(store);
const LAN_COOKIE = 'kesit_lan';

/** Geliştirmede Vite vekili X-Forwarded-For ekler; yalnız loopback'ten gelen vekile güvenilir. */
function clientIp(remote: string | undefined, forwarded: string | string[] | undefined) {
  const fwd = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return isLoopback(remote) && fwd ? plainIp(fwd.split(',')[0].trim()) : plainIp(remote);
}

/** Bu istek kabul edilebilir mi: bilgisayarın kendisi ya da eşlenmiş yerel ağ cihazı. */
function networkVerdict(ip: string, host: string | undefined, lanToken: unknown): 'local' | 'paired' | 'unpaired' | 'blocked' {
  if (!isAllowedHost(host)) return 'blocked';
  if (isLoopback(ip)) return 'local';
  if (!isPrivateIp(ip) || !lan.enabled) return 'blocked';
  return lan.isPaired(lanToken) ? 'paired' : 'unpaired';
}

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});
app.use(cookieParser(config.secret));

/**
 * Ağ kapısı: yalnız bu bilgisayar ve (açıksa) eşlenmiş yerel ağ cihazları.
 * Eşlenmemiş cihaz yalnız arayüzü yükleyip eşleme kodunu girebilir.
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const verdict = networkVerdict(req.ip ?? '', req.headers.host, req.signedCookies?.[LAN_COOKIE]);
  if (verdict === 'local' || verdict === 'paired') return next();
  if (verdict === 'blocked') {
    res.status(403).type('text/plain').send('Kesit bu cihazdan erişime kapalı. Telefondan açmak için bilgisayarda Ayarlar > Telefondan erişim\'i aç.');
    return;
  }
  const openPath = req.path === '/api/session' || req.path === '/api/lan/pair' || (req.method === 'GET' && !/^\/(api|auth|clips|socket\.io)(\/|$)/.test(req.path));
  if (openPath) return next();
  res.status(401).json({ error: 'Bu cihaz eşlenmemiş', lanPairing: true });
});

app.use(express.json({ limit: '1mb' }));
app.use(attachUser(store));

/** Durum değiştiren isteklerde başka siteden gelen çağrıları reddeder (SameSite çerezin yanında ikinci kat). */
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.get('origin');
  if (req.method === 'GET' || req.method === 'HEAD' || !origin) return next();
  let host: string | null = null;
  try {
    host = new URL(origin).host;
  } catch {
    /* "null" ya da bozuk köken — reddedilir */
  }
  if ((host && host === req.get('host')) || origin === config.baseUrl) return next();
  res.status(403).json({ error: 'Geçersiz istek kaynağı' });
});

app.use('/auth', authRouter(store));

app.get('/api/session', async (req, res) => {
  const local = isLoopback(req.ip);
  const paired = local || lan.isPaired(req.signedCookies?.[LAN_COOKIE]);
  const user = paired && req.user ? { ...req.user, onboardingDone: !!(await store.getSettings(req.user.id)).onboarding_done } : null;
  res.json({ user, local, pairingRequired: !paired });
});

/** Telefon eşleme: bilgisayar ekranındaki 6 haneli kod. */
app.post('/api/lan/pair', (req, res) => {
  const token = lan.pair(req.body?.code, String(req.get('user-agent') || '').replace(/\(.*?\)/g, '').trim().slice(0, 60) || 'Cihaz');
  res.cookie(LAN_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: false, signed: true, path: '/', maxAge: 30 * 86_400_000 });
  res.json({ ok: true });
});

/** Telefondan erişim yönetimi — yalnız bu bilgisayardan. */
app.get('/api/lan', requireLocal, (_req, res) => res.json(lan.status()));
app.put('/api/lan', requireLocal, (req, res) => res.json(lan.setEnabled(req.body?.enabled === true)));
app.post('/api/lan/code', requireLocal, (_req, res) => res.json(lan.newCode()));
app.delete('/api/lan/devices', requireLocal, (_req, res) => res.json(lan.revokeAll()));
app.use('/api', publicKickRoutes());

app.use('/api', requireUser);
for (const routes of [accountRoutes, settingsRoutes, taskRoutes, clipRoutes, studioRoutes, vodRoutes, liveRoutes, recordingRoutes, projectRoutes, systemRoutes]) {
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
// Masaüstü uygulaması derlenmiş arayüzü STATIC_DIR ile gösterir; aksi hâlde çalışma dizinindeki dist/.
const dist = path.resolve(process.env.STATIC_DIR || 'dist');
if (config.production && fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api|auth|clips|socket\.io).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use(errorHandler);

/* ── Socket.io: oturum çerezinden kullanıcı, kendi odasına katılır ────── */

io.use((socket, next) => {
  const h = socket.handshake;
  const ip = clientIp(h.address, h.headers['x-forwarded-for']);
  const verdict = networkVerdict(ip, h.headers.host, parseSignedCookie(h.headers.cookie, LAN_COOKIE));
  if (verdict !== 'local' && verdict !== 'paired') return next(new Error('Erişim yok'));
  const sid = parseSignedCookie(h.headers.cookie, SESSION_COOKIE);
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
retention.start();
await ctx.autopilot.restore();
ctx.harvester.restore();
const purge = setInterval(() => store.purgeExpiredSessions(), 6 * 3_600_000);
purge.unref();

server.listen(config.port, () => {
  console.log(`[Kesit] Sunucu hazır → http://localhost:${config.port}`);
});

// Kısa adres (Kesit App): SHORT_PORT verilirse (genelde 80) aynı uygulama o
// porttan da sunulur; tarayıcıda http://kesit.localhost yazmak yeter. Port
// doluysa sessizce atlanır, ana port çalışmaya devam eder.
const shortPort = Number(process.env.SHORT_PORT) || 0;
if (shortPort && shortPort !== config.port) {
  const short = createServer(app);
  io.attach(short);
  short.on('error', (err: NodeJS.ErrnoException) => console.warn(`[Kesit] Kısa adres portu ${shortPort} açılamadı (${err.code}); http://localhost:${config.port} kullan`));
  short.listen(shortPort, () => console.log(`[Kesit] Kısa adres hazır → http://kesit.localhost${shortPort === 80 ? '' : `:${shortPort}`}`));
}

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[Kesit] ${signal} alındı, kapanıyor…`);
  ctx.autopilot.stopAll();
  ctx.harvester.stopAll();
  retention.stop();
  ctx.system.stop();
  await workspaces.destroyAll().catch(() => {});
  await vodScanner.close().catch(() => {});
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
