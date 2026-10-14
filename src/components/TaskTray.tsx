import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { isActive, jobsStore } from '../lib/jobs.ts';
import { navigate, sectionPath } from '../lib/router.ts';
import { useSocketEvent } from '../lib/socket.ts';
import { Icon } from './Icon.tsx';
import { Progress } from './basics.tsx';

interface SideTask {
  key: string;
  label: string;
  step: string;
  progress: number | null;
  href: string;
}

const STEP_LABELS: Record<string, string> = {
  '': 'Sırada',
  indiriliyor: 'İndiriliyor',
  'facecam tespiti': 'Yüz kamerası aranıyor',
  'video oluşturuluyor': 'Video oluşturuluyor',
  tamamlandı: 'Tamamlandı',
};

const stepLabel = (step: string | null) => (step && (STEP_LABELS[step] ?? step.charAt(0).toLocaleUpperCase('tr') + step.slice(1))) || 'Sırada';

/**
 * Arka planda süren işler: klip üretimi, yayın indirme ve kayıt çıktısı.
 * Sağ altta katlanır bir tepsi; kullanıcı sayfa değiştirse de izler.
 */
export function TaskTray() {
  const { jobs, progress } = jobsStore.use();
  const [open, setOpen] = useState(true);
  const [side, setSide] = useState<Record<string, SideTask>>({});

  const upsert = (task: SideTask | null, key: string) =>
    setSide((s) => {
      const next = { ...s };
      if (task) next[key] = task;
      else delete next[key];
      return next;
    });

  useSocketEvent<{ vodJobId: number; status: string; step: string; progress: number }>('vodscan:update', (e) => {
    const key = `vod-${e.vodJobId}`;
    const running = e.status === 'processing' || e.status === 'paused';
    upsert(running ? { key, label: `Yayın #${e.vodJobId}`, step: e.status === 'paused' ? 'Duraklatıldı' : stepLabel(e.step), progress: e.progress ?? null, href: sectionPath('yayinlar', e.vodJobId) } : null, key);
  });

  useSocketEvent<{ recordingId: number; status: string; percent: number }>('recorder:final', (e) => {
    const key = `final-${e.recordingId}`;
    upsert(e.status === 'processing' ? { key, label: `Kayıt #${e.recordingId} çıktısı`, step: 'Kodlanıyor', progress: e.percent ?? null, href: sectionPath('kayitlar', e.recordingId) } : null, key);
  });

  const active = jobs.filter(isActive);
  const tasks: SideTask[] = [
    ...active.map((j) => ({
      key: `job-${j.id}`,
      label: j.gen_title || j.title || `Klip #${j.id}`,
      step: j.status === 'queued' ? 'Sırada' : stepLabel(j.step),
      progress: j.status === 'queued' ? 0 : (progress[j.id] ?? null),
      href: sectionPath('kutuphane', j.id),
    })),
    ...Object.values(side),
  ];

  return (
    <AnimatePresence>
      {tasks.length > 0 && (
        <motion.aside className="tray" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 30 }} aria-label="Süren işler">
          <button type="button" className="tray-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <span className="tray-dot" aria-hidden="true" />
            <b>{tasks.length} iş sürüyor</b>
            <Icon name="chevron" size={14} className={open ? 'tray-caret tray-caret-open' : 'tray-caret'} />
          </button>
          {open && (
            <ul className="tray-list">
              {tasks.slice(0, 6).map((t) => (
                <li key={t.key}>
                  <button type="button" className="tray-row" onClick={() => navigate(t.href)}>
                    <span className="tray-row-top">
                      <span className="tray-label">{t.label}</span>
                      <span className="tray-step">{t.step}</span>
                    </span>
                    <Progress value={t.progress} label={t.label} />
                  </button>
                </li>
              ))}
              {tasks.length > 6 && <li className="tray-more">ve {tasks.length - 6} iş daha</li>}
            </ul>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
