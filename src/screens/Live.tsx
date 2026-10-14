import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { Empty, Field, Pill, Segmented, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api, query } from '../lib/api.ts';
import { bytes, count, duration, relative, time } from '../lib/format.ts';
import { refreshJobs } from '../lib/jobs.ts';
import { liveStore, refreshLive } from '../lib/live.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { toast, toastError } from '../lib/toast.ts';
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
        lead="Şu an süren yayını kaydet, chat'e düşen klipleri yakala, yayının o ana kadarki kısmını kesmek için al."
        guide="canli"
      />
      {channel && <ChannelBanner info={info.data} loading={info.loading} channel={channel} />}
      {live.autopilot.config.enabled && (
        <p className="notice-box live-note">
          Nöbet açık: {live.autopilot.config.channel} yayına geçince kayıt ve klip yakalama kendiliğinden başlar.{' '}
          <button type="button" className="link" onClick={() => navigate(sectionPath('nobet'))}>
            Nöbet'e git
          </button>
        </p>
      )}
      <div className="live-grid">
        <RecorderPanel live={live} channel={channel} isLive={!!info.data?.isLive} />
        <WatcherPanel live={live} channel={channel} />
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
      toast(res.finishing ? 'Son parçalar iniyor, kayıt birazdan hazır' : 'Kayıt durdu, çıktı hazırlanıyor', 'ok');
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
      toast('Yayının şu ana kadarki bölümü indiriliyor — Geçmiş yayınlar\'da kesebilirsin', 'ok');
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
          <p className="panel-sub">Yayının tamamını dosyaya alır. Bitince Kayıtlar'da işlenmeye hazır olur.</p>
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
          <Field label="Başlangıç" help={isLive ? 'Geçmişten başlarsan yayının o kadar öncesi de kayda girer.' : 'Kanal şu an yayında değil; yayın açılınca başlatabilir ya da Nöbetçi\'ye bırakabilirsin.'}>
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
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      return;
    }
    // hls.js büyük; yalnız önizleme açıldığında yüklenir.
    let hls: { destroy(): void } | null = null;
    let cancelled = false;
    void import('hls.js').then(({ default: Hls }) => {
      if (cancelled || !Hls.isSupported()) return;
      const player = new Hls({ liveSyncDurationCount: 3 });
      player.loadSource(url);
      player.attachMedia(video);
      hls = player;
    });
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [url]);
  return (
    <div className="stage stage-h stage-live">
      <video ref={ref} className="stage-video" muted autoPlay playsInline controls />
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
          <p className="panel-sub">{w.watching ? `${w.channel} sohbeti dinleniyor${w.chatConnected ? '' : ' (bağlanıyor)'}` : 'Sohbete düşen klip bağlantılarını anında yakalar.'}</p>
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
      {managedByAutopilot && <p className="field-help">Nöbetçi açıkken klip yakalamayı nöbet yönetir.</p>}

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
