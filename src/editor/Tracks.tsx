import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Clip, Project, Track } from '../../shared/project.ts';
import { Icon } from '../components/Icon.tsx';
import { duration as fmtDuration } from '../lib/format.ts';
import { assetOf, clipEnd, moveClip, snapTime, trimEnd, trimStart, updateTrack } from './model.ts';

const ZOOMS = [2, 4, 8, 15, 25, 40, 60, 100, 160, 260];
const HEADER_W = 164;
const SNAP_PX = 9;
const ROW_H = { video: 58, audio: 40 } as const;

type Drag =
  | { kind: 'move'; id: string; offset: number; fromTrack: string }
  | { kind: 'start' | 'end'; id: string }
  | { kind: 'seek' };

/**
 * Çok yollu zaman çizelgesi. Üstte cetvel, her yol için bir satır; parçalar
 * sürüklenir, kenarından kısaltılır, yollar arasında taşınır. Oynatma
 * çizgisi cetvelden ya da boş alandan tutulur.
 */
export function Tracks({
  project,
  time,
  selectedId,
  onSelect,
  onSeek,
  onChange,
  onBegin,
  onEnd,
  onDropAt,
}: {
  project: Project;
  time: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onSeek: (t: number) => void;
  onChange: (fn: (p: Project) => Project, record?: boolean) => void;
  onBegin: () => void;
  onEnd: () => void;
  /** Kütüphaneden sürüklenen varlık bırakıldığında (varlık kimliği, saniye, yol). */
  onDropAt: (assetId: string, at: number, trackId: string | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const lanes = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [zoomIndex, setZoomIndex] = useState(4);
  const [snap, setSnap] = useState(true);
  const pps = ZOOMS[zoomIndex];
  const total = Math.max(30, project.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0) + 20);
  const width = total * pps;

  // Görüntü yolları üstte (son eklenen en üstte), ses yolları altta.
  const rows = useMemo(() => [...project.tracks.filter((t) => t.kind === 'video')].reverse().concat(project.tracks.filter((t) => t.kind === 'audio')), [project.tracks]);

  const toSec = useCallback(
    (clientX: number) => {
      const r = lanes.current!.getBoundingClientRect();
      return Math.max(0, (clientX - r.left) / pps);
    },
    [pps],
  );

  const trackAt = (clientY: number): Track | null => {
    const els = lanes.current?.querySelectorAll<HTMLElement>('[data-track]') ?? [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return project.tracks.find((t) => t.id === el.dataset.track) ?? null;
    }
    return null;
  };

  const snapPoints = useMemo(() => {
    const pts = [0, time];
    for (const c of project.clips) pts.push(c.start, clipEnd(c));
    return pts;
  }, [project.clips, time]);

  const snapped = (t: number, exclude?: Clip) => {
    if (!snap) return t;
    const pts = exclude ? snapPoints.filter((p) => p !== exclude.start && p !== clipEnd(exclude)) : snapPoints;
    return snapTime(t, pts, SNAP_PX / pps);
  };

  /* ── İşaretçi ────────────────────────────────────────────────────────── */

  const onClipDown = (e: ReactPointerEvent, clip: Clip, kind: 'move' | 'start' | 'end') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    onSelect(clip.id);
    drag.current = kind === 'move' ? { kind, id: clip.id, offset: toSec(e.clientX) - clip.start, fromTrack: clip.trackId } : { kind, id: clip.id };
    onBegin();
  };

  const onLaneDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { kind: 'seek' };
    onSelect(null);
    onSeek(toSec(e.clientX));
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = toSec(e.clientX);
    if (d.kind === 'seek') return onSeek(t);
    const clip = project.clips.find((c) => c.id === d.id);
    if (!clip) return;
    if (d.kind === 'move') {
      const raw = Math.max(0, t - d.offset);
      // Başlangıç ya da bitiş kenarı yapışabilir.
      const s1 = snapped(raw, clip);
      const s2 = snapped(raw + clip.duration, clip) - clip.duration;
      const start = Math.abs(s1 - raw) <= Math.abs(s2 - raw) ? s1 : s2;
      const track = trackAt(e.clientY);
      onChange((p) => moveClip(p, d.id, start, track?.id), false);
    } else if (d.kind === 'start') onChange((p) => trimStart(p, d.id, snapped(t, clip)), false);
    else onChange((p) => trimEnd(p, d.id, snapped(t, clip)), false);
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.kind !== 'seek') onEnd();
  };

  // Oynatma çizgisi görünür kalsın.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const x = time * pps + HEADER_W;
    if (x < el.scrollLeft + HEADER_W || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
  }, [time, pps]);

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoomIndex((z) => Math.max(0, Math.min(ZOOMS.length - 1, z + (e.deltaY < 0 ? 1 : -1))));
  };

  const ruler = useMemo(() => {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => s * pps >= 80) ?? 600;
    return Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
  }, [pps, total]);

  return (
    <div className="tl">
      <div className="tl-tools">
        <label className="tl-check">
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Yapış
        </label>
        <div className="transport-zoom" role="group" aria-label="Yakınlaştırma">
          <button type="button" className="btn btn-quiet btn-icon" onClick={() => setZoomIndex((z) => Math.max(0, z - 1))} disabled={zoomIndex === 0} aria-label="Uzaklaştır">
            −
          </button>
          <input type="range" className="tl-zoom" min={0} max={ZOOMS.length - 1} value={zoomIndex} onChange={(e) => setZoomIndex(Number(e.target.value))} aria-label="Yakınlaştırma" />
          <button type="button" className="btn btn-quiet btn-icon" onClick={() => setZoomIndex((z) => Math.min(ZOOMS.length - 1, z + 1))} disabled={zoomIndex === ZOOMS.length - 1} aria-label="Yakınlaştır">
            +
          </button>
        </div>
      </div>
      <div className="tl-scroller" ref={scroller} onWheel={onWheel}>
        <div className="tl-inner" style={{ width: width + HEADER_W }}>
          <div className="tl-ruler-row">
            <div className="tl-head tl-head-ruler" />
            <div className="tl-ruler" style={{ width }} onPointerDown={onLaneDown} onPointerMove={onMove} onPointerUp={onUp}>
              {ruler.map((t) => (
                <span key={t} style={{ left: t * pps }}>
                  {fmtDuration(t)}
                </span>
              ))}
            </div>
          </div>
          <div className="tl-lanes" ref={lanes}>
            {rows.map((track) => (
              <div key={track.id} className={`tl-row tl-row-${track.kind}${track.hidden ? ' tl-row-hidden' : ''}`} style={{ height: ROW_H[track.kind] }} data-track={track.id}>
                <div className="tl-head">
                  <span className="tl-head-name" title={track.name}>
                    <Icon name={track.kind === 'audio' ? 'music' : 'layers'} size={13} /> {track.name}
                  </span>
                  <span className="tl-head-btns">
                    {track.kind === 'video' && (
                      <button type="button" className={track.hidden ? 'tl-tog tl-tog-on' : 'tl-tog'} onClick={() => onChange((p) => updateTrack(p, track.id, { hidden: !track.hidden }))} title={track.hidden ? 'Göster' : 'Gizle'} aria-label="Görünürlük">
                        <Icon name="eye" size={13} />
                      </button>
                    )}
                    <button type="button" className={track.muted ? 'tl-tog tl-tog-on' : 'tl-tog'} onClick={() => onChange((p) => updateTrack(p, track.id, { muted: !track.muted }))} title={track.muted ? 'Sesi aç' : 'Sessize al'} aria-label="Ses">
                      <Icon name={track.muted ? 'mute' : 'volume'} size={13} />
                    </button>
                  </span>
                </div>
                <div
                  className="tl-lane"
                  style={{ width }}
                  onPointerDown={onLaneDown}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes('kesit/asset')) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'copy';
                    }
                  }}
                  onDrop={(e) => {
                    const id = e.dataTransfer.getData('kesit/asset');
                    if (!id) return;
                    e.preventDefault();
                    onDropAt(id, snapped(toSec(e.clientX)), track.id);
                  }}
                >
                  {project.clips
                    .filter((c) => c.trackId === track.id)
                    .map((c) => (
                      <ClipBlock key={c.id} clip={c} project={project} pps={pps} selected={c.id === selectedId} onDown={onClipDown} />
                    ))}
                </div>
              </div>
            ))}
          </div>
          <span className="tl-playhead" style={{ left: HEADER_W + time * pps }} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

function ClipBlock({ clip, project, pps, selected, onDown }: { clip: Clip; project: Project; pps: number; selected: boolean; onDown: (e: ReactPointerEvent, clip: Clip, kind: 'move' | 'start' | 'end') => void }) {
  const asset = assetOf(project, clip);
  const label = clip.kind === 'text' ? clip.text?.content || 'Yazı' : asset?.name || 'Parça';
  const thumb = asset?.thumb && clip.kind !== 'audio' ? `url("${asset.thumb}")` : undefined;
  return (
    <div
      className={`tclip tclip-${clip.kind}${selected ? ' tclip-on' : ''}`}
      style={{ left: clip.start * pps, width: Math.max(6, clip.duration * pps), backgroundImage: thumb }}
      onPointerDown={(e) => onDown(e, clip, 'move')}
      title={`${label} · ${fmtDuration(clip.duration)}`}
    >
      <span className="tclip-h tclip-h-l" onPointerDown={(e) => onDown(e, clip, 'start')} />
      <span className="tclip-label">
        <Icon name={clip.kind === 'text' ? 'text' : clip.kind === 'audio' ? 'music' : clip.kind === 'image' ? 'image' : 'film'} size={12} />
        {label}
        {clip.captions && <i className="tclip-cc">CC</i>}
      </span>
      <span className="tclip-h tclip-h-r" onPointerDown={(e) => onDown(e, clip, 'end')} />
    </div>
  );
}
