import { useSyncExternalStore } from 'react';

export const SECTIONS = ['kutuphane', 'klipler', 'yayinlar', 'canli', 'nobet', 'kayitlar', 'paylasim', 'arsiv', 'marka', 'ayarlar'] as const;
export type Section = (typeof SECTIONS)[number];

const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  window.addEventListener('popstate', fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('popstate', fn);
  };
}

export function navigate(path: string, replace = false) {
  if (location.pathname + location.search === path) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  listeners.forEach((fn) => fn());
}

export interface Route {
  section: Section;
  /** Bölüm içi alt yol (ör. /yayinlar/12 → "12"). */
  sub: string | null;
}

function parse(path: string): Route {
  const [, first = '', second = null] = path.split('/');
  const section = (SECTIONS as readonly string[]).includes(first) ? (first as Section) : 'kutuphane';
  return { section, sub: second || null };
}

export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, () => location.pathname);
  return parse(path);
}

export function sectionPath(section: Section, sub?: string | number | null) {
  return section === 'kutuphane' && !sub ? '/' : `/${section}${sub ? `/${sub}` : ''}`;
}
