import { useEffect } from 'react';
import type { Section } from './router.ts';

interface Theme {
  g1: string;
  g2: string;
}

/** Her çalışma alanının kendi şerit gradyanı; geçiş CSS'te yumuşatılır. */
export const THEMES: Record<Section | 'gate', Theme> = {
  gate: { g1: '#f43f5e', g2: '#f97316' },
  anasayfa: { g1: '#f43f5e', g2: '#f97316' },
  canli: { g1: '#dc2626', g2: '#ea580c' },
  galeri: { g1: '#e11d48', g2: '#f59e0b' },
  klipler: { g1: '#7c3aed', g2: '#db2777' },
  yayinlar: { g1: '#2563eb', g2: '#0891b2' },
  nobet: { g1: '#4f46e5', g2: '#9333ea' },
  editor: { g1: '#0ea5e9', g2: '#6366f1' },
  gorevler: { g1: '#0f766e', g2: '#2563eb' },
  paylasim: { g1: '#16a34a', g2: '#0891b2' },
  arsiv: { g1: '#334155', g2: '#2563eb' },
  marka: { g1: '#b45309', g2: '#e11d48' },
  ayarlar: { g1: '#475569', g2: '#0d9488' },
  kurulum: { g1: '#7c3aed', g2: '#ec4899' },
};

export function useTheme(id: keyof typeof THEMES) {
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--g1', THEMES[id].g1);
    root.style.setProperty('--g2', THEMES[id].g2);
  }, [id]);
}
