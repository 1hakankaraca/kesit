import { FORMAT_SIZE, NEUTRAL_COLOR, projectDuration, sourceSpan, type Clip, type Project } from '../../shared/project.ts';

/** Bir klibin dışa aktarmada kullanılacak kaynağı. */
export interface ClipSource {
  file: string;
  kind: 'video' | 'image' | 'audio';
  hasAudio: boolean;
}

export interface RenderPlan {
  args: string[];
  filterGraph: string;
  totalSec: number;
  width: number;
  height: number;
  warnings: string[];
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** atempo tek başına 0.5–2 arası çalışır; dışındaki hızlar zincirlenir. */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 0.001) out.push(`atempo=${f(s)}`);
  return out;
}
const f = (v: number) => (Math.round(v * 10000) / 10000).toString();
const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:');

/**
 * Projeden ffmpeg komutu kurar (saf fonksiyon; test edilebilir).
 *
 * Görsel katmanlar alttan üste `overlay` ile dikilir; her klip kendi girdisi
 * olarak kaynak zamanından (-ss/-t) okunur ve setpts ile zaman çizelgesindeki
 * yerine kaydırılır. Sesler adelay + amix ile tek kanala karıştırılır.
 * Altyazı varsa en üste basılır.
 */
export function buildRenderPlan(
  project: Project,
  resolve: (clip: Clip) => ClipSource | null,
  { output, assPath = null }: { output: string; assPath?: string | null },
): RenderPlan {
  const { w: W, h: H } = FORMAT_SIZE[project.format];
  const totalSec = Math.max(0.5, projectDuration(project));
  const warnings: string[] = [];
  const hidden = new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id));
  const mutedTracks = new Set(project.tracks.filter((t) => t.muted).map((t) => t.id));
  const trackIndex = new Map(project.tracks.map((t, i) => [t.id, i]));

  const args: string[] = ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${project.fps}:d=${f(totalSec)}`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
  let inputIndex = 2;
  const filters: string[] = [];
  const audioLabels: string[] = [];

  const ordered = [...project.clips].sort((a, b) => (trackIndex.get(a.trackId) ?? 0) - (trackIndex.get(b.trackId) ?? 0) || a.start - b.start);
  const baseTrack = project.tracks.find((t) => t.kind === 'video')?.id;
  let last = '0:v';
  let k = 0;

  for (const clip of ordered) {
    if (hidden.has(clip.trackId)) continue;
    const src = resolve(clip);
    if (!src) {
      warnings.push(`${clip.kind === 'text' ? 'Yazı' : 'Klip'} ${clip.id} kaynağı bulunamadı, atlandı`);
      continue;
    }
    const end = clip.start + clip.duration;
    const n = inputIndex++;
    const visual = src.kind !== 'audio';
    const speed = src.kind === 'image' ? 1 : clip.speed || 1;
    const fadeIn = Math.min(clip.fadeIn, clip.duration / 2);
    const fadeOut = Math.min(clip.fadeOut, clip.duration / 2);

    if (src.kind === 'image') args.push('-loop', '1', '-framerate', String(project.fps), '-t', f(clip.duration), '-i', src.file);
    else args.push('-ss', f(clip.in), '-t', f(sourceSpan({ duration: clip.duration, speed })), '-i', src.file);

    if (visual) {
      k++;
      const fw = even(clip.frame.w * W);
      const fh = even(clip.frame.h * H);
      const chain: string[] = [speed === 1 ? `setpts=PTS-STARTPTS+${f(clip.start)}/TB` : `setpts=(PTS-STARTPTS)/${f(speed)}+${f(clip.start)}/TB`];
      if (clip.crop.w < 0.999 || clip.crop.h < 0.999 || clip.crop.x > 0.001 || clip.crop.y > 0.001) {
        chain.push(`crop=iw*${f(clip.crop.w)}:ih*${f(clip.crop.h)}:iw*${f(clip.crop.x)}:ih*${f(clip.crop.y)}`);
      }
      chain.push(`scale=${fw}:${fh}:flags=lanczos`);
      const c = clip.color;
      if (c.brightness !== NEUTRAL_COLOR.brightness || c.contrast !== NEUTRAL_COLOR.contrast || c.saturation !== NEUTRAL_COLOR.saturation) {
        chain.push(`eq=brightness=${f(c.brightness)}:contrast=${f(c.contrast)}:saturation=${f(c.saturation)}`);
      }
      if (c.hue) chain.push(`hue=h=${f(c.hue)}`);
      if (src.kind === 'image') chain.push('format=rgba');
      // Ana yoldaki parça siyaha, üst katmanlar saydama doğru yumuşar.
      const alphaFade = clip.trackId !== baseTrack;
      if ((fadeIn > 0 || fadeOut > 0) && alphaFade && src.kind !== 'image') chain.push('format=yuva420p');
      if (fadeIn > 0) chain.push(`fade=t=in:st=${f(clip.start)}:d=${f(fadeIn)}${alphaFade ? ':alpha=1' : ''}`);
      if (fadeOut > 0) chain.push(`fade=t=out:st=${f(end - fadeOut)}:d=${f(fadeOut)}${alphaFade ? ':alpha=1' : ''}`);
      if (clip.opacity < 0.999) {
        if (src.kind !== 'image' && !(alphaFade && (fadeIn > 0 || fadeOut > 0))) chain.push('format=yuva420p');
        chain.push(`colorchannelmixer=aa=${f(clip.opacity)}`);
      }
      filters.push(`[${n}:v]${chain.join(',')}[v${k}]`);
      const x = Math.round(clip.frame.x * W);
      const y = Math.round(clip.frame.y * H);
      filters.push(`[${last}][v${k}]overlay=${x}:${y}:enable='between(t,${f(clip.start)},${f(end)})':eof_action=pass[o${k}]`);
      last = `o${k}`;
    }

    const audible = src.hasAudio && !clip.muted && clip.volume > 0 && !mutedTracks.has(clip.trackId);
    if (audible) {
      const label = `a${audioLabels.length + 1}`;
      const delay = Math.round(clip.start * 1000);
      const achain = ['asetpts=PTS-STARTPTS', ...atempoChain(speed), `volume=${f(clip.volume)}`];
      if (fadeIn > 0) achain.push(`afade=t=in:st=0:d=${f(fadeIn)}`);
      if (fadeOut > 0) achain.push(`afade=t=out:st=${f(clip.duration - fadeOut)}:d=${f(fadeOut)}`);
      achain.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo', `adelay=${delay}:all=1`);
      filters.push(`[${n}:a]${achain.join(',')}[${label}]`);
      audioLabels.push(label);
    }
  }

  filters.push(`[1:a]atrim=0:${f(totalSec)}[abase]`);
  if (audioLabels.length) {
    filters.push(`[abase]${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length + 1}:normalize=0:duration=first:dropout_transition=0[outa]`);
  } else {
    filters.push('[abase]anull[outa]');
  }

  if (assPath) {
    filters.push(`[${last}]subtitles=filename='${esc(assPath)}'[outv]`);
  } else {
    filters.push(`[${last}]null[outv]`);
  }

  const filterGraph = filters.join(';');
  args.push(
    '-filter_complex', filterGraph,
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(project.fps),
    '-c:a', 'aac', '-b:a', '160k',
    '-t', f(totalSec),
    '-movflags', '+faststart',
    '-y', output,
  );
  return { args, filterGraph, totalSec, width: W, height: H, warnings };
}
