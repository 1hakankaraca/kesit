import { useEffect } from 'react';
import type { Section } from './router.ts';

interface Theme {
  g1: string;
  g2: string;
}

/** Her çalışma alanının kendi şerit gradyanı; geçiş CSS'te yumuşatılır. */
export const THEMES: Record<Section | 'gate', Theme> = {
  gate: { g1: '#f43f5e', g2: '#f97316' },
  kutuphane: { g1: '#f43f5e', g2: '#f97316' },
  klipler: { g1: '#7c3aed', g2: '#db2777' },
  yayinlar: { g1: '#2563eb', g2: '#0891b2' },
  canli: { g1: '#dc2626', g2: '#ea580c' },
  nobet: { g1: '#4f46e5', g2: '#9333ea' },
  kayitlar: { g1: '#0d9488', g2: '#65a30d' },
  gorevler: { g1: '#0f766e', g2: '#2563eb' },
  paylasim: { g1: '#16a34a', g2: '#0891b2' },
  arsiv: { g1: '#334155', g2: '#2563eb' },
  marka: { g1: '#b45309', g2: '#e11d48' },
  ayarlar: { g1: '#475569', g2: '#0d9488' },
};

export function useTheme(id: keyof typeof THEMES) {
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--g1', THEMES[id].g1);
    root.style.setProperty('--g2', THEMES[id].g2);
  }, [id]);
}
