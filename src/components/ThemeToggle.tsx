import { THEME_LABELS, setThemePref, themeStore, type ThemePref } from '../lib/theme.ts';
import { openMenuAt } from './ContextMenu.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { Segmented } from './basics.tsx';

const ICONS: Record<ThemePref, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };
const ORDER: ThemePref[] = ['system', 'light', 'dark'];

/** Üst çubukta: tek tıkla açık / koyu / sistem. */
export function ThemeToggle() {
  const pref = themeStore.use();
  return (
    <button
      type="button"
      className="btn btn-quiet btn-icon theme-toggle"
      aria-label={`Tema: ${THEME_LABELS[pref]}`}
      title={`Tema: ${THEME_LABELS[pref]}`}
      onClick={(e) =>
        openMenuAt(
          e.currentTarget,
          ORDER.map((p) => ({ label: THEME_LABELS[p], icon: ICONS[p], hint: pref === p ? '✓' : undefined, onSelect: () => setThemePref(p) })),
          'Görünüm',
        )
      }
    >
      <Icon name={ICONS[pref]} size={17} />
    </button>
  );
}

/** Ayarlar'da: aynı seçim, segment olarak. */
export function ThemeSegmented() {
  const pref = themeStore.use();
  return <Segmented label="Tema" value={pref} onChange={setThemePref} options={ORDER.map((p) => ({ value: p, label: THEME_LABELS[p] }))} />;
}
