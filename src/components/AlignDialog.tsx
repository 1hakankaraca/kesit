import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from './Icon.tsx';
import { Modal, Spinner } from './basics.tsx';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Elle çizilen dikey yerleşim (0-1 oranlı): yayın alanı ve 0…4 kamera.
 * Kamera yoksa tek kare (yayın alanı 9:16'ya kırpılır); bir kamera üstte,
 * yayın alanı altta; birden çok kamera üst bantta yan yana dizilir.
 */
export interface ManualLayout {
  cams: Rect[];
  content: Rect;
  /** Eski kayıtlar için (ilk kamera). */
  cam?: Rect | null;
}

/** Üzerine kadraj çizilecek yatay kare. */
export interface LayoutFrame {
  id: string;
  title?: string | null;
  imageUrl: string | null;
}

const STORAGE_KEY = 'kesit.klip.hizalama.v2';
const MIN = 0.05;
export const MAX_CAMS = 4;
/** Motorla aynı sabitler (VerticalComposer): üst bölüm yüksekliği bandı. */
const OUT_W = 1080;
const OUT_H = 1920;
const MIN_CAM_H = 608;
const MAX_CAM_H = 760;
const CAM_V_CROP = 0.18;

const DEFAULT_CAM: Rect = { x: 0.72, y: 0.62, w: 0.26, h: 0.36 };
export const DEFAULT_LAYOUT: ManualLayout = {
  cams: [DEFAULT_CAM],
  content: { x: 0, y: 0, w: 1, h: 1 },
};

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';
const HANDLES: Exclude<Handle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/** Kutu anahtarı: 'content' ya da 'cam:<dizin>'. */
type BoxKey = 'content' | `cam:${number}`;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 1000) / 1000;

/** Eski {cam, content} biçimini de okur. */
export function normalizeLayout(raw: unknown): ManualLayout | null {
  const p = raw as Partial<ManualLayout> | null;
  if (!p || typeof p !== 'object' || !p.content) return null;
  const cams = Array.isArray(p.cams) ? p.cams.filter(Boolean) : p.cam ? [p.cam] : [];
  return { cams: cams.slice(0, MAX_CAMS).map(clampRect), content: clampRect(p.content) };
}

export function loadSavedLayout(): ManualLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('kesit.klip.hizalama.v1');
    return (raw && normalizeLayout(JSON.parse(raw))) || DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(layout: ManualLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ cams: layout.cams, content: layout.content }));
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

/**
 * Üst bandın yüksekliği (px, 1080×1920 çıktıda) — motorla (camBand/_camLayout)
 * aynı hesap: kameralar eşit sütunlara bölünür, sütun genişliğine göre kutu
 * oranından türeyen yükseklik [608, 760] bandına kıstırılır. Kamera yoksa 0.
 */
export function camBandHeight(cams: Rect[], aspect: number) {
  if (!cams.length) return 0;
  const tileW = OUT_W / cams.length;
  const ideal = cams.reduce((s, c) => s + tileW * (c.h / (c.w * aspect)), 0) / cams.length;
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

/** Yeni kamera için boş bir köşe: var olanlarla çakışmayan ilk aday. */
function nextCamRect(cams: Rect[]): Rect {
  const spots: Rect[] = [DEFAULT_CAM, { x: 0.02, y: 0.62, w: 0.26, h: 0.36 }, { x: 0.72, y: 0.02, w: 0.26, h: 0.36 }, { x: 0.02, y: 0.02, w: 0.26, h: 0.36 }];
  const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  return spots.find((s) => !cams.some((c) => overlaps(s, c))) ?? { x: 0.37, y: 0.3, w: 0.26, h: 0.36 };
}

/**
 * Kadraj düzenleyici: bir yatay kare üzerinde yayın alanı ve kameralar
 * çizilir. Sağda motorun üreteceği 9:16 sonucun önizlemesi vardır: kamera yoksa
 * tek kare, bir kamera üstte, birden çoğu üst bantta yan yana. Diyalogda
 * (klipler, yeniden üretim) ve Logo ve görünüm sayfasında kullanılır.
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
  const drag = useRef<{ key: BoxKey; handle: Handle; start: Rect; px: number; py: number } | null>(null);
  const current = frames[Math.min(index, Math.max(0, frames.length - 1))];

  useEffect(() => {
    setIndex(0);
  }, [frames.length]);

  const rectOf = (key: BoxKey): Rect => (key === 'content' ? layout.content : layout.cams[Number(key.slice(4))]);
  const set = (key: BoxKey, rect: Rect) => {
    if (key === 'content') onChange({ ...layout, content: rect });
    else onChange({ ...layout, cams: layout.cams.map((c, i) => (i === Number(key.slice(4)) ? rect : c)) });
  };
  const addCam = () => layout.cams.length < MAX_CAMS && onChange({ ...layout, cams: [...layout.cams, nextCamRect(layout.cams)] });
  const removeCam = (i: number) => onChange({ ...layout, cams: layout.cams.filter((_, k) => k !== i) });

  const pointer = (e: ReactPointerEvent) => {
    const r = frame.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onDown = (e: ReactPointerEvent, key: BoxKey, handle: Handle) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = pointer(e);
    drag.current = { key, handle, start: rectOf(key), px: p.x, py: p.y };
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
    const camH = Math.round((pw * camBandHeight(layout.cams, aspect)) / OUT_W);
    const n = layout.cams.length;
    const tileW = n ? pw / n : 0;
    return { pw, ph, camH, contentH: ph - camH, tileW };
  }, [layout, aspect, previewWidth]);

  const pct = (v: number) => `${v * 100}%`;
  const boxStyle = (r: Rect): CSSProperties => ({ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });
  const n = layout.cams.length;

  return (
    <div className="hz-grid">
      <div className="hz-stage">
        <div ref={frame} className="hz-frame" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {current?.imageUrl ? (
            <img src={current.imageUrl} alt="" draggable={false} onLoad={(e) => e.currentTarget.naturalWidth && setAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)} />
          ) : (
            <span className="hz-noimg">Önizleme karesi yok — kutuları yine de çizebilirsin.</span>
          )}
          <div className="hz-box hz-box-content" style={boxStyle(layout.content)} onPointerDown={(e) => onDown(e, 'content', 'move')} role="group" aria-label="Yayın alanı kutusu">
            <span className="hz-label">
              <Icon name="monitor" size={12} /> Yayın alanı
            </span>
            {HANDLES.map((h) => (
              <span key={h} className={`hz-handle hz-handle-${h}`} onPointerDown={(e) => onDown(e, 'content', h)} />
            ))}
          </div>
          {layout.cams.map((cam, i) => {
            const key: BoxKey = `cam:${i}`;
            return (
              <div key={key} className="hz-box hz-box-cam" style={boxStyle(cam)} onPointerDown={(e) => onDown(e, key, 'move')} role="group" aria-label={`Kamera ${i + 1} kutusu`}>
                <span className="hz-label">
                  <Icon name="camera" size={12} /> Kamera{n > 1 ? ` ${i + 1}` : ''}
                </span>
                <button
                  type="button"
                  className="hz-remove"
                  aria-label={`Kamera ${i + 1} kutusunu kaldır`}
                  title="Bu kamerayı kaldır"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeCam(i);
                  }}
                >
                  <Icon name="x" size={11} />
                </button>
                {HANDLES.map((h) => (
                  <span key={h} className={`hz-handle hz-handle-${h}`} onPointerDown={(e) => onDown(e, key, h)} />
                ))}
              </div>
            );
          })}
        </div>
        <div className="row-gap">
          <button type="button" className="btn btn-secondary btn-small" onClick={addCam} disabled={n >= MAX_CAMS}>
            <Icon name="plus" size={14} /> Kamera ekle{n ? ` (${n}/${MAX_CAMS})` : ''}
          </button>
          {n > 0 && (
            <button type="button" className="btn btn-quiet btn-small" onClick={() => onChange({ ...layout, cams: [] })}>
              Kamerasız (tek kare)
            </button>
          )}
          <span className="muted hz-mode">{n === 0 ? 'Tek kare: yayın alanı 9:16 kırpılır' : n === 1 ? 'Kamera üstte, yayın alanı altta' : `${n} kamera üstte yan yana, yayın alanı altta`}</span>
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
          {n > 0 && (
            <div className="hz-part hz-part-cam hz-band" style={{ height: preview.camH }}>
              {layout.cams.map((cam, i) => (
                <div key={i} className="hz-tile" style={{ width: preview.tileW, height: preview.camH }}>
                  {current?.imageUrl && <img src={current.imageUrl} alt="" style={coverStyle(cam, preview.tileW, preview.camH, aspect)} />}
                </div>
              ))}
            </div>
          )}
          <div className="hz-part hz-part-content" style={{ height: preview.contentH }}>
            {current?.imageUrl && <img src={current.imageUrl} alt="" style={coverStyle(layout.content, preview.pw, preview.contentH, aspect)} />}
          </div>
        </div>
        <dl className="hz-facts">
          <dt>Düzen</dt>
          <dd>{n === 0 ? 'Tek kare' : n === 1 ? 'Kamera + oyun' : `${n} kamera + oyun`}</dd>
          {n > 0 && (
            <>
              <dt>Üst bölüm</dt>
              <dd>{camBandHeight(layout.cams, aspect)} px</dd>
            </>
          )}
          <dt>Yayın alanı</dt>
          <dd>
            {Math.round(layout.content.w * 100)}×{Math.round(layout.content.h * 100)} %
          </dd>
        </dl>
        <p className="muted hz-tip">{n ? 'Kamera kutusunu biraz geniş tut: dar kutular üstte yakınlaştırılmış görünür. Yayın alanı alt bölüme ortalanarak sığdırılır.' : 'Yayın alanı kutusunu daraltırsan yalnız o bölge dikey kareye alınır; tam kare bırakırsan ortadan kırpılır.'}</p>
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

  // Yalnız açılışta sıfırla: üst bileşen her çizimde yeni bir `initial` nesnesi
  // verebilir (arka planda iş ilerlerken) ve çizim ortasında silinirdi.
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    if (open) setLayout(initialRef.current ?? loadSavedLayout());
  }, [open]);

  const submit = () => {
    saveLayout(layout);
    onSubmit({ cams: layout.cams, content: layout.content });
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
            Kutuları sürükle ve kenarlarından boyutlandır. <b>Kamera</b> kutuları üste, <b>Yayın alanı</b> alta gelir; kamera eklemezsen tek kare olur. Yüz tespiti yapılmaz, çizdiğin kadraj birebir kullanılır.
          </>
        )}
      </p>
      <LayoutEditor layout={layout} onChange={setLayout} frames={frames} />
    </Modal>
  );
}
