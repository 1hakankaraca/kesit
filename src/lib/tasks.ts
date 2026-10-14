import { api } from './api.ts';
import { onEverySocket } from './socket.ts';
import { createStore } from './store.ts';

export interface Task {
  key: string;
  group: 'iniyor' | 'hazirlaniyor' | 'bitti' | 'hata';
  kind: 'yayin' | 'klip-indir' | 'video' | 'kayit' | 'hazir-video' | 'model' | 'proje';
  title: string;
  channel: string | null;
  step: string;
  progress: number | null;
  sizeBytes: number | null;
  error: string | null;
  at: string;
  link: { section: string; sub: number | string | null; label: string } | null;
  vodJobId?: number;
}

/** Yayın indirmesinin anlık hızı (yalnız socket ile gelir). */
export interface LiveDownload {
  progress: number | null;
  bytes: number | null;
  speedBps: number | null;
  startedAt: number;
}

interface TasksState {
  loaded: boolean;
  tasks: Task[];
  live: Record<number, LiveDownload>;
}

export const tasksStore = createStore<TasksState>({ loaded: false, tasks: [], live: {} });

let timer: ReturnType<typeof setTimeout> | null = null;

export async function refreshTasks() {
  const res = await api.get<{ tasks: Task[] }>('/api/tasks').catch(() => null);
  if (res) tasksStore.set((s) => ({ ...s, loaded: true, tasks: res.tasks }));
}

/** Olay yağmurunda listeyi yarım saniyede bir tazeler. */
function soon() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void refreshTasks();
  }, 500);
}

export const isActiveTask = (t: Task) => t.group === 'iniyor' || t.group === 'hazirlaniyor';

export function wireTaskEvents() {
  onEverySocket((s) => {
    s.on('vodscan:update', (e: { vodJobId: number; status: string; progress?: number; bytesDownloaded?: number; speedBps?: number }) => {
      if (e.status === 'processing') {
        tasksStore.set((st) => {
          const prev = st.live[e.vodJobId];
          return {
            ...st,
            live: {
              ...st.live,
              [e.vodJobId]: {
                progress: typeof e.progress === 'number' ? e.progress : (prev?.progress ?? null),
                bytes: e.bytesDownloaded ?? prev?.bytes ?? null,
                speedBps: e.speedBps ?? prev?.speedBps ?? null,
                startedAt: prev?.startedAt ?? Date.now(),
              },
            },
          };
        });
        // Yüzde canlı güncellenir; listeyi yalnız aşama değişince tazele.
        if (!tasksStore.get().tasks.some((t) => t.vodJobId === e.vodJobId && t.group === 'iniyor')) soon();
        return;
      }
      soon();
    });
    for (const ev of ['clipedit:update', 'recorder:final', 'recorder:status', 'recorder:finished', 'harvest:update', 'captions:download', 'recorder:segments', 'project:render']) {
      s.on(ev, soon);
    }
    s.on('connect', soon);
  });
}
