import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChannelScopeToggle } from '../components/ChannelScopeToggle.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { PublishDialog, platformLabel } from '../components/PublishDialog.tsx';
import { Empty, Field, Progress, Segmented, Spinner, WorkspaceHead } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { useChannelScope } from '../lib/channelScope.ts';
import { openInEditor } from '../lib/editorOpen.ts';
import { bytes, dateTime, duration, parseJson, relative } from '../lib/format.ts';
import { isActive, jobsStore, refreshJobs, removeJobsLocally, restoreJobLocally } from '../lib/jobs.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { takeSnapshot } from '../lib/snapshot.ts';
import { useSocketEvent } from '../lib/socket.ts';
import { deleteWithUndo, toast, toastError } from '../lib/toast.ts';
import type { Job, ProjectSummary, RecorderStatus, Recording, ZernioSummary } from '../lib/types.ts';
import { useResource } from '../lib/useResource.ts';
import { stepLabel } from '../lib/words.ts';

type Kind = 'all' | 'vertical' | 'horizontal' | 'recording' | 'project';
type Status = 'all' | 'ready' | 'busy' | 'failed';
type Sort = 'new' | 'old' | 'long' | 'short';

const SOURCE_LABELS: Record<string, string> = {
  popular: 'Kick klibi',
  link: 'Bağlantıdan',
  live: 'Canlıda yakalandı',
  chat: 'Chat klibi',
  vod: 'Geçmiş yayın',
  vodscan: 'Geçmiş yayın',
  recording: 'Yayın kaydı',
  editor: 'Editörden',
};

const PUBLISH_LABELS: Record<string, string> = {
  publishing: 'Gönderiliyor',
  pending: 'Sırada',
  scheduled: 'Planlandı',
  published: 'Paylaşıldı',
  partial: 'Kısmen paylaşıldı',
  failed: 'Paylaşılamadı',
  unknown: 'Sonuç belirsiz',
};

const REC_STATUS: Record<Recording['status'], string> = { recording: 'Kayıtta', processing: 'Düzenleniyor', ready: 'Hazır', failed: 'Başarısız' };
const FINAL: Record<string, string> = { processing: 'Hazırlanıyor', ready: 'Hazır', failed: 'Hazırlanamadı', cancelled: 'İptal edildi' };
const COMPRESS_PROFILES = ['1080p', '720p', '480p'];

export const isHorizontal = (j: Job) => parseJson<{ outputFormat?: string }>(j.options, {}).outputFormat === 'horizontal';
export const jobTitle = (j: Job) => j.gen_title || j.title || `Video #${j.id}`;

interface Item {
  key: string;
  kind: 'video' | 'recording' | 'project';
  title: string;
  thumb: string | null;
  duration: number;
  at: string;
  channel: string | null;
  status: 'ready' | 'busy' | 'failed';
  statusLabel: string;
  format: 'vertical' | 'horizontal';
  previewUrl: string | null;
  href: string;
  job?: Job;
  rec?: Recording;
  project?: ProjectSummary;
}

/**
 * Galeri: hazırlanan videolar, yayın kayıtları ve editör projeleri tek
 * ızgarada. Üstte süzgeçler; karta tıklayınca izleme sayfası açılır.
 */
export function Gallery({ focus }: { focus: string | null }) {
  const { jobs: allJobs, loaded, progress } = jobsStore.use();
  const recs = useResource(() => api.get<{ recordings: Recording[]; recorder: RecorderStatus }>('/api/recordings'));
  const projects = useResource(() => api.get<{ projects: ProjectSummary[] }>('/api/projects').then((r) => r.projects));
  const reloadRecs = () => void recs.reload();
  useSocketEvent('recorder:finished', reloadRecs);
  useSocketEvent('recorder:edited', reloadRecs);
  useSocketEvent('recorder:publish', reloadRecs);
  useSocketEvent<{ recordingId: number; status: string; percent: number }>('recorder:final', (e) => {
    if (e.status === 'processing') recs.setData((d) => d && { ...d, recordings: d.recordings.map((r) => (r.id === e.recordingId ? { ...r, final_status: 'processing', final_percent: e.percent } : r)) });
    else reloadRecs();
  });
  useSocketEvent('project:render', () => void projects.reload());

  if (focus) {
    const recId = focus.startsWith('k') ? Number(focus.slice(1)) : null;
    if (recId) {
      const rec = recs.data?.recordings.find((r) => r.id === recId);
      if (!recs.data) return <Loading />;
      if (!rec) return <Missing what="Kayıt" />;
      return <RecordingDetail rec={rec} others={recs.data.recordings.filter((r) => r.id !== rec.id)} onChange={reloadRecs} />;
    }
    const job = allJobs.find((j) => j.id === Number(focus));
    if (!loaded) return <Loading />;
    if (!job) return <Missing what="Video" />;
    return <VideoDetail job={job} progress={progress[job.id]} others={allJobs.filter((j) => j.id !== job.id)} />;
  }

  const refreshAll = () => Promise.all([refreshJobs(), recs.reload(), projects.reload()]);
  return <Grid jobs={allJobs} loaded={loaded && !!recs.data} recordings={recs.data?.recordings ?? []} projects={projects.data ?? []} progress={progress} onDeleted={refreshAll} />;
}

function Loading() {
  return (
    <div className="center-pad">
      <Spinner size={24} />
    </div>
  );
}

function Missing({ what }: { what: string }) {
  return (
    <div className="panel">
      <Empty
        icon="library"
        title={`${what} bulunamadı`}
        action={
          <button type="button" className="btn btn-secondary" onClick={() => navigate(sectionPath('galeri'))}>
            Galeri'ye dön
          </button>
        }
      >
        Silinmiş olabilir.
      </Empty>
    </div>
  );
}

/* ── Izgara ─────────────────────────────────────────────────────────────── */

function toItems(jobs: Job[], recordings: Recording[], projects: ProjectSummary[]): Item[] {
  const items: Item[] = jobs.map((j) => ({
    key: `v${j.id}`,
    kind: 'video',
    title: jobTitle(j),
    thumb: j.thumbnail_url,
    duration: j.duration,
    at: j.created_at,
    channel: j.channel_slug,
    status: j.status === 'ready' ? 'ready' : j.status === 'failed' ? 'failed' : 'busy',
    statusLabel: j.status === 'ready' ? (j.publish_status ? PUBLISH_LABELS[j.publish_status] : 'Hazır') : j.status === 'failed' ? 'Başarısız' : j.status === 'queued' ? 'Sırada' : stepLabel(j.step),
    format: isHorizontal(j) ? 'horizontal' : 'vertical',
    previewUrl: j.status === 'ready' ? j.video_url : null,
    href: sectionPath('galeri', j.id),
    job: j,
  }));
  for (const r of recordings) {
    items.push({
      key: `k${r.id}`,
      kind: 'recording',
      title: r.title || `${r.channel_slug} yayın kaydı`,
      thumb: null,
      duration: r.duration_sec,
      at: r.started_at,
      channel: r.channel_slug,
      status: r.status === 'ready' ? 'ready' : r.status === 'failed' ? 'failed' : 'busy',
      statusLabel: REC_STATUS[r.status],
      format: 'horizontal',
      previewUrl: r.available ? `/api/recordings/${r.id}/stream` : null,
      href: sectionPath('galeri', `k${r.id}`),
      rec: r,
    });
  }
  for (const p of projects) {
    items.push({
      key: `p${p.id}`,
      kind: 'project',
      title: p.title,
      thumb: p.thumbUrl,
      duration: p.durationSec,
      at: p.updatedAt,
      channel: null,
      status: p.rendering && !p.rendering.jobId && !p.rendering.error ? 'busy' : 'ready',
      statusLabel: p.rendering && !p.rendering.jobId && !p.rendering.error ? `Dışa aktarılıyor %${p.rendering.percent}` : 'Proje',
      format: p.format,
      previewUrl: null,
      href: sectionPath('editor', p.id),
      project: p,
    });
  }
  return items;
}

const KIND_WORD: Record<Item['kind'], string> = { video: 'Video', recording: 'Kayıt', project: 'Proje' };

/** Hazırlanmakta olan öğeler sunucuda silinemez; seçime de alınmaz. */
const canDelete = (i: Item) => i.status !== 'busy';

/** Türüne göre doğru uç noktaya gider; videolar tek istekte toplu silinir. */
async function deleteOnServer(targets: Item[]) {
  const jobIds = targets.filter((i) => i.kind === 'video').map((i) => i.job!.id);
  const others = targets.filter((i) => i.kind !== 'video');
  const calls: Promise<unknown>[] = others.map((i) => api.del(i.kind === 'recording' ? `/api/recordings/${i.rec!.id}` : `/api/projects/${i.project!.id}`));
  if (jobIds.length === 1) calls.push(api.del(`/api/jobs/${jobIds[0]}`));
  else if (jobIds.length > 1)
    calls.push(
      api.post<{ removed: number }>('/api/jobs/bulk-delete', { ids: jobIds }).then((r) => {
        if (r.removed < jobIds.length) throw new Error(`${jobIds.length - r.removed} video silinemedi`);
      }),
    );
  const results = await Promise.allSettled(calls);
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (!failed.length) return;
  const first = (failed[0].reason as Error)?.message || 'Silinemedi';
  throw new Error(failed.length === 1 ? first : `${failed.length} öğe silinemedi — ${first}`);
}

function Grid({ jobs, loaded, recordings, projects, progress, onDeleted }: { jobs: Job[]; loaded: boolean; recordings: Recording[]; projects: ProjectSummary[]; progress: Record<number, number>; onDeleted: () => Promise<unknown> }) {
  const { inScope } = useChannelScope();
  const [kind, setKind] = useState<Kind>('all');
  const [status, setStatus] = useState<Status>('all');
  const [sort, setSort] = useState<Sort>('new');
  const [q, setQ] = useState('');
  /** Geri alınabilir silme sürerken ekrandan kaldırılan öğeler. */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const lastPick = useRef<string | null>(null);

  const items = useMemo(() => toItems(jobs, recordings, projects).filter((i) => inScope(i.channel) && !hidden.has(i.key)), [jobs, recordings, projects, inScope, hidden]);
  const visible = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase('tr');
    const list = items.filter((i) => {
      if (kind === 'recording' && i.kind !== 'recording') return false;
      if (kind === 'project' && i.kind !== 'project') return false;
      if ((kind === 'vertical' || kind === 'horizontal') && (i.kind !== 'video' || i.format !== kind)) return false;
      if (status !== 'all' && i.status !== status) return false;
      if (needle && !`${i.title} ${i.channel ?? ''}`.toLocaleLowerCase('tr').includes(needle)) return false;
      return true;
    });
    return list.sort((a, b) => (sort === 'new' ? b.at.localeCompare(a.at) : sort === 'old' ? a.at.localeCompare(b.at) : sort === 'long' ? b.duration - a.duration : a.duration - b.duration));
  }, [items, kind, status, sort, q]);

  const counts = { video: items.filter((i) => i.kind === 'video').length, recording: items.filter((i) => i.kind === 'recording').length, project: items.filter((i) => i.kind === 'project').length };
  const selectable = useMemo(() => visible.filter(canDelete), [visible]);
  const chosen = useMemo(() => visible.filter((i) => selected.has(i.key)), [visible, selected]);

  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
    lastPick.current = null;
  };

  const toggle = (item: Item, range: boolean) => {
    if (!canDelete(item)) return;
    // Çapa, güncelleyici ertelenmeden önce okunur; yoksa son tık kendisi olur.
    const anchor = range && lastPick.current ? selectable.findIndex((i) => i.key === lastPick.current) : -1;
    const target = selectable.findIndex((i) => i.key === item.key);
    setSelected((s) => {
      const next = new Set(s);
      if (anchor >= 0 && target >= 0) {
        // Shift ile tıklama: son seçimle bu kart arasındaki görünen her şey seçilir.
        for (const i of selectable.slice(Math.min(anchor, target), Math.max(anchor, target) + 1)) next.add(i.key);
      } else if (next.has(item.key)) next.delete(item.key);
      else next.add(item.key);
      return next;
    });
    lastPick.current = item.key;
  };

  const remove = (targets: Item[]) => {
    const list = targets.filter(canDelete);
    if (!list.length) return;
    const keys = list.map((i) => i.key);
    const prune = () =>
      setHidden((s) => {
        const next = new Set(s);
        keys.forEach((k) => next.delete(k));
        return next;
      });
    deleteWithUndo({
      label: list.length === 1 ? `${KIND_WORD[list[0].kind]} silindi` : `${list.length} öğe silindi`,
      hide: () => {
        setHidden((s) => new Set([...s, ...keys]));
        setSelected((s) => {
          const next = new Set(s);
          keys.forEach((k) => next.delete(k));
          return next;
        });
      },
      restore: prune,
      // Kısmen başarısız olsa da liste tazelenir ki silinenler geri gelmesin.
      commit: () => deleteOnServer(list).finally(() => onDeleted().catch(() => {})),
      done: prune,
    });
  };

  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') stopSelecting();
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected(new Set(selectable.map((i) => i.key)));
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && chosen.length) {
        e.preventDefault();
        remove(chosen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selecting, selectable, chosen]);

  return (
    <>
      <WorkspaceHead
        guide="galeri"
        title="Galeri"
        tape={`${items.length}`}
        lead="Hazırladığın videolar, yayın kayıtların ve editör projelerin. Karta tıkla, izle; istersen editörde aç."
        actions={
          <>
            <ChannelScopeToggle />
            <button type="button" className="btn btn-accent" onClick={() => navigate(sectionPath('klipler'))}>
              <Icon name="plus" size={16} /> Dikey klip üret
            </button>
          </>
        }
      />

      <div className="gallery-filters panel">
        <div className="search gallery-search">
          <Icon name="search" size={16} />
          <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Başlık ya da kanal ara" aria-label="Galeride ara" />
        </div>
        <Segmented
          size="small"
          label="Tür"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'Hepsi' },
            { value: 'vertical', label: 'Dikey' },
            { value: 'horizontal', label: 'Yatay' },
            { value: 'recording', label: `Yayın kayıtları${counts.recording ? ` (${counts.recording})` : ''}` },
            { value: 'project', label: `Projeler${counts.project ? ` (${counts.project})` : ''}` },
          ]}
        />
        <Segmented
          size="small"
          label="Durum"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'Tümü' },
            { value: 'ready', label: 'Hazır' },
            { value: 'busy', label: 'Hazırlanan' },
            { value: 'failed', label: 'Hatalı' },
          ]}
        />
        <Segmented
          size="small"
          label="Sırala"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'new', label: 'Yeni' },
            { value: 'old', label: 'Eski' },
            { value: 'long', label: 'Uzun' },
            { value: 'short', label: 'Kısa' },
          ]}
        />
        {items.length > 0 && (
          <button
            type="button"
            className={`btn btn-small ${selecting ? 'btn-secondary' : 'btn-quiet'} gallery-select-toggle`}
            aria-pressed={selecting}
            title={selecting ? 'Seçimi bitir (Esc)' : 'Birden çok öğeyi seçip toplu sil'}
            onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
          >
            <Icon name={selecting ? 'x' : 'check'} size={14} /> {selecting ? 'Bitti' : 'Seç'}
          </button>
        )}
      </div>

      {!loaded ? (
        <Loading />
      ) : items.length === 0 ? (
        <div className="panel">
          <Empty
            icon="library"
            title="Galeri boş"
            action={
              <div className="row-gap">
                <button type="button" className="btn btn-accent" onClick={() => navigate(sectionPath('klipler'))}>
                  Kliplerden başla
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => navigate(sectionPath('yayinlar'))}>
                  Yayın indir
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => navigate(sectionPath('editor'))}>
                  Editörü aç
                </button>
              </div>
            }
          >
            Kick kliplerinden dikey video üret, bir yayın indir ya da editörde sıfırdan başla; hazırlanan her şey burada toplanır.
          </Empty>
        </div>
      ) : visible.length === 0 ? (
        <p className="muted pad">Bu süzgeçte bir şey yok.</p>
      ) : (
        <ul className={`gallery-grid${selecting ? ' gallery-selecting' : ''}`}>
          {visible.map((it, i) => (
            <motion.li key={it.key} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 16) * 0.02 }}>
              <GalleryCard item={it} progress={it.job ? progress[it.job.id] : undefined} selecting={selecting} selected={selected.has(it.key)} onToggle={(range) => toggle(it, range)} />
              {!selecting && canDelete(it) && (
                <button type="button" className="gcard-x" title={`${KIND_WORD[it.kind]} sil`} aria-label={`${it.title} — sil`} onClick={() => remove([it])}>
                  <Icon name="trash" size={14} />
                </button>
              )}
            </motion.li>
          ))}
        </ul>
      )}

      <AnimatePresence>
        {selecting && (
          <motion.div className="action-bar" initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }} role="toolbar" aria-label="Seçim işlemleri">
            <b>{chosen.length ? `${chosen.length} öğe seçildi` : 'Silmek için kartlara tıkla'}</b>
            {chosen.length < selectable.length && (
              <button type="button" className="btn btn-quiet btn-small" onClick={() => setSelected(new Set(selectable.map((i) => i.key)))}>
                Tümünü seç{selectable.length < visible.length ? ` (${selectable.length})` : ''}
              </button>
            )}
            {chosen.length > 0 && (
              <button type="button" className="btn btn-quiet btn-small" onClick={() => setSelected(new Set())}>
                Temizle
              </button>
            )}
            <button type="button" className="btn btn-quiet btn-small" onClick={stopSelecting}>
              Vazgeç
            </button>
            <button type="button" className="btn btn-danger" disabled={!chosen.length} onClick={() => remove(chosen)}>
              <Icon name="trash" size={16} /> Sil{chosen.length ? ` (${chosen.length})` : ''}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** YouTube benzeri kart: üstünde bekleyince sessiz önizleme oynar; seçim modunda tıklamak seçer. */
function GalleryCard({ item, progress, selecting, selected, onToggle }: { item: Item; progress?: number; selecting: boolean; selected: boolean; onToggle: (range: boolean) => void }) {
  const [hover, setHover] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enter = () => {
    if (!item.previewUrl || selecting) return;
    timer.current = setTimeout(() => setHover(true), 450);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    setHover(false);
  };
  const kindIcon: IconName = item.kind === 'recording' ? 'record' : item.kind === 'project' ? 'scissors' : item.format === 'vertical' ? 'vertical' : 'horizontal';
  const pickable = canDelete(item);
  const cls = ['gcard', `gcard-${item.format}`, selecting && selected && 'gcard-on', selecting && !pickable && 'gcard-off'].filter(Boolean).join(' ');
  return (
    <a
      href={item.href}
      className={cls}
      aria-selected={selecting ? selected : undefined}
      aria-disabled={selecting && !pickable ? true : undefined}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onClick={(e) => {
        e.preventDefault();
        if (selecting) onToggle(e.shiftKey);
        else navigate(item.href);
      }}
    >
      <span className="gcard-thumb">
        {selecting && pickable && (
          <span className="gcard-check" aria-hidden="true">
            <Icon name="check" size={14} />
          </span>
        )}
        {item.thumb ? <img src={item.thumb} alt="" loading="lazy" /> : <Icon name={kindIcon} size={28} />}
        {hover && item.previewUrl && <video className="gcard-preview" src={item.previewUrl} muted autoPlay loop playsInline preload="none" />}
        {item.status === 'busy' && (
          <span className="gcard-busy">
            <Spinner size={14} /> {item.statusLabel}
            {item.job && typeof progress === 'number' && <i style={{ width: `${progress}%` }} />}
          </span>
        )}
        {item.duration > 0 && <span className="clip-badge clip-badge-dur">{duration(item.duration)}</span>}
        <span className="gcard-kind" title={item.kind === 'recording' ? 'Yayın kaydı' : item.kind === 'project' ? 'Editör projesi' : item.format === 'vertical' ? 'Dikey video' : 'Yatay video'}>
          <Icon name={kindIcon} size={13} />
        </span>
      </span>
      <span className="gcard-body">
        <span className="gcard-title">{item.title}</span>
        <span className="gcard-meta">
          <span className={`status status-${item.status === 'ready' ? 'ready' : item.status === 'failed' ? 'failed' : 'busy'}`}>{item.statusLabel}</span>
          {item.channel ? ` · ${item.channel}` : ''} · {relative(item.at)}
        </span>
      </span>
    </a>
  );
}

/* ── Video sayfası ──────────────────────────────────────────────────────── */

export function JobStatusLine({ job, progress }: { job: Job; progress?: number }) {
  if (job.status === 'ready') {
    const publish = job.publish_status ? PUBLISH_LABELS[job.publish_status] : null;
    return (
      <span className="clip-row-meta">
        <span className="status status-ready">{publish ?? 'Hazır'}</span>
        <span>{relative(job.created_at)}</span>
      </span>
    );
  }
  if (job.status === 'failed') return <span className="status status-failed">Başarısız</span>;
  return (
    <span className="clip-row-progress">
      <span className="status status-busy">{job.status === 'queued' ? 'Sırada' : stepLabel(job.step)}</span>
      <Progress value={job.status === 'queued' ? 0 : (progress ?? null)} />
    </span>
  );
}

function VideoDetail({ job, progress, others }: { job: Job; progress?: number; others: Job[] }) {
  const horizontal = isHorizontal(job);
  const [busy, setBusy] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const tags = parseJson<string[]>(job.gen_hashtags, []);
  const platforms = parseJson<{ platform: string; status: string; url?: string }[]>(job.publish_platforms, []);
  const issues = parseJson<string[]>(job.qc_issues, []);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [job.id]);

  const act = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    try {
      await fn();
      if (done) toast(done, 'ok');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  const remove = () =>
    deleteWithUndo({
      label: 'Video silindi',
      hide: () => {
        removeJobsLocally([job.id]);
        navigate(sectionPath('galeri'), true);
      },
      restore: () => {
        restoreJobLocally(job);
        navigate(sectionPath('galeri', job.id), true);
      },
      commit: () => api.del(`/api/jobs/${job.id}`),
    });

  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast('Kopyalandı', 'ok'), () => toast('Kopyalanamadı', 'error'));

  return (
    <div className="watch">
      <div className="crumb">
        <button type="button" className="link" onClick={() => navigate(sectionPath('galeri'))}>
          ← Galeri
        </button>
      </div>
      <div className="watch-grid">
        <div className="watch-main">
          <div className={horizontal ? 'stage stage-h' : 'stage stage-v watch-stage-v'}>
            {job.status === 'ready' && job.video_url ? (
              <video ref={videoRef} key={job.video_url} className="stage-video" src={job.video_url} poster={job.thumbnail_url ?? undefined} controls autoPlay playsInline preload="metadata" />
            ) : (
              <div className="stage-placeholder">
                {job.status === 'failed' ? (
                  <>
                    <Icon name="x" size={28} />
                    <p>{job.error || 'Üretim başarısız oldu'}</p>
                  </>
                ) : (
                  <>
                    <Spinner size={26} />
                    <p>{job.status === 'queued' ? 'Sırada bekliyor' : stepLabel(job.step)}</p>
                    <div className="stage-progress">
                      <Progress value={job.status === 'queued' ? 0 : (progress ?? null)} />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <h1 className="watch-title">{jobTitle(job)}</h1>
          <p className="watch-sub">
            {SOURCE_LABELS[job.source] ?? job.source}
            {job.channel_slug ? ` · ${job.channel_slug}` : ''} · {dateTime(job.created_at)} · {horizontal ? 'Yatay 16:9' : 'Dikey 9:16'}
            {job.status === 'ready' ? ` · ${duration(job.duration)}` : ''}
            {job.file_size_bytes ? ` · ${bytes(job.file_size_bytes)}` : ''}
          </p>
          <div className="watch-actions">
            {job.status === 'ready' && (
              <>
                <button type="button" className="btn btn-accent" onClick={() => void openInEditor({ type: 'job', id: job.id }, { title: jobTitle(job) })}>
                  <Icon name="scissors" size={16} /> Editörde aç
                </button>
                <button type="button" className="btn btn-primary" onClick={() => setPublishing(true)} disabled={!!job.publish_status && job.publish_status !== 'failed'}>
                  <Icon name="share" size={16} /> {job.publish_status && job.publish_status !== 'failed' ? PUBLISH_LABELS[job.publish_status] : 'Paylaş'}
                </button>
                <a className="btn btn-secondary" href={`/api/jobs/${job.id}/download`}>
                  <Icon name="download" size={16} /> İndir
                </a>
                <button type="button" className="btn btn-secondary" onClick={() => void takeSnapshot('clip', job.id, videoRef.current?.currentTime ?? 0)} title="Videonun o anki karesini kaydet">
                  <Icon name="image" size={16} /> Ekran görüntüsü
                </button>
                <div className="btn-group" role="group" aria-label="Küçültülmüş indir">
                  {COMPRESS_PROFILES.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className="btn btn-quiet btn-small"
                      disabled={!!busy}
                      onClick={() =>
                        act(
                          `c-${p}`,
                          async () => {
                            const res = await api.post<{ downloadUrl: string }>(`/api/jobs/${job.id}/compress`, { profile: p });
                            location.assign(res.downloadUrl);
                          },
                          `${p} sürüm hazır`,
                        )
                      }
                    >
                      {busy === `c-${p}` ? <Spinner size={12} /> : p}
                    </button>
                  ))}
                </div>
              </>
            )}
            {job.status === 'failed' && (
              <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => act('retry', () => api.post(`/api/jobs/${job.id}/retry`).then(refreshJobs), 'Yeniden sıraya alındı')}>
                <Icon name="refresh" size={16} /> Yeniden dene
              </button>
            )}
            <button type="button" className="btn btn-quiet stage-delete" onClick={remove} disabled={isActive(job)}>
              <Icon name="trash" size={16} /> Sil
            </button>
          </div>

          {job.viral_reason && !/LLM/i.test(job.viral_reason) && <p className="inspector-note">{job.viral_reason}</p>}
          {job.qc_verdict === 'broken' && <p className="notice-box">Otomatik kontrol bir sorun buldu{issues.length ? `: ${issues.join(', ')}` : ''}. Paylaşmadan önce izle.</p>}
          {job.gen_description && (
            <section className="copy-block">
              <header>
                <h3>Açıklama</h3>
                <button type="button" className="link" onClick={() => copy(job.gen_description!)}>
                  Kopyala
                </button>
              </header>
              <p>{job.gen_description}</p>
            </section>
          )}
          {tags.length > 0 && (
            <section className="copy-block">
              <header>
                <h3>Etiketler</h3>
                <button type="button" className="link" onClick={() => copy(tags.map((t) => `#${t}`).join(' '))}>
                  Kopyala
                </button>
              </header>
              <p className="tags">
                {tags.map((t) => (
                  <span key={t} className="tag">
                    #{t}
                  </span>
                ))}
              </p>
            </section>
          )}
          {platforms.length > 0 && (
            <section className="copy-block">
              <header>
                <h3>Paylaşım</h3>
                {job.scheduled_for && <span className="muted">{dateTime(job.scheduled_for)}</span>}
              </header>
              <ul className="platform-list">
                {platforms.map((p) => (
                  <li key={p.platform}>
                    <span className={`platform-badge platform-${p.platform}`}>{platformLabel(p.platform).slice(0, 2)}</span>
                    <span>{platformLabel(p.platform)}</span>
                    <span className="muted">{PUBLISH_LABELS[p.status] ?? p.status}</span>
                    {p.url && (
                      <a className="link" href={p.url} target="_blank" rel="noreferrer">
                        Aç
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="watch-side" aria-label="Diğer videolar">
          <h2 className="section-title">Diğer videolar</h2>
          <ul className="watch-list">
            {others.slice(0, 30).map((j) => (
              <li key={j.id}>
                <button type="button" className="clip-row" onClick={() => navigate(sectionPath('galeri', j.id))}>
                  <span className={isHorizontal(j) ? 'clip-row-thumb clip-row-thumb-h' : 'clip-row-thumb'}>
                    {j.thumbnail_url ? <img src={j.thumbnail_url} alt="" loading="lazy" /> : <Icon name={isHorizontal(j) ? 'horizontal' : 'vertical'} />}
                    {j.status === 'ready' && <span className="clip-row-dur">{duration(j.duration)}</span>}
                  </span>
                  <span className="clip-row-body">
                    <span className="clip-row-title">{jobTitle(j)}</span>
                    <JobStatusLine job={j} />
                  </span>
                </button>
              </li>
            ))}
            {!others.length && <li className="muted pad">Başka video yok.</li>}
          </ul>
        </aside>
      </div>
      <PublishDialog job={publishing ? job : null} onClose={() => setPublishing(false)} onDone={() => void refreshJobs()} />
    </div>
  );
}

/* ── Yayın kaydı sayfası ────────────────────────────────────────────────── */

function RecordingDetail({ rec, others, onChange }: { rec: Recording; others: Recording[]; onChange: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showFinal, setShowFinal] = useState(false);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [rec.id]);
  const src = rec.final_available && showFinal ? `/api/recordings/${rec.id}/stream?final=1` : rec.available ? `/api/recordings/${rec.id}/stream` : null;
  const remove = () =>
    deleteWithUndo({
      label: 'Kayıt silindi',
      hide: () => navigate(sectionPath('galeri'), true),
      restore: () => {
        onChange();
        navigate(sectionPath('galeri', `k${rec.id}`), true);
      },
      commit: () => api.del(`/api/recordings/${rec.id}`),
      done: onChange,
    });

  return (
    <div className="watch">
      <div className="crumb">
        <button type="button" className="link" onClick={() => navigate(sectionPath('galeri'))}>
          ← Galeri
        </button>
      </div>
      <div className="watch-grid">
        <div className="watch-main">
          <div className="stage stage-h">
            {src ? (
              <video ref={videoRef} key={src} className="stage-video" src={src} controls playsInline preload="metadata" />
            ) : (
              <div className="stage-placeholder">
                <Icon name="record" size={28} />
                <p>{rec.status === 'recording' ? 'Kayıt sürüyor' : rec.status === 'processing' ? 'Düzenleme sürüyor' : rec.error || 'Kayıt dosyası yok'}</p>
              </div>
            )}
          </div>
          <h1 className="watch-title">{rec.title || `${rec.channel_slug} yayın kaydı`}</h1>
          <p className="watch-sub">
            Yayın kaydı · {rec.channel_slug} · {dateTime(rec.started_at)} · {duration(rec.duration_sec)} · {bytes(rec.file_size)} · <span className={`status status-${rec.status === 'ready' ? 'ready' : rec.status === 'failed' ? 'failed' : 'busy'}`}>{REC_STATUS[rec.status]}</span>
          </p>
          <div className="watch-actions">
            <button type="button" className="btn btn-accent" disabled={!rec.available} onClick={() => void openInEditor({ type: 'recording', id: rec.id }, { title: rec.title || `${rec.channel_slug} yayını` })}>
              <Icon name="scissors" size={16} /> Editörde aç
            </button>
            {rec.available && (
              <a className="btn btn-secondary" href={`/api/recordings/${rec.id}/download`}>
                <Icon name="download" size={16} /> Ham kaydı indir
              </a>
            )}
            {rec.final_available && (
              <>
                <a className="btn btn-secondary" href={`/api/recordings/${rec.id}/download?final=1`}>
                  <Icon name="download" size={16} /> Hazır videoyu indir
                </a>
                <button type="button" className="btn btn-quiet btn-small" onClick={() => setShowFinal((v) => !v)}>
                  {showFinal ? 'Ham kaydı göster' : 'Hazır videoyu göster'}
                </button>
              </>
            )}
            {rec.available && (
              <button type="button" className="btn btn-secondary" onClick={() => void takeSnapshot('recording', rec.id, videoRef.current?.currentTime ?? 0)}>
                <Icon name="image" size={16} /> Ekran görüntüsü
              </button>
            )}
            <button type="button" className="btn btn-quiet stage-delete" onClick={remove} disabled={rec.status === 'recording' || rec.status === 'processing'}>
              <Icon name="trash" size={16} /> Sil
            </button>
          </div>
          <div className="rec-panels">
            <OutputPanel rec={rec} onChange={onChange} />
            <YoutubePanel rec={rec} onChange={onChange} />
          </div>
        </div>
        <aside className="watch-side" aria-label="Diğer kayıtlar">
          <h2 className="section-title">Diğer kayıtlar</h2>
          <ul className="watch-list">
            {others.slice(0, 30).map((r) => (
              <li key={r.id}>
                <button type="button" className="clip-row" onClick={() => navigate(sectionPath('galeri', `k${r.id}`))}>
                  <span className="clip-row-thumb clip-row-thumb-h">
                    <Icon name="record" />
                    {r.duration_sec > 0 && <span className="clip-row-dur">{duration(r.duration_sec)}</span>}
                  </span>
                  <span className="clip-row-body">
                    <span className="clip-row-title">{r.title || `${r.channel_slug} yayını`}</span>
                    <span className="clip-row-meta">
                      <span className={`status status-${r.status === 'ready' ? 'ready' : r.status === 'failed' ? 'failed' : 'busy'}`}>{REC_STATUS[r.status]}</span>
                      <span>{dateTime(r.started_at)}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {!others.length && <li className="muted pad">Başka kayıt yok.</li>}
          </ul>
        </aside>
      </div>
    </div>
  );
}

function OutputPanel({ rec, onChange }: { rec: Recording; onChange: () => void }) {
  const [compress, setCompress] = useState<{ profile: string; percent: number | null; ready: boolean } | null>(null);
  useSocketEvent<{ clipId: string; profil: string; percent: number }>('clipcompress:progress', (e) => {
    if (e.clipId === `rec-${rec.id}`) setCompress({ profile: e.profil, percent: e.percent, ready: false });
  });
  useSocketEvent<{ clipId: string; profil: string }>('clipcompress:done', (e) => {
    if (e.clipId === `rec-${rec.id}`) setCompress({ profile: e.profil, percent: 100, ready: true });
  });
  useSocketEvent<{ clipId: string; error: string }>('clipcompress:failed', (e) => {
    if (e.clipId === `rec-${rec.id}`) {
      setCompress(null);
      toast(e.error || 'Sıkıştırma başarısız', 'error');
    }
  });
  const finalBusy = rec.final_status === 'processing';
  return (
    <section className="panel">
      <h2 className="panel-title">Paylaşıma hazır video</h2>
      <p className="panel-sub">Kaydın açılış/kapanış videosu ve logo eklenmiş, boyutu küçültülmüş hali. Ayarları "Logo ve görünüm" bölümünde.</p>
      <dl className="facts">
        <div>
          <dt>Ham kayıt</dt>
          <dd>
            {bytes(rec.file_size)} · {rec.quality ?? '—'}
          </dd>
        </div>
        <div>
          <dt>Paylaşıma hazır</dt>
          <dd>{rec.final_status ? `${FINAL[rec.final_status] ?? rec.final_status}${rec.final_size ? ` · ${bytes(rec.final_size)}` : ''}` : 'Henüz hazırlanmadı'}</dd>
        </div>
      </dl>
      {finalBusy && <Progress value={rec.final_percent} label="Hazırlanıyor" />}
      {rec.final_error && <p className="field-error">{rec.final_error}</p>}
      <div className="row-gap pad-top">
        {finalBusy ? (
          <button type="button" className="btn btn-quiet" onClick={() => api.post(`/api/recordings/${rec.id}/final/cancel`).then(onChange, toastError)}>
            İptal
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" disabled={!rec.available} onClick={() => api.post(`/api/recordings/${rec.id}/final`).then(onChange, toastError)}>
            <Icon name="refresh" size={14} /> {rec.final_status ? 'Yeniden hazırla' : 'Paylaşıma hazırla'}
          </button>
        )}
      </div>
      {rec.available && (
        <div className="pad-top">
          {compress && !compress.ready ? (
            <div className="stack-s">
              <span className="muted">{compress.profile} sürüm hazırlanıyor</span>
              <Progress value={compress.percent} />
            </div>
          ) : compress?.ready ? (
            <a className="btn btn-secondary btn-small" href={`/api/recordings/${rec.id}/compress/download?profile=${compress.profile}`}>
              <Icon name="download" size={14} /> {compress.profile} sürümü indir
            </a>
          ) : (
            <div className="btn-group" role="group" aria-label="Küçültülmüş sürüm">
              {COMPRESS_PROFILES.map((p) => (
                <button key={p} type="button" className="btn btn-quiet btn-small" onClick={() => api.post(`/api/recordings/${rec.id}/compress`, { profile: p }).then(() => setCompress({ profile: p, percent: 0, ready: false }), toastError)}>
                  {p} küçült
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const YT_STATUS: Record<string, string> = { uploading: 'Yükleniyor', draft: 'Taslak hazır', publishing: 'Gönderiliyor', published: "YouTube'da yayında", failed: 'Başarısız' };

function YoutubePanel({ rec, onChange }: { rec: Recording; onChange: () => void }) {
  const [zernio, setZernio] = useState<ZernioSummary | null>(null);
  const [accountId, setAccountId] = useState('');
  const [title, setTitle] = useState(rec.publish_title || rec.title || '');
  const [description, setDescription] = useState(rec.publish_content ?? '');
  const [visibility, setVisibility] = useState<'public' | 'unlisted' | 'private'>(rec.publish_visibility ?? 'unlisted');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get<ZernioSummary>('/api/zernio')
      .then((z) => {
        setZernio(z);
        setAccountId(z.accounts.find((a) => a.platform === 'youtube')?.id ?? '');
      })
      .catch(() => {});
  }, []);
  const youtube = zernio?.accounts.filter((a) => a.platform === 'youtube') ?? [];
  const call = (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    fn()
      .then(() => {
        toast(done, 'ok');
        onChange();
      }, toastError)
      .finally(() => setBusy(false));
  };
  return (
    <section className="panel">
      <h2 className="panel-title">YouTube'a gönder</h2>
      {!zernio ? (
        <Spinner />
      ) : !zernio.connected ? (
        <button type="button" className="link" onClick={() => navigate(sectionPath('paylasim'))}>
          Zernio hesabını bağla
        </button>
      ) : !youtube.length ? (
        <p className="muted">Zernio profilinde bağlı YouTube hesabı yok.</p>
      ) : rec.publish_status && rec.publish_status !== 'failed' ? (
        <div className="stack-s">
          <p>
            <span className="status status-ready">{YT_STATUS[rec.publish_status] ?? rec.publish_status}</span>
          </p>
          {rec.publish_url && (
            <a className="link" href={rec.publish_url} target="_blank" rel="noreferrer">
              Videoyu aç
            </a>
          )}
          <div className="row-gap">
            {rec.publish_status === 'draft' && (
              <>
                <button type="button" className="btn btn-accent btn-small" disabled={busy} onClick={() => call(() => api.post(`/api/recordings/${rec.id}/youtube/send`), 'Gönderildi')}>
                  Yayınla
                </button>
                <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => call(() => api.del(`/api/recordings/${rec.id}/youtube/draft`), 'Taslak silindi')}>
                  Taslağı sil
                </button>
              </>
            )}
            <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => call(() => api.get(`/api/recordings/${rec.id}/youtube/status`), 'Durum güncellendi')}>
              Durumu yenile
            </button>
          </div>
        </div>
      ) : (
        <div className="stack-s">
          {rec.publish_error && <p className="field-error">{rec.publish_error}</p>}
          <Field label="Hesap" htmlFor="yt-acc">
            <select id="yt-acc" className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {youtube.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Başlık" htmlFor="yt-title">
            <input id="yt-title" className="input" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Açıklama" htmlFor="yt-desc">
            <textarea id="yt-desc" className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Segmented
            label="Görünürlük"
            value={visibility}
            onChange={setVisibility}
            options={[
              { value: 'unlisted', label: 'Liste dışı' },
              { value: 'private', label: 'Özel' },
              { value: 'public', label: 'Herkese açık' },
            ]}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !rec.final_available || !title.trim()}
            title={rec.final_available ? undefined : 'Önce kaydı paylaşıma hazırla'}
            onClick={() => call(() => api.post(`/api/recordings/${rec.id}/youtube/draft`, { accountId, title, content: description, visibility }), 'Taslak yükleniyor')}
          >
            <Icon name="upload" size={14} /> Taslak olarak yükle
          </button>
        </div>
      )}
    </section>
  );
}

