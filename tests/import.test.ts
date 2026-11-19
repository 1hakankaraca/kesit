import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyUrl, downloadToFile, driveConfirmUrl, driveFileId, driveHtmlError, fileNameFrom, isDriveFolder, mp4Args, titleFromName, toMp4 } from '../server/services/SnippetImport.ts';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456';

test('drive bağlantısı: paylaşım biçimlerinden dosya kimliği çıkar', () => {
  assert.equal(driveFileId(`https://drive.google.com/file/d/${ID}/view?usp=sharing`), ID);
  assert.equal(driveFileId(`https://drive.google.com/file/d/${ID}/view?usp=drive_link`), ID);
  assert.equal(driveFileId(`https://drive.google.com/open?id=${ID}`), ID);
  assert.equal(driveFileId(`https://drive.google.com/uc?id=${ID}&export=download`), ID);
  assert.equal(driveFileId(`https://drive.usercontent.google.com/download?id=${ID}&export=download`), ID);
  assert.equal(driveFileId(`https://docs.google.com/uc?export=download&id=${ID}`), ID);
  assert.equal(driveFileId('https://example.com/file/d/abc'), null, 'başka alan adı');
  assert.equal(driveFileId('drive.google.com/file/d/x'), null, 'şema yok');
  assert.ok(isDriveFolder('https://drive.google.com/drive/folders/1abcdefghijk?usp=sharing'));
  assert.ok(isDriveFolder('https://drive.google.com/drive/u/0/folders/1abcdefghijk'));
  assert.ok(!isDriveFolder(`https://drive.google.com/file/d/${ID}/view`));
});

test('bağlantı sınıflandırma: drive, doğrudan adres, yerel ağ ve klasör', () => {
  const d = classifyUrl(`  https://drive.google.com/file/d/${ID}/view  `);
  assert.equal(d.source, 'drive');
  assert.equal(d.driveId, ID);
  assert.ok(d.url.startsWith('https://drive.usercontent.google.com/download?id='), 'doğrudan indirme adresi');
  assert.ok(d.url.includes('confirm=t'));
  assert.equal(classifyUrl('https://cdn.example.com/video.mp4').source, 'url');
  assert.throws(() => classifyUrl(''), /boş/i);
  assert.throws(() => classifyUrl('ftp://x.com/a.mp4'), /http/);
  assert.throws(() => classifyUrl('http://localhost:3002/a.mp4'), /Yerel/);
  assert.throws(() => classifyUrl('http://192.168.1.5/a.mp4'), /Yerel/);
  assert.throws(() => classifyUrl('http://172.20.0.1/a.mp4'), /Yerel/);
  assert.throws(() => classifyUrl('https://drive.google.com/drive/folders/1abcdefghijk'), /klasör/);
  assert.throws(() => classifyUrl('https://drive.google.com/drive/my-drive'), /tanınmadı/);
  assert.throws(() => classifyUrl('bu bir bağlantı değil'), /Geçerli/);
});

test('drive uyarı sayfası: formdan onaylı indirme adresi çözülür', () => {
  const html = `<html><body><form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
    <input type="submit" value="Download anyway"/>
    <input type="hidden" name="id" value="${ID}"><input type="hidden" name="export" value="download">
    <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="9b1d-abc"></form></body></html>`;
  const u = new URL(driveConfirmUrl(html)!);
  assert.equal(u.origin + u.pathname, 'https://drive.usercontent.google.com/download');
  assert.equal(u.searchParams.get('id'), ID);
  assert.equal(u.searchParams.get('confirm'), 't');
  assert.equal(u.searchParams.get('uuid'), '9b1d-abc');
  assert.equal(driveConfirmUrl('<html><body>Sign in</body></html>'), null);
  assert.match(driveHtmlError('<title>Google Drive - Quota exceeded</title>'), /sınır/);
  assert.match(driveHtmlError('<a href="https://accounts.google.com/ServiceLogin">Sign in</a>'), /paylaşıma açık değil/);
});

test('dosya adı ve başlık: Content-Disposition ve adres yedeği', () => {
  assert.equal(fileNameFrom('attachment; filename="yayin_kesiti.mp4"; filename*=UTF-8\'\'yay%C4%B1n%20kesiti.mp4'), 'yayın kesiti.mp4', 'UTF-8 biçimi öncelikli');
  assert.equal(fileNameFrom('attachment; filename="a b.mov"'), 'a b.mov');
  assert.equal(fileNameFrom('attachment; filename=plain.mkv'), 'plain.mkv');
  assert.equal(fileNameFrom(undefined, 'https://x.com/dir/son%20video.mp4?x=1'), 'son video.mp4');
  assert.equal(fileNameFrom(undefined, 'bozuk'), '');
  assert.equal(titleFromName('bolum_12_final.MP4'), 'bolum 12 final');
  assert.equal(titleFromName('', 'Yedek'), 'Yedek');
});

test('mp4 çevirme: H.264+AAC yalnız kap değiştirir, diğerleri yeniden kodlanır', () => {
  const base = { hasVideo: true, format: 'matroska', duration: 10, width: 1920, height: 1080 };
  const copy = mp4Args({ ...base, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac' }, 'a.mkv', 'b.mp4');
  assert.ok(copy.copy);
  assert.ok(copy.args.includes('-c') && copy.args.includes('copy'));
  assert.ok(copy.args.includes('+faststart'));
  const silent = mp4Args({ ...base, hasAudio: false, videoCodec: 'h264', audioCodec: null }, 'a.mkv', 'b.mp4');
  assert.ok(silent.copy, 'sessiz H.264 de kopyalanır');
  assert.ok(!silent.args.includes('0:a:0'));
  const re = mp4Args({ ...base, hasAudio: true, videoCodec: 'vp9', audioCodec: 'opus' }, 'a.webm', 'b.mp4');
  assert.ok(!re.copy);
  assert.ok(re.args.includes('libx264') && re.args.includes('aac'));
  const mp3 = mp4Args({ ...base, hasAudio: true, videoCodec: 'h264', audioCodec: 'mp3' }, 'a.avi', 'b.mp4');
  assert.ok(!mp3.copy, 'MP3 ses yeniden kodlanır');
});

test('indirme: drive uyarı sayfası geçilir, dosya diske akar, ilerleme gelir', async () => {
  const body = Buffer.alloc(300_000, 7);
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    const u = new URL(req.url || '/', 'http://x');
    if (u.pathname === '/download' && u.searchParams.get('confirm') === 'ok' && u.searchParams.get('uuid') === 'u1') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length), 'content-disposition': 'attachment; filename="drive_video.mp4"' });
      res.end(body);
      return;
    }
    if (u.pathname === '/download') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body><form id="download-form" action="http://127.0.0.1:${(server.address() as { port: number }).port}/download" method="get"><input type="hidden" name="id" value="x"><input type="hidden" name="confirm" value="ok"><input type="hidden" name="uuid" value="u1"></form></body></html>`);
      return;
    }
    if (u.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>site</html>');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-import-'));
  try {
    const target = path.join(dir, 'a.bin');
    const ticks: number[] = [];
    const r = await downloadToFile(`http://127.0.0.1:${port}/download?id=x`, target, { isDrive: true, onProgress: (b, t) => ticks.push(t ? b / t : -1) });
    assert.equal(r.fileName, 'drive_video.mp4');
    assert.equal(r.bytes, body.length);
    assert.equal(fs.statSync(target).size, body.length);
    assert.equal(hits, 2, 'önce uyarı sayfası, sonra dosya');
    assert.equal(ticks.at(-1), 1, 'son ilerleme tam');
    await assert.rejects(downloadToFile(`http://127.0.0.1:${port}/page`, path.join(dir, 'b.bin'), {}), /web sayfası/);
    await assert.rejects(downloadToFile(`http://127.0.0.1:${port}/yok`, path.join(dir, 'c.bin'), {}), /404/);
    await assert.rejects(downloadToFile(`http://127.0.0.1:${port}/download?id=x`, path.join(dir, 'd.bin'), { isDrive: true, maxBytes: 1000 }), /sınırını/);
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(downloadToFile(`http://127.0.0.1:${port}/download?id=x`, path.join(dir, 'e.bin'), { isDrive: true, signal: ctl.signal }), /İptal/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mp4 çevirme (ffmpeg): MKV kopyalanır, MPEG-4/MP3 AVI yeniden kodlanır', { skip: !hasFfmpeg && 'ffmpeg yok' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-mp4-'));
  try {
    const mkv = path.join(dir, 'kaynak.mkv');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mkv]);
    const out1 = path.join(dir, 'a.mp4');
    const info1 = await toMp4(mkv, out1);
    assert.equal(info1.videoCodec, 'h264');
    assert.ok(fs.statSync(out1).size > 1000);
    assert.ok(Math.abs(info1.duration - 2) < 0.3);

    const avi = path.join(dir, 'eski.avi');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'mpeg4', '-c:a', 'libmp3lame', '-shortest', avi]);
    const out2 = path.join(dir, 'b.mp4');
    const info2 = await toMp4(avi, out2);
    assert.equal(info2.videoCodec, 'mpeg4');
    const codecs = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out2]).toString().trim().split('\n');
    assert.deepEqual(codecs, ['h264', 'aac'], 'tarayıcı uyumlu MP4');

    const txt = path.join(dir, 'metin.bin');
    fs.writeFileSync(txt, 'bu bir video değil');
    await assert.rejects(toMp4(txt, path.join(dir, 'c.mp4')), /video/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
