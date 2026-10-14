import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon.tsx';
import { Field, Pill, Progress, Spinner, WorkspaceHead } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { bytes } from '../lib/format.ts';
import { useSocketEvent } from '../lib/socket.ts';
import { createStore } from '../lib/store.ts';
import { toast, toastError } from '../lib/toast.ts';
import { useResource } from '../lib/useResource.ts';

interface SystemInfo {
  lan: string[];
  dataDir: string;
  hostname: string;
}

interface CaptionsStatus {
  engine: 'elevenlabs' | 'whisper' | null;
  elevenlabs: { connected: boolean; keyHint: string | null };
  whisper: {
    binary: boolean;
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

/** Ayarlar: altyazı motoru, telefondan erişim, verilerin yeri. */
export function Settings() {
  const phone = usePhoneUrl();
  const system = systemStore.use();
  return (
    <>
      <WorkspaceHead title="Ayarlar" tape="sistem" lead="Altyazı motorunu kur, telefondan nasıl açılacağını gör, verilerin nerede durduğunu öğren." guide="ayarlar" />
      <div className="ws-grid">
        <CaptionsPanel />
        <aside className="ws-stack">
          <section className="panel">
            <span className="panel-tape" aria-hidden="true" />
            <h2 className="panel-title">
              <Icon name="phone" size={18} /> Telefondan aç
            </h2>
            <p className="panel-sub">Telefonun bu bilgisayarla aynı Wi-Fi ağındaysa tarayıcısına şu adresi yaz:</p>
            {phone ? (
              <>
                <p className="big-url">{phone}</p>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => navigator.clipboard.writeText(phone).then(() => toast('Adres kopyalandı', 'ok'), () => toast('Kopyalanamadı', 'error'))}
                >
                  Adresi kopyala
                </button>
                <p className="field-help pad-top">Açılmazsa bilgisayarın güvenlik duvarı bağlantıya izin istemiş olabilir; macOS'ta çıkan uyarıda "İzin ver"i seç. Telefonda ayrıca giriş yapman gerekir.</p>
              </>
            ) : (
              <p className="muted">Bu bilgisayar bir ağa bağlı görünmüyor.</p>
            )}
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
      </div>
    </>
  );
}

function CaptionsPanel() {
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
          <h2 className="panel-title">Altyazı motoru</h2>
          <p className="panel-sub">Kliplerdeki konuşma yazıya dökülür. Anahtar bağlıysa önce ElevenLabs, yoksa yerel model kullanılır.</p>
        </div>
        <Pill tone={s.engine ? 'ok' : 'neutral'}>{s.engine === 'elevenlabs' ? 'ElevenLabs etkin' : s.engine === 'whisper' ? 'Yerel model etkin' : 'Altyazı kapalı'}</Pill>
      </header>

      <div className="engine-grid">
        <div className="engine">
          <h3>
            <Icon name="folder" size={16} /> Yerel model <span className="tag">ücretsiz</span>
          </h3>
          <p className="muted">Bu bilgisayarda çalışır, internet gerektirmez. Model bir kez indirilir.</p>
          {!s.whisper.binary ? (
            <p className="notice-box">
              whisper.cpp kurulu değil. Terminalde <code>brew install whisper-cpp</code> çalıştırıp bu sayfayı yenile.
            </p>
          ) : (
            <ul className="model-list">
              {s.whisper.models.map((m) => {
                const isDownloading = download?.id === m.id;
                return (
                  <li key={m.id} className={s.whisper.active === m.id ? 'model model-on' : 'model'}>
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
                        <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void call(() => api.del(`/api/captions/models/${m.id}`))}>
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
              <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void call(() => api.del('/api/captions/elevenlabs'), 'ElevenLabs kaldırıldı')}>
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
