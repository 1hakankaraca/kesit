import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { GUIDES, type GuideKey } from '../lib/guides.ts';
import { dismiss, useToasts } from '../lib/toast.ts';
import { Icon, type IconName } from './Icon.tsx';

/** Yazı logosu: düz "Kesit". */
export function Wordmark({ large = false }: { large?: boolean }) {
  return <span className={large ? 'wordmark-text wordmark-text-large' : 'wordmark-text'}>Kesit</span>;
}

export function Ticks({ className = '' }: { className?: string }) {
  return <span className={`ticks ${className}`} aria-hidden="true" />;
}

interface SegmentedProps<T extends string | number> {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; disabled?: boolean }[];
  onChange: (value: T) => void;
  size?: 'small' | 'normal';
}

export function Segmented<T extends string | number>({ label, value, options, onChange, size = 'normal' }: SegmentedProps<T>) {
  const id = useId();
  return (
    <div className={size === 'small' ? 'segmented segmented-small' : 'segmented'} role="radiogroup" aria-label={label}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={active}
            className="segmented-item"
            disabled={opt.disabled}
            onClick={() => !active && onChange(opt.value)}
          >
            {active && <motion.span layoutId={`seg-${id}`} className="segmented-thumb" transition={{ type: 'spring', stiffness: 520, damping: 38 }} />}
            <span className="segmented-label">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-text">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </span>
    </button>
  );
}

export function Field({ label, help, children, htmlFor }: { label: ReactNode; help?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {help && <p className="field-help">{help}</p>}
    </div>
  );
}

/** Şerit biçimli ilerleme çubuğu; yüzde yoksa belirsiz akış. */
export function Progress({ value, label }: { value: number | null; label?: string }) {
  const pct = value === null ? null : Math.max(0, Math.min(100, value));
  return (
    <div className={pct === null ? 'progress progress-indeterminate' : 'progress'} role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <span className="progress-fill" style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function Empty({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3 className="empty-title">{title}</h3>
      {children && <p className="empty-text">{children}</p>}
      {action}
    </div>
  );
}

export function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'live' | 'ok' | 'on'; children: ReactNode }) {
  return (
    <span className={`pill pill-${tone}`}>
      <span className="pill-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <motion.div
            ref={ref}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            className={wide ? 'modal modal-wide' : 'modal'}
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <span className="panel-tape" aria-hidden="true" />
            <header className="modal-head">
              <h2 className="panel-title">{title}</h2>
              <button type="button" className="btn btn-quiet btn-icon" onClick={onClose} aria-label="Kapat">
                <Icon name="x" />
              </button>
            </header>
            <div className="modal-body">{children}</div>
            {footer && <footer className="modal-foot">{footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            role="status"
            className={`toast toast-${t.tone}`}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40 }}
          >
            <Icon name={t.tone === 'error' ? 'x' : t.action ? 'trash' : 'check'} size={16} />
            <span>{t.text}</span>
            {t.action ? (
              <button type="button" className="toast-action" onClick={t.action.run}>
                {t.action.label}
              </button>
            ) : (
              <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Kapat">
                <Icon name="x" size={14} />
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

const guideSeenKey = (k: GuideKey) => `kesit.rehber.v2.${k}`;

function guideSeen(k: GuideKey) {
  try {
    return localStorage.getItem(guideSeenKey(k)) === '1';
  } catch {
    return true;
  }
}

function markGuideSeen(k: GuideKey) {
  try {
    localStorage.setItem(guideSeenKey(k), '1');
  } catch {
    /* tarayıcı depolaması kapalı — rehber her seferinde açılır */
  }
}

/** Çalışma alanı başlığı: dev başlık, bir kelimesi şerit üstünde; isteğe bağlı rehber. */
export function WorkspaceHead({ title, tape, lead, actions, guide }: { title: string; tape: string; lead?: ReactNode; actions?: ReactNode; guide?: GuideKey }) {
  const [open, setOpen] = useState(() => !!guide && !guideSeen(guide));
  const close = () => {
    setOpen(false);
    if (guide) markGuideSeen(guide);
  };
  return (
    <>
      <header className="ws-head">
        <div>
          <h1 className="ws-title">
            {title} <span className="ws-title-tape">{tape}</span>
          </h1>
          {lead && <p className="ws-lead">{lead}</p>}
        </div>
        <div className="ws-actions">
          {guide && (
            <button type="button" className="btn btn-secondary" onClick={() => (open ? close() : setOpen(true))} aria-expanded={open}>
              <Icon name="help" size={16} /> Nasıl kullanılır
            </button>
          )}
          {actions}
        </div>
      </header>
      <AnimatePresence initial={false}>{guide && open && <GuidePanel guideKey={guide} onClose={close} />}</AnimatePresence>
    </>
  );
}

function GuidePanel({ guideKey, onClose }: { guideKey: GuideKey; onClose: () => void }) {
  const g = GUIDES[guideKey];
  return (
    <motion.section className="guide" aria-label={g.title} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
      <div className="guide-inner">
        <header className="guide-head">
          <div>
            <p className="eyebrow">Rehber</p>
            <h2 className="guide-title">{g.title}</h2>
            <p className="guide-intro">{g.intro}</p>
          </div>
          <button type="button" className="btn btn-quiet btn-icon" onClick={onClose} aria-label="Rehberi kapat">
            <Icon name="x" />
          </button>
        </header>
        <ol className="guide-steps">
          {g.steps.map((st, i) => (
            <li key={st.title}>
              <span className="guide-num">{i + 1}</span>
              <b>{st.title}</b>
              <span>{st.text}</span>
            </li>
          ))}
        </ol>
        {'tips' in g && g.tips && (
          <ul className="guide-tips">
            {g.tips.map((t) => (
              <li key={t}>
                <Icon name="bolt" size={14} /> {t}
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="btn btn-primary btn-small" onClick={onClose}>
          Anladım
        </button>
      </div>
    </motion.section>
  );
}
