/* Kesit App arayüzü — tek dosya, çerçevesiz. window.kesit preload'dan gelir. */
const $ = (id) => document.getElementById(id);
const k = window.kesit;

const STATE = {
  stopped: { title: 'Sunucu kapalı', tone: 'off' },
  starting: { title: 'Başlatılıyor…', tone: 'busy' },
  running: { title: 'Çalışıyor', tone: 'on' },
  stopping: { title: 'Durduruluyor…', tone: 'busy' },
  error: { title: 'Hata', tone: 'err' },
};
const STEP_ICON = { running: '…', ok: '✓', skip: '–', fail: '✕' };

let state = null;
let info = null;
let settings = null;
let view = 'home';
let uptimeTimer = null;

const fmtUptime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk ${s % 60} sn`;
  const h = Math.floor(m / 60);
  return `${h} sa ${m % 60} dk`;
};

/* ── Görünümler ─────────────────────────────────────────────────────────── */

function show(next) {
  view = next;
  for (const v of ['home', 'setup', 'settings', 'logs']) $(`view-${v}`).hidden = v !== next;
  $('btn-back').hidden = next === 'home' || next === 'setup';
  $('btn-settings').hidden = next !== 'home';
  $('brand-sub').textContent = { home: 'Kick klip stüdyosu · yerel sunucu', setup: 'İlk kurulum', settings: 'Ayarlar', logs: 'Günlükler' }[next];
  if (next === 'logs') logEl.scrollTop = logEl.scrollHeight;
}

/* ── Sunucu durumu ──────────────────────────────────────────────────────── */

function renderState(s) {
  state = s;
  const spec = STATE[s.state] || STATE.stopped;
  const running = s.state === 'running';
  const busy = s.state === 'starting' || s.state === 'stopping';
  $('dot').className = `dot dot-${spec.tone}`;
  $('status-title').textContent = spec.title;
  $('status-sub').textContent = running && s.startedAt ? `Çalışma süresi ${fmtUptime(Date.now() - s.startedAt)}` : s.state === 'error' ? 'Sunucu çalışmıyor; günlüğe bak.' : busy ? 'Birkaç saniye…' : 'Çalışma süresi —';
  $('btn-start').disabled = running || busy;
  $('btn-stop').disabled = !running && !busy;
  $('open-row').hidden = !running;
  $('open-url').textContent = running ? s.url : '';
  $('status-error').hidden = !s.lastError;
  $('status-error').textContent = s.lastError || '';
  document.title = running ? `Kesit App — çalışıyor` : 'Kesit App';
  clearInterval(uptimeTimer);
  if (running) uptimeTimer = setInterval(() => renderState(state), 1000);
}

/* ── Güncelleme ─────────────────────────────────────────────────────────── */

function renderUpdate(u) {
  const text = $('update-text');
  const actions = $('update-actions');
  const prog = $('update-progress');
  actions.hidden = true;
  prog.hidden = true;
  $('btn-notes').hidden = !u.notes;
  $('btn-check').disabled = u.status === 'checking' || u.status === 'downloading' || u.status === 'installing';
  switch (u.status) {
    case 'checking':
      text.textContent = 'Bakılıyor…';
      break;
    case 'none':
      text.textContent = `Güncel: v${u.current}${u.latest ? '' : ' (henüz yayın yok)'}`;
      break;
    case 'available':
      text.textContent = `Yeni sürüm var: v${u.latest} (sende v${u.current})${u.error ? ` — ${u.error}` : ''}`;
      actions.hidden = false;
      $('btn-update').textContent = 'İndir ve kur';
      break;
    case 'downloading':
      text.textContent = `İndiriliyor %${u.progress}`;
      prog.hidden = false;
      prog.firstElementChild.style.width = `${u.progress}%`;
      break;
    case 'installing':
      text.textContent = `v${u.latest} kuruluyor, uygulama birazdan yeniden başlayacak…`;
      prog.hidden = false;
      prog.firstElementChild.style.width = '100%';
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

/* ── Kurulum ────────────────────────────────────────────────────────────── */

function renderSetup(s) {
  const ol = $('setup-steps');
  ol.textContent = '';
  for (const st of s.steps) {
    const li = document.createElement('li');
    li.className = `step step-${st.status}`;
    const ic = document.createElement('span');
    ic.className = 'step-ic';
    ic.textContent = STEP_ICON[st.status] || '';
    const body = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = st.label;
    const d = document.createElement('span');
    d.className = 'muted small';
    d.textContent = st.detail;
    body.append(b, d);
    li.append(ic, body);
    ol.appendChild(li);
  }
  const finished = !s.running && s.steps.length > 0;
  $('btn-setup-run').hidden = s.running || finished;
  $('btn-setup-run').disabled = s.running;
  $('btn-setup-done').hidden = !finished;
  $('btn-setup-skip').hidden = s.running || finished;
}

/* ── Günlük ─────────────────────────────────────────────────────────────── */

const logEl = $('log');
const fmtTime = (t) => new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function appendLog(e) {
  const line = document.createElement('div');
  line.className = e.s === 'err' ? 'ln ln-err' : e.s === 'app' ? 'ln ln-app' : 'ln';
  line.textContent = `${fmtTime(e.t)}  ${e.m}`;
  logEl.appendChild(line);
  while (logEl.childElementCount > 2000) logEl.removeChild(logEl.firstChild);
  if ($('log-follow').checked) logEl.scrollTop = logEl.scrollHeight;
}

/* ── Ayarlar ────────────────────────────────────────────────────────────── */

function renderSettings(s) {
  settings = s;
  $('set-port').value = s.port;
  $('set-data').value = s.dataDir;
  $('set-cover').value = s.coverUrl;
  $('set-autostart').checked = !!s.autoStart;
  $('set-login').checked = !!s.openAtLogin;
  $('set-tray').checked = !!s.keepInTray;
  $('set-short').checked = !!s.shortAddress;
}

async function patch(p) {
  renderSettings(await k.setSettings(p));
}

/* ── Başlat ─────────────────────────────────────────────────────────────── */

async function init() {
  info = await k.info();
  $('short-host').textContent = `http://${info.shortHost}`;
  renderSettings(await k.getSettings());
  renderState(await k.state());
  renderUpdate(await k.updateState());
  for (const e of await k.logs()) appendLog(e);
  const su = await k.setupState();
  renderSetup(su);
  show(su.done ? 'home' : 'setup');

  k.onState(renderState);
  k.onLog(appendLog);
  k.onUpdate(renderUpdate);
  k.onSetup(renderSetup);

  $('btn-start').onclick = () => k.start();
  $('btn-stop').onclick = () => k.stop();
  $('btn-open').onclick = () => k.openWeb();
  $('btn-cover').onclick = () => k.openCover();
  $('btn-settings').onclick = () => show('settings');
  $('btn-back').onclick = () => show(view === 'logs' ? 'settings' : 'home');
  $('btn-logs').onclick = () => show('logs');
  $('btn-check').onclick = () => k.checkUpdate();
  $('btn-update').onclick = () => k.installUpdate();
  $('btn-notes').onclick = async () => {
    const u = await k.updateState();
    alert(u.notes || 'Not yok');
  };
  $('btn-setup-run').onclick = () => k.runSetup();
  $('btn-setup-again').onclick = () => {
    show('setup');
    k.runSetup();
  };
  $('btn-setup-done').onclick = () => {
    show('home');
    if (settings.autoStart && state.state === 'stopped') k.start();
  };
  $('btn-setup-skip').onclick = async () => {
    await patch({ setupDone: true });
    show('home');
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
  $('set-cover').onchange = () => patch({ coverUrl: $('set-cover').value.trim() });
  $('set-autostart').onchange = () => patch({ autoStart: $('set-autostart').checked });
  $('set-login').onchange = () => patch({ openAtLogin: $('set-login').checked });
  $('set-tray').onchange = () => patch({ keepInTray: $('set-tray').checked });
  $('set-short').onchange = () => patch({ shortAddress: $('set-short').checked });
  $('btn-uninstall').onclick = () => k.uninstall();
  $('link-livorass').onclick = (e) => {
    e.preventDefault();
    k.openExternal('https://kick.com/livorass');
  };
}

init().catch((err) => {
  $('status-title').textContent = 'Arayüz yüklenemedi';
  $('status-sub').textContent = err.message;
});
