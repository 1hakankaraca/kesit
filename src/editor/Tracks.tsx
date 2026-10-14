import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Clip, Project, Track } from '../../shared/project.ts';
import { Icon, type IconName } from '../components/Icon.tsx';
import { duration as fmtDuration, stamp } from '../lib/format.ts';
import { assetOf, atSourceEnd, clipEnd, mainTrackId, moveClip, snapTime, trimEnd, trimStart, updateTrack } from './model.ts';

const ZOOMS = [2, 4, 8, 15, 25, 40, 60, 100, 160, 260];
const HEADER_W = 164;
const SNAP_PX = 9;
const ROW_H = { video: 58, audio: 40 } as const;

type Drag =
  | { kind: 'move'; id: string; offset: number; fromTrack: string }
  | { kind: 'start' | 'end'; id: string }
  | { kind: 'seek' };

export interface TimelineTool {
  key: string;
  icon?: IconName;
  label: string;
  title: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

/** Sağ tık menüsü ögesi. */
export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

/**
 * Çok yollu zaman çizelgesi. Üstte araç şeridi ve cetvel, her yol için bir
 * satır; parçalar sürüklenir, kenarından kısaltılır, yollar arasında taşınır.
 * Yapışma yalnız görünür alandaki hedeflere olur ve kılavuz çizgisi gösterir.
 */
export function Tracks({
  project,
  time,
  selectedId,
  magnetic,
  tools,
  leading,
  onSelect,
  onSeek,
  onChange,
  onBegin,
  onEnd,
  onDropAt,
  onMenu,
}: {
  project: Project;
  time: number;
  selectedId: string | null;
  magnetic: boolean;
  tools: TimelineTool[];
  /** Araç şeridinin sol başı (geri/ileri vb.) */
  leading?: ReactNode;
  onSelect: (id: string | null) => void;
  onSeek: (t: number) => void;
  onChange: (fn: (p: Project) => Project, record?: boolean) => void;
  onBegin: () => void;
  onEnd: () => void;
  onDropAt: (assetId: string, at: number, trackId: string | null) => void;
  onMenu: (clip: Clip) => MenuItem[];
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const lanes = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [zoomIndex, setZoomIndex] = useState(4);
  const [snap, setSnap] = useState(true);
  const [guide, setGuide] = useState<number | null>(null);
  const [trimTip, setTrimTip] = useState<{ x: number; text: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [view, setView] = useState({ left: 0, width: 800 });
  const pps = ZOOMS[zoomIndex];
  const total = Math.max(30, project.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0) + 20);
  const width = total * pps;
  const main = mainTrackId(project);

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

  // Görünür alandaki yapışma hedefleri (img.ly: ekran dışı hedefler şaşırtır).
  const snapPoints = useMemo(() => {
    const from = view.left / pps - 1;
    const to = (view.left + view.width) / pps + 1;
    const pts = [0, time];
    for (const c of project.clips) pts.push(c.start, clipEnd(c));
    return pts.filter((t) => t >= from && t <= to);
  }, [project.clips, time, view, pps]);

  const snapped = (t: number, exclude?: Clip) => {
    if (!snap) return { value: t, snapped: null as number | null };
    const pts = exclude ? snapPoints.filter((p) => p !== exclude.start && p !== clipEnd(exclude)) : snapPoints;
    return snapTime(t, pts, SNAP_PX / pps);
  };

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setView({ left: el.scrollLeft, width: el.clientWidth });
    update();
    el.addEventListener('scroll', update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  /* ── İşaretçi ────────────────────────────────────────────────────────── */

  const onClipDown = (e: ReactPointerEvent, clip: Clip, kind: 'move' | 'start' | 'end') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    onSelect(clip.id);
    drag.current = kind === 'move' ? { kind, id: clip.id, offset: toSec(e.clientX) - clip.start, fromTrack: clip.trackId } : { kind, id: clip.id };
    onBegin();
  };

  /** Boş alana tıklama seçimi kaldırır; cetvele tıklama yalnız oynatma çizgisini taşır (seçim kalır). */
  const onLaneDown = (e: ReactPointerEvent, keepSelection = false) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { kind: 'seek' };
    if (!keepSelection) onSelect(null);
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
      const s1 = snapped(raw, clip);
      const s2 = snapped(raw + clip.duration, clip);
      const useStart = Math.abs(s1.value - raw) <= Math.abs(s2.value - clip.duration - raw);
      const start = useStart ? s1.value : s2.value - clip.duration;
      setGuide(useStart ? s1.snapped : s2.snapped);
      const track = trackAt(e.clientY);
      onChange((p) => moveClip(p, d.id, start, track?.id, magnetic), false);
    } else if (d.kind === 'start') {
      const s = snapped(t, clip);
      setGuide(s.snapped);
      setTrimTip({ x: s.value * pps, text: stamp(s.value) });
      onChange((p) => trimStart(p, d.id, s.value, magnetic), false);
    } else {
      const s = snapped(t, clip);
      setGuide(s.snapped);
      setTrimTip({ x: s.value * pps, text: stamp(s.value) });
      onChange((p) => trimEnd(p, d.id, s.value, magnetic), false);
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setGuide(null);
    setTrimTip(null);
    if (d && d.kind !== 'seek') onEnd();
  };

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const x = time * pps + HEADER_W;
    if (x < el.scrollLeft + HEADER_W || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
  }, [time, pps]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menu]);

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

  const empty = project.clips.length === 0;

  return (
    <div className="tl">
      <div className="tl-tools">
        {leading}
        <span className="tl-sep" />
        {tools.filter((t) => t.key !== 'magnetic').map((t) => (
          <button key={t.key} type="button" className={`tl-tool${t.danger ? ' tl-tool-danger' : ''}`} disabled={t.disabled} onClick={t.run} title={t.title}>
            {t.icon && <Icon name={t.icon} size={14} />}
            <span>{t.label}</span>
          </button>
        ))}
        <span className="tl-grow" />
        <label className="tl-check" title="Ana yolda parçalar hep art arda durur; silme boşluk bırakmaz">
          <input type="checkbox" checked={magnetic} readOnly onClick={() => tools.find((t) => t.key === 'magnetic')?.run()} /> Mıknatıs
        </label>
        <label className="tl-check" title="Parçalar birbirinin kenarına ve oynatma çizgisine yapışır">
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
            <div className="tl-ruler" style={{ width }} onPointerDown={(e) => onLaneDown(e, true)} onPointerMove={onMove} onPointerUp={onUp}>
              {ruler.map((t) => (
                <span key={t} style={{ left: t * pps }}>
                  {fmtDuration(t)}
                </span>
              ))}
            </div>
          </div>
          <div className="tl-lanes" ref={lanes}>
            {rows.map((track) => (
              <div key={track.id} className={`tl-row tl-row-${track.kind}${track.hidden ? ' tl-row-hidden' : ''}${track.id === main ? ' tl-row-main' : ''}`} style={{ height: ROW_H[track.kind] }} data-track={track.id}>
                <div className="tl-head">
                  <span className="tl-head-name" title={track.id === main ? `${track.name} — ana yol` : track.name}>
                    <Icon name={track.kind === 'audio' ? 'music' : track.id === main ? 'film' : 'layers'} size={13} /> {track.name}
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
                    onDropAt(id, snapped(toSec(e.clientX)).value, track.id);
                  }}
                >
                  {project.clips
                    .filter((c) => c.trackId === track.id)
                    .map((c) => (
                      <ClipBlock
                        key={c.id}
                        clip={c}
                        project={project}
                        pps={pps}
                        selected={c.id === selectedId}
                        onDown={onClipDown}
                        onMenu={(e) => {
                          e.preventDefault();
                          onSelect(c.id);
                          const items = onMenu(c);
                          // Menü ekranın dışına taşmasın.
                          const h = items.length * 32 + 12;
                          setMenu({ x: Math.min(e.clientX, window.innerWidth - 260), y: Math.min(e.clientY, window.innerHeight - h - 8), items });
                        }}
                      />
                    ))}
                </div>
              </div>
            ))}
          </div>
          {guide !== null && <span className="tl-guide" style={{ left: HEADER_W + guide * pps }} aria-hidden="true" />}
          {trimTip && (
            <span className="tl-tip" style={{ left: HEADER_W + trimTip.x }} aria-hidden="true">
              {trimTip.text}
            </span>
          )}
          <span className="tl-playhead" style={{ left: HEADER_W + time * pps }} aria-hidden="true" />
          {empty && (
            <div
              className="tl-empty"
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
                onDropAt(id, 0, null);
              }}
            >
              <Icon name="download" size={20} />
              <b>Dosyayı buraya sürükle</b>
              <span>ya da soldaki Medya sekmesinden bir dosyanın üstüne gelip "Ekle"ye bas</span>
            </div>
          )}
        </div>
      </div>
      {menu && (
        <ul className="ctx" style={{ left: menu.x, top: menu.y }} role="menu" onMouseDown={(e) => e.stopPropagation()}>
          {menu.items.map((it) => (
            <li key={it.label}>
              <button
                type="button"
                role="menuitem"
                className={it.danger ? 'ctx-item ctx-danger' : 'ctx-item'}
                disabled={it.disabled}
                onClick={() => {
                  setMenu(null);
                  it.run();
                }}
              >
                <span>{it.label}</span>
                {it.shortcut && <kbd>{it.shortcut}</kbd>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ClipBlock({ clip, project, pps, selected, onDown, onMenu }: { clip: Clip; project: Project; pps: number; selected: boolean; onDown: (e: ReactPointerEvent, clip: Clip, kind: 'move' | 'start' | 'end') => void; onMenu: (e: React.MouseEvent) => void }) {
  const asset = assetOf(project, clip);
  const label = clip.kind === 'text' ? clip.text?.content || 'Yazı' : asset?.name || 'Parça';
  const thumb = asset?.thumb && clip.kind !== 'audio' ? `url("${asset.thumb}")` : undefined;
  const limitEnd = clip.kind !== 'text' && clip.kind !== 'image' && atSourceEnd(project, clip);
  const limitStart = clip.kind !== 'text' && clip.kind !== 'image' && clip.in <= 0.02;
  const dur = clip.duration < 10 ? `${clip.duration.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} sn` : fmtDuration(clip.duration);
  return (
    <div
      className={`tclip tclip-${clip.kind}${selected ? ' tclip-on' : ''}`}
      style={{ left: clip.start * pps, width: Math.max(6, clip.duration * pps), backgroundImage: thumb }}
      onPointerDown={(e) => onDown(e, clip, 'move')}
      onContextMenu={onMenu}
      title={`${label} · ${dur}${clip.speed !== 1 ? ` · ${clip.speed}x` : ''}`}
    >
      <span className={`tclip-h tclip-h-l${limitStart ? ' tclip-h-limit' : ''}`} onPointerDown={(e) => onDown(e, clip, 'start')} title={limitStart ? 'Kaynağın başı' : 'Başlangıcı kısalt / uzat'} />
      <span className="tclip-label">
        <Icon name={clip.kind === 'text' ? 'text' : clip.kind === 'audio' ? 'music' : clip.kind === 'image' ? 'image' : 'film'} size={12} />
        {label}
        {clip.speed !== 1 && <i className="tclip-badge">{clip.speed}x</i>}
        {clip.captions && <i className="tclip-badge">CC</i>}
      </span>
      {selected && <span className="tclip-dur">{dur}</span>}
      <span className={`tclip-h tclip-h-r${limitEnd ? ' tclip-h-limit' : ''}`} onPointerDown={(e) => onDown(e, clip, 'end')} title={limitEnd ? 'Kaynağın sonu — daha uzayamaz' : 'Sonu kısalt / uzat'} />
    </div>
  );
}
