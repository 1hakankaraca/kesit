// Paketle gelecek ffmpeg/ffprobe ikililerini desktop/bin'e kopyalar.
// Derleme hangi işletim sisteminde yapılıyorsa o platformun ikilisi alınır
// (GitHub Actions'ta macOS ve Windows ayrı koşucularda derlenir).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const out = path.resolve(import.meta.dirname, '..', 'bin');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const ext = process.platform === 'win32' ? '.exe' : '';
const sources = {
  [`ffmpeg${ext}`]: require('ffmpeg-static'),
  [`ffprobe${ext}`]: require('ffprobe-static').path,
};

for (const [name, src] of Object.entries(sources)) {
  if (!src || !fs.existsSync(src)) throw new Error(`${name} bulunamadı: ${src}`);
  const dest = path.join(out, name);
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  console.log(`${name} ← ${src} (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
}
