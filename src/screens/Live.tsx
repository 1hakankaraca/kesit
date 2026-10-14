import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { HlsVideo } from '../components/HlsVideo.tsx';
import { Icon } from '../components/Icon.tsx';
import { Empty, Field, Modal, Pill, Segmented, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api, query } from '../lib/api.ts';
import { bytes, count, duration, relative, time } from '../lib/format.ts';
import { refreshJobs } from '../lib/jobs.ts';
import { liveStore, refreshLive } from '../lib/live.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { deleteWithUndo, toast, toastError } from '../lib/toast.ts';
import { useSocketEvent } from '../lib/socket.ts';
import type { ChannelInfo, LiveState } from '../lib/types.ts';
import { useInterval, useResource } from '../lib/useResource.ts';

/** Canlı: nöbet, kayıt ve chat'ten klip yakalama. */
export function Live() {
  const { user } = useSession();
  const live = liveStore.use();
  const channel = live?.watcher.channel || live?.recorder.channel || user?.channelSlug || '';
  const info = useResource(() => (channel ? api.get<ChannelInfo>(`/api/live/channel${query({ channel })}`) : Promise.resolve(null)), [channel]);
  useInterval(() => channel && void info.reload(), 45_000);

  useEffect(() => {
    void refreshLive();
  }, []);

  if (!live) {
    return (
      <div className="center-pad">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <>
      <WorkspaceHead
        title="Canlı"
        tape="yayın"
        lead="Şu an süren yayını kaydet, klipleri yakala, sohbete klip komutu at ya da yayının o ana kadarki kısmını kesmek için indir."
        guide="canli"
      />
      {channel && <ChannelBanner info={info.data} loading={info.loading} channel={channel} />}
      {live.autopilot.config.enabled && (
        <p className="notice-box live-note">
          Otomatik takip açık: {live.autopilot.config.channel} yayına geçince klipler yakalanır, yayın bitince yayın indirilir.{' '}
          <button type="button" className="link" onClick={() => navigate(sectionPath('nobet'))}>
            Otomatik takibe git
          </button>
        </p>
      )}
      <div className="live-grid">
        <RecorderPanel live={live} channel={channel} isLive={!!info.data?.isLive} />
        <div className="ws-stack">
          <WatcherPanel live={live} channel={channel} />
          <QuickClipPanel channel={channel} isLive={!!info.data?.isLive} chatAccess={live.chatAccess} />
        </div>
      </div>
    </>
  );
}

export function ChannelBanner({ info, loading, channel }: { info: ChannelInfo | null; loading: boolean; channel: string }) {
  return (
    <section className={info?.isLive ? 'channel-banner channel-banner-live' : 'channel-banner'}>
      {info?.avatarUrl ? <img className="channel-avatar" src={info.avatarUrl} alt="" /> : <span className="channel-avatar" />}
      <div className="channel-banner-body">
        <p className="eyebrow">{info?.username ?? channel}</p>
        <h2 className="channel-banner-title">{loading && !info ? 'Kanal yoklanıyor…' : info?.isLive ? info.title || 'Canlı yayında' : 'Şu an yayında değil'}</h2>
        {info?.isLive && (
          <p className="muted">
            {info.category ? `${info.category} · ` : ''}
            {count(info.viewers)} izleyici
            {info.startedAt ? ` · ${relative(info.startedAt)} başladı` : ''}
          </p>
        )}
      </div>
      <Pill tone={info?.isLive ? 'live' : 'neutral'}>{info?.isLive ? 'CANLI' : 'Çevrimdışı'}</Pill>
    </section>
  );
}

/* ── Kayıt ─────────────────────────────────────────────────────────────── */

function RecorderPanel({ live, channel, isLive }: { live: LiveState; channel: string; isLive: boolean }) {
  const rec = live.recorder;
  const [backfill, setBackfill] = useState(0);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(rec.elapsedSec ?? 0);

  useEffect(() => setElapsed(rec.elapsedSec ?? 0), [rec.elapsedSec]);
  useInterval(() => rec.recording && setElapsed((s) => s + 1), rec.recording ? 1000 : null);
  useInterval(() => rec.recording && void refreshLive(), rec.recording ? 10_000 : null);

  const start = async () => {
    setBusy(true);
    try {
      await api.post('/api/live/record/start', { channel, backfillMinutes: backfill, follow: true });
      toast('Kayıt başladı', 'ok');
      await refreshLive();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ finishing?: boolean }>('/api/live/record/stop');
      toast(res.finishing ? 'Son parçalar iniyor, kayıt birazdan hazır' : 'Kayıt durdu — Yayın kayıtları\'nda', 'ok');
      await refreshLive();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const captureSoFar = async () => {
    try {
      await api.post('/api/vods/capture-live', { channel });
      toast('Yayının şu ana kadarki kısmı indiriliyor — Geçmiş yayınlar\'da düzenleyebilirsin', 'ok');
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <section className="panel" aria-labelledby="rec-title">
      <header className="panel-head">
        <div>
          <h2 id="rec-title" className="panel-title">
            <Icon name="record" size={18} /> Canlı kayıt
          </h2>
          <p className="panel-sub">Yayının tamamını dosyaya alır. Durdurunca Yayın kayıtları'nda düzenlemeye hazır olur.</p>
        </div>
        {rec.recording && <Pill tone="live">{rec.finishing ? 'Bitiriliyor' : 'Kayıtta'}</Pill>}
      </header>

      <AnimatePresence initial={false}>
        {rec.recording && rec.previewUrl && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <LivePreview url={rec.previewUrl} />
          </motion.div>
        )}
      </AnimatePresence>

      {rec.recording ? (
        <div className="stack">
          <dl className="facts facts-row">
            <div>
              <dt>Süre</dt>
              <dd className="tabular">{duration(elapsed)}</dd>
            </div>
            <div>
              <dt>Boyut</dt>
              <dd>{bytes(rec.sizeBytes)}</dd>
            </div>
            <div>
              <dt>Kalite</dt>
              <dd>{rec.quality ?? '—'}</dd>
            </div>
            <div>
              <dt>Kanal</dt>
              <dd>{rec.channel}</dd>
            </div>
          </dl>
          <div className="row-gap">
            <button type="button" className="btn btn-danger" onClick={stop} disabled={busy || rec.finishing}>
              {busy ? <Spinner /> : <Icon name="stop" size={14} />} Kaydı durdur
            </button>
            <button type="button" className="btn btn-secondary" onClick={captureSoFar}>
              <Icon name="scissors" size={14} /> Şu ana kadarını kesmek için al
            </button>
          </div>
        </div>
      ) : !channel ? (
        <Empty icon="record" title="Önce bir kanal seç" />
      ) : (
        <div className="stack">
          <Field label="Başlangıç" help={isLive ? 'Geçmişten başlarsan yayının o kadar öncesi de kayda girer.' : 'Kanal şu an yayında değil; yayın açılınca başlatabilir ya da Otomatik takip\'i açabilirsin.'}>
            <Segmented
              label="Geçmişten başla"
              value={backfill}
              onChange={setBackfill}
              options={[
                { value: 0, label: 'Şimdiden' },
                { value: 15, label: '15 dk önce' },
                { value: 60, label: '1 saat önce' },
                { value: 240, label: 'En baştan' },
              ]}
            />
          </Field>
          <button type="button" className="btn btn-accent" onClick={start} disabled={busy || !isLive}>
            {busy ? <Spinner /> : <Icon name="record" size={16} />} Kaydı başlat
          </button>
        </div>
      )}
    </section>
  );
}

/** Süren kaydın düşük gecikmeli önizlemesi (sunucu HLS vekili üzerinden). */
function LivePreview({ url }: { url: string }) {
  return (
    <div className="stage stage-h stage-live">
      <HlsVideo live className="stage-video" src={url} muted autoPlay playsInline controls />
    </div>
  );
}

/* ── Chat klip yakalama ────────────────────────────────────────────────── */

function WatcherPanel({ live, channel }: { live: LiveState; channel: string }) {
  const w = live.watcher;
  const [autoEdit, setAutoEdit] = useState(true);
  const [busy, setBusy] = useState(false);
  const managedByAutopilot = live.autopilot.config.enabled && live.autopilot.config.clips;

  const toggle = async () => {
    setBusy(true);
    try {
      if (w.watching) await api.post('/api/live/unwatch');
      else await api.post('/api/live/watch', { channel, autoEdit, subtitles: true });
      await refreshLive();
      await refreshJobs();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="watch-title">
      <header className="panel-head">
        <div>
          <h2 id="watch-title" className="panel-title">
            <Icon name="live" size={18} /> Chat klipleri
          </h2>
          <p className="panel-sub">{w.watching ? `${w.channel} dinleniyor: sohbet${w.chatConnected ? '' : ' (bağlanıyor)'} ve Kick'e eklenen yeni klipler` : "Sohbete atılan klipleri ve kanala Kick'te eklenen yeni klipleri yakalar."}</p>
        </div>
        {w.watching && <Pill tone="ok">{w.detectedCount} klip</Pill>}
      </header>

      {!managedByAutopilot && (
        <div className="row-gap">
          {!w.watching && <Switch checked={autoEdit} onChange={setAutoEdit} label="Otomatik düzenle" />}
          <button type="button" className={w.watching ? 'btn btn-secondary' : 'btn btn-primary'} onClick={toggle} disabled={busy || (!w.watching && !channel)}>
            {busy ? <Spinner /> : null}
            {w.watching ? 'Dinlemeyi bırak' : 'Dinlemeye başla'}
          </button>
        </div>
      )}
      {managedByAutopilot && <p className="field-help">Otomatik takip açıkken klip yakalamayı o yönetir.</p>}

      <HarvestList />

      {w.feed.length > 0 ? (
        <ul className="feed">
          {w.feed.map((f) => (
            <li key={f.clipId} className="feed-item">
              <span className="feed-time">{time(new Date(f.ts))}</span>
              <span className="feed-body">
                <b>{f.sender}</b> klip paylaştı
                {f.error && <span className="field-error"> — {f.error}</span>}
              </span>
              {f.jobId ? (
                <button type="button" className="link" onClick={() => navigate(sectionPath('kutuphane', f.jobId))}>
                  Klibi aç
                </button>
              ) : (
                <a className="link" href={f.url} target="_blank" rel="noreferrer">
                  Kick'te aç
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        w.watching && <p className="muted pad-top">Henüz klip düşmedi. Yayında biri klip aldığında burada görünecek.</p>
      )}
    </section>
  );
}

const QUICK_SECONDS = [30, 60, 90, 120, 180] as const;

/** Anlık klip: sohbete "!clip <sn>" yazar; kanalda klip botu varsa klip alınır ve yukarıda yakalanır. */
function QuickClipPanel({ channel, isLive, chatAccess }: { channel: string; isLive: boolean; chatAccess: boolean }) {
  const [sending, setSending] = useState<number | null>(null);
  const send = async (seconds: number) => {
    setSending(seconds);
    try {
      await api.post('/api/live/quick-clip', { channel, seconds });
      toast(`Sohbete "!clip ${seconds}" yazıldı — klip gelince yukarıda yakalanır`, 'ok');
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
            <Icon name="bolt" size={18} /> Anlık klip
          </h2>
          <p className="panel-sub">Yayın sırasında sohbete klip komutu gönderir. Yayıncının kanalında klip botu (ör. KickBot) destekliyorsa çalışır.</p>
        </div>
      </header>
      <div className="quick-grid">
        {QUICK_SECONDS.map((sec) => (
          <button key={sec} type="button" className="quick-btn" disabled={!chatAccess || !channel || sending !== null} onClick={() => void send(sec)}>
            {sending === sec ? <Spinner size={14} /> : <b>{sec}</b>}
            <span>sn</span>
          </button>
        ))}
      </div>
      {!chatAccess ? (
        <p className="field-help pad-top">
          Sohbete yazabilmek için kendi Kick uygulamanı bağlaman gerekiyor.{' '}
          <button type="button" className="link" onClick={() => navigate(sectionPath('ayarlar'))}>
            Ayarlar'da kur
          </button>
        </p>
      ) : (
        !isLive && <p className="field-help pad-top">Kanal şu an yayında değil; klip botları yalnız yayında klip alır.</p>
      )}
    </section>
  );
}

interface HarvestClip {
  id: number;
  clipId: string;
  channel: string;
  title: string | null;
  durationSec: number | null;
  thumbnailUrl: string | null;
  status: 'downloading' | 'ready' | 'failed';
  error: string | null;
  sizeBytes: number | null;
  jobId: number | null;
  videoUrl: string | null;
  createdAt: string;
}

interface HarvestState {
  config: { enabled: boolean; channel: string | null; autoEdit: boolean };
  clips: HarvestClip[];
  pollSeconds: number;
}

/**
 * Dinleme sırasında kanala Kick'te eklenen yeni klipler (arka planda indirilir).
 * Dinleme başlayınca takip kendiliğinden açılır, bitince kapanır.
 */
function HarvestList() {
  const state = useResource(() => api.get<HarvestState>('/api/harvest'));
  const [playing, setPlaying] = useState<HarvestClip | null>(null);
  useSocketEvent<{ clips: HarvestClip[] }>('harvest:update', (e) => state.setData((d) => d && { ...d, clips: e.clips }));

  const remove = (clip: HarvestClip) =>
    deleteWithUndo({
      label: 'Klip silindi',
      hide: () => state.setData((d) => d && { ...d, clips: d.clips.filter((c) => c.id !== clip.id) }),
      restore: () => void state.reload(),
      commit: () => api.del(`/api/harvest/${clip.id}`),
    });

  const edit = async (clip: HarvestClip) => {
    try {
      await api.post(`/api/harvest/${clip.id}/edit`);
      toast('Dikey videoya çevriliyor — Videolarım\'da görünecek', 'ok');
      void refreshJobs();
      void state.reload();
    } catch (err) {
      toastError(err);
    }
  };

  if (!state.data?.clips.length) return null;
  return (
    <div className="harvest-wrap">
      <h3 className="eyebrow pad-top">Kick'e eklenen yeni klipler</h3>
      {state.data && state.data.clips.length > 0 ? (
        <ul className="harvest-list">
          {state.data.clips.map((c) => (
            <li key={c.id} className="harvest-item">
              <button type="button" className="harvest-thumb" onClick={() => c.videoUrl && setPlaying(c)} disabled={!c.videoUrl} aria-label="Klibi izle">
                {c.thumbnailUrl ? <img src={c.thumbnailUrl} alt="" loading="lazy" /> : <Icon name="film" />}
                {c.videoUrl && (
                  <span className="clip-play" aria-hidden="true">
                    <Icon name="play" size={14} />
                  </span>
                )}
              </button>
              <div className="harvest-body">
                <b>{c.title || 'Başlıksız klip'}</b>
                <span className="muted">
                  {c.status === 'downloading' ? 'İndiriliyor…' : c.status === 'failed' ? `İndirilemedi: ${c.error ?? ''}` : `${duration(c.durationSec)} · ${bytes(c.sizeBytes)} · ${relative(c.createdAt)}`}
                </span>
              </div>
              <div className="row-gap">
                {c.videoUrl && (
                  <a className="btn btn-quiet btn-small" href={c.videoUrl} download>
                    <Icon name="download" size={14} />
                  </a>
                )}
                {c.status === 'ready' &&
                  (c.jobId ? (
                    <button type="button" className="btn btn-quiet btn-small" onClick={() => navigate(sectionPath('kutuphane', c.jobId))}>
                      Videolarım'da
                    </button>
                  ) : (
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => void edit(c)}>
                      Dikey videoya çevir
                    </button>
                  ))}
                <button type="button" className="btn btn-quiet btn-icon" onClick={() => remove(c)} aria-label="Sil">
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <Modal open={!!playing} onClose={() => setPlaying(null)} title={playing?.title || 'Klip'} wide>
        {playing?.videoUrl && (
          <div className="stage stage-h">
            <video className="stage-video" src={playing.videoUrl} controls autoPlay playsInline />
          </div>
        )}
      </Modal>
    </div>
  );
}
