import { useSyncExternalStore } from 'react';
import { api } from './api.ts';

export interface User {
  id: number;
  kind: 'kick' | 'guest';
  username: string;
  avatarUrl: string | null;
  channelSlug: string | null;
  /** İlk kurulum sihirbazı tamamlandı mı (yeni kullanıcı için false). */
  onboardingDone?: boolean;
}

interface SessionState {
  ready: boolean;
  user: User | null;
  tabs: string[];
  /** Bu bilgisayardan mı açıldı (bilgisayar geneli ayarlar yalnız buradan değişir). */
  local: boolean;
  /** Yerel ağdaki eşlenmemiş cihaz: önce eşleme kodu girilmeli. */
  pairingRequired: boolean;
}

let state: SessionState = { ready: false, user: null, tabs: [], local: true, pairingRequired: false };
const listeners = new Set<() => void>();

function set(next: Partial<SessionState>) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

export async function loadSession() {
  const res = await api
    .get<{ user: User | null; local: boolean; pairingRequired: boolean }>('/api/session')
    .catch(() => ({ user: null, local: true, pairingRequired: false }));
  set({ ready: true, user: res.user, local: res.local, pairingRequired: res.pairingRequired });
  if (res.user) await loadChannels();
}

/** Kick hesabıyla giriş: kanal Kick'te bulunup hesaba bağlanır. */
/** Kurulum sihirbazı bitti: sunucuya yazar, oturumdaki kullanıcıyı günceller. */
export async function markOnboarded(done = true) {
  await api.put('/api/me/onboarding', { done });
  set({ user: state.user && { ...state.user, onboardingDone: done } });
}

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

/** Telefonu bilgisayarın gösterdiği 6 haneli kodla eşler. */
export async function pairDevice(code: string) {
  await api.post('/api/lan/pair', { code });
  await loadSession();
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
