import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chatSegments, chatSourceAt, defaultChatLayer } from '../shared/chat.ts';
import { DEFAULT_FRAME_CHAT, FRAME_CHAT_SIZE, chatClipAt, chatClipRanges, clipSegments, dropFrameClips, effectiveChatKeySuffix, effectiveChatLayers, effectiveChatSegments, frameChatLayer, frameSubtitleBottom, intersectRanges } from '../shared/frame.ts';
import { FULL_RECT, coverRegion, emptyProject, expandCamClips, expandClips, expandFrameClips, frameAt, normalizeProject, type Asset, type Clip, type Project } from '../shared/project.ts';
import { runFfmpeg } from '../server/lib/media.ts';
import { buildRenderPlan } from '../server/services/ProjectRenderer.ts';
import { findTransparentWindow, windowToRect } from '../server/services/StreamFrame.ts';
import { addChatClip, addFrameClip, frameRangeFor, removeChatEntirely } from '../src/editor/model.ts';

const WINDOW = { x: 64 / 1920, y: 170 / 1080, w: 1280 / 1920, h: 720 / 1080 };
const REGIONS = { window: WINDOW, chat: DEFAULT_FRAME_CHAT };

const asset = (id: string, kind: Asset['kind'] = 'video', extra: Partial<Asset> = {}): Asset => ({ id, kind, name: id, duration: kind === 'image' ? 0 : 30, width: 1920, height: 1080, hasAudio: kind === 'video', origin: kind === 'image' ? { type: 'frame' } : { type: 'upload', file: `${id}.mp4` }, thumb: null, ...extra });
const clip = (id: string, trackId: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({
  id, trackId, kind: 'video', assetId: 'a1', start, duration, in: 0,
  frame: { x: 0, y: 0, w: 1, h: 1 }, crop: { x: 0, y: 0, w: 1, h: 1 }, opacity: 1, volume: 1, muted: false, speed: 1, fadeIn: 0, fadeOut: 0,
  color: { brightness: 0, contrast: 1, saturation: 1, hue: 0 }, text: null, cta: null, captions: null, regions: null, chatId: null, renderAssetId: null, ...extra,
});
const frameClip = (id: string, start: number, duration: number, extra: Partial<Clip> = {}) => clip(id, 'v2', start, duration, { kind: 'frame', assetId: 'f1', regions: REGIONS, ...extra });
const chatClip = (id: string, start: number, duration: number, extra: Partial<Clip> = {}) => clip(id, 'v2', start, duration, { kind: 'chat', assetId: null, chatId: 'h1', ...extra });
const CAM = { x: 0.7, y: 0.05, w: 0.25, h: 0.5 };

function sample(): Project {
  const p = emptyProject(1, 'Çerçeve', 'horizontal');
  p.assets = [asset('a1'), asset('f1', 'image')];
  p.clips = [clip('c1', 'v1', 0, 10), clip('c2', 'v1', 10, 5, { in: 12 })];
  p.chats = [defaultChatLayer('h1', 'a1', 'horizontal')];
  return p;
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const sameRect = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);

test('normalizeProject: çerçeve parçası bölgeleriyle doğrulanır; dikey projede düşer, görseli yoksa atılır', () => {
  const p = sample();
  p.clips.push(frameClip('k1', 2, 6));
  const n = normalizeProject(p, { id: 1 });
  const k = n.clips.find((c) => c.id === 'k1')!;
  assert.equal(k.kind, 'frame');
  assert.ok(sameRect(k.regions!.window, WINDOW));
  assert.ok(sameRect(k.regions!.chat!, DEFAULT_FRAME_CHAT));
  assert.equal(n.clips.find((c) => c.id === 'c1')!.regions, null, 'bölgeler yalnız çerçeve parçasında');
  assert.equal(normalizeProject({ ...p, format: 'vertical' }, { id: 1 }).clips.some((c) => c.kind === 'frame'), false, 'dikey projede çerçeve yok');
  assert.equal(normalizeProject({ ...p, assets: [asset('a1')] }, { id: 1 }).clips.some((c) => c.kind === 'frame'), false, 'görseli olmayan çerçeve atılır');
  // Sohbet parçası: katmanı varsa kalır, yoksa atılır.
  const withChat = normalizeProject({ ...p, clips: [...p.clips, chatClip('s1', 1, 5), chatClip('s2', 1, 5, { chatId: 'yok' })] }, { id: 1 });
  assert.deepEqual(withChat.clips.filter((c) => c.kind === 'chat').map((c) => [c.id, c.chatId]), [['s1', 'h1']]);
  assert.equal(withChat.clips.find((c) => c.id === 'c1')!.chatId, null);
  const loose = normalizeProject({ ...p, clips: [...p.clips.slice(0, 2), frameClip('k2', 0, 3, { regions: { window: { x: -1, y: 0, w: 5, h: 0.5 }, chat: null } })] }, { id: 1 }).clips.find((c) => c.id === 'k2')!;
  assert.equal(loose.regions!.chat, null);
  assert.ok(loose.regions!.window.x >= 0 && loose.regions!.window.x + loose.regions!.window.w <= 1, 'pencere karenin içinde tutulur');
  assert.equal(dropFrameClips(p, 'vertical').clips.some((c) => c.kind === 'frame'), false);
  assert.equal(dropFrameClips(p, 'horizontal'), p);
});

test('expandFrameClips: çerçeve aralığında ana video pencereye oturan katman çerçevenin hemen altına girer; dışı değişmez', () => {
  const p = sample();
  p.clips.push(frameClip('k1', 4, 8, { fadeIn: 0.5, fadeOut: 0.3, opacity: 0.9 }));
  // Pencereye kamera bölgesi girer: çerçeve parçasının crop'u kaynaktaki webcam kutusudur.
  const camOnly = expandFrameClips({ ...p, clips: p.clips.map((c) => (c.id === 'k1' ? { ...c, crop: CAM } : c)) }).find((c) => c.id === 'k1~c1')!;
  assert.ok(sameRect(camOnly.crop, coverRegion(1920, 1080, CAM, 'horizontal', WINDOW)), 'kamera kutusu pencere oranına daraltılır');
  assert.ok(sameRect(camOnly.frame, WINDOW));
  const out = expandFrameClips(p);
  const ids = out.map((c) => c.id);
  assert.deepEqual(ids, ['c1', 'c2', 'k1~c1', 'k1~c2', 'k1'], 'türetilen pencereler çerçeve görselinden önce (altında) çizilir');
  const w1 = out.find((c) => c.id === 'k1~c1')!;
  assert.equal(w1.trackId, 'v2');
  assert.deepEqual([w1.start, w1.duration, w1.in], [4, 6, 4], 'ana parçayla aynı kaynak zamanı');
  assert.ok(sameRect(w1.frame, WINDOW));
  assert.ok(sameRect(w1.crop, FULL_RECT), '16:9 kaynak 16:9 pencereye kırpmasız');
  assert.equal(w1.muted, true);
  assert.equal(w1.opacity, 0.9);
  assert.equal(w1.fadeIn, 0.5, 'çerçevenin başındaki kesim giriş yumuşatmasını alır');
  assert.equal(w1.fadeOut, 0, 'ortadaki kesim çıkış yumuşatması almaz');
  const w2 = out.find((c) => c.id === 'k1~c2')!;
  assert.deepEqual([w2.start, w2.duration, w2.in], [10, 2, 12]);
  assert.equal(w2.fadeOut, 0.3);
  // Çerçeve görselinin kendisi kırpılmaz: kamera kutusu yalnız pencere katmanına uygulanır.
  const withCam = expandFrameClips({ ...p, clips: p.clips.map((c) => (c.id === 'k1' ? { ...c, crop: CAM } : c)) });
  const img = withCam.find((c) => c.id === 'k1')!;
  assert.ok(sameRect(img.crop, FULL_RECT) && sameRect(img.frame, FULL_RECT), 'çerçeve PNG\'si tam kare ve kırpmasız');
  assert.ok(sameRect(withCam.find((c) => c.id === 'k1~c1')!.crop, coverRegion(1920, 1080, CAM, 'horizontal', WINDOW)));
  assert.ok(sameRect(out.find((c) => c.id === 'c1')!.frame, FULL_RECT), 'ana parçanın kendisi değişmez (aralık dışında tam kare)');
  // Dikey kaynak pencereyi oran bozmadan doldurur (üst/alt kırpılır).
  const tall = expandFrameClips({ ...p, assets: [asset('a1', 'video', { width: 1080, height: 1920 }), asset('f1', 'image')] });
  const crop = tall.find((c) => c.id === 'k1~c1')!.crop;
  assert.equal(crop.w, 1);
  assert.ok(crop.h < 0.4 && near(crop.y, (1 - crop.h) / 2), `dikey kaynak ortadan kırpılır: ${JSON.stringify(crop)}`);
  // Gizli yoldaki çerçeve katman üretmez; çerçevesiz proje aynen döner.
  assert.equal(expandFrameClips({ ...p, tracks: p.tracks.map((t) => (t.id === 'v2' ? { ...t, hidden: true } : t)) }).length, 3);
  const plain = sample();
  assert.equal(expandFrameClips(plain), plain.clips, 'çerçeve yoksa liste değişmez');
  assert.equal(frameAt(p, 5)?.id, 'k1');
  assert.equal(frameAt(p, 2), null);
  assert.ok(near(frameSubtitleBottom(REGIONS), 190 / 1080 + 24 / 1080), 'altyazı pencerenin alt kenarının üstüne');
});

test('kamera alanı çerçevenin içindeyse pencereyi doldurur; expandClips ikisini birden açar', () => {
  const p = sample();
  p.tracks = [...p.tracks, { id: 'v3', kind: 'video', name: 'Katman 3', muted: false, hidden: false }];
  const cam = clip('m1', 'v3', 5, 2, { kind: 'cam', assetId: null, crop: { x: 0.7, y: 0.05, w: 0.25, h: 0.5 } });
  p.clips.push(frameClip('k1', 4, 8), cam);
  const cams = expandCamClips(p);
  const derived = cams.find((c) => c.id === 'm1~c1')!;
  assert.ok(sameRect(derived.frame, WINDOW), 'çerçeve kesimi bütünüyle kapsıyor → pencere');
  assert.ok(sameRect(derived.crop, coverRegion(1920, 1080, cam.crop, 'horizontal', WINDOW)));
  assert.ok(sameRect(coverRegion(1920, 1080, cam.crop, 'horizontal', WINDOW), coverRegion(1920, 1080, cam.crop, 'horizontal')), '16:9 pencere tam kareyle aynı oran');
  // Çerçevenin dışına taşan kamera tam kare kalır.
  const outside = expandCamClips({ ...p, clips: p.clips.map((c) => (c.id === 'm1' ? { ...c, start: 1, duration: 2 } : c)) }).find((c) => c.id === 'm1~c1')!;
  assert.ok(sameRect(outside.frame, FULL_RECT));
  const all = expandClips(p);
  assert.ok(all.some((c) => c.id === 'm1~c1') && all.some((c) => c.id === 'k1~c1') && !all.some((c) => c.kind === 'cam'));
});

test('addFrameClip / frameRangeFor: seçili ana parçanın aralığına, yoksa oynatma çizgisindeki ana parçaya; yalnız yatayda', () => {
  const p = sample();
  assert.deepEqual(frameRangeFor(p, p.clips[1], 0), { start: 10, end: 15 }, 'seçili ana yol parçası');
  assert.deepEqual(frameRangeFor(p, null, 3), { start: 0, end: 10 }, 'oynatma çizgisindeki ana parça');
  assert.equal(frameRangeFor({ ...p, clips: [] }, null, 0), null);
  const r = addFrameClip(p, p.assets[1], REGIONS, { start: 10, end: 15 }, CAM)!;
  assert.equal(r.clip.kind, 'frame');
  assert.equal(r.clip.assetId, 'f1');
  assert.deepEqual([r.clip.start, r.clip.duration], [10, 5]);
  assert.ok(sameRect(r.clip.regions!.window, WINDOW));
  assert.ok(sameRect(r.clip.crop, CAM), 'kamera kutusu parçanın crop\'unda');
  assert.ok(sameRect(addFrameClip(p, p.assets[1], REGIONS, { start: 10, end: 15 })!.clip.crop, FULL_RECT), 'kamera verilmezse tüm yayın');
  assert.notEqual(r.clip.trackId, 'v1', 'üst katmana konur');
  // Sohbet parçası: katmana bağlı, üst katmanda; katmanı ve tüm parçaları birlikte kaldırma.
  const s = addChatClip(p, 'h1', { start: 2, end: 9 })!;
  assert.deepEqual([s.clip.kind, s.clip.chatId, s.clip.start, s.clip.duration, s.clip.assetId], ['chat', 'h1', 2, 7, null]);
  const gone = removeChatEntirely(s.project, 'h1');
  assert.equal(gone.chats.length, 0);
  assert.equal(gone.clips.some((c) => c.kind === 'chat'), false);
  assert.equal(addFrameClip({ ...p, format: 'vertical' }, p.assets[1], REGIONS, { start: 0, end: 5 }), null);
  assert.equal(frameChatLayer(defaultChatLayer('h2', 'a1', 'horizontal'), DEFAULT_FRAME_CHAT).size, FRAME_CHAT_SIZE);
});

test('etkin sohbet katmanları: sohbet parçası ne zaman, çerçeve nerede; eski kayıt (parçasız katman) her yerde', () => {
  const p = sample();
  p.clips.push(frameClip('k1', 4, 8));
  // Parçasız katman: eski kayıt kuralı — sınırsız.
  const legacy = effectiveChatLayers(p);
  assert.equal(legacy.length, 2);
  assert.equal(legacy[0].within, null);
  // Sohbet parçaları 1–6 ve 9–14: yalnız bu aralıklarda; çerçeve (4–12) içindeki kısım panele.
  p.clips.push(chatClip('s1', 1, 5), chatClip('s2', 9, 5));
  assert.deepEqual(chatClipRanges(p, 'h1'), [{ start: 1, end: 6 }, { start: 9, end: 14 }]);
  assert.deepEqual(chatClipAt(p, 'h1', 10)?.id, 's2');
  assert.equal(chatClipAt(p, 'h1', 7), null);
  assert.deepEqual(intersectRanges([{ start: 0, end: 5 }, { start: 8, end: 10 }], [{ start: 3, end: 9 }]), [{ start: 3, end: 5 }, { start: 8, end: 9 }]);
  const eff = effectiveChatLayers(p);
  assert.equal(eff.length, 2);
  const [plain, framed] = eff;
  assert.equal(plain.layer.id, 'h1');
  assert.deepEqual(plain.within, [{ start: 1, end: 6 }, { start: 9, end: 14 }]);
  assert.deepEqual(plain.except, [{ start: 4, end: 12 }]);
  assert.equal(framed.layer.id, 'h1_k1');
  assert.equal(framed.frameClipId, 'k1');
  assert.ok(sameRect(framed.layer.frame, DEFAULT_FRAME_CHAT));
  assert.equal(framed.layer.background, 'none');
  assert.equal(framed.layer.size, FRAME_CHAT_SIZE);
  assert.deepEqual(framed.within, [{ start: 4, end: 6 }, { start: 9, end: 12 }], 'çerçeve ∩ sohbet parçaları');
  const segPlain = effectiveChatSegments(p, plain);
  const segFramed = effectiveChatSegments(p, framed);
  assert.deepEqual(segPlain.map((s) => [s.start, s.end, s.src]), [[1, 4, 1], [12, 14, 14]], 'asıl katman: sohbet parçasında ve çerçeve dışında; kaynak zamanı doğru kayar');
  assert.deepEqual(segFramed.map((s) => [s.start, s.end, s.src]), [[4, 6, 4], [9, 10, 9], [10, 12, 12]], 'türev yalnız çerçeve ∩ sohbet parçası');
  assert.equal(chatSourceAt(segPlain, 0.5), null, 'sohbet parçası başlamadan görünmez');
  assert.equal(chatSourceAt(segPlain, 7), null, 'parçalar arasında görünmez');
  assert.equal(chatSourceAt(segFramed, 5), 5);
  assert.equal(chatSourceAt(segFramed, 11), 13, 'ikinci ana parçanın kaynak zamanı (in=12) ile eşli');
  assert.equal(chatSourceAt(segPlain, 13), 15);
  // Sohbet parçası taşınsa da içerik yayın saatiyle eşli kalır: 9–14 yerine 2–7'ye alınca kaynak zamanı o anın videosundan.
  const moved = { ...p, clips: p.clips.map((c) => (c.id === 's2' ? { ...c, start: 2 } : c)) };
  assert.equal(chatSourceAt(effectiveChatSegments(moved, effectiveChatLayers(moved)[0]), 3), 3);
  // Gizli yoldaki sohbet parçası sayılmaz; hiç görünür parçası kalmayan katman çizilmez.
  const hiddenTrack = { ...p, tracks: p.tracks.map((t) => (t.id === 'v2' ? { ...t, hidden: true } : t)) };
  assert.equal(effectiveChatLayers(hiddenTrack).length, 0);
  // Kırpma: hızlı parça (2x) ve kısıt — kaynak zamanı hızla ilerler.
  const fast = clipSegments([{ start: 0, end: 10, src: 100, speed: 2, clipId: 'x' }], [{ start: 3, end: 5 }], []);
  assert.deepEqual(fast, [{ start: 3, end: 5, src: 106, speed: 2, clipId: 'x' }]);
  // Anahtar eki: kısıt değişince plan yenilenir; çerçevesiz projede ek yok.
  assert.notEqual(effectiveChatKeySuffix(framed), effectiveChatKeySuffix({ ...framed, within: [{ start: 4, end: 13 }] }));
  assert.equal(effectiveChatKeySuffix(effectiveChatLayers(sample())[0]), '');
  assert.deepEqual(chatSegments(p, p.chats[0]).map((s) => [s.start, s.end]), [[0, 10], [10, 15]], 'asıl bölümler (Tracks şeridi) çerçeveden etkilenmez');
  // Sohbet alanı olmayan çerçeve türev üretmez.
  const noChat = effectiveChatLayers({ ...p, clips: p.clips.map((c) => (c.kind === 'frame' ? { ...c, regions: { window: WINDOW, chat: null } } : c)) });
  assert.equal(noChat.length, 1);
  assert.deepEqual(noChat[0].except, []);
});

test('pencere bulma: alfası düşük en büyük bitişik bölgenin sınır kutusu; saydam bölge yoksa null', () => {
  const W = 64;
  const H = 36;
  const buf = Buffer.alloc(W * H * 4, 255);
  const clear = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) buf[(y * W + x) * 4 + 3] = 0;
  };
  clear(8, 6, 40, 30); // pencere 32×24
  clear(50, 2, 60, 5); // küçük bir saydam kırıntı (ayrı bölge)
  buf[(20 * W + 62) * 4 + 3] = 5; // tek piksel, eşik altı
  const win = findTransparentWindow(buf, W, H)!;
  assert.deepEqual([win.x, win.y, win.w, win.h, win.pixels], [8, 6, 32, 24, 32 * 24]);
  const rect = windowToRect(win, W, H);
  assert.ok(near(rect.x, 8 / 64) && near(rect.w, 32 / 64) && near(rect.y, 6 / 36) && near(rect.h, 24 / 36));
  assert.equal(findTransparentWindow(Buffer.alloc(W * H * 4, 255), W, H), null, 'saydam piksel yok');
  // Yarı saydam vizör işaretleri (alfa 100) pencereyi büyütmez.
  buf[(5 * W + 8) * 4 + 3] = 100;
  assert.equal(findTransparentWindow(buf, W, H)!.y, 6);
});

test('buildRenderPlan: çerçeve aralığında pencere katmanı, üstünde çerçeve görseli; sohbet ve altyazı en üstte', () => {
  const p = sample();
  p.clips.push(frameClip('k1', 4, 8));
  p.clips.push(chatClip('s1', 0, 15));
  const plan = buildRenderPlan(p, (c) => (c.assetId === 'f1' ? { file: '/x/frame.png', kind: 'image', hasAudio: false } : { file: `/x/${c.assetId}.mp4`, kind: 'video', hasAudio: true }), {
    output: '/out.mp4',
    assPath: '/s.ass',
    chat: { x: 1413, y: 258, width: 421, height: 616, fps: 10 },
  });
  const g = plan.filterGraph;
  // v1: c1, v2: c2 (ana yol) · v3: k1~c1, v4: k1~c2 (pencere) · v5: k1 (çerçeve görseli)
  assert.match(g, /\[v3\]overlay=64:170:enable='between\(t,4,10\)'/, 'pencere katmanı çerçevenin penceresinde');
  assert.match(g, /\[v4\]overlay=64:170:enable='between\(t,10,12\)'/, 'ikinci ana parçanın penceresi de çerçevenin altında (başlangıcı geç olsa da)');
  assert.match(g, /\[o4\]\[v5\]overlay=0:0:enable='between\(t,4,12\)'/, 'çerçeve görseli pencere katmanlarının üstünde, tam kare, yalnız kendi aralığında');
  assert.match(g, /\[5:v\]setpts=PTS-STARTPTS\+10\/TB,scale=1280:720/, 'pencere katmanı pencere boyutuna ölçeklenir');
  const iFrame = g.indexOf('[v5]overlay=0:0');
  const iChat = g.indexOf('[chat]overlay=');
  const iSub = g.indexOf('subtitles=');
  assert.ok(iFrame > 0 && iChat > iFrame && iSub > iChat, `sıra: parçalar → çerçeve → sohbet → altyazı: ${g}`);
  assert.deepEqual(plan.warnings, [], 'sohbet parçasının görsel girdisi yok, uyarı da yok');
  const args = plan.args.join(' ');
  assert.ok(args.includes('-loop 1 -framerate 30 -t 8 -i /x/frame.png'), 'çerçeve görseli yalnız parçanın süresince okunur');
  assert.ok(!buildRenderPlan(sample(), () => ({ file: '/x/a.mp4', kind: 'video', hasAudio: true }), { output: '/out.mp4' }).filterGraph.includes('overlay=64:170'));
});

/* ── Uçtan uca: gerçek ffmpeg ile çerçeve bindirme ──────────────────────── */

test('dışa aktarma: çerçeve aralığında pencere içi video, dışı çerçeve; aralık dışında tam kare video (ffmpeg)', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'ffmpeg yok' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-frame-'));
  try {
    const ff = (...args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
    const video = path.join(dir, 'kaynak.mp4');
    ff('-f', 'lavfi', '-i', 'color=c=red:s=1920x1080:r=30:d=4', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video);
    // Çerçeve: mavi tam kare, ortası (64,170)–(1344,890) saydam.
    const framePng = path.join(dir, 'cerceve.png');
    ff('-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080', '-frames:v', '1', '-vf', "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(X,64,1343)*between(Y,170,889),0,255)'", framePng);
    const decoded = execFileSync('ffmpeg', ['-v', 'error', '-i', framePng, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 1920 * 1080 * 4 + 1024 });
    const win = findTransparentWindow(decoded, 1920, 1080)!;
    assert.deepEqual([win.x, win.y, win.w, win.h], [64, 170, 1280, 720], 'pencere PNG\'den doğru ölçülür');
    const regions = { window: windowToRect(win, 1920, 1080), chat: null };

    const p = emptyProject(1, 'Çerçeve', 'horizontal');
    p.assets = [asset('a1', 'video', { duration: 4 }), asset('f1', 'image')];
    p.clips = [clip('c1', 'v1', 0, 4)];
    // Çerçeve yalnız 2–4. saniyede.
    const r = addFrameClip(p, p.assets[1], regions, { start: 2, end: 4 })!;
    const output = path.join(dir, 'cikti.mp4');
    const plan = buildRenderPlan(r.project, (c) => (c.assetId === 'a1' ? { file: video, kind: 'video', hasAudio: true } : c.assetId === 'f1' ? { file: framePng, kind: 'image', hasAudio: false } : null), { output });
    await runFfmpeg(plan.args, { totalSec: plan.totalSec }).done;
    const pixel = (t: number, x: number, y: number) => [...execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', output, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']).subarray(0, 3)];
    const red = (px: number[]) => px[0] > 200 && px[2] < 60;
    const blue = (px: number[]) => px[2] > 200 && px[0] < 60;
    assert.ok(red(pixel(1, 700, 500)) && red(pixel(1, 20, 20)) && red(pixel(1, 900, 1000)), 'çerçeve öncesi her yer video');
    assert.ok(red(pixel(3, 700, 500)), `çerçevede pencerenin içi video: ${pixel(3, 700, 500)}`);
    assert.ok(red(pixel(3, 70, 176)), `pencerenin köşesine yakın da video: ${pixel(3, 70, 176)}`);
    assert.ok(blue(pixel(3, 20, 20)), `pencerenin dışı çerçeve: ${pixel(3, 20, 20)}`);
    assert.ok(blue(pixel(3, 900, 1000)), `alt kartların yeri çerçeve: ${pixel(3, 900, 1000)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
