import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const VideoEncoder = require('../server/engine/VideoEncoder.js');
const RecordingFinalizer = require('../server/engine/RecordingFinalizer.js');

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const gpu = (family: string, codec = 'h264', extra: Record<string, unknown> = {}) => ({
  family, hw: true, codec, encoder: `${codec}_${family}`, label: family, qscale: true, hwaccel: null, ...extra,
});

test('işlemci argümanları eskisiyle aynı: veryfast crf 20, taslakta ultrafast crf 24', () => {
  assert.deepEqual(VideoEncoder.videoArgs(VideoEncoder.cpu('h264')), ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']);
  assert.deepEqual(VideoEncoder.videoArgs(VideoEncoder.cpu('h264'), { quality: 'draft' }), ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p']);
  assert.deepEqual(VideoEncoder.inputArgs(VideoEncoder.cpu('h264')), [], 'işlemcide donanım çözme yok');
});

test('bit hızı modu: VBV ve hız ön ayarı; H.265 x265-params ve hvc1 ile', () => {
  const h264 = VideoEncoder.videoArgs(VideoEncoder.cpu('h264'), { bitrateKbps: '6M', bufsizeKbps: '12M', speed: 'balanced' });
  assert.deepEqual(h264, ['-c:v', 'libx264', '-preset', 'medium', '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k', '-profile:v', 'high', '-pix_fmt', 'yuv420p']);
  const hevc = VideoEncoder.videoArgs(VideoEncoder.cpu('hevc'), { bitrateKbps: 2500 });
  assert.deepEqual(hevc, ['-c:v', 'libx265', '-preset', 'fast', '-b:v', '2500k', '-pix_fmt', 'yuv420p', '-x265-params', 'vbv-maxrate=2500:vbv-bufsize=5000:log-level=error', '-tag:v', 'hvc1']);
  assert.equal(VideoEncoder.kbps('1500k'), 1500);
  assert.equal(VideoEncoder.kbps(3000), 3000);
});

test('GPU aileleri: VideoToolbox sabit kalite, NVENC cq, Quick Sync ICQ, AMF cqp', () => {
  const vt = VideoEncoder.videoArgs(gpu('videotoolbox'));
  assert.deepEqual(vt, ['-c:v', 'h264_videotoolbox', '-q:v', '65', '-profile:v', 'high', '-pix_fmt', 'yuv420p']);
  const vtHevc = VideoEncoder.videoArgs(gpu('videotoolbox', 'hevc'), { bitrateKbps: 2500 });
  assert.deepEqual(vtHevc, ['-c:v', 'hevc_videotoolbox', '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1']);
  const nv = VideoEncoder.videoArgs(gpu('nvenc'));
  assert.ok(nv.join(' ').includes('-cq 23 -b:v 0'), nv.join(' '));
  const qsv = VideoEncoder.videoArgs(gpu('qsv'), { quality: 'draft' });
  assert.ok(qsv.join(' ').includes('-global_quality 28') && qsv.includes('nv12'), qsv.join(' '));
  const amf = VideoEncoder.videoArgs(gpu('amf'), { bitrateKbps: 3000, speed: 'quality' });
  assert.ok(amf.join(' ').includes('-quality quality -rc vbr_peak -b:v 3000k'), amf.join(' '));
});

test('Intel Mac VideoToolbox (sabit kalite yok): ölçüden bit hızı tahmin edilir', () => {
  const args = VideoEncoder.videoArgs(gpu('videotoolbox', 'h264', { qscale: false }), { width: 1080, height: 1920, fps: '60/1' });
  assert.ok(!args.includes('-q:v'));
  const b = Number(args[args.indexOf('-b:v') + 1].replace('k', ''));
  assert.ok(b > 8000 && b < 10000, `60 fps dikey ~9,3 Mbps (${b})`);
  assert.equal(VideoEncoder.tahminiBitHizi({ width: 160, height: 90 }), 1500, 'alt sınır');
});

test('donanım çözme: girdi önüne, çok parçalı projede kapalı', () => {
  const enc = gpu('videotoolbox', 'h264', { hwaccel: 'videotoolbox' });
  assert.deepEqual(VideoEncoder.inputArgs(enc), ['-hwaccel', 'videotoolbox']);
  assert.deepEqual(VideoEncoder.inputArgsFor(enc, 4), ['-hwaccel', 'videotoolbox']);
  assert.deepEqual(VideoEncoder.inputArgsFor(enc, 5), []);
  assert.deepEqual(VideoEncoder.adaylar('win32'), ['nvenc', 'qsv', 'amf']);
  assert.equal(VideoEncoder.cozmeYontemi('amf', 'win32'), 'd3d11va');
  assert.equal(VideoEncoder.cozmeYontemi('qsv', 'linux'), null);
});

test('kayıt çıktısı: kodlayıcı verilince GPU bayrakları ve çözme, verilmezse libx264', () => {
  const options = RecordingFinalizer.normalizeOutputOptions({});
  const main = { width: 1920, height: 1080, fps: '60/1', hasAudio: true, duration: 60 };
  const cpuArgs = RecordingFinalizer.buildArgs({ inputPath: 'k.ts', outputPath: 'o.mp4', main, options });
  assert.ok(cpuArgs.join(' ').includes('-c:v libx264 -preset veryfast -b:v 2500k -maxrate 2500k -bufsize 5000k'));
  assert.ok(!cpuArgs.includes('-hwaccel'));
  const enc = gpu('videotoolbox', 'h264', { hwaccel: 'videotoolbox' });
  const gpuArgs = RecordingFinalizer.buildArgs({ inputPath: 'k.ts', outputPath: 'o.mp4', introPath: 'i.mp4', main, intro: { hasAudio: true, duration: 3 }, options, encoder: enc });
  assert.equal(gpuArgs[gpuArgs.indexOf('k.ts') - 2], 'videotoolbox', 'kayıt girdisi GPU\'da çözülür');
  assert.equal(gpuArgs[gpuArgs.indexOf('i.mp4') - 2], 'videotoolbox', 'intro girdisi de');
  assert.ok(gpuArgs.includes('h264_videotoolbox') && !gpuArgs.includes('libx264'));
});

test('yedek: GPU işi hata verirse işlemciyle bir kez yeniden denenir; iptal ve zaman aşımı denenmez', async () => {
  VideoEncoder._reset();
  VideoEncoder._use('h264', gpu('videotoolbox'));
  const used: string[] = [];
  const r = await VideoEncoder.withFallback('h264', async (enc: { encoder: string; hw: boolean }) => {
    used.push(enc.encoder);
    if (enc.hw) throw new Error('compression session');
    return 'ok';
  });
  assert.equal(r, 'ok');
  assert.deepEqual(used, ['h264_videotoolbox', 'libx264']);

  used.length = 0;
  const iptal = Object.assign(new Error('İşlem durduruldu'), { signal: 'SIGKILL' });
  await assert.rejects(VideoEncoder.withFallback('h264', async (enc: { encoder: string }) => {
    used.push(enc.encoder);
    throw iptal;
  }), /durduruldu/);
  assert.deepEqual(used, ['h264_videotoolbox'], 'iptalde işlemciye düşülmez');

  used.length = 0;
  await assert.rejects(VideoEncoder.withFallback('h264', async (enc: { encoder: string }) => {
    used.push(enc.encoder);
    throw new Error('x');
  }, { canRetry: () => false }));
  assert.deepEqual(used, ['h264_videotoolbox'], 'canRetry false ise denenmez');
  VideoEncoder._reset();
});

test('yedek: üst üste 3 GPU hatasında kodek işlemciye sabitlenir, başarı sayacı sıfırlar', async () => {
  VideoEncoder._reset();
  VideoEncoder._use('h264', gpu('nvenc'));
  const fail = (enc: { hw: boolean }) => (enc.hw ? Promise.reject(new Error('OpenEncodeSessionEx failed')) : Promise.resolve());
  await VideoEncoder.withFallback('h264', fail);
  await VideoEncoder.withFallback('h264', fail);
  await VideoEncoder.withFallback('h264', async () => {}); // başarı → sayaç sıfır
  await VideoEncoder.withFallback('h264', fail);
  await VideoEncoder.withFallback('h264', fail);
  assert.equal((await VideoEncoder.select('h264')).hw, true, 'iki hata yetmez');
  await VideoEncoder.withFallback('h264', fail);
  assert.equal((await VideoEncoder.select('h264')).hw, false, 'üçüncü ardışık hatada işlemci');
  assert.equal(VideoEncoder.status().h264.hw, false);
  VideoEncoder._reset();
});

test('KESIT_VIDEO_ENCODER=cpu: GPU denenmez', async () => {
  VideoEncoder._reset();
  const eski = process.env.KESIT_VIDEO_ENCODER;
  process.env.KESIT_VIDEO_ENCODER = 'cpu';
  try {
    const enc = await VideoEncoder.select('h264');
    assert.equal(enc.hw, false);
    assert.equal(enc.encoder, 'libx264');
  } finally {
    if (eski === undefined) delete process.env.KESIT_VIDEO_ENCODER;
    else process.env.KESIT_VIDEO_ENCODER = eski;
    VideoEncoder._reset();
  }
});

test('ffmpeg: seçilen kodlayıcı (GPU ya da işlemci) oynatılabilir H.264/H.265 MP4 üretir', { skip: !hasFfmpeg && 'ffmpeg yok' }, async () => {
  VideoEncoder._reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-enc-'));
  try {
    for (const codec of ['h264', 'hevc']) {
      const enc = await VideoEncoder.select(codec);
      const out = path.join(dir, `${codec}.mp4`);
      for (const opts of [{}, { bitrateKbps: 1500 }]) {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=1', ...VideoEncoder.videoArgs(enc, opts), out]);
        const [name, pix] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'csv=p=0', out]).toString().trim().split(',');
        assert.equal(name, codec, `${enc.encoder} ${JSON.stringify(opts)}`);
        assert.ok(['yuv420p', 'nv12'].includes(pix), pix);
      }
      if (process.platform === 'darwin' && enc.hw) assert.equal(enc.hwaccel, 'videotoolbox');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    VideoEncoder._reset();
  }
});
