import { useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon.tsx';
import { platformLabel } from '../components/PublishDialog.tsx';
import { Empty, Field, Modal, Spinner, WorkspaceHead } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { dateTime, duration } from '../lib/format.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { ScheduleEntry, ZernioSummary } from '../lib/types.ts';
import { useResource } from '../lib/useResource.ts';

const STATUS: Record<string, string> = {
  publishing: 'Gönderiliyor',
  pending: 'Sırada',
  scheduled: 'Planlandı',
  published: 'Paylaşıldı',
  partial: 'Kısmen',
  failed: 'Başarısız',
  unknown: 'Belirsiz',
};

/** Paylaşım: Zernio bağlantısı ve gönderi takvimi. */
export function Publish() {
  const zernio = useResource(() => api.get<ZernioSummary>('/api/zernio'));
  const schedule = useResource(() => api.get<{ entries: ScheduleEntry[] }>('/api/schedule').then((r) => r.entries));

  const now = Date.now();
  const entries = schedule.data ?? [];
  const upcoming = entries.filter((e) => e.publishStatus === 'scheduled' && e.scheduledFor && new Date(e.scheduledFor).getTime() > now);
  const past = entries.filter((e) => !upcoming.includes(e));

  return (
    <>
      <WorkspaceHead title="Paylaşım" tape="zernio" lead="Zernio hesabını bağla; TikTok, YouTube, Instagram ve diğer hesaplarına Kesit'ten paylaş ya da planla." />
      <div className="ws-grid">
        <div className="ws-stack">
          <section className="panel">
            <span className="panel-tape" aria-hidden="true" />
            <header className="panel-head">
              <h2 className="panel-title">Yaklaşan paylaşımlar</h2>
              <button type="button" className="btn btn-quiet btn-small" onClick={() => void schedule.reload()}>
                <Icon name="refresh" size={14} /> Yenile
              </button>
            </header>
            {schedule.loading && !schedule.data ? <Spinner /> : upcoming.length ? <EntryList entries={upcoming} onRefresh={schedule.reload} /> : <p className="muted">Planlanmış paylaşım yok.</p>}
          </section>
          <section className="panel">
            <h2 className="panel-title">Son gönderiler</h2>
            {past.length ? (
              <EntryList entries={past} onRefresh={schedule.reload} />
            ) : (
              <Empty
                icon="share"
                title="Henüz paylaşım yok"
                action={
                  <button type="button" className="btn btn-secondary" onClick={() => navigate(sectionPath('kutuphane'))}>
                    Kütüphane'den paylaş
                  </button>
                }
              />
            )}
          </section>
        </div>
        <aside className="ws-stack">
          <ConnectionPanel zernio={zernio.data} loading={zernio.loading} onChange={zernio.reload} />
        </aside>
      </div>
    </>
  );
}

function EntryList({ entries, onRefresh }: { entries: ScheduleEntry[]; onRefresh: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const refresh = async (id: number) => {
    setBusy(id);
    try {
      await api.get(`/api/jobs/${id}/publish-status`);
      onRefresh();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };
  return (
    <ul className="schedule">
      {entries.map((e) => (
        <li key={e.jobId} className="schedule-item">
          <button type="button" className="schedule-thumb" onClick={() => navigate(sectionPath('kutuphane', e.jobId))} aria-label={`${e.title} klibini aç`}>
            {e.thumbnailUrl ? <img src={e.thumbnailUrl} alt="" loading="lazy" /> : <Icon name="vertical" />}
          </button>
          <div className="schedule-body">
            <b className="schedule-title">{e.title}</b>
            <span className="muted">
              {e.scheduledFor ? `${dateTime(e.scheduledFor)} için` : e.publishedAt ? dateTime(e.publishedAt) : dateTime(e.createdAt)} · {duration(e.duration)}
            </span>
            <span className="platform-row">
              {e.platforms.map((p) => (
                <span key={p.platform} className={`platform-chip platform-chip-${p.status}`}>
                  <span className={`platform-badge platform-${p.platform}`}>{platformLabel(p.platform).slice(0, 2)}</span>
                  {STATUS[p.status] ?? p.status}
                </span>
              ))}
            </span>
          </div>
          <span className={`status status-${e.publishStatus === 'published' ? 'ready' : e.publishStatus === 'failed' ? 'failed' : 'busy'}`}>{STATUS[e.publishStatus ?? ''] ?? '—'}</span>
          <button type="button" className="btn btn-quiet btn-icon" onClick={() => refresh(e.jobId)} disabled={busy === e.jobId} aria-label="Durumu yenile">
            {busy === e.jobId ? <Spinner size={12} /> : <Icon name="refresh" size={14} />}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ConnectionPanel({ zernio, loading, onChange }: { zernio: ZernioSummary | null; loading: boolean; onChange: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [profiles, setProfiles] = useState<{ id: string; name: string }[] | null>(null);
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post<{ profiles: { id: string; name: string }[] }>('/api/zernio/profiles', { apiKey });
      setProfiles(res.profiles);
      setProfileId(res.profiles[0]?.id ?? '');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    try {
      await api.put('/api/zernio', { apiKey, profileId });
      toast('Zernio bağlandı', 'ok');
      setApiKey('');
      setProfiles(null);
      onChange();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    try {
      await api.del('/api/zernio');
      setConfirm(false);
      toast('Zernio bağlantısı kaldırıldı', 'ok');
      onChange();
    } catch (err) {
      toastError(err);
    }
  };

  if (loading && !zernio) {
    return (
      <section className="panel">
        <Spinner />
      </section>
    );
  }

  if (zernio?.connected) {
    return (
      <section className="panel">
        <span className="panel-tape" aria-hidden="true" />
        <header className="panel-head">
          <div>
            <h2 className="panel-title">Zernio bağlı</h2>
            <p className="panel-sub">
              Profil: <b>{zernio.profile?.name}</b> · anahtar {zernio.keyHint}
            </p>
          </div>
        </header>
        {zernio.error && <p className="field-error">{zernio.error}</p>}
        {zernio.accounts.length ? (
          <ul className="platform-list">
            {zernio.accounts.map((a) => (
              <li key={a.id}>
                <span className={`platform-badge platform-${a.platform}`}>{platformLabel(a.platform).slice(0, 2)}</span>
                <span>{a.displayName}</span>
                <span className="muted">{platformLabel(a.platform)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Bu profilde bağlı sosyal hesap yok. Hesaplarını Zernio panelinden bağla, burada otomatik görünür.</p>
        )}
        <div className="row-gap pad-top">
          <a className="btn btn-secondary btn-small" href="https://zernio.com" target="_blank" rel="noreferrer">
            Zernio panelini aç
          </a>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setConfirm(true)}>
            Bağlantıyı kaldır
          </button>
        </div>
        <Modal
          open={confirm}
          onClose={() => setConfirm(false)}
          title="Zernio bağlantısı kaldırılsın mı?"
          footer={
            <>
              <button type="button" className="btn btn-quiet" onClick={() => setConfirm(false)}>
                Vazgeç
              </button>
              <button type="button" className="btn btn-danger" onClick={disconnect}>
                Kaldır
              </button>
            </>
          }
        >
          <p className="notice">API anahtarı Kesit'ten silinir. Planlanmış gönderiler Zernio'da kalır; otomatik paylaşım durur.</p>
        </Modal>
      </section>
    );
  }

  return (
    <section className="panel">
      <span className="panel-tape" aria-hidden="true" />
      <h2 className="panel-title">Zernio'yu bağla</h2>
      <ol className="steps">
        <li>
          <a className="link" href="https://zernio.com" target="_blank" rel="noreferrer">
            zernio.com
          </a>
          'da sosyal hesaplarını bağla.
        </li>
        <li>Ayarlar → API bölümünden bir anahtar oluştur.</li>
        <li>Anahtarı buraya yapıştır, profilini seç.</li>
      </ol>
      <form className="stack" onSubmit={verify}>
        <Field label="API anahtarı" help="Anahtar sunucuda şifreli saklanır, sana bir daha gösterilmez." htmlFor="z-key">
          <input id="z-key" className="input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk_…" />
        </Field>
        {!profiles ? (
          <button type="submit" className="btn btn-primary" disabled={busy || apiKey.trim().length < 10}>
            {busy ? <Spinner /> : 'Anahtarı doğrula'}
          </button>
        ) : (
          <>
            <Field label="Profil" htmlFor="z-profile">
              <select id="z-profile" className="input" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <button type="button" className="btn btn-accent" onClick={connect} disabled={busy || !profileId}>
              {busy ? <Spinner /> : <Icon name="check" size={16} />} Bağla
            </button>
          </>
        )}
      </form>
    </section>
  );
}
