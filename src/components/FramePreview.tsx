import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { SAFE_MARGIN, V_CAM_H, V_H, clampCenter, logoBox, snap, subtitleBox, type Format } from '../lib/frame.ts';

const SAMPLE_LINE = ['Bunu', 'kimse', 'beklemiyordu', 've', 'tam', 'o', 'anda…'];

export interface FrameOptions {
  logo: boolean;
  logoScale: number;
  logoOpacity: number;
  logoPosition: 'seam' | 'top-center' | 'custom';
  logoX: number | null;
  logoY: number | null;
  subtitles: boolean;
  composition: 'auto' | 'split' | 'single';
}

/**
 * Video karesi önizlemesi. Logo ve altyazı motorun gerçek oranlarıyla
 * (lib/frame.ts) çizilir; kare hangi boyutta görünürse görünsün yerleşim
 * aynı orandadır. Logo sürüklenebilir: merkez, üçte birler ve güvenli
 * kenarlara yapışır, yapıştığı çizgi kılavuz olarak görünür. Ok tuşlarıyla
 * ince ayar yapılır (Shift ile büyük adım).
 */
export function FramePreview({
  format,
  opts,
  logoUrl,
  styleKey,
  sampleUrl,
  onLogoMove,
}: {
  format: Format;
  opts: FrameOptions;
  logoUrl: string | null;
  styleKey: string;
  sampleUrl: string | null;
  onLogoMove: (x: number, y: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(1 / 3);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const vertical = format === 'vertical';
  const split = vertical && opts.composition !== 'single';

  const logo = opts.logo ? logoBox(format, opts, aspect, split) : null;
  const sub = subtitleBox(format, styleKey, logo, opts.logoPosition, split);

  const place = (x: number, y: number, withSnap: boolean) => {
    if (!logo) return;
    const hx = logo.w / 2;
    const hy = logo.h / 2;
    let nx = clampCenter(x, hx);
    let ny = clampCenter(y, hy);
    let gx: number | null = null;
    let gy: number | null = null;
    if (withSnap) {
      const sx = snap(nx, hx);
      const sy = snap(ny, hy);
      nx = sx.value;
      ny = sy.value;
      gx = sx.guide;
      gy = sy.guide;
    }
    setGuides({ x: gx, y: gy });
    onLogoMove(Math.round(nx * 1000) / 1000, Math.round(ny * 1000) / 1000);
  };

  const pointer = (e: ReactPointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onDown = (e: ReactPointerEvent) => {
    if (!logo) return;
    e.preventDefault();
    box.current!.setPointerCapture(e.pointerId);
    const p = pointer(e);
    // Tutulan nokta ile merkez arasındaki fark korunur; logo zıplamaz.
    setDrag({ dx: p.x - logo.cx, dy: p.y - logo.cy });
  };

  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const p = pointer(e);
    place(p.x - drag.dx, p.y - drag.dy, !e.altKey);
  };

  const onUp = () => {
    setDrag(null);
    setGuides({ x: null, y: null });
  };

  const onKey = (e: KeyboardEvent) => {
    if (!logo) return;
    const step = e.shiftKey ? 0.05 : 0.005;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    place(logo.cx + m[0], logo.cy + m[1], false);
  };

  const pct = (v: number) => `${v * 100}%`;

  return (
    <figure className={vertical ? 'frame frame-v' : 'frame frame-h'}>
      <div
        ref={box}
        className={drag ? 'frame-canvas frame-dragging' : 'frame-canvas'}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {sampleUrl ? (
          <img className="frame-bg" src={sampleUrl} alt="" draggable={false} />
        ) : vertical && split ? (
          <>
            <div className="frame-cam" style={{ height: pct(V_CAM_H / V_H) }}>
              Kamera
            </div>
            <div className="frame-game frame-game-rest">Oyun / ekran</div>
          </>
        ) : (
          <div className="frame-game">{vertical ? 'Oyun / ekran' : 'Yayın görüntüsü'}</div>
        )}

        {/* Kılavuzlar: güvenli alan ve üçte birler sürüklerken görünür */}
        <div className="frame-guides" aria-hidden="true">
          <span className="frame-safe" style={{ inset: pct(SAFE_MARGIN) }} />
          <span className="frame-third frame-third-v" style={{ left: pct(1 / 3) }} />
          <span className="frame-third frame-third-v" style={{ left: pct(2 / 3) }} />
          <span className="frame-third frame-third-h" style={{ top: pct(1 / 3) }} />
          <span className="frame-third frame-third-h" style={{ top: pct(2 / 3) }} />
        </div>
        {guides.x !== null && <span className="frame-snap frame-snap-v" style={{ left: pct(guides.x) }} aria-hidden="true" />}
        {guides.y !== null && <span className="frame-snap frame-snap-h" style={{ top: pct(guides.y) }} aria-hidden="true" />}

        {logo && (
          <span
            className={logoUrl ? 'frame-logo' : 'frame-logo frame-logo-ghost'}
            role="slider"
            tabIndex={0}
            aria-label={`Logo konumu: yatay %${Math.round(logo.cx * 100)}, dikey %${Math.round(logo.cy * 100)}. Ok tuşlarıyla taşı.`}
            aria-valuenow={Math.round(logo.cx * 100)}
            style={{ left: pct(logo.cx), top: pct(logo.cy), width: pct(logo.w), height: pct(logo.h), opacity: opts.logoOpacity }}
            onPointerDown={onDown}
            onKeyDown={onKey}
          >
            {logoUrl ? (
              <img
                src={logoUrl}
                alt=""
                draggable={false}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth) setAspect(img.naturalHeight / img.naturalWidth);
                }}
              />
            ) : (
              'LOGO'
            )}
          </span>
        )}

        {opts.subtitles && (
          <p className={`frame-sub sub-${styleKey}`} style={{ bottom: pct(sub.bottom), fontSize: `${sub.fontCqi}cqi` }}>
            {SAMPLE_LINE.map((w, i) => (i === 2 ? <em key={i}>{w} </em> : `${w} `))}
          </p>
        )}
      </div>
      <figcaption>
        {vertical ? 'Dikey 9:16' : 'Yatay 16:9'}
        {logo && ` · logo %${Math.round(logo.cx * 100)}, %${Math.round(logo.cy * 100)}`}
        {logo && ' · sürükle, ok tuşlarıyla ince ayar, Alt ile yapışmadan'}
      </figcaption>
    </figure>
  );
}
