import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'ok' | 'error';
  action?: { label: string; run: () => void };
}

let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function toast(text: string, tone: Toast['tone'] = 'info', action?: Toast['action'], ms?: number) {
  const t = { id: next++, text, tone, action };
  toasts = [...toasts.slice(-3), t];
  emit();
  setTimeout(() => dismiss(t.id), ms ?? (tone === 'error' ? 6500 : 3800));
  return t.id;
}

export const toastError = (err: unknown) => toast((err as Error)?.message || 'Bir şeyler ters gitti', 'error');

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

const UNDO_MS = 6000;

/**
 * Onaysız silme: öğe hemen ekrandan kalkar (hide), gerçek silme UNDO_MS
 * sonra yapılır (commit). Bildirimdeki "Geri al" silmeyi iptal edip öğeyi
 * geri getirir (restore). Sayfa kapanırsa bekleyen silme hemen yapılır.
 */
export function deleteWithUndo({
  label,
  hide,
  restore,
  commit,
  done,
}: {
  label: string;
  hide: () => void;
  restore: () => void;
  commit: () => Promise<unknown>;
  done?: () => void;
}) {
  hide();
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    window.removeEventListener('pagehide', finish);
    commit().then(done, (err) => {
      restore();
      toastError(err);
    });
  };
  const timer = setTimeout(finish, UNDO_MS);
  window.addEventListener('pagehide', finish);
  const id = toast(
    label,
    'info',
    {
      label: 'Geri al',
      run: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('pagehide', finish);
        restore();
        dismiss(id);
      },
    },
    UNDO_MS,
  );
}

export function useToasts() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => toasts,
  );
}
