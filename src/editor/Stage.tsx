import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { chatSourceAt, type ChatLayer } from '../../shared/chat.ts';
import { chatClipAt, effectiveChatLayers, effectiveChatSegments, frameSubtitleBottom } from '../../shared/frame.ts';
import { FORMAT_SIZE, VERTICAL_SAFE, camParentId, expandClips, frameAt, timelineCaptions, type Clip, type Project, type Rect } from '../../shared/project.ts';
import { subtitleBox } from '../lib/frame.ts';
import type { CtaConfig } from '../lib/types.ts';
import { CtaMini } from '../screens/Studio.tsx';
import { ChatView } from './ChatView.tsx';
import { assetOf, clampFrame, clipEnd, fadeFactor, trackOf } from './model.ts';
import { TEXT_FONTS, TEXT_LINE, TEXT_PAD_X, TEXT_PAD_Y, TEXT_RADIUS, TEXT_STROKE } from './textRender.ts';
import type { ChatStore } from './useChat.ts';

/** Abone çağrısı önizlemesi için marka bilgisi (yazılar ve renkler Stüdyo'dan). */
export interface CtaPreview {
  config: CtaConfig;
  brandColor: string;
  accentColor: string;
}

/** Küçük CSS kopyasının referans ölçüsü: gerçek çizimde hap yüksekliği karenin kısa kenarının ~%10'u. */
const CTA_MINI_REF = 160;

/** Parçanın görünür olması için önceden yüklenmeye başlanacağı pay (sn). */
const PRELOAD_SEC = 3;
const SNAP = 0.012;
const SNAP_LINES = [0, 0.5, 1];

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Önizleme sahnesi: zaman çizelgesindeki görünür parçaları katman katman
 * çizer (video/görsel/yazı), sesleri çalar, altyazıyı basar. Seçili parça
 * sürüklenip boyutlanır; orta ve kenarlara yapışır. Dikeyde "güvenli alan"
 * platform arayüzlerinin kapattığı bölgeleri gösterir. Videoya bağlı sohbet
 * katmanları tüm parçaların üstünde çizilir; kutusu parça gibi taşınıp
 * boyutlanır, içeriği o anda karede duran videonun kaynak zamanından gelir.
 */
export function Stage({
  project,
  time,
  playing,
  selectedId,
  subtitleStyle,
  safeZone,
  cta,
  chat,
  onSelect,
  onFrame,
  onChatFrame,
  onCtaMove,
  onBegin,
  onEnd,
}: {
  project: Project;
  time: number;
  playing: boolean;
  selectedId: string | null;
  subtitleStyle: string;
  safeZone: boolean;
  cta: CtaPreview | null;
  /** Sohbet katmanlarının verisi ve görselleri */
  chat: ChatStore;
  onSelect: (id: string | null) => void;
  onFrame: (id: string, frame: Rect) => void;
  /** Sohbet kutusu taşınınca/boyutlanınca (katman kimliğiyle) */
  onChatFrame: (id: string, frame: Rect) => void;
  /** Abone çağrısı merkezi (kareye oran) sürüklenince. */
  onCtaMove: (id: string, x: number, y: number) => void;
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
  const [minSide, setMinSide] = useState(0);
  const drag = useRef<{ id: string; target: 'clip' | 'chat'; mode: 'move' | Handle; start: Rect; px: number; py: number; aspect: number } | null>(null);
  /** Abone çağrısı sürüklemesi: merkez noktası taşınır, kutu boyutlanmaz. */
  const ctaDrag = useRef<{ id: string; x: number; y: number; px: number; py: number; lockX: boolean } | null>(null);
  const vertical = project.format === 'vertical';
  const { w: W, h: H } = FORMAT_SIZE[project.format];

  const trackIndex = useMemo(() => new Map(project.tracks.map((t, i) => [t.id, i])), [project.tracks]);
  const hidden = useMemo(() => new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id)), [project.tracks]);
  const mutedTracks = useMemo(() => new Set(project.tracks.filter((t) => t.muted).map((t) => t.id)), [project.tracks]);
  // Kamera alanları ve yayın çerçeveleri ana yoldaki videodan türetilen katmanlara açılır (dışa aktarmayla aynı liste).
  const layers = useMemo(() => expandClips(project), [project]);

  const mounted = useMemo(
    () => layers.filter((c) => !hidden.has(c.trackId) && time >= c.start - PRELOAD_SEC && time < clipEnd(c) + 0.5).sort((a, b) => (trackIndex.get(a.trackId) ?? 0) - (trackIndex.get(b.trackId) ?? 0)),
    [layers, hidden, time, trackIndex],
  );

  // Çağrı önizlemesinin ölçeği kare boyutuna bağlı: kısa kenar ölçülür.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setMinSide(Math.min(el.clientWidth, el.clientHeight));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── Oynatma eşitleme ───────────────────────────────────────────────── */
  useEffect(() => {
    for (const c of mounted) {
      const el = media.current.get(c.id);
      if (!el) continue;
      const active = time >= c.start && time < clipEnd(c);
      const speed = c.speed || 1;
      const desired = c.in + (time - c.start) * speed;
      el.muted = c.muted || mutedTracks.has(c.trackId) || c.volume <= 0;
      el.volume = Math.max(0, Math.min(1, c.volume * fadeFactor(c, time)));
      if (el.playbackRate !== speed) el.playbackRate = Math.min(16, Math.max(0.0625, speed));
      if (!active) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - Math.max(0, desired)) > 0.3) el.currentTime = Math.max(0, Math.min(desired, c.in));
        continue;
      }
      if (playing) {
        if (Math.abs(el.currentTime - desired) > 0.25 * speed) el.currentTime = desired;
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
    drag.current = { id: clip.id, target: 'clip', mode, start: clip.frame, px: p.x, py: p.y, aspect: (clip.frame.w * W) / (clip.frame.h * H) };
    onBegin();
  };

  /** Sohbet kutusu: parça gibi taşınır/boyutlanır (ayar katmanda, tüm sohbet parçaları paylaşır); köşeden çekince oran kilitlenmez. Tıklama o anki sohbet parçasını seçer. */
  const onChatDown = (e: ReactPointerEvent, layer: ChatLayer, mode: 'move' | Handle) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const clipNow = chatClipAt(project, layer.id, time);
    if (clipNow) onSelect(clipNow.id);
    box.current!.setPointerCapture(e.pointerId);
    const p = pointer(e);
    drag.current = { id: layer.id, target: 'chat', mode, start: layer.frame, px: p.x, py: p.y, aspect: (layer.frame.w * W) / (layer.frame.h * H) };
    onBegin();
  };

  const onCtaDown = (e: ReactPointerEvent, clip: Clip) => {
    if (e.button !== 0 || !clip.cta) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect(clip.id);
    box.current!.setPointerCapture(e.pointerId);
    const p = pointer(e);
    ctaDrag.current = { id: clip.id, x: clip.cta.x, y: clip.cta.y, px: p.x, py: p.y, lockX: clip.cta.style === 'bar' };
    onBegin();
  };

  const onMove = (e: ReactPointerEvent) => {
    const cd = ctaDrag.current;
    if (cd) {
      const p = pointer(e);
      let x = cd.lockX ? 0.5 : cd.x + (p.x - cd.px);
      let y = cd.y + (p.y - cd.py);
      let gx: number | null = null;
      let gy: number | null = null;
      if (!e.altKey) {
        if (!cd.lockX && Math.abs(x - 0.5) < SNAP) {
          x = 0.5;
          gx = 0.5;
        }
        if (Math.abs(y - 0.5) < SNAP) {
          y = 0.5;
          gy = 0.5;
        }
      }
      setGuides({ x: gx, y: gy });
      onCtaMove(cd.id, Math.min(0.97, Math.max(0.03, x)), Math.min(0.97, Math.max(0.03, y)));
      return;
    }
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
      const corner = m.length === 2;
      if (corner && !e.altKey && d.target === 'clip') {
        const ratio = d.aspect * (H / W);
        if (Math.abs(dx) > Math.abs(dy)) h = w / ratio;
        else w = h * ratio;
        if (m.includes('w')) x = s.x + s.w - w;
        if (m.includes('n')) y = s.y + s.h - h;
      }
      next = { x, y, w: Math.max(0.02, w), h: Math.max(0.02, h) };
    }
    setGuides({ x: gx, y: gy });
    if (d.target === 'chat') onChatFrame(d.id, clampFrame(next));
    else onFrame(d.id, clampFrame(next));
  };

  const onUp = () => {
    if (!drag.current && !ctaDrag.current) return;
    drag.current = null;
    ctaDrag.current = null;
    setGuides({ x: null, y: null });
    onEnd();
  };

  /* ── Altyazı ────────────────────────────────────────────────────────── */
  const captions = useMemo(() => (project.subtitles.enabled ? timelineCaptions(project) : []), [project]);
  const caption = captions.find((c) => time >= c.start && time < c.end);
  const sub = subtitleBox(project.format, subtitleStyle, null, 'seam', false);
  // Çerçeve aralığında altyazı pencerenin içinde kalır (dışa aktarmayla aynı pay).
  const activeFrame = frameAt(project, time);
  const subBottom = activeFrame?.regions ? frameSubtitleBottom(activeFrame.regions) : sub.bottom;

  /* ── Sohbet katmanları ──────────────────────────────────────────────── */
  // Her etkin katmanın (asıl + çerçeve aralıkları için panele oturmuş türevleri) o andaki kaynak zamanı; bölümler proje değişince yeniden hesaplanır.
  const chatSegs = useMemo(() => effectiveChatLayers(project).map((eff) => ({ eff, layer: eff.layer, segments: effectiveChatSegments(project, eff) })), [project]);
  const chatZ = project.tracks.length + 2;
  const pct = (v: number) => `${v * 100}%`;
  const selected = project.clips.find((c) => c.id === selectedId) ?? null;
  // Sohbet parçası seçiliyken kutusu (katmanın kutusu) sahnede taşınır/boyutlanır.
  const selectedChat = selected?.kind === 'chat' && selected.chatId ? project.chats.find((c) => c.id === selected.chatId) ?? null : null;
  const selectedChatOn = !!selected && !!selectedChat && time >= selected.start && time < clipEnd(selected);
  // Seçili sohbet şu anda çerçevenin panelinde mi (o zaman kutu panelde, taşınmaz)?
  const selectedChatFramed = selectedChat ? chatSegs.find((c) => c.eff.frameClipId && c.eff.layer.id.startsWith(`${selectedChat.id}_`) && chatSourceAt(c.segments, time) !== null) ?? null : null;
  const selectedVisible = selected && selected.kind !== 'cta' && selected.kind !== 'chat' && mounted.includes(selected) && time >= selected.start && time < clipEnd(selected);
  const selectedCamOn = selected?.kind === 'cam' && time >= selected.start && time < clipEnd(selected) && !hidden.has(selected.trackId);
  const selectedFrameOn = selected?.kind === 'frame' && time >= selected.start && time < clipEnd(selected) && !hidden.has(selected.trackId);

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
          const layerStyle: CSSProperties = { left: pct(c.frame.x), top: pct(c.frame.y), width: pct(c.frame.w), height: pct(c.frame.h), zIndex: z, opacity: c.opacity * fadeFactor(c, time), display: active ? undefined : 'none' };
          const mediaStyle: CSSProperties = { width: pct(1 / c.crop.w), height: pct(1 / c.crop.h), left: pct(-c.crop.x / c.crop.w), top: pct(-c.crop.y / c.crop.h), filter };
          if (c.kind === 'audio') {
            return asset ? <audio key={c.id} ref={bind(c.id)} src={`/api/projects/${project.id}/assets/${asset.id}/stream`} preload="auto" /> : null;
          }
          if (c.kind === 'cta') {
            return (
              <div
                key={c.id}
                className={`elayer-cta${c.cta?.style === 'bar' ? ' elayer-cta-bar' : ''}${c.id === selectedId ? ' elayer-cta-on' : ''}`}
                style={{ left: pct(c.cta?.style === 'bar' ? 0.5 : (c.cta?.x ?? 0.5)), top: pct(c.cta?.y ?? 0.5), zIndex: z, opacity: c.opacity, display: active ? undefined : 'none' }}
                onPointerDown={(e) => onCtaDown(e, c)}
                title="Sürükleyerek taşı"
              >
                <CtaLayer clip={c} cta={cta} minSide={minSide} />
              </div>
            );
          }
          // Yayın çerçevesi: tam kare görsel, tıklama altındaki videoya geçer (zaman çizelgesinden seçilir).
          if (c.kind === 'frame') {
            return asset ? <img key={c.id} className={c.id === selectedId ? 'elayer-frame elayer-frame-on' : 'elayer-frame'} src={`/api/projects/${project.id}/assets/${asset.id}/stream`} alt="" draggable={false} style={{ zIndex: z, opacity: c.opacity * fadeFactor(c, time), display: active ? undefined : 'none' }} /> : null;
          }
          // Türetilmiş kamera/çerçeve penceresi katmanı: sürüklenmez, tıklanınca ait olduğu parça seçilir.
          const camId = camParentId(c.id);
          if (camId) {
            return (
              <div
                key={c.id}
                className={camId === selectedId ? 'elayer elayer-cam elayer-on' : 'elayer elayer-cam'}
                style={layerStyle}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  onSelect(camId);
                }}
              >
                {asset && <video ref={bind(c.id)} src={`/api/projects/${project.id}/assets/${asset.id}/stream`} preload="auto" playsInline style={mediaStyle} />}
              </div>
            );
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

        {chatSegs.map(({ eff, layer, segments }) => {
          const src = chatSourceAt(segments, time);
          if (src === null) return null;
          const framed = !!eff.frameClipId;
          const owner = framed ? project.chats.find((c) => layer.id.startsWith(`${c.id}_`)) ?? layer : layer;
          return (
            <div
              key={layer.id}
              className={owner.id === selectedChat?.id ? 'elayer-chat elayer-chat-on' : 'elayer-chat'}
              style={{ left: pct(layer.frame.x), top: pct(layer.frame.y), width: pct(layer.frame.w), height: pct(layer.frame.h), zIndex: chatZ, opacity: layer.opacity, cursor: framed ? 'default' : undefined }}
              onPointerDown={(e) => {
                // Çerçevenin panelindeyken kutu taşınmaz; tıklama yalnız o anki sohbet parçasını seçer.
                if (framed) {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  const clipNow = chatClipAt(project, owner.id, time);
                  if (clipNow) onSelect(clipNow.id);
                } else onChatDown(e, owner, 'move');
              }}
              title={framed ? 'Kick sohbeti — çerçevenin panelinde' : 'Kick sohbeti — sürükleyerek taşı'}
            >
              <ChatView layer={layer} data={chat.data[layer.assetId]} src={src} format={project.format} images={chat.images} version={chat.version} />
            </div>
          );
        })}

        {selectedChat && selectedChatOn && selectedChatFramed && (
          <div className="esel esel-chat" style={{ left: pct(selectedChatFramed.layer.frame.x), top: pct(selectedChatFramed.layer.frame.y), width: pct(selectedChatFramed.layer.frame.w), height: pct(selectedChatFramed.layer.frame.h) }}>
            <span className="esel-note">Sohbet çerçevenin panelinde</span>
          </div>
        )}
        {selectedChat && selectedChatOn && !selectedChatFramed && (
          <div className="esel esel-chat" style={{ left: pct(selectedChat.frame.x), top: pct(selectedChat.frame.y), width: pct(selectedChat.frame.w), height: pct(selectedChat.frame.h) }} onPointerDown={(e) => onChatDown(e, selectedChat, 'move')}>
            {chatSourceAt(chatSegs.find((c) => c.layer.id === selectedChat.id)?.segments ?? [], time) === null && <span className="esel-note">Bu anda karede bu yayının videosu yok</span>}
            {HANDLES.map((h) => (
              <span key={h} className={`esel-h esel-${h}`} onPointerDown={(e) => onChatDown(e, selectedChat, h)} />
            ))}
          </div>
        )}

        {selected && selectedVisible && (
          <div className="esel" style={{ left: pct(selected.frame.x), top: pct(selected.frame.y), width: pct(selected.frame.w), height: pct(selected.frame.h) }} onPointerDown={(e) => onDown(e, selected, 'move')}>
            {HANDLES.map((h) => (
              <span key={h} className={`esel-h esel-${h}`} onPointerDown={(e) => onDown(e, selected, h)} />
            ))}
          </div>
        )}

        {selectedCamOn && (
          <span className="ecam-badge" aria-hidden="true">
            Kamera alanı · tam ekran
          </span>
        )}
        {selectedFrameOn && (
          <span className="ecam-badge" aria-hidden="true">
            Yayın çerçevesi · video pencerede
          </span>
        )}

        {guides.x !== null && <span className="frame-snap frame-snap-v" style={{ left: pct(guides.x) }} aria-hidden="true" />}
        {guides.y !== null && <span className="frame-snap frame-snap-h" style={{ top: pct(guides.y) }} aria-hidden="true" />}

        {safeZone && vertical && (
          <div className="esafe" aria-hidden="true">
            <span className="esafe-top" style={{ height: pct(VERTICAL_SAFE.top) }}>
              üst bilgi
            </span>
            <span className="esafe-bottom" style={{ height: pct(VERTICAL_SAFE.bottom) }}>
              açıklama + düğmeler
            </span>
            <span className="esafe-side esafe-left" style={{ width: pct(VERTICAL_SAFE.side) }} />
            <span className="esafe-side esafe-right" style={{ width: pct(VERTICAL_SAFE.side) }} />
            <span className="esafe-box" style={{ top: pct(VERTICAL_SAFE.top), bottom: pct(VERTICAL_SAFE.bottom), left: pct(VERTICAL_SAFE.side), right: pct(VERTICAL_SAFE.side) }} />
          </div>
        )}
        {safeZone && !vertical && (
          <div className="esafe" aria-hidden="true">
            <span className="esafe-box" style={{ inset: '5%' }} />
          </div>
        )}

        {caption && (
          <p className={`frame-sub sub-${subtitleStyle}`} style={{ bottom: pct(subBottom), fontSize: `${sub.fontCqi}cqi` }}>
            {caption.text}
          </p>
        )}
        {!mounted.length && (
          <div className="estage-empty">
            <b>{project.clips.length ? 'Bu anda görüntü yok' : 'Sahne boş'}</b>
            <span>{project.clips.length ? 'Oynatma çizgisini bir parçanın üstüne getir' : 'Soldaki Medya sekmesinden video ekle'}</span>
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

/**
 * Abone çağrısı katmanı — Stüdyo'daki döngüde oynayan CSS kopyası, kare
 * boyutuna ve parçanın boyut ayarına göre ölçeklenir. Gerçek çizim (ASS)
 * dışa aktarmada basılır; burası yer/boyut/stil için yeterli bir yaklaşımdır.
 */
function CtaLayer({ clip, cta, minSide }: { clip: Clip; cta: CtaPreview | null; minSide: number }) {
  const s = clip.cta;
  if (!s) return null;
  const labels = cta?.config.overlay.labels ?? { subscribe: 'Abone ol', like: 'Beğen', comment: 'Yorum yap' };
  const colors = cta?.config.overlay.colors;
  const style = {
    zoom: Math.max(0.5, (minSide / CTA_MINI_REF) * (s.size / 100)),
    '--brand': colors?.primary ?? cta?.brandColor ?? '#53fc18',
    '--accent': colors?.accent ?? cta?.accentColor ?? cta?.brandColor ?? '#53fc18',
    '--cta-text': colors?.text ?? '#ffffff',
    '--cta-dark': colors?.dark ?? '#2a2d33',
  } as CSSProperties;
  return (
    <div className="ecta" style={style}>
      <CtaMini style={s.style} labels={labels} />
    </div>
  );
}

export function activeClipsAt(project: Project, time: number) {
  return project.clips.filter((c) => time >= c.start && time < clipEnd(c) && !trackOf(project, c)?.hidden);
}
