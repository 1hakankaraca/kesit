import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ClipEditorManager = require('../server/engine/ClipEditorManager.js');
const VerticalComposer = require('../server/engine/VerticalComposer.js');

test('normalizeClipOptions.manualLayout: geçerli kutular yuvarlanır, bozuk/küçük olanlar elenir', () => {
  const ok = ClipEditorManager.normalizeClipOptions({ manualLayout: { cam: { x: 0.7, y: 0.6, w: 0.5, h: 0.5 }, content: { x: '0', y: 0, w: 1, h: 1 } } }).manualLayout;
  assert.deepEqual(ok, { cam: { x: 0.7, y: 0.6, w: 0.3, h: 0.4 }, content: { x: 0, y: 0, w: 1, h: 1 } }, 'kutu kare içine kıstırılır');
  assert.equal(ClipEditorManager.normalizeClipOptions({ manualLayout: { cam: { x: 0, y: 0, w: 0.02, h: 0.5 }, content: { x: 0, y: 0, w: 1, h: 1 } } }).manualLayout, null, 'çok dar kamera');
  assert.equal(ClipEditorManager.normalizeClipOptions({ manualLayout: { cam: { x: 0, y: 0, w: 0.3, h: 0.3 } } }).manualLayout, null, 'içerik kutusu yok');
  assert.equal(ClipEditorManager.normalizeClipOptions({}).manualLayout, null);
});

test('manualRects: oranlar kaynak piksellerine çift sayı olarak çevrilir', () => {
  const r = ClipEditorManager.manualRects({ cam: { x: 0.75, y: 0.6, w: 0.25, h: 0.4 }, content: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }, { width: 1920, height: 1080 });
  assert.deepEqual(r.cam, { x: 1440, y: 648, w: 480, h: 432 });
  assert.deepEqual(r.content, { x: 192, y: 108, w: 960, h: 540 });
  for (const v of [...Object.values(r.cam), ...Object.values(r.content)] as number[]) assert.equal(v % 2, 0);
});

test('VerticalComposer.contentCrop: bölge verilince hedef orana ortalı sığdırır', () => {
  const meta = { width: 1920, height: 1080 };
  const contentH = 1920 - 608;
  const full = VerticalComposer.contentCrop(meta, contentH, null);
  assert.equal(full.cropH, 1080, 'bölge yoksa tam yükseklik');
  assert.ok(Math.abs(full.cropW / full.cropH - 1080 / contentH) < 0.01);
  assert.ok(Math.abs(full.cropX - (1920 - full.cropW) / 2) <= 2, 'ortalı (çift sayıya yuvarlanır)');

  const region = VerticalComposer.contentCrop(meta, contentH, { x: 0, y: 0, w: 1440, h: 1080 });
  assert.equal(region.cropH, 1080);
  assert.ok(region.cropW < 1440 && region.cropX > 0 && region.cropX + region.cropW <= 1440, 'bölgenin içinde kalır');

  const flat = VerticalComposer.contentCrop(meta, contentH, { x: 100, y: 500, w: 1800, h: 300 });
  assert.equal(flat.cropH, 300, 'yassı bölgede yükseklik sınırlar');
  assert.ok(Math.abs(flat.cropW / flat.cropH - 1080 / contentH) < 0.02);
  assert.ok(Math.abs(flat.cropX - (100 + (1800 - flat.cropW) / 2)) <= 2, 'bölge içinde ortalı');

  const narrow = VerticalComposer.contentCrop(meta, contentH, { x: 1400, y: 0, w: 400, h: 1080 });
  assert.equal(narrow.cropW, 400, 'dar bölgede genişlik sınırlar');
  assert.ok(narrow.cropH < 1080 && narrow.cropX === 1400);
});
