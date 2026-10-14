import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { normalizeAutopilot } from '../shared/autopilot.ts';

const require = createRequire(import.meta.url);
const HorizontalComposer = require('../server/engine/HorizontalComposer.js');
const { Queue, Worker } = require('../server/engine/LocalQueue.js');

const main = { width: 1920, height: 1080, fps: '30/1', hasAudio: true, duration: 10 };

test('renderPlan: intro + outro sırayla birleştirilir', () => {
  const plan = HorizontalComposer.renderPlan({ main, intro: { hasAudio: true, duration: 3 }, outro: { hasAudio: true, duration: 2 } });
  assert.equal(plan.introIndex, 1);
  assert.equal(plan.outroIndex, 2);
  assert.equal(plan.needsSilence, false);
  assert.match(plan.filterGraph, /\[introv\]\[introa\]\[mainv\]\[maina\]\[outrov\]\[outroa\]concat=n=3/);
});

test('renderPlan: yalnız outro, sessiz outro için sessizlik girdisi', () => {
  const plan = HorizontalComposer.renderPlan({ main, outro: { hasAudio: false, duration: 2 }, logo: { logoW: 200, opacity: 1, x: 0.9, y: 0.1 } });
  assert.equal(plan.introIndex, null);
  assert.equal(plan.outroIndex, 2);
  assert.equal(plan.silenceIndex, 3);
  assert.match(plan.filterGraph, /\[mainv\]\[maina\]\[outrov\]\[outroa\]concat=n=2/);
});

test('renderPlan: ek yoksa yalnız görüntü zinciri', () => {
  const plan = HorizontalComposer.renderPlan({ main });
  assert.equal(plan.needsSilence, false);
  assert.match(plan.filterGraph, /\[outv\]$/);
});

test('LocalQueue: eşzamanlılık sınırı ve kuyruktan çıkarma', async () => {
  const q = new Queue('test-kuyruk');
  const done: string[] = [];
  let running = 0;
  let peak = 0;
  const worker = new Worker(
    'test-kuyruk',
    async (job: { name: string }) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      done.push(job.name);
      running--;
    },
    { concurrency: 2 },
  );
  await q.add('a', {});
  await q.add('b', {});
  await q.add('c', {});
  const removed = await q.add('d', {});
  await removed.remove();
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(done.sort(), ['a', 'b', 'c']);
  assert.equal(peak, 2);
  await worker.close();
});

test('nöbetçi ayarı: bilinmeyen alanlar atılır, hesaplar süzülür', () => {
  const cfg = normalizeAutopilot({ enabled: true, channel: 'kanal', downloadVod: 'evet', publishAccounts: [{ platform: 'youtube', accountId: '1' }, { bad: 1 }], hack: true });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.downloadVod, true, 'geçersiz değer varsayılana düşer');
  assert.equal(normalizeAutopilot({ record: false }).downloadVod, false, 'eski "record" ayarı taşınır');
  assert.equal(cfg.publishAccounts.length, 1);
  assert.equal('hack' in cfg, false);
});

test('Kick dönüşü yalnız bu bilgisayara ya da yerel ağa yönlenir', async () => {
  const { localOrigin } = await import('../server/auth.ts');
  assert.equal(localOrigin('http://localhost:5174/ayarlar'), 'http://localhost:5174');
  assert.equal(localOrigin('http://192.168.1.20:3002'), 'http://192.168.1.20:3002');
  assert.equal(localOrigin('http://172.20.0.5:3002'), 'http://172.20.0.5:3002');
  assert.equal(localOrigin('https://kotu-site.com'), null);
  assert.equal(localOrigin('http://172.40.0.1'), null);
  assert.equal(localOrigin('javascript:alert(1)'), null);
});

const Transcriber = require('../server/engine/Transcriber.js');
const ClipEditorManager = require('../server/engine/ClipEditorManager.js');

test('yatay altyazı her çözünürlükte yüksekliğin aynı oranında', () => {
  for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1440]]) {
    const l = HorizontalComposer.subtitleLayout({ width: w, height: h });
    assert.equal(l.playResX, w);
    assert.equal(l.playResY, h);
    assert.ok(Math.abs((58 * l.fontScale) / h - 0.0468) < 0.001, `${h}p yazı oranı`);
    assert.ok(Math.abs(l.marginV / h - 0.07) < 0.002);
  }
});

test('altyazı stili ölçeklenir, MarginV korunur', () => {
  const line = 'Style: Normal,Arial,58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,60,60,320,1';
  const f = Transcriber.scaleStyleLines(line, 0.5).split(',');
  assert.equal(f[2], '29');
  assert.equal(f[16], '2');
  assert.equal(f[19], '30');
  assert.equal(f[21], '320');
});

test('yatay varsayılanda altyazı kapalı, dikeyde açık; kayıtlı tercih geçerli', () => {
  assert.equal(ClipEditorManager.groupDefaults({}, 'horizontal').subtitles, false);
  assert.equal(ClipEditorManager.groupDefaults({}, 'gezgin').subtitles, true);
  const saved = { gezgin: {}, vodscan: {}, live: {}, horizontal: { subtitles: true } };
  assert.equal(ClipEditorManager.groupDefaults(saved, 'horizontal').subtitles, true);
});

test('yatay kompozisyon altyazıyı logodan sonra, ölçeklemeden önce basar', () => {
  const plan = HorizontalComposer.renderPlan({ main, assPath: '/tmp/x.ass', logo: { logoW: 200, opacity: 1, x: 0.5, y: 0.5 }, output: { width: 1280, height: 720 } });
  assert.match(plan.filterGraph, /\[lg\]subtitles='\/tmp\/x\.ass'\[sub\];\[sub\]scale=1280:720/);
});
