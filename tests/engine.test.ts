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
