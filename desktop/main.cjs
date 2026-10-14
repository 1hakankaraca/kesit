/**
 * Kesit App — ana süreç.
 *
 * Küçük bir araç: Kesit sunucusunu (desktop/dist-server, Electron'un gömülü
 * Node'uyla) başlatır/durdurur, günlüğünü gösterir, güncellemeleri kontrol
 * eder. Sunucu ayrı bir süreç olarak çalışır; uygulama penceresi kapansa da
 * tepsi simgesinden yaşamaya devam eder.
 */
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('electron-log/main');
const { autoUpdater } = require('electron-updater');

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = app.isPackaged ? false : 'info';

const LOG_MAX = 2000;
const STOP_TIMEOUT_MS = 8000;
// electron-builder paketlerken package.json'daki "build" alanını atar; depo burada sabit.
const GITHUB = { owner: '1hakankaraca', repo: 'kesit' };

/* ── Yollar ─────────────────────────────────────────────────────────────── */

const resources = app.isPackaged ? process.resourcesPath : __dirname;
const paths = {
  serverDir: app.isPackaged ? path.join(resources, 'server') : path.join(__dirname, 'dist-server'),
  webDir: app.isPackaged ? path.join(resources, 'web') : path.join(__dirname, '..', 'dist'),
  binDir: app.isPackaged ? path.join(resources, 'bin') : path.join(__dirname, 'bin'),
  settings: path.join(app.getPath('userData'), 'settings.json'),
  defaultData: path.join(app.getPath('userData'), 'data'),
  renderer: path.join(__dirname, 'renderer'),
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
};

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
  fs.writeFileSync(paths.settings, JSON.stringify(next, null, 2));
}

let settings = loadSettings();

/* ── Sunucu süreci ──────────────────────────────────────────────────────── */

const server = {
  proc: null,
  state: 'stopped', // stopped | starting | running | stopping | error
  startedAt: null,
  lastError: null,
  logs: [],
};

let win = null;
let tray = null;
let quitting = false;

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

function pushLog(line, stream = 'out') {
  const entry = { t: Date.now(), s: stream, m: line };
  server.logs.push(entry);
  if (server.logs.length > LOG_MAX) server.logs.splice(0, server.logs.length - LOG_MAX);
  log.info(`[sunucu] ${line}`);
  broadcast('server:log', entry);
}

function setState(state, extra = {}) {
  server.state = state;
  Object.assign(server, extra);
  broadcast('server:state', publicState());
  refreshTray();
}

function publicState() {
  return {
    state: server.state,
    pid: server.proc?.pid ?? null,
    port: settings.port,
    url: `http://localhost:${settings.port}`,
    startedAt: server.startedAt,
    lastError: server.lastError,
    ffmpeg: fs.existsSync(path.join(paths.binDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')) ? 'bundled' : 'system',
    version: app.getVersion(),
    platform: process.platform,
    dataDir: settings.dataDir,
  };
}

function serverEnv() {
  const sep = path.delimiter;
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    NODE_OPTIONS: '--no-warnings',
    PORT: String(settings.port),
    DATA_DIR: settings.dataDir,
    STATIC_DIR: paths.webDir,
    // Paketle gelen ffmpeg/ffprobe öne alınır; yoksa sistemdeki kullanılır.
    PATH: `${paths.binDir}${sep}${process.env.PATH || ''}`,
  };
}

function startServer() {
  if (server.proc) return;
  const entry = path.join(paths.serverDir, 'server.mjs');
  if (!fs.existsSync(entry)) {
    setState('error', { lastError: `Sunucu dosyası bulunamadı: ${entry}` });
    pushLog(`Sunucu dosyası bulunamadı: ${entry}`, 'err');
    return;
  }
  fs.mkdirSync(settings.dataDir, { recursive: true });
  server.lastError = null;
  setState('starting', { startedAt: Date.now() });
  pushLog(`Başlatılıyor — port ${settings.port}, veri ${settings.dataDir}`);

  const proc = spawn(process.execPath, [entry], { cwd: paths.serverDir, env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.proc = proc;

  const onData = (stream) => {
    let rest = '';
    return (chunk) => {
      rest += chunk.toString();
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        pushLog(line, stream);
        if (server.state === 'starting' && /Sunucu hazır/.test(line)) setState('running');
      }
    };
  };
  proc.stdout.on('data', onData('out'));
  proc.stderr.on('data', onData('err'));
  proc.on('error', (err) => {
    pushLog(`Başlatılamadı: ${err.message}`, 'err');
    server.proc = null;
    setState('error', { lastError: err.message });
  });
  proc.on('exit', (code, signal) => {
    const wasStopping = server.state === 'stopping';
    server.proc = null;
    if (wasStopping || code === 0) {
      pushLog('Sunucu durdu');
      setState('stopped', { startedAt: null });
    } else {
      const why = `Sunucu beklenmedik şekilde kapandı (${signal || `kod ${code}`})`;
      pushLog(why, 'err');
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
  if (!proc) return Promise.resolve();
  setState('stopping');
  pushLog('Durduruluyor…');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (server.proc === proc) {
        pushLog('Yanıt yok, zorla kapatılıyor', 'err');
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
  startServer();
}

/* ── Güncelleme ─────────────────────────────────────────────────────────── */

const update = { status: 'idle', latest: null, url: null, progress: 0, error: null, notes: null };

function sendUpdate() {
  broadcast('update:state', { ...update, current: app.getVersion() });
}

const semverNewer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

/** GitHub'daki son sürümü sorar (imzasız macOS için indirme bağlantısı). */
async function checkGithub() {
  if (!GITHUB) throw new Error('Yayın deposu tanımlı değil');
  const res = await fetch(`https://api.github.com/repos/${GITHUB.owner}/${GITHUB.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kesit-app' }, signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return { latest: null };
  if (!res.ok) throw new Error(`GitHub yanıtı ${res.status}`);
  const rel = await res.json();
  const want = process.platform === 'darwin' ? (process.arch === 'arm64' ? /arm64.*\.dmg$/i : /(x64|intel).*\.dmg$/i) : /\.exe$/i;
  const asset = (rel.assets || []).find((a) => want.test(a.name)) || (rel.assets || []).find((a) => (process.platform === 'darwin' ? /\.dmg$/i : /\.exe$/i).test(a.name));
  return { latest: String(rel.tag_name || rel.name || '').replace(/^v/, ''), url: asset?.browser_download_url || rel.html_url, notes: rel.body || null };
}

async function checkForUpdate() {
  update.status = 'checking';
  update.error = null;
  sendUpdate();
  try {
    if (process.platform === 'win32' && app.isPackaged) {
      const r = await autoUpdater.checkForUpdates();
      const latest = r?.updateInfo?.version ?? null;
      update.latest = latest;
      update.notes = typeof r?.updateInfo?.releaseNotes === 'string' ? r.updateInfo.releaseNotes : null;
      update.status = latest && semverNewer(latest, app.getVersion()) ? 'available' : 'none';
    } else {
      const r = await checkGithub();
      update.latest = r.latest;
      update.url = r.url ?? null;
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
  if (process.platform === 'win32' && app.isPackaged) {
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
  } else if (update.url) {
    // macOS: imzasız uygulama kendini değiştiremez; DMG indirilir, kullanıcı sürükler.
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

/* ── Pencere ve tepsi ───────────────────────────────────────────────────── */

function iconPath(name) {
  return path.join(paths.renderer, 'img', name);
}

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 460,
    minHeight: 560,
    title: 'Kesit App',
    backgroundColor: '#eef1f4',
    icon: process.platform === 'win32' ? iconPath('icon.ico') : iconPath('icon.png'),
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
      running ? { label: 'Tarayıcıda aç', click: () => shell.openExternal(`http://localhost:${settings.port}`) } : { label: 'Sunucuyu başlat', click: startServer, enabled: server.state === 'stopped' || server.state === 'error' },
      running ? { label: 'Sunucuyu durdur', click: () => void stopServer() } : { label: 'Tarayıcıda aç', enabled: false },
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
  const img = nativeImage.createFromPath(iconPath(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  if (process.platform === 'darwin') img.setTemplateImage(true);
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
ipcMain.handle('open:web', () => shell.openExternal(`http://localhost:${settings.port}`));
ipcMain.handle('open:data', () => shell.openPath(settings.dataDir));
ipcMain.handle('open:logFile', () => shell.showItemInFolder(log.transports.file.getFile().path));
ipcMain.handle('open:external', (_e, url) => (typeof url === 'string' && /^https?:\/\//.test(url) ? shell.openExternal(url) : undefined));
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => {
  const next = { ...settings, ...patch };
  next.port = Math.min(65535, Math.max(1024, Number(next.port) || 3002));
  if (typeof next.dataDir !== 'string' || !next.dataDir.trim()) next.dataDir = paths.defaultData;
  settings = next;
  saveSettings(settings);
  if (process.platform !== 'linux') app.setLoginItemSettings({ openAtLogin: !!settings.openAtLogin, openAsHidden: true });
  refreshTray();
  broadcast('server:state', publicState());
  return settings;
});
ipcMain.handle('settings:chooseDataDir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Veri klasörü', properties: ['openDirectory', 'createDirectory'], defaultPath: settings.dataDir });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('update:state', () => ({ ...update, current: app.getVersion() }));
ipcMain.handle('update:check', () => checkForUpdate());
ipcMain.handle('update:install', () => installUpdate());
ipcMain.handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, github: GITHUB, dataDir: settings.dataDir, logFile: log.transports.file.getFile().path }));

/* ── Yaşam döngüsü ──────────────────────────────────────────────────────── */

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(iconPath('icon.png')));
    createTray();
    createWindow();
    if (settings.autoStart) startServer();
    // Açılıştan biraz sonra sessizce güncelleme bak.
    setTimeout(() => void checkForUpdate().catch(() => {}), 4000);
  });
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {
    if (!settings.keepInTray && process.platform !== 'darwin') app.quit();
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
