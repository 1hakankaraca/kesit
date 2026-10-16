/**
 * Kesit App — ana süreç.
 *
 * Küçük bir araç: Kesit sunucusunu (desktop/dist-server, Electron'un gömülü
 * Node'uyla) başlatır/durdurur, günlüğünü gösterir, güncellemeleri kontrol
 * eder, ilk açılışta gerekli araçları (ffmpeg/ffprobe paketle gelir, whisper
 * indirilir) kurar. Sunucu ayrı bir süreç olarak çalışır; pencere kapansa da
 * tepsi simgesinden yaşamaya devam eder.
 */
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const log = require('electron-log/main');
const { autoUpdater } = require('electron-updater');

const execFileP = promisify(execFile);

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = app.isPackaged ? false : 'info';

const LOG_MAX = 2000;
const STOP_TIMEOUT_MS = 8000;
const SHORT_PORT = 80;
const SHORT_HOST = 'kesit.localhost';
// electron-builder paketlerken package.json'daki "build" alanını atar; depo burada sabit.
const GITHUB = { owner: '1hakankaraca', repo: 'kesit' };
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const EXE = IS_WIN ? '.exe' : '';

/* ── Yollar ─────────────────────────────────────────────────────────────── */

const resources = app.isPackaged ? process.resourcesPath : __dirname;
const userData = app.getPath('userData');
const paths = {
  serverDir: app.isPackaged ? path.join(resources, 'server') : path.join(__dirname, 'dist-server'),
  webDir: app.isPackaged ? path.join(resources, 'web') : path.join(__dirname, '..', 'dist'),
  binDir: app.isPackaged ? path.join(resources, 'bin') : path.join(__dirname, 'bin'),
  toolsDir: path.join(userData, 'tools'),
  settings: path.join(userData, 'settings.json'),
  defaultData: path.join(userData, 'data'),
  renderer: path.join(__dirname, 'renderer'),
  exports: path.join(app.getPath('downloads'), 'Kesit'),
};

/* ── Ayarlar ────────────────────────────────────────────────────────────── */

const DEFAULT_SETTINGS = {
  port: 3002,
  dataDir: paths.defaultData,
  /** Uygulama açılınca sunucu da başlasın. */
  autoStart: true,
  /** Bilgisayar açılınca uygulama (tepside) başlasın. */
  openAtLogin: false,
  /** Pencere kapanınca uygulama tepside kalsın. */
  keepInTray: true,
  /** http://kesit.localhost kısa adresi (80 portu) de açılsın. */
  shortAddress: true,
  /** Kapak üretimi bağlantısı. */
  coverUrl: 'https://locavise.co',
  /** İlk kurulum tamamlandı mı. */
  setupDone: false,
  /** Kurulumun bulduğu whisper-cli yolu (boşsa yok). */
  whisperBin: '',
};

function loadSettings() {
  try {
    const saved = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(paths.settings, 'utf8')) };
    // 0.2.0'da yanlış alan adı kaydedilmişti.
    if (saved.coverUrl === 'https://locavise.com') saved.coverUrl = DEFAULT_SETTINGS.coverUrl;
    return saved;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
  fs.writeFileSync(paths.settings, JSON.stringify(next, null, 2));
}

let settings = loadSettings();

/* ── Ortak ──────────────────────────────────────────────────────────────── */

let win = null;
let tray = null;
let quitting = false;

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

/** Finder/Explorer'dan açılan uygulamanın PATH'i kısadır; araç dizinleri öne eklenir. */
function toolPath() {
  const extra = [paths.binDir, path.join(paths.toolsDir, 'whisper')];
  if (IS_MAC) extra.push('/opt/homebrew/bin', '/usr/local/bin');
  return [...extra, process.env.PATH || ''].join(path.delimiter);
}

const exists = (p) => {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
};

/* ── Sunucu süreci ──────────────────────────────────────────────────────── */

const server = {
  proc: null,
  state: 'stopped', // stopped | starting | running | stopping | error
  startedAt: null,
  lastError: null,
  shortReady: false,
  logs: [],
};

function pushLog(line, stream = 'out') {
  const entry = { t: Date.now(), s: stream, m: line };
  server.logs.push(entry);
  if (server.logs.length > LOG_MAX) server.logs.splice(0, server.logs.length - LOG_MAX);
  log.info(`[sunucu] ${line}`);
  broadcast('server:log', entry);
}

function appLog(line, stream = 'app') {
  pushLog(line, stream);
}

function setState(state, extra = {}) {
  server.state = state;
  Object.assign(server, extra);
  broadcast('server:state', publicState());
  refreshTray();
}

function webUrl() {
  return settings.shortAddress && server.shortReady ? `http://${SHORT_HOST}` : `http://localhost:${settings.port}`;
}

function publicState() {
  return {
    state: server.state,
    pid: server.proc?.pid ?? null,
    port: settings.port,
    url: webUrl(),
    localUrl: `http://localhost:${settings.port}`,
    startedAt: server.startedAt,
    lastError: server.lastError,
    ffmpeg: exists(path.join(paths.binDir, `ffmpeg${EXE}`)) ? 'bundled' : 'system',
    whisper: !!findWhisper(),
    version: app.getVersion(),
    platform: process.platform,
    dataDir: settings.dataDir,
    setupDone: !!settings.setupDone,
  };
}

function serverEnv() {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    NODE_OPTIONS: '--no-warnings',
    PORT: String(settings.port),
    DATA_DIR: settings.dataDir,
    STATIC_DIR: paths.webDir,
    PATH: toolPath(),
  };
  if (settings.shortAddress) env.SHORT_PORT = String(SHORT_PORT);
  if (settings.whisperBin && exists(settings.whisperBin)) env.WHISPER_BIN = settings.whisperBin;
  return env;
}

/* ── Port denetimi: dolu portu açan süreci kapat ───────────────────────── */

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '0.0.0.0');
  });
}

/** Portu dinleyen süreçler: [{pid, name}]. */
async function portOwners(port) {
  try {
    if (IS_WIN) {
      const { stdout } = await execFileP('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true });
      const pids = new Set();
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && Number(m[1]) === port) pids.add(Number(m[2]));
      }
      const owners = [];
      for (const pid of pids) {
        let name = '?';
        try {
          const { stdout: t } = await execFileP('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
          name = (t.match(/^"([^"]+)"/) || [])[1] || '?';
        } catch {
          /* ad bulunamadı */
        }
        owners.push({ pid, name });
      }
      return owners;
    }
    const { stdout } = await execFileP('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
    const owners = [];
    let cur = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) cur = { pid: Number(line.slice(1)), name: '?' };
      else if (line.startsWith('c') && cur) {
        cur.name = line.slice(1);
        owners.push(cur);
        cur = null;
      }
    }
    return owners;
  } catch {
    return [];
  }
}

async function killPid(pid) {
  if (IS_WIN) await execFileP('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 1200));
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      /* kapandı */
    }
  }
}

/** Port doluysa sahibini kapatır; boşalana kadar (en çok 6 sn) bekler. */
async function ensurePortFree(port) {
  if (await isPortFree(port)) return true;
  const owners = (await portOwners(port)).filter((o) => o.pid !== process.pid && o.pid !== server.proc?.pid);
  if (!owners.length) appLog(`Port ${port} dolu ama sahibi bulunamadı`, 'err');
  for (const o of owners) {
    appLog(`Port ${port} "${o.name}" (pid ${o.pid}) tarafından kullanılıyor — kapatılıyor`);
    await killPid(o.pid);
  }
  for (let i = 0; i < 12; i++) {
    if (await isPortFree(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function startServer() {
  if (server.proc || server.state === 'starting') return;
  const entry = path.join(paths.serverDir, 'server.mjs');
  if (!exists(entry)) {
    setState('error', { lastError: `Sunucu dosyası bulunamadı: ${entry}` });
    appLog(`Sunucu dosyası bulunamadı: ${entry}`, 'err');
    return;
  }
  fs.mkdirSync(settings.dataDir, { recursive: true });
  server.lastError = null;
  server.shortReady = false;
  setState('starting', { startedAt: null });
  appLog(`Başlatılıyor — port ${settings.port}, veri ${settings.dataDir}`);

  if (!(await ensurePortFree(settings.port))) {
    setState('error', { lastError: `Port ${settings.port} boşaltılamadı. Ayarlar'dan başka bir port seç.` });
    appLog(`Port ${settings.port} boşaltılamadı`, 'err');
    return;
  }
  if (settings.shortAddress && !(await isPortFree(SHORT_PORT))) {
    const owners = (await portOwners(SHORT_PORT)).filter((o) => o.pid !== process.pid);
    if (owners.length) appLog(`Kısa adres için ${SHORT_PORT} portu "${owners[0].name}" tarafından kullanılıyor; http://localhost:${settings.port} ile devam edilecek`);
  }
  if (server.state !== 'starting') return; // bu arada durduruldu

  const proc = spawn(process.execPath, [entry], { cwd: paths.serverDir, env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.proc = proc;
  server.startedAt = Date.now();

  const onData = (stream) => {
    let rest = '';
    return (chunk) => {
      rest += chunk.toString();
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        pushLog(line, stream);
        if (/Kısa adres hazır/.test(line)) {
          server.shortReady = true;
          broadcast('server:state', publicState());
        }
        if (server.state === 'starting' && /Sunucu hazır/.test(line)) setState('running');
      }
    };
  };
  proc.stdout.on('data', onData('out'));
  proc.stderr.on('data', onData('err'));
  proc.on('error', (err) => {
    appLog(`Başlatılamadı: ${err.message}`, 'err');
    server.proc = null;
    setState('error', { lastError: err.message, startedAt: null });
  });
  proc.on('exit', (code, signal) => {
    const wasStopping = server.state === 'stopping';
    server.proc = null;
    server.shortReady = false;
    if (wasStopping || code === 0) {
      appLog('Sunucu durdu');
      setState('stopped', { startedAt: null });
    } else {
      const why = `Sunucu beklenmedik şekilde kapandı (${signal || `kod ${code}`})`;
      appLog(why, 'err');
      setState('error', { lastError: why, startedAt: null });
    }
  });

  // Hazır mesajı gelmezse bile HTTP yanıt veriyorsa çalışıyor say.
  const probe = setInterval(async () => {
    if (server.state !== 'starting') return clearInterval(probe);
    try {
      const res = await fetch(`http://127.0.0.1:${settings.port}/`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) setState('running');
    } catch {
      /* henüz değil */
    }
  }, 1500);
}

function stopServer() {
  const proc = server.proc;
  if (!proc) {
    if (server.state === 'starting') setState('stopped');
    return Promise.resolve();
  }
  setState('stopping');
  appLog('Durduruluyor…');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (server.proc === proc) {
        appLog('Yanıt yok, zorla kapatılıyor', 'err');
        proc.kill('SIGKILL');
      }
    }, STOP_TIMEOUT_MS);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

async function restartServer() {
  await stopServer();
  await startServer();
}

/* ── İlk kurulum ────────────────────────────────────────────────────────── */

const setup = { running: false, steps: [] };

function findInPath(name) {
  const file = `${name}${EXE}`;
  for (const dir of toolPath().split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, file);
    if (exists(p)) return p;
  }
  return null;
}

function findWhisper() {
  // Öncelik: paketle gelen (desktop/bin) → kurulumun indirdiği → ayar → PATH.
  const bundled = path.join(paths.binDir, `whisper-cli${EXE}`);
  if (exists(bundled)) return bundled;
  const local = findFile(path.join(paths.toolsDir, 'whisper'), `whisper-cli${EXE}`);
  if (local) return local;
  if (settings.whisperBin && exists(settings.whisperBin)) return settings.whisperBin;
  return findInPath('whisper-cli') || (IS_MAC ? findInPath('whisper-cpp') : null);
}

function findFile(dir, name, depth = 3) {
  if (!exists(dir) || depth < 0) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
    if (e.isDirectory()) {
      const r = findFile(p, name, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

function sendSetup() {
  broadcast('setup:state', { running: setup.running, steps: setup.steps, done: !!settings.setupDone });
}

function step(id, label) {
  const s = { id, label, status: 'running', detail: '' };
  setup.steps.push(s);
  sendSetup();
  return {
    ok: (detail = '') => Object.assign(s, { status: 'ok', detail }) && sendSetup(),
    skip: (detail = '') => Object.assign(s, { status: 'skip', detail }) && sendSetup(),
    fail: (detail = '') => Object.assign(s, { status: 'fail', detail }) && sendSetup(),
    note: (detail = '') => Object.assign(s, { detail }) && sendSetup(),
  };
}

async function version(bin, args = ['-version']) {
  const { stdout, stderr } = await execFileP(bin, args, { env: { ...process.env, PATH: toolPath() }, windowsHide: true, timeout: 15000 });
  return (stdout || stderr).split('\n')[0].trim().slice(0, 80);
}

async function downloadFile(url, dest, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': 'kesit-app' }, signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`İndirme başarısız (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  for await (const chunk of res.body) {
    got += chunk.length;
    out.write(chunk);
    if (total && onProgress) onProgress(Math.round((got / total) * 100));
  }
  await new Promise((r) => out.end(r));
}

/**
 * Kesit'in kendi Release'inden derlenmiş whisper-cli'yi indirir (CI her sürümde
 * whisper.cpp'yi derleyip whisper-win-x64.zip / whisper-mac-universal.zip ekler).
 * Normalde gerek kalmaz — ikili dosya paketle gelir; bu yol eski/eksik paket içindir.
 */
async function installWhisperFromRelease(s) {
  const want = IS_WIN ? 'whisper-win-x64.zip' : `whisper-mac-${process.arch}.zip`;
  const api = `https://api.github.com/repos/${GITHUB.owner}/${GITHUB.repo}/releases/latest`;
  const rel = await (await fetch(api, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kesit-app' }, signal: AbortSignal.timeout(15000) })).json();
  const asset = (rel.assets || []).find((a) => a.name === want);
  if (!asset) throw new Error(`${want} Release'de yok (${rel.tag_name || 'sürüm bulunamadı'})`);
  const dir = path.join(paths.toolsDir, 'whisper');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(paths.toolsDir, 'whisper.zip');
  s.note(`${rel.tag_name} indiriliyor…`);
  await downloadFile(asset.browser_download_url, zip, (p) => s.note(`${rel.tag_name} indiriliyor %${p}`));
  s.note('Açılıyor…');
  // Windows 10+ tar.exe zip açabilir; macOS'ta da tar zip okur.
  await execFileP('tar', ['-xf', zip, '-C', dir], { windowsHide: true });
  fs.rmSync(zip, { force: true });
  const bin = findFile(dir, `whisper-cli${EXE}`, 4);
  if (!bin) throw new Error('Paket açıldı ama whisper-cli bulunamadı');
  if (!IS_WIN) fs.chmodSync(bin, 0o755);
  return bin;
}

/** macOS: Homebrew varsa whisper-cpp kurar (dakikalar sürebilir). */
async function installWhisperMac(s) {
  const brew = findInPath('brew');
  if (!brew) throw new Error('Homebrew yok. Terminal\'de: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" sonra brew install whisper-cpp');
  s.note('brew install whisper-cpp çalışıyor… (ilk seferde birkaç dakika)');
  await new Promise((resolve, reject) => {
    const p = spawn(brew, ['install', 'whisper-cpp'], { env: { ...process.env, PATH: toolPath(), HOMEBREW_NO_AUTO_UPDATE: '1' } });
    const tail = [];
    const onLine = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 3) tail.shift();
        appLog(`[brew] ${line.trim().slice(0, 160)}`, 'app');
        s.note(line.trim().slice(0, 90));
      }
    };
    p.stdout.on('data', onLine);
    p.stderr.on('data', onLine);
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`brew ${code} ile bitti: ${tail.join(' | ').slice(0, 200)}`))));
  });
  return findInPath('whisper-cli') || findInPath('whisper-cpp');
}

async function runSetup() {
  if (setup.running) return;
  setup.running = true;
  setup.steps = [];
  sendSetup();
  appLog(`Kurulum başladı (${IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : process.platform})`);

  // 1. Veri klasörü
  {
    const s = step('data', 'Veri klasörü');
    try {
      fs.mkdirSync(settings.dataDir, { recursive: true });
      fs.accessSync(settings.dataDir, fs.constants.W_OK);
      fs.mkdirSync(paths.exports, { recursive: true });
      s.ok(settings.dataDir);
    } catch (err) {
      s.fail(`Yazılamıyor: ${err.message}`);
    }
  }

  // 2-3. ffmpeg / ffprobe
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const s = step(tool, tool);
    const bundled = path.join(paths.binDir, `${tool}${EXE}`);
    const bin = exists(bundled) ? bundled : findInPath(tool);
    if (!bin) {
      s.fail('Bulunamadı — paket eksik görünüyor, uygulamayı yeniden kur');
      continue;
    }
    try {
      if (!IS_WIN) fs.chmodSync(bin, 0o755);
      s.ok(`${bin === bundled ? 'Paketle geldi' : 'Sistemde'} · ${await version(bin)}`);
    } catch (err) {
      s.fail(`Çalıştırılamadı: ${err.message.slice(0, 120)}`);
    }
  }

  // 4. whisper-cli (isteğe bağlı: yerel altyazı)
  {
    const s = step('whisper', 'whisper-cli (yerel altyazı)');
    let bin = findWhisper();
    if (bin) s.ok(`Hazır · ${bin}`);
    else {
      try {
        // Önce Kesit'in kendi derlemesi; macOS'ta o da yoksa Homebrew.
        try {
          bin = await installWhisperFromRelease(s);
        } catch (err) {
          appLog(`whisper Release'den alınamadı: ${err.message}`, 'err');
          if (!IS_MAC) throw err;
          bin = await installWhisperMac(s);
        }
        if (bin) s.ok(`Kuruldu · ${bin}`);
        else s.skip('Bu sistemde otomatik kurulamıyor; Ayarlar\'da ElevenLabs anahtarı kullanılabilir');
      } catch (err) {
        s.skip(`Kurulamadı: ${err.message.slice(0, 220)}. Altyazı için ElevenLabs anahtarı kullanılabilir.`);
      }
    }
    if (bin) {
      settings.whisperBin = bin;
      saveSettings(settings);
    }
  }

  // 5. Port
  {
    const s = step('port', `Port ${settings.port}`);
    if (await isPortFree(settings.port)) s.ok('Boş');
    else {
      const owners = await portOwners(settings.port);
      s.ok(owners.length ? `"${owners[0].name}" kullanıyor; başlatırken kapatılacak` : 'Dolu; başlatırken boşaltılacak');
    }
  }

  settings.setupDone = true;
  saveSettings(settings);
  setup.running = false;
  sendSetup();
  broadcast('server:state', publicState());
  appLog('Kurulum tamamlandı');
}

/* ── Güncelleme ─────────────────────────────────────────────────────────── */

const update = { status: 'idle', latest: null, url: null, zipUrl: null, progress: 0, error: null, notes: null };

function sendUpdate() {
  broadcast('update:state', { ...update, current: app.getVersion() });
}

const semverNewer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

/**
 * GitHub'daki son sürümü sorar. macOS'ta iki bağlantı döner: uygulamanın
 * kendi kendini değiştirmesi için .zip, elle kurulum için .pkg (yoksa .dmg).
 */
async function checkGithub() {
  const res = await fetch(`https://api.github.com/repos/${GITHUB.owner}/${GITHUB.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kesit-app' }, signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return { latest: null };
  if (!res.ok) throw new Error(`GitHub yanıtı ${res.status}`);
  const rel = await res.json();
  const assets = rel.assets || [];
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const pick = (ext) => assets.find((a) => new RegExp(`mac.*${arch}.*\\.${ext}$`, 'i').test(a.name)) || assets.find((a) => new RegExp(`\\.${ext}$`, 'i').test(a.name));
  const asset = IS_MAC ? pick('pkg') || pick('dmg') : assets.find((a) => /\.exe$/i.test(a.name));
  const zip = IS_MAC ? assets.find((a) => new RegExp(`mac.*${arch}.*\\.zip$`, 'i').test(a.name)) : null;
  return { latest: String(rel.tag_name || rel.name || '').replace(/^v/, ''), url: asset?.browser_download_url || rel.html_url, zipUrl: zip?.browser_download_url || null, notes: rel.body || null };
}

/** Dosyayı diske indirir; yüzde ilerlemesini bildirir. */
async function downloadFile(url, dest, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': 'kesit-app' }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`İndirme yanıtı ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let last = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    got += chunk.length;
    const pct = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
    if (pct !== last) {
      last = pct;
      onProgress(pct);
    }
  });
  await pipeline(body, fs.createWriteStream(dest));
}

/**
 * macOS: sertifika olmadığı için electron-updater çalışmaz; uygulama .zip'i
 * kendisi indirir, açar, karantina işaretini kaldırır (Gatekeeper'ın
 * "hasarlı" demesinin tek nedeni bu işaret) ve kendi paketini yenisiyle
 * değiştirip yeniden başlar. Yazma izni yoksa ya da bir şey ters giderse
 * kurulum paketi tarayıcıda açılır.
 */
async function installMacUpdate() {
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  if (!app.isPackaged || !bundle.endsWith('.app') || !update.zipUrl) {
    if (update.url) await shell.openExternal(update.url);
    return;
  }
  update.status = 'downloading';
  update.progress = 0;
  update.error = null;
  sendUpdate();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-guncelleme-'));
  const zipPath = path.join(tmp, 'kesit.zip');
  const yedek = path.join(path.dirname(bundle), `.${path.basename(bundle)}.eski`);
  try {
    await downloadFile(update.zipUrl, zipPath, (pct) => {
      update.progress = pct;
      sendUpdate();
    });
    update.status = 'installing';
    update.progress = 100;
    sendUpdate();
    appLog(`Güncelleme indirildi, kuruluyor: ${bundle}`);
    await execFileP('ditto', ['-x', '-k', zipPath, tmp]);
    const yeniAd = fs.readdirSync(tmp).find((n) => n.endsWith('.app'));
    if (!yeniAd) throw new Error('Pakette uygulama bulunamadı');
    const yeni = path.join(tmp, yeniAd);
    await execFileP('xattr', ['-dr', 'com.apple.quarantine', yeni]).catch(() => {});
    // Yazma izni var mı? (Applications'a yalnız yönetici yazabilir.)
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    await stopServer();
    fs.rmSync(yedek, { recursive: true, force: true });
    fs.renameSync(bundle, yedek);
    try {
      await execFileP('ditto', [yeni, bundle]);
    } catch (err) {
      fs.rmSync(bundle, { recursive: true, force: true });
      fs.renameSync(yedek, bundle);
      throw err;
    }
    fs.rmSync(yedek, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    appLog(`Güncelleme kuruldu: v${update.latest}; yeniden başlatılıyor`);
    quitting = true;
    app.relaunch();
    app.exit(0);
  } catch (err) {
    log.warn(`macOS güncellemesi kurulamadı: ${err.message}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    update.status = 'available';
    update.progress = 0;
    update.error = `Kendiliğinden kurulamadı (${err.message}); kurulum paketi tarayıcıda açıldı.`;
    sendUpdate();
    if (update.url) await shell.openExternal(update.url);
  }
}

async function checkForUpdate() {
  update.status = 'checking';
  update.error = null;
  sendUpdate();
  try {
    if (IS_WIN && app.isPackaged) {
      const r = await autoUpdater.checkForUpdates();
      const latest = r?.updateInfo?.version ?? null;
      update.latest = latest;
      update.notes = typeof r?.updateInfo?.releaseNotes === 'string' ? r.updateInfo.releaseNotes : null;
      update.status = latest && semverNewer(latest, app.getVersion()) ? 'available' : 'none';
    } else {
      const r = await checkGithub();
      update.latest = r.latest;
      update.url = r.url ?? null;
      update.zipUrl = r.zipUrl ?? null;
      update.notes = r.notes ?? null;
      update.status = r.latest && semverNewer(r.latest, app.getVersion()) ? 'available' : 'none';
    }
  } catch (err) {
    update.status = 'error';
    update.error = err.message;
  }
  sendUpdate();
}

async function installUpdate() {
  if (update.status !== 'available' && update.status !== 'downloaded') return;
  if (IS_WIN && app.isPackaged) {
    if (update.status === 'downloaded') {
      await stopServer();
      quitting = true;
      autoUpdater.quitAndInstall();
      return;
    }
    update.status = 'downloading';
    sendUpdate();
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      update.status = 'error';
      update.error = err.message;
      sendUpdate();
    }
  } else if (IS_MAC) {
    await installMacUpdate();
  } else if (update.url) {
    await shell.openExternal(update.url);
  }
}

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = log;
autoUpdater.on('download-progress', (p) => {
  update.progress = Math.round(p.percent);
  sendUpdate();
});
autoUpdater.on('update-downloaded', () => {
  update.status = 'downloaded';
  update.progress = 100;
  sendUpdate();
});
autoUpdater.on('error', (err) => {
  update.status = 'error';
  update.error = err?.message || String(err);
  sendUpdate();
});

/* ── Kaldırma ───────────────────────────────────────────────────────────── */

async function uninstall() {
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Kesit App\'i kaldır',
    message: 'Kesit App ve tüm verileri silinsin mi?',
    detail: `Silinecekler:\n• Veri klasörü (veritabanı, klipler, kayıtlar): ${settings.dataDir}\n• Ayarlar, günlükler ve indirilen araçlar: ${userData}\n• Uygulamanın kendisi${IS_WIN ? ' (kaldırıcı açılır)' : ' (Çöp Sepeti\'ne taşınır)'}\n\nBu işlem geri alınamaz.`,
    checkboxLabel: `İndirilenler/Kesit klasöründeki hazır videoları da sil (${paths.exports})`,
    checkboxChecked: false,
    buttons: ['Vazgeç', 'Hepsini sil'],
    defaultId: 0,
    cancelId: 0,
  });
  if (r.response !== 1) return false;
  quitting = true;
  await stopServer();
  const rm = (p) => {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (err) {
      log.warn(`silinemedi ${p}: ${err.message}`);
    }
  };
  rm(settings.dataDir);
  if (r.checkboxChecked) rm(paths.exports);
  // Günlük dosyası açık olabilir; önce kapat.
  try {
    log.transports.file.level = false;
  } catch {
    /* yok say */
  }
  rm(paths.toolsDir);
  rm(paths.settings);
  rm(path.dirname(log.transports.file.getFile().path));
  if (app.isPackaged) {
    if (IS_WIN) {
      const unins = path.join(path.dirname(process.execPath), 'Uninstall Kesit App.exe');
      if (exists(unins)) spawn(unins, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } else if (IS_MAC) {
      const bundle = path.resolve(process.execPath, '..', '..', '..');
      if (bundle.endsWith('.app')) await shell.trashItem(bundle).catch((err) => log.warn(`uygulama taşınamadı: ${err.message}`));
    }
  }
  app.exit(0);
  return true;
}

/* ── Pencere ve tepsi ───────────────────────────────────────────────────── */

function iconPath(name) {
  return path.join(paths.renderer, 'img', name);
}

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 700,
    minWidth: 440,
    minHeight: 560,
    title: 'Kesit App',
    backgroundColor: '#eef1f4',
    icon: iconPath('icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(paths.renderer, 'index.html'));
  win.on('close', (e) => {
    if (quitting || !settings.keepInTray) return;
    e.preventDefault();
    win.hide();
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win) createWindow();
  else {
    win.show();
    win.focus();
  }
}

function refreshTray() {
  if (!tray) return;
  const running = server.state === 'running';
  const label = { stopped: 'Sunucu kapalı', starting: 'Başlatılıyor…', running: `Çalışıyor · :${settings.port}`, stopping: 'Durduruluyor…', error: 'Hata' }[server.state];
  tray.setToolTip(`Kesit App — ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Sunucuyu başlat', click: () => void startServer(), enabled: server.state === 'stopped' || server.state === 'error' },
      { label: 'Sunucuyu durdur', click: () => void stopServer(), enabled: running },
      { label: 'Uygulamayı aç', click: () => shell.openExternal(webUrl()), enabled: running },
      { label: 'Pencereyi göster', click: showWindow },
      { type: 'separator' },
      {
        label: 'Çık',
        click: async () => {
          quitting = true;
          await stopServer();
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath(IS_MAC ? 'trayTemplate.png' : 'tray.png'));
  if (IS_MAC) img.setTemplateImage(true);
  tray = new Tray(img);
  tray.on('click', showWindow);
  refreshTray();
}

/* ── IPC ────────────────────────────────────────────────────────────────── */

ipcMain.handle('server:state', () => publicState());
ipcMain.handle('server:start', () => startServer());
ipcMain.handle('server:stop', () => stopServer());
ipcMain.handle('server:restart', () => restartServer());
ipcMain.handle('server:logs', () => server.logs);
ipcMain.handle('server:clearLogs', () => {
  server.logs = [];
});
ipcMain.handle('open:web', () => shell.openExternal(webUrl()));
ipcMain.handle('open:cover', () => (/^https?:\/\//.test(settings.coverUrl) ? shell.openExternal(settings.coverUrl) : undefined));
ipcMain.handle('open:data', () => shell.openPath(settings.dataDir));
ipcMain.handle('open:logFile', () => shell.showItemInFolder(log.transports.file.getFile().path));
ipcMain.handle('open:external', (_e, url) => (typeof url === 'string' && /^https?:\/\//.test(url) ? shell.openExternal(url) : undefined));
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => {
  const next = { ...settings, ...patch };
  next.port = Math.min(65535, Math.max(1024, Number(next.port) || 3002));
  if (typeof next.dataDir !== 'string' || !next.dataDir.trim()) next.dataDir = paths.defaultData;
  if (typeof next.coverUrl !== 'string' || !/^https?:\/\//.test(next.coverUrl)) next.coverUrl = DEFAULT_SETTINGS.coverUrl;
  settings = next;
  saveSettings(settings);
  if (!process.env.KESIT_APP_TEST && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.openAtLogin, openAsHidden: true });
  refreshTray();
  broadcast('server:state', publicState());
  return settings;
});
ipcMain.handle('settings:chooseDataDir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Veri klasörü', properties: ['openDirectory', 'createDirectory'], defaultPath: settings.dataDir });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('setup:state', () => ({ running: setup.running, steps: setup.steps, done: !!settings.setupDone }));
ipcMain.handle('setup:run', () => runSetup());
ipcMain.handle('update:state', () => ({ ...update, current: app.getVersion() }));
ipcMain.handle('update:check', () => checkForUpdate());
ipcMain.handle('update:install', () => installUpdate());
ipcMain.handle('app:uninstall', () => uninstall());
ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, github: GITHUB, dataDir: settings.dataDir, logFile: log.transports.file.getFile().path, shortHost: SHORT_HOST }));

/* ── Yaşam döngüsü ──────────────────────────────────────────────────────── */

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    if (IS_MAC) app.dock?.setIcon(nativeImage.createFromPath(iconPath('icon.png')));
    createTray();
    createWindow();
    if (settings.setupDone && settings.autoStart) void startServer();
    // Açılıştan biraz sonra sessizce güncelleme bak.
    setTimeout(() => void checkForUpdate().catch(() => {}), 4000);
  });
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {
    if (!settings.keepInTray && !IS_MAC) app.quit();
  });
  app.on('before-quit', (e) => {
    if (quitting || !server.proc) {
      quitting = true;
      return;
    }
    e.preventDefault();
    quitting = true;
    void stopServer().then(() => app.quit());
  });
}
