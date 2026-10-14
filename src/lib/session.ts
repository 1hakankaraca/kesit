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
  kickLogin: boolean;
}

let state: SessionState = { ready: false, user: null, kickLogin: false };
const listeners = new Set<() => void>();

function set(next: Partial<SessionState>) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

export async function loadSession() {
  const res = await api.get<{ user: User | null; kickLogin: boolean }>('/api/session').catch(() => ({ user: null, kickLogin: false }));
  set({ ready: true, user: res.user, kickLogin: res.kickLogin });
}

export async function enterAsGuest() {
  const res = await api.post<{ user: User }>('/auth/guest');
  set({ user: res.user });
}

export async function logout() {
  await api.post('/auth/logout').catch(() => {});
  set({ user: null });
}

export async function setChannel(channel: string | null) {
  const res = await api.put<{ user: User }>('/api/me/channel', { channel });
  set({ user: res.user });
  return res.user;
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
