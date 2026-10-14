import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

/** Oturum açılınca bağlanır; sunucu çerezden kullanıcıyı tanır ve kendi odasına alır. */
export function connectSocket() {
  if (socket) return socket;
  socket = io({ withCredentials: true, transports: ['websocket', 'polling'] });
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

/** Bir sunucu olayını dinler; işleyici her render'da güncel kalır. */
export function useSocketEvent<T = any>(event: string, handler: (payload: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = connectSocket();
    const fn = (payload: T) => ref.current(payload);
    s.on(event, fn);
    return () => {
      s.off(event, fn);
    };
  }, [event]);
}
