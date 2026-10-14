import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { config } from '../config.ts';
import { ClipEditorManager } from '../engine.ts';
import { badRequest } from '../http.ts';

const run = promisify(execFile);
const SAMPLE_MS = 2000;
/** Kesit'in çalıştırdığı araçlar — süreç listesinde bunlar gösterilir. */
const TOOL_NAMES = /ffmpeg|ffprobe|whisper|yt-dlp|streamlink/i;

export interface SystemProcess {
  pid: number;
  name: string;
  label: string;
  cpu: number;
  memBytes: number;
  elapsed: string;
  /** Kesit'in kendisi mi (sonlandırılamaz) */
  self: boolean;
}

export interface SystemReport {
  cpu: { percent: number; cores: number; load: number };
  memory: { total: number; used: number; percent: number };
  disk: { total: number; free: number; used: number; percent: number } | null;
  kesit: { pid: number; uptimeSec: number; memBytes: number; queue: { running: number; waiting: number; capacity: number } };
  processes: SystemProcess[];
  sampledAt: number;
}

interface CpuSnapshot {
  idle: number;
  total: number;
}

function cpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  return { idle, total };
}

/** `ps` çıktısındaki bir satırı ayrıştırır (saf fonksiyon; test edilir). */
export function parsePsLine(line: string): { pid: number; ppid: number; cpu: number; rssKb: number; elapsed: string; command: string } | null {
  // pcpu yerel ayara göre "0,0" ya da "0.0" yazılabilir.
  const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
  if (!m) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3].replace(',', '.')) || 0, rssKb: Number(m[4]), elapsed: m[5], command: m[6] };
}

/** Komut satırından kullanıcıya anlamlı etiket. */
export function describeCommand(command: string): { name: string; label: string } {
  const bin = command.split(/\s+/)[0].split('/').pop() || command;
  if (/ffmpeg/i.test(bin)) {
    if (/-progress pipe:1/.test(command) && /overlay|subtitles=/.test(command)) return { name: 'ffmpeg', label: 'Video dışa aktarılıyor' };
    if (/vstack|crop=/.test(command)) return { name: 'ffmpeg', label: 'Dikey video hazırlanıyor' };
    if (/-c copy/.test(command) && /\.ts\b|mpegts/.test(command)) return { name: 'ffmpeg', label: 'Yayın kaydediliyor' };
    if (/\.m3u8|https?:\/\//.test(command)) return { name: 'ffmpeg', label: 'Yayın indiriliyor' };
    if (/-frames:v 1/.test(command)) return { name: 'ffmpeg', label: 'Kare alınıyor' };
    if (/\.wav\b|pcm_s16le/.test(command)) return { name: 'ffmpeg', label: 'Ses ayrıştırılıyor' };
    return { name: 'ffmpeg', label: 'Video işleniyor' };
  }
  if (/ffprobe/i.test(bin)) return { name: 'ffprobe', label: 'Dosya inceleniyor' };
  if (/whisper/i.test(bin)) return { name: 'whisper', label: 'Konuşma yazıya dökülüyor' };
  if (/yt-dlp|streamlink/i.test(bin)) return { name: bin, label: 'Yayın indiriliyor' };
  return { name: bin, label: bin };
}

/**
 * Bilgisayarın ve Kesit'in çalıştırdığı süreçlerin anlık durumu —
 * işletim sisteminin görev yöneticisine benzer bir görünüm için.
 */
export class SystemMonitor {
  private last = cpuSnapshot();
  private percent = 0;
  private timer: NodeJS.Timeout | null = null;

  start() {
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private sample() {
    const now = cpuSnapshot();
    const dTotal = now.total - this.last.total;
    const dIdle = now.idle - this.last.idle;
    if (dTotal > 0) this.percent = Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)));
    this.last = now;
  }

  async report(): Promise<SystemReport> {
    const total = os.totalmem();
    const [disk, processes, available] = await Promise.all([this.disk(), this.processes(), this.availableMemory()]);
    const used = Math.max(0, total - available);
    return {
      cpu: { percent: this.percent, cores: os.cpus().length, load: Math.round((os.loadavg()[0] || 0) * 10) / 10 },
      memory: { total, used, percent: Math.round((used / total) * 100) },
      disk,
      kesit: { pid: process.pid, uptimeSec: Math.round(process.uptime()), memBytes: process.memoryUsage().rss, queue: ClipEditorManager.getQueueStatus() },
      processes,
      sampledAt: Date.now(),
    };
  }

  /** Yalnız Kesit'in başlattığı süreçler sonlandırılabilir. */
  async kill(pid: number) {
    const list = await this.processes();
    const target = list.find((p) => p.pid === pid);
    if (!target || target.self) throw badRequest('Bu süreç Kesit tarafından başlatılmadı');
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      throw badRequest('Süreç sonlandırılamadı');
    }
  }

  /**
   * Kullanılabilir bellek. macOS'ta os.freemem() yalnız boş sayfaları verir
   * (her zaman ~%0); vm_stat'taki boş + etkin olmayan + spekülatif sayfalar
   * gerçek "kullanılabilir" değere yakındır.
   */
  private async availableMemory(): Promise<number> {
    if (process.platform !== 'darwin') return os.freemem();
    try {
      const { stdout } = await run('vm_stat', [], { timeout: 3000 });
      const pageSize = Number(stdout.match(/page size of (\d+)/)?.[1]) || 16384;
      const pages = (label: string) => Number(stdout.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1]) || 0;
      return (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * pageSize;
    } catch {
      return os.freemem();
    }
  }

  private async disk() {
    try {
      const { stdout } = await run('df', ['-k', config.dataDir], { timeout: 5000 });
      const line = stdout.trim().split('\n').pop() || '';
      const parts = line.split(/\s+/);
      const totalKb = Number(parts[1]);
      const usedKb = Number(parts[2]);
      const freeKb = Number(parts[3]);
      if (!Number.isFinite(totalKb) || !totalKb) return null;
      return { total: totalKb * 1024, free: freeKb * 1024, used: usedKb * 1024, percent: Math.round((usedKb / totalKb) * 100) };
    } catch {
      return null;
    }
  }

  private async processes(): Promise<SystemProcess[]> {
    let stdout = '';
    try {
      ({ stdout } = await run('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,command='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }));
    } catch {
      return [];
    }
    const rows = stdout.split('\n').map(parsePsLine).filter((r): r is NonNullable<typeof r> => !!r);
    // Kesit'in alt süreçleri: ppid zinciri bu sürece ulaşanlar.
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const mine = new Set<number>([process.pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of rows) {
        if (!mine.has(r.pid) && mine.has(r.ppid)) {
          mine.add(r.pid);
          grew = true;
        }
      }
    }
    const out: SystemProcess[] = [];
    for (const pid of mine) {
      const r = byPid.get(pid);
      if (!r) continue;
      const isSelf = pid === process.pid;
      const helper = !isSelf && !TOOL_NAMES.test(r.command) && /node|tsx/.test(r.command);
      if (!isSelf && !helper && !TOOL_NAMES.test(r.command)) continue;
      const d = isSelf ? { name: 'kesit', label: 'Kesit sunucusu' } : helper ? { name: 'node', label: 'Kesit yardımcı süreci' } : describeCommand(r.command);
      // Yardımcı node süreçleri de Kesit'in parçasıdır; sonlandırılamaz.
      out.push({ pid, name: d.name, label: d.label, cpu: r.cpu, memBytes: r.rssKb * 1024, elapsed: r.elapsed, self: isSelf || helper });
    }
    return out.sort((a, b) => Number(b.self) - Number(a.self) || b.cpu - a.cpu);
  }
}
