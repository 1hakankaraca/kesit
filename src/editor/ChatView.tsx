import { useEffect, useMemo, useRef, useState } from 'react';
import { lastIndexAt, type ChatData, type ChatLayer } from '../../shared/chat.ts';
import type { ProjectFormat } from '../../shared/project.ts';
import { canvasMeasure, chatMetrics, drawChatBackground, renderChatRow, stackRows, type ChatImages, type ChatRowImage, type LayoutEnv } from './chatRender.ts';

const ROW_CACHE = 500;

/**
 * Sohbet kutusunun önizlemesi. Satırlar çıktı çözünürlüğünde çizilir (dışa
 * aktarmayla aynı kod) ve kutunun ekrandaki boyutuna küçültülerek gösterilir;
 * kaydırma ve satır kırılımları çıktıdakiyle aynıdır. Yalnız görünen son
 * mesaj değiştiğinde yeniden çizilir.
 */
export function ChatView({ layer, data, src, format, images, version }: { layer: ChatLayer; data: ChatData | null | undefined; src: number | null; format: ProjectFormat; images: ChatImages; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cache = useRef<{ key: string; rows: Map<number, ChatRowImage> }>({ key: '', rows: new Map() });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const { x, y, w, h } = layer.frame;
  const m = useMemo(() => chatMetrics({ frame: { x, y, w, h }, size: layer.size }, format), [x, y, w, h, layer.size, format]);
  const last = data && src !== null ? lastIndexAt(data.messages, src - layer.offset) : -1;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      setSize({ w: Math.max(1, Math.round(el.clientWidth * dpr)), h: Math.max(1, Math.round(el.clientHeight * dpr)) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !size.w || !size.h) return;
    if (canvas.width !== size.w) canvas.width = size.w;
    if (canvas.height !== size.h) canvas.height = size.h;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(size.w / m.width, 0, 0, size.h / m.height, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    drawChatBackground(ctx, m, layer.background);
    if (!data || last < 0) return;

    // Satır önbelleği: görünümü etkileyen ayar değişince boşalır (version: yazı tipi/görsel yüklenmesi).
    const key = JSON.stringify([m.width, m.font, layer.badges, layer.shadow, data.fetchedAt, data.messages.length]);
    if (cache.current.key !== key) cache.current = { key, rows: new Map() };
    const rows = cache.current.rows;
    const env: LayoutEnv = { measure: canvasMeasure, aspect: images.aspect, subBadges: data.subBadges, badges: layer.badges };
    const row = (i: number) => {
      let r = rows.get(i);
      if (!r) {
        r = renderChatRow(data.messages[i], m, env, images, layer.shadow);
        if (r.complete) {
          rows.set(i, r);
          if (rows.size > ROW_CACHE) rows.delete(rows.keys().next().value!);
        }
      }
      return r;
    };
    for (const { index, y: ry } of stackRows((i) => row(i).height, last, m)) ctx.drawImage(row(index).canvas, 0, ry);
  }, [last, m, layer.background, layer.shadow, layer.badges, data, size.w, size.h, images, version]);

  return <canvas ref={ref} className="echat-canvas" />;
}
