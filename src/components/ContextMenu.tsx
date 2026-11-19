import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createStore } from '../lib/store.ts';
import { Icon, type IconName } from './Icon.tsx';

/**
 * Uygulama geneli sağ tık menüsü. Herhangi bir yerden:
 *
 *   onContextMenu={(e) => openMenu(e, [{ label: 'Sil', icon: 'trash', danger: true, onSelect: … }])}
 *
 * Tek bir menü açık olur; dışarı tıklamak, Esc, kaydırma ya da pencere
 * boyutu değişimi kapatır. Ok tuşları, Enter ve sağ/sol ok (alt menü) çalışır.
 */
export interface MenuItem {
  label?: string;
  icon?: IconName;
  /** Sağda soluk yazı (ör. kısayol). */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Ayırıcı çizgi (diğer alanlar yok sayılır). */
  separator?: boolean;
  onSelect?: () => void;
  submenu?: MenuItem[];
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  title?: string;
}

const menuStore = createStore<MenuState | null>(null);

/** Menüyü fare konumunda açar; tarayıcının kendi menüsünü bastırır. */
export function openMenu(e: ReactMouseEvent | MouseEvent, items: (MenuItem | false | null | undefined)[], title?: string) {
  e.preventDefault();
  e.stopPropagation();
  const clean = items.filter(Boolean) as MenuItem[];
  if (!clean.some((i) => !i.separator)) return;
  menuStore.set({ x: e.clientX, y: e.clientY, items: clean, title });
}

/** Bir düğmenin altında açar (ör. "⋯" düğmesi). */
export function openMenuAt(el: HTMLElement, items: (MenuItem | false | null | undefined)[], title?: string) {
  const r = el.getBoundingClientRect();
  const clean = items.filter(Boolean) as MenuItem[];
  menuStore.set({ x: r.left, y: r.bottom + 4, items: clean, title });
}

export function closeMenu() {
  menuStore.set(null);
}

export function ContextMenuHost() {
  const menu = menuStore.use();
  useEffect(() => {
    if (!menu) return;
    const openedAt = performance.now();
    const close = () => closeMenu();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    // Açılıştan hemen sonra gelen kaydırma (ör. tarayıcının öğeyi görünür
    // kılması) menüyü kapatmasın; menünün kendi içindeki kaydırma da.
    const onScroll = (e: Event) => {
      if (performance.now() - openedAt < 250) return;
      if (e.target instanceof Node && (e.target as Element).closest?.('.ctx-menu')) return;
      close();
    };
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [menu]);
  return (
    <AnimatePresence>
      {menu && (
        <div
          className="ctx-layer"
          onMouseDown={(e) => e.target === e.currentTarget && closeMenu()}
          onContextMenu={(e) => {
            e.preventDefault();
            closeMenu();
          }}
        >
          <MenuList key={`${menu.x}:${menu.y}`} x={menu.x} y={menu.y} items={menu.items} title={menu.title} autoFocus />
        </div>
      )}
    </AnimatePresence>
  );
}

function MenuList({ x, y, items, title, autoFocus, onBack, flipFrom }: { x: number; y: number; items: MenuItem[]; title?: string; autoFocus?: boolean; onBack?: () => void; flipFrom?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; x: number; y: number; left: number } | null>(null);

  // Ekrana sığdır: sağa taşarsa sola, alta taşarsa yukarı aç.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 8) nx = flipFrom !== undefined ? flipFrom - r.width : window.innerWidth - r.width - 8;
    if (ny + r.height > window.innerHeight - 8) ny = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny) });
  }, [x, y, flipFrom]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const enabled = items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);

  const openSub = (i: number) => {
    const row = ref.current?.querySelectorAll<HTMLElement>('[data-row]')[i];
    if (!row) return;
    const r = row.getBoundingClientRect();
    setSub({ index: i, x: r.right - 4, y: r.top - 6, left: r.left + 4 });
  };

  const choose = (it: MenuItem, i: number) => {
    if (it.disabled || it.separator) return;
    if (it.submenu) {
      openSub(i);
      return;
    }
    closeMenu();
    it.onSelect?.();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (sub) return;
    const at = enabled.indexOf(active);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(enabled[(at + 1) % enabled.length]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(enabled[(at - 1 + enabled.length) % enabled.length]);
    } else if ((e.key === 'Enter' || e.key === ' ') && active >= 0) {
      e.preventDefault();
      choose(items[active], active);
    } else if (e.key === 'ArrowRight' && active >= 0 && items[active].submenu) {
      e.preventDefault();
      openSub(active);
    } else if (e.key === 'ArrowLeft' && onBack) {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    }
  };

  return (
    <>
      <motion.div
        ref={ref}
        className="ctx-menu"
        role="menu"
        tabIndex={-1}
        style={{ left: pos.x, top: pos.y }}
        initial={{ opacity: 0, scale: 0.96, y: -4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.08 } }}
        transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
        onKeyDown={onKey}
        onContextMenu={(e) => e.preventDefault()}
      >
        {title && <div className="ctx-title">{title}</div>}
        {items.map((it, i) =>
          it.separator ? (
            <div key={`s${i}`} className="ctx-sep" role="separator" />
          ) : (
            <button
              key={`${i}${it.label}`}
              type="button"
              role="menuitem"
              data-row
              className={['ctx-item', it.danger && 'ctx-danger', active === i && 'ctx-active'].filter(Boolean).join(' ')}
              disabled={it.disabled}
              aria-haspopup={it.submenu ? 'menu' : undefined}
              onMouseEnter={() => {
                setActive(i);
                if (it.submenu) openSub(i);
                else setSub(null);
              }}
              onClick={() => choose(it, i)}
            >
              <span className="ctx-icon">{it.icon && <Icon name={it.icon} size={15} />}</span>
              <span className="ctx-label">{it.label}</span>
              {it.hint && <span className="ctx-hint">{it.hint}</span>}
              {it.submenu && <span className="ctx-caret">›</span>}
            </button>
          ),
        )}
      </motion.div>
      {sub && items[sub.index]?.submenu && (
        <MenuList
          key={`sub${sub.index}`}
          x={sub.x}
          y={sub.y}
          flipFrom={sub.left}
          items={items[sub.index].submenu!}
          autoFocus
          onBack={() => {
            setSub(null);
            ref.current?.focus();
          }}
        />
      )}
    </>
  );
}
