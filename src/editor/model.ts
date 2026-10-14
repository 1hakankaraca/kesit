/**
 * Editör proje işlemleri — saf fonksiyonlar. Her işlem yeni bir Project döner;
 * geri alma geçmişi bu sayede basit bir yığın olur.
 */
import {
  FORMAT_SIZE,
  FULL_RECT,
  MIN_CLIP_SEC,
  NEUTRAL_COLOR,
  coverCrop,
  fitFrame,
  type Asset,
  type Clip,
  type Project,
  type Rect,
  type TextStyle,
  type Track,
} from '../../shared/project.ts';

export const newId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-3)}`;
export const clipEnd = (c: Clip) => c.start + c.duration;
export const assetOf = (p: Project, c: Clip) => (c.assetId ? p.assets.find((a) => a.id === c.assetId) ?? null : null);
export const trackOf = (p: Project, c: Clip) => p.tracks.find((t) => t.id === c.trackId) ?? null;
/** Kaynak süresi: görsel/yazı sınırsız, video/ses varlığın süresi. */
export const sourceLimit = (p: Project, c: Clip) => {
  const a = assetOf(p, c);
  return a && a.kind !== 'image' ? a.duration : Infinity;
};

export function overlaps(a: Clip, b: Clip) {
  return a.id !== b.id && a.trackId === b.trackId && a.start < clipEnd(b) && clipEnd(a) > b.start;
}

function patch(p: Project, id: string, fn: (c: Clip) => Clip): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === id ? fn(c) : c)) };
}

/** Parçadaki ilk uygun boşluk: istenen yer doluysa dolu parçanın hemen ardına kayar. */
export function freeSlot(p: Project, clip: Clip, trackId: string, start: number): number | null {
  const others = p.clips.filter((c) => c.id !== clip.id && c.trackId === trackId).sort((a, b) => a.start - b.start);
  let s = Math.max(0, start);
  for (let i = 0; i < 20; i++) {
    const hit = others.find((o) => s < clipEnd(o) && s + clip.duration > o.start);
    if (!hit) return s;
    s = clipEnd(hit);
  }
  return null;
}

export function addAssetClip(p: Project, asset: Asset, at: number, trackId?: string): { project: Project; clip: Clip } {
  const track = (trackId && p.tracks.find((t) => t.id === trackId)) || p.tracks.find((t) => (asset.kind === 'audio' ? t.kind === 'audio' : t.kind === 'video')) || p.tracks[0];
  const crop = { ...FULL_RECT };
  const base: Clip = {
    id: newId('c'),
    trackId: track.id,
    kind: asset.kind,
    assetId: asset.id,
    start: at,
    duration: asset.kind === 'image' ? 5 : Math.max(MIN_CLIP_SEC, asset.duration),
    in: 0,
    frame: asset.kind === 'audio' ? crop : fitFrame(asset.width || 16, asset.height || 9, crop, p.format),
    crop,
    opacity: 1,
    volume: 1,
    muted: false,
    color: { ...NEUTRAL_COLOR },
    text: null,
    captions: null,
    renderAssetId: null,
  };
  const start = freeSlot(p, base, track.id, at) ?? p.clips.filter((c) => c.trackId === track.id).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const clip = { ...base, start };
  return { project: { ...p, clips: [...p.clips, clip] }, clip };
}

export function addTextClip(p: Project, at: number, text?: Partial<TextStyle>): { project: Project; clip: Clip } {
  const track = [...p.tracks].reverse().find((t) => t.kind === 'video') ?? p.tracks[0];
  const base: Clip = {
    id: newId('c'),
    trackId: track.id,
    kind: 'text',
    assetId: null,
    start: at,
    duration: 4,
    in: 0,
    frame: p.format === 'vertical' ? { x: 0.1, y: 0.42, w: 0.8, h: 0.16 } : { x: 0.2, y: 0.4, w: 0.6, h: 0.2 },
    crop: { ...FULL_RECT },
    opacity: 1,
    volume: 1,
    muted: false,
    color: { ...NEUTRAL_COLOR },
    text: { content: 'Yazı', font: 'display', size: 0.08, color: '#ffffff', background: null, align: 'center', bold: true, italic: false, outline: true, ...text },
    captions: null,
    renderAssetId: null,
  };
  const start = freeSlot(p, base, track.id, at) ?? at;
  const clip = { ...base, start };
  return { project: { ...p, clips: [...p.clips, clip] }, clip };
}

export function updateClip(p: Project, id: string, changes: Partial<Clip>): Project {
  return patch(p, id, (c) => ({ ...c, ...changes, renderAssetId: 'text' in changes || 'frame' in changes ? null : (changes.renderAssetId ?? c.renderAssetId) }));
}

export function removeClips(p: Project, ids: string[]): Project {
  const set = new Set(ids);
  return { ...p, clips: p.clips.filter((c) => !set.has(c.id)) };
}

/** Parçayı siler ve aynı yoldaki sonraki parçaları boşluğu kapatacak şekilde geri çeker. */
export function rippleRemove(p: Project, id: string): Project {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return p;
  const gap = clip.duration;
  return {
    ...p,
    clips: p.clips.filter((c) => c.id !== id).map((c) => (c.trackId === clip.trackId && c.start >= clipEnd(clip) - 0.001 ? { ...c, start: Math.max(0, c.start - gap) } : c)),
  };
}

/** Verilen anda, verilen parçaları (yoksa o andaki tüm parçaları) ikiye böler. */
export function splitAt(p: Project, t: number, ids?: string[]): { project: Project; created: string[] } {
  const targets = p.clips.filter((c) => (ids ? ids.includes(c.id) : true) && t > c.start + MIN_CLIP_SEC && t < clipEnd(c) - MIN_CLIP_SEC);
  if (!targets.length) return { project: p, created: [] };
  const created: string[] = [];
  const clips = p.clips.flatMap((c) => {
    if (!targets.includes(c)) return [c];
    const left: Clip = { ...c, duration: t - c.start };
    const right: Clip = { ...c, id: newId('c'), start: t, in: c.in + (t - c.start), duration: clipEnd(c) - t, renderAssetId: c.renderAssetId };
    created.push(right.id);
    return [left, right];
  });
  return { project: { ...p, clips }, created };
}

export function moveClip(p: Project, id: string, start: number, trackId?: string): Project {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return p;
  const target = trackId && p.tracks.find((t) => t.id === trackId);
  const toTrack = target && ((clip.kind === 'audio') === (target.kind === 'audio')) ? target.id : clip.trackId;
  const s = freeSlot(p, clip, toTrack, Math.max(0, start));
  if (s === null) return p;
  return patch(p, id, (c) => ({ ...c, start: s, trackId: toTrack }));
}

/** Sol kenardan kısaltma/uzatma: başlangıç ve kaynak girişi birlikte kayar. */
export function trimStart(p: Project, id: string, newStart: number): Project {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return p;
  const minStart = clipEnd(clip) - Math.min(clipEnd(clip), sourceLimit(p, clip) - clip.in + clip.start);
  const prevEnd = p.clips.filter((c) => c.id !== id && c.trackId === clip.trackId && clipEnd(c) <= clip.start + 0.001).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const s = Math.max(prevEnd, minStart, Math.max(0, Math.min(newStart, clipEnd(clip) - MIN_CLIP_SEC)));
  const delta = s - clip.start;
  if (clip.in + delta < 0) return p;
  return patch(p, id, (c) => ({ ...c, start: s, in: c.in + delta, duration: c.duration - delta }));
}

export function trimEnd(p: Project, id: string, newEnd: number): Project {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return p;
  const nextStart = p.clips.filter((c) => c.id !== id && c.trackId === clip.trackId && c.start >= clipEnd(clip) - 0.001).reduce((m, c) => Math.min(m, c.start), Infinity);
  const maxEnd = Math.min(nextStart, clip.start + (sourceLimit(p, clip) - clip.in));
  const e = Math.min(maxEnd, Math.max(clip.start + MIN_CLIP_SEC, newEnd));
  return patch(p, id, (c) => ({ ...c, duration: e - c.start }));
}

export function duplicateClip(p: Project, id: string): { project: Project; clip: Clip | null } {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return { project: p, clip: null };
  const copy: Clip = { ...clip, id: newId('c') };
  const start = freeSlot(p, copy, clip.trackId, clipEnd(clip));
  if (start === null) return { project: p, clip: null };
  const placed = { ...copy, start };
  return { project: { ...p, clips: [...p.clips, placed] }, clip: placed };
}

/** Yoldaki boşlukları kapatır (parçalar art arda dizilir). */
export function closeGaps(p: Project, trackId: string): Project {
  const sorted = p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
  let cursor = 0;
  const moved = new Map<string, number>();
  for (const c of sorted) {
    moved.set(c.id, cursor);
    cursor += c.duration;
  }
  return { ...p, clips: p.clips.map((c) => (moved.has(c.id) ? { ...c, start: moved.get(c.id)! } : c)) };
}

export function addTrack(p: Project, kind: Track['kind']): Project {
  const n = p.tracks.filter((t) => t.kind === kind).length + 1;
  const track: Track = { id: newId(kind === 'audio' ? 'a' : 'v'), kind, name: kind === 'audio' ? `Ses ${n}` : `Katman ${n}`, muted: false, hidden: false };
  // Ses yolları en altta, görüntü yolları onların üstünde.
  const tracks = kind === 'audio' ? [...p.tracks, track] : [...p.tracks.filter((t) => t.kind === 'video'), track, ...p.tracks.filter((t) => t.kind === 'audio')];
  return { ...p, tracks };
}

export function removeTrack(p: Project, id: string): Project {
  if (p.tracks.length <= 1) return p;
  return { ...p, tracks: p.tracks.filter((t) => t.id !== id), clips: p.clips.filter((c) => c.trackId !== id) };
}

export function updateTrack(p: Project, id: string, changes: Partial<Track>): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...changes } : t)) };
}

/** Kareyi oran koruyarak doldur: kaynaktan gereken bölge kırpılır. */
export function fillFrame(p: Project, id: string): Project {
  const clip = p.clips.find((c) => c.id === id);
  const a = clip && assetOf(p, clip);
  if (!clip || !a) return p;
  const frame = { ...FULL_RECT };
  return patch(p, id, (c) => ({ ...c, frame, crop: coverCrop(a.width || 16, a.height || 9, frame, p.format) }));
}

/** Kaynağın tamamını kareye oran koruyarak sığdır. */
export function fitToFrame(p: Project, id: string): Project {
  const clip = p.clips.find((c) => c.id === id);
  const a = clip && assetOf(p, clip);
  if (!clip || !a) return p;
  const crop = { ...FULL_RECT };
  return patch(p, id, (c) => ({ ...c, crop, frame: fitFrame(a.width || 16, a.height || 9, crop, p.format) }));
}

export function centerFrame(p: Project, id: string): Project {
  return patch(p, id, (c) => ({ ...c, frame: { ...c.frame, x: (1 - c.frame.w) / 2, y: (1 - c.frame.h) / 2 } }));
}

/**
 * Yatay yayın parçasını dikey düzene çevirir: kamera kutusu üstte ayrı bir
 * katman, oyun/ekran altta kalan alanı doldurur. İkisi de sonradan ayrı
 * ayrı taşınıp boyutlanabilir.
 */
export function splitCameraAndScreen(p: Project, id: string, camRect: Rect | null): Project {
  const clip = p.clips.find((c) => c.id === id);
  const a = clip && assetOf(p, clip);
  if (!clip || !a || a.kind !== 'video') return p;
  const srcW = a.width || 16;
  const srcH = a.height || 9;
  const cam = camRect ?? { x: 0.72, y: 0.02, w: 0.26, h: 0.26 * (srcW / srcH) * (9 / 16) };
  // Kamera katmanı, parçanın üstünde ve o zaman aralığı boş olan ilk görüntü yoluna gider; yoksa yeni yol açılır.
  const idx = p.tracks.findIndex((t) => t.id === clip.trackId);
  const free = (t: Track) => !p.clips.some((c) => c.trackId === t.id && c.start < clipEnd(clip) && clipEnd(c) > clip.start);
  const upperTrack = p.tracks.slice(idx + 1).find((t) => t.kind === 'video' && free(t)) ?? null;
  let project = p;
  if (!upperTrack) project = addTrack(project, 'video');
  const camTrack = upperTrack ?? [...project.tracks].reverse().find((t) => t.kind === 'video')!;

  // Kamera: kendi oranıyla üstte, tam genişlik.
  const camFrame = fitFrame(srcW, srcH, cam, project.format, 1);
  const camPlaced = { ...camFrame, x: 0, y: 0 };
  // Ekran: kalan alan; oran korunarak orta kısmı kırpılır (kamera bölgesi hariç tutulmaz, yayın ekranı ortalanır).
  const screenFrame = { x: 0, y: camPlaced.h, w: 1, h: 1 - camPlaced.h };
  const screenCrop = coverCrop(srcW, srcH, screenFrame, project.format);
  const camClip: Clip = { ...clip, id: newId('c'), trackId: camTrack.id, frame: camPlaced, crop: cam, muted: true, captions: null };
  return {
    ...project,
    clips: [...project.clips.map((c) => (c.id === id ? { ...c, frame: screenFrame, crop: screenCrop } : c)), camClip],
  };
}

/** Kutuyu kare içinde tutar (tamamen dışarı çıkamaz). */
export function clampFrame(r: Rect): Rect {
  const w = Math.max(0.02, Math.min(3, r.w));
  const h = Math.max(0.02, Math.min(3, r.h));
  return { x: Math.max(-w + 0.05, Math.min(0.95, r.x)), y: Math.max(-h + 0.05, Math.min(0.95, r.y)), w, h };
}

export function frameAspect(p: Project, c: Clip) {
  const { w, h } = FORMAT_SIZE[p.format];
  return (c.frame.w * w) / (c.frame.h * h);
}

/** Oynatma çizgisi, parça kenarları ve sıfıra yapışma. */
export function snapTime(t: number, candidates: number[], tolerance: number): number {
  let best = t;
  let dist = tolerance;
  for (const c of candidates) {
    const d = Math.abs(t - c);
    if (d < dist) {
      dist = d;
      best = c;
    }
  }
  return best;
}
