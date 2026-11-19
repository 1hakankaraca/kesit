import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  addChatLayer,
  chatClipSourceAt,
  chatPlanKey,
  chatSegments,
  chatSourceAt,
  chatVisibleOnClip,
  defaultChatLayer,
  hideChatFrom,
  isChatHiddenAt,
  lastIndexAt,
  mergeRanges,
  missingChatRanges,
  neededChatRanges,
  normalizeChatPlan,
  removeChatLayer,
  showChatFrom,
  subBadgeFor,
  subtractRanges,
  tokenizeChat,
  type ChatMessage,
  type ChatRenderPlan,
} from '../shared/chat.ts';
import { emptyProject, normalizeProject, type Asset, type Clip, type Project } from '../shared/project.ts';
import { runFfmpeg } from '../server/lib/media.ts';
import { ChatHistory, fetchMessageRange, kickTimeMs, messageTimeMs, sniffImage, toChatMessage, type MessagePage, type RawKickMessage } from '../server/services/ChatHistory.ts';
import { chatOverlayStream, composeChatBox, decodePng, lastRowAt, loadChatOverlay, overlayGeometry, visibleRows, type RgbaImage } from '../server/services/ChatOverlay.ts';
import { buildRenderPlan } from '../server/services/ProjectRenderer.ts';
import { neededMessageIndices } from '../src/editor/chatExport.ts';
import { chatMetrics, layoutChatRow, maxChatRows, stackRows, type LayoutEnv } from '../src/editor/chatRender.ts';
import { rippleRemove, splitAt } from '../src/editor/model.ts';

const asset = (id: string, kind: Asset['kind'] = 'video', duration = 600): Asset => ({ id, kind, name: id, duration, width: 1920, height: 1080, hasAudio: true, origin: { type: 'vod', id: 1 }, thumb: null });
const clip = (id: string, trackId: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({
  id, trackId, kind: 'video', assetId: 'a1', start, duration, in: 0,
  frame: { x: 0, y: 0, w: 1, h: 1 }, crop: { x: 0, y: 0, w: 1, h: 1 }, opacity: 1, volume: 1, muted: false, speed: 1, fadeIn: 0, fadeOut: 0,
  color: { brightness: 0, contrast: 1, saturation: 1, hue: 0 }, text: null, cta: null, captions: null, regions: null, chatId: null, renderAssetId: null, ...extra,
});

function sample(): Project {
  const p = emptyProject(1, 'Sohbet', 'horizontal');
  p.assets = [asset('a1'), asset('a2')];
  p.clips = [clip('c1', 'v1', 0, 60, { in: 100 })];
  p.chats = [defaultChatLayer('h1', 'a1', 'horizontal')];
  return p;
}

const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

/* ── Aralıklar ───────────────────────────────────────────────────────────── */

test('mergeRanges ve subtractRanges: birleştirir, çıkarır, bozukları atar', () => {
  assert.deepEqual(mergeRanges([{ start: 5, end: 8 }, { start: 0, end: 2 }, { start: 2, end: 3 }, { start: 7, end: 10 }, { start: 4, end: 4 }]), [{ start: 0, end: 3 }, { start: 5, end: 10 }]);
  assert.deepEqual(subtractRanges([{ start: 0, end: 10 }], [{ start: 2, end: 3 }, { start: 8, end: 20 }]), [{ start: 0, end: 2 }, { start: 3, end: 8 }]);
  assert.deepEqual(subtractRanges([{ start: 0, end: 10 }], [{ start: -5, end: 50 }]), []);
  assert.deepEqual(missingChatRanges([{ start: 0, end: 100 }], [{ start: 0, end: 60 }]), [{ start: 60, end: 100 }]);
  assert.deepEqual(missingChatRanges([{ start: 0, end: 100 }], [{ start: 0, end: 99.8 }]), [], 'yarım saniyeden küçük eksik çekim başlatmaz');
});

/* ── Videoya bağlı eşleme ────────────────────────────────────────────────── */

test('chatSegments: sohbet zamanı zaman çizelgesinden değil videonun kaynak zamanından gelir', () => {
  const p = sample();
  const segs = chatSegments(p, p.chats[0]);
  assert.equal(segs.length, 1);
  near(chatSourceAt(segs, 0), 100);
  near(chatSourceAt(segs, 12.5), 112.5);
  assert.equal(chatSourceAt(segs, 60), null, 'parçanın bittiği anda sohbet de biter');
});

test('aradan kesme: kesilen bölümün sohbeti gider, kalanlar videoyla eşli kalır', () => {
  let p = sample();
  // 20. ve 30. saniyelerden böl, ortadaki 10 saniyeyi sil ve sonrakileri geri çek.
  p = splitAt(p, 20).project;
  p = splitAt(p, 30).project;
  const middle = p.clips.find((c) => Math.abs(c.start - 20) < 1e-6)!;
  p = rippleRemove(p, middle.id);
  const segs = chatSegments(p, p.chats[0]);
  assert.equal(segs.length, 2);
  near(chatSourceAt(segs, 19.9), 119.9);
  // Kesimden hemen sonra video 130. saniyesindedir; sohbet de oradan devam eder (120–130 arası hiç gösterilmez).
  near(chatSourceAt(segs, 20), 130);
  near(chatSourceAt(segs, 45), 155);
  assert.equal(chatSourceAt(segs, 50), null);
});

test('hız ve sıra değişikliği eşlemeyi bozmaz; aynı anda iki parça varsa en alttaki yol esas alınır', () => {
  const p = sample();
  p.clips = [clip('c1', 'v1', 0, 10, { in: 200, speed: 2 }), clip('c2', 'v1', 10, 10, { in: 50 }), clip('cam', 'v2', 0, 20, { in: 500 })];
  const segs = chatSegments(p, p.chats[0]);
  near(chatSourceAt(segs, 5), 210);
  near(chatSourceAt(segs, 15), 55);
  assert.ok(segs.every((s) => s.clipId !== 'cam'), 'üst katmandaki kopya ikinci bir sohbet üretmez');
  p.tracks.find((t) => t.id === 'v1')!.hidden = true;
  near(chatSourceAt(chatSegments(p, p.chats[0]), 5), 505);
});

test('gizleme videonun zamanındadır: kesmelerle birlikte taşınır', () => {
  let p = sample();
  // Kaynağın 110–125. saniyeleri arasında gizle.
  let layer = hideChatFrom(p.chats[0], 110, 600);
  assert.ok(isChatHiddenAt(layer, 300), 'gösterilene kadar sona dek gizli');
  layer = showChatFrom(layer, 125);
  assert.deepEqual(layer.hides, [{ start: 110, end: 125 }]);
  assert.equal(showChatFrom(layer, 200), layer, 'görünür yerde "göster" bir şey değiştirmez');
  p = { ...p, chats: [layer] };
  let segs = chatSegments(p, layer);
  assert.equal(chatSourceAt(segs, 12), null, 'zaman çizelgesi 10–25 arası gizli');
  near(chatSourceAt(segs, 26), 126);
  near(chatClipSourceAt(p, layer, 12), 112);
  // Baştaki 5 saniye kesilince gizli bölüm de 5 saniye öne gelir.
  p = splitAt(p, 5).project;
  p = rippleRemove(p, p.clips.find((c) => c.start === 0)!.id);
  segs = chatSegments(p, layer);
  near(chatSourceAt(segs, 4), 109);
  assert.equal(chatSourceAt(segs, 7), null);
  near(chatSourceAt(segs, 20.5), 125.5);
  // Zaman çizelgesi şeridi: parçanın üstünde görünen bölümler (oran).
  const vis = chatVisibleOnClip(p.clips[0], layer);
  assert.equal(vis.length, 2);
  near(vis[0].to, 5 / 55);
  near(vis[1].from, 20 / 55);
});

test('normalizeProject: sohbet katmanı korunur; videosu olmayan ve yinelenen atılır', () => {
  const p = sample();
  const raw = { ...p, chats: [{ ...p.chats[0], size: 9, opacity: -1, hides: [{ start: 30, end: 10 }, { start: 5, end: 9 }, { start: 8, end: 12 }] }, { ...p.chats[0], id: 'h2' }, { id: 'h3', assetId: 'yok' }, { id: 'kötü kimlik', assetId: 'a2' }] };
  const n = normalizeProject(raw, { id: 1 });
  assert.equal(n.chats.length, 1);
  assert.equal(n.chats[0].size, 0.06);
  assert.equal(n.chats[0].opacity, 0);
  assert.deepEqual(n.chats[0].hides, [{ start: 5, end: 12 }]);
  assert.deepEqual(normalizeProject({ ...p, chats: undefined }, { id: 1 }).chats, []);
  assert.equal(addChatLayer(n, defaultChatLayer('h9', 'a1', 'horizontal')), n, 'videoya ikinci sohbet eklenmez');
  assert.equal(removeChatLayer(n, 'h1').chats.length, 0);
  assert.deepEqual(neededChatRanges(p, 'a1'), [{ start: 10, end: 162 }]);
});

/* ── Mesajlar ────────────────────────────────────────────────────────────── */

test('tokenizeChat, lastIndexAt, subBadgeFor', () => {
  assert.deepEqual(tokenizeChat('selam [emote:37226:KEKW] nasılsın[emote:1:x]'), [
    { type: 'text', text: 'selam ' },
    { type: 'emote', id: '37226', name: 'KEKW' },
    { type: 'text', text: ' nasılsın' },
    { type: 'emote', id: '1', name: 'x' },
  ]);
  assert.deepEqual(tokenizeChat('[emote:bozuk]'), [{ type: 'text', text: '[emote:bozuk]' }]);
  const times = [{ t: 1 }, { t: 2 }, { t: 2 }, { t: 5 }];
  assert.equal(lastIndexAt(times, 0.5), -1);
  assert.equal(lastIndexAt(times, 2), 2);
  assert.equal(lastIndexAt(times, 99), 3);
  const badges = [{ months: 1, url: 'a' }, { months: 3, url: 'b' }, { months: 6, url: 'c' }];
  assert.equal(subBadgeFor(badges, 1), 'a');
  assert.equal(subBadgeFor(badges, 5), 'b');
  assert.equal(subBadgeFor(badges, 40), 'c');
  assert.equal(subBadgeFor([], 3), null);
});

const raw = (id: string, iso: string, extra: Partial<RawKickMessage> = {}): RawKickMessage => ({
  id,
  content: `mesaj ${id}`,
  type: 'message',
  created_at: iso,
  metadata: JSON.stringify({ message_ref: String(Date.parse(iso) + 250) }),
  sender: { username: 'ayse', identity: { color: '#FF9D00', badges: [{ type: 'subscriber', text: 'Subscriber', count: 7, sort_order: 9 }], badges_v2: [{ name: 'level', image_url: 'https://ext.cdn.kick.com/chat/badges/x.png', metadata: { level: 33 }, selected: true, sort_order: 1 }, { name: 'level', image_url: 'https://kotu.example/x.png', selected: true }] } },
  ...extra,
});

test('toChatMessage: zaman kaynağın saniyesine çevrilir; rozet, renk ve yanıt korunur', () => {
  assert.equal(kickTimeMs('2026-11-09 18:32:34'), Date.parse('2026-11-09T18:32:34Z'));
  const base = Date.parse('2026-11-09T19:00:00Z');
  const m = toChatMessage(raw('m1', '2026-11-09T19:00:10Z'), base)!;
  assert.equal(m.t, 10.25, 'milisaniyelik damga kullanılır');
  assert.equal(m.c, '#FF9D00');
  assert.deepEqual(m.b, [{ t: 'level', u: 'https://ext.cdn.kick.com/chat/badges/x.png', n: 33 }, { t: 'subscriber', n: 7 }], 'izinli olmayan adresteki rozet atılır, sıra Kick sırası');
  assert.equal(messageTimeMs({ id: 'x', created_at: '2026-11-09T19:00:10Z', metadata: '{"message_ref":"5"}' }), Date.parse('2026-11-09T19:00:10Z'), 'tutarsız damga yok sayılır');
  const reply = toChatMessage(raw('m2', '2026-11-09T19:00:11Z', { type: 'reply', metadata: { message_ref: String(base + 11_000), original_message: { content: 'ilk mesaj' }, original_sender: { username: 'ali' } } }), base)!;
  assert.deepEqual(reply.r, { u: 'ali', x: 'ilk mesaj' });
  assert.equal(toChatMessage(raw('m3', '2026-11-09T19:00:12Z', { type: 'celebration' }), base), null, 'kutlama satırı sohbet mesajı değildir');
  assert.equal(toChatMessage(raw('m4', '2026-11-09T19:00:12Z', { sender: { username: 'x', identity: { color: 'javascript:1' } } }), base)!.c, '#b8c0c8');
});

test('ChatHistory.binding: yayın aralığı → kanal ve kaynağın 0. saniyesinin UTC saati', async () => {
  const startMs = Date.parse('2026-11-09T18:32:34Z');
  const writes: unknown[][] = [];
  const job: Record<string, unknown> = { id: 7, channel_slug: 'hype', source_video_id: '136907586', range_start_sec: 3240, stream_started_at: null };
  const store = {
    get: (sql: string) => (sql.includes('vod_scan_jobs') ? job : sql.includes('stream_recordings') ? { channel_slug: 'hype', started_at: new Date(startMs) } : sql.includes('harvested_clips') ? { channel_slug: 'hype', clip_created_at: new Date(startMs + 90_000), duration_sec: 30 } : null),
    run: (_sql: string, params: unknown[]) => void writes.push(params),
  };
  const chat = new ChatHistory(store as never, {} as never, { listVideos: async () => [{ id: 136907586, startedAt: '2026-11-09 18:32:34' }] });
  // Saat kayıtlı değilse Kick'in yayın listesinden bulunur ve Date olarak yazılır (bölgesiz metin yerel saat sanılmasın).
  assert.deepEqual(await chat.binding(1, { type: 'vod', id: 7 }), { channel: 'hype', baseMs: startMs + 3_240_000, precision: 'exact' });
  assert.ok(writes[0][0] instanceof Date && (writes[0][0] as Date).getTime() === startMs);
  // Sonraki okumada veritabanı kolonu Date olarak verir; yayın listesine gidilmez.
  job.stream_started_at = new Date(startMs);
  const offline = new ChatHistory(store as never, {} as never, { listVideos: async () => Promise.reject(new Error('çağrılmamalı')) });
  assert.equal((await offline.binding(1, { type: 'vod', id: 7 })).baseMs, startMs + 3_240_000);
  assert.deepEqual(await chat.binding(1, { type: 'recording', id: 1 }), { channel: 'hype', baseMs: startMs, precision: 'approx' });
  assert.deepEqual(await chat.binding(1, { type: 'harvest', id: 1 }), { channel: 'hype', baseMs: startMs + 60_000, precision: 'approx' });
  await assert.rejects(chat.binding(1, { type: 'upload', file: 'x.mp4' }), /Kick yayınından gelen/);
  job.stream_started_at = null;
  const gone = new ChatHistory(store as never, {} as never, { listVideos: async () => [] });
  await assert.rejects(gone.binding(1, { type: 'vod', id: 7 }), /başlangıç saati bulunamadı/);
});

test('sniffImage: tür başlıktan değil içerikten okunur (Kick bazı emote\'ları octet-stream verir)', () => {
  const head = (bytes: number[], text = '') => Buffer.concat([Buffer.from(bytes), Buffer.from(text, 'latin1'), Buffer.alloc(16)]);
  assert.equal(sniffImage(head([0x89], 'PNG\r\n')), 'image/png');
  assert.equal(sniffImage(head([], 'GIF89a')), 'image/gif');
  assert.equal(sniffImage(head([], 'RIFF\0\0\0\0WEBP')), 'image/webp');
  assert.equal(sniffImage(head([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(head([], '<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(sniffImage(Buffer.from('kısa')), null);
});

test('fetchMessageRange: imleçle geriye sayfalar, yoğun aralıkta mesaj kaçırmaz, aralık dışını almaz', async () => {
  // 25 dakikalık sahte sohbet: saniyede 3 mesaj (Kick sayfa başına 25 mesaj verir, yeniden eskiye).
  const start = Date.parse('2026-11-09T18:00:00Z');
  const all: RawKickMessage[] = [];
  for (let i = 0; i < 25 * 60 * 3; i++) all.push(raw(`k${i}`, new Date(start + Math.floor(i / 3) * 1000).toISOString().replace('.000Z', 'Z'), { metadata: JSON.stringify({ message_ref: String(start + Math.floor((i * 1000) / 3)) }) }));
  let calls = 0;
  const fetchPage = async (_channel: number, cursor: string): Promise<MessagePage> => {
    calls++;
    const beforeMs = Number(cursor) / 1000;
    const older = all.filter((m) => messageTimeMs(m) < beforeMs);
    const page = older.slice(-25).reverse();
    return { messages: page, cursor: page.length ? String(Math.round(messageTimeMs(page[page.length - 1]) * 1000)) : null };
  };
  const from = start + 5 * 60_000;
  const to = start + 16 * 60_000;
  let lastPct = 0;
  const got = await fetchMessageRange(1, from, to, { fetchPage, pauseMs: 0, onProgress: (done, total) => (lastPct = done / total) });
  const expected = all.filter((m) => messageTimeMs(m) >= from && messageTimeMs(m) < to);
  assert.equal(got.length, expected.length);
  assert.equal(new Set(got.map((m) => m.id)).size, expected.length, 'yinelenen yok');
  assert.ok(calls < expected.length / 25 + 20, `istek sayısı makul (${calls})`);
  assert.ok(lastPct > 0.999, 'ilerleme tamamlanır');
  assert.deepEqual(await fetchMessageRange(1, start - 3600_000, start - 1800_000, { fetchPage, pauseMs: 0 }), []);
});

/* ── Satır yerleşimi (önizleme ve dışa aktarma ortak) ───────────────────── */

const env: LayoutEnv = { measure: (text, bold, size) => Array.from(text).length * size * (bold ? 0.6 : 0.5), aspect: () => null, subBadges: [{ months: 1, url: 'https://files.kick.com/channel_subscriber_badges/1/x.png' }], badges: true };
const msg = (x: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ t: 0, id: 'm', u: 'ayse', c: '#FF9D00', b: [], x, ...extra });

test('layoutChatRow: genişliğe göre kaydırır, hiçbir parça kutudan taşmaz', () => {
  const layer = defaultChatLayer('h1', 'a1', 'horizontal');
  const m = chatMetrics(layer, 'horizontal');
  assert.equal(m.width, Math.round(0.235 * 1920));
  assert.equal(m.font, Math.round(0.022 * 1080));
  const short = layoutChatRow(msg('selam'), m, env);
  assert.equal(short.height, m.lineH + m.rowGap);
  const first = short.items[0];
  assert.ok(first.kind === 'text' && first.text === 'ayse:' && first.bold && first.color === '#FF9D00');
  const long = layoutChatRow(msg('bu çok uzun bir mesaj '.repeat(8) + 'x'.repeat(200)), m, env);
  assert.ok(long.height > m.lineH * 6);
  for (const it of long.items) if (it.kind === 'text') assert.ok(it.x + env.measure(it.text, it.bold, it.size) <= m.width - m.padX + 0.5, `"${it.text.slice(0, 12)}…" kutuda kalır`);
});

test('layoutChatRow: rozet, emote ve yanıt satırı', () => {
  const m = chatMetrics(defaultChatLayer('h1', 'a1', 'horizontal'), 'horizontal');
  const row = layoutChatRow(msg('gg [emote:37226:KEKW]', { b: [{ t: 'moderator' }, { t: 'subscriber', n: 3 }], r: { u: 'ali', x: 'ilk [emote:1:LUL] mesaj' } }), m, env);
  const kinds = row.items.map((i) => i.kind);
  assert.deepEqual(kinds, ['text', 'glyph', 'img', 'text', 'text', 'img']);
  const reply = row.items[0];
  assert.ok(reply.kind === 'text' && reply.text === '↩ @ali: ilk LUL mesaj' && reply.size < m.font);
  assert.deepEqual(row.images, ['/api/chat/img?u=https%3A%2F%2Ffiles.kick.com%2Fchannel_subscriber_badges%2F1%2Fx.png', '/api/chat/emote/37226']);
  const emote = row.items[5];
  assert.ok(emote.kind === 'img' && emote.h === m.emote);
  assert.ok(row.height > m.emote, 'emote satırı emote kadar yüksek');
  const plain = layoutChatRow(msg('gg', { b: [{ t: 'moderator' }] }), m, { ...env, badges: false });
  assert.ok(plain.items.every((i) => i.kind === 'text'), 'rozetler kapalıyken çizilmez');
  // Üst üste dizme: alttan yukarı, tamamı sığanlar.
  const stack = stackRows(() => 100, 9, { height: 350, padY: 10 });
  assert.deepEqual(stack.map((s) => [s.index, s.y]), [[9, 240], [8, 140], [7, 40]]);
  assert.ok(maxChatRows(m) >= 20);
});

test('neededMessageIndices: her bölüm için öncesinden kutuyu dolduracak kadar ve bölüm boyunca gelenler', () => {
  const p = sample();
  p.clips = [clip('c1', 'v1', 0, 10, { in: 100 }), clip('c2', 'v1', 10, 10, { in: 400 })];
  const messages = Array.from({ length: 600 }, (_, i) => msg('x', { t: i, id: `m${i}` }));
  const idx = neededMessageIndices(chatSegments(p, p.chats[0]), p.chats[0], { messages }, 5);
  assert.deepEqual([idx[0], idx[15], idx[16], idx[idx.length - 1]], [95, 110, 395, 410]);
  assert.equal(idx.length, 32);
  // Kaydırma: +2 sn gecikme → 2 saniye önceki mesajlar görünür.
  const shifted = neededMessageIndices(chatSegments(p, p.chats[0]), { ...p.chats[0], offset: 2 }, { messages }, 5);
  assert.equal(shifted[0], 93);
});

/* ── Dışa aktarma: kare derleme ──────────────────────────────────────────── */

const solid = (width: number, height: number, rgba: [number, number, number, number]): RgbaImage => {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { data, width, height };
};
const px = (buf: Buffer, width: number, x: number, y: number) => [...buf.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
const plan = (extra: Partial<ChatRenderPlan> = {}): ChatRenderPlan => ({ chatId: 'h1', x: 10, y: 20, width: 8, height: 12, padY: 1, opacity: 1, hasBackground: false, pages: 1, rows: [[1, 0, 0, 4], [2, 0, 4, 4], [3, 0, 8, 4]], key: 'k', ...extra });

test('composeChatBox: satırlar alttan yukarı dizilir, sığmayan düşer, arka planın üstüne karışır', () => {
  const page: RgbaImage = { data: Buffer.concat([solid(8, 4, [255, 0, 0, 255]).data, solid(8, 4, [0, 255, 0, 255]).data, solid(8, 4, [0, 0, 255, 128]).data]), width: 8, height: 12 };
  const pages = new Map([[0, page]]);
  const p = plan();
  assert.equal(lastRowAt(p.rows, 0.5), -1);
  assert.equal(lastRowAt(p.rows, 2.5), 1);
  assert.deepEqual(visibleRows(p, 2), [{ row: 2, y: 7 }, { row: 1, y: 3 }], 'üçüncü satır (en eski) kutuya sığmaz');
  const box = composeChatBox(p, 1, pages, null);
  assert.deepEqual(px(box, 8, 0, 8), [0, 255, 0, 255], 'en yeni mesaj en altta');
  assert.deepEqual(px(box, 8, 0, 4), [255, 0, 0, 255]);
  assert.deepEqual(px(box, 8, 0, 0), [0, 0, 0, 0], 'boş yer saydam');
  const withBg = composeChatBox(plan({ hasBackground: true }), 2, pages, solid(8, 12, [0, 0, 0, 128]));
  assert.deepEqual(px(withBg, 8, 0, 0), [0, 0, 0, 128], 'arka plan görünür');
  const mixed = px(withBg, 8, 3, 8);
  assert.ok(mixed[2] > 120 && mixed[3] > 128 && mixed[3] < 255, `yarı saydam satır arka planla karışır (${mixed})`);
  assert.deepEqual(overlayGeometry([p, plan({ x: -4, y: 1070, width: 20, height: 40 })], 1920, 1080), { x: 0, y: 20, width: 18, height: 1060, fps: 10 }, 'kare dışına taşan kısım kırpılır');
  assert.equal(overlayGeometry([plan({ x: 5000 })], 1920, 1080), null);
});

test('chatOverlayStream: kareler zaman çizelgesi → kaynak eşlemesine göre değişir', async () => {
  const page = solid(8, 12, [255, 255, 255, 255]);
  // Zaman çizelgesi 0–2 sn: kaynak 0–2; 2–4 sn: kesme sonrası kaynak 10–12 (tüm satırlar gelmiş olur).
  const stream = chatOverlayStream([{ plan: plan(), segments: [{ start: 0, end: 2, src: 0, speed: 1, clipId: 'c1' }, { start: 2, end: 3, src: 10, speed: 1, clipId: 'c2' }], loadPage: async () => page }], 1920, 1080, 4)!;
  assert.deepEqual([stream.x, stream.y, stream.width, stream.height, stream.frames], [10, 20, 8, 12, 41]);
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  await stream.feed(out);
  const all = Buffer.concat(chunks);
  const size = 8 * 12 * 4;
  assert.equal(all.length, size * 41);
  const filled = (frame: number) => {
    const f = all.subarray(frame * size, (frame + 1) * size);
    let n = 0;
    for (let i = 3; i < f.length; i += 4) if (f[i]) n++;
    return n / 8;
  };
  assert.equal(filled(5), 0, '0,5. saniyede henüz mesaj yok');
  assert.equal(filled(10), 4, '1. saniyede ilk satır');
  assert.equal(filled(25), 8, 'kesmeden sonra kutuya sığan iki satır');
  assert.equal(filled(35), 0, 'parça bitince sohbet de biter');
});

test('buildRenderPlan: sohbet standart girdiden ham video olarak bindirilir', () => {
  const p = sample();
  const r = buildRenderPlan(p, () => ({ file: '/x/a.mp4', kind: 'video', hasAudio: true }), { output: '/out.mp4', assPath: '/s.ass', chat: { x: 1430, y: 86, width: 452, height: 908, fps: 10 } });
  const at = r.args.indexOf('pipe:0');
  assert.deepEqual(r.args.slice(at - 9, at + 1), ['-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '452x908', '-framerate', '10', '-i', 'pipe:0']);
  assert.ok(r.filterGraph.includes('[3:v]setpts=PTS-STARTPTS,format=rgba[chat]'));
  assert.ok(r.filterGraph.includes('[o1][chat]overlay=1430:86:eof_action=pass[ochat]'));
  assert.ok(r.filterGraph.includes("[ochat]subtitles=filename='/s.ass'[outv]"), 'altyazı ve abone çağrısı sohbetin üstünde');
  assert.ok(!buildRenderPlan(p, () => ({ file: '/x/a.mp4', kind: 'video', hasAudio: true }), { output: '/out.mp4' }).args.includes('pipe:0'));
});

test('normalizeChatPlan: bozuk satırları ve sayfa dışını atar', () => {
  const n = normalizeChatPlan({ chatId: 'h1', x: 1, y: 2, width: 100, height: 50, padY: 4, pages: 2, hasBackground: true, opacity: 0.5, key: 'k', rows: [[5, 1, 0, 10], [1, 0, 0, 10], [2, 2, 0, 10], [3, 0, 4090, 10], ['x', 0, 0, 10], [4, 0, 0, 0]] })!;
  assert.deepEqual(n.rows, [[1, 0, 0, 10], [5, 1, 0, 10]]);
  assert.equal(normalizeChatPlan({ chatId: 'h1', rows: [], width: 1, height: 1 }), null);
  const layer = defaultChatLayer('h1', 'a1', 'horizontal');
  assert.notEqual(chatPlanKey(layer, 'horizontal'), chatPlanKey({ ...layer, size: 0.03 }, 'horizontal'), 'ayar değişince plan anahtarı değişir');
});

/* ── Uçtan uca: gerçek ffmpeg ile videoya bindirme ───────────────────────── */

test('dışa aktarma: sohbet satırı videonun doğru anında ve yerinde görünür (ffmpeg)', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'ffmpeg yok' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-chat-'));
  try {
    const ff = (...args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
    const video = path.join(dir, 'kaynak.mp4');
    ff('-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=30:d=6', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video);
    // Proje: kaynağın 2–3. ve 4–5. saniyeleri art arda (aradan 1 sn kesilmiş). Sohbet satırı kaynağın 4,5. saniyesinde gelir.
    const p = sample();
    p.assets = [asset('a1', 'video', 6)];
    p.clips = [clip('c1', 'v1', 0, 1, { in: 2 }), clip('c2', 'v1', 1, 1, { in: 4 })];
    const layer = { ...p.chats[0], frame: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, background: 'none' as const };
    p.chats = [layer];
    const renderDir = path.join(dir, 'chat-render');
    fs.mkdirSync(path.join(renderDir, layer.id), { recursive: true });
    ff('-f', 'lavfi', '-i', 'color=c=red:s=192x40', '-frames:v', '1', path.join(renderDir, layer.id, 'page-0.png'));
    const page = await decodePng(path.join(renderDir, layer.id, 'page-0.png'));
    assert.deepEqual([page.width, page.height, page.data.length], [192, 40, 192 * 40 * 4]);
    const chatPlan: ChatRenderPlan = { chatId: layer.id, x: 960, y: 540, width: 192, height: 108, padY: 4, opacity: 1, hasBackground: false, pages: 1, rows: [[4.5, 0, 0, 40]], key: chatPlanKey(layer, p.format) };
    fs.writeFileSync(path.join(renderDir, layer.id, 'plan.json'), JSON.stringify(chatPlan));
    const warnings: string[] = [];
    const chat = loadChatOverlay(renderDir, p, warnings)!;
    assert.deepEqual(warnings, []);
    assert.ok(chat);
    const output = path.join(dir, 'cikti.mp4');
    const renderPlan = buildRenderPlan(p, () => ({ file: video, kind: 'video', hasAudio: true }), { output, chat });
    await runFfmpeg(renderPlan.args, { totalSec: renderPlan.totalSec, feed: (stdin) => chat.feed(stdin) }).done;
    // Satır kutunun altına oturur: y = 540 + 108 - 4 - 40 = 604 … 644. Ortasından bir piksel okunur.
    const pixelAt = (t: number) => [...execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', output, '-frames:v', '1', '-vf', 'crop=2:2:1050:624', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']).subarray(0, 3)];
    const before = pixelAt(0.5);
    const cutA = pixelAt(1.2);
    const after = pixelAt(1.8);
    assert.ok(before[0] < 40, `ilk parçada (kaynak 2–3 sn) satır yok: ${before}`);
    assert.ok(cutA[0] < 40, `kesmeden sonra kaynak 4,2. saniyede hâlâ yok: ${cutA}`);
    assert.ok(after[0] > 200 && after[1] < 60, `kaynağın 4,8. saniyesinde satır görünür: ${after}`);
    // Ayarı sonradan değişen katmanın eski planı kullanılmaz.
    const stale: string[] = [];
    assert.equal(loadChatOverlay(renderDir, { ...p, chats: [{ ...layer, size: 0.05 }] }, stale), null);
    assert.equal(stale.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
