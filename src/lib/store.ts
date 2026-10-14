import { useSyncExternalStore } from 'react';

/** Küçük, dışa açık durum kabı — useSyncExternalStore ile okunur. */
export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: T | ((prev: T) => T)) {
      state = typeof next === 'function' ? (next as (prev: T) => T)(state) : next;
      listeners.forEach((fn) => fn());
    },
    use(): T {
      return useSyncExternalStore(
        (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        () => state,
      );
    },
  };
}
