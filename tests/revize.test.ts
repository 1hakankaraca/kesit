import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolveRow } from '../src/components/RangeDialog.tsx';

const require = createRequire(import.meta.url);
const ClipEditorManager = require('../server/engine/ClipEditorManager.js');
const ProcTracker = require('../server/engine/ProcTracker.js');

const layout = { cam: { x: 0.7, y: 0.6, w: 0.3, h: 0.4 }, content: { x: 0, y: 0, w: 1, h: 1 } };
const noCam = { found: true, fullCam: true, rect: null, meta: { width: 1920, height: 1080 } };
const withCam = { found: true, fullCam: false, rect: { x: 10, y: 10, w: 400, h: 300 }, meta: { width: 1920, height: 1080 } };

test('yerleşim kararı: "Kamera + oyun" + çizili kadraj → tespit yapılmaz, kadraj kullanılır', () => {
  const opts = ClipEditorManager.normalizeClipOptions({ composition: 'split', manualLayout: layout });
  assert.deepEqual(ClipEditorManager.layoutBeforeDetect(opts), layout);
  assert.equal(ClipEditorManager.layoutBeforeDetect(ClipEditorManager.normalizeClipOptions({ composition: 'auto', manualLayout: layout })), null, 'otomatikte önce tespit denenir');
  assert.equal(ClipEditorManager.layoutBeforeDetect(ClipEditorManager.normalizeClipOptions({ composition: 'split' })), null, 'kadraj yoksa tespit denenir');
});

test('yerleşim kararı: bölünmüş düzen istenip kamera bulunamayınca tek kareye düşülmez', () => {
  const split = ClipEditorManager.normalizeClipOptions({ composition: 'split' });
  assert.deepEqual(ClipEditorManager.layoutAfterDetect(split, noCam), ClipEditorManager.DEFAULT_MANUAL_LAYOUT, 'varsayılan kadraj');
  assert.equal(ClipEditorManager.layoutAfterDetect(split, withCam), null, 'kamera bulunduysa tespit sonucu kullanılır');

  const auto = ClipEditorManager.normalizeClipOptions({ composition: 'auto', manualLayout: layout });
  assert.deepEqual(ClipEditorManager.layoutAfterDetect(auto, noCam), layout, 'otomatikte kayıtlı kadraja düşülür');
  assert.equal(ClipEditorManager.layoutAfterDetect(ClipEditorManager.normalizeClipOptions({ composition: 'auto' }), noCam), null, 'kadraj yoksa tek kare');
  assert.equal(ClipEditorManager.layoutAfterDetect(ClipEditorManager.normalizeClipOptions({ composition: 'single', manualLayout: layout }), noCam), null, '"Tek kare" seçildiyse kadraj kullanılmaz');
});

test('sekme profili: channel_brands içinden kanal adıyla (küçük harf) okunur', () => {
  const settings = { channel_brands: JSON.stringify({ livorass: { brand: { brand_color: '#123456' }, clip_defaults: {} } }) };
  assert.equal(ClipEditorManager.channelProfile(settings, 'LivoRass')?.brand.brand_color, '#123456');
  assert.equal(ClipEditorManager.channelProfile(settings, 'baska'), null);
  assert.equal(ClipEditorManager.channelProfile({ channel_brands: 'bozuk{' }, 'livorass'), null);
  assert.equal(ClipEditorManager.channelProfile(settings, null), null);
});

test('süreç izleyici: iş anahtarı içinde açılan alt süreç iptalle öldürülür', async () => {
  const exited = await ProcTracker.run('test:1', async () => {
    const proc = ProcTracker.spawn('sleep', ['30']);
    const done = new Promise<{ code: number | null; signal: string | null }>((resolve) => proc.on('exit', (code: number | null, signal: string | null) => resolve({ code, signal })));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ProcTracker.kill('test:1'), 1, 'bir süreç öldürüldü');
    return done;
  });
  assert.equal(exited.signal, 'SIGKILL');
  assert.equal(ProcTracker.kill('test:1'), 0, 'biten süreç listeden düşer');
  assert.equal(ProcTracker.kill('yok'), 0);
});

test('aralık satırı: yayın başından ve şu andan geriye kipleri', () => {
  assert.deepEqual(resolveRow({ start: '12', end: '35' }, 'bastan', 3600, false).range, { startSec: 720, endSec: 2100 });
  assert.deepEqual(resolveRow({ start: '80', end: '50' }, 'geriye', 6000, true).range, { startSec: 1200, endSec: 3000 }, '80 dk önce → 50 dk önce');
  assert.deepEqual(resolveRow({ start: '1:00:00', end: '0' }, 'geriye', 5400, true).range, { startSec: 1800, endSec: 5400 }, '0 = şu an');
  assert.ok(resolveRow({ start: '50', end: '80' }, 'geriye', 6000, true).error, 'geriye kipinde bitiş daha yakın olmalı');
  assert.ok(resolveRow({ start: '200', end: '10' }, 'geriye', 6000, true).error, 'yayından daha geriye gidilemez');
  assert.ok(resolveRow({ start: '', end: '' }, 'bastan', 100, false).empty, 'boş satır atlanır');
  assert.equal(resolveRow({ start: '10', end: '99:00' }, 'bastan', 3600, false).range?.endSec, 3600, 'bitmiş yayında bitiş süreye kırpılır');
  assert.ok(resolveRow({ start: '10', end: '10' }, 'bastan', 3600, false).error, 'en az 5 sn');
});
