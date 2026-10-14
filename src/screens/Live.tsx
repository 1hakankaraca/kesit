import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { platformLabel } from '../components/PublishDialog.tsx';
import { Empty, Field, Pill, Segmented, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api, query } from '../lib/api.ts';
import { bytes, count, duration, relative, time } from '../lib/format.ts';
import { refreshJobs } from '../lib/jobs.ts';
import { liveStore, refreshLive } from '../lib/live.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { AutopilotConfig, ChannelInfo, LiveState, ZernioSummary } from '../lib/types.ts';
import { useInterval, useResource } from '../lib/useResource.ts';

/** Canlı: nöbet, kayıt ve chat'ten klip yakalama. */
export function Live() {
  const { user } = useSession();
  const live = liveStore.use();
  const channel = live?.autopilot.config.channel || live?.watcher.channel || live?.recorder.channel || user?.channelSlug || '';
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
      <WorkspaceHead title="Canlı" tape="nöbet" lead="Yayın açılınca kaydı başlat, chat'e düşen klipleri yakala ve işle. Nöbetçiyi açarsan bunların hepsi sen yokken de olur." />
      {channel && <ChannelBanner info={info.data} loading={info.loading} channel={channel} />}
      <div className="live-grid">
        <AutopilotPanel live={live} fallbackChannel={channel} />
        <div className="ws-stack">
          <RecorderPanel live={live} channel={channel} isLive={!!info.data?.isLive} />
          <WatcherPanel live={live} channel={channel} />
        </div>
      </div>
    </>
  );
}

function ChannelBanner({ info, loading, channel }: { info: ChannelInfo | null; loading: boolean; channel: string }) {
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

/* ── Nöbetçi ───────────────────────────────────────────────────────────── */

function AutopilotPanel({ live, fallbackChannel }: { live: LiveState; fallbackChannel: string }) {
  const status = live.autopilot;
  const [draft, setDraft] = useState<AutopilotConfig>(() => ({ ...status.config, channel: status.config.channel || fallbackChannel || null }));
  const [busy, setBusy] = useState(false);
  const [zernio, setZernio] = useState<ZernioSummary | null>(null);

  useEffect(() => {
    if (draft.autoPublish && !zernio) api.get<ZernioSummary>('/api/zernio').then(setZernio).catch(() => {});
  }, [draft.autoPublish, zernio]);

  const save = async (next: AutopilotConfig) => {
    setBusy(true);
    try {
      const res = await api.put<LiveState['autopilot']>('/api/autopilot', next);
      liveStore.set((s) => (s ? { ...s, autopilot: res } : s));
      setDraft(res.config);
      toast(res.config.enabled ? 'Nöbetçi açık' : 'Nöbetçi kapatıldı', 'ok');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const patch = (p: Partial<AutopilotConfig>) => {
    const next = { ...draft, ...p };
    setDraft(next);
    if (status.config.enabled) void save(next);
  };

  const accounts = (zernio?.accounts ?? []).filter((a) => a.platform !== 'tiktok');
  const toggleAccount = (platform: string, accountId: string) => {
    const has = draft.publishAccounts.some((a) => a.accountId === accountId && a.platform === platform);
    patch({ publishAccounts: has ? draft.publishAccounts.filter((a) => !(a.accountId === accountId && a.platform === platform)) : [...draft.publishAccounts, { platform, accountId }] });
  };

  const on = status.config.enabled;

  return (
    <section className={on ? 'panel autopilot autopilot-on' : 'panel autopilot'} aria-labelledby="ap-title">
      <span className="panel-tape" aria-hidden="true" />
      <header className="panel-head">
        <div>
          <h2 id="ap-title" className="panel-title">
            <Icon name="shield" size={18} /> Nöbetçi
          </h2>
          <p className="panel-sub">Bilgisayar başında değilken kanalı yoklar; yayın açılınca devreye girer, kapanınca toparlar.</p>
        </div>
        {on && <Pill tone={status.live ? 'live' : 'on'}>{status.live ? 'Yayın sürüyor' : 'Bekliyor'}</Pill>}
      </header>

      <div className="stack">
        <Field label="Takip edilen kanal" htmlFor="ap-channel">
          <input
            id="ap-channel"
            className="input"
            value={draft.channel ?? ''}
            onChange={(e) => setDraft({ ...draft, channel: e.target.value.trim() || null })}
            placeholder="kanal adı"
            disabled={on}
          />
        </Field>
        <Switch checked={draft.record} onChange={(v) => patch({ record: v })} label="Yayını baştan sona kaydet" hint="Yayın bitince kayıt kapanır; intro, outro ve logo eklenmiş çıktı otomatik hazırlanır" />
        <Switch checked={draft.clips} onChange={(v) => patch({ clips: v })} label="Chat kliplerini yakala" hint="Sohbete düşen kick.com ve kickbot.com klip bağlantıları" />
        {draft.clips && <Switch checked={draft.autoEdit} onChange={(v) => patch({ autoEdit: v })} label="Yakalananları otomatik düzenle" hint="Dikey klip + altyazı, Kütüphane'ye düşer" />}
        {draft.clips && draft.autoEdit && <Switch checked={draft.subtitles} onChange={(v) => patch({ subtitles: v })} label="Altyazı" />}
        {draft.clips && draft.autoEdit && (
          <Switch checked={draft.autoPublish} onChange={(v) => patch({ autoPublish: v })} label="Otomatik paylaş" hint="Hazır klipler saatte bir Zernio ile paylaşılır" />
        )}
        {draft.autoPublish && (
          <div className="subtle-box">
            {!zernio ? (
              <Spinner />
            ) : !zernio.connected ? (
              <button type="button" className="link" onClick={() => navigate(sectionPath('paylasim'))}>
                Önce Zernio hesabını bağla
              </button>
            ) : (
              <div className="account-grid">
                {accounts.map((a) => {
                  const checked = draft.publishAccounts.some((x) => x.accountId === a.id && x.platform === a.platform);
                  return (
                    <label key={a.id} className={checked ? 'account account-on' : 'account'}>
                      <input type="checkbox" checked={checked} onChange={() => toggleAccount(a.platform, a.id)} />
                      <span className={`platform-badge platform-${a.platform}`}>{platformLabel(a.platform).slice(0, 2)}</span>
                      <span>
                        <b>{a.displayName}</b>
                        <small>{platformLabel(a.platform)}</small>
                      </span>
                    </label>
                  );
                })}
                <p className="field-help">TikTok her gönderide açık onay istediği için otomatik paylaşılamaz.</p>
              </div>
            )}
          </div>
        )}

        <button type="button" className={on ? 'btn btn-secondary btn-large' : 'btn btn-accent btn-large'} disabled={busy || (!on && !draft.channel)} onClick={() => save({ ...draft, enabled: !on })}>
          {busy ? <Spinner /> : <Icon name={on ? 'stop' : 'shield'} size={16} />}
          {on ? 'Nöbeti kapat' : 'Nöbeti başlat'}
        </button>
        {on && status.nextCheckAt && <p className="field-help">Son yoklama {time(status.lastCheckAt)} · sonraki {time(status.nextCheckAt)}</p>}
      </div>

      {status.events.length > 0 && (
        <ol className="event-log" aria-label="Nöbet günlüğü">
          {status.events.map((e, i) => (
            <li key={`${e.at}-${i}`} className={`event event-${e.kind}`}>
              <span className="event-time">{time(e.at)}</span>
              <span>{e.text}</span>
            </li>
          ))}
        </ol>
      )}
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
