import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { HlsVideo } from '../components/HlsVideo.tsx';
import { Icon } from '../components/Icon.tsx';
import { RangeDialog, type TimeRange } from '../components/RangeDialog.tsx';
import { Empty, Field, Modal, Pill, Segmented, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api, query } from '../lib/api.ts';
import { kickTimeMs } from '../lib/clock.ts';
import { bytes, count, duration, relative, time } from '../lib/format.ts';
import { refreshJobs } from '../lib/jobs.ts';
import { liveStore, refreshLive } from '../lib/live.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { deleteWithUndo, toast, toastError } from '../lib/toast.ts';
import { useSocketEvent } from '../lib/socket.ts';
import type { ChannelInfo, LiveState } from '../lib/types.ts';
import { useInterval, useResource } from '../lib/useResource.ts';
import { QuickCapturePanel } from './Kesitler.tsx';

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
        lead="Şu an süren yayını kaydet, klipleri yakala, anlık kesit al ya da yayının o ana kadarki kısmını kesmek için indir."
        guide="canli"
      />
      {channel && <ChannelBanner info={info.data} loading={info.loading} channel={channel} />}
      {live.autopilot.config.enabled && (
        <p className="notice-box live-note">
          Çevrimdışı bot takip açık: {live.autopilot.config.channel} yayına geçince klipler yakalanır, yayın bitince yayın indirilir.{' '}
          <button type="button" className="link" onClick={() => navigate(sectionPath('nobet'))}>
            Bot takibine git
          </button>
        </p>
      )}
      <div className="live-grid">
        <div className="ws-stack">
          <RecorderPanel live={live} channel={channel} isLive={!!info.data?.isLive} />
          <LiveCapturePanel channel={channel} isLive={!!info.data?.isLive} startedAt={info.data?.startedAt ?? null} />
        </div>
        <div className="ws-stack">
          <WatcherPanel live={live} channel={channel} />
          <QuickCapturePanel channel={channel} isLive={!!info.data?.isLive} compact />
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
      toast(res.finishing ? 'Son parçalar iniyor, kayıt birazdan hazır' : 'Kayıt durdu — Galeri\'de', 'ok');
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
      toast('Yayının şu ana kadarki kısmı indiriliyor — Yayın geçmişleri\'nde kesebilirsin', 'ok');
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
          <p className="panel-sub">Yayının tamamını dosyaya alır. Durdurunca Galeri'de düzenlemeye hazır olur.</p>
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

/**
 * Süren yayından indirme: şu ana kadarki kısmı ya da yazılan bir aralığı
 * (başlangıç–bitiş dakikası) Kick'in süren yayın kaydından alır; Yayın
 * geçmişleri'ne düşer. Bitiş ileride olabilir: yayın o ana gelince dosya kapanır.
 */
function LiveCapturePanel({ channel, isLive, startedAt }: { channel: string; isLive: boolean; startedAt: string | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startMs = kickTimeMs(startedAt);
  useEffect(() => {
    const tick = () => setElapsed(startMs ? Math.max(0, Math.floor((Date.now() - startMs) / 1000)) : 0);
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startMs]);

  const toTasks = { label: 'Görevlere git', run: () => navigate(sectionPath('gorevler')) };

  const captureSoFar = async () => {
    setBusy(true);
    try {
      await api.post('/api/vods/capture-live', { channel });
      toast("Yayının şu ana kadarki kısmı indiriliyor — Yayın geçmişleri'nde kesebilirsin", 'ok', toTasks, 5000);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const captureRange = async (ranges: TimeRange[]) => {
    for (const range of ranges) await api.post('/api/vods/capture-live', { channel, startSec: range.startSec, endSec: range.endSec });
    const future = ranges.some((r) => r.endSec > elapsed);
    const label = ranges.length > 1 ? `${ranges.length} aralık indiriliyor` : future ? `Aralık kaydediliyor — yayın ${duration(ranges[0].endSec)} noktasına gelince dosya kapanır` : 'Aralık indiriliyor — Yayın geçmişleri\'nde görünecek';
    toast(label, 'ok', toTasks, 6000);
  };

  return (
    <section className="panel" aria-labelledby="capture-title">
      <header className="panel-head">
        <div>
          <h2 id="capture-title" className="panel-title">
            <Icon name="download" size={18} /> Yayından indir
          </h2>
          <p className="panel-sub">
            {isLive ? `Yayın ${duration(elapsed)} noktasında. Şu ana kadarını ya da yazdığın bir aralığı indir; Yayın geçmişleri'ne düşer.` : 'Kanal yayına girince süren yayının bir bölümünü indirebilirsin.'}
          </p>
        </div>
      </header>
      <div className="row-gap">
        <button type="button" className="btn btn-secondary" onClick={() => void captureSoFar()} disabled={busy || !isLive || !channel}>
          {busy ? <Spinner /> : <Icon name="scissors" size={14} />} Şu ana kadarını indir
        </button>
        <button type="button" className="btn btn-accent" onClick={() => setOpen(true)} disabled={!isLive || !channel}>
          <Icon name="clock" size={14} /> Belirli aralığı indir
        </button>
      </div>
      <p className="field-help pad-top">Yayın kaydı kapalı kanallarda bu seçenek çalışmaz; o durumda "Canlı kayıt" kullan.</p>
      <RangeDialog open={open} onClose={() => setOpen(false)} title="Yayından aralık indir" durationSec={elapsed} live onSubmit={captureRange} />
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
      {managedByAutopilot && <p className="field-help">Bot takibi açıkken klip yakalamayı o yönetir.</p>}

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
                <button type="button" className="link" onClick={() => navigate(sectionPath('galeri', f.jobId))}>
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
      toast('Dikey videoya çevriliyor — Galeri\'de görünecek', 'ok');
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
                    <button type="button" className="btn btn-quiet btn-small" onClick={() => navigate(sectionPath('galeri', c.jobId))}>
                      Galeri'de
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
