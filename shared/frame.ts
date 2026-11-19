/**
 * Yayın çerçevesi — sunucu ve arayüz aynı tanımı kullanır.
 *
 * Çerçeve, Stüdyo'da yüklenen saydam pencereli tam kare bir PNG'dir ve
 * zaman çizelgesinde bir PARÇADIR (`kind: 'frame'`, kamera alanı gibi):
 * aralığında ana yoldaki videonun kamera bölgesi çerçevenin penceresine (bkz.
 * project.ts → `expandFrameClips`), Kick sohbeti çerçevedeki sohbet paneline
 * oturur; aralık dışında her şey eskisi gibidir. Parça kısaltılır, taşınır, silinir.
 *
 * Kick sohbeti de ayrı bir parçadır (`kind: 'chat'`, `chatId` → sohbet katmanı):
 * sohbet yalnız sohbet parçalarının aralığında görünür; içeriği o anda karede
 * duran videonun yayın saatinden gelir, yani kesme ve taşımalar eşlemeyi bozmaz.
 */
import { chatSegments, mergeRanges, subtractRanges, type ChatLayer, type ChatRange, type ChatSegment } from './chat.ts';
import type { FrameRegions, Project, ProjectFormat, Rect } from './project.ts';

export type { FrameRegions } from './project.ts';

/**
 * Sohbet alanı varsayılanı: ekteki çerçeve dosyasında "SOHBET" başlığı ve
 * ayırıcı çizginin altı (x 1413, y 258, 421×616 piksel). Başka çerçevede
 * kullanıcı Stüdyo'da kutuyu çizerek değiştirir.
 */
export const DEFAULT_FRAME_CHAT: Rect = { x: 0.7359, y: 0.2389, w: 0.2193, h: 0.5704 };
/** Çerçeve içindeki sohbetin yazı boyutu (21 px / 1080). */
export const FRAME_CHAT_SIZE = 0.0195;
/** Altyazı ile pencerenin alt kenarı arasındaki pay (karenin yüksekliğine oranı, ~24 px). */
export const FRAME_SUBTITLE_PAD = 24 / 1080;

const near = (a: number, b: number) => Math.abs(a - b) < 0.002;
export const sameRect = (a: Rect, b: Rect) => near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);

/** Pencerenin altı çerçevede kaldığından altyazı pencerenin alt kenarının hemen üstüne alınır (karenin oranı, alttan). */
export const frameSubtitleBottom = (regions: Pick<FrameRegions, 'window'>) => Math.min(0.9, Math.max(0, 1 - (regions.window.y + regions.window.h)) + FRAME_SUBTITLE_PAD);

/** Sohbet katmanını çerçevedeki panele oturtur: arka plansız, gölgesiz, panel yazı boyutunda. */
export function frameChatLayer(layer: ChatLayer, chat: Rect): ChatLayer {
  return { ...layer, frame: { ...chat }, background: 'none', shadow: false, size: FRAME_CHAT_SIZE };
}

/* ── Sohbetin çerçeveyle etkileşimi ─────────────────────────────────────── */

type WithClips = Pick<Project, 'clips' | 'tracks' | 'chats'>;

/**
 * Çizim/dışa aktarma için "etkin" sohbet katmanı: asıl katman çerçeve
 * aralıklarının DIŞINDA, çerçeve başına türetilen sanal katman (panele
 * oturmuş) yalnız o çerçevenin aralığı İÇİNDE görünür. Sanal kimlik
 * `<sohbet>_<çerçeve>` biçimindedir; dışa aktarma planı da bu kimlikle saklanır.
 */
export interface EffectiveChat {
  layer: ChatLayer;
  /** Zaman çizelgesinde yalnız bu aralıklarda (null: sınırsız) */
  within: ChatRange[] | null;
  /** Bu aralıklarda görünmez */
  except: ChatRange[];
  /** Türetildiyse kaynak katman ve çerçeve parçası */
  frameClipId: string | null;
}

/** Görünür yollardaki, sohbet alanı olan çerçeve parçaları. */
export function chatFrameClips(p: Pick<Project, 'clips' | 'tracks'>) {
  const hidden = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id));
  return p.clips.filter((c) => c.kind === 'frame' && c.regions?.chat && !hidden.has(c.trackId) && c.duration > 0);
}

/** Katmanın sohbet parçalarının (görünür yollarda) zaman çizelgesi aralıkları; parçası yoksa null (eski kayıt: her yerde görünür). */
export function chatClipRanges(p: Pick<Project, 'clips' | 'tracks'>, layerId: string): ChatRange[] | null {
  const hidden = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id));
  const clips = p.clips.filter((c) => c.kind === 'chat' && c.chatId === layerId);
  if (!clips.length) return null;
  return mergeRanges(clips.filter((c) => !hidden.has(c.trackId)).map((c) => ({ start: c.start, end: c.start + c.duration })));
}

/** İki aralık kümesinin kesişimi (null: sınırsız). */
export function intersectRanges(a: readonly ChatRange[] | null, b: readonly ChatRange[] | null): ChatRange[] | null {
  if (!a) return b ? mergeRanges(b) : null;
  if (!b) return mergeRanges(a);
  const out: ChatRange[] = [];
  for (const x of a) for (const y of b) {
    const r = { start: Math.max(x.start, y.start), end: Math.min(x.end, y.end) };
    if (r.end - r.start > 1e-6) out.push(r);
  }
  return mergeRanges(out);
}

export function effectiveChatLayers(p: WithClips): EffectiveChat[] {
  const frames = chatFrameClips(p);
  const frameRanges = mergeRanges(frames.map((f) => ({ start: f.start, end: f.start + f.duration })));
  const out: EffectiveChat[] = [];
  for (const layer of p.chats) {
    // Sohbet parçaları ne zaman görüneceğini söyler; çerçeve aralıkları o görünümü panele taşır.
    const shown = chatClipRanges(p, layer.id);
    if (shown && !shown.length) continue;
    out.push({ layer, within: shown, except: frameRanges, frameClipId: null });
    for (const f of frames) {
      const within = intersectRanges(shown, [{ start: f.start, end: f.start + f.duration }])!;
      if (!within.length) continue;
      out.push({ layer: { ...frameChatLayer(layer, f.regions!.chat!), id: `${layer.id}_${f.id}` }, within, except: [], frameClipId: f.id });
    }
  }
  return out;
}

/** O anda sohbet katmanını gösteren sohbet parçası (seçim için); yoksa null. */
export function chatClipAt(p: Pick<Project, 'clips' | 'tracks'>, layerId: string, t: number) {
  const hidden = new Set(p.tracks.filter((x) => x.hidden).map((x) => x.id));
  return p.clips.find((c) => c.kind === 'chat' && c.chatId === layerId && !hidden.has(c.trackId) && t >= c.start && t < c.start + c.duration) ?? null;
}

/** Bölümleri zaman çizelgesi aralıklarıyla kırpar (within içinde, except dışında). */
export function clipSegments(segments: readonly ChatSegment[], within: readonly ChatRange[] | null, except: readonly ChatRange[]): ChatSegment[] {
  const out: ChatSegment[] = [];
  for (const s of segments) {
    let keep: ChatRange[] = [{ start: s.start, end: s.end }];
    if (within) keep = keep.flatMap((k) => within.map((w) => ({ start: Math.max(k.start, w.start), end: Math.min(k.end, w.end) })).filter((r) => r.end - r.start > 1e-4));
    if (except.length) keep = subtractRanges(keep, except);
    for (const k of keep) if (k.end - k.start > 1e-4) out.push({ start: k.start, end: k.end, src: s.src + (k.start - s.start) * s.speed, speed: s.speed, clipId: s.clipId });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Etkin katmanın zaman çizelgesinde göründüğü bölümler (önizleme ve dışa aktarma aynı). */
export const effectiveChatSegments = (p: Pick<Project, 'clips' | 'tracks'>, eff: EffectiveChat) => clipSegments(chatSegments(p, eff.layer), eff.within, eff.except);

/** Zaman kısıtının plan anahtarına eki: çerçeve parçası oynayınca eski plan geçersiz sayılır. */
export const effectiveChatKeySuffix = (eff: EffectiveChat) => (eff.within || eff.except.length ? JSON.stringify([eff.within, eff.except].map((r) => r?.map((x) => [Math.round(x.start * 100) / 100, Math.round(x.end * 100) / 100]) ?? null)) : '');

/** Projenin biçimi değişince (dikeye geçince) çerçeve parçaları düşer. */
export function dropFrameClips<P extends Pick<Project, 'clips'>>(p: P, format: ProjectFormat): P {
  if (format === 'horizontal' || !p.clips.some((c) => c.kind === 'frame')) return p;
  return { ...p, clips: p.clips.filter((c) => c.kind !== 'frame') };
}
