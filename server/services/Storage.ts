import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import type { Store } from '../db/Store.ts';
import { ClipEditorManager } from '../engine.ts';
import { HttpError } from '../http.ts';
import type { Exporter } from './Exporter.ts';
import type { Workspaces } from './Workspaces.ts';

/** Kullanıcı klasöründeki önbellek alt dizinleri (silinince yeniden üretilir). */
const CACHE_DIRS = ['work', 'compressed', 'recording-work'];

async function sizeOf(target: string): Promise<number> {
  const stat = await fs.promises.lstat(target).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  const entries = await fs.promises.readdir(target).catch(() => [] as string[]);
  let total = 0;
  for (const e of entries) total += await sizeOf(path.join(target, e));
  return total;
}

async function userDirs(): Promise<string[]> {
  const names = await fs.promises.readdir(config.clipDir).catch(() => [] as string[]);
  return names.filter((n) => /^\d+$/.test(n)).map((n) => path.join(config.clipDir, n));
}

/** Bir kullanıcı klasöründeki önbellek dosyaları: iş dizinleri, sıkıştırılmış kopyalar, film şeritleri, örnek kareler. */
async function cachePaths(dir: string): Promise<string[]> {
  const out = CACHE_DIRS.map((d) => path.join(dir, d));
  for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    if (/^sample-.*\.jpg$|_upload_/.test(f)) out.push(path.join(dir, f));
  }
  const vodWork = path.join(dir, 'vod-work');
  for (const job of await fs.promises.readdir(vodWork).catch(() => [] as string[])) {
    out.push(path.join(vodWork, job, 'filmstrip'));
  }
  return out;
}

export interface StorageReport {
  total: number;
  categories: { id: string; label: string; hint: string; bytes: number; cleanable: boolean }[];
  exportDir: { path: string; bytes: number };
}

/**
 * Kesit'in bu bilgisayarda kapladığı yer ve temizleme işlemleri.
 * "Önbellek" yeniden üretilebilen ara dosyalardır; "üretilenler" klip,
 * kayıt ve indirilen yayın dosyalarıdır (arşiv kayıtları kalır).
 */
export class Storage {
  constructor(
    private store: Store,
    private workspaces: Workspaces,
    private vodScanner: any,
    private exporter: Exporter,
  ) {}

  async report(): Promise<StorageReport> {
    let videos = 0;
    let cache = 0;
    let brand = 0;
    for (const dir of await userDirs()) {
      videos += (await sizeOf(path.join(dir, 'vertical'))) + (await sizeOf(path.join(dir, 'recordings'))) + (await sizeOf(path.join(dir, 'harvest')));
      const vodWork = path.join(dir, 'vod-work');
      for (const job of await fs.promises.readdir(vodWork).catch(() => [] as string[])) {
        videos += await sizeOf(path.join(vodWork, job, 'vod.mp4'));
      }
      for (const p of await cachePaths(dir)) cache += await sizeOf(p);
      for (const f of ['logo.png', 'intro.mp4', 'outro.mp4']) brand += await sizeOf(path.join(dir, f));
    }
    const models = await sizeOf(path.join(config.dataDir, 'models'));
    const archive = await sizeOf(config.archiveDir);
    let db = 0;
    for (const f of ['kesit.db', 'kesit.db-wal', 'kesit.db-shm']) db += await sizeOf(path.join(config.dataDir, f));
    const categories = [
      { id: 'videos', label: 'Üretilen videolar ve kayıtlar', hint: 'Klipler, yayın kayıtları, indirilen yayınlar, takipten inen klipler', bytes: videos, cleanable: true },
      { id: 'cache', label: 'Önbellek', hint: 'Ara dosyalar, küçültülmüş kopyalar, film şeritleri — gerektiğinde yeniden oluşur', bytes: cache, cleanable: true },
      { id: 'models', label: 'Altyazı modeli', hint: 'Ayarlar\'dan kaldırılabilir', bytes: models, cleanable: false },
      { id: 'brand', label: 'Marka dosyaları', hint: 'Logo, intro, outro', bytes: brand, cleanable: false },
      { id: 'archive', label: 'Arşiv görselleri ve veritabanı', hint: 'Geçmiş kayıtları — silinmez', bytes: archive + db, cleanable: false },
    ];
    return {
      total: categories.reduce((s, c) => s + c.bytes, 0),
      categories,
      exportDir: { path: this.exporter.dir, bytes: await sizeOf(this.exporter.dir) },
    };
  }

  /** Önbelleği siler; süren iş varken ara dosyalar kullanımda olduğu için reddeder. */
  async clearCache() {
    const q = ClipEditorManager.getQueueStatus();
    if (q.running > 0 || q.waiting > 0) throw new HttpError(409, 'Süren klip işleri var — bitince tekrar dene');
    let freed = 0;
    for (const dir of await userDirs()) {
      for (const p of await cachePaths(dir)) {
        freed += await sizeOf(p);
        await fs.promises.rm(p, { recursive: true, force: true });
      }
    }
    return { freed };
  }

  /**
   * Kullanıcının üretilen tüm dosyalarını siler (klipler, kayıtlar,
   * indirilen yayınlar). Süren işlere dokunmaz. Arşivde "silindi" olarak kalır.
   */
  async clearVideos(userId: number) {
    const ws = await this.workspaces.get(userId);
    const before = (await this.report()).categories.find((c) => c.id === 'videos')!.bytes;
    let skipped = 0;
    for (const job of await this.store.getEditedClips(userId, 10_000)) {
      if (job.status === 'queued' || job.status === 'processing') skipped++;
      else await ws.clipEditor.remove(job.id);
    }
    const activeRec = ws.recorder.getStatus()?.id;
    for (const rec of await this.store.getStreamRecordings(userId, 10_000)) {
      const busy = rec.id === activeRec || rec.status === 'processing' || ws.finalizer.yuzde(rec.id) != null || ['uploading', 'publishing'].includes(rec.publish_status);
      if (busy) {
        skipped++;
        continue;
      }
      for (const f of [rec.file_path, rec.final_path]) if (f) fs.rmSync(f, { force: true });
      await this.store.deleteStreamRecording(rec.id, userId);
    }
    for (const job of await this.store.getVodScanJobs(userId, 10_000)) {
      if (['queued', 'processing', 'paused'].includes(job.status)) {
        skipped++;
        continue;
      }
      await this.vodScanner.remove(job.id, userId).catch(() => skipped++);
    }
    // Kanal klip takibinin indirdikleri: dosya silinir, satır "görüldü" kalır ki yeniden inmesin.
    for (const row of this.store.all("SELECT id, file_path FROM harvested_clips WHERE user_id = ? AND status = 'ready'", [userId])) {
      if (row.file_path) fs.rmSync(row.file_path, { force: true });
      this.store.run("UPDATE harvested_clips SET status = 'seen', file_path = NULL WHERE id = ?", [row.id]);
    }
    const after = (await this.report()).categories.find((c) => c.id === 'videos')!.bytes;
    return { freed: Math.max(0, before - after), skipped };
  }
}
