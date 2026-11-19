import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const SubscribeCta = require('../server/engine/SubscribeCta.js');

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('abone çağrısı ayarı: bozuk/eksik değerler güvenli varsayılana döner', () => {
  const d = SubscribeCta.normalize(undefined);
  assert.equal(d.overlay.enabled, false);
  assert.deepEqual(d.overlay.at, ['start']);
  assert.deepEqual(d.insert.at, ['end']);
  const c = SubscribeCta.normalize(JSON.stringify({ overlay: { enabled: true, at: ['end', 'start', 'yok'], seconds: 99, labels: { subscribe: '  Takip et  ', like: '', comment: 'Yaz' }, style: 'card', place: 'top' }, insert: { enabled: true, at: 'middle' } }));
  assert.deepEqual(c.overlay.at, ['start', 'end'], 'sıra sabit, geçersizler düşer');
  assert.equal(c.overlay.seconds, 10, 'süre 2–10 arasına kırpılır');
  assert.deepEqual(c.overlay.labels, { subscribe: 'Takip et', like: '', comment: 'Yaz' }, 'boş yazı o çağrıyı kapatır');
  assert.equal(c.overlay.style, 'card');
  assert.deepEqual(c.insert.at, ['middle'], 'tek dize de kabul edilir');
  assert.equal(SubscribeCta.normalize('bozuk{').overlay.enabled, false);
  assert.equal(SubscribeCta.normalize({ overlay: { enabled: true, labels: { subscribe: '', like: '', comment: '' } } }).overlay.labels.subscribe, 'Abone ol', 'hepsi boşsa abone yazısı döner');
  assert.equal(SubscribeCta.normalize({ overlay: { text: 'Takip et' } }).overlay.labels.subscribe, 'Takip et', 'eski tek yazı alanı abone yazısına taşınır');
  assert.equal(SubscribeCta.normalize({ overlay: { style: 'cursor' } }).overlay.style, 'cursor');
});

test('abone çağrısı ayarı: sekme profili kendi değerini taşıyorsa o, yoksa genel', () => {
  const settings = { cta: JSON.stringify({ overlay: { enabled: true, style: 'bar' } }) };
  assert.equal(SubscribeCta.resolve(settings, null).overlay.style, 'bar');
  assert.equal(SubscribeCta.resolve(settings, { brand: { brand_color: '#000000' } }).overlay.style, 'bar', 'eski profil (cta yok) genele düşer');
  assert.equal(SubscribeCta.resolve(settings, { brand: { cta: { overlay: { enabled: true, style: 'card' } } } }).overlay.style, 'card');
});

test('animasyon pencereleri: kısa klipte çakışanlar atlanır, ortaya kesit dikiliyorsa orta pencere dikiş sonrasına kayar', () => {
  const ov = { ...SubscribeCta.DEFAULTS.overlay, at: ['start', 'middle', 'end'], seconds: 4 };
  const long = SubscribeCta.windows(ov, 60);
  assert.deepEqual(long.map((w: { at: string }) => w.at), ['start', 'middle', 'end']);
  assert.deepEqual(long[1], { start: 28, end: 32, at: 'middle' });
  assert.deepEqual(long[2], { start: 55.6, end: 59.6, at: 'end' });
  const short = SubscribeCta.windows(ov, 12);
  assert.deepEqual(short.map((w: { at: string }) => w.at), ['start', 'end'], 'orta pencere baştakiyle çakışır, atlanır');
  assert.deepEqual(SubscribeCta.windows(ov, 9).map((w: { at: string }) => w.at), ['start'], '9 sn: yalnız baştaki sığar');
  assert.equal(SubscribeCta.windows(ov, 1.5).length, 0, 'çok kısa klipte animasyon yok');
  const shifted = SubscribeCta.windows({ ...ov, at: ['middle'] }, 60, { middleInsert: true });
  assert.deepEqual(shifted[0], { start: 30, end: 34, at: 'middle' });
});

test('otomatik yerleşim: yalnız zamanı belirler; aç/kapa anahtarları ve tasarım korunur', () => {
  const saved = SubscribeCta.normalize({
    overlay: { enabled: true, at: ['middle'], style: 'cursor', formats: { vertical: { enabled: false, place: 'bottom', size: 60 }, horizontal: { enabled: true, place: 'top', size: 45 } } },
    insert: { enabled: true, at: ['end'], formats: { vertical: false, horizontal: true } },
  });
  const auto = SubscribeCta.autoPlan(saved);
  assert.deepEqual(auto.overlay.at, ['start', 'end']);
  assert.equal(auto.overlay.style, 'cursor', 'tasarım Stüdyo ayarından');
  assert.deepEqual(auto.overlay.formats.vertical, { enabled: false, place: 'bottom', size: 60 }, 'kapalı biçim kapalı kalır');
  assert.ok(!SubscribeCta.overlayActive(auto, 'vertical') && SubscribeCta.overlayActive(auto, 'horizontal'));
  assert.deepEqual(auto.insert, { enabled: true, at: ['middle'], formats: { vertical: false, horizontal: true } });
  assert.ok(!SubscribeCta.insertActive(auto, 'vertical') && SubscribeCta.insertActive(auto, 'horizontal'));
  assert.equal(SubscribeCta.autoPlan(saved, { hasClip: false }).insert.enabled, false, 'kesit yüklenmemişse dikme yok');
  assert.deepEqual(SubscribeCta.insertPoints(auto.insert.at, 25), [12.5], 'tam orta');
});

test('otomatik yerleşim: Stüdyo\'da kapatılan abone çağrısı hiçbir videoya eklenmez', () => {
  const off = SubscribeCta.autoPlan({ overlay: { enabled: false }, insert: { enabled: false } });
  for (const fmt of ['vertical', 'horizontal']) {
    assert.equal(SubscribeCta.overlayActive(off, fmt), false);
    assert.equal(SubscribeCta.insertActive(off, fmt), false);
    assert.deepEqual(SubscribeCta.overlayEvents(off, { duration: 60, format: fmt, playResX: 1080, playResY: 1920 }), []);
  }
});

test('dikiş noktaları: baş/orta/son, kısa klipte orta atlanır, intro kadar kayar', () => {
  assert.deepEqual(SubscribeCta.insertPoints(['start', 'middle', 'end'], 40), [0, 20, 40]);
  assert.deepEqual(SubscribeCta.insertPoints(['start', 'middle', 'end'], 8), [0, 8], '10 sn altı: orta yok');
  assert.deepEqual(SubscribeCta.insertPoints(['end'], 12, { offset: 5 }), [17]);
  assert.deepEqual(SubscribeCta.insertPoints(['start'], 0), []);
});

test('ASS olayları: hap/şerit/kart marka rengiyle çizilir, altyazı dosyasına stil eklenerek katılır', () => {
  const cfg = SubscribeCta.normalize({ overlay: { enabled: true, at: ['start'], style: 'pill', labels: { subscribe: 'Abone ol', like: '', comment: '' } } });
  const events: string[] = SubscribeCta.overlayEvents(cfg, { duration: 30, brandColor: '#53fc18', accentColor: '#ff3d8b', channel: 'hype' });
  assert.ok(events.length >= 3, 'hap + simge + yazı + dalga');
  assert.ok(events[0].includes('\\1c&H18FC53&'), 'renk bbggrr sırasında');
  assert.ok(events[0].includes('\\p1}m '), 'çizim komutu');
  assert.ok(events.every((e) => e.startsWith('Dialogue: ') && e.includes(',Cta,')));
  assert.ok(events.some((e) => e.endsWith('Abone ol')));
  assert.ok(!events.some((e) => e.endsWith('Beğen')), 'boş bırakılan çağrı çizilmez');
  assert.equal(SubscribeCta.overlayEvents(SubscribeCta.normalize({}), { duration: 30 }).length, 0, 'kapalıyken boş');
  const card: string[] = SubscribeCta.overlayEvents(SubscribeCta.normalize({ overlay: { enabled: true, style: 'card' } }), { duration: 30, channel: 'hype' });
  assert.ok(card.some((e) => e.endsWith('@hype')), 'kartın altında kanal adı');
  const bar = SubscribeCta.overlayEvents(SubscribeCta.normalize({ overlay: { enabled: true, style: 'bar' } }), { duration: 30, playResX: 1920, playResY: 1080, brandColor: '#000000', accentColor: '#ff3d8b' });
  assert.ok(bar[1].includes('\\1c&H8B3DFF&'), 'şeritte vurgu çizgisi');
  for (const style of SubscribeCta.STYLES) {
    const evs: string[] = SubscribeCta.overlayEvents(SubscribeCta.normalize({ overlay: { enabled: true, style, seconds: 5 } }), { duration: 30, brandColor: '#53fc18', accentColor: '#ff3d8b', channel: 'hype' });
    assert.ok(evs.length >= 6, `${style}: üç çağrı için olaylar`);
    for (const label of ['Beğen', 'Yorum yap', 'Abone ol']) assert.ok(evs.some((e) => e.endsWith(label)), `${style}: ${label} yazısı`);
    assert.ok(evs.every((e) => /^Dialogue: \d+,\d:\d\d:\d\d\.\d\d,\d:\d\d:\d\d\.\d\d,Cta,/.test(e)), `${style}: zaman biçimi`);
  }
  const cursor: string[] = SubscribeCta.overlayEvents(SubscribeCta.normalize({ overlay: { enabled: true, style: 'cursor', seconds: 5 } }), { duration: 30, brandColor: '#53fc18', accentColor: '#ff3d8b' });
  assert.ok(cursor.filter((e) => e.includes('\\move(') && e.includes('\\bord2')).length >= 4, 'imleç birden çok bacakta hareket eder');
  assert.ok(cursor.some((e) => e.includes('\\1c&H8B3DFF&') && e.includes('\\p1}m ')), 'tıklanınca buton vurgu rengine döner');
  assert.ok(cursor.some((e) => e.includes('\\frz')), 'zil sallanır');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-cta-'));
  const assPath = path.join(dir, 'sub.ass');
  fs.writeFileSync(assPath, '[Script Info]\nPlayResX: 1080\n\n[V4+ Styles]\nFormat: Name\nStyle: Normal,Arial\n\n[Events]\nFormat: Layer, Text\nDialogue: 0,merhaba\n');
  SubscribeCta.attach(events, assPath, path.join(dir, 'cta.ass'), { playResX: 1080, playResY: 1920 });
  const merged = fs.readFileSync(assPath, 'utf8');
  assert.ok(merged.indexOf('Style: Cta,') < merged.indexOf('[Events]'), 'stil olaylardan önce');
  assert.ok(merged.includes('Dialogue: 0,merhaba'), 'altyazı korunur');
  assert.ok(merged.trimEnd().endsWith(events[events.length - 1]), 'olaylar sona eklenir');
  const fresh = SubscribeCta.attach(events, null, path.join(dir, 'cta.ass'), { playResX: 1080, playResY: 1920 });
  assert.ok(fs.readFileSync(fresh, 'utf8').includes('PlayResY: 1920'));
  assert.equal(SubscribeCta.attach([], null, path.join(dir, 'x.ass'), { playResX: 1080, playResY: 1920 }), null, 'olay yoksa dosya yazılmaz');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dikiş planı: ana parçalar + kesit sırası, sessiz taraflar doldurulur, oran uymazsa bulanık arka plan', () => {
  const main = { width: 1080, height: 1920, duration: 40, fps: '30/1', hasAudio: true };
  const clip = { width: 1920, height: 1080, duration: 3, hasAudio: false };
  const plan = SubscribeCta.insertPlan({ main, clip, points: [0, 20, 40] });
  assert.equal(plan.segments, 5, 'kesit, ana, kesit, ana, kesit');
  assert.equal(plan.clipCount, 3);
  assert.equal(plan.addedSeconds, 9);
  assert.ok(plan.filterGraph.includes('boxblur'), 'yatay kesit dikeye bulanık arka planla sığar');
  assert.ok(plan.filterGraph.includes('anullsrc'), 'sessiz kesite sessizlik');
  assert.ok(plan.filterGraph.includes('concat=n=5:v=1:a=1'));
  assert.ok(plan.filterGraph.includes('[0:v]split=2'));
  const same = SubscribeCta.insertPlan({ main, clip: { ...clip, width: 1080, height: 1920, hasAudio: true }, points: [40] });
  assert.equal(same.segments, 2);
  assert.ok(!same.filterGraph.includes('boxblur'));
  assert.ok(same.filterGraph.includes('[1:a]'));
  assert.equal(SubscribeCta.insertPlan({ main, clip, points: [] }), null);
});

test('ffmpeg: kesit gerçekten dikilir ve önizleme üretilir', { skip: !hasFfmpeg && 'ffmpeg yok' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-cta-ff-'));
  const mainPath = path.join(dir, 'main.mp4');
  const clipPath = path.join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=90x160:r=30:d=12', '-f', 'lavfi', '-i', 'sine=f=440:d=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', mainPath]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=25:d=1.5', '-c:v', 'libx264', '-preset', 'ultrafast', clipPath]);
  const out = path.join(dir, 'out.mp4');
  const r = await SubscribeCta.insertClip({ inputPath: mainPath, outputPath: out, clipPath, points: SubscribeCta.insertPoints(['start', 'middle', 'end'], 12) });
  assert.equal(r.clipCount, 3);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', out]).toString());
  assert.ok(Math.abs(Number(probe.format.duration) - (12 + 4.5)) < 0.6, `süre ${probe.format.duration}`);
  assert.deepEqual(probe.streams.map((s: { codec_type: string }) => s.codec_type).sort(), ['audio', 'video']);
  assert.equal(probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video').width, 90);

  const cfg = SubscribeCta.normalize({ overlay: { enabled: true, style: 'cursor', seconds: 2 } });
  const prev = await SubscribeCta.renderPreview({ cfg, outputPath: path.join(dir, 'prev.mp4'), playResX: 1080, playResY: 1920, outW: 90, outH: 160, brandColor: '#53fc18', accentColor: '#ff3d8b', workDir: dir });
  assert.ok(fs.statSync(prev).size > 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('biçim ve boyut: dikey/yatay ayrı açılır, yer ve ölçek biçime göre, eski tek "place" iki biçime taşınır', () => {
  const d = SubscribeCta.normalize({});
  assert.deepEqual(d.overlay.formats, { vertical: { enabled: true, place: 'center', size: 100 }, horizontal: { enabled: true, place: 'bottom', size: 80 } });
  assert.deepEqual(d.overlay.colors, { primary: null, accent: null, text: null, dark: null });
  assert.deepEqual(d.insert.formats, { vertical: true, horizontal: true });
  const legacy = SubscribeCta.normalize({ overlay: { enabled: true, place: 'top' } });
  assert.equal(legacy.overlay.formats.vertical.place, 'top');
  assert.equal(legacy.overlay.formats.horizontal.place, 'top', 'eski yer her iki biçime');
  const c = SubscribeCta.normalize({
    overlay: { enabled: true, formats: { vertical: { enabled: false, size: 'xlarge' }, horizontal: { place: 'top', size: 'dev' } } },
    insert: { enabled: true, formats: { horizontal: false } },
  });
  assert.equal(c.overlay.formats.vertical.enabled, false);
  assert.equal(c.overlay.formats.vertical.size, 150, 'eski kademe adı yüzdeye çevrilir');
  assert.equal(c.overlay.formats.horizontal.size, 80, 'geçersiz boyut varsayılana döner');
  assert.equal(SubscribeCta.normalize({ overlay: { formats: { vertical: { size: 12 } } } }).overlay.formats.vertical.size, 30, 'alt sınır %30');
  assert.equal(SubscribeCta.normalize({ overlay: { formats: { vertical: { size: '55' } } } }).overlay.formats.vertical.size, 55, 'dize sayı kabul');
  assert.equal(c.overlay.formats.horizontal.place, 'top');
  assert.equal(SubscribeCta.overlayActive(c, 'vertical'), false);
  assert.equal(SubscribeCta.overlayActive(c, 'horizontal'), true);
  assert.equal(SubscribeCta.insertActive(c, 'vertical'), true);
  assert.equal(SubscribeCta.insertActive(c, 'horizontal'), false);
  assert.equal(SubscribeCta.overlayEvents(c, { duration: 30, format: 'vertical' }).length, 0, 'dikeyde kapalı → olay yok');
  assert.ok(SubscribeCta.overlayEvents(c, { duration: 30, format: 'horizontal', playResX: 1920, playResY: 1080 }).length > 0);
  assert.ok(SubscribeCta.overlayEvents(c, { duration: 30, playResX: 1920, playResY: 1080 }).length > 0, 'biçim verilmezse ölçüden çıkarılır');
  assert.equal(SubscribeCta.overlayEvents(c, { duration: 30, playResX: 1080, playResY: 1920 }).length, 0);

  // Boyut: aynı tasarım büyük ölçekte daha büyük simge çizer (\fscx değeri artar).
  const scaleOf = (size: number | string) => {
    const cfg = SubscribeCta.normalize({ overlay: { enabled: true, style: 'icons', formats: { vertical: { size } } } });
    const evs: string[] = SubscribeCta.overlayEvents(cfg, { duration: 30, format: 'vertical', brandColor: '#53fc18' });
    // Dalga halkası sabit %320 olduğundan en büyük değil, tüm ölçeklerin toplamı karşılaştırılır.
    return evs.flatMap((e) => [...e.matchAll(/\\fscx(\d+)/g)].map((m) => Number(m[1]))).reduce((a, b) => a + b, 0);
  };
  assert.ok(scaleOf(125) > scaleOf(100) && scaleOf(100) > scaleOf(45), 'küçük < orta < büyük');
  const top = SubscribeCta.overlayFor(SubscribeCta.normalize({ overlay: { formats: { horizontal: { place: 'top', size: 'large' } } } }), 'horizontal');
  assert.equal(top.place, 'top');
  assert.equal(top.scale, 1.25);
});

test('renkler: özel ana/vurgu/yazı/koyu renk çizime girer, geçersiz hex düşer, boşsa marka rengi', () => {
  const c = SubscribeCta.normalize({ overlay: { enabled: true, style: 'pill', colors: { primary: '#112233', accent: 'kırmızı', text: '#ABCDEF', dark: '#000000' } } });
  assert.deepEqual(c.overlay.colors, { primary: '#112233', accent: null, text: '#abcdef', dark: '#000000' });
  const col = SubscribeCta.colorsOf(c, '#53fc18', '#ff3d8b');
  assert.deepEqual(col, { primary: '#112233', accent: '#ff3d8b', text: '#abcdef', dark: '#000000' }, 'vurgu markadan, diğerleri ayardan');
  assert.deepEqual(SubscribeCta.colorsOf(SubscribeCta.normalize({}), '#53fc18', null), { primary: '#53fc18', accent: '#53fc18', text: '#ffffff', dark: '#2a2d33' });
  const evs: string[] = SubscribeCta.overlayEvents(c, { duration: 30, format: 'vertical', brandColor: '#53fc18', accentColor: '#ff3d8b' });
  const all = evs.join('\n');
  assert.ok(all.includes('&H332211&'), 'ana renk ASS BGR sırasıyla');
  assert.ok(all.includes('&HEFCDAB&'), 'yazı rengi');
  assert.ok(all.includes('&H000000&'), 'koyu zemin');
  assert.ok(!all.includes('&H18FC53&'), 'marka rengi özel renkle ezildi');
});
