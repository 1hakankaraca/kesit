import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { duration as fmtDuration, stamp } from '../lib/format.ts';
import type { Frame } from '../lib/types.ts';
import { Icon } from './Icon.tsx';

export interface Cut {
  id: string;
  start: number;
  end: number;
  color: string;
  label?: string;
}

export interface Marker {
  start: number;
  end: number;
  label?: string | null;
  score?: number | null;
}

const COLORS = ['#f43f5e', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#eab308'];
const MIN_CUT = 1;
/** Yakınlaştırma: 1 = tüm yayın şeride sığar; 1'in altı şeridi daraltır. */
const ZOOMS = [0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 4, 8, 16, 32];
const FIT_ZOOM = ZOOMS.indexOf(1);

let seq = 0;
export const newCut = (start: number, end: number, index: number, label?: string): Cut => ({
  id: `c${Date.now()}${seq++}`,
  start,
  end,
  color: COLORS[index % COLORS.length],
  label,
});

type Drag =
  | { kind: 'create'; anchor: number; id: string }
  | { kind: 'scrub' }
  | { kind: 'move'; id: string; offset: number; length: number }
  | { kind: 'start' | 'end'; id: string }
  | { kind: 'seek' };

/**
 * Zaman çizelgesi editörü. Üstte oynatıcı, altta film şeridi + öne çıkan
 * anlar + kesitler. İki mod vardır:
 *  - İzle (varsayılan): şeride tıkla/sürükle → oynatma çizgisi oraya gider.
 *  - Kesit seç: şeritte sürükle → yeni kesit.
 * Kesitler her iki modda taşınır/uzatılır; oynatma çizgisi her zaman tutulup sürüklenir.
 * Klavye: Boşluk oynat, C mod değiştir, I/O giriş/çıkış, Enter ekle, S ekran görüntüsü.
 */
export function Timeline({
  src,
  duration,
  frames = [],
  markers = [],
  cuts,
  onCutsChange,
  aspect = 'h',
  onSnapshot,
}: {
  src: string;
  duration: number;
  frames?: Frame[];
  markers?: Marker[];
  cuts: Cut[];
  onCutsChange: (cuts: Cut[]) => void;
  aspect?: 'h' | 'v';
  /** Verilirse "Ekran görüntüsü" düğmesi görünür; o anki saniyeyle çağrılır. */
  onSnapshot?: (t: number) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(FIT_ZOOM);
  const [mode, setMode] = useState<'izle' | 'kes'>('izle');
  const [mark, setMark] = useState<{ in: number | null; out: number | null }>({ in: null, out: null });
  const [active, setActive] = useState<string | null>(null);
  const total = Math.max(1, duration);

  // Yakınlaştırma 1x'te tüm yayın görünür; her kademe iki katı.
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pxPerSec = (width / total) * ZOOMS[zoomIndex];
  const trackWidth = total * pxPerSec;

  const toSec = useCallback(
    (clientX: number) => {
      const rect = track.current!.getBoundingClientRect();
      return Math.max(0, Math.min(total, (clientX - rect.left) / pxPerSec));
    },
    [pxPerSec, total],
  );

  const seek = (t: number) => {
    if (video.current) video.current.currentTime = t;
    setNow(t);
  };

  const update = (id: string, patch: Partial<Cut>) => onCutsChange(cuts.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const addCut = (start: number, end: number) => {
    const s = Math.max(0, Math.min(start, end));
    const e = Math.min(total, Math.max(start, end));
    if (e - s < MIN_CUT) return;
    const cut = newCut(s, e, cuts.length);
    onCutsChange([...cuts, cut]);
    setActive(cut.id);
  };

  /* ── İşaretçi olayları ──────────────────────────────────────────────── */

  const onTrackDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const t = toSec(e.clientX);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (mode === 'izle' || e.altKey || e.shiftKey) {
      drag.current = { kind: 'scrub' };
      seek(t);
      return;
    }
    const cut = newCut(t, t, cuts.length);
    drag.current = { kind: 'create', anchor: t, id: cut.id };
    onCutsChange([...cuts, cut]);
    setActive(cut.id);
  };

  const onCutDown = (e: ReactPointerEvent, cut: Cut, kind: 'move' | 'start' | 'end') => {
    e.stopPropagation();
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setActive(cut.id);
    drag.current = kind === 'move' ? { kind, id: cut.id, offset: toSec(e.clientX) - cut.start, length: cut.end - cut.start } : { kind, id: cut.id };
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = toSec(e.clientX);
    if (d.kind === 'seek' || d.kind === 'scrub') return seek(t);
    if (d.kind === 'create') return update(d.id, { start: Math.min(d.anchor, t), end: Math.max(d.anchor, t) });
    const cut = cuts.find((c) => c.id === d.id);
    if (!cut) return;
    if (d.kind === 'move') {
      const start = Math.max(0, Math.min(total - d.length, t - d.offset));
      update(d.id, { start, end: start + d.length });
    } else if (d.kind === 'start') update(d.id, { start: Math.min(t, cut.end - MIN_CUT) });
    else update(d.id, { end: Math.max(t, cut.start + MIN_CUT) });
  };

  const onUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'create') {
      const cut = cuts.find((c) => c.id === d.id);
      // Kısa tıklama kesit değil, oynatma konumu demek.
      if (!cut || cut.end - cut.start < MIN_CUT) {
        onCutsChange(cuts.filter((c) => c.id !== d.id));
        setActive(null);
        seek(toSec(e.clientX));
      }
    }
  };

  /* ── Klavye ─────────────────────────────────────────────────────────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const v = video.current;
      if (!v) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (v.paused) void v.play();
        else v.pause();
      } else if (e.key === 'c' || e.key === 'C') setMode((m) => (m === 'izle' ? 'kes' : 'izle'));
      else if ((e.key === 's' || e.key === 'S') && onSnapshot) onSnapshot(v.currentTime);
      else if (e.key === 'i' || e.key === 'I') setMark((m) => ({ ...m, in: v.currentTime }));
      else if (e.key === 'o' || e.key === 'O') setMark((m) => ({ ...m, out: v.currentTime }));
      else if (e.key === 'Enter' && mark.in !== null && mark.out !== null) {
        addCut(mark.in, mark.out);
        setMark({ in: null, out: null });
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && active) {
        onCutsChange(cuts.filter((c) => c.id !== active));
        setActive(null);
      } else if (e.key === 'ArrowLeft') seek(Math.max(0, v.currentTime - (e.shiftKey ? 10 : 2)));
      else if (e.key === 'ArrowRight') seek(Math.min(total, v.currentTime + (e.shiftKey ? 10 : 2)));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // Oynatma başı görünür kalsın (yakınlaştırılmışken).
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const x = now * pxPerSec;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - 40;
  }, [now, pxPerSec, playing]);

  const ruler = useMemo(() => {
    const steps = [5, 10, 30, 60, 120, 300, 600, 1800, 3600];
    const step = steps.find((s) => s * pxPerSec >= 90) ?? 3600;
    return Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
  }, [pxPerSec, total]);

  const frameW = frames.length ? Math.max(40, (frames[1]?.t ?? total) * pxPerSec - (frames[0]?.t ?? 0) * pxPerSec) : 0;

  return (
    <div className="timeline">
      <div className={aspect === 'v' ? 'stage stage-v' : 'stage stage-h'}>
        <video
          ref={video}
          className="stage-video"
          src={src}
          preload="metadata"
          playsInline
          onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause())}
        />
      </div>

      <div className="transport">
        <button type="button" className="btn btn-primary btn-icon" onClick={() => (video.current?.paused ? void video.current.play() : video.current?.pause())} aria-label={playing ? 'Duraklat' : 'Oynat'}>
          <Icon name={playing ? 'pause' : 'play'} size={16} />
        </button>
        <span className="timecode">
          {stamp(now)} <span className="muted">/ {fmtDuration(total)}</span>
        </span>
        <div className="mode-switch" role="radiogroup" aria-label="Şerit modu">
          <button type="button" role="radio" aria-checked={mode === 'izle'} className={mode === 'izle' ? 'mode-on' : ''} onClick={() => setMode('izle')} title="Şeride tıklayınca oraya gider (C)">
            <Icon name="play" size={12} /> İzle
          </button>
          <button type="button" role="radio" aria-checked={mode === 'kes'} className={mode === 'kes' ? 'mode-on' : ''} onClick={() => setMode('kes')} title="Şeritte sürükleyince kesit seçer (C)">
            <Icon name="scissors" size={12} /> Kesit seç
          </button>
        </div>
        {onSnapshot && (
          <button type="button" className="btn btn-secondary btn-small" onClick={() => onSnapshot(video.current?.currentTime ?? now)} title="Bu saniyenin ekran görüntüsünü al (S)">
            <Icon name="image" size={14} /> Ekran görüntüsü
          </button>
        )}
        <div className="transport-marks">
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setMark((m) => ({ ...m, in: now }))} title="Kesitin başlangıcı (I)">
            Başlangıç {mark.in !== null && <b>{fmtDuration(mark.in)}</b>}
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setMark((m) => ({ ...m, out: now }))} title="Kesitin bitişi (O)">
            Bitiş {mark.out !== null && <b>{fmtDuration(mark.out)}</b>}
          </button>
          <button
            type="button"
            className="btn btn-accent btn-small"
            disabled={mark.in === null || mark.out === null}
            onClick={() => {
              addCut(mark.in!, mark.out!);
              setMark({ in: null, out: null });
            }}
            title="Kesit ekle (Enter)"
          >
            <Icon name="plus" size={14} /> Kesit
          </button>
        </div>
        <div className="transport-zoom" role="group" aria-label="Yakınlaştırma">
          <button type="button" className="btn btn-quiet btn-icon" onClick={() => setZoomIndex((z) => Math.max(0, z - 1))} disabled={zoomIndex === 0} aria-label="Uzaklaştır">
            −
          </button>
          <span className="muted">{ZOOMS[zoomIndex].toLocaleString('tr-TR')}x</span>
          <button type="button" className="btn btn-quiet btn-icon" onClick={() => setZoomIndex((z) => Math.min(ZOOMS.length - 1, z + 1))} disabled={zoomIndex === ZOOMS.length - 1} aria-label="Yakınlaştır">
            +
          </button>
        </div>
      </div>

      <div className="track-scroller" ref={scroller}>
        <div className={mode === 'kes' ? 'track track-cut-mode' : 'track'} ref={track} style={{ width: trackWidth }} onPointerDown={onTrackDown} onPointerMove={onMove} onPointerUp={onUp}>
          <div className="track-ruler" aria-hidden="true">
            {ruler.map((t) => (
              <span key={t} style={{ left: t * pxPerSec }}>
                {fmtDuration(t)}
              </span>
            ))}
          </div>
          <div className="track-film" aria-hidden="true">
            {frames.map((f) => (
              <img key={f.t} src={f.url} alt="" style={{ left: f.t * pxPerSec, width: frameW }} draggable={false} />
            ))}
          </div>
          {markers.map((m, i) => (
            <span key={i} className="track-marker" style={{ left: m.start * pxPerSec, width: Math.max(3, (m.end - m.start) * pxPerSec) }} title={m.label ?? 'Öne çıkan an'} />
          ))}
          {mark.in !== null && <span className="track-mark track-mark-in" style={{ left: mark.in * pxPerSec }} />}
          {mark.out !== null && <span className="track-mark track-mark-out" style={{ left: mark.out * pxPerSec }} />}
          {cuts.map((c) => (
            <div
              key={c.id}
              className={active === c.id ? 'track-cut track-cut-active' : 'track-cut'}
              style={{ left: c.start * pxPerSec, width: Math.max(4, (c.end - c.start) * pxPerSec), '--cut': c.color } as React.CSSProperties}
              onPointerDown={(e) => onCutDown(e, c, 'move')}
              onDoubleClick={() => seek(c.start)}
            >
              <span className="track-cut-handle track-cut-handle-l" onPointerDown={(e) => onCutDown(e, c, 'start')} />
              <span className="track-cut-label">{fmtDuration(c.end - c.start)}</span>
              <span className="track-cut-handle track-cut-handle-r" onPointerDown={(e) => onCutDown(e, c, 'end')} />
            </div>
          ))}
          <span
            className="track-playhead"
            style={{ left: now * pxPerSec }}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.target as Element).setPointerCapture?.(e.pointerId);
              drag.current = { kind: 'scrub' };
            }}
            aria-hidden="true"
          />
        </div>
      </div>
      <p className="timeline-hint">
        {mode === 'izle' ? 'İzle modu: şeride tıkla ya da çizgiyi tutup sürükle' : 'Kesit seç modu: şeritte sürükleyerek kesit çiz'} · kesiti taşı ya da kenarından uzat · <kbd>C</kbd> mod değiştir · <kbd>Boşluk</kbd> oynat · <kbd>I</kbd>/<kbd>O</kbd> başlangıç/bitiş · <kbd>Enter</kbd> kesit ekle
        {onSnapshot ? <> · <kbd>S</kbd> ekran görüntüsü</> : null} · <kbd>Sil</kbd> kesiti kaldır
      </p>
    </div>
  );
}

/** Kesit listesi: her kesidin süresi, oynatma ve silme. */
export function CutList({ cuts, onChange, onPlay }: { cuts: Cut[]; onChange: (cuts: Cut[]) => void; onPlay?: (c: Cut) => void }) {
  if (!cuts.length) return <p className="muted">Henüz kesit yok. "Kesit seç" moduna geçip şeritte sürükle ya da Başlangıç/Bitiş ile ekle.</p>;
  return (
    <ol className="cut-list">
      {[...cuts]
        .sort((a, b) => a.start - b.start)
        .map((c, i) => (
          <li key={c.id} style={{ '--cut': c.color } as React.CSSProperties}>
            <span className="cut-swatch" aria-hidden="true" />
            <span className="cut-name">Kesit {i + 1}</span>
            <span className="muted">
              {fmtDuration(c.start)} – {fmtDuration(c.end)}
            </span>
            <b>{fmtDuration(c.end - c.start)}</b>
            {onPlay && (
              <button type="button" className="btn btn-quiet btn-icon" onClick={() => onPlay(c)} aria-label="Kesite git">
                <Icon name="play" size={12} />
              </button>
            )}
            <button type="button" className="btn btn-quiet btn-icon" onClick={() => onChange(cuts.filter((x) => x.id !== c.id))} aria-label="Kesiti kaldır">
              <Icon name="x" size={14} />
            </button>
          </li>
        ))}
    </ol>
  );
}
