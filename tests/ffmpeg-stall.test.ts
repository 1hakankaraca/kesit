import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runFfmpeg } from '../server/lib/media.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('runFfmpeg: ilerleme durursa işlem kesilir ve hata iptal sayılmaz (kodlayıcı yedeği yeniden dener)', { skip: !hasFfmpeg && 'ffmpeg yok' }, async () => {
  // Standart girdiden ham kare bekleyen ffmpeg'e hiç kare yazılmaz: ilerleme gelmez, bekçi 1 sn sonra keser.
  const run = runFfmpeg(['-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '16x16', '-framerate', '10', '-i', 'pipe:0', '-f', 'null', '-'], {
    totalSec: 5,
    stallSec: 1,
    feed: () => new Promise<void>(() => {}),
  });
  const t0 = Date.now();
  await assert.rejects(run.done, (err: Error & { signal?: string; killed?: boolean }) => {
    assert.match(err.message, /takıldı/);
    assert.equal(err.signal, undefined, 'iptal bilgisi taşımaz');
    assert.equal(err.killed, undefined);
    return true;
  });
  assert.ok(Date.now() - t0 < 5000, 'bekçi gecikmeden kesti');
});

test('runFfmpeg: ilerleyen iş bekçiye takılmaz', { skip: !hasFfmpeg && 'ffmpeg yok' }, async () => {
  const pcts: number[] = [];
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=2', '-f', 'null', '-'], { totalSec: 2, stallSec: 2, onProgress: (p) => pcts.push(p) }).done;
  assert.ok(pcts.length > 0);
});
