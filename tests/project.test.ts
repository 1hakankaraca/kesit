import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyProject, fitFrame, coverCrop, normalizeProject, projectDuration, timelineCaptions, type Asset, type Clip, type Project } from '../shared/project.ts';
import { atempoChain, buildRenderPlan } from '../server/services/ProjectRenderer.ts';
import { describeCommand, parsePsLine } from '../server/services/SystemMonitor.ts';

const asset = (id: string, kind: Asset['kind'] = 'video'): Asset => ({ id, kind, name: id, duration: kind === 'image' ? 0 : 30, width: 1920, height: 1080, hasAudio: kind !== 'image', origin: { type: 'upload', file: `${id}.mp4` }, thumb: null });
const clip = (id: string, trackId: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({
  id, trackId, kind: 'video', assetId: 'a1', start, duration, in: 0,
  frame: { x: 0, y: 0, w: 1, h: 1 }, crop: { x: 0, y: 0, w: 1, h: 1 }, opacity: 1, volume: 1, muted: false, speed: 1, fadeIn: 0, fadeOut: 0,
  color: { brightness: 0, contrast: 1, saturation: 1, hue: 0 }, text: null, captions: null, renderAssetId: null, ...extra,
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
