/**
 * Editör proje modeli — sunucu ve arayüz aynı tanımı kullanır.
 *
 * Tüm konum/boyut değerleri KARENİN ORANI (0–1) olarak tutulur; böylece
 * önizleme hangi boyutta çizilirse çizilsin dışa aktarma aynı sonucu verir.
 *  - `frame`: klibin çıktı karesindeki kutusu.
 *  - `crop`: kaynağın hangi bölgesinin o kutuya oturtulacağı (kaynağın oranı).
 *  Kaynaktaki crop bölgesi frame kutusuna birebir ölçeklenir (gerekirse
 *  oran bozularak); oran korumalı yerleşimi arayüz hesaplar (bkz. fitFrame).
 */
import { normalizeChats, type ChatLayer } from './chat.ts';

export type ProjectFormat = 'horizontal' | 'vertical';
export type AssetKind = 'video' | 'image' | 'audio';
/**
 * Parça türleri. `text`: kareye çizilen yazı. `cta`: abone çağrısı animasyonu
 * (dışa aktarmada ASS olarak basılır). `cam`: kamera alanı — bu aralıkta ana
 * yoldaki videonun webcam bölgesi (crop) tüm kareyi doldurur. `frame`: yayın
 * çerçevesi — Stüdyo'daki saydam pencereli PNG; bu aralıkta ana yoldaki videonun
 * kamera bölgesi (crop; tüm kare de olabilir) çerçevenin penceresine, Kick sohbeti
 * sohbet paneline oturur (bkz. shared/frame.ts). `chat`: Kick sohbeti parçası —
 * `chatId` ile bir sohbet katmanına (shared/chat.ts) bağlanır; sohbet yalnız bu
 * parçanın aralığında görünür, içeriği o anda karede duran videonun yayın saatiyle eşlidir.
 */
export type ClipKind = 'video' | 'image' | 'audio' | 'text' | 'cta' | 'cam' | 'frame' | 'chat';
export type TrackKind = 'video' | 'audio';
/** Yalnız zaman çizelgesinde yaşayan, kaynak dosyası olmayan türler. */
export const SYNTHETIC_KINDS: ReadonlySet<ClipKind> = new Set<ClipKind>(['text', 'cta', 'cam', 'chat']);

export type CtaStyleKey = 'pill' | 'bar' | 'card' | 'cursor' | 'icons' | 'side';
export type CtaPlaceKey = 'top' | 'center' | 'bottom';
export const CTA_STYLE_KEYS: CtaStyleKey[] = ['pill', 'bar', 'card', 'cursor', 'icons', 'side'];
export const CTA_PLACE_KEYS: CtaPlaceKey[] = ['top', 'center', 'bottom'];
export const CTA_SIZE_RANGE = { min: 30, max: 200 } as const;

/** Stüdyo'daki üst/orta/alt seçiminin kare içindeki dikey merkezi (0–1). */
export const CTA_PLACE_Y: Record<CtaPlaceKey, number> = { top: 0.2, center: 0.5, bottom: 0.78 };

/**
 * Abone çağrısı parçasının tasarımı; yazılar ve renkler Stüdyo'daki marka
 * ayarından gelir. x/y: animasyonun merkezi, kareye oranla (0–1); sahnede
 * sürüklenerek değişir. Şerit stili tam genişliktir, yalnız y'yi kullanır.
 */
export interface CtaClipStyle {
  style: CtaStyleKey;
  x: number;
  y: number;
  /** Yüzde: 100 = tasarım ölçüsü */
  size: number;
}

/** Üst/orta/alt ön ayarının merkez noktası. */
export function ctaPlacePoint(place: CtaPlaceKey | null | undefined): { x: number; y: number } {
  return { x: 0.5, y: CTA_PLACE_Y[place && place in CTA_PLACE_Y ? place : 'center'] };
}

/** Konum bir ön ayara denk geliyorsa adı, değilse null. */
export function ctaPlaceOf(c: Pick<CtaClipStyle, 'x' | 'y'>): CtaPlaceKey | null {
  if (Math.abs(c.x - 0.5) > 0.005) return null;
  return CTA_PLACE_KEYS.find((k) => Math.abs(c.y - CTA_PLACE_Y[k]) < 0.005) ?? null;
}

export const FORMAT_SIZE: Record<ProjectFormat, { w: number; h: number }> = {
  horizontal: { w: 1920, h: 1080 },
  vertical: { w: 1080, h: 1920 },
};
export const PROJECT_FPS = 30;
export const MAX_TRACKS = 12;
export const MAX_CLIPS = 400;
export const MIN_CLIP_SEC = 0.1;

export type AssetOrigin =
  | { type: 'upload'; file: string }
  | { type: 'render'; file: string }
  | { type: 'job' | 'recording' | 'vod' | 'harvest'; id: number }
  | { type: 'logo' | 'intro' | 'outro' | 'cta' | 'frame' };

export interface Asset {
  id: string;
  kind: AssetKind;
  name: string;
  duration: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  origin: AssetOrigin;
  thumb: string | null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ColorGrade {
  /** -1..1, 0 = değişmez */
  brightness: number;
  /** 0..2, 1 = değişmez */
  contrast: number;
  /** 0..3, 1 = değişmez */
  saturation: number;
  /** derece, 0 = değişmez */
  hue: number;
}

export interface TextStyle {
  content: string;
  font: 'display' | 'body' | 'mono';
  /** Yazı yüksekliği, karenin yüksekliğine oranı */
  size: number;
  color: string;
  background: string | null;
  align: 'left' | 'center' | 'right';
  bold: boolean;
  italic: boolean;
  outline: boolean;
}

export interface Caption {
  start: number;
  end: number;
  text: string;
}

export interface Clip {
  id: string;
  trackId: string;
  kind: ClipKind;
  assetId: string | null;
  /** Zaman çizelgesindeki başlangıç (sn) */
  start: number;
  duration: number;
  /** Kaynaktaki başlangıç (sn) */
  in: number;
  frame: Rect;
  crop: Rect;
  opacity: number;
  volume: number;
  muted: boolean;
  /** Oynatma hızı (0.25–4); zaman çizelgesindeki süre = kaynak süresi / hız */
  speed: number;
  /** Giriş/çıkış yumuşatma süreleri (sn) */
  fadeIn: number;
  fadeOut: number;
  color: ColorGrade;
  text: TextStyle | null;
  /** Abone çağrısı parçasının tasarımı (yalnız kind === 'cta') */
  cta: CtaClipStyle | null;
  /** Kaynak zamanında konuşma dökümü (otomatik altyazı) */
  captions: Caption[] | null;
  /** Yayın çerçevesinin bölgeleri (yalnız kind === 'frame') */
  regions: FrameRegions | null;
  /** Bağlı sohbet katmanı (yalnız kind === 'chat') */
  chatId: string | null;
  /** Yazı klibinin dışa aktarma için kareye çizilmiş hâli (görsel varlık) */
  renderAssetId: string | null;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
}

export interface ProjectSubtitles {
  enabled: boolean;
  style: string | null;
  followTheme: boolean;
}

/** Yayın çerçevesinin bölgeleri (karenin oranı): videonun oturduğu saydam pencere ve varsa sohbet paneli. */
export interface FrameRegions {
  window: Rect;
  chat: Rect | null;
}

export interface Project {
  id: number;
  title: string;
  format: ProjectFormat;
  fps: number;
  assets: Asset[];
  /** Alttan üste: ilk parça en altta çizilir. */
  tracks: Track[];
  clips: Clip[];
  subtitles: ProjectSubtitles;
  /** Videoya bağlı Kick sohbet katmanları (varlık başına en fazla bir tane; bkz. shared/chat.ts). */
  chats: ChatLayer[];
}

export const FULL_RECT: Rect = { x: 0, y: 0, w: 1, h: 1 };
export const NEUTRAL_COLOR: ColorGrade = { brightness: 0, contrast: 1, saturation: 1, hue: 0 };

export const COLOR_PRESETS: { key: string; label: string; color: ColorGrade }[] = [
  { key: 'none', label: 'Doğal', color: NEUTRAL_COLOR },
  { key: 'vivid', label: 'Canlı', color: { brightness: 0.03, contrast: 1.12, saturation: 1.35, hue: 0 } },
  { key: 'warm', label: 'Sıcak', color: { brightness: 0.02, contrast: 1.05, saturation: 1.15, hue: -8 } },
  { key: 'cool', label: 'Soğuk', color: { brightness: 0, contrast: 1.05, saturation: 1.05, hue: 10 } },
  { key: 'cinema', label: 'Sinema', color: { brightness: -0.04, contrast: 1.25, saturation: 0.85, hue: 4 } },
  { key: 'mono', label: 'Siyah-beyaz', color: { brightness: 0, contrast: 1.1, saturation: 0, hue: 0 } },
  { key: 'faded', label: 'Soluk', color: { brightness: 0.08, contrast: 0.85, saturation: 0.8, hue: 0 } },
];

const num = (v: unknown, dflt: number, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const str = (v: unknown, dflt = '', max = 200) => (typeof v === 'string' ? v.slice(0, max) : dflt);
const id = (v: unknown) => (typeof v === 'string' && /^[a-z0-9_-]{1,40}$/i.test(v) ? v : null);

export function normalizeRect(raw: unknown, dflt: Rect = FULL_RECT): Rect {
  const r = (raw ?? {}) as Partial<Rect>;
  const w = num(r.w, dflt.w, 0.005, 4);
  const h = num(r.h, dflt.h, 0.005, 4);
  return { x: num(r.x, dflt.x, -3, 3), y: num(r.y, dflt.y, -3, 3), w, h };
}

/** Kaynak bölgesi karenin içinde kalmalı. */
export function normalizeCrop(raw: unknown): Rect {
  const r = normalizeRect(raw);
  const w = Math.min(1, Math.max(0.01, r.w));
  const h = Math.min(1, Math.max(0.01, r.h));
  return { x: Math.min(1 - w, Math.max(0, r.x)), y: Math.min(1 - h, Math.max(0, r.y)), w, h };
}

export function normalizeColor(raw: unknown): ColorGrade {
  const c = (raw ?? {}) as Partial<ColorGrade>;
  return {
    brightness: num(c.brightness, 0, -1, 1),
    contrast: num(c.contrast, 1, 0, 2),
    saturation: num(c.saturation, 1, 0, 3),
    hue: num(c.hue, 0, -180, 180),
  };
}

const HEXA = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGBA = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i;
const color = (v: unknown, dflt: string | null) => (typeof v === 'string' && (HEXA.test(v) || RGBA.test(v)) ? v : dflt);

export function normalizeText(raw: unknown): TextStyle {
  const t = (raw ?? {}) as Partial<TextStyle>;
  return {
    content: str(t.content, 'Yazı', 400),
    font: (['display', 'body', 'mono'] as const).includes(t.font as 'display') ? (t.font as TextStyle['font']) : 'display',
    size: num(t.size, 0.08, 0.015, 0.6),
    color: color(t.color, '#ffffff') ?? '#ffffff',
    background: color(t.background, null),
    align: (['left', 'center', 'right'] as const).includes(t.align as 'left') ? (t.align as TextStyle['align']) : 'center',
    bold: t.bold !== false,
    italic: t.italic === true,
    outline: t.outline !== false,
  };
}

export const DEFAULT_CTA_STYLE: CtaClipStyle = { style: 'pill', x: 0.5, y: 0.5, size: 100 };

export function normalizeCtaStyle(raw: unknown): CtaClipStyle {
  // Eski kayıtlarda `place` (üst/orta/alt) vardı; x/y yoksa oradan türetilir.
  const c = (raw ?? {}) as Partial<CtaClipStyle> & { place?: CtaPlaceKey };
  const fromPlace = ctaPlacePoint(c.place);
  return {
    style: CTA_STYLE_KEYS.includes(c.style as CtaStyleKey) ? (c.style as CtaStyleKey) : DEFAULT_CTA_STYLE.style,
    x: num(c.x, fromPlace.x, 0, 1),
    y: num(c.y, fromPlace.y, 0, 1),
    size: Math.round(num(c.size, DEFAULT_CTA_STYLE.size, CTA_SIZE_RANGE.min, CTA_SIZE_RANGE.max)),
  };
}

export function normalizeCaptions(raw: unknown): Caption[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .slice(0, 5000)
    .map((c) => ({ start: num(c?.start, NaN, 0), end: num(c?.end, NaN, 0), text: str(c?.text, '', 300).trim() }))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.text);
}

export function normalizeAsset(raw: unknown): Asset | null {
  const a = (raw ?? {}) as Partial<Asset>;
  const aid = id(a.id);
  if (!aid) return null;
  const kind = (['video', 'image', 'audio'] as const).includes(a.kind as 'video') ? (a.kind as AssetKind) : null;
  if (!kind) return null;
  const o = (a.origin ?? {}) as Record<string, unknown>;
  let origin: AssetOrigin | null = null;
  if ((o.type === 'upload' || o.type === 'render') && typeof o.file === 'string' && /^[a-z0-9_.-]{1,120}$/i.test(o.file) && !o.file.includes('..')) origin = { type: o.type, file: o.file };
  else if ((o.type === 'job' || o.type === 'recording' || o.type === 'vod' || o.type === 'harvest') && Number.isInteger(Number(o.id)) && Number(o.id) > 0) origin = { type: o.type, id: Number(o.id) };
  else if (o.type === 'logo' || o.type === 'intro' || o.type === 'outro' || o.type === 'cta' || o.type === 'frame') origin = { type: o.type };
  if (!origin) return null;
  return {
    id: aid,
    kind,
    name: str(a.name, 'Dosya', 160) || 'Dosya',
    duration: num(a.duration, 0, 0),
    width: a.width == null ? null : num(a.width, 0, 0),
    height: a.height == null ? null : num(a.height, 0, 0),
    hasAudio: a.hasAudio === true,
    origin,
    thumb: typeof a.thumb === 'string' ? a.thumb.slice(0, 300) : null,
  };
}

export function normalizeClip(raw: unknown, assetIds: Set<string>, trackIds: Set<string>): Clip | null {
  const c = (raw ?? {}) as Partial<Clip>;
  const cid = id(c.id);
  const tid = id(c.trackId);
  if (!cid || !tid || !trackIds.has(tid)) return null;
  const kind = (['video', 'image', 'audio', 'text', 'cta', 'cam', 'frame', 'chat'] as const).includes(c.kind as 'video') ? (c.kind as ClipKind) : null;
  if (!kind) return null;
  const assetId = c.assetId == null ? null : id(c.assetId);
  if (!SYNTHETIC_KINDS.has(kind) && (!assetId || !assetIds.has(assetId))) return null;
  const renderAssetId = c.renderAssetId == null ? null : id(c.renderAssetId);
  return {
    id: cid,
    trackId: tid,
    kind,
    assetId: assetId && assetIds.has(assetId) ? assetId : null,
    start: num(c.start, 0, 0, 24 * 3600),
    duration: num(c.duration, 1, MIN_CLIP_SEC, 24 * 3600),
    in: num(c.in, 0, 0, 48 * 3600),
    frame: normalizeRect(c.frame),
    crop: normalizeCrop(c.crop),
    opacity: num(c.opacity, 1, 0, 1),
    volume: num(c.volume, 1, 0, 3),
    muted: c.muted === true,
    speed: num(c.speed, 1, 0.25, 4),
    fadeIn: num(c.fadeIn, 0, 0, 10),
    fadeOut: num(c.fadeOut, 0, 0, 10),
    color: normalizeColor(c.color),
    text: kind === 'text' ? normalizeText(c.text) : null,
    cta: kind === 'cta' ? normalizeCtaStyle(c.cta) : null,
    captions: normalizeCaptions(c.captions),
    regions: kind === 'frame' ? normalizeRegions(c.regions) : null,
    chatId: kind === 'chat' ? id(c.chatId) : null,
    renderAssetId: renderAssetId && assetIds.has(renderAssetId) ? renderAssetId : null,
  };
}

export function normalizeTrack(raw: unknown): Track | null {
  const t = (raw ?? {}) as Partial<Track>;
  const tid = id(t.id);
  if (!tid) return null;
  return {
    id: tid,
    kind: t.kind === 'audio' ? 'audio' : 'video',
    name: str(t.name, '', 60) || (t.kind === 'audio' ? 'Ses' : 'Görüntü'),
    muted: t.muted === true,
    hidden: t.hidden === true,
  };
}

/** Çerçeve bölgeleri karenin içinde kalır; sohbet alanı yoksa null. */
export function normalizeRegions(raw: unknown): FrameRegions {
  const r = (raw ?? {}) as Partial<FrameRegions>;
  return { window: normalizeCrop(r.window), chat: r.chat == null ? null : normalizeCrop(r.chat) };
}

/** Dış kaynaklı proje verisini doğrular; bozuk parçaları sessizce atar. */
export function normalizeProject(raw: unknown, base: { id: number; title?: string }): Project {
  const p = (raw ?? {}) as Partial<Project>;
  const format: ProjectFormat = p.format === 'vertical' ? 'vertical' : 'horizontal';
  const assets = (Array.isArray(p.assets) ? p.assets : []).map(normalizeAsset).filter((a): a is Asset => !!a).slice(0, 300);
  const assetIds = new Set(assets.map((a) => a.id));
  let tracks = (Array.isArray(p.tracks) ? p.tracks : []).map(normalizeTrack).filter((t): t is Track => !!t).slice(0, MAX_TRACKS);
  if (!tracks.length) tracks = defaultTracks();
  const trackIds = new Set(tracks.map((t) => t.id));
  const chats = normalizeChats(p.chats, new Set(assets.filter((a) => a.kind === 'video').map((a) => a.id)), format);
  const chatIds = new Set(chats.map((c) => c.id));
  const clips = (Array.isArray(p.clips) ? p.clips : [])
    .map((c) => normalizeClip(c, assetIds, trackIds))
    // Yayın çerçevesi yalnız yatay projede çalışır; sohbet parçası katmanı olmadan yaşayamaz.
    .filter((c): c is Clip => !!c && (c.kind !== 'frame' || format === 'horizontal') && (c.kind !== 'chat' || (!!c.chatId && chatIds.has(c.chatId))))
    .slice(0, MAX_CLIPS);
  const s = (p.subtitles ?? {}) as Partial<ProjectSubtitles>;
  return {
    id: base.id,
    title: str(p.title, base.title ?? 'Yeni proje', 120).trim() || base.title || 'Yeni proje',
    format,
    fps: PROJECT_FPS,
    assets,
    tracks,
    clips,
    subtitles: {
      enabled: s.enabled === true,
      style: typeof s.style === 'string' && /^[a-z0-9-]{1,30}$/.test(s.style) ? s.style : null,
      followTheme: s.followTheme === true,
    },
    chats,
  };
}

export function defaultTracks(): Track[] {
  return [
    { id: 'v1', kind: 'video', name: 'Video 1', muted: false, hidden: false },
    { id: 'v2', kind: 'video', name: 'Üst katman', muted: false, hidden: false },
    { id: 'a1', kind: 'audio', name: 'Müzik', muted: false, hidden: false },
  ];
}

export function emptyProject(id: number, title: string, format: ProjectFormat): Project {
  return { id, title, format, fps: PROJECT_FPS, assets: [], tracks: defaultTracks(), clips: [], subtitles: { enabled: false, style: null, followTheme: false }, chats: [] };
}

/** Projenin toplam süresi: en son biten klip. */
export function projectDuration(p: Pick<Project, 'clips'>): number {
  return p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
}

/** Kaynak oranı (crop uygulanmış) → kareye oran koruyarak sığdırılmış kutu. */
export function fitFrame(srcW: number, srcH: number, crop: Rect, format: ProjectFormat, scale = 1): Rect {
  const out = FORMAT_SIZE[format];
  const aspect = ((srcW || 16) * crop.w) / ((srcH || 9) * crop.h);
  const outAspect = out.w / out.h;
  let w: number;
  let h: number;
  if (aspect >= outAspect) {
    w = scale;
    h = (scale * outAspect) / aspect;
  } else {
    h = scale;
    w = (scale * aspect) / outAspect;
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** Kutuyu oran bozmadan doldurmak için kaynaktan alınacak bölge (orta). */
export function coverCrop(srcW: number, srcH: number, frame: Rect, format: ProjectFormat): Rect {
  const out = FORMAT_SIZE[format];
  const frameAspect = (frame.w * out.w) / (frame.h * out.h);
  const srcAspect = (srcW || 16) / (srcH || 9);
  if (srcAspect > frameAspect) {
    const w = frameAspect / srcAspect;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }
  const h = srcAspect / frameAspect;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

/**
 * Kaynaktaki bir bölgeyi (ör. webcam kutusu) hedef kutuyu (varsayılan tüm
 * kare) oran bozmadan DOLDURACAK alt bölgeye daraltır (ortalanmış, fazlalık
 * kırpılır).
 */
export function coverRegion(srcW: number, srcH: number, region: Rect, format: ProjectFormat, target: Rect = FULL_RECT): Rect {
  const out = FORMAT_SIZE[format];
  const outAspect = (target.w * out.w) / (target.h * out.h);
  const regionAspect = ((srcW || 16) * region.w) / ((srcH || 9) * region.h);
  if (regionAspect > outAspect) {
    const w = region.w * (outAspect / regionAspect);
    return { x: region.x + (region.w - w) / 2, y: region.y, w, h: region.h };
  }
  const h = region.h * (regionAspect / outAspect);
  return { x: region.x, y: region.y + (region.h - h) / 2, w: region.w, h };
}

/** Kamera alanı parçasının kameraya "tam ekran" girişi/çıkışı için varsayılan yumuşatma (sn). */
export const CAM_FADE = 0.12;

/**
 * Kamera alanı parçalarını çizilebilir katmanlara açar: her kamera alanı,
 * aralığında ana yolda (ilk görüntü yolu) duran video parçalarına bölünür ve
 * her bölüm, o parçanın kaynağından kamera bölgesini (crop) tüm kareyi
 * dolduracak şekilde alan sessiz bir video katmanı olur. Kesimler arasında
 * kaynak zamanı ana parçayla birebir ilerler. Önizleme ve dışa aktarma aynı
 * listeyi kullanır. Türetilen kimlik `<kamera>~<ana parça>` biçimindedir.
 */
export function expandCamClips(p: Pick<Project, 'clips' | 'tracks' | 'assets' | 'format'>): Clip[] {
  const cams = p.clips.filter((c) => c.kind === 'cam');
  if (!cams.length) return p.clips;
  const mainTrack = p.tracks.find((t) => t.kind === 'video')?.id ?? p.tracks[0]?.id;
  const hidden = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id));
  const mains = p.clips.filter((c) => c.trackId === mainTrack && c.kind === 'video' && c.assetId);
  const frames = p.clips.filter((c) => c.kind === 'frame' && c.regions && !hidden.has(c.trackId));
  const out = p.clips.filter((c) => c.kind !== 'cam');
  for (const cam of cams) {
    if (hidden.has(cam.trackId)) continue;
    const camEnd = cam.start + cam.duration;
    for (const m of mains) {
      const mEnd = m.start + m.duration;
      const start = Math.max(cam.start, m.start);
      const end = Math.min(camEnd, mEnd);
      if (end - start < MIN_CLIP_SEC / 2) continue;
      const asset = p.assets.find((a) => a.id === m.assetId);
      const speed = m.speed || 1;
      // Bu kesimi bütünüyle kapsayan bir yayın çerçevesi varsa kamera tam kare yerine pencereyi doldurur.
      const target = frames.find((f) => f.start <= start + 1e-6 && f.start + f.duration >= end - 1e-6)?.regions?.window ?? FULL_RECT;
      out.push({
        ...m,
        id: `${cam.id}~${m.id}`,
        trackId: cam.trackId,
        start,
        duration: end - start,
        in: m.in + (start - m.start) * speed,
        frame: { ...target },
        crop: coverRegion(asset?.width || 16, asset?.height || 9, cam.crop, p.format, target),
        opacity: cam.opacity,
        muted: true,
        fadeIn: start <= cam.start + 1e-6 ? cam.fadeIn : 0,
        fadeOut: end >= camEnd - 1e-6 ? cam.fadeOut : 0,
        captions: null,
        text: null,
        cta: null,
        regions: null,
        chatId: null,
        renderAssetId: null,
      });
    }
  }
  return out;
}

/**
 * Yayın çerçevesi parçalarını çizilebilir katmanlara açar: çerçeve aralığında
 * ana yolda duran her video parçası için, o parçanın kaynağındaki kamera
 * bölgesini (çerçeve parçasının `crop`u; tüm kare de olabilir) çerçevenin
 * penceresine oran bozmadan (fazlalık kırpılarak) oturtan sessiz bir katman
 * üretilir ve çerçeve görselinin HEMEN ALTINA konur; çerçevenin kendisi
 * (saydam pencereli PNG) tam kare görsel olarak kalır. Kesimler arasında
 * kaynak zamanı ana parçayla birebir ilerler. Türetilen kimlik
 * `<çerçeve>~<ana parça>` biçimindedir.
 */
export function expandFrameClips(p: Pick<Project, 'clips' | 'tracks' | 'assets' | 'format'>): Clip[] {
  if (!p.clips.some((c) => c.kind === 'frame')) return p.clips;
  const mainTrack = p.tracks.find((t) => t.kind === 'video')?.id ?? p.tracks[0]?.id;
  const hidden = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id));
  const mains = p.clips.filter((c) => c.trackId === mainTrack && c.kind === 'video' && c.assetId);
  const out: Clip[] = [];
  for (const fr of p.clips) {
    if (fr.kind !== 'frame') {
      out.push(fr);
      continue;
    }
    if (hidden.has(fr.trackId) || !fr.regions) {
      out.push(fr);
      continue;
    }
    const window = fr.regions.window;
    const frEnd = fr.start + fr.duration;
    for (const m of mains) {
      const start = Math.max(fr.start, m.start);
      const end = Math.min(frEnd, m.start + m.duration);
      if (end - start < MIN_CLIP_SEC / 2) continue;
      const asset = p.assets.find((a) => a.id === m.assetId);
      const speed = m.speed || 1;
      out.push({
        ...m,
        id: `${fr.id}~${m.id}`,
        trackId: fr.trackId,
        start,
        duration: end - start,
        in: m.in + (start - m.start) * speed,
        frame: { ...window },
        crop: coverRegion(asset?.width || 16, asset?.height || 9, fr.crop, p.format, window),
        opacity: fr.opacity,
        muted: true,
        fadeIn: start <= fr.start + 1e-6 ? fr.fadeIn : 0,
        fadeOut: end >= frEnd - 1e-6 ? fr.fadeOut : 0,
        captions: null,
        text: null,
        cta: null,
        regions: null,
        chatId: null,
        renderAssetId: null,
      });
    }
    // Çerçeve parçasının `crop`u pencereye giren kamera kutusudur; çerçeve görselinin kendisi her zaman tam kare, kırpmasız çizilir.
    out.push({ ...fr, frame: { ...FULL_RECT }, crop: { ...FULL_RECT } });
  }
  return out;
}

/** Kamera alanı ve yayın çerçevesi parçalarını çizilebilir katmanlara açar (önizleme ve dışa aktarma aynı listeyi kullanır). */
export const expandClips = (p: Pick<Project, 'clips' | 'tracks' | 'assets' | 'format'>): Clip[] => expandFrameClips({ ...p, clips: expandCamClips(p) });

/** Türetilmiş katmanın (kamera penceresi / çerçeve penceresi) ait olduğu parça. */
export const camParentId = (id: string) => (id.includes('~') ? id.slice(0, id.indexOf('~')) : null);

/** Verilen anda görünür bir yoldaki yayın çerçevesi parçası (varsa). */
export function frameAt(p: Pick<Project, 'clips' | 'tracks'>, t: number): Clip | null {
  const hidden = new Set(p.tracks.filter((x) => x.hidden).map((x) => x.id));
  return p.clips.find((c) => c.kind === 'frame' && c.regions && !hidden.has(c.trackId) && t >= c.start && t < c.start + c.duration) ?? null;
}

/** Klibin kaynaktan kullandığı süre (hız hesaba katılır). */
export const sourceSpan = (c: Pick<Clip, 'duration' | 'speed'>) => c.duration * (c.speed || 1);

/** Klip kaynak zamanından zaman çizelgesine altyazı satırları. */
export function timelineCaptions(p: Pick<Project, 'clips' | 'tracks'>): Caption[] {
  const hidden = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id));
  const out: Caption[] = [];
  for (const c of p.clips) {
    if (!c.captions || hidden.has(c.trackId) || c.kind === 'text' || c.kind === 'image') continue;
    const speed = c.speed || 1;
    const end = c.in + sourceSpan(c);
    for (const cap of c.captions) {
      if (cap.end <= c.in || cap.start >= end) continue;
      out.push({ start: c.start + Math.max(0, cap.start - c.in) / speed, end: c.start + Math.min(sourceSpan(c), cap.end - c.in) / speed, text: cap.text });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Dikey videoda platform arayüzlerinin kapattığı bölgeler (karenin oranı, topluluk ölçümlerinin tutucu birleşimi). */
export const VERTICAL_SAFE = { top: 250 / 1920, bottom: 420 / 1920, side: 60 / 1080 };
