/**
 * Kick sohbet satırlarının çizimi — önizleme ve dışa aktarma AYNI kodu
 * kullanır. Her mesaj çıktı çözünürlüğünde bir "satır" tuvaline çizilir
 * (rozetler, renkli kullanıcı adı, yazı ve emote'lar; genişliğe göre
 * kaydırılır). Önizleme bu satırları küçülterek gösterir, dışa aktarma aynı
 * satırları sayfalara dizip sunucuya yollar; böylece çıktı önizlemeyle birebir
 * aynıdır.
 *
 * Yerleşim (`layoutChatRow`) tuvalden bağımsızdır: ölçüm ve görsel boyutu
 * dışarıdan verilir, test edilebilir.
 */
import { subBadgeFor, tokenizeChat, type ChatBackground, type ChatBadge, type ChatLayer, type ChatMessage } from '../../shared/chat.ts';
import { FORMAT_SIZE, type ProjectFormat } from '../../shared/project.ts';
import { TEXT_FONTS } from './textRender.ts';

export const CHAT_FONT = TEXT_FONTS.body;
const TEXT_COLOR = '#f3f5f6';
const DIM_COLOR = 'rgba(243,245,246,0.62)';
const BACKGROUNDS: Record<ChatBackground, string | null> = { none: null, soft: 'rgba(12,14,17,0.52)', solid: 'rgba(12,14,17,0.92)' };

export const emoteUrl = (id: string) => `/api/chat/emote/${id}`;
export const cdnUrl = (url: string) => `/api/chat/img?u=${encodeURIComponent(url)}`;

/** Sohbet kutusunun çıktı karesindeki piksel ölçüleri. */
export interface ChatMetrics {
  x: number;
  y: number;
  width: number;
  height: number;
  font: number;
  padX: number;
  padY: number;
  lineH: number;
  emote: number;
  badge: number;
  gap: number;
  rowGap: number;
  radius: number;
}

export function chatMetrics(layer: Pick<ChatLayer, 'frame' | 'size'>, format: ProjectFormat): ChatMetrics {
  const { w: W, h: H } = FORMAT_SIZE[format];
  const font = Math.max(8, Math.round(layer.size * H));
  return {
    x: Math.round(layer.frame.x * W),
    y: Math.round(layer.frame.y * H),
    width: Math.max(4, Math.round(layer.frame.w * W)),
    height: Math.max(4, Math.round(layer.frame.h * H)),
    font,
    padX: Math.round(font * 0.6),
    padY: Math.round(font * 0.45),
    lineH: Math.round(font * 1.42),
    emote: Math.round(font * 1.6),
    badge: Math.round(font * 1.05),
    gap: Math.round(font * 0.24),
    rowGap: Math.round(font * 0.36),
    radius: Math.round(font * 0.55),
  };
}

/** Kutuya en fazla sığabilecek satır sayısı (her satır en az bir yazı satırıdır). */
export const maxChatRows = (m: ChatMetrics) => Math.max(1, Math.ceil((m.height - 2 * m.padY) / (m.lineH + m.rowGap)) + 1);

/* ── Yerleşim ────────────────────────────────────────────────────────────── */

export type ChatItem =
  | { kind: 'text'; text: string; x: number; y: number; color: string; bold: boolean; size: number }
  | { kind: 'img'; url: string; x: number; y: number; w: number; h: number }
  | { kind: 'glyph'; type: string; x: number; y: number; size: number };

export interface ChatRowLayout {
  height: number;
  items: ChatItem[];
  /** Çizim için gereken görseller */
  images: string[];
}

export interface LayoutEnv {
  /** Yazı genişliği (piksel) */
  measure: (text: string, bold: boolean, size: number) => number;
  /** Yüklenmiş görselin en/boy oranı; bilinmiyorsa null (kare sayılır) */
  aspect: (url: string) => number | null;
  subBadges: readonly { months: number; url: string }[];
  badges: boolean;
}

type Piece = { kind: 'text'; text: string; w: number; color: string; bold: boolean; space?: boolean } | { kind: 'img'; url: string; w: number; h: number } | { kind: 'glyph'; type: string; w: number };

/** Rozetin görseli (abone/seviye) ya da çizilecek simgesi. */
export function badgeArt(b: ChatBadge, subBadges: LayoutEnv['subBadges']): { url: string } | { glyph: string } {
  if (b.u) return { url: cdnUrl(b.u) };
  if (b.t === 'subscriber') {
    const u = subBadgeFor(subBadges, b.n);
    if (u) return { url: cdnUrl(u) };
  }
  return { glyph: b.t };
}

/** Uzun kelimeyi genişliğe sığacak parçalara böler. */
function breakWord(word: string, max: number, measure: (t: string) => number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of Array.from(word)) {
    if (cur && measure(cur + ch) > max) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Bir mesajın satır yerleşimi: [rozetler] kullanıcı adı: yazı ve emote'lar.
 * Yanıt ise üstte tek satırlık soluk bir alıntı bulunur. Koordinatlar satırın
 * sol üstüne göredir; yazı `y` değeri satırın dikey ortasıdır.
 */
export function layoutChatRow(msg: ChatMessage, m: ChatMetrics, env: LayoutEnv): ChatRowLayout {
  const maxW = Math.max(m.font * 3, m.width - 2 * m.padX);
  const items: ChatItem[] = [];
  const images: string[] = [];
  let top = 0;

  if (msg.r) {
    const size = Math.round(m.font * 0.8);
    let text = `↩ @${msg.r.u}: ${tokenizeChat(msg.r.x).map((t) => (t.type === 'text' ? t.text : t.name)).join('')}`.replace(/\s+/g, ' ');
    if (env.measure(text, false, size) > maxW) {
      const chars = Array.from(text);
      while (chars.length > 4 && env.measure(`${chars.join('')}…`, false, size) > maxW) chars.pop();
      text = `${chars.join('')}…`;
    }
    const h = Math.round(size * 1.35);
    items.push({ kind: 'text', text, x: m.padX, y: h / 2, color: DIM_COLOR, bold: false, size });
    top = h;
  }

  // Satır içi parçalar
  const pieces: Piece[] = [];
  if (env.badges) {
    for (const b of msg.b) {
      const art = badgeArt(b, env.subBadges);
      if ('url' in art) {
        pieces.push({ kind: 'img', url: art.url, w: m.badge, h: m.badge });
        images.push(art.url);
      } else pieces.push({ kind: 'glyph', type: art.glyph, w: m.badge });
    }
  }
  const sp = env.measure(' ', false, m.font);
  pieces.push({ kind: 'text', text: `${msg.u}:`, w: env.measure(`${msg.u}:`, true, m.font), color: msg.c, bold: true });
  pieces.push({ kind: 'text', text: ' ', w: sp, color: TEXT_COLOR, bold: false, space: true });
  for (const tok of tokenizeChat(msg.x)) {
    if (tok.type === 'emote') {
      const url = emoteUrl(tok.id);
      const ratio = Math.min(3, Math.max(0.4, env.aspect(url) ?? 1));
      pieces.push({ kind: 'img', url, w: Math.round(m.emote * ratio), h: m.emote });
      images.push(url);
      continue;
    }
    for (const part of tok.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) pieces.push({ kind: 'text', text: ' ', w: sp, color: TEXT_COLOR, bold: false, space: true });
      else {
        const w = env.measure(part, false, m.font);
        if (w <= maxW) pieces.push({ kind: 'text', text: part, w, color: TEXT_COLOR, bold: false });
        else for (const chunk of breakWord(part, maxW, (t) => env.measure(t, false, m.font))) pieces.push({ kind: 'text', text: chunk, w: env.measure(chunk, false, m.font), color: TEXT_COLOR, bold: false });
      }
    }
  }

  // Görsel ↔ görsel ve görsel → yazı arasında küçük boşluk (rozetler, art arda emote'lar).
  const gapBefore = (prev: Piece | null, p: Piece) => (prev && prev.kind !== 'text' && (p.kind !== 'text' || !p.space) ? m.gap : 0);

  // Kaydırma: parça sığmıyorsa alt satıra; satır başındaki boşluk atılır.
  const lines: { pieces: Piece[]; width: number }[] = [{ pieces: [], width: 0 }];
  for (const p of pieces) {
    let line = lines[lines.length - 1];
    const isSpace = p.kind === 'text' && p.space === true;
    const lead = gapBefore(line.pieces[line.pieces.length - 1] ?? null, p);
    if (line.pieces.length && line.width + lead + p.w > maxW) {
      if (isSpace) continue;
      line = { pieces: [], width: 0 };
      lines.push(line);
      line.pieces.push(p);
      line.width = p.w;
      continue;
    }
    if (isSpace && !line.pieces.length) continue;
    line.pieces.push(p);
    line.width += lead + p.w;
  }

  let y = top;
  for (const line of lines) {
    const tall = line.pieces.some((p) => p.kind === 'img' && p.h > m.lineH - 2);
    const h = tall ? m.emote + Math.round(m.font * 0.14) : m.lineH;
    let x = m.padX;
    let prev: Piece | null = null;
    for (const p of line.pieces) {
      x += gapBefore(prev, p);
      if (p.kind === 'text') {
        if (!p.space) items.push({ kind: 'text', text: p.text, x, y: y + h / 2, color: p.color, bold: p.bold, size: m.font });
      } else if (p.kind === 'img') items.push({ kind: 'img', url: p.url, x, y: y + (h - p.h) / 2, w: p.w, h: p.h });
      else items.push({ kind: 'glyph', type: p.type, x, y: y + (h - p.w) / 2, size: p.w });
      x += p.w;
      prev = p;
    }
    y += h;
  }
  return { height: Math.ceil(y + m.rowGap), items, images: [...new Set(images)] };
}

/* ── Görseller ───────────────────────────────────────────────────────────── */

/** Emote ve rozet görselleri: aynı kökenden (sunucu önbelleği) yüklenir, tuval kirlenmez. */
export class ChatImages {
  private map = new Map<string, HTMLImageElement | null>();
  private pending = new Map<string, Promise<void>>();
  /** Bir görsel yüklendiğinde (önizlemenin yeniden çizilmesi için) */
  onLoad: (() => void) | null = null;

  /** Yüklüyse görsel; değilse yüklemeyi başlatır ve null döner. Yüklenemeyen görsel hep null. */
  get(url: string): HTMLImageElement | null {
    if (this.map.has(url)) return this.map.get(url) ?? null;
    void this.load(url);
    return null;
  }

  /** Görsel denenmiş mi (yüklenmiş ya da yüklenemeyeceği belli)? */
  settled(url: string) {
    return this.map.has(url);
  }

  aspect = (url: string): number | null => {
    const img = this.get(url);
    return img && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null;
  };

  load(url: string): Promise<void> {
    if (this.map.has(url)) return Promise.resolve();
    let p = this.pending.get(url);
    if (!p) {
      p = new Promise<void>((resolve) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => {
          this.map.set(url, img);
          this.pending.delete(url);
          this.onLoad?.();
          resolve();
        };
        img.onerror = () => {
          this.map.set(url, null);
          this.pending.delete(url);
          this.onLoad?.();
          resolve();
        };
        img.src = url;
      });
      this.pending.set(url, p);
    }
    return p;
  }

  /** Dışa aktarma öncesi: verilen görsellerin hepsi denenene kadar bekler (sınırlı eşzamanlılık). */
  async loadAll(urls: Iterable<string>, onProgress?: (done: number, total: number) => void) {
    const list = [...new Set(urls)].filter((u) => !this.map.has(u));
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        await this.load(list[next++]);
        onProgress?.(++done, list.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
  }
}

/* ── Çizim ───────────────────────────────────────────────────────────────── */

const fontOf = (bold: boolean, size: number) => `${bold ? 700 : 500} ${size}px ${CHAT_FONT}`;

let measureCtx: CanvasRenderingContext2D | null = null;
/** Tuvalle ölçüm (yazı tipi yüklendikten sonra tutarlıdır). */
export function canvasMeasure(text: string, bold: boolean, size: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  const f = fontOf(bold, size);
  if (measureCtx.font !== f) measureCtx.font = f;
  return measureCtx.measureText(text).width;
}

/** Sohbet yazı tipinin iki kalınlığı da yüklensin (ölçüm ve çizim tutarlı olsun). */
export async function chatFontsReady(size = 24) {
  try {
    await Promise.all([document.fonts.load(fontOf(false, size)), document.fonts.load(fontOf(true, size))]);
    await document.fonts.ready;
  } catch {
    /* yazı tipi API'si yoksa sistem yazı tipiyle devam */
  }
}

/** Görseli olmayan rozet türleri için sade simgeler (Kick'in kendi ikonları değil, tür rengiyle benzer işaretler). */
function drawGlyph(ctx: CanvasRenderingContext2D, type: string, x: number, y: number, s: number) {
  const palette: Record<string, string> = { moderator: '#00c7ff', vip: '#fa4e78', og: '#00d1b2', verified: '#1efa41', founder: '#f5a524', sub_gifter: '#a855f7', broadcaster: '#ef4444', staff: '#53fc18', subscriber: '#f97316' };
  const color = palette[type] ?? '#8b949e';
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, s, s, s * 0.22);
  ctx.fill();
  ctx.fillStyle = '#0b0e11';
  ctx.strokeStyle = '#0b0e11';
  ctx.lineWidth = Math.max(1, s * 0.13);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const p = (px: number, py: number) => [px * s, py * s] as const;
  switch (type) {
    case 'moderator': // kalkan
      ctx.moveTo(...p(0.5, 0.18));
      ctx.lineTo(...p(0.78, 0.3));
      ctx.lineTo(...p(0.74, 0.62));
      ctx.lineTo(...p(0.5, 0.84));
      ctx.lineTo(...p(0.26, 0.62));
      ctx.lineTo(...p(0.22, 0.3));
      ctx.closePath();
      ctx.fill();
      break;
    case 'vip': // elmas
      ctx.moveTo(...p(0.5, 0.2));
      ctx.lineTo(...p(0.8, 0.46));
      ctx.lineTo(...p(0.5, 0.82));
      ctx.lineTo(...p(0.2, 0.46));
      ctx.closePath();
      ctx.fill();
      break;
    case 'verified': // onay işareti
      ctx.moveTo(...p(0.26, 0.52));
      ctx.lineTo(...p(0.44, 0.7));
      ctx.lineTo(...p(0.76, 0.32));
      ctx.stroke();
      break;
    case 'founder':
    case 'subscriber': {
      // yıldız
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.16 : 0.36;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const pt = p(0.5 + r * Math.cos(a), 0.52 + r * Math.sin(a));
        if (i) ctx.lineTo(...pt);
        else ctx.moveTo(...pt);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'sub_gifter': // hediye kutusu: gövde + kapak, üstte fiyonk, ortada kurdele
      ctx.rect(s * 0.25, s * 0.5, s * 0.5, s * 0.32);
      ctx.rect(s * 0.19, s * 0.36, s * 0.62, s * 0.14);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(s * 0.4, s * 0.26, s * 0.1, 0, Math.PI * 2);
      ctx.arc(s * 0.6, s * 0.26, s * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, s * 0.1);
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(...p(0.5, 0.36));
      ctx.lineTo(...p(0.5, 0.82));
      ctx.stroke();
      break;
    case 'broadcaster': // oynat üçgeni
      ctx.moveTo(...p(0.36, 0.26));
      ctx.lineTo(...p(0.74, 0.5));
      ctx.lineTo(...p(0.36, 0.74));
      ctx.closePath();
      ctx.fill();
      break;
    case 'og': {
      ctx.font = `800 ${Math.round(s * 0.5)}px ${CHAT_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('OG', s / 2, s * 0.54);
      break;
    }
    default: // nokta
      ctx.arc(s / 2, s / 2, s * 0.2, 0, Math.PI * 2);
      ctx.fill();
  }
  ctx.restore();
}

export interface ChatRowImage {
  canvas: HTMLCanvasElement;
  height: number;
  /** Tüm görselleri yüklenmiş olarak çizildi mi (değilse önbelleğe alınmaz) */
  complete: boolean;
}

/** Yerleşimi `ctx` üzerine (0, oy) noktasından çizer. */
export function drawChatRow(ctx: CanvasRenderingContext2D, layout: ChatRowLayout, oy: number, images: ChatImages, shadow: boolean): boolean {
  let complete = true;
  ctx.save();
  ctx.translate(0, oy);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  for (const it of layout.items) {
    if (it.kind === 'text') {
      ctx.font = fontOf(it.bold, it.size);
      if (shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.75)';
        ctx.shadowBlur = it.size * 0.22;
        ctx.shadowOffsetY = it.size * 0.05;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = it.size * 0.16;
        ctx.strokeText(it.text, it.x, it.y);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
      }
      ctx.fillStyle = it.color;
      ctx.fillText(it.text, it.x, it.y);
    } else if (it.kind === 'img') {
      const img = images.get(it.url);
      if (img) ctx.drawImage(img, it.x, it.y, it.w, it.h);
      else if (!images.settled(it.url)) complete = false;
    } else drawGlyph(ctx, it.type, it.x, it.y, it.size);
  }
  ctx.restore();
  return complete;
}

/** Tek mesajı kendi tuvaline (kutu genişliğinde, saydam zeminli) çizer. */
export function renderChatRow(msg: ChatMessage, m: ChatMetrics, env: LayoutEnv, images: ChatImages, shadow: boolean): ChatRowImage {
  const layout = layoutChatRow(msg, m, env);
  const canvas = document.createElement('canvas');
  canvas.width = m.width;
  canvas.height = Math.max(1, layout.height);
  const complete = drawChatRow(canvas.getContext('2d')!, layout, 0, images, shadow);
  return { canvas, height: layout.height, complete };
}

/** Kutunun arka planı (çıktı pikseli ölçüsünde). */
export function drawChatBackground(ctx: CanvasRenderingContext2D, m: ChatMetrics, background: ChatBackground) {
  const fill = BACKGROUNDS[background];
  if (!fill) return;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(0, 0, m.width, m.height, m.radius);
  ctx.fill();
}

/**
 * Satırların kutudaki dikey yerleri: alt kenardan yukarı, tamamı sığanlar
 * (sunucudaki `visibleRows` ile aynı kural).
 */
export function stackRows(heights: (i: number) => number, last: number, m: Pick<ChatMetrics, 'height' | 'padY'>): { index: number; y: number }[] {
  const out: { index: number; y: number }[] = [];
  let y = m.height - m.padY;
  for (let i = last; i >= 0; i--) {
    const h = heights(i);
    if (y - h < m.padY) break;
    y -= h;
    out.push({ index: i, y });
  }
  return out;
}
