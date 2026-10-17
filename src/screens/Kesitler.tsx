import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { Empty, Modal, Pill, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api, query } from '../lib/api.ts';
import { useChannelScope } from '../lib/channelScope.ts';
import { bytes, duration, relative } from '../lib/format.ts';
import { refreshJobs } from '../lib/jobs.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { useSocketEvent } from '../lib/socket.ts';
import { deleteWithUndo, toast, toastError } from '../lib/toast.ts';
import type { ChannelInfo, Snippet } from '../lib/types.ts';
import { useInterval, useResource } from '../lib/useResource.ts';
import { ChannelBanner } from './Live.tsx';

export const SNIPPET_SECONDS = [30, 60, 90, 120, 180] as const;
const AUTO_KEY = 'kesit.kesitler.otomatikDikey';

function readAuto() {
  try {
    return localStorage.getItem(AUTO_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * Kesitler: anlık klip düğmesiyle yayının son N saniyesi Kick'in süren yayın
 * kaydından alınır, ham olarak burada listelenir ve istenirse dikey videoya
 * çevrilir (dikey sonuç Galeri'ye düşer, buradan da açılır).
 */
export function Kesitler() {
  const { user } = useSession();
  const { inScope } = useChannelScope();
  const channel = user?.channelSlug ?? '';
  const info = useResource(() => (channel ? api.get<ChannelInfo>(`/api/live/channel${query({ channel })}`) : Promise.resolve(null)), [channel]);
  useInterval(() => channel && void info.reload(), 45_000);
  const list = useResource(() => api.get<{ snippets: Snippet[] }>('/api/snippets').then((r) => r.snippets));
  useSocketEvent<{ snippets: Snippet[] }>('snippet:update', (e) => list.setData(e.snippets));
  const [playing, setPlaying] = useState<Snippet | null>(null);
  const snippets = (list.data ?? []).filter((s) => inScope(s.channel));

  return (
    <>
      <WorkspaceHead
        guide="kesitler"
        title="Kesitler"
        tape="anlık"
        lead="Yayın sürerken bir düğmeye bas: yayının son 30–180 saniyesi buraya iner, istersen kendiliğinden dikey videoya çevrilir. Sohbete hiçbir şey yazılmaz."
      />
      {channel && <ChannelBanner info={info.data} loading={info.loading} channel={channel} />}
      <div className="live-grid">
        <div className="ws-stack">
          <QuickCapturePanel channel={channel} isLive={!!info.data?.isLive} />
        </div>
        <div className="ws-stack">
          <section className="panel">
            <header className="panel-head">
              <div>
                <h2 className="panel-title">
                  <Icon name="film" size={18} /> Alınan kesitler
                </h2>
                <p className="panel-sub">Ham dosyayı indir, izle ya da dikey videoya çevir. Dikey sonuçlar Galeri'de de görünür.</p>
              </div>
              {snippets.length > 0 && <Pill tone="ok">{snippets.length} kesit</Pill>}
            </header>
            {!list.data ? (
              <Spinner />
            ) : snippets.length === 0 ? (
              <Empty icon="bolt" title="Henüz kesit yok">
                Kanal yayındayken soldaki süre düğmelerinden birine bas; kesit yarım dakika içinde burada görünür.
              </Empty>
            ) : (
              <ul className="snippet-list">
                <AnimatePresence initial={false}>
                  {snippets.map((s) => (
                    <motion.li key={s.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                      <SnippetRow snippet={s} onPlay={() => setPlaying(s)} onChange={() => void list.reload()} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </section>
        </div>
      </div>

      <Modal open={!!playing} onClose={() => setPlaying(null)} title={playing?.title || 'Kesit'} wide>
        {playing?.videoUrl && (
          <div className="stage stage-h">
            <video className="stage-video" src={playing.videoUrl} controls autoPlay playsInline />
          </div>
        )}
      </Modal>
    </>
  );
}

/** Süre düğmeleri: yayının son N saniyesini kesit olarak alır. */
export function QuickCapturePanel({ channel, isLive, compact = false }: { channel: string; isLive: boolean; compact?: boolean }) {
  const [sending, setSending] = useState<number | null>(null);
  const [auto, setAuto] = useState(readAuto);
  const setAutoPersist = (v: boolean) => {
    setAuto(v);
    try {
      localStorage.setItem(AUTO_KEY, v ? '1' : '0');
    } catch {
      /* depolama kapalı */
    }
  };
  const send = async (seconds: number) => {
    setSending(seconds);
    try {
      await api.post('/api/snippets/capture', { channel, seconds, autoEdit: auto });
      toast(`Son ${seconds} saniye alınıyor${auto ? ' ve dikey videoya çevrilecek' : ''}`, 'ok', compact ? { label: 'Kesitlere git', run: () => navigate(sectionPath('kesitler')) } : undefined, 5000);
    } catch (err) {
      toastError(err);
    } finally {
      setSending(null);
    }
  };
  return (
    <section className="panel" aria-labelledby="qc-title">
      <header className="panel-head">
        <div>
          <h2 id="qc-title" className="panel-title">
            <Icon name="bolt" size={18} /> Anlık kesit al
          </h2>
          <p className="panel-sub">Düğmeye bastığın andan geriye doğru o kadar saniye Kick'in yayın kaydından alınır. Yayın kaydı canlıdan yarım dakika kadar geride gelir.</p>
        </div>
      </header>
      <div className="quick-grid">
        {SNIPPET_SECONDS.map((sec) => (
          <button key={sec} type="button" className="quick-btn" disabled={!isLive || !channel || sending !== null} onClick={() => void send(sec)}>
            {sending === sec ? <Spinner size={14} /> : <b>{sec}</b>}
            <span>sn</span>
          </button>
        ))}
      </div>
      <div className="pad-top">
        <Switch checked={auto} onChange={setAutoPersist} label="Kesit inince dikey videoya çevir" hint="Kapalıysa yalnız ham kesit alınır; sonradan tek tıkla çevirebilirsin" />
      </div>
      {!channel ? (
        <p className="field-help pad-top">Üstteki sekmelerden bir kanal seç.</p>
      ) : (
        !isLive && <p className="field-help pad-top">Kanal şu an yayında değil; kesit yalnız yayın sürerken alınır.</p>
      )}
      {compact && (
        <p className="field-help pad-top">
          Alınan kesitler{' '}
          <button type="button" className="link" onClick={() => navigate(sectionPath('kesitler'))}>
            Kesitler
          </button>{' '}
          bölümünde.
        </p>
      )}
    </section>
  );
}

function SnippetRow({ snippet: s, onPlay, onChange }: { snippet: Snippet; onPlay: () => void; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const remove = () =>
    deleteWithUndo({
      label: 'Kesit silindi',
      hide: onChange,
      restore: onChange,
      commit: () => api.del(`/api/snippets/${s.id}`),
      done: onChange,
    });
  const edit = async () => {
    setBusy(true);
    try {
      await api.post(`/api/snippets/${s.id}/edit`);
      toast("Dikey videoya çevriliyor — Galeri'de görünecek", 'ok');
      void refreshJobs();
      onChange();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await api.post(`/api/snippets/${s.id}/cancel`);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="snippet-item">
      <button type="button" className="harvest-thumb snippet-thumb" onClick={onPlay} disabled={!s.videoUrl} aria-label="Kesiti izle">
        {s.thumbUrl ? <img src={s.thumbUrl} alt="" loading="lazy" /> : s.status === 'downloading' ? <Spinner size={16} /> : <Icon name="film" />}
        {s.videoUrl && (
          <span className="clip-play" aria-hidden="true">
            <Icon name="play" size={14} />
          </span>
        )}
      </button>
      <div className="harvest-body">
        <b>{s.title}</b>
        <span className="muted">
          {s.status === 'downloading' ? 'Yayın kaydından alınıyor…' : s.status === 'failed' ? `Alınamadı: ${s.error ?? ''}` : `${duration(s.durationSec)} · ${bytes(s.sizeBytes)} · ${relative(s.createdAt)}`}
        </span>
      </div>
      <div className="row-gap">
        {s.status === 'downloading' && (
          <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void cancel()}>
            İptal
          </button>
        )}
        {s.videoUrl && (
          <a className="btn btn-quiet btn-small" href={s.videoUrl} download title="Ham kesiti indir">
            <Icon name="download" size={14} /> Ham
          </a>
        )}
        {s.status === 'ready' &&
          (s.jobId ? (
            <button type="button" className="btn btn-secondary btn-small" onClick={() => navigate(sectionPath('galeri', s.jobId))}>
              <Icon name="vertical" size={14} /> Dikey videoyu gör
            </button>
          ) : (
            <button type="button" className="btn btn-accent btn-small" disabled={busy} onClick={() => void edit()}>
              {busy ? <Spinner size={12} /> : <Icon name="vertical" size={14} />} Dikey videoya çevir
            </button>
          ))}
        {s.status !== 'downloading' && (
          <button type="button" className="btn btn-quiet btn-icon" onClick={remove} aria-label="Sil">
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
