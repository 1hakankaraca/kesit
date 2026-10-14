import { api } from './api.ts';
import { connectSocket } from './socket.ts';
import { createStore } from './store.ts';
import type { AutopilotStatus, LiveState, RecorderStatus, WatcherStatus } from './types.ts';

/** Canlı durum (klip takibi, kayıt, nöbet) — kabuk ve Canlı ekranı ortak okur. */
export const liveStore = createStore<LiveState | null>(null);

export async function refreshLive() {
  const next = await api.get<LiveState>('/api/live').catch(() => null);
  if (next) liveStore.set(next);
  return next;
}

let wired = false;
export function wireLiveEvents() {
  if (wired) return;
  wired = true;
  const s = connectSocket();
  const patch = (p: Partial<LiveState>) => liveStore.set((prev) => (prev ? { ...prev, ...p } : prev));
  s.on('autopilot:status', (autopilot: AutopilotStatus) => patch({ autopilot }));
  s.on('clipwatch:status', (watcher: WatcherStatus) => patch({ watcher }));
  s.on('recorder:status', (recorder: RecorderStatus) => patch({ recorder }));
  s.on('connect', () => void refreshLive());
}
