import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { dismiss, useToasts } from '../lib/toast.ts';
import { Icon, type IconName } from './Icon.tsx';

/** Logo: cetvel çentikli kare içinde makas kesiği — bir şeritten kesilmiş parça. */
export function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="kesit-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="logo-stop-1" />
          <stop offset="1" className="logo-stop-2" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill="url(#kesit-g)" />
      <g stroke="#fff" strokeLinecap="round" opacity="0.55" strokeWidth="2.6">
        <path d="M15 7v7M23.5 7v4M32 7v7M40.5 7v4M49 7v7" />
      </g>
      <path d="M18 24v26M18 37l16-13M24.5 32 40 50" fill="none" stroke="#fff" strokeWidth="6.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M46 26v24" stroke="#fff" strokeWidth="6.4" strokeLinecap="round" strokeDasharray="0.1 8.5" />
    </svg>
  );
}

/** "Kes" düz, "it" kesilmiş bir şerit parçasının üstünde durur. */
export function Wordmark({ large = false }: { large?: boolean }) {
  return (
    <span className={large ? 'logotype logotype-large' : 'logotype'} aria-label="Kesit">
      <LogoMark size={large ? 44 : 32} />
      <span className="logotype-plain">Kes</span>
      <span className="logotype-tag">
        <span className="logotype-ticks" aria-hidden="true" />
        it
      </span>
    </span>
  );
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
          <motion.button
            key={t.id}
            type="button"
            layout
            className={`toast toast-${t.tone}`}
            onClick={() => dismiss(t.id)}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40 }}
          >
            <Icon name={t.tone === 'error' ? 'x' : 'check'} size={16} />
            {t.text}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Çalışma alanı başlığı: dev başlık, bir kelimesi şerit üstünde. */
export function WorkspaceHead({ title, tape, lead, actions }: { title: string; tape: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="ws-head">
      <div>
        <h1 className="ws-title">
          {title} <span className="ws-title-tape">{tape}</span>
        </h1>
        {lead && <p className="ws-lead">{lead}</p>}
      </div>
      {actions && <div className="ws-actions">{actions}</div>}
    </header>
  );
}
