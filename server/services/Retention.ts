import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import type { Store } from '../db/Store.ts';
import { ClipEditorManager } from '../engine.ts';

const SWEEP_MS = 60 * 60_000;
/** Ara dosyalar (kesit kopyaları, iş dizinleri) bu kadar eskiyse silinir. */
const STALE_MS = 24 * 60 * 60_000;
/** vod-work içinde korunan dosyalar: yayının kendisi ve film şeridi. */
const KEEP_IN_VOD = new Set(['vod.mp4', 'filmstrip']);

/**
 * Saklama: indirilen yayınlar 7 gün sonra silinir (arşivde "süresi doldu"
 * olarak kalır); klip işine aktarılmış kesit kopyaları ve yarım kalmış iş
 * dizinleri 1 gün sonra temizlenir. Süren klip işi varken ara dosyalara
 * dokunulmaz.
 */
export class Retention {
  private timer: NodeJS.Timeout | null = null;

  constructor(private store: Store) {}

  start() {
    const first = setTimeout(() => void this.sweep(), 60_000);
    first.unref();
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep() {
    let freed = 0;
    try {
      freed += await this.expireVods();
      const q = ClipEditorManager.getQueueStatus();
      if (q.running === 0 && q.waiting === 0) freed += await this.removeStaleWork();
    } catch (err) {
      console.warn('[Saklama] Temizlik hatası:', (err as Error).message);
    }
    if (freed > 0) console.log(`[Saklama] ${Math.round(freed / 1048576)} MB temizlendi`);
    return freed;
  }

  /** Saklama süresi dolan yayın indirmeleri. */
  private async expireVods() {
    let freed = 0;
    for (const job of await this.store.getExpiredVodDownloads(new Date())) {
      if (job.vod_path) {
        const dir = path.dirname(job.vod_path);
        freed += sizeOf(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      await this.store.updateVodScanJob(job.id, job.user_id, { status: 'expired' });
    }
    return freed;
  }

  /** Eski ara dosyalar: vod-work kesit kopyaları, work/ ve recording-work/ dizinleri. */
  private async removeStaleWork() {
    let freed = 0;
    const cutoff = Date.now() - STALE_MS;
    const old = (p: string) => {
      try {
        return fs.statSync(p).mtimeMs < cutoff;
      } catch {
        return false;
      }
    };
    const drop = (p: string) => {
      freed += sizeOf(p);
      fs.rmSync(p, { recursive: true, force: true });
    };
    const hourAgo = Date.now() - 60 * 60_000;
    for (const user of list(config.clipDir).filter((n) => /^\d+$/.test(n))) {
      const base = path.join(config.clipDir, user);
      for (const job of list(path.join(base, 'vod-work'))) {
        const dir = path.join(base, 'vod-work', job);
        // Başarısız / iptal edilmiş / silinmiş işlerin klasörü 1 saat sonra tamamen gider.
        const row = this.store.get('SELECT status FROM vod_scan_jobs WHERE id = ?', [Number(job)]);
        if (!row || ['failed', 'cancelled', 'expired'].includes(row.status)) {
          try {
            if (fs.statSync(dir).mtimeMs < hourAgo) drop(dir);
          } catch {
            /* yok */
          }
          continue;
        }
        for (const f of list(dir)) if (!KEEP_IN_VOD.has(f) && old(path.join(dir, f))) drop(path.join(dir, f));
      }
      for (const sub of ['work', 'recording-work']) {
        for (const entry of list(path.join(base, sub))) {
          const p = path.join(base, sub, entry);
          if (old(p)) drop(p);
        }
      }
    }
    return freed;
  }
}

function list(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function sizeOf(p: string): number {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    return list(p).reduce((sum, e) => sum + sizeOf(path.join(p, e)), 0);
  } catch {
    return 0;
  }
}
