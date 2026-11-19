import axios from 'axios';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Server as IOServer } from 'socket.io';
import { CHAT_SOURCE_MAX, mergeRanges, missingChatRanges, type ChatBadge, type ChatData, type ChatMessage, type ChatRange } from '../../shared/chat.ts';
import type { AssetOrigin } from '../../shared/project.ts';
import { config } from '../config.ts';
import type { Store } from '../db/Store.ts';
import { BROWSER_HEADERS, SLUG_PATTERN } from '../engine.ts';
import { HttpError, badRequest, notFound } from '../http.ts';

/** Tek istekte çekilebilecek en uzun toplam sohbet (sn) ve en çok mesaj. */
const MAX_FETCH_SEC = 8 * 3600;
const MAX_MESSAGES = 250_000;
/** Paralel çekim: aralık bu uzunlukta dilimlere bölünür, dilimler kuyruktan işlenir. */
const SLICE_MS = 60_000;
const WORKERS = 5;
const PAGE_PAUSE_MS = 40;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_HOSTS = new Set(['files.kick.com', 'ext.cdn.kick.com']);

/** Kick'in sohbet mesajı (kullandığımız alanlar). */
export interface RawKickMessage {
  id: string;
  content?: string;
  type?: string;
  metadata?: string | Record<string, unknown> | null;
  created_at?: string;
  sender?: { username?: string; identity?: { color?: string; badges?: unknown[]; badges_v2?: unknown[] } };
}

export interface MessagePage {
  messages: RawKickMessage[];
  cursor: string | null;
}

export type PageFetcher = (channelId: number, cursor: string) => Promise<MessagePage>;

/** Sohbetin bağlanacağı yayın: kanal ve kaynağın 0. saniyesinin duvar saati. */
export interface ChatBinding {
  channel: string;
  baseMs: number;
  precision: ChatData['precision'];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/**
 * Kick saatleri UTC verir: "2026-11-09 18:32:34" ya da ISO. Veritabanından
 * okunan `_at` kolonları Date olarak gelir (bkz. Store.fromSql) — o da kabul edilir.
 */
export function kickTimeMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const s = String(value ?? '').trim();
  if (!s) return NaN;
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
}

function parseMeta(meta: RawKickMessage['metadata']): Record<string, any> {
  if (!meta) return {};
  if (typeof meta === 'object') return meta as Record<string, any>;
  try {
    const v = JSON.parse(meta);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Mesajın gönderildiği an (ms): milisaniyelik damga varsa o, yoksa saniyelik `created_at`. */
export function messageTimeMs(m: RawKickMessage): number {
  const created = kickTimeMs(m.created_at);
  const ref = Number(parseMeta(m.metadata).message_ref);
  // Damga saniyelik zamanla tutarlıysa (aynı mesaja ait) kullanılır.
  if (Number.isFinite(ref) && Number.isFinite(created) && Math.abs(ref - created) < 5000) return ref;
  return created;
}

const HEX = /^#[0-9a-f]{6}$/i;
const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

function imageUrlOk(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > 400) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && IMAGE_HOSTS.has(url.hostname) && !url.pathname.includes('..');
  } catch {
    return false;
  }
}

/**
 * Görsel türü içeriğin ilk baytlarından okunur: Kick'in CDN'i bazı emote'ları
 * `binary/octet-stream` olarak verir, başlığa güvenilmez. Tanınmayan içerik
 * (ör. SVG, HTML) reddedilir.
 */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  const tag = (from: number, to: number) => buf.toString('latin1', from, to);
  if (buf[0] === 0x89 && tag(1, 4) === 'PNG') return 'image/png';
  if (tag(0, 4) === 'GIF8') return 'image/gif';
  if (tag(0, 4) === 'RIFF' && tag(8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (tag(4, 12) === 'ftypavif') return 'image/avif';
  return null;
}

function badgesOf(identity: NonNullable<RawKickMessage['sender']>['identity']): ChatBadge[] {
  const list: { order: number; badge: ChatBadge }[] = [];
  for (const b of (Array.isArray(identity?.badges) ? identity!.badges : []) as any[]) {
    if (!b || typeof b.type !== 'string') continue;
    const badge: ChatBadge = { t: clean(b.type, 24) };
    if (Number.isFinite(Number(b.count))) badge.n = Number(b.count);
    list.push({ order: Number(b.sort_order) || 50, badge });
  }
  // Seviye gibi hazır görselli rozetler: yalnız kullanıcının seçtiği gösterilir.
  for (const b of (Array.isArray(identity?.badges_v2) ? identity!.badges_v2 : []) as any[]) {
    if (!b || b.selected !== true || typeof b.name !== 'string' || !imageUrlOk(b.image_url)) continue;
    const badge: ChatBadge = { t: clean(b.name, 24), u: b.image_url };
    if (Number.isFinite(Number(b.metadata?.level))) badge.n = Number(b.metadata.level);
    list.push({ order: Number(b.sort_order) || 50, badge });
  }
  return list.sort((a, b) => a.order - b.order).slice(0, 6).map((x) => x.badge);
}

/** Kick mesajını saklanan biçime çevirir; sohbet satırı olmayan türleri (kutlama vb.) atar. */
export function toChatMessage(m: RawKickMessage, baseMs: number): ChatMessage | null {
  if (!m || typeof m.id !== 'string' || (m.type !== 'message' && m.type !== 'reply')) return null;
  const ms = messageTimeMs(m);
  if (!Number.isFinite(ms)) return null;
  const content = clean(m.content, 500);
  if (!content.trim()) return null;
  const color = m.sender?.identity?.color;
  const out: ChatMessage = {
    t: Math.round(ms - baseMs) / 1000,
    id: m.id.slice(0, 64),
    u: clean(m.sender?.username, 40) || 'kullanıcı',
    c: typeof color === 'string' && HEX.test(color) ? color : '#b8c0c8',
    b: badgesOf(m.sender?.identity),
    x: content,
  };
  if (m.type === 'reply') {
    const meta = parseMeta(m.metadata);
    const user = clean(meta.original_sender?.username, 40);
    const text = clean(meta.original_message?.content, 160);
    if (user && text) out.r = { u: user, x: text };
  }
  return out;
}

/**
 * [fromMs, toMs) aralığındaki tüm mesajları çeker. Kick'in mesaj uç noktası
 * `?cursor=<mikrosaniye>` ile o andan GERİYE doğru 25'er mesaj verir; aralık
 * dilimlere bölünür ve dilimler koşut işlenir (`start_time` parametresi istek
 * başına 25 mesajla sınırlıdır ve yoğun anlarda mesaj kaçırır — kullanılmaz).
 */
export async function fetchMessageRange(
  channelId: number,
  fromMs: number,
  toMs: number,
  { fetchPage, onProgress, pauseMs = PAGE_PAUSE_MS, signal, maxMessages = MAX_MESSAGES }: { fetchPage: PageFetcher; onProgress?: (done: number, total: number, count: number) => void; pauseMs?: number; signal?: { aborted: boolean }; maxMessages?: number },
): Promise<RawKickMessage[]> {
  const found = new Map<string, RawKickMessage>();
  const slices: { from: number; to: number }[] = [];
  for (let t = fromMs; t < toMs; t += SLICE_MS) slices.push({ from: t, to: Math.min(toMs, t + SLICE_MS) });
  const total = Math.max(1, toMs - fromMs);
  let covered = 0;
  let next = 0;

  const worker = async () => {
    while (next < slices.length) {
      const slice = slices[next++];
      // İmleç dilimin sonundan biraz ileriden başlar: Kick'in sıralama zamanı ile mesajın
      // kendi damgası arasındaki küçük fark yüzünden sınırdaki mesaj kaçmasın.
      let cursor = String(Math.round((slice.to + 1500) * 1000));
      let reached = slice.to;
      for (let page = 0; page < 20_000; page++) {
        if (signal?.aborted) throw new HttpError(499, 'İptal edildi');
        const res = await fetchPage(channelId, cursor);
        if (!res.messages.length) break;
        let oldest = Infinity;
        for (const m of res.messages) {
          const ms = messageTimeMs(m);
          if (!Number.isFinite(ms)) continue;
          if (ms < oldest) oldest = ms;
          if (ms >= fromMs && ms < toMs && typeof m.id === 'string') found.set(m.id, m);
        }
        if (found.size > maxMessages) throw badRequest('Bu aralıkta çok fazla mesaj var — daha kısa bir bölüm seç');
        const progressed = Math.max(0, reached - Math.max(slice.from, oldest));
        covered += progressed;
        reached = Math.min(reached, Math.max(slice.from, oldest));
        onProgress?.(Math.min(total, covered), total, found.size);
        if (oldest < slice.from) break;
        // İmleç geriye gitmiyorsa (aynı sayfa) sonsuz döngüye girme.
        if (!res.cursor || !(Number(res.cursor) < Number(cursor))) break;
        cursor = res.cursor;
        if (pauseMs) await sleep(pauseMs);
      }
      covered += Math.max(0, reached - slice.from);
      onProgress?.(Math.min(total, covered), total, found.size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, slices.length) }, worker));
  return [...found.values()];
}

/** Kick'ten bir mesaj sayfası; geçici hatalarda (429/5xx/ağ) artan beklemeyle yeniden dener. */
export const kickPage: PageFetcher = async (channelId, cursor) => {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await axios.get(`https://kick.com/api/v2/channels/${channelId}/messages`, { params: { cursor }, headers: BROWSER_HEADERS, timeout: 15_000 });
      const d = res.data?.data ?? {};
      return { messages: Array.isArray(d.messages) ? d.messages : [], cursor: d.cursor ? String(d.cursor) : null };
    } catch (err) {
      lastErr = err;
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status && status !== 429 && status < 500) break;
      await sleep(1500 * (attempt + 1));
    }
  }
  const status = (lastErr as { response?: { status?: number } })?.response?.status;
  throw new HttpError(502, status === 403 ? 'Kick sohbet geçmişine erişimi reddetti — biraz sonra yeniden dene' : 'Kick sohbet geçmişi alınamadı');
};

interface Active {
  promise: Promise<ChatData>;
}

/**
 * Editördeki sohbet katmanının verisi: varlığın (indirilen yayın aralığı,
 * yayın kaydı, Kick klibi) hangi yayına ve saate denk geldiğini bulur, o
 * aralığın sohbet geçmişini Kick'ten çekip projenin yanında saklar; emote ve
 * rozet görsellerini önbelleğe alıp aynı kökenden sunar (dışa aktarmada
 * tuvale çizilebilsin diye).
 */
export class ChatHistory {
  private active = new Map<string, Active>();
  private images = new Map<string, Promise<{ file: string; type: string }>>();
  private store: Store;
  private io: IOServer;
  private listVideos: (slug: string) => Promise<{ id: string | number; startedAt?: string | null }[]>;
  private fetchPage: PageFetcher;

  constructor(store: Store, io: IOServer, vodScanner: { listVideos: (slug: string, opts?: unknown) => Promise<any[]> }, fetchPage: PageFetcher = kickPage) {
    this.store = store;
    this.io = io;
    this.listVideos = (slug) => vodScanner.listVideos(slug, { includeLive: true });
    this.fetchPage = fetchPage;
  }

  /* ── Dizinler ──────────────────────────────────────────────────────────── */

  private chatDir(userId: number, projectId: number) {
    return path.join(config.clipDir, String(userId), 'projects', String(projectId), 'chat');
  }

  private dataFile(userId: number, projectId: number, assetId: string) {
    return path.join(this.chatDir(userId, projectId), `${assetId}.json`);
  }

  /** Dışa aktarma planı ve satır sayfaları (bkz. ChatOverlay). */
  renderDir(userId: number, projectId: number, chatId?: string) {
    const base = path.join(config.clipDir, String(userId), 'projects', String(projectId), 'chat-render');
    return chatId ? path.join(base, chatId) : base;
  }

  /* ── Yayın bağlaması ───────────────────────────────────────────────────── */

  /** Varlığın kaynağından kanal ve başlangıç saati; bağlanamıyorsa anlaşılır hata. */
  async binding(userId: number, origin: AssetOrigin): Promise<ChatBinding> {
    if (origin.type === 'vod') {
      const job = this.store.get('SELECT id, channel_slug, source_video_id, range_start_sec, stream_started_at FROM vod_scan_jobs WHERE id = ? AND user_id = ?', [origin.id, userId]);
      if (!job) throw notFound('Yayın kaydı bulunamadı');
      let startMs = kickTimeMs(job.stream_started_at);
      if (!Number.isFinite(startMs)) {
        const videos = await this.listVideos(job.channel_slug).catch(() => []);
        startMs = kickTimeMs(videos.find((v) => String(v.id) === String(job.source_video_id))?.startedAt);
        // Date olarak yazılır (ISO-UTC saklanır): bölgesiz metin geri okunurken yerel saat sanılırdı.
        if (Number.isFinite(startMs)) this.store.run('UPDATE vod_scan_jobs SET stream_started_at = ? WHERE id = ?', [new Date(startMs), job.id]);
      }
      if (!Number.isFinite(startMs)) throw badRequest('Bu yayının başlangıç saati bulunamadı (yayın Kick\'in listesinden düşmüş) — sohbet eşlenemiyor');
      return { channel: job.channel_slug, baseMs: startMs + (Number(job.range_start_sec) || 0) * 1000, precision: 'exact' };
    }
    if (origin.type === 'recording') {
      const rec = this.store.get('SELECT channel_slug, started_at FROM stream_recordings WHERE id = ? AND user_id = ?', [origin.id, userId]);
      const startMs = kickTimeMs(rec?.started_at);
      if (!rec || !Number.isFinite(startMs)) throw notFound('Yayın kaydı bulunamadı');
      return { channel: rec.channel_slug, baseMs: startMs, precision: 'approx' };
    }
    if (origin.type === 'harvest') {
      const clip = this.store.get('SELECT channel_slug, clip_created_at, duration_sec FROM harvested_clips WHERE id = ? AND user_id = ?', [origin.id, userId]);
      const endMs = kickTimeMs(clip?.clip_created_at);
      if (!clip || !Number.isFinite(endMs)) throw badRequest('Bu klibin yayın saati bilinmiyor — sohbet eşlenemiyor');
      return { channel: clip.channel_slug, baseMs: endMs - (Number(clip.duration_sec) || 0) * 1000, precision: 'approx' };
    }
    throw badRequest('Sohbet yalnız Kick yayınından gelen videolara eklenebilir: indirilen yayın (aralık), yayın kaydı ya da Kick klibi');
  }

  /* ── Veri ──────────────────────────────────────────────────────────────── */

  read(userId: number, projectId: number, assetId: string): ChatData | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.dataFile(userId, projectId, assetId), 'utf8')) as ChatData;
      return data?.version === 1 && Array.isArray(data.messages) ? data : null;
    } catch {
      return null;
    }
  }

  /** Saklanan verinin ham JSON metni (büyük dosya yeniden çözülüp yazılmasın). */
  readRaw(userId: number, projectId: number, assetId: string): string | null {
    try {
      return fs.readFileSync(this.dataFile(userId, projectId, assetId), 'utf8');
    } catch {
      return null;
    }
  }

  remove(userId: number, projectId: number, assetId: string) {
    fs.rmSync(this.dataFile(userId, projectId, assetId), { force: true });
  }

  /**
   * İstenen kaynak aralıklarının sohbetini (eksik kalan kısmını) çeker ve
   * saklanan veriyle birleştirir. Aynı varlık için eşzamanlı çağrılar tek
   * çekimi paylaşır.
   */
  ensure(userId: number, projectId: number, asset: { id: string; duration: number; origin: AssetOrigin }, ranges: ChatRange[]): Promise<ChatData> {
    const key = `${userId}:${projectId}:${asset.id}`;
    const running = this.active.get(key);
    if (running) return running.promise;
    const promise = this.fetchInto(userId, projectId, asset, ranges).finally(() => this.active.delete(key));
    this.active.set(key, { promise });
    return promise;
  }

  private async fetchInto(userId: number, projectId: number, asset: { id: string; duration: number; origin: AssetOrigin }, ranges: ChatRange[]): Promise<ChatData> {
    const bind = await this.binding(userId, asset.origin);
    if (!SLUG_PATTERN.test(bind.channel)) throw badRequest('Kanal adı geçersiz');
    let data = this.read(userId, projectId, asset.id);
    // Bağlama değiştiyse (ör. başlangıç saati sonradan düzeltildi) eski mesajların zamanı geçersizdir.
    if (data && (data.channel !== bind.channel || Math.abs(data.baseMs - bind.baseMs) > 500)) data = null;

    const limit = Math.min(CHAT_SOURCE_MAX, (asset.duration || CHAT_SOURCE_MAX) + 5, (Date.now() - bind.baseMs) / 1000);
    const wanted = mergeRanges(ranges.map((r) => ({ start: Math.max(0, r.start), end: Math.min(limit, r.end) })));
    const missing = missingChatRanges(wanted, data?.ranges ?? []);
    if (data && !missing.length) return data;
    const channel = await this.channel(bind.channel);
    const totalSec = missing.reduce((s, r) => s + (r.end - r.start), 0);
    if (totalSec > MAX_FETCH_SEC) throw badRequest('Tek seferde en fazla 8 saatlik sohbet çekilebilir — videoyu daha kısa parçalarla kullan');

    const emit = (percent: number, count: number, extra: Record<string, unknown> = {}) => this.io.to(`user:${userId}`).emit('chat:progress', { projectId, assetId: asset.id, percent, count, ...extra });
    emit(0, data?.messages.length ?? 0);
    const byId = new Map<string, ChatMessage>((data?.messages ?? []).map((m) => [m.id, m]));
    let doneSec = 0;
    try {
      for (const r of missing) {
        const span = r.end - r.start;
        const raw = await fetchMessageRange(channel.id, bind.baseMs + r.start * 1000, bind.baseMs + r.end * 1000, {
          fetchPage: this.fetchPage,
          onProgress: (done, total, count) => emit(Math.min(99, Math.floor(((doneSec + (done / total) * span) / totalSec) * 100)), byId.size + count),
        });
        for (const m of raw) {
          const msg = toChatMessage(m, bind.baseMs);
          if (msg) byId.set(msg.id, msg);
        }
        doneSec += span;
      }
    } catch (err) {
      emit(0, byId.size, { failed: true });
      throw err;
    }

    const next: ChatData = {
      version: 1,
      assetId: asset.id,
      channel: bind.channel,
      channelId: channel.id,
      baseMs: bind.baseMs,
      precision: bind.precision,
      ranges: mergeRanges([...(data?.ranges ?? []), ...missing]),
      subBadges: channel.subBadges,
      messages: [...byId.values()].sort((a, b) => a.t - b.t),
      fetchedAt: new Date().toISOString(),
    };
    fs.mkdirSync(this.chatDir(userId, projectId), { recursive: true });
    const file = this.dataFile(userId, projectId, asset.id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(next));
    fs.renameSync(`${file}.tmp`, file);
    emit(100, next.messages.length, { done: true });
    return next;
  }

  /** Kanalın sayısal kimliği (mesaj uç noktası bunu ister) ve abone rozetleri. */
  private async channel(slug: string): Promise<{ id: number; subBadges: ChatData['subBadges'] }> {
    let d: any;
    try {
      d = (await axios.get(`https://kick.com/api/v2/channels/${slug}`, { headers: BROWSER_HEADERS, timeout: 12_000 })).data ?? {};
    } catch {
      throw new HttpError(502, 'Kick kanal bilgisi alınamadı');
    }
    const id = Number(d.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Kanal bulunamadı');
    const subBadges = (Array.isArray(d.subscriber_badges) ? d.subscriber_badges : [])
      .map((b: any) => ({ months: Number(b?.months) || 1, url: b?.badge_image?.src }))
      .filter((b: { url: unknown }) => imageUrlOk(b.url))
      .sort((a: { months: number }, b: { months: number }) => a.months - b.months)
      .slice(0, 40);
    return { id, subBadges };
  }

  /* ── An taraması için tüm yayının sohbeti ──────────────────────────────── */

  /**
   * İndirilen yayının (ya da aralığın) baştan sona sohbeti, an taraması için
   * yalın biçimde: t = indirilen dosyanın saniyesi. `cacheFile` verilirse
   * sonuç oraya yazılır ve sonraki taramalarda Kick'e yeniden gidilmez.
   */
  async streamMessages(
    userId: number,
    vodJobId: number,
    durationSec: number,
    { cacheFile, onProgress }: { cacheFile?: string; onProgress?: (percent: number, count: number) => void } = {},
  ): Promise<{ t: number; u: string; x: string }[]> {
    if (cacheFile && fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (Array.isArray(cached)) return cached;
      } catch {
        /* bozuk önbellek — yeniden çek */
      }
    }
    const bind = await this.binding(userId, { type: 'vod', id: vodJobId });
    if (!SLUG_PATTERN.test(bind.channel)) throw badRequest('Kanal adı geçersiz');
    const channel = await this.channel(bind.channel);
    const span = Math.max(1, Math.min(durationSec + 5, (Date.now() - bind.baseMs) / 1000));
    const raw = await fetchMessageRange(channel.id, bind.baseMs, bind.baseMs + span * 1000, {
      fetchPage: this.fetchPage,
      // Uzun ve kalabalık yayınlar: editördeki 250 bin sınırı burada geçerli değil.
      maxMessages: 1_500_000,
      onProgress: (done, total, count) => onProgress?.(Math.min(99, Math.floor((done / total) * 100)), count),
    });
    const out: { t: number; u: string; x: string }[] = [];
    for (const m of raw) {
      const msg = toChatMessage(m, bind.baseMs);
      if (msg && msg.t >= 0) out.push({ t: msg.t, u: msg.u, x: msg.x });
    }
    out.sort((a, b) => a.t - b.t);
    if (cacheFile) {
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(out));
        fs.renameSync(`${cacheFile}.tmp`, cacheFile);
      } catch {
        /* önbellek yazılamadı — tarama yine sürer */
      }
    }
    onProgress?.(100, out.length);
    return out;
  }

  /* ── Görseller (emote, rozet) ──────────────────────────────────────────── */

  emote(id: string) {
    if (!/^\d{1,12}$/.test(id)) throw badRequest('Emote kimliği geçersiz');
    return this.image(`https://files.kick.com/emotes/${id}/fullsize`);
  }

  /** Kick CDN'indeki bir görseli önbelleğe alır; yalnız izinli alan adları. */
  image(url: string): Promise<{ file: string; type: string }> {
    if (!imageUrlOk(url)) throw badRequest('Görsel adresi izinli değil');
    const hash = createHash('sha1').update(url).digest('hex');
    const dir = path.join(config.dataDir, 'chat-assets');
    const file = path.join(dir, hash);
    const typeFile = `${file}.type`;
    if (fs.existsSync(file) && fs.existsSync(typeFile)) return Promise.resolve({ file, type: fs.readFileSync(typeFile, 'utf8').trim() || 'image/png' });
    const running = this.images.get(hash);
    if (running) return running;
    const task = (async () => {
      let res;
      try {
        res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15_000, maxContentLength: IMAGE_MAX_BYTES, headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] } });
      } catch (err) {
        throw new HttpError((err as { response?: { status?: number } }).response?.status === 404 ? 404 : 502, 'Görsel alınamadı');
      }
      const body = Buffer.from(res.data);
      const type = sniffImage(body);
      if (!type) throw new HttpError(415, 'Beklenmeyen görsel türü');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, body);
      fs.renameSync(`${file}.tmp`, file);
      fs.writeFileSync(typeFile, type);
      return { file, type };
    })().finally(() => this.images.delete(hash));
    this.images.set(hash, task);
    return task;
  }
}
