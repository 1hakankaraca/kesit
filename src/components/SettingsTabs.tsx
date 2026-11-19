import { navigate, sectionPath, type Section } from '../lib/router.ts';

/**
 * Tüm ayarlar tek yerde: eskiden "Logo ve görünüm" ile "Ayarlar" iki ayrı
 * menü öğesiydi, Zernio bağlantısı da Paylaşım sayfasındaydı. Artık hepsi
 * Ayarlar'ın sekmeleri; eski adresler (/marka…) aynen çalışır.
 */
export type SettingsTabId = 'video' | 'abone' | 'baglantilar' | 'bilgisayar';

const TABS: { id: SettingsTabId; label: string; section: Section; sub: string | null; hint: string }[] = [
  { id: 'video', label: 'Video ve marka', section: 'marka', sub: null, hint: 'Logo, renkler, altyazı stili, dikey/yatay üretim kuralları, açılış-kapanış' },
  { id: 'abone', label: 'Abone çağrısı', section: 'marka', sub: 'abone', hint: 'Abone ol animasyonu ve abone kesiti' },
  { id: 'baglantilar', label: 'Hesaplar ve servisler', section: 'ayarlar', sub: null, hint: 'Kick, Zernio, Claude, altyazı motoru' },
  { id: 'bilgisayar', label: 'Bilgisayar', section: 'ayarlar', sub: 'bilgisayar', hint: 'Kayıt klasörü, disk, telefondan erişim' },
];

export function SettingsTabs({ current }: { current: SettingsTabId }) {
  return (
    <nav className="settings-tabs" aria-label="Ayar bölümleri">
      {TABS.map((t) => (
        <a
          key={t.id}
          href={sectionPath(t.section, t.sub)}
          className="settings-tab"
          aria-current={t.id === current ? 'page' : undefined}
          title={t.hint}
          onClick={(e) => {
            e.preventDefault();
            navigate(sectionPath(t.section, t.sub));
          }}
        >
          {t.label}
        </a>
      ))}
    </nav>
  );
}
