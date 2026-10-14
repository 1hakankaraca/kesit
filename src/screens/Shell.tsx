import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChannelSearch, type ChannelHit } from '../components/ChannelSearch.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Pill, Toasts, Wordmark } from '../components/basics.tsx';
import { TaskTray } from '../components/TaskTray.tsx';
import { isActive, jobsStore, refreshJobs, wireJobEvents } from '../lib/jobs.ts';
import { liveStore, refreshLive, wireLiveEvents } from '../lib/live.ts';
import { navigate, sectionPath, useRoute, type Section } from '../lib/router.ts';
import { logout, saveChannels, useSession } from '../lib/session.ts';
import { connectSocket, disconnectSocket } from '../lib/socket.ts';
import { useTheme } from '../lib/theme.ts';
import { toastError } from '../lib/toast.ts';
import { useInterval } from '../lib/useResource.ts';
import { Archive } from './Archive.tsx';
import { Clips } from './Clips.tsx';
import { Library } from './Library.tsx';
import { Live } from './Live.tsx';
import { Nobet } from './Nobet.tsx';
import { Settings, usePhoneUrl } from './Settings.tsx';
import { Publish } from './Publish.tsx';
import { Recordings } from './Recordings.tsx';
import { Studio } from './Studio.tsx';
import { Vods } from './Vods.tsx';

const NAV: { group: string; items: { id: Section; label: string; icon: IconName }[] }[] = [
  {
    group: 'Üret',
    items: [
      { id: 'kutuphane', label: 'Kütüphane', icon: 'library' },
      { id: 'klipler', label: 'Klipler', icon: 'scissors' },
      { id: 'yayinlar', label: 'Geçmiş yayınlar', icon: 'film' },
      { id: 'canli', label: 'Canlı', icon: 'live' },
      { id: 'nobet', label: 'Nöbet', icon: 'shield' },
      { id: 'kayitlar', label: 'Kayıtlar', icon: 'record' },
    ],
  },
  {
    group: 'Yayınla',
    items: [
      { id: 'paylasim', label: 'Paylaşım', icon: 'share' },
      { id: 'arsiv', label: 'Arşiv', icon: 'archive' },
    ],
  },
  {
    group: 'Ayarlar',
    items: [
      { id: 'marka', label: 'Marka ve şablon', icon: 'palette' },
      { id: 'ayarlar', label: 'Ayarlar', icon: 'key' },
    ],
  },
];

const TITLES: Record<Section, string> = {
  kutuphane: 'Kütüphane',
  klipler: 'Klipler',
  yayinlar: 'Geçmiş yayınlar',
  canli: 'Canlı',
  nobet: 'Nöbet',
  kayitlar: 'Kayıtlar',
  paylasim: 'Paylaşım',
  arsiv: 'Arşiv',
  marka: 'Marka ve şablon',
  ayarlar: 'Ayarlar',
};

/** Oturum açmış kullanıcının stüdyosu: üst şerit + sol ray + çalışma alanı. */
export function Shell() {
  const route = useRoute();
  useTheme(route.section);
  const live = liveStore.use();
  const { jobs } = jobsStore.use();
  const activeJobs = jobs.filter(isActive).length;

  useEffect(() => {
    connectSocket();
    wireJobEvents();
    wireLiveEvents();
    void refreshJobs().catch(() => {});
    void refreshLive();
    return () => disconnectSocket();
  }, []);

  useInterval(() => void refreshLive(), 30_000);
  // Socket kopsa bile süren işlerin durumu güncel kalsın.
  useInterval(() => void refreshJobs().catch(() => {}), activeJobs > 0 ? 6_000 : null);

  useEffect(() => {
    document.title = `${TITLES[route.section]} — Kesit`;
  }, [route.section]);

  const isLiveBusy = !!(live?.recorder.recording || live?.watcher.watching);

  return (
    <div className="shell">
      <header className="shell-top">
        <a
          href="/"
          className="shell-home"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
        >
          <Wordmark />
        </a>
        <ChannelTabs />
        <div className="shell-top-side">
          {live?.autopilot.config.enabled && (
            <button type="button" className="pill-button" onClick={() => navigate(sectionPath('nobet'))} title="Nöbet açık">
              <Pill tone={live.autopilot.live ? 'live' : 'on'}>{live.autopilot.live ? 'Nöbet: yayında' : `Nöbet: ${live.autopilot.config.channel}`}</Pill>
            </button>
          )}
          {live?.recorder.recording && (
            <button type="button" className="pill-button" onClick={() => navigate(sectionPath('canli'))}>
              <Pill tone="live">Kaydediliyor</Pill>
            </button>
          )}
          <UserMenu />
        </div>
      </header>

      <nav className="shell-rail" aria-label="Çalışma alanları">
        {NAV.map((g) => (
          <div key={g.group} className="rail-block">
            <p className="rail-group eyebrow">{g.group}</p>
            {g.items.map((item) => {
              const current = route.section === item.id;
              return (
                <a
                  key={item.id}
                  href={sectionPath(item.id)}
                  className="rail-item"
                  aria-current={current ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(sectionPath(item.id));
                  }}
                >
                  {current && <motion.span layoutId="rail-thumb" className="rail-thumb" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                  <span className="rail-icon">
                    <Icon name={item.icon} size={16} />
                  </span>
                  <span className="rail-label">{item.label}</span>
                  {item.id === 'kutuphane' && activeJobs > 0 && <span className="rail-count">{activeJobs}</span>}
                  {item.id === 'canli' && isLiveBusy && <span className="rail-live" aria-label="Canlı işlem sürüyor" />}
                  {item.id === 'nobet' && live?.autopilot.config.enabled && <span className="rail-live rail-live-calm" aria-label="Nöbet açık" />}
                </a>
              );
            })}
          </div>
        ))}
        <RailFoot />
      </nav>

      <main className="shell-main" id="main">
        <AnimatePresence mode="wait">
          <motion.div key={route.section} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }}>
            <SectionView section={route.section} sub={route.sub} />
          </motion.div>
        </AnimatePresence>
      </main>

      <TaskTray />
      <Toasts />
    </div>
  );
}

function SectionView({ section, sub }: { section: Section; sub: string | null }): ReactNode {
  switch (section) {
    case 'klipler':
      return <Clips />;
    case 'yayinlar':
      return <Vods openId={sub ? Number(sub) : null} />;
    case 'canli':
      return <Live />;
    case 'nobet':
      return <Nobet />;
    case 'ayarlar':
      return <Settings />;
    case 'kayitlar':
      return <Recordings openId={sub ? Number(sub) : null} />;
    case 'paylasim':
      return <Publish />;
    case 'arsiv':
      return <Archive />;
    case 'marka':
      return <Studio />;
    default:
      return <Library focusId={sub ? Number(sub) : null} />;
  }
}

/**
 * Kanal sekmeleri: her sekme bir yayıncı. Etkin sekme tarama, kayıt ve
 * nöbetin varsayılan kanalıdır. "+" ile Kick'te arayıp yeni sekme açılır.
 */
function ChannelTabs() {
  const { user, tabs } = useSession();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<ChannelHit | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const active = user?.channelSlug ?? null;
  useOutside(ref, () => tabs.length > 0 && (setAdding(false), setPending(null)), adding);

  const save = async (next: string[], nextActive: string | null) => {
    try {
      await saveChannels(next, nextActive);
    } catch (err) {
      toastError(err);
    }
  };

  const add = async () => {
    if (!pending) return;
    await save([...tabs.filter((t) => t !== pending.slug), pending.slug], pending.slug);
    setPending(null);
    setAdding(false);
  };

  const close = (slug: string) => {
    const rest = tabs.filter((t) => t !== slug);
    void save(rest, active === slug ? (rest[rest.length - 1] ?? null) : active);
  };

  return (
    <div className="ctabs" ref={ref}>
      <div className="ctabs-list" role="tablist" aria-label="Kanallar">
        {tabs.map((slug) => (
          <div key={slug} className={slug === active ? 'ctab ctab-on' : 'ctab'} role="presentation">
            <button type="button" role="tab" aria-selected={slug === active} className="ctab-main" onClick={() => slug !== active && void save(tabs, slug)}>
              {slug === active && <motion.span layoutId="ctab-thumb" className="ctab-thumb" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
              <span className="ctab-label">{slug}</span>
            </button>
            <button type="button" className="ctab-close" onClick={() => close(slug)} aria-label={`${slug} sekmesini kapat`}>
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
        <button type="button" className="ctab-add" onClick={() => setAdding((a) => !a)} aria-label="Yeni yayıncı sekmesi" title="Yeni yayıncı">
          <Icon name="plus" size={16} />
          {tabs.length === 0 && <span>Kanal seç</span>}
        </button>
      </div>
      <AnimatePresence>
        {adding && (
          <motion.div className="menu ctabs-menu" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <p className="menu-note">Kick kanalı ara, seç ve kaydet. Her kanal ayrı bir sekme olur; tarama, kayıt ve nöbet etkin sekmeyi kullanır.</p>
            {pending ? (
              <div className="ctabs-pending">
                {pending.avatarUrl ? <img src={pending.avatarUrl} alt="" /> : <span className="csearch-avatar" />}
                <b>{pending.username}</b>
                <button type="button" className="btn btn-quiet btn-small" onClick={() => setPending(null)}>
                  Değiştir
                </button>
                <button type="button" className="btn btn-accent btn-small" onClick={() => void add()}>
                  Kaydet
                </button>
              </div>
            ) : (
              <ChannelSearch autoFocus onPick={setPending} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Ray altı: telefondan açma notu. */
function RailFoot() {
  const url = usePhoneUrl();
  return (
    <div className="rail-foot">
      {url && (
        <p className="rail-phone">
          <Icon name="phone" size={14} />
          <span>
            Telefondan aç (aynı Wi-Fi)
            <b>{url.replace(/^https?:\/\//, '')}</b>
          </span>
        </p>
      )}
      <p>
        powered by <b>livorass</b>
      </p>
    </div>
  );
}

function UserMenu() {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  if (!user) return null;
  return (
    <div ref={ref} className="who-wrap">
      <button type="button" className="who" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {user.avatarUrl ? <img className="who-img" src={user.avatarUrl} alt="" /> : <span className="who-img who-initial">{user.username[0]}</span>}
        <span className="who-text">
          <span className="who-name">{user.username}</span>
          <span className="who-kind">{user.kind === 'kick' ? 'Kick hesabı' : 'Misafir'}</span>
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="menu" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            {user.kind === 'guest' && <p className="menu-note">Misafir oturumu bu tarayıcıya bağlı. Çıkış yaparsan bu çalışmalara geri dönemezsin; dosyalar bilgisayarda kalır.</p>}
            <button type="button" className="menu-item" onClick={() => navigate(sectionPath('marka'))}>
              <Icon name="palette" size={16} /> Marka ve şablon
            </button>
            <button type="button" className="menu-item" onClick={() => navigate(sectionPath('paylasim'))}>
              <Icon name="share" size={16} /> Zernio bağlantısı
            </button>
            <button type="button" className="menu-item" onClick={() => navigate(sectionPath('ayarlar'))}>
              <Icon name="key" size={16} /> Ayarlar
            </button>
            <button type="button" className="menu-item" onClick={() => void logout()}>
              <Icon name="logout" size={16} /> Çıkış yap
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function useOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onOutside, active]);
}
