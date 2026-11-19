import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface MediaInfo {
  duration: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Tek kare mi (görsel) */
  isImage: boolean;
}

/** ffprobe ile süre, çözünürlük ve akış bilgisi. */
export async function probe(file: string): Promise<MediaInfo> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,nb_frames,duration:format=duration,format_name', '-of', 'json', file], { timeout: 30_000 });
  const info = JSON.parse(stdout || '{}');
  const streams: any[] = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const formatName = String(info.format?.format_name || '');
  const duration = Number(info.format?.duration) || Number(video?.duration) || Number(audio?.duration) || 0;
  const isImage = !!video && !audio && (/image2|png_pipe|mjpeg|webp|gif/.test(formatName) || (Number(video.nb_frames) === 1 && duration < 0.2));
  return {
    duration: isImage ? 0 : duration,
    width: video?.width ? Number(video.width) : null,
    height: video?.height ? Number(video.height) : null,
    hasVideo: !!video,
    hasAudio: !!audio,
    isImage,
  };
}

/** Videodan tek kare (jpg) ya da görselden küçük kopya. */
export async function thumbnail(source: string, target: string, { at = 1, width = 480 }: { at?: number; width?: number } = {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, at)), '-i', source, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', target], { timeout: 30_000 });
  return fs.existsSync(target);
}

export interface FfmpegRun {
  proc: ChildProcess;
  done: Promise<void>;
}

/**
 * ffmpeg'i ilerleme raporuyla çalıştırır. `-progress pipe:1` satırlarından
 * out_time okunur, toplam süreye oranı onProgress'e yüzde olarak verilir.
 * `feed` verilirse ffmpeg'in standart girdisi açılır ve ona yazılır (ör.
 * `-i pipe:0` ile okunan ham sohbet kareleri); besleme hata verirse işlem
 * o hatayla sonlanır.
 *
 * `stallSec` verilirse ilerleme o kadar saniye hiç değişmezse işlem öldürülür
 * ve "takıldı" hatasıyla biter. Bu hata iptal sayılmaz; kodlayıcı yedeği
 * (VideoEncoder.withFallback) işi işlemciyle yeniden dener. Apple
 * VideoToolbox ara sıra %0 işlemciyle sonsuza dek bekliyor; ilerleme hiç
 * gelmeden de takılabildiği için sayaç baştan işler.
 */
export function runFfmpeg(args: string[], { totalSec, onProgress, feed, stallSec = 0 }: { totalSec: number; onProgress?: (pct: number) => void; feed?: (stdin: Writable) => Promise<void>; stallSec?: number }): FfmpegRun {
  const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', ...args], { stdio: [feed ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let feedError: Error | null = null;
  let stalled = false;
  let lastProgress = Date.now();
  let lastOut = -1;
  const watchdog =
    stallSec > 0
      ? setInterval(() => {
          if (Date.now() - lastProgress > stallSec * 1000) {
            stalled = true;
            proc.kill('SIGKILL');
          }
        }, Math.min(5000, Math.max(250, (stallSec * 1000) / 4))).unref()
      : null;
  if (feed && proc.stdin) {
    // ffmpeg çıktıyı bitirince girdiyi kapatır; sonrasında yazma hatası (EPIPE) beklenen durumdur.
    proc.stdin.on('error', () => {});
    feed(proc.stdin).catch((err: Error) => {
      feedError = err;
      proc.kill('SIGKILL');
    });
  }
  let buf = '';
  proc.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const m = line.match(/^out_time_us=(\d+)/) || line.match(/^out_time_ms=(\d+)/);
      if (m && Number(m[1]) !== lastOut) {
        lastOut = Number(m[1]);
        lastProgress = Date.now();
      }
      if (m && totalSec > 0) onProgress?.(Math.min(99, Math.floor((Number(m[1]) / 1_000_000 / totalSec) * 100)));
    }
  });
  proc.stderr!.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-4000);
  });
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', (err) => reject(new Error(`ffmpeg çalıştırılamadı: ${err.message}`)));
    proc.on('exit', (code, signal) => {
      if (watchdog) clearInterval(watchdog);
      if (feedError) reject(feedError);
      else if (code === 0) resolve();
      // Takılma: iptal değil, kodlayıcı hatası sayılır (işlemciyle yeniden denenir).
      else if (stalled) reject(new Error(`Kodlayıcı takıldı — ${stallSec} sn boyunca ilerleme olmadı`));
      // signal: iptal — kodlayıcı yedeği (VideoEncoder.withFallback) yeniden denemesin
      else if (signal || code === null) reject(Object.assign(new Error('İşlem durduruldu'), { signal: signal || 'SIGKILL' }));
      else reject(new Error(stderr.trim().split('\n').pop()?.slice(0, 300) || `ffmpeg kodu ${code}`));
    });
  });
  return { proc, done };
}
