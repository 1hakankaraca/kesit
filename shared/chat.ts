/**
 * Kick sohbet katmanı — sunucu ve arayüz aynı tanımı kullanır.
 *
 * Sohbet zaman çizelgesine değil VİDEOYA (varlığa) bağlıdır: her mesajın
 * zamanı kaynağın saniyesi olarak tutulur ve hangi anda hangi mesajların
 * görüneceği, o anda karede duran video parçasının kaynak zamanından
 * hesaplanır. Bu yüzden bölme, aradan kesme, sıra değiştirme ve hız
 * değişikliği eşlemeyi bozamaz; kesilen bölümün sohbeti de kendiliğinden
 * gider. Gizleme aralıkları da kaynak zamanındadır, videoyla birlikte taşınır.
 *
 * Bu dosya project.ts'ten yalnız TİP alır (çalışma zamanı döngüsü olmasın).
 */
import type { Clip, Project, ProjectFormat, Rect } from './project.ts';

/** Kaynak zamanında yarı açık aralık [start, end). */
export interface ChatRange {
  start: number;
  end: number;
}

export type ChatBackground = 'none' | 'soft' | 'solid';
export const CHAT_BACKGROUNDS: ChatBackground[] = ['none', 'soft', 'solid'];

export interface ChatLayer {
  id: string;
  /** Sohbetin bağlı olduğu video varlığı */
  assetId: string;
  /** Sohbet kutusu, karenin oranı (0–1) */
  frame: Rect;
  /** Yazı yüksekliği, karenin yüksekliğine oranı */
  size: number;
  opacity: number;
  background: ChatBackground;
  /** Yazının arkasına gölge (arka plansız kullanımda okunurluk için) */
  shadow: boolean;
  /** Rozetleri (abone, moderatör, seviye…) göster */
  badges: boolean;
  /** Eşleme kaydırması (sn): artı değer sohbeti geciktirir */
  offset: number;
  /** Sohbetin gizlendiği aralıklar — KAYNAK zamanı */
  hides: ChatRange[];
}

export interface ChatBadge {
  /** subscriber | moderator | vip | og | verified | founder | sub_gifter | broadcaster | staff | level … */
  t: string;
  /** Ay sayısı / seviye / hediye adedi */
  n?: number;
  /** Hazır rozet görseli (Kick CDN adresi) */
  u?: string;
}

export interface ChatMessage {
  /** Kaynak (varlık) zamanı, sn */
  t: number;
  id: string;
  /** Kullanıcı adı ve Kick'teki rengi */
  u: string;
  c: string;
  b: ChatBadge[];
  /** İçerik; emote'lar `[emote:ID:ad]` olarak geçer */
  x: string;
  /** Yanıtlanan mesaj */
  r?: { u: string; x: string };
}

export interface ChatData {
  version: 1;
  assetId: string;
  channel: string;
  channelId: number;
  /** Kaynağın 0. saniyesinin duvar saati (ms, UTC) */
  baseMs: number;
  /** exact: yayın kaydından aralık (saniyesi belli) · approx: canlı kayıt/klip (kaydırma gerekebilir) */
  precision: 'exact' | 'approx';
  /** Sohbeti çekilmiş kaynak aralıkları */
  ranges: ChatRange[];
  subBadges: { months: number; url: string }[];
  messages: ChatMessage[];
  fetchedAt: string;
}

export const MAX_CHATS = 8;
export const CHAT_SIZE_RANGE = { min: 0.008, max: 0.06 } as const;
export const CHAT_OFFSET_RANGE = { min: -120, max: 120 } as const;
/** Parça başında kutu boş açılmasın diye öncesinden çekilen sohbet (sn). */
export const CHAT_LOOKBACK_SEC = 90;
/** Dışa aktarmada sohbet akışının kare hızı (durumlar 100 ms'ye oturur). */
export const CHAT_FPS = 10;
/** Kaynak zamanında "sonuna kadar" sınırı (JSON'da sonsuz tutulamaz). */
export const CHAT_SOURCE_MAX = 48 * 3600;

/* ── Aralık hesabı ───────────────────────────────────────────────────────── */

const num = (v: unknown, dflt: number, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** Aralıkları sıralar, çakışan/bitişikleri birleştirir, bozukları atar. */
export function mergeRanges(raw: readonly ChatRange[], eps = 1e-6): ChatRange[] {
  const list = raw
    .map((r) => ({ start: Number(r?.start), end: Number(r?.end) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end - r.start > eps)
    .sort((a, b) => a.start - b.start);
  const out: ChatRange[] = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + eps) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** `from` aralıklarından `cut` aralıklarını çıkarır. */
export function subtractRanges(from: readonly ChatRange[], cut: readonly ChatRange[], eps = 1e-6): ChatRange[] {
  let out = mergeRanges(from, eps);
  for (const c of mergeRanges(cut, eps)) {
    const next: ChatRange[] = [];
    for (const r of out) {
      if (c.end <= r.start || c.start >= r.end) {
        next.push(r);
        continue;
      }
      if (c.start - r.start > eps) next.push({ start: r.start, end: c.start });
      if (r.end - c.end > eps) next.push({ start: c.end, end: r.end });
    }
    out = next;
  }
  return out;
}

/* ── Doğrulama ───────────────────────────────────────────────────────────── */

const idOk = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9_-]{1,40}$/i.test(v);

export function defaultChatFrame(format: ProjectFormat): Rect {
  // Dikeyde platform arayüzünün kapatmadığı orta-alt bölge; yatayda sağ kenar.
  return format === 'vertical' ? { x: 0.06, y: 0.5, w: 0.66, h: 0.27 } : { x: 0.745, y: 0.08, w: 0.235, h: 0.84 };
}

export function defaultChatLayer(id: string, assetId: string, format: ProjectFormat): ChatLayer {
  return { id, assetId, frame: defaultChatFrame(format), size: format === 'vertical' ? 0.0155 : 0.022, opacity: 1, background: 'soft', shadow: true, badges: true, offset: 0, hides: [] };
}

export function normalizeChatLayer(raw: unknown, assetIds: ReadonlySet<string>, format: ProjectFormat): ChatLayer | null {
  const c = (raw ?? {}) as Partial<ChatLayer>;
  if (!idOk(c.id) || !idOk(c.assetId) || !assetIds.has(c.assetId)) return null;
  const d = defaultChatLayer(c.id, c.assetId, format);
  const f = (c.frame ?? {}) as Partial<Rect>;
  return {
    id: c.id,
    assetId: c.assetId,
    frame: { x: num(f.x, d.frame.x, -3, 3), y: num(f.y, d.frame.y, -3, 3), w: num(f.w, d.frame.w, 0.02, 4), h: num(f.h, d.frame.h, 0.02, 4) },
    size: num(c.size, d.size, CHAT_SIZE_RANGE.min, CHAT_SIZE_RANGE.max),
    opacity: num(c.opacity, 1, 0, 1),
    background: CHAT_BACKGROUNDS.includes(c.background as ChatBackground) ? (c.background as ChatBackground) : d.background,
    shadow: c.shadow !== false,
    badges: c.badges !== false,
    offset: num(c.offset, 0, CHAT_OFFSET_RANGE.min, CHAT_OFFSET_RANGE.max),
    hides: mergeRanges(Array.isArray(c.hides) ? c.hides.slice(0, 500) : []).map((r) => ({ start: Math.max(0, r.start), end: Math.min(CHAT_SOURCE_MAX, r.end) })).filter((r) => r.end > r.start),
  };
}

/** Varlık başına en fazla bir sohbet katmanı; varlığı olmayanlar atılır. */
export function normalizeChats(raw: unknown, assetIds: ReadonlySet<string>, format: ProjectFormat): ChatLayer[] {
  const seen = new Set<string>();
  const ids = new Set<string>();
  const out: ChatLayer[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const layer = normalizeChatLayer(item, assetIds, format);
    if (!layer || seen.has(layer.assetId) || ids.has(layer.id)) continue;
    seen.add(layer.assetId);
    ids.add(layer.id);
    out.push(layer);
    if (out.length >= MAX_CHATS) break;
  }
  return out;
}

/* ── Seçim kimliği (zaman çizelgesi parçalarıyla aynı seçim alanını paylaşır) ── */

export const CHAT_SELECT_PREFIX = 'chat:';
export const chatSelectId = (layerId: string) => `${CHAT_SELECT_PREFIX}${layerId}`;
export const chatIdFromSelection = (selectedId: string | null | undefined) => (selectedId?.startsWith(CHAT_SELECT_PREFIX) ? selectedId.slice(CHAT_SELECT_PREFIX.length) : null);

/* ── Proje işlemleri (saf) ───────────────────────────────────────────────── */

type WithChats = Pick<Project, 'chats'>;

export const chatForAsset = (p: WithChats, assetId: string | null | undefined) => (assetId ? p.chats.find((c) => c.assetId === assetId) ?? null : null);

export function addChatLayer<P extends Project>(p: P, layer: ChatLayer): P {
  if (p.chats.some((c) => c.assetId === layer.assetId) || p.chats.length >= MAX_CHATS) return p;
  return { ...p, chats: [...p.chats, layer] };
}

export function updateChatLayer<P extends Project>(p: P, id: string, changes: Partial<Omit<ChatLayer, 'id' | 'assetId'>>): P {
  if (!p.chats.some((c) => c.id === id)) return p;
  return { ...p, chats: p.chats.map((c) => (c.id === id ? { ...c, ...changes } : c)) };
}

export function removeChatLayer<P extends Project>(p: P, id: string): P {
  if (!p.chats.some((c) => c.id === id)) return p;
  return { ...p, chats: p.chats.filter((c) => c.id !== id) };
}

/* ── Gizleme (kaynak zamanı) ─────────────────────────────────────────────── */

export const isChatHiddenAt = (layer: Pick<ChatLayer, 'hides'>, src: number) => layer.hides.some((r) => src >= r.start && src < r.end);

/**
 * "Buradan gizle": kaynak zamanı `src`'den bir sonraki gizli aralığa (yoksa
 * kaynağın sonuna) kadar gizler. "Buradan göster" ile bitişi belirlenir.
 */
export function hideChatFrom(layer: ChatLayer, src: number, sourceEnd = CHAT_SOURCE_MAX): ChatLayer {
  const s = Math.max(0, src);
  const end = Math.min(CHAT_SOURCE_MAX, Math.max(s + 0.05, sourceEnd));
  return { ...layer, hides: mergeRanges([...layer.hides, { start: s, end }]) };
}

/** "Buradan göster": `src`'yi içeren gizli aralık bu noktada biter (sonrası görünür). */
export function showChatFrom(layer: ChatLayer, src: number): ChatLayer {
  const hit = layer.hides.find((r) => src >= r.start && src < r.end);
  if (!hit) return layer;
  return { ...layer, hides: mergeRanges(layer.hides.flatMap((r) => (r === hit ? [{ start: r.start, end: src }] : [r])), 0.02) };
}

/* ── Zaman çizelgesi ↔ kaynak eşlemesi ──────────────────────────────────── */

export interface ChatSegment {
  /** Zaman çizelgesi aralığı (sn) */
  start: number;
  end: number;
  /** `start` anındaki kaynak zamanı ve parçanın hızı */
  src: number;
  speed: number;
  clipId: string;
}

type ClipLike = Pick<Clip, 'id' | 'trackId' | 'kind' | 'assetId' | 'start' | 'duration' | 'in' | 'speed'>;

/**
 * Sohbetin zaman çizelgesinde göründüğü bölümler. Bağlı varlığın video
 * parçalarından türetilir: aynı anda birden çok parça varsa (ör. kamera/ekran
 * düzeni) en alttaki yol esas alınır; gizli yollar ve gizleme aralıkları düşer.
 */
export function chatSegments(p: { clips: readonly ClipLike[]; tracks: Project['tracks'] }, layer: Pick<ChatLayer, 'assetId' | 'hides'>): ChatSegment[] {
  const order = new Map(p.tracks.map((t, i) => [t.id, i]));
  const hiddenTracks = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id));
  const clips = p.clips
    .filter((c) => c.kind === 'video' && c.assetId === layer.assetId && !hiddenTracks.has(c.trackId) && c.duration > 0)
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) || a.start - b.start);
  let taken: ChatRange[] = [];
  const out: ChatSegment[] = [];
  for (const c of clips) {
    const speed = c.speed || 1;
    const span = { start: c.start, end: c.start + c.duration };
    for (const free of subtractRanges([span], taken)) {
      const src0 = c.in + (free.start - c.start) * speed;
      const src1 = c.in + (free.end - c.start) * speed;
      for (const v of subtractRanges([{ start: src0, end: src1 }], layer.hides)) {
        const start = c.start + (v.start - c.in) / speed;
        const end = c.start + (v.end - c.in) / speed;
        if (end - start > 1e-4) out.push({ start, end, src: v.start, speed, clipId: c.id });
      }
    }
    taken = mergeRanges([...taken, span]);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** O anda sohbetin kaynak zamanı; sohbet görünmüyorsa null. */
export function chatSourceAt(segments: readonly ChatSegment[], t: number): number | null {
  for (const s of segments) if (t >= s.start && t < s.end) return s.src + (t - s.start) * s.speed;
  return null;
}

/**
 * Gizleme düğmeleri için: o anda karede duran bağlı parçanın kaynak zamanı
 * (gizli olsa bile). Parça yoksa null.
 */
export function chatClipSourceAt(p: { clips: readonly ClipLike[]; tracks: Project['tracks'] }, layer: Pick<ChatLayer, 'assetId'>, t: number): number | null {
  return chatSourceAt(chatSegments(p, { assetId: layer.assetId, hides: [] }), t);
}

/** Bir video parçasının üstünde sohbetin göründüğü bölümler, parçaya göre oran (0–1) olarak. */
export function chatVisibleOnClip(clip: Pick<Clip, 'in' | 'duration' | 'speed'>, layer: Pick<ChatLayer, 'hides'>): { from: number; to: number }[] {
  const speed = clip.speed || 1;
  const span = clip.duration * speed;
  if (!(span > 0)) return [];
  return subtractRanges([{ start: clip.in, end: clip.in + span }], layer.hides).map((r) => ({ from: (r.start - clip.in) / span, to: (r.end - clip.in) / span }));
}

/** Projede bu varlıktan kullanılan kaynak aralıkları (öncesi payıyla) — sohbeti çekilecek bölümler. */
export function neededChatRanges(p: { clips: readonly ClipLike[] }, assetId: string, lookback = CHAT_LOOKBACK_SEC): ChatRange[] {
  return mergeRanges(
    p.clips
      .filter((c) => c.kind === 'video' && c.assetId === assetId)
      .map((c) => ({ start: Math.max(0, c.in - lookback), end: c.in + c.duration * (c.speed || 1) + 2 })),
  );
}

/** Çekilmiş aralıkların karşılamadığı bölümler. */
export const missingChatRanges = (needed: readonly ChatRange[], fetched: readonly ChatRange[]) => subtractRanges(needed, fetched, 0.5).filter((r) => r.end - r.start >= 1);

/* ── Mesajlar ────────────────────────────────────────────────────────────── */

/** Zamanı `t` ya da öncesi olan son mesajın sırası; yoksa -1 (mesajlar zamana göre sıralı). */
export function lastIndexAt(times: ArrayLike<{ t: number }>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export type ChatToken = { type: 'text'; text: string } | { type: 'emote'; id: string; name: string };

/** İçeriği yazı ve emote parçalarına ayırır. */
export function tokenizeChat(content: string): ChatToken[] {
  const out: ChatToken[] = [];
  const re = /\[emote:(\d{1,12}):([^\]\n]{0,60})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m.index > last) out.push({ type: 'text', text: content.slice(last, m.index) });
    out.push({ type: 'emote', id: m[1], name: m[2] });
    last = m.index + m[0].length;
  }
  if (last < content.length) out.push({ type: 'text', text: content.slice(last) });
  return out;
}

/** Kanalın abone rozetlerinden ay sayısına uyan görsel (en büyük eşik ≤ ay). */
export function subBadgeFor(subBadges: readonly { months: number; url: string }[], months: number | undefined): string | null {
  let best: { months: number; url: string } | null = null;
  for (const b of subBadges) if (b.months <= (months ?? 1) && (!best || b.months > best.months)) best = b;
  return best?.url ?? subBadges[0]?.url ?? null;
}

/* ── Dışa aktarma planı ──────────────────────────────────────────────────── */

/**
 * Arayüz her mesajı çıktı çözünürlüğünde satır olarak çizer, satırları uzun
 * sayfalara (PNG) dizer ve bu planı yükler; sunucu kareleri bu satırlardan
 * derler (bkz. server/services/ChatOverlay.ts). Böylece dışa aktarılan sohbet
 * önizlemedekiyle aynı piksellerdir.
 */
export interface ChatRenderPlan {
  chatId: string;
  /** Kutunun karedeki yeri ve boyutu (piksel) */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Üst/alt iç boşluk (piksel) */
  padY: number;
  opacity: number;
  /** Arka plan sayfası (kutu boyutunda) var mı — sayfa adı `bg` */
  hasBackground: boolean;
  pages: number;
  /** [kaynak zamanı (kaydırma dahil), sayfa, y, yükseklik] — zamana göre sıralı */
  rows: [number, number, number, number][];
  /** Planın üretildiği katman ayarının özeti (eski plan yanlışlıkla kullanılmasın) */
  key: string;
}

export const CHAT_PAGE_MAX_HEIGHT = 4096;
/** Plan JSON'u sunucunun 1 MB gövde sınırının altında kalsın (satır başına ~22 bayt). */
export const CHAT_PLAN_MAX_ROWS = 25_000;

/** Katman ayarı + çıktı biçiminden plan anahtarı: ayar değişince eski plan geçersiz sayılır. */
export function chatPlanKey(layer: ChatLayer, format: ProjectFormat): string {
  return JSON.stringify([layer.id, layer.assetId, layer.frame, layer.size, layer.background, layer.shadow, layer.badges, layer.offset, layer.opacity, format]);
}

export function normalizeChatPlan(raw: unknown): ChatRenderPlan | null {
  const p = (raw ?? {}) as Partial<ChatRenderPlan>;
  if (!idOk(p.chatId) || !Array.isArray(p.rows)) return null;
  const width = Math.round(num(p.width, 0, 0, 8192));
  const height = Math.round(num(p.height, 0, 0, 8192));
  const pages = Math.round(num(p.pages, 0, 0, 2000));
  if (width < 2 || height < 2) return null;
  const rows: ChatRenderPlan['rows'] = [];
  for (const r of p.rows.slice(0, CHAT_PLAN_MAX_ROWS)) {
    if (!Array.isArray(r)) continue;
    const [t, page, y, h] = r.map(Number);
    if (!Number.isFinite(t) || !Number.isInteger(page) || page < 0 || page >= pages) continue;
    if (!Number.isInteger(y) || !Number.isInteger(h) || y < 0 || h < 1 || y + h > CHAT_PAGE_MAX_HEIGHT) continue;
    rows.push([t, page, y, h]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  return {
    chatId: p.chatId,
    x: Math.round(num(p.x, 0, -8192, 8192)),
    y: Math.round(num(p.y, 0, -8192, 8192)),
    width,
    height,
    padY: Math.round(num(p.padY, 0, 0, height / 2)),
    opacity: num(p.opacity, 1, 0, 1),
    hasBackground: p.hasBackground === true,
    pages,
    rows,
    key: typeof p.key === 'string' ? p.key.slice(0, 600) : '',
  };
}
