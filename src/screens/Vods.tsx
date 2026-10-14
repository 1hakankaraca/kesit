import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { Timeline, CutList, newCut, type Cut } from '../components/Timeline.tsx';
import { Empty, Progress, Segmented, Spinner, Switch, WorkspaceHead } from '../components/basics.tsx';
import { api, query } from '../lib/api.ts';
import { bytes, count, dateTime, duration, relative } from '../lib/format.ts';
import { jobsStore, refreshJobs } from '../lib/jobs.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { useSocketEvent } from '../lib/socket.ts';
import { toast, toastError } from '../lib/toast.ts';
import { useResource } from '../lib/useResource.ts';
import type { Frame, Highlight, Job, VodJob, VodVideo } from '../lib/types.ts';
import { JobStatusLine, jobTitle } from './Library.tsx';

const QUALITIES = ['1080p', '720p', '480p'] as const;

const STATUS_TEXT: Record<VodJob['status'], string> = {
  queued: 'Sırada',
  processing: 'İndiriliyor',
  paused: 'Duraklatıldı',
  downloaded: 'Hazır',
  failed: 'Başarısız',
  cancelled: 'İptal edildi',
  expired: 'Süresi doldu',
};

/** Geçmiş yayınlar: listeden indir, zaman çizelgesinde kes. */
export function Vods({ openId }: { openId: number | null }) {
  return openId ? <VodEditor id={openId} /> : <VodList />;
}

function VodList() {
  const { user } = useSession();
  const [channel, setChannel] = useState(user?.channelSlug ?? '');
  const [quality, setQuality] = useState<(typeof QUALITIES)[number]>('720p');
  const videos = useResource(() => (channel ? api.get<{ videos: VodVideo[] }>(`/api/vods${query({ channel })}`).then((r) => r.videos) : Promise.resolve([])), [channel]);
  const jobs = useResource(() => api.get<{ jobs: VodJob[] }>('/api/vod-jobs').then((r) => r.jobs));
  const [busy, setBusy] = useState<string | null>(null);

  useSocketEvent<{ vodJobId: number; status: VodJob['status']; step: string; progress: number }>('vodscan:update', (e) => {
    if (!jobs.data?.some((j) => j.id === e.vodJobId)) return void jobs.reload();
    jobs.setData((list) => list?.map((j) => (j.id === e.vodJobId && STATUS_TEXT[e.status] ? { ...j, status: e.status, step: e.step, progress: e.progress ?? j.progress } : j)) ?? list);
    if (e.status === 'downloaded' || e.status === 'failed') void jobs.reload();
  });

  const download = async (v: VodVideo) => {
    setBusy(String(v.id));
    try {
      await api.post(v.isLive ? '/api/vods/capture-live' : '/api/vods/download', { channel, videoId: v.id, quality });
      toast(v.isLive ? 'Yayının şu ana kadarki bölümü indiriliyor' : 'Yayın indirme sırasına alındı', 'ok');
      await jobs.reload();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  const act = async (job: VodJob, action: 'pause' | 'resume' | 'cancel' | 'delete') => {
    try {
      if (action === 'delete') await api.del(`/api/vod-jobs/${job.id}`);
      else await api.post(`/api/vod-jobs/${job.id}/${action}`);
      await jobs.reload();
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <>
      <WorkspaceHead title="Geçmiş" tape="yayınlar" lead="Kick'in sakladığı yayınları indir; zaman çizelgesinde istediğin anı kes ya da en iyi anları otomatik buldur." />

      <div className="ws-grid">
        <section className="ws-stack" aria-labelledby="vod-list-title">
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
                <input name="channel" className="search-input" defaultValue={channel} placeholder="Kanal adı" aria-label="Kanal" />
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

          <h2 id="vod-list-title" className="eyebrow">
            {channel ? `${channel} — kayıtlı yayınlar` : 'Kayıtlı yayınlar'}
          </h2>
          {!channel ? (
            <div className="panel">
              <Empty icon="film" title="Önce bir kanal seç">
                Üst şeritten çalıştığın kanalı belirle ya da buraya bir kanal adı yaz.
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
              {videos.data.map((v) => (
                <li key={v.id} className="vod-card">
                  <span className="clip-thumb">
                    {v.thumbnailUrl ? <img src={v.thumbnailUrl} alt="" loading="lazy" /> : <Icon name="film" size={26} />}
                    {v.isLive ? <span className="clip-badge clip-badge-live">CANLI</span> : <span className="clip-badge clip-badge-dur">{duration(v.durationSec)}</span>}
                  </span>
                  <div className="vod-card-body">
                    <h3 className="clip-card-title">{v.title || 'Başlıksız yayın'}</h3>
                    <p className="clip-card-meta">
                      {dateTime(v.startedAt)} · {count(v.viewCount)} izlenme
                    </p>
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => download(v)} disabled={busy === String(v.id)}>
                      {busy === String(v.id) ? <Spinner size={12} /> : <Icon name="download" size={14} />}
                      {v.isLive ? 'Şu ana kadarını al' : 'İndir'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="ws-stack">
          <section className="panel">
            <span className="panel-tape" aria-hidden="true" />
            <h2 className="panel-title">İndirilenler</h2>
            <p className="panel-sub">İnen yayınlar 7 gün saklanır; bu sürede kesit alabilirsin.</p>
            {!jobs.data?.length ? (
              <p className="muted pad-top">Henüz indirilen yayın yok.</p>
            ) : (
              <ul className="vodjob-list">
                {jobs.data.map((j) => (
                  <li key={j.id} className="vodjob">
                    <div className="vodjob-top">
                      <span className="vodjob-title">{j.title || `Yayın #${j.source_video_id}`}</span>
                      <span className={`status status-${j.status === 'downloaded' ? 'ready' : j.status === 'failed' ? 'failed' : 'busy'}`}>{STATUS_TEXT[j.status]}</span>
                    </div>
                    {(j.status === 'processing' || j.status === 'queued' || j.status === 'paused') && <Progress value={j.status === 'queued' ? 0 : j.progress} />}
                    <p className="vodjob-meta">
                      {duration(j.duration_sec)}
                      {j.vod_file_size_bytes ? ` · ${bytes(j.vod_file_size_bytes)}` : ''}
                      {j.status === 'downloaded' && j.vod_expires_at ? ` · ${relative(j.vod_expires_at)} silinecek` : ''}
                    </p>
                    {j.error && <p className="field-error">{j.error}</p>}
                    <div className="row-gap">
                      {j.status === 'downloaded' && (
                        <button type="button" className="btn btn-accent btn-small" onClick={() => navigate(sectionPath('yayinlar', j.id))}>
                          <Icon name="scissors" size={14} /> Editörde aç
                        </button>
                      )}
                      {j.status === 'processing' && (
                        <button type="button" className="btn btn-quiet btn-small" onClick={() => act(j, 'pause')}>
                          Duraklat
                        </button>
                      )}
                      {j.status === 'paused' && (
                        <button type="button" className="btn btn-quiet btn-small" onClick={() => act(j, 'resume')}>
                          Sürdür
                        </button>
                      )}
                      {['queued', 'processing', 'paused'].includes(j.status) ? (
                        <button type="button" className="btn btn-quiet btn-small" onClick={() => act(j, 'cancel')}>
                          İptal
                        </button>
                      ) : (
                        <button type="button" className="btn btn-quiet btn-small" onClick={() => act(j, 'delete')}>
                          Sil
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
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
      <WorkspaceHead title={job.title || 'Yayın'} tape="kes" lead={`${job.channel_slug} · ${duration(job.duration_sec)} · ${dateTime(job.created_at)} tarihinde indirildi`} />

      <div className="ws-grid">
        <div className="ws-stack">
          <section className="panel">
            {vodUrl ? (
              <Timeline src={vodUrl} duration={job.duration_sec} frames={frames} markers={highlights.map((h) => ({ start: h.start_sec, end: h.end_sec, label: h.reason, score: h.score }))} cuts={cuts} onCutsChange={setCuts} />
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
                    <button type="button" className="clip-row" onClick={() => navigate(sectionPath('kutuphane', j.id))}>
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
                label="Çıktı biçimi"
                value={format}
                onChange={setFormat}
                options={[
                  { value: 'vertical', label: 'Dikey klip' },
                  { value: 'horizontal', label: 'Yatay kesit' },
                ]}
              />
              <Switch checked={subtitles} onChange={setSubtitles} label="Altyazı" />
              {format === 'horizontal' && <Switch checked={intro} onChange={setIntro} label="Intro ve outro ekle" hint="Marka bölümünde yüklediysen" />}
              <button type="button" className="btn btn-accent" disabled={!cuts.length || busy} onClick={submitCuts}>
                {busy ? <Spinner /> : <Icon name="scissors" size={16} />}
                {cuts.length ? `${cuts.length} kesiti üret` : 'Kesit işaretle'}
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

function BackLink() {
  return (
    <button type="button" className="link" onClick={() => navigate(sectionPath('yayinlar'))}>
      ← Geçmiş yayınlar
    </button>
  );
}
