import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon.tsx';
import { Field, Pill, Progress, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { bytes } from '../lib/format.ts';
import { useSocketEvent } from '../lib/socket.ts';
import { createStore } from '../lib/store.ts';
import { deleteWithUndo, toast, toastError } from '../lib/toast.ts';
import { refreshJobs } from '../lib/jobs.ts';
import { useResource } from '../lib/useResource.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { markOnboarded, useSession } from '../lib/session.ts';

interface SystemInfo {
  lan: string[];
  dataDir: string;
  hostname: string;
}

interface CaptionsStatus {
  engine: 'elevenlabs' | 'whisper' | null;
  platform: string;
  elevenlabs: { connected: boolean; keyHint: string | null };
  whisper: {
    binary: boolean;
    binaryPath: string | null;
    active: string | null;
    models: { id: string; label: string; hint: string; sizeBytes: number; installed: boolean }[];
    download: { id: string; percent: number } | null;
  };
}

const systemStore = createStore<SystemInfo | null>(null);
let systemRequested = false;

/** Aynı Wi-Fi'daki telefondan açılacak adres (arayüzün çalıştığı port ile). */
export function usePhoneUrl(): string | null {
  const info = systemStore.use();
  useEffect(() => {
    if (systemRequested) return;
    systemRequested = true;
    api.get<SystemInfo>('/api/system').then(systemStore.set, () => (systemRequested = false));
  }, []);
  const ip = info?.lan[0];
  if (!ip) return null;
  return `${location.protocol}//${ip}${location.port ? `:${location.port}` : ''}`;
}

/** Ayarlar: Kick uygulaması, altyazı motoru, çıktılar, disk, telefondan erişim. */
export function Settings() {
  const { local } = useSession();
  const system = systemStore.use();
  usePhoneUrl();
  return (
    <>
      <WorkspaceHead title="Ayarlar" tape="sistem" lead="Sohbete klip atma, otomatik altyazı, videoların kaydedileceği klasör, kapladığı yer ve telefondan erişim." guide="ayarlar" />
      {!local && <p className="notice-box live-note">Telefondan açtın. Bilgisayar geneli ayarlar (altyazı, kayıt klasörü, disk, telefon erişimi) yalnız Kesit'in kurulu olduğu bilgisayardan değiştirilebilir.</p>}
      <div className="ws-grid">
        <div className="ws-stack">
          <KickAppPanel />
          {local && <CaptionsPanel />}
          {local && <ExportPanel />}
          {local && <StoragePanel />}
        </div>
        {local && (
          <aside className="ws-stack">
            <LanPanel />
            <section className="panel">
              <h2 className="panel-title">
                <Icon name="sparkle" size={18} /> Kurulum sihirbazı
              </h2>
              <p className="panel-sub">Kanal, logo, açılış/kapanış videosu, Zernio ve genel ayarları adım adım yeniden gözden geçir.</p>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() =>
                  markOnboarded(false)
                    .then(() => navigate(sectionPath('kurulum')))
                    .catch(toastError)
                }
              >
                Sihirbazı aç
              </button>
            </section>
            <section className="panel">
              <h2 className="panel-title">
                <Icon name="folder" size={18} /> Veriler bu bilgisayarda
              </h2>
              <p className="panel-sub">Klipler, kayıtlar, logo ve intro dosyaları, arşiv ve ayarlar yalnız bu klasörde durur; hiçbir yere yüklenmez (paylaşmadıkça).</p>
              {system && <p className="path-box">{system.dataDir}</p>}
              <p className="field-help">Yedeklemek için bu klasörü kopyalaman yeterli.</p>
            </section>
          </aside>
        )}
      </div>
    </>
  );
}

interface LanStatus {
  enabled: boolean;
  code: string | null;
  codeExpiresAt: string | null;
  devices: { name: string; pairedAt: string }[];
}

/** Telefondan erişim: varsayılan kapalı; açıkken cihazlar ekrandaki kodla eşlenir. */
function LanPanel() {
  const phone = usePhoneUrl();
  const data = useResource(() => api.get<LanStatus>('/api/lan'));
  const [busy, setBusy] = useState(false);
  const d = data.data;
  const call = async (fn: () => Promise<LanStatus>) => {
    setBusy(true);
    try {
      data.setData(await fn());
      // Ray altındaki erişim notu tazelensin.
      window.dispatchEvent(new Event('kesit:lan'));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <span className="panel-tape" aria-hidden="true" />
      <h2 className="panel-title">
        <Icon name="phone" size={18} /> Telefondan erişim
      </h2>
      <p className="panel-sub">Kapalıyken Kesit'e yalnız bu bilgisayardan girilir. Açarsan aynı Wi-Fi'daki cihazlar, bu ekranda göstereceğin kodla eşlenerek girebilir.</p>
      {!d ? (
        <Spinner />
      ) : (
        <div className="stack">
          <Switch checked={d.enabled} disabled={busy} onChange={(v) => void call(() => api.put<LanStatus>('/api/lan', { enabled: v }))} label="Telefondan erişime izin ver" hint={d.enabled ? 'Kapatınca eşlenen cihazların erişimi de kalkar' : undefined} />
          {d.enabled && (
            <>
              {phone && (
                <>
                  <p className="big-url">{phone}</p>
                  <p className="field-help">Telefonun tarayıcısına bu adresi yaz, sonra aşağıdaki kodu gir.</p>
                </>
              )}
              {d.code ? (
                <div className="pair-show">
                  <span className="eyebrow">Eşleme kodu</span>
                  <b>{d.code.replace(/(\d{3})(\d{3})/, '$1 $2')}</b>
                  <span className="muted">10 dakika geçerli, tek kullanımlık</span>
                </div>
              ) : null}
              <div className="row-gap">
                <button type="button" className="btn btn-accent btn-small" disabled={busy} onClick={() => void call(() => api.post<LanStatus>('/api/lan/code'))}>
                  {d.code ? 'Yeni kod üret' : 'Kod üret'}
                </button>
                {d.devices.length > 0 && (
                  <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void call(() => api.del<LanStatus>('/api/lan/devices'))}>
                    Eşlenen {d.devices.length} cihazı çıkar
                  </button>
                )}
              </div>
              <p className="field-help">Açılmazsa bilgisayarın güvenlik duvarı izin istemiş olabilir; macOS'ta çıkan uyarıda "İzin ver"i seç.</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function CaptionsPanel() {
  const status = useResource(() => api.get<CaptionsStatus>('/api/captions'));
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const s = status.data;

  useSocketEvent<{ id: string; percent: number; done?: boolean; failed?: boolean; error?: string; status?: CaptionsStatus }>('captions:download', (e) => {
    if (e.status) status.setData(e.status);
    else status.setData((d) => d && { ...d, whisper: { ...d.whisper, download: { id: e.id, percent: e.percent } } });
    if (e.done) toast('Altyazı modeli kuruldu', 'ok');
    if (e.failed) toast(e.error || 'Model indirilemedi', 'error');
  });

  const call = async (fn: () => Promise<CaptionsStatus>, done?: string) => {
    setBusy(true);
    try {
      status.setData(await fn());
      if (done) toast(done, 'ok');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const connect = (e: FormEvent) => {
    e.preventDefault();
    void call(() => api.put<CaptionsStatus>('/api/captions/elevenlabs', { apiKey: key }), 'ElevenLabs bağlandı').then(() => setKey(''));
  };

  if (!s) {
    return (
      <section className="panel">
        <Spinner />
      </section>
    );
  }

  const download = s.whisper.download;

  return (
    <section className="panel">
      <span className="panel-tape" aria-hidden="true" />
      <header className="panel-head">
        <div>
          <h2 className="panel-title">Otomatik altyazı</h2>
          <p className="panel-sub">Videolardaki konuşma yazıya dökülüp altyazı olarak eklenir. ElevenLabs bağlıysa o, değilse bu bilgisayardaki ücretsiz model kullanılır.</p>
        </div>
        <Pill tone={s.engine ? 'ok' : 'neutral'}>{s.engine === 'elevenlabs' ? 'ElevenLabs açık' : s.engine === 'whisper' ? 'Ücretsiz model açık' : 'Altyazı kapalı'}</Pill>
      </header>

      <div className="engine-grid">
        <div className="engine">
          <h3>
            <Icon name="folder" size={16} /> Bu bilgisayarda <span className="tag">ücretsiz</span>
          </h3>
          <p className="muted">İnternet olmadan çalışır. Bir kez indirilir.</p>
          {!s.whisper.binary ? (
            <p className="notice-box">
              Gerekli program (whisper) bu bilgisayarda kurulu değil.{' '}
              {s.platform === 'win32' ? (
                <>
                  Kesit App'te <b>Ayarlar → Kurulumu yeniden çalıştır</b> de; whisper kendiliğinden indirilir. Sonra sunucuyu yeniden başlatıp bu sayfayı yenile.
                </>
              ) : s.platform === 'darwin' ? (
                <>
                  Kesit App'te <b>Ayarlar → Kurulumu yeniden çalıştır</b> de (Homebrew varsa kurar) ya da Terminal'de <code>brew install whisper-cpp</code> çalıştır; sonra sunucuyu yeniden başlatıp bu sayfayı yenile.
                </>
              ) : (
                <>whisper.cpp kurup <code>whisper-cli</code> komutunu PATH'e ekle; sonra bu sayfayı yenile.</>
              )}
            </p>
          ) : (
            <ul className="model-list">
              {s.whisper.models.map((m) => {
                const isDownloading = download?.id === m.id;
                return (
                  <li key={m.id} className={s.whisper.active === m.id ? 'model model-on' : 'model model-recommended'}>
                    <span className="model-badge">
                      <Icon name="sparkle" size={12} /> Önerilen
                    </span>
                    <div className="model-head">
                      <b>{m.label}</b>
                      <span className="muted">{bytes(m.sizeBytes)}</span>
                    </div>
                    <span className="muted">{m.hint}</span>
                    {isDownloading ? (
                      <div className="stack-s">
                        <Progress value={download!.percent} label="Model indiriliyor" />
                        <div className="row-gap">
                          <span className="muted">%{download!.percent} indirildi</span>
                          <button type="button" className="btn btn-quiet btn-small" onClick={() => void api.post('/api/captions/models/cancel')}>
                            İptal
                          </button>
                        </div>
                      </div>
                    ) : m.installed ? (
                      <div className="row-gap">
                        {s.whisper.active === m.id ? (
                          <span className="status status-ready">Kullanılıyor</span>
                        ) : (
                          <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => void call(() => api.put(`/api/captions/models/${m.id}`), 'Model seçildi')}>
                            Bunu kullan
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-quiet btn-small"
                          disabled={busy}
                          onClick={() =>
                            deleteWithUndo({
                              label: 'Altyazı modeli kaldırıldı',
                              hide: () => status.setData((d) => d && { ...d, whisper: { ...d.whisper, models: d.whisper.models.map((x) => (x.id === m.id ? { ...x, installed: false } : x)) } }),
                              restore: () => void status.reload(),
                              commit: () => api.del<CaptionsStatus>(`/api/captions/models/${m.id}`).then(status.setData),
                            })
                          }
                        >
                          Kaldır
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="btn btn-accent btn-small" disabled={busy || !!download} onClick={() => void call(() => api.post(`/api/captions/models/${m.id}/download`))}>
                        <Icon name="download" size={14} /> İndir ve kur
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="engine">
          <h3>
            <Icon name="key" size={16} /> ElevenLabs <span className="tag">bulut</span>
          </h3>
          <p className="muted">Daha hızlı ve gürültülü yayın sesinde daha isabetli. Ücretli bir ElevenLabs hesabı ister.</p>
          {s.elevenlabs.connected ? (
            <div className="stack-s">
              <p>
                <span className="status status-ready">Bağlı</span> <span className="muted">anahtar {s.elevenlabs.keyHint}</span>
              </p>
              <button
                type="button"
                className="btn btn-quiet btn-small"
                disabled={busy}
                onClick={() =>
                  deleteWithUndo({
                    label: 'ElevenLabs bağlantısı kaldırıldı',
                    hide: () => status.setData((d) => d && { ...d, elevenlabs: { connected: false, keyHint: null } }),
                    restore: () => void status.reload(),
                    commit: () => api.del<CaptionsStatus>('/api/captions/elevenlabs').then(status.setData),
                  })
                }
              >
                Bağlantıyı kaldır
              </button>
            </div>
          ) : (
            <form className="stack-s" onSubmit={connect}>
              <ol className="steps steps-tight">
                <li>
                  <a className="link" href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer">
                    elevenlabs.io
                  </a>{' '}
                  → Settings → API Keys.
                </li>
                <li>"Create API Key" ile anahtar oluştur; Speech to Text izni açık olsun.</li>
                <li>Anahtarı buraya yapıştır.</li>
              </ol>
              <Field label="API anahtarı" htmlFor="el-key" help="Anahtar şifreli olarak yalnız bu bilgisayarda saklanır.">
                <input id="el-key" className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk_…" />
              </Field>
              <button type="submit" className="btn btn-primary btn-small" disabled={busy || key.trim().length < 20}>
                {busy ? <Spinner size={12} /> : null} Bağla
              </button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}

interface ExportSettings {
  enabled: boolean;
  dir: string;
  defaultDir: string;
  isDefault: boolean;
}

/** Hazır videoların kopyalandığı klasör (varsayılan: İndirilenler/Kesit). */
export function ExportPanel() {
  const data = useResource(() => api.get<ExportSettings>('/api/export'));
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data.data) setDir(data.data.dir);
  }, [data.data]);

  const save = async (patch: Partial<{ enabled: boolean; dir: string | null }>, done?: string) => {
    setBusy(true);
    try {
      data.setData(await api.put<ExportSettings>('/api/export', patch));
      if (done) toast(done, 'ok');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const d = data.data;
  return (
    <section className="panel">
      <h2 className="panel-title">
        <Icon name="download" size={18} /> Videolar nereye kaydedilsin
      </h2>
      <p className="panel-sub">Hazır olan her dikey video, yatay kesit ve paylaşıma hazır kayıt bu klasöre kopyalanır: Dikey, Yatay ve Kayıtlar klasörlerine ayrılır.</p>
      {!d ? (
        <Spinner />
      ) : (
        <div className="stack">
          <Switch checked={d.enabled} onChange={(v) => void save({ enabled: v })} label="Hazır olanları otomatik kopyala" />
          <Field label="Klasör" help={d.isDefault ? 'Bilgisayarın İndirilenler klasörü (varsayılan)' : `Varsayılan: ${d.defaultDir}`} htmlFor="export-dir">
            <div className="inline-form">
              <input id="export-dir" className="input mono" value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} />
              <button type="button" className="btn btn-primary" disabled={busy || dir === d.dir || !dir.trim()} onClick={() => void save({ dir: dir.trim() }, 'Klasör değiştirildi')}>
                Kaydet
              </button>
            </div>
          </Field>
          <div className="row-gap">
            <button type="button" className="btn btn-secondary btn-small" onClick={() => void api.post('/api/export/reveal').catch(toastError)}>
              <Icon name="folder" size={14} /> Klasörü aç
            </button>
            {!d.isDefault && (
              <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void save({ dir: null }, 'Varsayılan klasöre dönüldü')}>
                Varsayılana dön
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

interface StorageReport {
  total: number;
  categories: { id: string; label: string; hint: string; bytes: number; cleanable: boolean }[];
  exportDir: { path: string; bytes: number };
}

/** Kesit'in bilgisayarda kapladığı yer ve temizleme. */
function StoragePanel() {
  const report = useResource(() => api.get<StorageReport>('/api/storage'));
  const [pending, setPending] = useState<string | null>(null);
  const r = report.data;
  const max = Math.max(1, ...(r?.categories.map((c) => c.bytes) ?? [1]));

  const clean = (id: 'cache' | 'videos') => {
    const label = id === 'cache' ? 'Geçici dosyalar temizleniyor' : 'Üretilen videolar siliniyor';
    deleteWithUndo({
      label,
      hide: () => setPending(id),
      restore: () => setPending(null),
      commit: () =>
        api.post<{ freed: number; skipped?: number }>(`/api/storage/${id}/clear`).then((res) => {
          toast(`${bytes(res.freed)} yer açıldı${res.skipped ? ` · süren ${res.skipped} iş atlandı` : ''}`, 'ok');
        }),
      done: () => {
        setPending(null);
        void report.reload();
        void refreshJobs().catch(() => {});
      },
    });
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2 className="panel-title">
            <Icon name="archive" size={18} /> Disk kullanımı
          </h2>
          <p className="panel-sub">Kesit'in bu bilgisayarda kapladığı yer.</p>
        </div>
        {r && <span className="disk-total">{bytes(r.total)}</span>}
      </header>
      {!r ? (
        <Spinner />
      ) : (
        <>
          <ul className="disk-list">
            {r.categories.map((c) => (
              <li key={c.id} className={pending === c.id ? 'disk-row disk-row-pending' : 'disk-row'}>
                <div className="disk-head">
                  <b>{c.label}</b>
                  <span>{pending === c.id ? 'temizlenecek' : bytes(c.bytes)}</span>
                </div>
                <span className="disk-bar">
                  <span style={{ width: `${(c.bytes / max) * 100}%` }} />
                </span>
                <span className="muted">{c.hint}</span>
              </li>
            ))}
          </ul>
          <div className="row-gap pad-top">
            <button type="button" className="btn btn-secondary btn-small" disabled={!!pending} onClick={() => clean('cache')}>
              <Icon name="refresh" size={14} /> Geçici dosyaları temizle
            </button>
            <button type="button" className="btn btn-quiet btn-small stage-delete" disabled={!!pending} onClick={() => clean('videos')}>
              <Icon name="trash" size={14} /> Üretilen videoları sil
            </button>
          </div>
          <p className="field-help pad-top">
            Silinen videoların kaydı Arşiv'de kalır. İndirilenler klasörüne kopyalananlar ({bytes(r.exportDir.bytes)}) senin dosyalarındır; Kesit onlara dokunmaz.
          </p>
        </>
      )}
    </section>
  );
}

interface KickAppStatus {
  configured: boolean;
  clientIdHint: string | null;
  connected: boolean;
  account: string | null;
}

const KICK_RESULT: Record<string, { text: string; tone: 'ok' | 'error' }> = {
  baglandi: { text: 'Kick hesabın bağlandı — anlık klip hazır', tone: 'ok' },
  reddedildi: { text: 'Kick izni reddedildi', tone: 'error' },
  gecersiz: { text: 'Bağlantı isteği geçersiz ya da süresi doldu, tekrar dene', tone: 'error' },
  hata: { text: 'Kick bağlantısı tamamlanamadı — Client ID, Secret ve dönüş adresini kontrol et', tone: 'error' },
  kurulmadi: { text: 'Önce Kick uygulamanın bilgilerini kaydet', tone: 'error' },
  adres: { text: 'Bağlantıyı bu bilgisayarın kendi adresinden başlat', tone: 'error' },
};

/**
 * Kullanıcının kendi Kick geliştirici uygulaması: sohbete "!clip" yazmak
 * (anlık klip) için. Anahtarlar şifreli olarak yalnız bu bilgisayarda durur.
 */
function KickAppPanel() {
  const data = useResource(() => api.get<KickAppStatus>('/api/kick-app'));
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const redirectUri = `${location.origin}/auth/kick/callback`;
  const onLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const result = params.get('kick');
    if (!result) return;
    const msg = KICK_RESULT[result];
    if (msg) toast(msg.text, msg.tone);
    history.replaceState(null, '', location.pathname);
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      data.setData(await api.put<KickAppStatus>('/api/kick-app', { clientId, clientSecret: secret }));
      setClientId('');
      setSecret('');
      toast('Kick uygulaması kaydedildi — şimdi hesabını bağla', 'ok');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const connect = () => location.assign(`/auth/kick/connect?origin=${encodeURIComponent(location.origin)}`);
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast('Kopyalandı', 'ok'), () => toast('Kopyalanamadı', 'error'));
  const d = data.data;

  return (
    <section className="panel" aria-labelledby="kickapp-title">
      <span className="panel-tape" aria-hidden="true" />
      <header className="panel-head">
        <div>
          <h2 id="kickapp-title" className="panel-title">
            <Icon name="bolt" size={18} /> Sohbete klip atma (Kick bağlantısı)
          </h2>
          <p className="panel-sub">Canlı'daki anlık klip düğmeleri sohbete "!clip" yazar. Bunun için kendi Kick geliştirici uygulamanı oluşturup bağlarsın; anahtarlar yalnız bu bilgisayarda, şifreli durur.</p>
        </div>
        {d && <Pill tone={d.connected ? 'ok' : 'neutral'}>{d.connected ? `Bağlı${d.account ? `: ${d.account}` : ''}` : d.configured ? 'Hesap bağlanmadı' : 'Kurulmadı'}</Pill>}
      </header>

      {!d ? (
        <Spinner />
      ) : (
        <div className="stack">
          {!onLocalhost && (
            <p className="notice-box">
              Şu an {location.host} adresinden açtın. Kurulumu bu bilgisayarda <b>localhost</b> adresinden yap; Kick'e kaydettiğin dönüş adresi açtığın adresle birebir aynı olmalı.
            </p>
          )}
          <ol className="howto-steps">
            <li>
              <span className="guide-num">1</span>
              <div>
                <b>Kick'te uygulama oluştur</b>
                <p>
                  <a className="link" href="https://kick.com/settings/developer" target="_blank" rel="noreferrer">
                    kick.com → Ayarlar → Geliştirici
                  </a>{' '}
                  sayfasında yeni bir uygulama oluştur. Adı serbest (ör. "Kesit").
                </p>
              </div>
            </li>
            <li>
              <span className="guide-num">2</span>
              <div>
                <b>Dönüş adresini (Redirect URL) yapıştır</b>
                <p className="copy-line">
                  <code>{redirectUri}</code>
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => void copy(redirectUri)}>
                    Kopyala
                  </button>
                </p>
                <p>İzinlerden kullanıcı bilgisini okuma ve sohbete yazma (chat:write) seçili olsun.</p>
              </div>
            </li>
            <li>
              <span className="guide-num">3</span>
              <div>
                <b>Client ID ve Client Secret'ı buraya gir</b>
                {d.configured ? (
                  <p>
                    Kayıtlı: <code>{d.clientIdHint}</code>{' '}
                    <button
                      type="button"
                      className="link"
                      onClick={() =>
                        deleteWithUndo({
                          label: 'Kick uygulaması kaldırıldı',
                          hide: () => data.setData((x) => x && { ...x, configured: false, connected: false, account: null, clientIdHint: null }),
                          restore: () => void data.reload(),
                          commit: () => api.del<KickAppStatus>('/api/kick-app').then(data.setData),
                        })
                      }
                    >
                      Kaldır
                    </button>
                  </p>
                ) : (
                  <div className="stack-s pad-top-s">
                    <input className="input mono" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Client ID" />
                    <input className="input mono" type="password" placeholder="Client Secret" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" aria-label="Client Secret" />
                    <button type="button" className="btn btn-primary btn-small" disabled={busy || !clientId.trim() || !secret.trim()} onClick={() => void save()}>
                      {busy ? <Spinner size={12} /> : null} Kaydet
                    </button>
                  </div>
                )}
              </div>
            </li>
            <li>
              <span className="guide-num">4</span>
              <div>
                <b>Kick hesabını bağla</b>
                <p>Kick'e gidip izin verirsin, sonra buraya dönersin.</p>
                <div className="row-gap pad-top-s">
                  <button type="button" className="btn btn-accent btn-small" disabled={!d.configured} onClick={connect}>
                    <Icon name="link" size={14} /> {d.connected ? 'Yeniden bağla' : 'Kick hesabını bağla'}
                  </button>
                  {d.connected && (
                    <button
                      type="button"
                      className="btn btn-quiet btn-small"
                      onClick={() =>
                        deleteWithUndo({
                          label: 'Kick hesap bağlantısı kaldırıldı',
                          hide: () => data.setData((x) => x && { ...x, connected: false, account: null }),
                          restore: () => void data.reload(),
                          commit: () => api.del<KickAppStatus>('/api/kick-app/connection').then(data.setData),
                        })
                      }
                    >
                      Bağlantıyı kaldır
                    </button>
                  )}
                </div>
              </div>
            </li>
          </ol>
        </div>
      )}
    </section>
  );
}
