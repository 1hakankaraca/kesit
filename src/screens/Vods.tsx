import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { RangeDialog, type TimeRange } from '../components/RangeDialog.tsx';
import { Timeline, CutList, newCut, type Cut } from '../components/Timeline.tsx';
import { Empty, Segmented, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api, query } from '../lib/api.ts';
import { clockText, kickTimeMs } from '../lib/clock.ts';
import { bytes, count, dateTime, duration, relative } from '../lib/format.ts';
import { jobsStore, refreshJobs } from '../lib/jobs.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { useSocketEvent } from '../lib/socket.ts';
import { deleteWithUndo, toast, toastError } from '../lib/toast.ts';
import { useResource } from '../lib/useResource.ts';
import { useChannelScope } from '../lib/channelScope.ts';
import { tasksStore } from '../lib/tasks.ts';
import { takeSnapshot } from '../lib/snapshot.ts';
import { speedLabel } from '../lib/words.ts';
import { ChannelScopeToggle } from '../components/ChannelScopeToggle.tsx';
import type { Frame, Highlight, Job, VodJob, VodVideo } from '../lib/types.ts';
import { JobStatusLine, jobTitle } from './Gallery.tsx';
import { openInEditor } from '../lib/editorOpen.ts';

const QUALITIES = ['1080p', '720p', '480p'] as const;

/** Yayın geçmişleri: listeden indir, zaman çizelgesinde kes ya da editörde aç. */
export function Vods({ openId }: { openId: number | null }) {
  return openId ? <VodEditor id={openId} /> : <VodList />;
}

function VodList() {
  const { user } = useSession();
  const { inScope, showAll } = useChannelScope();
  const [channel, setChannel] = useState(user?.channelSlug ?? '');
  const [quality, setQuality] = useState<(typeof QUALITIES)[number]>('720p');
  useEffect(() => {
    if (user?.channelSlug) setChannel(user.channelSlug);
  }, [user?.channelSlug]);
  const videos = useResource(() => (channel ? api.get<{ videos: VodVideo[] }>(`/api/vods${query({ channel })}`).then((r) => r.videos) : Promise.resolve([])), [channel]);
  const jobs = useResource(() => api.get<{ jobs: VodJob[] }>('/api/vod-jobs').then((r) => r.jobs));
  const { live } = tasksStore.use();
  const [busy, setBusy] = useState<string | null>(null);
  const [rangeFor, setRangeFor] = useState<VodVideo | null>(null);

  useSocketEvent<{ vodJobId: number; status: string }>('vodscan:update', (e) => {
    if (e.status !== 'processing') void jobs.reload();
  });

  const all = jobs.data ?? [];
  const ready = all.filter((j) => j.status === 'downloaded' && inScope(j.channel_slug));
  const downloading = all.filter((j) => ['queued', 'processing', 'paused'].includes(j.status) && inScope(j.channel_slug));
  // Yayının tamamını indiren iş; aralık işleri "Düzenlemeye hazır"da ayrı ayrı görünür.
  const jobFor = (v: VodVideo) => all.find((j) => String(j.source_video_id) === String(v.id) && j.range_start_sec == null && j.status !== 'cancelled' && j.status !== 'failed' && j.status !== 'expired');
  const rangeLabel = (j: VodJob) => (j.range_start_sec != null && j.range_end_sec != null ? `${clockText(j.range_start_sec)}–${clockText(j.range_end_sec)}` : null);

  const request = (v: VodVideo, range?: TimeRange) =>
    api.post(v.isLive ? '/api/vods/capture-live' : '/api/vods/download', { channel, videoId: v.id, quality, ...(range ? { startSec: range.startSec, endSec: range.endSec } : {}) });

  const download = async (v: VodVideo) => {
    setBusy(String(v.id));
    try {
      await request(v);
      toast('İndirme başladı — Görev yöneticisi\'nden izleyebilirsin', 'ok', { label: 'Görevlere git', run: () => navigate(sectionPath('gorevler')) }, 5000);
      await jobs.reload();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  const downloadRange = async (ranges: TimeRange[]) => {
    if (!rangeFor) return;
    for (const range of ranges) await request(rangeFor, range);
    const label = ranges.length === 1 ? `${clockText(ranges[0].startSec)}–${clockText(ranges[0].endSec)} aralığı indiriliyor` : `${ranges.length} aralık indiriliyor`;
    toast(label, 'ok', { label: 'Görevlere git', run: () => navigate(sectionPath('gorevler')) }, 5000);
    await jobs.reload();
  };

  const remove = (job: VodJob) =>
    deleteWithUndo({
      label: 'İndirilen yayın silindi',
      hide: () => jobs.setData((list) => list?.filter((j) => j.id !== job.id) ?? list),
      restore: () => void jobs.reload(),
      commit: () => api.del(`/api/vod-jobs/${job.id}`),
    });

  return (
    <>
      <WorkspaceHead guide="yayinlar" title="Yayın" tape="geçmişleri" lead="Kick'in sakladığı yayınları bilgisayarına indir; sonra hızlıca kes ya da editörde aç." actions={<ChannelScopeToggle />} />

      {downloading.length > 0 && (
        <button type="button" className="notice-box notice-link live-note" onClick={() => navigate(sectionPath('gorevler'))}>
          <Spinner size={14} /> {downloading.length} yayın iniyor — ilerlemesini Görev yöneticisi'nde görebilirsin
          <Icon name="chevron" size={14} />
        </button>
      )}

      <section className="ws-stack" aria-labelledby="ready-title">
        <h2 id="ready-title" className="section-title">
          Düzenlemeye hazır {showAll ? '' : channel ? `· ${channel}` : ''}
        </h2>
        {!ready.length ? (
          <p className="muted">Henüz indirilmiş yayın yok. Aşağıdan bir yayın seçip indir; inince burada görünür.</p>
        ) : (
          <ul className="vod-grid">
            {ready.map((j) => (
              <li key={j.id} className="vod-card">
                <button type="button" className="clip-thumb clip-thumb-play" onClick={() => navigate(sectionPath('yayinlar', j.id))} aria-label={`${j.title || 'Yayın'} — düzenle`}>
                  {j.thumbnail_url ? <img src={j.thumbnail_url} alt="" loading="lazy" /> : <Icon name="film" size={26} />}
                  <span className="clip-play" aria-hidden="true">
                    <Icon name="scissors" size={18} />
                  </span>
                  <span className="clip-badge clip-badge-dur">{duration(j.duration_sec)}</span>
                </button>
                <div className="vod-card-body">
                  <h3 className="clip-card-title">{j.title || `Yayın #${j.source_video_id}`}</h3>
                  <p className="clip-card-meta">
                    {j.channel_slug}
                    {rangeLabel(j) ? ` · aralık ${rangeLabel(j)}` : ''}
                    {j.vod_file_size_bytes ? ` · ${bytes(j.vod_file_size_bytes)}` : ''}
                    {j.vod_expires_at ? ` · ${relative(j.vod_expires_at)} silinecek` : ''}
                  </p>
                  <div className="row-gap">
                    <button type="button" className="btn btn-accent btn-small" onClick={() => navigate(sectionPath('yayinlar', j.id))}>
                      <Icon name="scissors" size={14} /> Kes
                    </button>
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => void openInEditor({ type: 'vod', id: j.id }, { title: j.title || undefined })}>
                      Editörde aç
                    </button>
                    <button type="button" className="btn btn-quiet btn-icon" onClick={() => remove(j)} aria-label="Sil">
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ws-stack pad-top-section" aria-labelledby="vod-list-title">
        <div className="toolbar panel">
          <form
            className="toolbar-search"
            onSubmit={(e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget).get('channel');
              setChannel(String(v || '').trim());
            }}
          >
            <div className="search search-large">
              <Icon name="search" size={18} />
              <input key={channel} name="channel" className="search-input" defaultValue={channel} placeholder="Kanal adı" aria-label="Kanal" />
            </div>
            <button type="submit" className="btn btn-primary">
              Yayınları getir
            </button>
          </form>
          <div className="toolbar-filters">
            <span className="eyebrow">İndirme kalitesi</span>
            <Segmented size="small" label="Kalite" value={quality} onChange={setQuality} options={QUALITIES.map((q) => ({ value: q, label: q }))} />
          </div>
        </div>

        <h2 id="vod-list-title" className="section-title">
          {channel ? `${channel} — Kick'teki yayınlar` : "Kick'teki yayınlar"}
        </h2>
        {!channel ? (
          <div className="panel">
            <Empty icon="film" title="Önce bir kanal seç">
              Üst ortadaki kanal sekmelerinden birini seç ya da buraya bir kanal adı yaz.
            </Empty>
          </div>
        ) : videos.loading && !videos.data ? (
          <div className="center-pad">
            <Spinner size={22} />
          </div>
        ) : videos.error ? (
          <p className="field-error">{videos.error}</p>
        ) : !videos.data?.length ? (
          <div className="panel">
            <Empty icon="film" title="Bu kanalın kayıtlı yayını yok">
              Kick yayınları bir süre saklar; yayıncı kaydı kapatmış da olabilir.
            </Empty>
          </div>
        ) : (
          <ul className="vod-grid">
            {videos.data.map((v) => {
              const job = jobFor(v);
              const lv = job ? live[job.id] : undefined;
              const pct = lv?.progress ?? job?.progress ?? 0;
              return (
                <li key={v.id} className="vod-card">
                  <span className="clip-thumb">
                    {v.thumbnailUrl ? <img src={v.thumbnailUrl} alt="" loading="lazy" /> : <Icon name="film" size={26} />}
                    {v.isLive ? <span className="clip-badge clip-badge-live">CANLI</span> : <span className="clip-badge clip-badge-dur">{duration(v.durationSec)}</span>}
                    {job && job.status !== 'downloaded' && (
                      <span className="thumb-progress" aria-hidden="true">
                        <span style={{ width: `${pct}%` }} />
                      </span>
                    )}
                  </span>
                  <div className="vod-card-body">
                    <h3 className="clip-card-title">{v.title || 'Başlıksız yayın'}</h3>
                    <p className="clip-card-meta">
                      {dateTime(v.startedAt)} · {count(v.viewCount)} izlenme
                    </p>
                    <div className="row-gap">
                      {job?.status === 'downloaded' ? (
                        <button type="button" className="btn btn-accent btn-small" onClick={() => navigate(sectionPath('yayinlar', job.id))}>
                          <Icon name="scissors" size={14} /> Kes
                        </button>
                      ) : job ? (
                        <button type="button" className="btn btn-secondary btn-small" onClick={() => navigate(sectionPath('gorevler'))}>
                          <Spinner size={12} /> {job.status === 'queued' ? 'Sırada' : job.status === 'paused' ? 'Duraklatıldı' : `İniyor %${Math.round(pct)}`}
                          {lv?.speedBps ? ` · ${speedLabel(lv.speedBps)}` : ''}
                        </button>
                      ) : (
                        <button type="button" className="btn btn-secondary btn-small" onClick={() => download(v)} disabled={busy === String(v.id)}>
                          {busy === String(v.id) ? <Spinner size={12} /> : <Icon name="download" size={14} />}
                          {v.isLive ? 'Şu ana kadarını indir' : 'İndir'}
                        </button>
                      )}
                      <button type="button" className="btn btn-quiet btn-small" onClick={() => setRangeFor(v)} disabled={busy === String(v.id)} title="Yalnız bir aralığını indir">
                        <Icon name="clock" size={14} /> Aralık
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <RangeDialog
        open={!!rangeFor}
        onClose={() => setRangeFor(null)}
        title={rangeFor ? `${rangeFor.title || 'Yayın'} — aralık indir` : 'Aralık indir'}
        durationSec={rangeFor ? liveElapsed(rangeFor) : 0}
        live={!!rangeFor?.isLive}
        onSubmit={downloadRange}
      />
    </>
  );
}

interface VodDetail {
  job: VodJob;
  highlights: Highlight[];
  clips: Job[];
  vodUrl: string | null;
}

/** İndirilmiş bir yayının zaman çizelgesi editörü. */
function VodEditor({ id }: { id: number }) {
  const detail = useResource(() => api.get<VodDetail>(`/api/vod-jobs/${id}`), [id]);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [format, setFormat] = useState<'vertical' | 'horizontal'>('vertical');
  const [subtitles, setSubtitles] = useState(true);
  const [intro, setIntro] = useState(true);
  const [autoCount, setAutoCount] = useState(3);
  const [busy, setBusy] = useState(false);
  const { jobs } = jobsStore.use();

  useEffect(() => {
    api
      .get<{ frames: Frame[] }>(`/api/vod-jobs/${id}/filmstrip`)
      .then((r) => setFrames(r.frames))
      .catch(() => setFrames([]));
  }, [id]);

  useSocketEvent<{ vodJobId: number; status: string }>('vodscan:update', (e) => {
    if (e.vodJobId === id && /done|failed/.test(e.status)) {
      void detail.reload();
      void refreshJobs();
    }
  });

  if (detail.loading && !detail.data) {
    return (
      <div className="center-pad">
        <Spinner size={24} />
      </div>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <div className="panel">
        <Empty icon="film" title="Yayın açılamadı" action={<BackLink />}>
          {detail.error}
        </Empty>
      </div>
    );
  }

  const { job, highlights, vodUrl } = detail.data;
  const produced = jobs.filter((j) => j.vod_scan_job_id === id);
  const options = { outputFormat: format, subtitles, intro, introAsk: false, outro: intro };

  const submitCuts = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ clips: unknown[] }>(`/api/vod-jobs/${id}/cuts`, {
        cuts: cuts.map((c) => ({ start: c.start, end: c.end, color: c.color, label: c.label })),
        options,
      });
      toast(`${res.clips.length} kesit üretime gönderildi`, 'ok');
      setCuts([]);
      await refreshJobs();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const auto = async () => {
    setBusy(true);
    try {
      await api.post(`/api/vod-jobs/${id}/auto`, { count: autoCount, options: { ...options, outputFormat: 'vertical' } });
      toast(`En iyi ${autoCount} an aranıyor`, 'ok');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="crumb">
        <BackLink />
      </div>
      <WorkspaceHead guide="yayinlar" title={job.title || 'Yayın'} tape="kes" lead={`${job.channel_slug} · ${duration(job.duration_sec)} · ${dateTime(job.created_at)} tarihinde indirildi`} />

      <div className="ws-grid">
        <div className="ws-stack">
          <section className="panel">
            {vodUrl ? (
              <Timeline
                src={vodUrl}
                duration={job.duration_sec}
                frames={frames}
                markers={highlights.map((h) => ({ start: h.start_sec, end: h.end_sec, label: h.reason, score: h.score }))}
                cuts={cuts}
                onCutsChange={setCuts}
                onSnapshot={(t) => void takeSnapshot('vod', id, t)}
              />
            ) : (
              <Empty icon="film" title="Yayın dosyası artık yok">
                Saklama süresi dolmuş olabilir. Yayını yeniden indirebilirsin.
              </Empty>
            )}
          </section>

          {produced.length > 0 && (
            <section className="panel">
              <h2 className="panel-title">Bu yayından üretilenler</h2>
              <ul className="mini-list">
                {produced.map((j) => (
                  <li key={j.id}>
                    <button type="button" className="clip-row" onClick={() => navigate(sectionPath('galeri', j.id))}>
                      <span className="clip-row-thumb clip-row-thumb-h">{j.thumbnail_url ? <img src={j.thumbnail_url} alt="" /> : <Icon name="film" />}</span>
                      <span className="clip-row-body">
                        <span className="clip-row-title">{jobTitle(j)}</span>
                        <JobStatusLine job={j} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="ws-stack">
          <section className="panel">
            <span className="panel-tape" aria-hidden="true" />
            <h2 className="panel-title">Kesitler</h2>
            <CutList cuts={cuts} onChange={setCuts} />
            <div className="stack pad-top">
              <Segmented
                label="Video biçimi"
                value={format}
                onChange={setFormat}
                options={[
                  { value: 'vertical', label: 'Dikey klip' },
                  { value: 'horizontal', label: 'Yatay kesit' },
                ]}
              />
              <Switch checked={subtitles} onChange={setSubtitles} label="Altyazı" />
              {format === 'horizontal' && <Switch checked={intro} onChange={setIntro} label="Açılış ve kapanış videosu ekle" hint="Marka bölümünde yüklediysen" />}
              <button type="button" className="btn btn-accent" disabled={!cuts.length || busy} onClick={submitCuts}>
                {busy ? <Spinner /> : <Icon name="scissors" size={16} />}
                {cuts.length ? `${cuts.length} kesiti üret` : 'Kesit işaretle'}
              </button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void openInEditor({ type: 'vod', id }, { title: job.title || undefined, ranges: cuts.length ? cuts.map((c) => ({ start: c.start, end: c.end })) : undefined })}>
                <Icon name="layers" size={16} /> {cuts.length ? 'Kesitleri editörde aç' : 'Editörde aç'}
              </button>
            </div>
          </section>

          <section className="panel">
            <h2 className="panel-title">Otomatik</h2>
            <p className="panel-sub">Konuşma, tepki ve sahne değişimlerinden en güçlü anları bulur, dikey klibe çevirir.</p>
            {highlights.length > 0 && (
              <button type="button" className="btn btn-quiet btn-small" onClick={() => setCuts(highlights.slice(0, 12).map((h, i) => newCut(h.start_sec, h.end_sec, i, h.reason ?? undefined)))}>
                <Icon name="sparkle" size={14} /> {highlights.length} öne çıkan anı kesite çevir
              </button>
            )}
            <div className="inline-form pad-top">
              <input type="number" min={1} max={30} className="input input-narrow" value={autoCount} onChange={(e) => setAutoCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} aria-label="Klip sayısı" />
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={auto}>
                <Icon name="sparkle" size={16} /> En iyi anları çıkar
              </button>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}

/** Süren yayında "şu an" listenin yüklendiği an değil, gerçek an olsun. */
function liveElapsed(v: VodVideo) {
  if (!v.isLive) return v.durationSec;
  const start = kickTimeMs(v.startedAt);
  return start ? Math.max(v.durationSec, Math.floor((Date.now() - start) / 1000)) : v.durationSec;
}

function BackLink() {
  return (
    <button type="button" className="link" onClick={() => navigate(sectionPath('yayinlar'))}>
      ← Yayın geçmişleri
    </button>
  );
}
