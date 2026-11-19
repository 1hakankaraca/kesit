import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatData, ChatLayer, ChatRange } from '../../shared/chat.ts';
import { api } from '../lib/api.ts';
import { useSocketEvent } from '../lib/socket.ts';
import { ChatImages, chatFontsReady } from './chatRender.ts';

export interface ChatStore {
  /** Varlık kimliği → sohbet verisi (undefined: yükleniyor, null: henüz çekilmemiş) */
  data: Record<string, ChatData | null | undefined>;
  images: ChatImages;
  /** Görsel/yazı tipi yüklendikçe artar; önizleme yeniden çizilir */
  version: number;
  /** Çekimi süren varlıklar → yüzde */
  busy: Record<string, number>;
  /** Sohbeti (eksik bölümlerini) Kick'ten çeker ve saklar */
  ensure: (assetId: string, ranges?: ChatRange[]) => Promise<ChatData>;
}

/**
 * Projedeki sohbet katmanlarının verisi ve görselleri. Veri sunucuda projenin
 * yanında saklanır; burada bir kez yüklenir, çekim sürerken ilerleme
 * `chat:progress` olayıyla gelir.
 */
export function useChat(projectId: number, chats: readonly ChatLayer[]): ChatStore {
  const [data, setData] = useState<Record<string, ChatData | null | undefined>>({});
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<Record<string, number>>({});
  const images = useMemo(() => new ChatImages(), []);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    let raf = 0;
    // Art arda yüklenen görseller tek yeniden çizimde toplanır.
    images.onLoad = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          setVersion((v) => v + 1);
        });
    };
    void chatFontsReady().then(() => setVersion((v) => v + 1));
    return () => {
      images.onLoad = null;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [images]);

  const assetKey = chats.map((c) => c.assetId).join(',');
  useEffect(() => {
    for (const assetId of assetKey ? assetKey.split(',') : []) {
      if (requested.current.has(assetId)) continue;
      requested.current.add(assetId);
      api.get<{ chat: ChatData | null }>(`/api/projects/${projectId}/assets/${assetId}/chat`).then(
        (r) => setData((d) => (d[assetId] ? d : { ...d, [assetId]: r.chat })),
        () => setData((d) => (d[assetId] ? d : { ...d, [assetId]: null })),
      );
    }
  }, [assetKey, projectId]);

  useSocketEvent<{ projectId: number; assetId: string; percent: number; done?: boolean; failed?: boolean }>('chat:progress', (e) => {
    if (e.projectId !== projectId) return;
    setBusy((b) => {
      const next = { ...b };
      if (e.done || e.failed) delete next[e.assetId];
      else next[e.assetId] = e.percent;
      return next;
    });
  });

  const ensure = useCallback(
    async (assetId: string, ranges?: ChatRange[]) => {
      setBusy((b) => ({ ...b, [assetId]: b[assetId] ?? 0 }));
      try {
        const res = await api.post<{ chat: ChatData }>(`/api/projects/${projectId}/assets/${assetId}/chat`, ranges ? { ranges } : {});
        requested.current.add(assetId);
        setData((d) => ({ ...d, [assetId]: res.chat }));
        return res.chat;
      } finally {
        setBusy((b) => {
          const next = { ...b };
          delete next[assetId];
          return next;
        });
      }
    },
    [projectId],
  );

  return { data, images, version, busy, ensure };
}
