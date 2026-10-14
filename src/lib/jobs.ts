import { api } from './api.ts';
import type { Socket } from 'socket.io-client';
import { onEverySocket } from './socket.ts';
import { createStore } from './store.ts';
import type { Job, QueueStatus } from './types.ts';

interface JobsState {
  loaded: boolean;
  jobs: Job[];
  queue: QueueStatus | null;
  /** Socket'ten gelen anlık ilerleme yüzdesi (iş kimliğine göre). */
  progress: Record<number, number>;
}

export const jobsStore = createStore<JobsState>({ loaded: false, jobs: [], queue: null, progress: {} });

export async function refreshJobs() {
  const res = await api.get<{ jobs: Job[]; queue: QueueStatus }>('/api/jobs?limit=200');
  jobsStore.set((s) => ({ ...s, loaded: true, jobs: res.jobs, queue: res.queue }));
}

async function refreshJob(id: number) {
  const res = await api.get<{ job: Job }>(`/api/jobs/${id}`).catch(() => null);
  if (!res) return;
  jobsStore.set((s) => {
    const exists = s.jobs.some((j) => j.id === id);
    return { ...s, jobs: exists ? s.jobs.map((j) => (j.id === id ? res.job : j)) : [res.job, ...s.jobs] };
  });
}

export function removeJobsLocally(ids: number[]) {
  const set = new Set(ids);
  jobsStore.set((s) => ({ ...s, jobs: s.jobs.filter((j) => !set.has(j.id)) }));
}

/** Geri alınan silmede işi listeye geri koyar (sıra id'ye göre). */
export function restoreJobLocally(job: Job) {
  jobsStore.set((s) => ({ ...s, jobs: [...s.jobs.filter((j) => j.id !== job.id), job].sort((a, b) => b.id - a.id) }));
}

export const isActive = (j: Job) => j.status === 'queued' || j.status === 'processing';

export function wireJobEvents() {
  onEverySocket(attachJobEvents);
}

function attachJobEvents(s: Socket) {
  s.on('clipedit:update', (e: { jobId: number; status: Job['status']; step: string; progress?: number }) => {
    jobsStore.set((st) => ({
      ...st,
      jobs: st.jobs.map((j) => (j.id === e.jobId ? { ...j, status: e.status, step: e.step } : j)),
      progress: typeof e.progress === 'number' ? { ...st.progress, [e.jobId]: e.progress } : st.progress,
    }));
    const known = jobsStore.get().jobs.some((j) => j.id === e.jobId);
    // Biten iş için tüm liste tazelenir ki kuyruk sayacı da güncellensin.
    if (e.status === 'ready' || e.status === 'failed') void refreshJobs().catch(() => {});
    else if (!known) void refreshJob(e.jobId);
  });
  s.on('clipedit:published', (e: { jobId: number }) => void refreshJob(e.jobId));
  // Kayıttan kesit aktarımı: yeni işler Kütüphane'ye düşer.
  s.on('recorder:segments', () => void refreshJobs().catch(() => {}));
  s.on('connect', () => void refreshJobs().catch(() => {}));
}
