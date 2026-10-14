import { useSyncExternalStore } from 'react';
import { api } from './api.ts';

export interface User {
  id: number;
  kind: 'kick' | 'guest';
  username: string;
  avatarUrl: string | null;
  channelSlug: string | null;
}

interface SessionState {
  ready: boolean;
  user: User | null;
  /** Sunucuda Kick geliştirici uygulaması tanımlıysa OAuth, değilse kanal adıyla bağlama. */
  kickOAuth: boolean;
  tabs: string[];
}

let state: SessionState = { ready: false, user: null, kickOAuth: false, tabs: [] };
const listeners = new Set<() => void>();

function set(next: Partial<SessionState>) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

export async function loadSession() {
  const res = await api.get<{ user: User | null; kickOAuth: boolean }>('/api/session').catch(() => ({ user: null, kickOAuth: false }));
  set({ ready: true, user: res.user, kickOAuth: res.kickOAuth });
  if (res.user) await loadChannels();
}

/** Kick hesabını kanal adıyla bağlar (geliştirici uygulaması gerekmez). */
export async function linkKick(channel: string) {
  const res = await api.post<{ user: User }>('/auth/kick/link', { channel });
  set({ user: res.user });
  await loadChannels();
}

export async function loadChannels() {
  const res = await api.get<{ tabs: string[]; active: string | null }>('/api/me/channels').catch(() => null);
  if (res) set({ tabs: res.tabs, user: state.user && { ...state.user, channelSlug: res.active } });
}

/** Kanal sekmelerini ve etkin kanalı kaydeder. */
export async function saveChannels(tabs: string[], active: string | null) {
  const res = await api.put<{ tabs: string[]; active: string | null }>('/api/me/channels', { tabs, active });
  set({ tabs: res.tabs, user: state.user && { ...state.user, channelSlug: res.active } });
}

export async function enterAsGuest() {
  const res = await api.post<{ user: User }>('/auth/guest');
  set({ user: res.user, tabs: [] });
}

export async function logout() {
  await api.post('/auth/logout').catch(() => {});
  set({ user: null });
}


window.addEventListener('kesit:unauthorized', () => {
  if (state.user) set({ user: null });
});

export function useSession(): SessionState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}
