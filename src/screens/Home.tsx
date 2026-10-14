import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Pill } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { bytes, dayKey, duration, relative } from '../lib/format.ts';
import { jobsStore } from '../lib/jobs.ts';
import { liveStore } from '../lib/live.ts';
import { navigate, sectionPath, type Section } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { isActiveTask, refreshTasks, tasksStore, type LiveDownload, type Task } from '../lib/tasks.ts';
import { toastError } from '../lib/toast.ts';
import { useInterval } from '../lib/useResource.ts';
import { etaLabel, speedLabel, stepLabel } from '../lib/words.ts';
import { isHorizontal, jobTitle } from './Gallery.tsx';

const QUICK: { section: Section; icon: IconName; title: string; text: string; img: string }[] = [
  { section: 'canli', icon: 'live', title: 'Canlı yayın', text: 'Kaydet, klip yakala, !clip at', img: '/img/canli.jpg' },
  { section: 'klipler', icon: 'vertical', title: 'Dikey klip üret', text: 'Kick kliplerini seç, işleme gönder', img: '/img/dikey.jpg' },
  { section: 'editor', icon: 'scissors', title: 'Editörü aç', text: 'Kes, birleştir, yazı ve müzik ekle', img: '/img/editor.jpg' },
  { section: 'yayinlar', icon: 'film', title: 'Yayın indir', text: 'Geçmiş yayını bilgisayara al', img: '/img/indir.jpg' },
];

/** Video hazırlama hattının adımları — kartta hangi adımda olduğu gösterilir. */
const PIPELINE: { key: string; label: string; match: RegExp }[] = [
  { key: 'indir', label: 'İndir', match: /indiriliyor|hazırlanıyor|kaynak/ },
  { key: 'kamera', label: 'Kamera', match: /facecam|hareket|yüz/ },
  { key: 'yazi', label: 'Yazı', match: /transkript|küfür/ },
  { key: 'video', label: 'Video', match: /video oluşturuluyor|kırpılıyor/ },
  { key: 'kontrol', label: 'Kontrol', match: /kontrol|kalite|açıklama|viral/ },
];

const KIND_LABEL: Record<Task['kind'], string> = {
  yayin: 'Yayın iniyor',
  'klip-indir': 'Klip iniyor',
  video: 'Video hazırlanıyor',
  kayit: 'Canlı kayıt',
  'hazir-video': 'Paylaşıma hazırlanıyor',
  model: 'Altyazı modeli iniyor',
  proje: 'Dışa aktarılıyor',
};

function greeting() {
  const h = new Date().getHours();
  return h < 6 ? 'İyi geceler' : h < 12 ? 'Günaydın' : h < 18 ? 'İyi günler' : 'İyi akşamlar';
}

/** Anasayfa: fotoğraflı giriş, hızlı başlangıç, canlı ilerleme ve son bitenler. */
export function Home() {
  const { user } = useSession();
  const { tasks, live: liveDownloads } = tasksStore.use();
  const { jobs, progress } = jobsStore.use();
  const live = liveStore.use();
  const [, tick] = useState(0);

  useEffect(() => {
    void refreshTasks();
  }, []);
  const active = useMemo(() => tasks.filter(isActiveTask), [tasks]);
  useInterval(() => tick((n) => n + 1), active.length ? 1000 : null);

  const today = dayKey(new Date());
  const ready = jobs.filter((j) => j.status === 'ready');
  const todayCount = ready.filter((j) => dayKey(j.created_at) === today).length;
  const recent = [...ready].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8);
  const totalBytes = ready.reduce((s, j) => s + (j.file_size_bytes || 0), 0);
  const isLive = !!(live?.recorder.recording || live?.watcher.watching || live?.autopilot.live);

  return (
    <div className="home">
      <section className="hero" aria-label="Hoş geldin">
        <img className="hero-img" src="/img/hero.jpg" alt="" />
        <div className="hero-shade" aria-hidden="true" />
        <div className="hero-body">
          <p className="hero-eyebrow">
            {greeting()}
            {isLive && (
              <span className="hero-live">
                <i /> şu an iş var
              </span>
            )}
          </p>
          <h1 className="hero-title">
            {user?.username ?? 'Kesit'} <span className="hero-tape">stüdyosu</span>
          </h1>
          <p className="hero-lead">Yayından klibe, klipten paylaşıma. Hazırlanan videoların ilerlemesini buradan izle; yeni bir işe de buradan başla.</p>
          <div className="hero-actions">
            <button type="button" className="btn btn-accent btn-large" onClick={() => navigate(sectionPath('klipler'))}>
              <Icon name="vertical" size={18} /> Dikey klip üret
            </button>
            <button type="button" className="btn hero-ghost btn-large" onClick={() => void newProject()}>
              <Icon name="scissors" size={18} /> Editörü aç
            </button>
          </div>
          <div className="hero-stats" aria-label="Özet">
            <span>
              <b>{todayCount}</b> bugün hazırlanan
            </span>
            <span>
              <b>{ready.length}</b> hazır video
            </span>
            <span>
              <b>{active.length}</b> süren iş
            </span>
            <span>
              <b>{bytes(totalBytes)}</b> videoların yeri
            </span>
          </div>
        </div>
        {live && (live.recorder.recording || live.watcher.watching || live.autopilot.config.enabled) && (
          <div className="hero-pills">
            {live.recorder.recording && (
              <button type="button" className="pill-button" onClick={() => navigate(sectionPath('canli'))}>
                <Pill tone="live">Kaydediliyor · {live.recorder.channel}</Pill>
              </button>
            )}
            {live.watcher.watching && (
              <button type="button" className="pill-button" onClick={() => navigate(sectionPath('canli'))}>
                <Pill tone="on">Klipler dinleniyor · {live.watcher.channel}</Pill>
              </button>
            )}
            {live.autopilot.config.enabled && (
              <button type="button" className="pill-button" onClick={() => navigate(sectionPath('nobet'))}>
                <Pill tone={live.autopilot.live ? 'live' : 'ok'}>{live.autopilot.live ? 'Bot: yayında' : `Bot bekliyor · ${live.autopilot.config.channel}`}</Pill>
              </button>
            )}
          </div>
        )}
      </section>

      <div className="home-quick">
        {QUICK.map((q, i) => (
          <motion.button
            key={q.section}
            type="button"
            className="quick-tile"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.05 }}
            whileHover={{ y: -4 }}
            onClick={() => (q.section === 'editor' ? void newProject() : navigate(sectionPath(q.section)))}
          >
            <img className="quick-img" src={q.img} alt="" loading="lazy" />
            <span className="quick-shade" aria-hidden="true" />
            <span className="quick-body">
              <span className="quick-icon">
                <Icon name={q.icon} size={18} />
              </span>
              <b>{q.title}</b>
              <span>{q.text}</span>
            </span>
          </motion.button>
        ))}
      </div>

      <section className="home-section" aria-labelledby="now-title">
        <div className="home-section-head">
          <h2 id="now-title" className="section-title">
            Şu an hazırlananlar {active.length > 0 && <span className="eyebrow-count">{active.length}</span>}
          </h2>
          <button type="button" className="link" onClick={() => navigate(sectionPath('gorevler'))}>
            Görev yöneticisi →
          </button>
        </div>
        {active.length === 0 ? (
          <div className="home-idle">
            <span className="home-idle-orb" aria-hidden="true" />
            <div>
              <b>Her şey sakin</b>
              <p>Şu an hazırlanan bir video yok. Bir klip üret ya da yayın indir; ilerlemesi burada canlı görünür.</p>
            </div>
          </div>
        ) : (
          <ul className="now-grid">
            <AnimatePresence>
              {active.map((t) => (
                <motion.li key={t.key} layout initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}>
                  <NowCard task={t} live={t.vodJobId ? liveDownloads[t.vodJobId] : undefined} jobProgress={t.kind === 'video' ? progress[Number(t.key.replace('video-', ''))] : undefined} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>

      <section className="home-section" aria-labelledby="recent-title">
        <div className="home-section-head">
          <h2 id="recent-title" className="section-title">
            Son bitenler
          </h2>
          <button type="button" className="link" onClick={() => navigate(sectionPath('galeri'))}>
            Galeri →
          </button>
        </div>
        {recent.length === 0 ? (
          <p className="muted">Henüz hazır video yok.</p>
        ) : (
          <ul className="recent-row">
            {recent.map((j) => (
              <li key={j.id}>
                <button type="button" className={isHorizontal(j) ? 'recent-card recent-card-h' : 'recent-card'} onClick={() => navigate(sectionPath('galeri', j.id))}>
                  <span className="recent-thumb">{j.thumbnail_url ? <img src={j.thumbnail_url} alt="" loading="lazy" /> : <Icon name="film" />}</span>
                  <span className="recent-title">{jobTitle(j)}</span>
                  <span className="recent-meta">
                    {duration(j.duration)} · {relative(j.created_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

async function newProject() {
  try {
    const res = await api.post<{ project: { id: number } }>('/api/projects', {});
    navigate(sectionPath('editor', res.project.id));
  } catch (err) {
    toastError(err);
  }
}

/** Süren bir işin kartı: halka ilerleme + adımlar + hız/kalan süre. */
function NowCard({ task: t, live, jobProgress }: { task: Task; live?: LiveDownload; jobProgress?: number }) {
  const pct = live?.progress ?? t.progress ?? jobProgress ?? null;
  const stepIndex = t.kind === 'video' ? PIPELINE.findIndex((p) => p.match.test((t.step || '').toLocaleLowerCase('tr'))) : -1;
  const details = [live?.bytes ? `${bytes(live.bytes)} indi` : null, speedLabel(live?.speedBps), etaLabel(pct, live?.startedAt)].filter(Boolean);
  const go = () => t.link && navigate(sectionPath(t.link.section as Section, t.link.sub));
  return (
    <button type="button" className="now-card" onClick={go}>
      <Ring value={pct} />
      <span className="now-body">
        <b className="now-title">{t.title}</b>
        <span className="now-kind">
          {KIND_LABEL[t.kind]}
          {t.channel ? ` · ${t.channel}` : ''}
        </span>
        <span className="now-step">{stepLabel(t.step)}</span>
        {t.kind === 'video' && (
          <span className="pipeline" aria-hidden="true">
            {PIPELINE.map((p, i) => (
              <span key={p.key} className={i < stepIndex ? 'pipe pipe-done' : i === stepIndex ? 'pipe pipe-now' : 'pipe'}>
                <i />
                {p.label}
              </span>
            ))}
          </span>
        )}
        {details.length > 0 && <span className="now-details">{details.join(' · ')}</span>}
      </span>
    </button>
  );
}

/** Halka ilerleme; yüzde yoksa dönen belirsiz halka. */
export function Ring({ value, size = 64 }: { value: number | null; size?: number }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const pct = value === null ? 30 : Math.max(0, Math.min(100, value));
  return (
    <span className={value === null ? 'ring ring-spin' : 'ring'} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} />
        <circle className="ring-fill" cx={size / 2} cy={size / 2} r={r} strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      {value !== null && <b>%{Math.round(value)}</b>}
    </span>
  );
}
