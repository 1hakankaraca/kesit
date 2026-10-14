import { api } from './api.ts';
import type { Socket } from 'socket.io-client';
import { onEverySocket } from './socket.ts';
import { createStore } from './store.ts';
import type { AutopilotStatus, LiveState, RecorderStatus, WatcherStatus } from './types.ts';

/** Canlı durum (klip takibi, kayıt, nöbet) — kabuk ve Canlı ekranı ortak okur. */
export const liveStore = createStore<LiveState | null>(null);

export async function refreshLive() {
  const next = await api.get<LiveState>('/api/live').catch(() => null);
  if (next) liveStore.set(next);
  return next;
}

export function wireLiveEvents() {
  onEverySocket(attachLiveEvents);
}

function attachLiveEvents(s: Socket) {
  const patch = (p: Partial<LiveState>) => liveStore.set((prev) => (prev ? { ...prev, ...p } : prev));
  s.on('autopilot:status', (autopilot: AutopilotStatus) => patch({ autopilot }));
  s.on('clipwatch:status', (watcher: WatcherStatus) => patch({ watcher }));
  s.on('recorder:status', (recorder: RecorderStatus) => patch({ recorder }));
  // Yakalanan klip akışı ve sayaç anında güncellensin (motor yakalamada durum yayınlamaz).
  s.on('clipwatch:detected', () => void refreshLive());
  s.on('connect', () => void refreshLive());
}
