import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { PublishDialog, platformLabel } from '../components/PublishDialog.tsx';
import { Empty, Modal, Progress, Segmented, Spinner, WorkspaceHead } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { bytes, dateTime, duration, parseJson, relative } from '../lib/format.ts';
import { isActive, jobsStore, refreshJobs, removeJobsLocally } from '../lib/jobs.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { Job } from '../lib/types.ts';

type FormatFilter = 'all' | 'vertical' | 'horizontal';
type StatusFilter = 'all' | 'ready' | 'busy' | 'failed';

const SOURCE_LABELS: Record<string, string> = {
  popular: 'Kick klibi',
  link: 'Bağlantıdan',
  live: 'Canlıda yakalandı',
  chat: 'Chat klibi',
  vod: 'Geçmiş yayın',
  vodscan: 'Geçmiş yayın',
  recording: 'Yayın kaydı',
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

const COMPRESS_PROFILES = [
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
];

export const isHorizontal = (j: Job) => parseJson<{ outputFormat?: string }>(j.options, {}).outputFormat === 'horizontal';
export const jobTitle = (j: Job) => j.gen_title || j.title || `Klip #${j.id}`;

/**
 * Kütüphane: üretilen tüm klip ve kesitler. Editör düzeninde — solda liste,
 * ortada önizleme sahnesi, sağda üretilen metinler ve paylaşım denetçisi.
 */
export function Library({ focusId }: { focusId: number | null }) {
  const { jobs, loaded, queue, progress } = jobsStore.use();
  const [format, setFormat] = useState<FormatFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [q, setQ] = useState('');
  const [publishing, setPublishing] = useState<Job | null>(null);

  const visible = useMemo(
    () =>
      jobs.filter((j) => {
        if (format !== 'all' && (format === 'horizontal') !== isHorizontal(j)) return false;
        if (status === 'ready' && j.status !== 'ready') return false;
        if (status === 'busy' && !isActive(j)) return false;
        if (status === 'failed' && j.status !== 'failed') return false;
        if (q && !`${jobTitle(j)} ${j.channel_slug ?? ''}`.toLocaleLowerCase('tr').includes(q.toLocaleLowerCase('tr'))) return false;
        return true;
      }),
    [jobs, format, status, q],
  );

  const selected = jobs.find((j) => j.id === focusId) ?? visible[0] ?? null;
  const select = (id: number) => navigate(sectionPath('kutuphane', id), true);

  return (
    <>
      <WorkspaceHead
        guide="kutuphane"
        title="Kütüphane"
        tape="stüdyo"
        lead="Ürettiğin tüm dikey klipler ve yatay kesitler. Önizle, metni düzenle, indir ya da paylaş."
        actions={
          <>
            {queue && (queue.running > 0 || queue.waiting > 0) && (
              <span className="pill">
                <Spinner size={12} /> {queue.running} işleniyor · {queue.waiting} sırada
              </span>
            )}
            <button type="button" className="btn btn-accent" onClick={() => navigate(sectionPath('klipler'))}>
              <Icon name="plus" size={16} /> Klip üret
            </button>
          </>
        }
      />

      {!loaded ? (
        <div className="center-pad">
          <Spinner size={24} />
        </div>
      ) : jobs.length === 0 ? (
        <div className="panel">
          <Empty
            icon="library"
            title="Kütüphane henüz boş"
            action={
              <div className="row-gap">
                <button type="button" className="btn btn-accent" onClick={() => navigate(sectionPath('klipler'))}>
                  Kliplerden başla
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => navigate(sectionPath('yayinlar'))}>
                  Geçmiş yayından kes
                </button>
              </div>
            }
          >
            Kick kliplerini tara ya da geçmiş bir yayından kesit al; üretilen her şey burada toplanır.
          </Empty>
        </div>
      ) : (
        <div className="editor">
          <section className="editor-list panel panel-flat" aria-label="Klip listesi">
            <div className="editor-list-tools">
              <div className="search">
                <Icon name="search" size={16} />
                <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ara" aria-label="Kliplerde ara" />
              </div>
              <Segmented
                size="small"
                label="Biçim"
                value={format}
                onChange={setFormat}
                options={[
                  { value: 'all', label: 'Hepsi' },
                  { value: 'vertical', label: 'Dikey' },
                  { value: 'horizontal', label: 'Yatay' },
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
                  { value: 'busy', label: 'Süren' },
                  { value: 'failed', label: 'Hata' },
                ]}
              />
            </div>
            <ul className="editor-rows">
              {visible.map((j) => (
                <li key={j.id}>
                  <button type="button" className="clip-row" aria-current={selected?.id === j.id} onClick={() => select(j.id)}>
                    <span className={isHorizontal(j) ? 'clip-row-thumb clip-row-thumb-h' : 'clip-row-thumb'}>
                      {j.thumbnail_url ? <img src={j.thumbnail_url} alt="" loading="lazy" /> : <Icon name={isHorizontal(j) ? 'horizontal' : 'vertical'} />}
                      {j.status === 'ready' && <span className="clip-row-dur">{duration(j.duration)}</span>}
                    </span>
                    <span className="clip-row-body">
                      <span className="clip-row-title">{jobTitle(j)}</span>
                      <JobStatusLine job={j} progress={progress[j.id]} />
                    </span>
                  </button>
                </li>
              ))}
              {!visible.length && <li className="muted pad">Bu filtrede klip yok.</li>}
            </ul>
          </section>

          <AnimatePresence mode="wait">
            {selected && (
              <motion.div key={selected.id} className="editor-stage-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                <Stage job={selected} progress={progress[selected.id]} onPublish={() => setPublishing(selected)} />
                <Inspector job={selected} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      <PublishDialog job={publishing} onClose={() => setPublishing(null)} onDone={() => void refreshJobs()} />
    </>
  );
}

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
      <span className="status status-busy">{job.status === 'queued' ? 'Sırada' : job.step || 'İşleniyor'}</span>
      <Progress value={job.status === 'queued' ? 0 : (progress ?? null)} />
    </span>
  );
}

/** Önizleme sahnesi: biçime göre 9:16 ya da 16:9 çerçeve + eylemler. */
function Stage({ job, progress, onPublish }: { job: Job; progress?: number; onPublish: () => void }) {
  const horizontal = isHorizontal(job);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

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

  const compress = (profile: string) =>
    act(
      `c-${profile}`,
      async () => {
        const res = await api.post<{ downloadUrl: string }>(`/api/jobs/${job.id}/compress`, { profile });
        location.assign(res.downloadUrl);
      },
      `${profile} sürüm hazır`,
    );

  return (
    <section className="editor-stage panel" aria-label="Önizleme">
      <div className={horizontal ? 'stage stage-h' : 'stage stage-v'}>
        {job.status === 'ready' && job.video_url ? (
          <video key={job.video_url} className="stage-video" src={job.video_url} poster={job.thumbnail_url ?? undefined} controls playsInline preload="metadata" />
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
                <p>{job.status === 'queued' ? 'Sırada bekliyor' : job.step || 'İşleniyor'}</p>
                <div className="stage-progress">
                  <Progress value={job.status === 'queued' ? 0 : (progress ?? null)} />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="stage-actions">
        {job.status === 'ready' && (
          <>
            <button type="button" className="btn btn-accent" onClick={onPublish} disabled={!!job.publish_status && job.publish_status !== 'failed'}>
              <Icon name="share" size={16} /> {job.publish_status && job.publish_status !== 'failed' ? PUBLISH_LABELS[job.publish_status] : 'Paylaş'}
            </button>
            <a className="btn btn-secondary" href={`/api/jobs/${job.id}/download`}>
              <Icon name="download" size={16} /> İndir
            </a>
            <div className="btn-group" role="group" aria-label="Küçültülmüş indir">
              {COMPRESS_PROFILES.map((p) => (
                <button key={p.value} type="button" className="btn btn-quiet btn-small" disabled={!!busy} onClick={() => compress(p.value)}>
                  {busy === `c-${p.value}` ? <Spinner size={12} /> : p.label}
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
        <button type="button" className="btn btn-quiet stage-delete" onClick={() => setConfirm(true)} disabled={isActive(job)}>
          <Icon name="trash" size={16} /> Sil
        </button>
      </div>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Klip silinsin mi?"
        footer={
          <>
            <button type="button" className="btn btn-quiet" onClick={() => setConfirm(false)}>
              Vazgeç
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() =>
                act(
                  'del',
                  async () => {
                    await api.del(`/api/jobs/${job.id}`);
                    removeJobsLocally([job.id]);
                    setConfirm(false);
                    navigate(sectionPath('kutuphane'), true);
                  },
                  'Klip silindi — arşivde kaydı kalır',
                )
              }
            >
              Sil
            </button>
          </>
        }
      >
        <p className="notice">Video dosyası diskten silinir. Arşivde bu klibin ne zaman üretildiği ve nerede paylaşıldığı görünmeye devam eder.</p>
      </Modal>
    </section>
  );
}

function Inspector({ job }: { job: Job }) {
  const tags = parseJson<string[]>(job.gen_hashtags, []);
  const platforms = parseJson<{ platform: string; status: string; url?: string }[]>(job.publish_platforms, []);
  const issues = parseJson<string[]>(job.qc_issues, []);
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast('Kopyalandı', 'ok'),
      () => toast('Kopyalanamadı', 'error'),
    );

  return (
    <aside className="editor-inspector panel panel-flat" aria-label="Klip ayrıntıları">
      <p className="eyebrow">{SOURCE_LABELS[job.source] ?? job.source}</p>
      <h2 className="inspector-title">{jobTitle(job)}</h2>

      <dl className="facts">
        <div>
          <dt>Biçim</dt>
          <dd>{isHorizontal(job) ? 'Yatay 16:9' : 'Dikey 9:16'}</dd>
        </div>
        <div>
          <dt>Süre</dt>
          <dd>{job.status === 'ready' ? duration(job.duration) : '—'}</dd>
        </div>
        {job.viral_score != null && (
          <div>
            <dt>Viral skor</dt>
            <dd>
              <span className="score">{job.viral_score}</span>
            </dd>
          </div>
        )}
        {job.file_size_bytes ? (
          <div>
            <dt>Boyut</dt>
            <dd>{bytes(job.file_size_bytes)}</dd>
          </div>
        ) : null}
        {job.channel_slug && (
          <div>
            <dt>Kanal</dt>
            <dd>{job.channel_slug}</dd>
          </div>
        )}
        <div>
          <dt>Üretildi</dt>
          <dd>{dateTime(job.created_at)}</dd>
        </div>
      </dl>

      {job.viral_reason && <p className="inspector-note">{job.viral_reason}</p>}
      {job.qc_verdict === 'broken' && <p className="notice-box">Kalite kontrolü sorun buldu{issues.length ? `: ${issues.join(', ')}` : ''}. Paylaşmadan önce izle.</p>}

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
    </aside>
  );
}
