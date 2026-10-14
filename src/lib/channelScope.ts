import { useSyncExternalStore } from 'react';
import { useSession } from './session.ts';

/**
 * Kanal kapsamı: listeler varsayılan olarak üstteki etkin kanal sekmesine
 * göre süzülür; "Tüm kanallar" seçilirse hepsi görünür. Tercih tarayıcıda
 * hatırlanır.
 */
const KEY = 'kesit.tumKanallar';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let all = read();

export function setShowAllChannels(next: boolean) {
  all = next;
  try {
    localStorage.setItem(KEY, next ? '1' : '0');
  } catch {
    /* tarayıcı depolaması kapalı — yalnız bu oturumda geçerli */
  }
  listeners.forEach((fn) => fn());
}

export function useChannelScope() {
  const { user } = useSession();
  const showAll = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => all,
  );
  const channel = user?.channelSlug ?? null;
  /** Kayıt bu kapsamda mı (kanalsız kayıtlar her zaman görünür). */
  const inScope = (slug: string | null | undefined) => showAll || !channel || !slug || slug === channel;
  return { channel, showAll, inScope };
}
