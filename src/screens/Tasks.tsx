import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Empty, Progress, Segmented, Spinner, WorkspaceHead } from '../components/basics.tsx';
import { api } from '../lib/api.ts';
import { bytes, relative } from '../lib/format.ts';
import { navigate, sectionPath, type Section } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { isActiveTask, refreshTasks, tasksStore, type Task } from '../lib/tasks.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { SystemReport } from '../lib/types.ts';
import { useInterval, useResource } from '../lib/useResource.ts';
import { etaLabel, speedLabel, stepLabel } from '../lib/words.ts';

type Filter = 'hepsi' | Task['group'];

const KIND: Record<Task['kind'], { icon: IconName; label: string }> = {
  yayin: { icon: 'film', label: 'Yayın indirme' },
  'klip-indir': { icon: 'download', label: 'Kick klibi indirme' },
  video: { icon: 'vertical', label: 'Video hazırlama' },
  kayit: { icon: 'record', label: 'Canlı kayıt' },
  'hazir-video': { icon: 'sparkle', label: 'Paylaşıma hazır video' },
  model: { icon: 'download', label: 'Altyazı modeli indirme' },
  proje: { icon: 'scissors', label: 'Editör dışa aktarma' },
  kesit: { icon: 'bolt', label: 'Yayından kesit alma' },
};

/** Görev yöneticisi: bilgisayarın durumu, Kesit'in süreçleri ve süren işler. */
export function Tasks() {
  const { loaded, tasks, live } = tasksStore.use();
  const [filter, setFilter] = useState<Filter>('hepsi');

  useEffect(() => {
    void refreshTasks();
  }, []);
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
      <WorkspaceHead guide="gorevler" title="Görev" tape="yöneticisi" lead="Bilgisayarın işlemci, bellek ve disk durumu; Kesit'in çalıştırdığı işlemler ve süren işler." />

      <SystemPanel />

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

/** İşletim sistemi görev yöneticisi gibi: göstergeler + süreç listesi. */
function SystemPanel() {
  const { local } = useSession();
  const sys = useResource(() => api.get<SystemReport>('/api/system/monitor'));
  useInterval(() => void sys.reload(), 2500);
  const [killing, setKilling] = useState<number | null>(null);
  const d = sys.data;

  const kill = async (pid: number) => {
    setKilling(pid);
    try {
      await api.post('/api/system/kill', { pid });
      toast('İşlem sonlandırıldı', 'ok');
      await sys.reload();
    } catch (err) {
      toastError(err);
    } finally {
      setKilling(null);
    }
  };

  return (
    <section className="sys panel" aria-label="Sistem">
      <div className="sys-gauges">
        <Gauge icon="cpu" label="İşlemci" percent={d?.cpu.percent ?? null} note={d ? `${d.cpu.cores} çekirdek · yük ${d.cpu.load}` : ''} />
        <Gauge icon="memory" label="Bellek" percent={d?.memory.percent ?? null} note={d ? `${bytes(d.memory.used)} / ${bytes(d.memory.total)}` : ''} />
        <Gauge icon="disk" label="Disk" percent={d?.disk?.percent ?? null} note={d?.disk ? `${bytes(d.disk.free)} boş` : 'okunamadı'} />
        <div className="sys-kesit">
          <span className="eyebrow">Kesit</span>
          <b>{d ? bytes(d.kesit.memBytes) : '—'}</b>
          <span className="muted">
            {d ? `${Math.floor(d.kesit.uptimeSec / 3600)} sa ${Math.floor((d.kesit.uptimeSec % 3600) / 60)} dk açık · ${d.kesit.queue.running} işleniyor, ${d.kesit.queue.waiting} sırada` : 'okunuyor'}
          </span>
        </div>
      </div>
      <table className="sys-table">
        <thead>
          <tr>
            <th>İşlem</th>
            <th>Ne yapıyor</th>
            <th className="num">İşlemci</th>
            <th className="num">Bellek</th>
            <th className="num">Süre</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(d?.processes ?? []).map((p) => (
            <tr key={p.pid} className={p.self ? 'sys-self' : undefined}>
              <td>
                <b>{p.name}</b> <span className="muted">#{p.pid}</span>
              </td>
              <td>{p.label}</td>
              <td className="num">
                <span className="sys-bar" aria-hidden="true">
                  <i style={{ width: `${Math.min(100, p.cpu)}%` }} />
                </span>
                %{Math.round(p.cpu)}
              </td>
              <td className="num">{bytes(p.memBytes)}</td>
              <td className="num">{p.elapsed}</td>
              <td className="num">
                {!p.self && local && (
                  <button type="button" className="btn btn-quiet btn-small" disabled={killing === p.pid} onClick={() => void kill(p.pid)}>
                    {killing === p.pid ? <Spinner size={12} /> : 'Sonlandır'}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {d && d.processes.length <= 1 && (
            <tr>
              <td colSpan={6} className="muted">
                Şu an Kesit'in başlattığı başka işlem yok.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function Gauge({ icon, label, percent, note }: { icon: IconName; label: string; percent: number | null; note: string }) {
  const p = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const tone = p > 90 ? 'hot' : p > 70 ? 'warm' : 'cool';
  return (
    <div className={`gauge gauge-${tone}`}>
      <span className="gauge-head">
        <Icon name={icon} size={16} /> {label}
      </span>
      <b className="gauge-value">{percent === null ? '—' : `%${Math.round(p)}`}</b>
      <span className="gauge-bar" aria-hidden="true">
        <i style={{ width: `${p}%` }} />
      </span>
      <span className="gauge-note">{note}</span>
    </div>
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

  /** Sunucunun bildirdiği iptal ucuna gönderir (video, kesit, kayıt çıktısı, dışa aktarma…). */
  const cancelTask = async () => {
    if (!t.cancel) return;
    setBusy(true);
    try {
      await api.post(t.cancel);
      toast('İptal edildi', 'ok');
      await refreshTasks();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`task task-${t.group}`}>
      <span className={t.thumbUrl ? 'task-icon task-icon-img' : 'task-icon'}>{t.thumbUrl ? <img src={t.thumbUrl} alt="" loading="lazy" /> : <Icon name={KIND[t.kind].icon} size={18} />}</span>
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
        {t.kind !== 'yayin' && t.cancel && running && (
          <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void cancelTask()}>
            İptal
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
