import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
 */
export function runFfmpeg(args: string[], { totalSec, onProgress }: { totalSec: number; onProgress?: (pct: number) => void }): FfmpegRun {
  const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let buf = '';
  proc.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const m = line.match(/^out_time_us=(\d+)/) || line.match(/^out_time_ms=(\d+)/);
      if (m && totalSec > 0) onProgress?.(Math.min(99, Math.floor((Number(m[1]) / 1_000_000 / totalSec) * 100)));
    }
  });
  proc.stderr!.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-4000);
  });
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', (err) => reject(new Error(`ffmpeg çalıştırılamadı: ${err.message}`)));
    proc.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else if (signal || code === null) reject(new Error('İşlem durduruldu'));
      else reject(new Error(stderr.trim().split('\n').pop()?.slice(0, 300) || `ffmpeg kodu ${code}`));
    });
  });
  return { proc, done };
}
