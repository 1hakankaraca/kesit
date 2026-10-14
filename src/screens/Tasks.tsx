import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Empty, Progress, Segmented, Spinner, WorkspaceHead } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { bytes, relative } from '../lib/format.ts';
import { navigate, sectionPath, type Section } from '../lib/router.ts';
import { isActiveTask, refreshTasks, tasksStore, type Task } from '../lib/tasks.ts';
import { toastError } from '../lib/toast.ts';
import { useInterval } from '../lib/useResource.ts';
import { etaLabel, speedLabel, stepLabel } from '../lib/words.ts';

type Filter = 'hepsi' | Task['group'];

const KIND: Record<Task['kind'], { icon: IconName; label: string }> = {
  yayin: { icon: 'film', label: 'Geçmiş yayın indirme' },
  'klip-indir': { icon: 'download', label: 'Kick klibi indirme' },
  video: { icon: 'vertical', label: 'Video hazırlama' },
  kayit: { icon: 'record', label: 'Canlı kayıt' },
  'hazir-video': { icon: 'sparkle', label: 'Paylaşıma hazır video' },
  model: { icon: 'download', label: 'Altyazı modeli indirme' },
};

/** Görev yöneticisi: inen, hazırlanan, biten ve hatalı işler; her biri gideceği yere bağlı. */
export function Tasks() {
  const { loaded, tasks, live } = tasksStore.use();
  const [filter, setFilter] = useState<Filter>('hepsi');

  useEffect(() => {
    void refreshTasks();
  }, []);
  // Kalan süre ve göreli zamanlar akarken ekran tazelensin.
  const [, tick] = useState(0);
  useInterval(() => tick((n) => n + 1), tasks.some(isActiveTask) ? 1000 : null);

  const counts = {
    iniyor: tasks.filter((t) => t.group === 'iniyor').length,
    hazirlaniyor: tasks.filter((t) => t.group === 'hazirlaniyor').length,
    bitti: tasks.filter((t) => t.group === 'bitti').length,
    hata: tasks.filter((t) => t.group === 'hata').length,
  };
  const shown = filter === 'hepsi' ? tasks : tasks.filter((t) => t.group === filter);
  const label = (name: string, n: number) => (n ? `${name} (${n})` : name);

  return (
    <>
      <WorkspaceHead guide="gorevler" title="Görev" tape="yöneticisi" lead="İnen yayınlar, hazırlanan videolar ve son bir günde bitenler. Bir işe tıklayıp ilgili yere gidebilirsin." />
      <div className="toolbar panel">
        <Segmented
          label="Bölüm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'hepsi', label: label('Hepsi', tasks.length) },
            { value: 'iniyor', label: label('İnenler', counts.iniyor) },
            { value: 'hazirlaniyor', label: label('Hazırlananlar', counts.hazirlaniyor) },
            { value: 'bitti', label: label('Bitenler', counts.bitti) },
            { value: 'hata', label: label('Hatalılar', counts.hata) },
          ]}
        />
      </div>

      {!loaded ? (
        <div className="center-pad">
          <Spinner size={24} />
        </div>
      ) : shown.length === 0 ? (
        <div className="panel">
          <Empty icon="check" title={filter === 'hepsi' ? 'Şu an iş yok' : 'Bu bölümde iş yok'}>
            Bir yayın indirdiğinde ya da video hazırlattığında burada adım adım görürsün.
          </Empty>
        </div>
      ) : (
        <ul className="task-list">
          {shown.map((t) => (
            <TaskRow key={t.key} task={t} live={t.vodJobId ? live[t.vodJobId] : undefined} />
          ))}
        </ul>
      )}
    </>
  );
}

function TaskRow({ task: t, live }: { task: Task; live?: { progress: number | null; bytes: number | null; speedBps: number | null; startedAt: number } }) {
  const [busy, setBusy] = useState(false);
  const running = isActiveTask(t);
  const progress = live?.progress ?? t.progress;
  const details = [
    running && progress !== null ? `%${Math.round(progress)}` : null,
    running && live?.bytes ? `${bytes(live.bytes)} indi` : !running && t.sizeBytes ? bytes(t.sizeBytes) : null,
    running ? speedLabel(live?.speedBps) : null,
    running ? etaLabel(progress, live?.startedAt) : null,
  ].filter(Boolean);

  const vodAction = async (action: 'pause' | 'resume' | 'cancel' | 'remove') => {
    setBusy(true);
    try {
      if (action === 'remove') await api.del(`/api/vod-jobs/${t.vodJobId}`);
      else await api.post(`/api/vod-jobs/${t.vodJobId}/${action}`);
      await refreshTasks();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`task task-${t.group}`}>
      <span className="task-icon">
        <Icon name={KIND[t.kind].icon} size={18} />
      </span>
      <div className="task-body">
        <div className="task-top">
          <b className="task-title">{t.title}</b>
          <span className={`status status-${t.group === 'bitti' ? 'ready' : t.group === 'hata' ? 'failed' : 'busy'}`}>{stepLabel(t.step)}</span>
        </div>
        <span className="task-meta">
          {KIND[t.kind].label}
          {t.channel ? ` · ${t.channel}` : ''} · {relative(t.at)}
        </span>
        {running && <Progress value={progress} label={t.title} />}
        {details.length > 0 && <span className="task-details">{details.join(' · ')}</span>}
        {t.error && <span className="field-error">{t.error}</span>}
      </div>
      <div className="task-actions">
        {t.kind === 'yayin' && t.group === 'iniyor' && (
          <>
            {t.step === 'Duraklatıldı' ? (
              <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void vodAction('resume')}>
                Sürdür
              </button>
            ) : t.step === 'İndiriliyor' ? (
              <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void vodAction('pause')}>
                Duraklat
              </button>
            ) : null}
            <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void vodAction('cancel')}>
              İptal
            </button>
          </>
        )}
        {t.kind === 'yayin' && t.group === 'hata' && (
          <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void vodAction('remove')}>
            Listeden kaldır
          </button>
        )}
        {t.link && (
          <button type="button" className={t.group === 'bitti' ? 'btn btn-accent btn-small' : 'btn btn-secondary btn-small'} onClick={() => navigate(sectionPath(t.link!.section as Section, t.link!.sub))}>
            {t.link.label}
            <Icon name="chevron" size={14} />
          </button>
        )}
      </div>
    </li>
  );
}
