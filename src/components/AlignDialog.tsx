import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from './Icon.tsx';
import { Modal, Spinner } from './basics.tsx';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Elle çizilen dikey yerleşim: kamera kutusu ve altına gelecek yayın alanı (0-1 oranlı). */
export interface ManualLayout {
  cam: Rect;
  content: Rect;
}

/** Üzerine kadraj çizilecek yatay kare. */
export interface LayoutFrame {
  id: string;
  title?: string | null;
  imageUrl: string | null;
}

const STORAGE_KEY = 'kesit.klip.hizalama.v1';
const MIN = 0.05;
/** Motorla aynı sabitler (VerticalComposer): üst bölüm yüksekliği bandı. */
const OUT_W = 1080;
const OUT_H = 1920;
const MIN_CAM_H = 608;
const MAX_CAM_H = 760;
const CAM_V_CROP = 0.18;

export const DEFAULT_LAYOUT: ManualLayout = {
  cam: { x: 0.72, y: 0.62, w: 0.26, h: 0.36 },
  content: { x: 0, y: 0, w: 1, h: 1 },
};

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';
const HANDLES: Exclude<Handle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 1000) / 1000;

export function loadSavedLayout(): ManualLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const p = JSON.parse(raw) as ManualLayout;
    return p?.cam && p?.content ? p : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(layout: ManualLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* yok say */
  }
}

/** Kutuyu kare içinde tutar; en az MIN kadar geniş/yüksek kalır. */
export function clampRect(r: Rect): Rect {
  const w = clamp(r.w, MIN, 1);
  const h = clamp(r.h, MIN, 1);
  return { x: round(clamp(r.x, 0, 1 - w)), y: round(clamp(r.y, 0, 1 - h)), w: round(w), h: round(h) };
}

/** Sürükleme sırasında tutamağa göre yeni kutu (dx, dy 0-1 oranlı fark). */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number): Rect {
  if (handle === 'move') return clampRect({ ...start, x: start.x + dx, y: start.y + dy });
  let { x, y, w, h } = start;
  const right = x + w;
  const bottom = y + h;
  if (handle.includes('w')) x = clamp(x + dx, 0, right - MIN);
  if (handle.includes('n')) y = clamp(y + dy, 0, bottom - MIN);
  if (handle.includes('e')) w = clamp(right + dx, x + MIN, 1) - x;
  if (handle.includes('s')) h = clamp(bottom + dy, y + MIN, 1) - y;
  if (handle.includes('w')) w = right - x;
  if (handle.includes('n')) h = bottom - y;
  return clampRect({ x, y, w, h });
}

/** Motorun üst bölüm yüksekliği (px, 1080×1920 çıktıda); kaynak oranı A = genişlik/yükseklik. */
export function camHeightFor(cam: Rect, aspect: number) {
  const ideal = OUT_W * (cam.h / (cam.w * aspect));
  return Math.round(clamp(ideal * (1 - CAM_V_CROP), MIN_CAM_H, MAX_CAM_H));
}

/** Bir bölgeyi kutuya "cover" sığdıran görsel konumu (px). */
function coverStyle(region: Rect, boxW: number, boxH: number, aspect: number): CSSProperties {
  let wi = boxW / region.w;
  let hi = wi / aspect;
  if (region.h * hi < boxH) {
    hi = boxH / region.h;
    wi = hi * aspect;
  }
  return { position: 'absolute', width: wi, height: hi, left: (boxW - region.w * wi) / 2 - region.x * wi, top: (boxH - region.h * hi) / 2 - region.y * hi, maxWidth: 'none' };
}

/**
 * Kadraj düzenleyici: bir yatay kare üzerinde iki kutu çizilir — "Kamera"
 * üste, "Yayın alanı" alta gelir. Sağda motorun üreteceği 9:16 sonucun
 * önizlemesi vardır. Diyalogda (klipler, yeniden üretim) ve Logo ve görünüm
 * sayfasında (varsayılan kadraj) kullanılır.
 */
export function LayoutEditor({
  layout,
  onChange,
  frames,
  previewWidth = 216,
  footer,
}: {
  layout: ManualLayout;
  onChange: (layout: ManualLayout) => void;
  frames: LayoutFrame[];
  previewWidth?: number;
  /** Önizlemenin altına eklenecek içerik (ör. örnek kare seçme). */
  footer?: React.ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const [aspect, setAspect] = useState(16 / 9);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ key: keyof ManualLayout; handle: Handle; start: Rect; px: number; py: number } | null>(null);
  const current = frames[Math.min(index, Math.max(0, frames.length - 1))];

  useEffect(() => {
    setIndex(0);
  }, [frames.length]);

  const set = (key: keyof ManualLayout, rect: Rect) => onChange({ ...layout, [key]: rect });

  const pointer = (e: ReactPointerEvent) => {
    const r = frame.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onDown = (e: ReactPointerEvent, key: keyof ManualLayout, handle: Handle) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = pointer(e);
    drag.current = { key, handle, start: layout[key], px: p.x, py: p.y };
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = pointer(e);
    set(d.key, resizeRect(d.start, d.handle, p.x - d.px, p.y - d.py));
  };

  const onUp = () => {
    drag.current = null;
  };

  const preview = useMemo(() => {
    const pw = previewWidth;
    const ph = Math.round((pw * OUT_H) / OUT_W);
    const camH = Math.round((pw * camHeightFor(layout.cam, aspect)) / OUT_W);
    return { pw, ph, camH, contentH: ph - camH };
  }, [layout, aspect, previewWidth]);

  const pct = (v: number) => `${v * 100}%`;
  const boxStyle = (r: Rect): CSSProperties => ({ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });

  return (
    <div className="hz-grid">
      <div className="hz-stage">
        <div ref={frame} className="hz-frame" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {current?.imageUrl ? (
            <img src={current.imageUrl} alt="" draggable={false} onLoad={(e) => e.currentTarget.naturalWidth && setAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)} />
          ) : (
            <span className="hz-noimg">Önizleme karesi yok — kutuları yine de çizebilirsin.</span>
          )}
          {(['content', 'cam'] as const).map((key) => (
            <div key={key} className={`hz-box hz-box-${key}`} style={boxStyle(layout[key])} onPointerDown={(e) => onDown(e, key, 'move')} role="group" aria-label={key === 'cam' ? 'Kamera kutusu' : 'Yayın alanı kutusu'}>
              <span className="hz-label">
                <Icon name={key === 'cam' ? 'camera' : 'monitor'} size={12} /> {key === 'cam' ? 'Kamera' : 'Yayın alanı'}
              </span>
              {HANDLES.map((h) => (
                <span key={h} className={`hz-handle hz-handle-${h}`} onPointerDown={(e) => onDown(e, key, h)} />
              ))}
            </div>
          ))}
        </div>
        {frames.length > 1 && (
          <div className="hz-strip" role="tablist" aria-label="Kare seç">
            {frames.map((c, i) => (
              <button key={c.id} type="button" role="tab" aria-selected={i === index} className={i === index ? 'hz-thumb on' : 'hz-thumb'} onClick={() => setIndex(i)} title={c.title ?? undefined}>
                {c.imageUrl ? <img src={c.imageUrl} alt="" loading="lazy" /> : <Icon name="film" size={16} />}
              </button>
            ))}
          </div>
        )}
      </div>

      <aside className="hz-side">
        <div className="hz-preview" style={{ width: preview.pw, height: preview.ph }} aria-label="Dikey sonuç önizlemesi">
          <div className="hz-part hz-part-cam" style={{ height: preview.camH }}>
            {current?.imageUrl && <img src={current.imageUrl} alt="" style={coverStyle(layout.cam, preview.pw, preview.camH, aspect)} />}
          </div>
          <div className="hz-part hz-part-content" style={{ height: preview.contentH }}>
            {current?.imageUrl && <img src={current.imageUrl} alt="" style={coverStyle(layout.content, preview.pw, preview.contentH, aspect)} />}
          </div>
        </div>
        <dl className="hz-facts">
          <dt>Üst bölüm</dt>
          <dd>{camHeightFor(layout.cam, aspect)} px</dd>
          <dt>Kamera</dt>
          <dd>
            {Math.round(layout.cam.w * 100)}×{Math.round(layout.cam.h * 100)} %
          </dd>
          <dt>Yayın alanı</dt>
          <dd>
            {Math.round(layout.content.w * 100)}×{Math.round(layout.content.h * 100)} %
          </dd>
        </dl>
        <p className="muted hz-tip">Kamera kutusunu biraz geniş tut: dar kutular üstte yakınlaştırılmış görünür. Yayın alanı kutusu alt bölüme ortalanarak sığdırılır.</p>
        {footer}
      </aside>
    </div>
  );
}

/**
 * Manuel hizalama penceresi: klibin karesi üzerinde kadraj çizilir ve
 * seçili kliplere uygulanır. Son çizim hatırlanır.
 */
export function AlignDialog({
  open,
  frames,
  submitting,
  onClose,
  onSubmit,
  initial,
  title = 'Manuel hizalama',
  submitLabel,
  lead,
}: {
  open: boolean;
  frames: LayoutFrame[];
  submitting: boolean;
  onClose: () => void;
  onSubmit: (layout: ManualLayout) => void;
  /** Açılışta gösterilecek kadraj (yoksa son çizim). */
  initial?: ManualLayout | null;
  title?: string;
  submitLabel?: string;
  lead?: React.ReactNode;
}) {
  const [layout, setLayout] = useState<ManualLayout>(() => initial ?? loadSavedLayout());

  useEffect(() => {
    if (open) setLayout(initial ?? loadSavedLayout());
  }, [open, initial]);

  const submit = () => {
    saveLayout(layout);
    onSubmit(layout);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      className="modal-align"
      title={title}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={() => setLayout(DEFAULT_LAYOUT)}>
            Sıfırla
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Vazgeç
          </button>
          <button type="button" className="btn btn-accent" onClick={submit} disabled={submitting || !frames.length}>
            {submitting ? <Spinner /> : <Icon name="vertical" size={16} />}
            {submitLabel ?? (frames.length > 1 ? `${frames.length} klibi bu kadrajla işle` : 'Bu kadrajla işle')}
          </button>
        </>
      }
    >
      <p className="muted hz-lead">
        {lead ?? (
          <>
            Kutuları sürükle ve kenarlarından boyutlandır. <b>Kamera</b> üste, <b>Yayın alanı</b> alta gelir; yüz tespiti yapılmaz, çizdiğin kadraj birebir kullanılır.
          </>
        )}
      </p>
      <LayoutEditor layout={layout} onChange={setLayout} frames={frames} />
    </Modal>
  );
}
