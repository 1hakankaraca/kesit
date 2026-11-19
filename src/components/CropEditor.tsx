import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Rect } from '../../shared/project.ts';

/** Bölge seçici: küçük resim üstünde sürüklenip boyutlanan dikdörtgen (kaynak kırpma, kamera kutusu, çerçevedeki sohbet alanı). `children` altlık üstüne çizilen ek işaretler içindir. */
export function CropEditor({ thumb, crop, onChange, onBegin, onEnd, children }: { thumb: string | null; crop: Rect; onChange: (r: Rect, record: boolean) => void; onBegin: () => void; onEnd: () => void; children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'move' | 'se' | 'nw' | 'ne' | 'sw'; start: Rect; px: number; py: number } | null>(null);
  const pointer = (e: ReactPointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const down = (e: ReactPointerEvent, mode: NonNullable<typeof drag.current>['mode']) => {
    e.stopPropagation();
    e.preventDefault();
    box.current!.setPointerCapture(e.pointerId);
    const p = pointer(e);
    drag.current = { mode, start: crop, px: p.x, py: p.y };
    onBegin();
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = pointer(e);
    const dx = p.x - d.px;
    const dy = p.y - d.py;
    const s = d.start;
    let r: Rect;
    if (d.mode === 'move') r = { ...s, x: s.x + dx, y: s.y + dy };
    else {
      let { x, y, w, h } = s;
      if (d.mode.includes('e')) w = s.w + dx;
      if (d.mode.includes('s')) h = s.h + dy;
      if (d.mode.includes('w')) {
        w = s.w - dx;
        x = s.x + dx;
      }
      if (d.mode.includes('n')) {
        h = s.h - dy;
        y = s.y + dy;
      }
      r = { x, y, w, h };
    }
    const w = Math.min(1, Math.max(0.05, r.w));
    const h = Math.min(1, Math.max(0.05, r.h));
    onChange({ x: Math.min(1 - w, Math.max(0, r.x)), y: Math.min(1 - h, Math.max(0, r.y)), w, h }, false);
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    onEnd();
  };
  const pct = (v: number) => `${v * 100}%`;
  return (
    <div ref={box} className="cropbox" onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {thumb ? <img src={thumb} alt="" draggable={false} /> : <span className="cropbox-empty" />}
      {children}
      <div className="cropbox-rect" style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.w), height: pct(crop.h) }} onPointerDown={(e) => down(e, 'move')}>
        <i className="crop-h crop-nw" onPointerDown={(e) => down(e, 'nw')} />
        <i className="crop-h crop-ne" onPointerDown={(e) => down(e, 'ne')} />
        <i className="crop-h crop-sw" onPointerDown={(e) => down(e, 'sw')} />
        <i className="crop-h crop-se" onPointerDown={(e) => down(e, 'se')} />
      </div>
    </div>
  );
}
