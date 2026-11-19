import { createStore } from './store.ts';

/**
 * Açık / koyu tema. "Sistem" bilgisayarın ayarını izler (CSS'teki
 * prefers-color-scheme); "Açık" ve "Koyu" html[data-theme] ile sabitlenir.
 * Seçim bu tarayıcıda saklanır; index.html'deki küçük betik ilk boyamadan
 * önce uygular ki açılışta yanlış tema yanıp sönmesin.
 */
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'kesit.tema';

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export const themeStore = createStore<ThemePref>(read());

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

export function setThemePref(pref: ThemePref) {
  themeStore.set(pref);
  apply(pref);
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* depolama kapalı — yalnız bu oturum */
  }
}

/** Şu an gerçekte görünen tema (sistem seçiliyse bilgisayarınki). */
export function effectiveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export const THEME_LABELS: Record<ThemePref, string> = { system: 'Sistem', light: 'Açık', dark: 'Koyu' };
