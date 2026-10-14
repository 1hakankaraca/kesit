import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Pill, Toasts, Wordmark } from '../components/basics.tsx';
import { TaskTray } from '../components/TaskTray.tsx';
import { isActive, jobsStore, refreshJobs, wireJobEvents } from '../lib/jobs.ts';
import { liveStore, refreshLive, wireLiveEvents } from '../lib/live.ts';
import { navigate, sectionPath, useRoute, type Section } from '../lib/router.ts';
import { logout, setChannel, useSession } from '../lib/session.ts';
import { connectSocket, disconnectSocket } from '../lib/socket.ts';
import { useTheme } from '../lib/theme.ts';
import { toastError } from '../lib/toast.ts';
import { useInterval } from '../lib/useResource.ts';
import { Archive } from './Archive.tsx';
import { Clips } from './Clips.tsx';
import { Library } from './Library.tsx';
import { Live } from './Live.tsx';
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
  { group: 'Ayarlar', items: [{ id: 'marka', label: 'Marka ve şablon', icon: 'palette' }] },
];

const TITLES: Record<Section, string> = {
  kutuphane: 'Kütüphane',
  klipler: 'Klipler',
  yayinlar: 'Geçmiş yayınlar',
  canli: 'Canlı',
  kayitlar: 'Kayıtlar',
  paylasim: 'Paylaşım',
  arsiv: 'Arşiv',
  marka: 'Marka ve şablon',
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
        <ChannelChip />
        <div className="shell-top-side">
          {live?.autopilot.config.enabled && (
            <button type="button" className="pill-button" onClick={() => navigate(sectionPath('canli'))} title="Nöbetçi açık">
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
                </a>
              );
            })}
          </div>
        ))}
        <p className="rail-foot">
          powered by <b>livorass</b>
        </p>
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

/** Çalışılan kanal: tarama, kayıt ve nöbetin varsayılanı. */
function ChannelChip() {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(user?.channelSlug ?? '');
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => setValue(user?.channelSlug ?? ''), [user?.channelSlug]);
  useOutside(ref, () => setOpen(false), open);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await setChannel(value.trim() || null);
      setOpen(false);
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <form ref={ref} className="channel-chip-wrap" onSubmit={submit}>
      <button type="button" className={user?.channelSlug ? 'channel-chip' : 'channel-chip channel-chip-empty'} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="eyebrow">Kanal</span>
        <b>{user?.channelSlug ?? 'Seç'}</b>
        <Icon name="chevron" size={14} className="channel-chip-caret" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="menu channel-menu" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <p className="menu-note">Klip tarama, yayın listesi ve kayıt bu kanalı varsayılan alır. Başka bir yayıncıyı da takip edebilirsin.</p>
            <div className="inline-form">
              <input className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="kick.com/kanal ya da kanal adı" aria-label="Kanal adı" autoFocus />
              <button type="submit" className="btn btn-primary btn-small">
                Kaydet
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
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
            {user.kind === 'guest' && <p className="menu-note">Misafir oturumu bu tarayıcıya bağlı. Çıkış yaparsan bu çalışmalara geri dönemezsin.</p>}
            <button type="button" className="menu-item" onClick={() => navigate(sectionPath('marka'))}>
              <Icon name="palette" size={16} /> Marka ve şablon
            </button>
            <button type="button" className="menu-item" onClick={() => navigate(sectionPath('paylasim'))}>
              <Icon name="key" size={16} /> Zernio bağlantısı
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
