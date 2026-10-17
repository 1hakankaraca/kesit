import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChannelSearch, type ChannelHit } from '../components/ChannelSearch.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Pill, Toasts, Wordmark } from '../components/basics.tsx';
import { isActive, jobsStore, refreshJobs, wireJobEvents } from '../lib/jobs.ts';
import { liveStore, refreshLive, wireLiveEvents } from '../lib/live.ts';
import { isActiveTask, refreshTasks, tasksStore, wireTaskEvents } from '../lib/tasks.ts';
import { navigate, sectionPath, useRoute, type Section } from '../lib/router.ts';
import { logout, saveChannels, useSession } from '../lib/session.ts';
import { connectSocket, disconnectSocket } from '../lib/socket.ts';
import { useTheme } from '../lib/theme.ts';
import { toast, toastError } from '../lib/toast.ts';
import { useInterval, useResource } from '../lib/useResource.ts';
import { api } from '../lib/api.ts';
import { Archive } from './Archive.tsx';
import { Clips } from './Clips.tsx';
import { Editor } from '../editor/Editor.tsx';
import { Gallery } from './Gallery.tsx';
import { Home } from './Home.tsx';
import { Kesitler } from './Kesitler.tsx';
import { Live } from './Live.tsx';
import { Nobet } from './Nobet.tsx';
import { Onboarding } from './Onboarding.tsx';
import { Settings, usePhoneUrl } from './Settings.tsx';
import { Publish } from './Publish.tsx';
import { Studio } from './Studio.tsx';
import { Tasks } from './Tasks.tsx';
import { Vods } from './Vods.tsx';

const NAV: { group: string; items: { id: Section; label: string; icon: IconName }[] }[] = [
  {
    group: 'Stüdyo',
    items: [
      { id: 'anasayfa', label: 'Anasayfa', icon: 'home' },
      { id: 'canli', label: 'Canlı yayın', icon: 'live' },
      { id: 'kesitler', label: 'Kesitler', icon: 'bolt' },
      { id: 'galeri', label: 'Galeri', icon: 'library' },
      { id: 'klipler', label: 'Dikey klipler', icon: 'vertical' },
      { id: 'yayinlar', label: 'Yayın geçmişleri', icon: 'film' },
      { id: 'nobet', label: 'Çevrimdışı bot takip', icon: 'shield' },
      { id: 'editor', label: 'Editör', icon: 'scissors' },
      { id: 'gorevler', label: 'Görev yöneticisi', icon: 'clock' },
    ],
  },
  {
    group: 'Paylaş',
    items: [
      { id: 'paylasim', label: 'Paylaşım', icon: 'share' },
      { id: 'arsiv', label: 'Arşiv', icon: 'archive' },
    ],
  },
  {
    group: 'Ayarlar',
    items: [
      { id: 'marka', label: 'Logo ve görünüm', icon: 'palette' },
      { id: 'ayarlar', label: 'Ayarlar', icon: 'key' },
    ],
  },
];

const TITLES: Record<Section, string> = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.id, i.label]))) as Record<Section, string>;

const RAIL_KEY = 'kesit.solMenu';
const RAIL_MIN = 180;
const RAIL_MAX = 340;
const RAIL_COLLAPSED = 72;

/** Sol menünün genişliği ve daraltılmış hali tarayıcıda hatırlanır. */
function useRailSize() {
  const [state, setState] = useState<{ width: number; collapsed: boolean }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(RAIL_KEY) || '{}');
      return { width: Math.min(RAIL_MAX, Math.max(RAIL_MIN, Number(saved.width) || 232)), collapsed: saved.collapsed === true };
    } catch {
      return { width: 232, collapsed: false };
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, JSON.stringify(state));
    } catch {
      /* depolama kapalı */
    }
  }, [state]);
  return [state, setState] as const;
}

/** Oturum açmış kullanıcının stüdyosu: üst şerit + sol ray + çalışma alanı. */
export function Shell() {
  const route = useRoute();
  useTheme(route.section);
  const live = liveStore.use();
  const { jobs } = jobsStore.use();
  const { tasks } = tasksStore.use();
  const activeJobs = jobs.filter(isActive).length;
  const activeTasks = tasks.filter(isActiveTask).length;
  const [rail, setRail] = useRailSize();

  useEffect(() => {
    connectSocket();
    wireJobEvents();
    wireLiveEvents();
    wireTaskEvents();
    void refreshJobs().catch(() => {});
    void refreshLive();
    void refreshTasks();
    return () => disconnectSocket();
  }, []);

  // Sürükleyerek genişlik ayarı (sol menünün sağ kenarı).
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rail.collapsed ? RAIL_COLLAPSED : rail.width;
    const move = (ev: PointerEvent) => {
      const w = startW + ev.clientX - startX;
      setRail(w < RAIL_MIN - 40 ? { width: rail.width, collapsed: true } : { width: Math.min(RAIL_MAX, Math.max(RAIL_MIN, w)), collapsed: false });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  useInterval(() => void refreshLive(), 30_000);
  // Socket kopsa bile süren işlerin durumu güncel kalsın.
  useInterval(() => void refreshJobs().catch(() => {}), activeJobs > 0 ? 6_000 : null);
  useInterval(() => void refreshTasks(), activeTasks > 0 ? 8_000 : null);

  useEffect(() => {
    document.title = `${TITLES[route.section] ?? 'Kurulum'} — Kesit`;
  }, [route.section]);

  // Yeni kullanıcı: ilk kurulum sihirbazı bitene kadar başka bölüm açılmaz.
  const { user } = useSession();
  const needsSetup = !!user && !user.onboardingDone;
  useEffect(() => {
    if (needsSetup && route.section !== 'kurulum') navigate(sectionPath('kurulum'), true);
  }, [needsSetup, route.section]);

  if (route.section === 'kurulum') {
    return (
      <div className="onb-shell">
        <Onboarding />
        <Toasts />
      </div>
    );
  }

  const isLiveBusy = !!(live?.recorder.recording || live?.watcher.watching);

  return (
    <div className={rail.collapsed ? 'shell shell-collapsed' : 'shell'} style={{ '--rail-w': `${rail.collapsed ? RAIL_COLLAPSED : rail.width}px` } as React.CSSProperties}>
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
            <button type="button" className="pill-button" onClick={() => navigate(sectionPath('nobet'))} title="Çevrimdışı bot takip açık">
              <Pill tone={live.autopilot.live ? 'live' : 'on'}>{live.autopilot.live ? 'Bot: yayında' : `Bot: ${live.autopilot.config.channel}`}</Pill>
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

      <nav className="shell-rail" aria-label="Bölümler">
        <button
          type="button"
          className="rail-toggle"
          onClick={() => setRail((r) => ({ ...r, collapsed: !r.collapsed }))}
          aria-label={rail.collapsed ? 'Menüyü genişlet' : 'Menüyü daralt'}
          title={rail.collapsed ? 'Menüyü genişlet' : 'Menüyü daralt'}
        >
          <Icon name="chevron" size={14} className={rail.collapsed ? '' : 'rail-toggle-open'} />
        </button>
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
                  title={rail.collapsed ? item.label : undefined}
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
                  {item.id === 'gorevler' && activeTasks > 0 && <span className="rail-count rail-count-live">{activeTasks}</span>}
                  {item.id === 'canli' && isLiveBusy && <span className="rail-live" aria-label="Canlı işlem sürüyor" />}
                  {item.id === 'nobet' && live?.autopilot.config.enabled && <span className="rail-live rail-live-calm" aria-label="Çevrimdışı bot takip açık" />}
                </a>
              );
            })}
          </div>
        ))}
        <RailFoot />
        <span className="rail-resize" onPointerDown={startResize} aria-hidden="true" title="Sürükleyerek genişlet" />
      </nav>

      <main className={route.section === 'editor' && route.sub ? 'shell-main shell-main-editor' : 'shell-main'} id="main">
        <AnimatePresence mode="wait">
          <motion.div key={route.section === 'editor' ? `editor-${route.sub ?? ''}` : route.section} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }}>
            <SectionView section={route.section} sub={route.sub} />
          </motion.div>
        </AnimatePresence>
      </main>

      <Toasts />
    </div>
  );
}

function SectionView({ section, sub }: { section: Section; sub: string | null }): ReactNode {
  switch (section) {
    case 'galeri':
      return <Gallery focus={sub} />;
    case 'editor':
      return <Editor projectId={sub ? Number(sub) : null} />;
    case 'klipler':
      return <Clips />;
    case 'yayinlar':
      return <Vods openId={sub ? Number(sub) : null} />;
    case 'canli':
      return <Live />;
    case 'kesitler':
      return <Kesitler />;
    case 'nobet':
      return <Nobet />;
    case 'ayarlar':
      return <Settings />;
    case 'gorevler':
      return <Tasks />;
    case 'paylasim':
      return <Publish />;
    case 'arsiv':
      return <Archive />;
    case 'marka':
      return <Studio />;
    case 'kurulum':
      return <Onboarding />;
    default:
      return <Home />;
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
    const prevTabs = tabs;
    const prevActive = active;
    void save(rest, active === slug ? (rest[rest.length - 1] ?? null) : active);
    toast(`${slug} sekmesi kapatıldı`, 'info', { label: 'Geri al', run: () => void save(prevTabs, prevActive) }, 6000);
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
            <p className="menu-note">Kick kanalı ara, seç ve kaydet. Her kanal ayrı bir sekme olur; videolar, yayınlar ve kayıtlar seçili sekmenin kanalına göre listelenir.</p>
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

/** Ray altı: telefondan erişim durumu (yalnız bu bilgisayarda gösterilir). */
function RailFoot() {
  const { local } = useSession();
  const url = usePhoneUrl();
  const lan = useResource(() => (local ? api.get<{ enabled: boolean }>('/api/lan') : Promise.resolve(null)), [local]);
  useEffect(() => {
    const reload = () => void lan.reload();
    window.addEventListener('kesit:lan', reload);
    return () => window.removeEventListener('kesit:lan', reload);
  }, [lan.reload]);
  return (
    <div className="rail-foot">
      {local && lan.data && (
        <button type="button" className="rail-phone" onClick={() => navigate(sectionPath('ayarlar'))}>
          <Icon name="phone" size={14} />
          <span>
            {lan.data.enabled ? 'Telefondan erişim açık' : 'Telefondan erişim kapalı'}
            {lan.data.enabled && url ? <b>{url.replace(/^https?:\/\//, '')}</b> : <small>Ayarlar'dan aç</small>}
          </span>
        </button>
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
              <Icon name="palette" size={16} /> Logo ve görünüm
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
