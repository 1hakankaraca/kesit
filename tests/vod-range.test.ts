import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { clockText, kickTimeMs, parseClock } from '../src/lib/clock.ts';

const require = createRequire(import.meta.url);
const KickVodFetcher = require('../server/engine/KickVodFetcher.js');
const VodScanManager = require('../server/engine/VodScanManager.js');
const VodSegmentFollower = require('../server/engine/VodSegmentFollower.js');
const { parsePlaylist, henuzGelmedi } = VodSegmentFollower;

test('zaman girişi: dakika, dk:sn ve sa:dk:sn saniyeye çevrilir', () => {
  assert.equal(parseClock('25'), 1500);
  assert.equal(parseClock('12.5'), 750);
  assert.equal(parseClock('12,5'), 750);
  assert.equal(parseClock('25:30'), 1530);
  assert.equal(parseClock('1:02:00'), 3720);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock('abc'), null);
  assert.equal(parseClock('1:2:3:4'), null);
  assert.equal(clockText(3720), '1:02:00');
  assert.equal(clockText(90), '1:30');
});

test('Kick saati UTC okunur, ISO olduğu gibi kalır', () => {
  assert.equal(kickTimeMs('2026-10-16 18:14:00'), Date.UTC(2026, 9, 16, 18, 14, 0));
  assert.equal(kickTimeMs('2026-10-16T18:14:00.000Z'), Date.UTC(2026, 9, 16, 18, 14, 0));
  assert.equal(kickTimeMs(null), null);
});

test('ffmpeg aralık argümanları: -ss girdi tarafında, -t aralık uzunluğu', () => {
  const tam = KickVodFetcher.buildDownloadArgs('https://stream.kick.com/a.m3u8', '/tmp/v.mp4');
  assert.ok(!tam.includes('-ss') && !tam.includes('-t'));
  const aralik = KickVodFetcher.buildDownloadArgs('https://stream.kick.com/a.m3u8', '/tmp/v.mp4', { startSec: 720, endSec: 2100 });
  const ss = aralik.indexOf('-ss');
  assert.equal(aralik[ss + 1], '720.000');
  assert.ok(ss < aralik.indexOf('-i'), '-ss girdiden önce');
  assert.equal(aralik[aralik.indexOf('-t') + 1], '1380.000');
  // Başlangıç 0 ise -ss konmaz, yalnız -t
  const bastan = KickVodFetcher.buildDownloadArgs('https://stream.kick.com/a.m3u8', '/tmp/v.mp4', { startSec: 0, endSec: 60 });
  assert.ok(!bastan.includes('-ss'));
  assert.equal(bastan[bastan.indexOf('-t') + 1], '60.000');
});

test('aralık doğrulama: bitmiş yayında süreye kırpılır, canlıda ileri sınır 4 saat', () => {
  assert.equal(VodScanManager.normalizeRange(null, { durationSec: 100 }), null);
  assert.deepEqual(VodScanManager.normalizeRange({ startSec: 10.4, endSec: 50.2 }, { durationSec: 100 }), { startSec: 10, endSec: 51 });
  assert.deepEqual(VodScanManager.normalizeRange({ startSec: 10, endSec: 500 }, { durationSec: 100 }), { startSec: 10, endSec: 100 });
  assert.throws(() => VodScanManager.normalizeRange({ startSec: 100, endSec: 120 }, { durationSec: 100 }), /süresini aşıyor/);
  assert.throws(() => VodScanManager.normalizeRange({ startSec: 10, endSec: 12 }, { durationSec: 100 }), /en az/);
  assert.throws(() => VodScanManager.normalizeRange({ startSec: 10 }, { durationSec: 100 }), /bitişi gerekli/);
  // Canlı: bitiş ileride olabilir
  assert.deepEqual(VodScanManager.normalizeRange({ startSec: 1200, endSec: 3000 }, { isLive: true, durationSec: 1500 }), { startSec: 1200, endSec: 3000 });
  assert.throws(() => VodScanManager.normalizeRange({ startSec: 0, endSec: 1500 + 5 * 3600 }, { isLive: true, durationSec: 1500 }), /4 saat/);
});

test('parça takipçisi: başlangıç henüz yayınlanmadıysa bekler, yayın gelince aralığı toplar', async () => {
  const base = Date.UTC(2026, 9, 16, 18, 0, 0);
  const seg = (i: number) => `#EXTINF:10.0,\nseg${i}.ts\n`;
  // İlk okumada yayın 0-30 sn'de; ikinci okumada 0-80 sn.
  const playlists = [
    `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PROGRAM-DATE-TIME:${new Date(base).toISOString()}\n${seg(0)}${seg(1)}${seg(2)}#EXT-X-ENDLIST\n`,
    `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PROGRAM-DATE-TIME:${new Date(base).toISOString()}\n${[0, 1, 2, 3, 4, 5, 6, 7].map(seg).join('')}#EXT-X-ENDLIST\n`,
  ];
  let okuma = 0;
  const istekler: string[] = [];
  const http = {
    async get(url: string) {
      if (url.endsWith('.m3u8')) {
        const data = playlists[Math.min(okuma, playlists.length - 1)];
        okuma++;
        return { data };
      }
      istekler.push(url);
      return { data: Buffer.from(`<${path.basename(url)}>`) };
    },
  };
  const parcalar = parsePlaylist(playlists[0], 'https://stream.kick.com/x/720p/playlist.m3u8');
  assert.equal(henuzGelmedi(parcalar[parcalar.length - 1], base + 40_000), true);
  assert.equal(henuzGelmedi(parcalar[parcalar.length - 1], base + 25_000), false);

  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-aralik-')), 'v.ts');
  const takipci = new VodSegmentFollower({
    playlistUrl: 'https://stream.kick.com/x/720p/playlist.m3u8',
    outputPath: out,
    fromMs: base + 40_000, // 4. parça (40-50 sn) — ilk okumada henüz yok
    untilMs: base + 65_000, // 6. parçanın (60-70) sonuna kadar
    baseMs: base,
    http,
    pollMs: 5,
    drainMs: 10_000,
    stallMs: 10_000,
  });
  const sonuc = await takipci.start();
  assert.equal(sonuc.reason, 'completed');
  assert.deepEqual(istekler.map((u) => path.basename(u)), ['seg4.ts', 'seg5.ts', 'seg6.ts']);
  assert.equal(fs.readFileSync(out, 'utf8'), '<seg4.ts><seg5.ts><seg6.ts>');
  assert.equal(takipci.coveredSec, 30);
});

test('parça takipçisi: yayın aralığa gelmeden kapanırsa "ended" döner, dosya boş kalır', async () => {
  const base = Date.UTC(2026, 9, 16, 18, 0, 0);
  const playlist = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PROGRAM-DATE-TIME:${new Date(base).toISOString()}\n#EXTINF:10.0,\nseg0.ts\n#EXT-X-ENDLIST\n`;
  const http = { async get() { return { data: playlist }; } };
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-aralik-')), 'v.ts');
  const takipci = new VodSegmentFollower({
    playlistUrl: 'https://stream.kick.com/x/720p/playlist.m3u8',
    outputPath: out,
    fromMs: base + 600_000,
    untilMs: Date.now() + 60_000, // bitiş ileride; playlist büyümüyor → yayın bitti
    baseMs: base,
    http,
    pollMs: 5,
    stallMs: 40,
  });
  const sonuc = await takipci.start();
  assert.equal(sonuc.reason, 'ended');
  assert.equal(takipci.bytes, 0);
});
