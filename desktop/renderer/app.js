/* Kesit App arayüzü — tek dosya, çerçevesiz. window.kesit preload'dan gelir. */
const $ = (id) => document.getElementById(id);
const k = window.kesit;

const STATE = {
  stopped: { title: 'Sunucu kapalı', sub: "Başlat'a bas; arayüz tarayıcıda açılır.", tone: 'off' },
  starting: { title: 'Başlatılıyor…', sub: 'Sunucu ayağa kalkıyor, birkaç saniye.', tone: 'busy' },
  running: { title: 'Çalışıyor', sub: '', tone: 'on' },
  stopping: { title: 'Durduruluyor…', sub: 'Süren işler kapatılıyor.', tone: 'busy' },
  error: { title: 'Hata', sub: 'Sunucu çalışmıyor; günlüğe bak.', tone: 'err' },
};

let state = null;
let info = null;
let settings = null;
let uptimeTimer = null;

const fmtUptime = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60);
  return `${h} sa ${m % 60} dk`;
};

function renderState(s) {
  state = s;
  const spec = STATE[s.state] || STATE.stopped;
  $('dot').className = `dot dot-${spec.tone}`;
  $('status-title').textContent = spec.title;
  const sub = s.state === 'running' ? `${s.url} · ${s.startedAt ? fmtUptime(Date.now() - s.startedAt) : ''} · ffmpeg ${s.ffmpeg === 'bundled' ? 'paketle geldi' : 'sistemden'}` : spec.sub;
  $('status-sub').textContent = sub;
  const running = s.state === 'running';
  const busy = s.state === 'starting' || s.state === 'stopping';
  $('btn-start').hidden = running || busy;
  $('btn-stop').hidden = !running;
  $('btn-restart').hidden = !running;
  $('btn-open').hidden = !running;
  $('btn-start').disabled = busy;
  $('status-error').hidden = !s.lastError;
  $('status-error').textContent = s.lastError || '';
  document.title = running ? `Kesit App — çalışıyor :${s.port}` : 'Kesit App';
  clearInterval(uptimeTimer);
  if (running) uptimeTimer = setInterval(() => renderState(state), 10_000);
}

function renderUpdate(u) {
  const text = $('update-text');
  const actions = $('update-actions');
  const prog = $('update-progress');
  actions.hidden = true;
  prog.hidden = true;
  $('btn-notes').hidden = !u.notes;
  $('btn-check').disabled = u.status === 'checking' || u.status === 'downloading';
  switch (u.status) {
    case 'checking':
      text.textContent = 'Bakılıyor…';
      break;
    case 'none':
      text.textContent = `Güncel: v${u.current}${u.latest ? '' : ' (henüz yayın yok)'}`;
      break;
    case 'available':
      text.textContent = `Yeni sürüm var: v${u.latest} (sende v${u.current})`;
      actions.hidden = false;
      $('btn-update').textContent = info?.platform === 'win32' ? 'İndir ve kur' : 'İndir (DMG)';
      break;
    case 'downloading':
      text.textContent = `İndiriliyor %${u.progress}`;
      prog.hidden = false;
      prog.firstElementChild.style.width = `${u.progress}%`;
      break;
    case 'downloaded':
      text.textContent = `v${u.latest} indirildi. Kurulum için uygulama yeniden başlatılır.`;
      actions.hidden = false;
      $('btn-update').textContent = 'Kur ve yeniden başlat';
      break;
    case 'error':
      text.textContent = `Bakılamadı: ${u.error || 'bilinmeyen hata'}`;
      break;
    default:
      text.textContent = 'Henüz bakılmadı.';
  }
}

const logEl = $('log');
const fmtTime = (t) => new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function appendLog(e) {
  const line = document.createElement('div');
  line.className = e.s === 'err' ? 'ln ln-err' : 'ln';
  line.textContent = `${fmtTime(e.t)}  ${e.m}`;
  logEl.appendChild(line);
  while (logEl.childElementCount > 2000) logEl.removeChild(logEl.firstChild);
  if ($('log-follow').checked) logEl.scrollTop = logEl.scrollHeight;
}

function renderSettings(s) {
  settings = s;
  $('set-port').value = s.port;
  $('set-data').value = s.dataDir;
  $('set-autostart').checked = !!s.autoStart;
  $('set-login').checked = !!s.openAtLogin;
  $('set-tray').checked = !!s.keepInTray;
}

async function patch(p) {
  renderSettings(await k.setSettings(p));
}

async function init() {
  info = await k.info();
  $('version').textContent = `v${info.version}`;
  $('foot-info').textContent = `Electron ${info.electron} · Node ${info.node} · ${info.platform}/${info.arch}`;
  if (info.github) $('link-site').onclick = (e) => (e.preventDefault(), k.openExternal(`https://github.com/${info.github.owner}/${info.github.repo}`));
  else $('link-site').hidden = true;
  renderSettings(await k.getSettings());
  renderState(await k.state());
  renderUpdate(await k.updateState());
  for (const e of await k.logs()) appendLog(e);
  logEl.scrollTop = logEl.scrollHeight;

  k.onState(renderState);
  k.onLog(appendLog);
  k.onUpdate(renderUpdate);

  $('btn-start').onclick = () => k.start();
  $('btn-stop').onclick = () => k.stop();
  $('btn-restart').onclick = () => k.restart();
  $('btn-open').onclick = () => k.openWeb();
  $('btn-check').onclick = () => k.checkUpdate();
  $('btn-update').onclick = () => k.installUpdate();
  $('btn-notes').onclick = async () => {
    const u = await k.updateState();
    alert(u.notes || 'Not yok');
  };
  $('btn-logfile').onclick = () => k.openLogFile();
  $('btn-clear').onclick = async () => {
    await k.clearLogs();
    logEl.textContent = '';
  };
  $('btn-data-open').onclick = () => k.openData();
  $('btn-data-choose').onclick = async () => {
    const dir = await k.chooseDataDir();
    if (dir) await patch({ dataDir: dir });
  };
  $('set-port').onchange = () => patch({ port: Number($('set-port').value) });
  $('set-autostart').onchange = () => patch({ autoStart: $('set-autostart').checked });
  $('set-login').onchange = () => patch({ openAtLogin: $('set-login').checked });
  $('set-tray').onchange = () => patch({ keepInTray: $('set-tray').checked });
}

init().catch((err) => {
  $('status-title').textContent = 'Arayüz yüklenemedi';
  $('status-sub').textContent = err.message;
});
