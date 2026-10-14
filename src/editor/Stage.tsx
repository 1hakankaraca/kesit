import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { FORMAT_SIZE, timelineCaptions, type Clip, type Project, type Rect } from '../../shared/project.ts';
import { subtitleBox } from '../lib/frame.ts';
import { assetOf, clampFrame, clipEnd, trackOf } from './model.ts';
import { TEXT_FONTS, TEXT_LINE, TEXT_PAD_X, TEXT_PAD_Y, TEXT_RADIUS, TEXT_STROKE } from './textRender.ts';

/** Parçanın görünür olması için önceden yüklenmeye başlanacağı pay (sn). */
const PRELOAD_SEC = 3;
const SNAP = 0.012;
const SNAP_LINES = [0, 0.5, 1];

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Önizleme sahnesi: zaman çizelgesindeki görünür parçaları katman katman
 * çizer (video/görsel/yazı), sesleri çalar, altyazıyı basar. Seçili parça
 * sürüklenip boyutlanır; orta ve kenarlara yapışır.
 */
export function Stage({
  project,
  time,
  playing,
  selectedId,
  subtitleStyle,
  onSelect,
  onFrame,
  onBegin,
  onEnd,
}: {
  project: Project;
  time: number;
  playing: boolean;
  selectedId: string | null;
  subtitleStyle: string;
  onSelect: (id: string | null) => void;
  onFrame: (id: string, frame: Rect) => void;
  onBegin: () => void;
  onEnd: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const media = useRef(new Map<string, HTMLMediaElement>());
  const bind = (id: string) => (el: HTMLMediaElement | null) => {
    if (el) media.current.set(id, el);
    else media.current.delete(id);
  };
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const drag = useRef<{ id: string; mode: 'move' | Handle; start: Rect; px: number; py: number; aspect: number } | null>(null);
  const vertical = project.format === 'vertical';
  const { w: W, h: H } = FORMAT_SIZE[project.format];

  const trackIndex = useMemo(() => new Map(project.tracks.map((t, i) => [t.id, i])), [project.tracks]);
  const hidden = useMemo(() => new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id)), [project.tracks]);
  const mutedTracks = useMemo(() => new Set(project.tracks.filter((t) => t.muted).map((t) => t.id)), [project.tracks]);

  // Yüklü tutulacak parçalar: şu an görünenler + az sonra gelecekler.
  const mounted = useMemo(
    () => project.clips.filter((c) => !hidden.has(c.trackId) && time >= c.start - PRELOAD_SEC && time < clipEnd(c) + 0.5).sort((a, b) => (trackIndex.get(a.trackId) ?? 0) - (trackIndex.get(b.trackId) ?? 0)),
    [project.clips, hidden, time, trackIndex],
  );

  /* ── Oynatma eşitleme ───────────────────────────────────────────────── */
  useEffect(() => {
    for (const c of mounted) {
      const el = media.current.get(c.id);
      if (!el) continue;
      const active = time >= c.start && time < clipEnd(c);
      const desired = c.in + (time - c.start);
      el.muted = c.muted || mutedTracks.has(c.trackId) || c.volume <= 0;
      el.volume = Math.max(0, Math.min(1, c.volume));
      if (!active) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - Math.max(0, desired)) > 0.3) el.currentTime = Math.max(0, Math.min(desired, c.in));
        continue;
      }
      if (playing) {
        if (Math.abs(el.currentTime - desired) > 0.25) el.currentTime = desired;
        if (el.paused) void el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - desired) > 0.04) el.currentTime = desired;
      }
    }
  }, [mounted, time, playing, mutedTracks]);

  useEffect(() => {
    const map = media.current;
    for (const [id, el] of map) if (!mounted.some((c) => c.id === id)) {
      el.pause();
      map.delete(id);
    }
  }, [mounted]);

  /* ── Seçim ve dönüştürme ────────────────────────────────────────────── */
  const pointer = (e: ReactPointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onDown = (e: ReactPointerEvent, clip: Clip, mode: 'move' | Handle) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect(clip.id);
    box.current!.setPointerCapture(e.pointerId);
    const p = pointer(e);
    drag.current = { id: clip.id, mode, start: clip.frame, px: p.x, py: p.y, aspect: (clip.frame.w * W) / (clip.frame.h * H) };
    onBegin();
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = pointer(e);
    const dx = p.x - d.px;
    const dy = p.y - d.py;
    const s = d.start;
    let next: Rect;
    let gx: number | null = null;
    let gy: number | null = null;
    if (d.mode === 'move') {
      next = { ...s, x: s.x + dx, y: s.y + dy };
      if (!e.altKey) {
        for (const line of SNAP_LINES) {
          for (const [edge, off] of [
            [next.x, 0],
            [next.x + next.w / 2, next.w / 2],
            [next.x + next.w, next.w],
          ] as const) {
            if (Math.abs(edge - line) < SNAP) {
              next.x = line - off;
              gx = line;
            }
          }
          for (const [edge, off] of [
            [next.y, 0],
            [next.y + next.h / 2, next.h / 2],
            [next.y + next.h, next.h],
          ] as const) {
            if (Math.abs(edge - line) < SNAP) {
              next.y = line - off;
              gy = line;
            }
          }
        }
      }
    } else {
      const m = d.mode;
      let x = s.x;
      let y = s.y;
      let w = s.w;
      let h = s.h;
      if (m.includes('e')) w = s.w + dx;
      if (m.includes('s')) h = s.h + dy;
      if (m.includes('w')) {
        w = s.w - dx;
        x = s.x + dx;
      }
      if (m.includes('n')) {
        h = s.h - dy;
        y = s.y + dy;
      }
      // Köşeden oran korunur (Alt ile serbest); kenardan tek eksen.
      const corner = m.length === 2;
      if (corner && !e.altKey) {
        const ratio = d.aspect * (H / W); // kare oranı cinsinden w/h
        if (Math.abs(dx) > Math.abs(dy)) h = w / ratio;
        else w = h * ratio;
        if (m.includes('w')) x = s.x + s.w - w;
        if (m.includes('n')) y = s.y + s.h - h;
      }
      next = { x, y, w: Math.max(0.02, w), h: Math.max(0.02, h) };
    }
    setGuides({ x: gx, y: gy });
    onFrame(d.id, clampFrame(next));
  };

  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setGuides({ x: null, y: null });
    onEnd();
  };

  /* ── Altyazı ────────────────────────────────────────────────────────── */
  const captions = useMemo(() => (project.subtitles.enabled ? timelineCaptions(project) : []), [project]);
  const caption = captions.find((c) => time >= c.start && time < c.end);
  const sub = subtitleBox(project.format, subtitleStyle, null, 'seam', false);

  const pct = (v: number) => `${v * 100}%`;
  const selected = project.clips.find((c) => c.id === selectedId) ?? null;
  const selectedVisible = selected && mounted.includes(selected) && time >= selected.start && time < clipEnd(selected);

  return (
    <div className={vertical ? 'estage estage-v' : 'estage estage-h'}>
      <div
        ref={box}
        className="estage-canvas"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onSelect(null);
        }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {mounted.map((c) => {
          const active = time >= c.start && time < clipEnd(c);
          const asset = assetOf(project, c);
          const z = (trackIndex.get(c.trackId) ?? 0) + 1;
          const filter = `brightness(${1 + c.color.brightness}) contrast(${c.color.contrast}) saturate(${c.color.saturation}) hue-rotate(${c.color.hue}deg)`;
          const layerStyle: CSSProperties = { left: pct(c.frame.x), top: pct(c.frame.y), width: pct(c.frame.w), height: pct(c.frame.h), zIndex: z, opacity: c.opacity, display: active ? undefined : 'none' };
          const mediaStyle: CSSProperties = { width: pct(1 / c.crop.w), height: pct(1 / c.crop.h), left: pct(-c.crop.x / c.crop.w), top: pct(-c.crop.y / c.crop.h), filter };
          if (c.kind === 'audio') {
            return asset ? <audio key={c.id} ref={bind(c.id)} src={`/api/projects/${project.id}/assets/${asset.id}/stream`} preload="auto" /> : null;
          }
          return (
            <div key={c.id} className={c.id === selectedId ? 'elayer elayer-on' : 'elayer'} style={layerStyle} onPointerDown={(e) => onDown(e, c, 'move')}>
              {c.kind === 'text' && c.text ? (
                <TextLayer clip={c} />
              ) : asset?.kind === 'image' ? (
                <img src={`/api/projects/${project.id}/assets/${asset.id}/stream`} alt="" draggable={false} style={mediaStyle} />
              ) : asset ? (
                <video ref={bind(c.id)} src={`/api/projects/${project.id}/assets/${asset.id}/stream`} preload="auto" playsInline style={mediaStyle} />
              ) : null}
            </div>
          );
        })}

        {selected && selectedVisible && (
          <div className="esel" style={{ left: pct(selected.frame.x), top: pct(selected.frame.y), width: pct(selected.frame.w), height: pct(selected.frame.h) }} onPointerDown={(e) => onDown(e, selected, 'move')}>
            {HANDLES.map((h) => (
              <span key={h} className={`esel-h esel-${h}`} onPointerDown={(e) => onDown(e, selected, h)} />
            ))}
          </div>
        )}

        {guides.x !== null && <span className="frame-snap frame-snap-v" style={{ left: pct(guides.x) }} aria-hidden="true" />}
        {guides.y !== null && <span className="frame-snap frame-snap-h" style={{ top: pct(guides.y) }} aria-hidden="true" />}

        {caption && (
          <p className={`frame-sub sub-${subtitleStyle}`} style={{ bottom: pct(sub.bottom), fontSize: `${sub.fontCqi}cqi` }}>
            {caption.text}
          </p>
        )}
        {!mounted.length && (
          <div className="estage-empty">
            <b>Sahne boş</b>
            <span>Soldan video, görsel ya da yazı ekle</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Yazı katmanı — dışa aktarmadaki çizimle aynı ölçüler. */
function TextLayer({ clip }: { clip: Clip }) {
  const t = clip.text!;
  const style: CSSProperties = {
    fontFamily: TEXT_FONTS[t.font],
    fontSize: `${t.size * 100}cqh`,
    fontWeight: t.bold ? 700 : 400,
    fontStyle: t.italic ? 'italic' : 'normal',
    color: t.color,
    background: t.background ?? 'transparent',
    padding: `${TEXT_PAD_Y}em ${TEXT_PAD_X}em`,
    borderRadius: `${TEXT_RADIUS}em`,
    lineHeight: TEXT_LINE,
    textAlign: t.align,
    WebkitTextStroke: t.outline ? `${TEXT_STROKE}em rgba(0,0,0,0.85)` : undefined,
    paintOrder: 'stroke fill',
  };
  return (
    <div className={`etext etext-${t.align}`}>
      <span style={style}>{t.content}</span>
    </div>
  );
}

export function activeClipsAt(project: Project, time: number) {
  return project.clips.filter((c) => time >= c.start && time < clipEnd(c) && !trackOf(project, c)?.hidden);
}
