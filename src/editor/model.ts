/**
 * Editör proje işlemleri — saf fonksiyonlar. Her işlem yeni bir Project döner;
 * geri alma geçmişi bu sayede basit bir yığın olur.
 *
 * Mıknatıs modu: ana görüntü yolunda (ilk video yolu) parçalar her zaman art
 * arda durur — silme boşluk bırakmaz, kısaltma sonrakileri çeker, sürükleme
 * sıra değiştirir. Üst katmanlar serbesttir.
 */
import {
  FORMAT_SIZE,
  FULL_RECT,
  MIN_CLIP_SEC,
  NEUTRAL_COLOR,
  VERTICAL_SAFE,
  coverCrop,
  fitFrame,
  sourceSpan,
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
export const mainTrackId = (p: Project) => p.tracks.find((t) => t.kind === 'video')?.id ?? p.tracks[0]?.id;
/** Kaynak süresi: görsel/yazı sınırsız, video/ses varlığın süresi. */
export const sourceLimit = (p: Project, c: Clip) => {
  const a = assetOf(p, c);
  return a && a.kind !== 'image' ? a.duration : Infinity;
};
/** Parça kaynağın sonuna dayandı mı (daha fazla uzayamaz)? */
export const atSourceEnd = (p: Project, c: Clip) => c.in + sourceSpan(c) >= sourceLimit(p, c) - 0.02;

export function overlaps(a: Clip, b: Clip) {
  return a.id !== b.id && a.trackId === b.trackId && a.start < clipEnd(b) && clipEnd(a) > b.start;
}

function patch(p: Project, id: string, fn: (c: Clip) => Clip): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === id ? fn(c) : c)) };
}

const onTrack = (p: Project, trackId: string, except?: string) => p.clips.filter((c) => c.trackId === trackId && c.id !== except).sort((a, b) => a.start - b.start);

/** Yolu art arda dizer (mıknatıs). `order` verilirse o sıra kullanılır. */
function packTrack(p: Project, trackId: string, order?: string[]): Project {
  const sorted = onTrack(p, trackId);
  const seq = order ? order.map((id) => sorted.find((c) => c.id === id)!).filter(Boolean) : sorted;
  let cursor = 0;
  const starts = new Map<string, number>();
  for (const c of seq) {
    starts.set(c.id, cursor);
    cursor += c.duration;
  }
  return { ...p, clips: p.clips.map((c) => (starts.has(c.id) ? { ...c, start: starts.get(c.id)! } : c)) };
}

/** Parçadaki ilk uygun boşluk: istenen yer doluysa dolu parçanın hemen ardına kayar. */
export function freeSlot(p: Project, clip: Clip, trackId: string, start: number): number | null {
  const others = onTrack(p, trackId, clip.id);
  let s = Math.max(0, start);
  for (let i = 0; i < 20; i++) {
    const hit = others.find((o) => s < clipEnd(o) && s + clip.duration > o.start);
    if (!hit) return s;
    s = clipEnd(hit);
  }
  return null;
}

export function blankClip(trackId: string, kind: Clip['kind'], assetId: string | null, start: number, duration: number): Clip {
  return {
    id: newId('c'),
    trackId,
    kind,
    assetId,
    start,
    duration,
    in: 0,
    frame: { ...FULL_RECT },
    crop: { ...FULL_RECT },
    opacity: 1,
    volume: 1,
    muted: false,
    speed: 1,
    fadeIn: 0,
    fadeOut: 0,
    color: { ...NEUTRAL_COLOR },
    text: null,
    captions: null,
    renderAssetId: null,
  };
}

export function addAssetClip(p: Project, asset: Asset, at: number, trackId?: string, magnetic = true): { project: Project; clip: Clip } {
  const track = (trackId && p.tracks.find((t) => t.id === trackId)) || p.tracks.find((t) => (asset.kind === 'audio' ? t.kind === 'audio' : t.kind === 'video')) || p.tracks[0];
  const base = blankClip(track.id, asset.kind, asset.id, at, asset.kind === 'image' ? 5 : Math.max(MIN_CLIP_SEC, asset.duration));
  if (asset.kind !== 'audio') base.frame = fitFrame(asset.width || 16, asset.height || 9, base.crop, p.format);
  if (magnetic && track.id === mainTrackId(p)) {
    // Ana yolda: oynatma çizgisinin bulunduğu parçanın ardına girer, sonrakiler kayar (akıllı ekleme).
    const seq = onTrack(p, track.id);
    const after = seq.findIndex((c) => at < clipEnd(c));
    const order = seq.map((c) => c.id);
    order.splice(after === -1 ? order.length : after + (at > seq[after].start + seq[after].duration / 2 ? 1 : 0), 0, base.id);
    const withClip = { ...p, clips: [...p.clips, base] };
    const packed = packTrack(withClip, track.id, order);
    return { project: packed, clip: packed.clips.find((c) => c.id === base.id)! };
  }
  const start = freeSlot(p, base, track.id, at) ?? onTrack(p, track.id).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const clip = { ...base, start };
  return { project: { ...p, clips: [...p.clips, clip] }, clip };
}

export type TextPreset = 'baslik' | 'bant' | 'etiket' | 'cagri' | 'serbest';

/** Hazır yazı kalıpları: güvenli alana oturur. */
export function textPreset(preset: TextPreset, format: Project['format'], accent: string): { text: Partial<TextStyle>; frame: Rect; duration: number } {
  const v = format === 'vertical';
  const top = v ? VERTICAL_SAFE.top : 0.08;
  const bottom = v ? VERTICAL_SAFE.bottom : 0.08;
  switch (preset) {
    case 'baslik':
      return { text: { content: 'BÜYÜK BAŞLIK', font: 'display', size: v ? 0.075 : 0.14, bold: true, outline: true, background: null, align: 'center' }, frame: v ? { x: 0.08, y: top + 0.02, w: 0.84, h: 0.16 } : { x: 0.1, y: top, w: 0.8, h: 0.2 }, duration: 4 };
    case 'bant':
      return { text: { content: 'Alt bant yazısı', font: 'body', size: v ? 0.03 : 0.05, bold: true, outline: false, background: '#000000b3', align: 'left' }, frame: v ? { x: 0.06, y: 1 - bottom - 0.08, w: 0.88, h: 0.07 } : { x: 0.06, y: 1 - bottom - 0.1, w: 0.7, h: 0.1 }, duration: 6 };
    case 'etiket':
      return { text: { content: 'kanal adı', font: 'body', size: v ? 0.024 : 0.04, bold: true, outline: false, background: `${accent}e6`, align: 'left' }, frame: v ? { x: 0.06, y: top + 0.01, w: 0.5, h: 0.05 } : { x: 0.06, y: top, w: 0.3, h: 0.07 }, duration: 8 };
    case 'cagri':
      return { text: { content: 'TAKİP ET ❤', font: 'display', size: v ? 0.045 : 0.08, bold: true, outline: false, background: `${accent}f2`, align: 'center' }, frame: v ? { x: 0.25, y: 1 - bottom - 0.12, w: 0.5, h: 0.08 } : { x: 0.35, y: 1 - bottom - 0.12, w: 0.3, h: 0.1 }, duration: 3 };
    default:
      return { text: { content: 'Yazı' }, frame: v ? { x: 0.1, y: 0.42, w: 0.8, h: 0.16 } : { x: 0.2, y: 0.4, w: 0.6, h: 0.2 }, duration: 4 };
  }
}

export function addTextClip(p: Project, at: number, preset: TextPreset = 'serbest', accent = '#f43f5e'): { project: Project; clip: Clip } {
  const track = [...p.tracks].reverse().find((t) => t.kind === 'video') ?? p.tracks[0];
  const pr = textPreset(preset, p.format, accent);
  const base = blankClip(track.id, 'text', null, at, pr.duration);
  base.frame = pr.frame;
  base.text = { content: 'Yazı', font: 'display', size: 0.08, color: '#ffffff', background: null, align: 'center', bold: true, italic: false, outline: true, ...pr.text };
  // Yazı, ana yoldan farklı ve o anda boş olan bir katmana gider; yoksa yeni katman açılır.
  let project = p;
  let target = p.tracks.filter((t) => t.kind === 'video' && t.id !== mainTrackId(p)).find((t) => freeSlot(p, base, t.id, at) === at) ?? null;
  if (!target) {
    project = addTrack(p, 'video');
    target = [...project.tracks].reverse().find((t) => t.kind === 'video')!;
  }
  const clip = { ...base, trackId: target.id, start: at };
  void track;
  return { project: { ...project, clips: [...project.clips, clip] }, clip };
}

export function updateClip(p: Project, id: string, changes: Partial<Clip>): Project {
  return patch(p, id, (c) => ({ ...c, ...changes, renderAssetId: 'text' in changes || 'frame' in changes ? null : (changes.renderAssetId ?? c.renderAssetId) }));
}

export function removeClips(p: Project, ids: string[], magnetic = true): Project {
  const set = new Set(ids);
  const removed = p.clips.filter((c) => set.has(c.id));
  let next: Project = { ...p, clips: p.clips.filter((c) => !set.has(c.id)) };
  if (magnetic && removed.some((c) => c.trackId === mainTrackId(p))) next = packTrack(next, mainTrackId(p));
  return next;
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
    const left: Clip = { ...c, duration: t - c.start, fadeOut: 0 };
    const right: Clip = { ...c, id: newId('c'), start: t, in: c.in + (t - c.start) * (c.speed || 1), duration: clipEnd(c) - t, fadeIn: 0 };
    created.push(right.id);
    return [left, right];
  });
  return { project: { ...p, clips }, created };
}

/** Oynatma çizgisinin solundaki (Q) ya da sağındaki (W) kısmı atar. */
export function trimToPlayhead(p: Project, id: string, t: number, side: 'left' | 'right', magnetic = true): Project {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip || t <= clip.start + MIN_CLIP_SEC || t >= clipEnd(clip) - MIN_CLIP_SEC) return p;
  let next: Project;
  if (side === 'left') {
    const delta = t - clip.start;
    next = patch(p, id, (c) => ({ ...c, start: t, in: c.in + delta * (c.speed || 1), duration: c.duration - delta }));
  } else next = patch(p, id, (c) => ({ ...c, duration: t - c.start }));
  if (magnetic && clip.trackId === mainTrackId(p)) next = packTrack(next, clip.trackId);
  return next;
}

export function moveClip(p: Project, id: string, start: number, trackId?: string, magnetic = true): Project {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return p;
  const target = trackId && p.tracks.find((t) => t.id === trackId);
  const toTrack = target && ((clip.kind === 'audio') === (target.kind === 'audio')) ? target.id : clip.trackId;
  const main = mainTrackId(p);
  if (magnetic && toTrack === main) {
    // Ana yolda sürükleme = sıra değiştirme: parçanın ortası hangi parçanın üstüne gelirse oraya girer.
    const others = onTrack(p, main, id);
    const mid = Math.max(0, start) + clip.duration / 2;
    let index = others.findIndex((o) => mid < o.start + o.duration / 2);
    if (index === -1) index = others.length;
    const order = others.map((o) => o.id);
    order.splice(index, 0, id);
    const moved = patch(p, id, (c) => ({ ...c, trackId: main }));
    return packTrack(moved, main, order);
  }
  const s = freeSlot(p, clip, toTrack, Math.max(0, start));
  if (s === null) return p;
  let next = patch(p, id, (c) => ({ ...c, start: s, trackId: toTrack }));
  if (magnetic && clip.trackId === main && toTrack !== main) next = packTrack(next, main);
  return next;
}

/** Sol kenardan kısaltma/uzatma: başlangıç ve kaynak girişi birlikte kayar. */
export function trimStart(p: Project, id: string, newStart: number, magnetic = true): Project {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return p;
  const speed = clip.speed || 1;
  const magneticMain = magnetic && clip.trackId === mainTrackId(p);
  const prevEnd = magneticMain ? -Infinity : onTrack(p, clip.trackId, id).filter((c) => clipEnd(c) <= clip.start + 0.001).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  // Kaynakta geriye gidilebilecek en fazla: in / speed
  const minStart = clip.start - clip.in / speed;
  const s = Math.max(prevEnd, minStart, 0, Math.min(newStart, clipEnd(clip) - MIN_CLIP_SEC));
  const delta = s - clip.start;
  if (Math.abs(delta) < 1e-6) return p;
  let next = patch(p, id, (c) => ({ ...c, start: s, in: Math.max(0, c.in + delta * speed), duration: c.duration - delta }));
  if (magneticMain) next = packTrack(next, clip.trackId);
  return next;
}

export function trimEnd(p: Project, id: string, newEnd: number, magnetic = true): Project {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return p;
  const speed = clip.speed || 1;
  const magneticMain = magnetic && clip.trackId === mainTrackId(p);
  const nextStart = magneticMain ? Infinity : onTrack(p, clip.trackId, id).filter((c) => c.start >= clipEnd(clip) - 0.001).reduce((m, c) => Math.min(m, c.start), Infinity);
  const maxEnd = Math.min(nextStart, clip.start + (sourceLimit(p, clip) - clip.in) / speed);
  const e = Math.min(maxEnd, Math.max(clip.start + MIN_CLIP_SEC, newEnd));
  if (Math.abs(e - clipEnd(clip)) < 1e-6) return p;
  let next = patch(p, id, (c) => ({ ...c, duration: e - c.start }));
  if (magneticMain) next = packTrack(next, clip.trackId);
  return next;
}

export function setSpeed(p: Project, id: string, speed: number): Project {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip || clip.kind === 'image' || clip.kind === 'text') return p;
  const s = Math.min(4, Math.max(0.25, speed));
  const span = sourceSpan(clip);
  let next = patch(p, id, (c) => ({ ...c, speed: s, duration: Math.max(MIN_CLIP_SEC, span / s) }));
  // Serbest yolda sonraki parçayla çakışırsa süre kısılır; ana yolda sonrakiler kayar.
  if (clip.trackId === mainTrackId(p)) next = packTrack(next, clip.trackId);
  else {
    const after = onTrack(next, clip.trackId, id).find((c) => c.start >= clip.start + 0.001 && c.start < clip.start + span / s);
    if (after) next = patch(next, id, (c) => ({ ...c, duration: Math.max(MIN_CLIP_SEC, after.start - c.start) }));
  }
  return next;
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

/** Kopyalanan parçayı oynatma çizgisine yapıştırır. */
export function pasteClip(p: Project, source: Clip, at: number, magnetic = true): { project: Project; clip: Clip | null } {
  if (source.assetId && !p.assets.some((a) => a.id === source.assetId)) return { project: p, clip: null };
  const copy: Clip = { ...source, id: newId('c'), start: at, renderAssetId: null };
  const track = p.tracks.find((t) => t.id === copy.trackId) ?? p.tracks.find((t) => (copy.kind === 'audio' ? t.kind === 'audio' : t.kind === 'video'))!;
  copy.trackId = track.id;
  if (magnetic && track.id === mainTrackId(p)) {
    const seq = onTrack(p, track.id);
    const idx = seq.findIndex((c) => at < clipEnd(c));
    const order = seq.map((c) => c.id);
    order.splice(idx === -1 ? order.length : idx + 1, 0, copy.id);
    const packed = packTrack({ ...p, clips: [...p.clips, copy] }, track.id, order);
    return { project: packed, clip: packed.clips.find((c) => c.id === copy.id)! };
  }
  const start = freeSlot(p, copy, track.id, at);
  if (start === null) return { project: p, clip: null };
  const placed = { ...copy, start };
  return { project: { ...p, clips: [...p.clips, placed] }, clip: placed };
}

/** Yoldaki boşlukları kapatır (parçalar art arda dizilir). */
export function closeGaps(p: Project, trackId: string): Project {
  return packTrack(p, trackId);
}

export function addTrack(p: Project, kind: Track['kind']): Project {
  const n = p.tracks.filter((t) => t.kind === kind).length + 1;
  const track: Track = { id: newId(kind === 'audio' ? 'a' : 'v'), kind, name: kind === 'audio' ? `Ses ${n}` : `Katman ${n}`, muted: false, hidden: false };
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

/** Parçayı bir üst ya da alt görüntü katmanına taşır (boşsa). */
export function moveToTrack(p: Project, id: string, dir: 'up' | 'down'): Project {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return p;
  const same = p.tracks.filter((t) => t.kind === (clip.kind === 'audio' ? 'audio' : 'video'));
  const i = same.findIndex((t) => t.id === clip.trackId);
  const target = same[dir === 'up' ? i + 1 : i - 1];
  if (!target) return p;
  return moveClip(p, id, clip.start, target.id, false);
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

export type LayoutPreset = 'kamera-ust' | 'kamera-alt' | 'kamera-kose' | 'tam' | 'sigdir';

export const LAYOUTS: { key: LayoutPreset; label: string; hint: string; vertical: boolean; needsCam: boolean }[] = [
  { key: 'kamera-ust', label: 'Kamera üstte', hint: 'Kamera üstte, oyun/ekran altta (en yaygın dikey düzen)', vertical: true, needsCam: true },
  { key: 'kamera-alt', label: 'Kamera altta', hint: 'Ekran üstte, kamera altta', vertical: true, needsCam: true },
  { key: 'kamera-kose', label: 'Kamera köşede', hint: 'Ekran tam kare, kamera küçük kutuda', vertical: false, needsCam: true },
  { key: 'tam', label: 'Tam ekran', hint: 'Ortadan kırpıp kareyi doldur', vertical: false, needsCam: false },
  { key: 'sigdir', label: 'Sığdır', hint: 'Tamamı görünsün, kenarlar siyah', vertical: false, needsCam: false },
];

/**
 * Hazır düzen uygular. Kamera düzenlerinde yayın parçası ikiye ayrılır: kamera
 * ayrı katmanda, ekran altta/arkada. İkisi sonradan ayrı ayrı taşınabilir.
 */
export function applyLayout(p: Project, id: string, layout: LayoutPreset, camRect: Rect | null): Project {
  const clip = p.clips.find((c) => c.id === id);
  const a = clip && assetOf(p, clip);
  if (!clip || !a || a.kind !== 'video') return p;
  if (layout === 'tam') return fillFrame(p, id);
  if (layout === 'sigdir') return fitToFrame(p, id);
  const srcW = a.width || 16;
  const srcH = a.height || 9;
  const cam = camRect ?? { x: 0.72, y: 0.02, w: 0.26, h: 0.26 * (srcW / srcH) * (9 / 16) };
  // Kamera katmanı: parçanın üstünde, o aralığı boş olan ilk görüntü yolu; yoksa yeni yol.
  const idx = p.tracks.findIndex((t) => t.id === clip.trackId);
  const free = (t: Track) => !p.clips.some((c) => c.trackId === t.id && c.start < clipEnd(clip) && clipEnd(c) > clip.start);
  let project = p;
  let camTrack = p.tracks.slice(idx + 1).find((t) => t.kind === 'video' && free(t)) ?? null;
  if (!camTrack) {
    project = addTrack(project, 'video');
    camTrack = [...project.tracks].reverse().find((t) => t.kind === 'video')!;
  }
  let camFrame: Rect;
  let screenFrame: Rect;
  if (layout === 'kamera-kose') {
    screenFrame = { ...FULL_RECT };
    const w = project.format === 'vertical' ? 0.42 : 0.26;
    const fit = fitFrame(srcW, srcH, cam, project.format, w);
    const safeSide = project.format === 'vertical' ? VERTICAL_SAFE.side + 0.02 : 0.03;
    const safeBottom = project.format === 'vertical' ? VERTICAL_SAFE.bottom + 0.02 : 0.05;
    camFrame = { ...fit, x: 1 - safeSide - fit.w, y: 1 - safeBottom - fit.h };
  } else {
    const fit = fitFrame(srcW, srcH, cam, project.format, 1);
    camFrame = { ...fit, x: 0, y: layout === 'kamera-ust' ? 0 : 1 - fit.h };
    screenFrame = layout === 'kamera-ust' ? { x: 0, y: camFrame.h, w: 1, h: 1 - camFrame.h } : { x: 0, y: 0, w: 1, h: 1 - camFrame.h };
  }
  const screenCrop = coverCrop(srcW, srcH, screenFrame, project.format);
  const camClip: Clip = { ...clip, id: newId('c'), trackId: camTrack.id, frame: camFrame, crop: cam, muted: true, captions: null, renderAssetId: null };
  return {
    ...project,
    clips: [...project.clips.map((c) => (c.id === id ? { ...c, frame: screenFrame, crop: screenCrop } : c)), camClip],
  };
}

/** Eski ad — kamera üstte düzeni. */
export const splitCameraAndScreen = (p: Project, id: string, camRect: Rect | null) => applyLayout(p, id, 'kamera-ust', camRect);

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
export function snapTime(t: number, candidates: number[], tolerance: number): { value: number; snapped: number | null } {
  let best = t;
  let hit: number | null = null;
  let dist = tolerance;
  for (const c of candidates) {
    const d = Math.abs(t - c);
    if (d < dist) {
      dist = d;
      best = c;
      hit = c;
    }
  }
  return { value: best, snapped: hit };
}

/** Yumuşatmaya göre o andaki görünürlük çarpanı (önizleme). */
export function fadeFactor(c: Clip, t: number) {
  const local = t - c.start;
  let k = 1;
  if (c.fadeIn > 0 && local < c.fadeIn) k = Math.min(k, local / c.fadeIn);
  if (c.fadeOut > 0 && local > c.duration - c.fadeOut) k = Math.min(k, (c.duration - local) / c.fadeOut);
  return Math.max(0, Math.min(1, k));
}
