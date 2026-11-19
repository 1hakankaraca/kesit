import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverRegion, emptyProject, expandCamClips, fitFrame, coverCrop, normalizeProject, projectDuration, timelineCaptions, type Asset, type Clip, type CtaStyleKey, type Project } from '../shared/project.ts';
import { ctaEvents } from '../server/services/ProjectCta.ts';
import { createRequire } from 'node:module';
import { atempoChain, buildRenderPlan } from '../server/services/ProjectRenderer.ts';
import { describeCommand, parsePsLine } from '../server/services/SystemMonitor.ts';

const asset = (id: string, kind: Asset['kind'] = 'video'): Asset => ({ id, kind, name: id, duration: kind === 'image' ? 0 : 30, width: 1920, height: 1080, hasAudio: kind !== 'image', origin: { type: 'upload', file: `${id}.mp4` }, thumb: null });
const clip = (id: string, trackId: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({
  id, trackId, kind: 'video', assetId: 'a1', start, duration, in: 0,
  frame: { x: 0, y: 0, w: 1, h: 1 }, crop: { x: 0, y: 0, w: 1, h: 1 }, opacity: 1, volume: 1, muted: false, speed: 1, fadeIn: 0, fadeOut: 0,
  color: { brightness: 0, contrast: 1, saturation: 1, hue: 0 }, text: null, cta: null, captions: null, regions: null, chatId: null, renderAssetId: null, ...extra,
});

function sample(): Project {
  const p = emptyProject(1, 'Test', 'horizontal');
  p.assets = [asset('a1'), asset('a2', 'image'), asset('a3', 'audio')];
  p.clips = [clip('c1', 'v1', 0, 10), clip('c2', 'v1', 10, 5, { in: 12 }), clip('c3', 'v2', 2, 3, { kind: 'image', assetId: 'a2', frame: { x: 0.6, y: 0.1, w: 0.3, h: 0.3 }, opacity: 0.5 }), clip('c4', 'a1', 0, 15, { kind: 'audio', assetId: 'a3', volume: 0.4 })];
  return p;
}

test('normalizeProject: bozuk parçaları atar, kimlik ve biçimi doğrular', () => {
  const raw = { ...sample(), format: 'weird', clips: [...sample().clips, { id: 'bad', trackId: 'yok', kind: 'video', assetId: 'a1' }, { id: 'x', trackId: 'v1', kind: 'video', assetId: 'olmayan' }] };
  const p = normalizeProject(raw, { id: 7 });
  assert.equal(p.id, 7);
  assert.equal(p.format, 'horizontal');
  assert.equal(p.clips.length, 4, 'yolu/varlığı olmayan parçalar atılır');
  assert.equal(p.clips[2].opacity, 0.5);
  assert.equal(projectDuration(p), 15);
});

test('fitFrame ve coverCrop oranı korur', () => {
  const f = fitFrame(1920, 1080, { x: 0, y: 0, w: 1, h: 1 }, 'vertical');
  assert.equal(f.w, 1);
  assert.ok(Math.abs(f.h - 0.3164) < 0.001);
  const c = coverCrop(1920, 1080, { x: 0, y: 0.3, w: 1, h: 0.7 }, 'vertical');
  assert.equal(c.h, 1);
  assert.ok(c.w < 1 && Math.abs(c.x - (1 - c.w) / 2) < 1e-9);
});

test('timelineCaptions: kaynak zamanını çizelgeye taşır ve kesilen kısmı atar', () => {
  const p = sample();
  p.clips[1].captions = [{ start: 11, end: 13, text: 'önce' }, { start: 14, end: 16, text: 'içeride' }, { start: 20, end: 21, text: 'sonra' }];
  const caps = timelineCaptions(p);
  assert.deepEqual(caps.map((c) => c.text), ['önce', 'içeride']);
  assert.equal(caps[0].start, 10);
  assert.equal(caps[1].start, 12);
  assert.equal(caps[1].end, 14);
});

test('buildRenderPlan: katmanlar alttan üste dikilir, ses karışır, altyazı en üstte', () => {
  const p = sample();
  const plan = buildRenderPlan(p, (c) => ({ file: `/tmp/${c.assetId}.mp4`, kind: c.kind === 'audio' ? 'audio' : c.kind === 'image' ? 'image' : 'video', hasAudio: c.kind !== 'image' }), { output: '/tmp/out.mp4', assPath: '/tmp/a:b.ass' });
  assert.equal(plan.width, 1920);
  assert.equal(plan.totalSec, 15);
  assert.match(plan.filterGraph, /\[0:v\]\[v1\]overlay=0:0:enable='between\(t,0,10\)'/);
  assert.match(plan.filterGraph, /\[o2\]\[v3\]overlay=1152:108/, 'üst katman görseli konumuna');
  assert.match(plan.filterGraph, /colorchannelmixer=aa=0\.5/);
  assert.match(plan.filterGraph, /amix=inputs=4/);
  assert.match(plan.filterGraph, /subtitles=filename='\/tmp\/a\\:b\.ass'\[outv\]/);
  assert.ok(plan.args.includes('-loop'), 'görsel döngüyle okunur');
  assert.equal(plan.args[plan.args.length - 1], '/tmp/out.mp4');
});

test('buildRenderPlan: hız ve yumuşatma — setpts/atempo ve fade/afade', () => {
  const p = sample();
  p.clips = [clip('c1', 'v1', 0, 5, { speed: 2, fadeIn: 1, fadeOut: 0.5 }), clip('c2', 'v2', 1, 2, { fadeIn: 0.5 })];
  const plan = buildRenderPlan(p, () => ({ file: '/tmp/x.mp4', kind: 'video', hasAudio: true }), { output: '/tmp/o.mp4' });
  assert.ok(plan.args.join(' ').includes('-ss 0 -t 10 -i /tmp/x.mp4'), 'kaynaktan süre×hız okunur');
  assert.match(plan.filterGraph, /setpts=\(PTS-STARTPTS\)\/2\+0\/TB/);
  assert.match(plan.filterGraph, /fade=t=in:st=0:d=1,fade=t=out:st=4\.5:d=0\.5\[v1\]/, 'ana yol siyaha yumuşar');
  assert.match(plan.filterGraph, /format=yuva420p,fade=t=in:st=1:d=0\.5:alpha=1/, 'üst katman saydama yumuşar');
  assert.match(plan.filterGraph, /atempo=2,volume=1,afade=t=in:st=0:d=1,afade=t=out:st=4\.5:d=0\.5/);
  assert.deepEqual(atempoChain(3), ['atempo=2', 'atempo=1.5']);
  assert.deepEqual(atempoChain(0.25), ['atempo=0.5', 'atempo=0.5']);
});

test('buildRenderPlan: gizli yol atlanır, kaynağı olmayan parça uyarı verir', () => {
  const p = sample();
  p.tracks = p.tracks.map((t) => (t.id === 'v2' ? { ...t, hidden: true } : t));
  const plan = buildRenderPlan(p, (c) => (c.id === 'c2' ? null : { file: '/tmp/x.mp4', kind: 'video', hasAudio: true }), { output: '/tmp/o.mp4' });
  assert.equal(plan.warnings.length, 1);
  assert.doesNotMatch(plan.filterGraph, /\[v3\]/);
  assert.match(plan.filterGraph, /null\[outv\]/);
});

test('sistem izleyici: ps satırı (virgüllü ondalık dahil) ve komut etiketi', () => {
  const row = parsePsLine('  123  45  12,5 20480 01:02:03 /usr/local/bin/ffmpeg -i a.mp4 -filter_complex overlay=0:0 -progress pipe:1 out.mp4');
  assert.ok(row);
  assert.equal(row!.cpu, 12.5);
  assert.equal(row!.rssKb, 20480);
  assert.equal(describeCommand(row!.command).label, 'Video dışa aktarılıyor');
  assert.equal(describeCommand('whisper-cli -m model.bin').label, 'Konuşma yazıya dökülüyor');
  assert.equal(parsePsLine('bozuk satır'), null);
});

/* ── Kamera alanı ve abone çağrısı parçaları ─────────────────────────────── */

test('coverRegion: bölgeyi çıktı oranında, ortalanmış daraltır', () => {
  // 1920×1080 kaynakta 0.26×0.46 (≈ 16:9 kutu) → dikey çıktıda yükseklik korunur, en daralır
  const r = coverRegion(1920, 1080, { x: 0.72, y: 0.02, w: 0.26, h: 0.4622 }, 'vertical');
  assert.ok(Math.abs(r.h - 0.4622) < 1e-9);
  assert.ok(r.w < 0.26 && Math.abs(r.x - (0.72 + (0.26 - r.w) / 2)) < 1e-9, 'yatayda ortalanır');
  const aspect = (1920 * r.w) / (1080 * r.h);
  assert.ok(Math.abs(aspect - 9 / 16) < 1e-6, 'çıktı oranı 9:16');
  const h = coverRegion(1920, 1080, { x: 0, y: 0, w: 0.5, h: 1 }, 'horizontal');
  assert.equal(h.w, 0.5);
  assert.ok(h.h < 1 && Math.abs(h.y - (1 - h.h) / 2) < 1e-9, 'dikey bölge yatay çıktıda ortadan kırpılır');
});

test('expandCamClips: kamera alanı ana yoldaki kesimlere bölünür, kaynak zamanı birebir ilerler', () => {
  const p = sample();
  p.format = 'vertical';
  p.clips.push(clip('cam1', 'v2', 8, 5, { kind: 'cam', assetId: null, crop: { x: 0.7, y: 0, w: 0.3, h: 0.5 }, fadeIn: 0.1, fadeOut: 0.1 }));
  const out = expandCamClips(p);
  assert.ok(!out.some((c) => c.kind === 'cam'), 'kamera parçası listede kalmaz');
  const derived = out.filter((c) => c.id.startsWith('cam1~')).sort((a, b) => a.start - b.start);
  assert.equal(derived.length, 2, 'iki ana parçaya yayılır');
  const [a, b] = derived;
  assert.equal(a.id, 'cam1~c1');
  assert.equal(a.start, 8);
  assert.equal(a.duration, 2);
  assert.equal(a.in, 8, 'ilk ana parça 0’dan başlar → kaynak 8');
  assert.equal(b.id, 'cam1~c2');
  assert.equal(b.start, 10);
  assert.equal(b.duration, 3);
  assert.equal(b.in, 12, 'ikinci ana parçanın kendi girişi (12) korunur');
  assert.equal(a.trackId, 'v2', 'kamera alanının katmanında çizilir');
  assert.ok(a.muted && b.muted, 'türetilen katman sessiz');
  assert.deepEqual(a.frame, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(a.fadeIn, 0.1);
  assert.equal(a.fadeOut, 0, 'kesim ortasında yumuşatma yok');
  assert.equal(b.fadeOut, 0.1);
  const aspect = (1920 * a.crop.w) / (1080 * a.crop.h);
  assert.ok(Math.abs(aspect - 9 / 16) < 1e-6, 'kamera bölgesi tam kareyi dolduracak biçimde kırpılır');
  // Gizli katmandaki kamera alanı atlanır
  p.tracks = p.tracks.map((t) => (t.id === 'v2' ? { ...t, hidden: true } : t));
  assert.equal(expandCamClips(p).filter((c) => c.id.includes('~')).length, 0);
});

test('normalizeProject: cta ve cam parçaları varlıksız kabul edilir, tasarım doğrulanır', () => {
  const raw = { ...sample(), clips: [...sample().clips, { id: 'k1', trackId: 'v2', kind: 'cta', start: 1, duration: 4, cta: { style: 'card', place: 'bottom', size: 999 } }, { id: 'k2', trackId: 'v2', kind: 'cam', start: 2, duration: 3, crop: { x: 0.5, y: 0.5, w: 0.6, h: 0.6 } }] };
  const p = normalizeProject(raw, { id: 1 });
  const cta = p.clips.find((c) => c.id === 'k1')!;
  assert.equal(cta.kind, 'cta');
  assert.deepEqual(cta.cta, { style: 'card', x: 0.5, y: 0.78, size: 200 });
  const cam = p.clips.find((c) => c.id === 'k2')!;
  assert.equal(cam.kind, 'cam');
  assert.equal(cam.cta, null);
  assert.deepEqual(cam.crop, { x: 0.4, y: 0.4, w: 0.6, h: 0.6 }, 'bölge kare içinde kalır');
});

test('buildRenderPlan: kamera alanı tam kare katman olur, çağrı parçası ffmpeg planına girmez', () => {
  const p = sample();
  p.clips.push(clip('cam1', 'v2', 8, 5, { kind: 'cam', assetId: null, crop: { x: 0.7, y: 0, w: 0.3, h: 0.5 } }));
  p.clips.push(clip('cta1', 'v2', 0, 4, { kind: 'cta', assetId: null, cta: { style: 'pill', x: 0.5, y: 0.5, size: 100 } }));
  const plan = buildRenderPlan(p, (c) => (c.kind === 'cta' ? null : { file: `/tmp/${c.assetId}.mp4`, kind: c.kind === 'audio' ? 'audio' : c.kind === 'image' ? 'image' : 'video', hasAudio: c.kind !== 'image' }), { output: '/tmp/out.mp4' });
  assert.equal(plan.warnings.length, 0, 'çağrı parçası uyarı üretmez (ASS ile basılır)');
  assert.match(plan.filterGraph, /overlay=0:0:enable='between\(t,8,10\)'/, 'ilk kesimdeki kamera katmanı');
  assert.match(plan.filterGraph, /overlay=0:0:enable='between\(t,10,13\)'/, 'ikinci kesimdeki kamera katmanı');
  assert.match(plan.filterGraph, /crop=iw\*0\.3:ih\*0\.3:iw\*0\.7:ih\*0\.1/, 'kamera bölgesi 16:9 oranında, ortadan kırpılır');
  assert.match(plan.filterGraph, /scale=1920:1080/, 'tam kare');
  // Kamera katmanı sessiz: amix yalnız ana parçalar + ses dosyası (3 + taban)
  assert.match(plan.filterGraph, /amix=inputs=4/);
});

test('ctaEvents: her çağrı parçası kendi penceresinde ASS olayı üretir', () => {
  const require = createRequire(import.meta.url);
  const SubscribeCta = require('../server/engine/SubscribeCta.js');
  const cfg = SubscribeCta.normalize({ overlay: { enabled: false, labels: { subscribe: 'Abone ol', like: 'Beğen', comment: '' } } });
  const p = sample();
  p.format = 'vertical';
  p.clips.push(clip('cta1', 'v2', 3, 4, { kind: 'cta', assetId: null, cta: { style: 'pill', x: 0.5, y: 0.2, size: 100 } }));
  p.clips.push(clip('cta2', 'v2', 10, 0.5, { kind: 'cta', assetId: null, cta: { style: 'bar', x: 0.5, y: 0.78, size: 80 } }));
  const events = ctaEvents(SubscribeCta, p, cfg, { brandColor: '#ff0000', accentColor: null, channel: 'kanal' });
  assert.ok(events.length > 0, 'ayar kapalı olsa da parça varsa çizilir');
  assert.ok(events.every((e) => e.startsWith('Dialogue: ')));
  assert.ok(events.some((e) => e.includes(',0:00:03.00,')), 'pencere parçanın başında açılır');
  assert.ok(!events.some((e) => e.includes(',0:00:10.00,')), '1 sn’den kısa çağrı atlanır');
  assert.ok(events.some((e) => e.includes('Abone ol')) && !events.some((e) => e.includes('Yorum')), 'boş yazı gösterilmez');
  // Gizli katman → olay yok
  p.tracks = p.tracks.map((t) => (t.id === 'v2' ? { ...t, hidden: true } : t));
  assert.equal(ctaEvents(SubscribeCta, p, cfg).length, 0);
});

test('ctaEvents: parçanın x/y konumu ASS koordinatına taşınır', () => {
  const require = createRequire(import.meta.url);
  const SubscribeCta = require('../server/engine/SubscribeCta.js');
  const cfg = SubscribeCta.normalize({ overlay: { labels: { subscribe: 'Abone ol', like: '', comment: '' } } });
  const at = (x: number, y: number, style: CtaStyleKey = 'icons') => {
    const p = sample();
    p.format = 'vertical';
    p.clips.push(clip('cta1', 'v2', 0, 4, { kind: 'cta', assetId: null, cta: { style, x, y, size: 100 } }));
    return ctaEvents(SubscribeCta, p, cfg, { brandColor: '#ff0000' }).join('\n');
  };
  // Simgeler stili tek çağrıyla tam merkezde çizilir: pos(x*1080, y*1920)
  assert.ok(at(0.25, 0.1).includes('\\pos(270,192)'), 'merkez sola/yukarı kayar');
  assert.ok(at(0.5, 0.5).includes('\\pos(540,960)'), 'orta');
  // Şerit tam genişlik: x ne olursa olsun yatayda ortalı kalır, y uygulanır
  const bar = at(0.1, 0.9, 'bar');
  assert.ok(bar.includes('\\move(-540,1728,540,1728,0,350)'), 'şerit X/2’ye kayar, y=0.9');
});
