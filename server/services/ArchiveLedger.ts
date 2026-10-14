import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import type { ArchiveHooks, Row, Store } from '../db/Store.ts';

type Kind = 'clip' | 'recording' | 'vod';

export interface ArchiveEntry {
  id: number;
  kind: Kind;
  refId: number;
  title: string;
  channelSlug: string | null;
  source: string | null;
  format: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  thumbUrl: string | null;
  publishStatus: string | null;
  platforms: { platform: string; status: string }[];
  publishedAt: string | null;
  producedAt: string;
  deletedAt: string | null;
  /** Kaynak dosya hâlâ diskte mi (yalnız okunurken hesaplanır). */
  fileAvailable: boolean;
}

const READY_CLIP = new Set(['ready']);
const READY_RECORDING = new Set(['ready', 'completed']);

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** `/clips/<uid>/...?v=1` biçimindeki adresi diskteki yola çevirir. */
function clipUrlToPath(url: string | null | undefined): string | null {
  if (!url?.startsWith('/clips/')) return null;
  const rel = decodeURIComponent(url.slice('/clips/'.length).split('?')[0]);
  const full = path.resolve(config.clipDir, rel);
  return full.startsWith(config.clipDir + path.sep) ? full : null;
}

/**
 * Arşiv defteri: üretilen her klip, kayıt ve indirilen yayın için kalıcı bir
 * satır tutar. Kaynak satır ya da dosya silinince satır silinmez, yalnız
 * `deleted_at` işaretlenir; küçük görsel ayrı bir arşiv dizinine kopyalandığı
 * için silinmiş içerik de geçmişte görsel olarak tanınır.
 */
export class ArchiveLedger implements ArchiveHooks {
  constructor(private store: Store) {}

  /* ── Kancalar (Store çağırır) ─────────────────────────────────────────── */

  clipChanged(row: Row) {
    if (!READY_CLIP.has(row.status) && !this.exists(row.user_id, 'clip', row.id)) return;
    const options = parseJson<{ outputFormat?: string }>(row.options, {});
    this.upsert(row.user_id, 'clip', row.id, {
      title: row.gen_title || row.title || `Klip #${row.id}`,
      channel_slug: row.channel_slug || null,
      source: row.source || null,
      format: options.outputFormat === 'horizontal' ? 'horizontal' : 'vertical',
      duration_sec: row.duration || null,
      size_bytes: row.file_size_bytes || null,
      publish_status: row.publish_status || null,
      publish_platforms: row.publish_platforms || null,
      published_at: row.published_at || null,
    });
    this.keepThumb(row.user_id, 'clip', row.id, clipUrlToPath(row.thumbnail_url));
  }

  clipDeleted(userId: number, id: number) {
    this.markDeleted(userId, 'clip', id);
  }

  recordingChanged(row: Row) {
    if (!READY_RECORDING.has(row.status) && !this.exists(row.user_id, 'recording', row.id)) return;
    const final = row.final_status === 'ready';
    this.upsert(row.user_id, 'recording', row.id, {
      title: row.title || `Yayın kaydı #${row.id}`,
      channel_slug: row.channel_slug || null,
      source: 'live',
      format: 'horizontal',
      duration_sec: row.duration_sec || null,
      size_bytes: (final ? row.final_size : row.file_size) || null,
      publish_status: row.publish_status || null,
      publish_platforms: row.publish_status ? JSON.stringify([{ platform: 'youtube', status: row.publish_status }]) : null,
      published_at: row.published_at || null,
    });
    const video = final ? row.final_path : row.file_path;
    if (video && !this.thumbPath(row.user_id, 'recording', row.id, true)) this.grabFrame(row.user_id, row.id, video);
  }

  recordingDeleted(userId: number, id: number) {
    this.markDeleted(userId, 'recording', id);
  }

  vodChanged(row: Row) {
    if (row.status === 'expired') {
      this.markDeleted(row.user_id, 'vod', row.id);
      return;
    }
    this.upsert(row.user_id, 'vod', row.id, {
      title: row.title || `Geçmiş yayın #${row.source_video_id}`,
      channel_slug: row.channel_slug || null,
      source: row.from_live ? 'live' : 'vod',
      format: 'horizontal',
      duration_sec: row.duration_sec || null,
      size_bytes: row.vod_file_size_bytes || null,
      publish_status: null,
      publish_platforms: null,
      published_at: null,
    });
  }

  vodDeleted(userId: number, id: number) {
    this.markDeleted(userId, 'vod', id);
  }

  /* ── Okuma ─────────────────────────────────────────────────────────────── */

  list(userId: number, { from, to, kind, q }: { from?: string; to?: string; kind?: Kind; q?: string } = {}): ArchiveEntry[] {
    const where = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (from) {
      where.push('produced_at >= ?');
      params.push(from);
    }
    if (to) {
      where.push('produced_at < ?');
      params.push(to);
    }
    if (kind) {
      where.push('kind = ?');
      params.push(kind);
    }
    if (q) {
      where.push("(title LIKE ? ESCAPE '\\' OR channel_slug LIKE ? ESCAPE '\\')");
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    const rows = this.store.all(
      `SELECT * FROM archive_entries WHERE ${where.join(' AND ')} ORDER BY produced_at DESC LIMIT 500`,
      params,
    );
    return rows.map((r) => this.toEntry(r));
  }

  /** Günlük üretim/paylaşım sayıları — arşivin ısı şeridi için. */
  dailyCounts(userId: number, days = 120) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.store.all(
      `SELECT substr(produced_at, 1, 10) AS day, COUNT(*) AS produced,
              SUM(CASE WHEN publish_status IN ('published', 'scheduled', 'partial') THEN 1 ELSE 0 END) AS shared,
              SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted
         FROM archive_entries WHERE user_id = ? AND produced_at >= ?
        GROUP BY day ORDER BY day`,
      [userId, since],
    );
  }

  thumbFile(userId: number, entryId: number): string | null {
    const row = this.store.get('SELECT kind, ref_id FROM archive_entries WHERE id = ? AND user_id = ?', [entryId, userId]);
    return row ? this.thumbPath(userId, row.kind, row.ref_id, true) : null;
  }

  /* ── İç işler ──────────────────────────────────────────────────────────── */

  private toEntry(r: Row): ArchiveEntry {
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? null);
    return {
      id: r.id,
      kind: r.kind,
      refId: r.ref_id,
      title: r.title || '',
      channelSlug: r.channel_slug,
      source: r.source,
      format: r.format,
      durationSec: r.duration_sec,
      sizeBytes: r.size_bytes,
      thumbUrl: r.thumb_path ? `/api/archive/${r.id}/thumb` : null,
      publishStatus: r.publish_status,
      platforms: parseJson(r.publish_platforms, []),
      publishedAt: iso(r.published_at),
      producedAt: iso(r.produced_at)!,
      deletedAt: iso(r.deleted_at),
      fileAvailable: !r.deleted_at && this.sourceExists(r),
    };
  }

  private sourceExists(r: Row): boolean {
    if (r.kind === 'clip') {
      return fs.existsSync(path.join(config.clipDir, String(r.user_id), 'vertical', `${r.ref_id}.mp4`));
    }
    if (r.kind === 'recording') {
      const rec = this.store.get('SELECT file_path, final_path FROM stream_recordings WHERE id = ?', [r.ref_id]);
      return !!rec && [rec.final_path, rec.file_path].some((p) => p && fs.existsSync(p));
    }
    const vod = this.store.get('SELECT vod_path FROM vod_scan_jobs WHERE id = ?', [r.ref_id]);
    return !!vod?.vod_path && fs.existsSync(vod.vod_path);
  }

  private exists(userId: number, kind: Kind, refId: number) {
    return !!this.store.get('SELECT 1 FROM archive_entries WHERE user_id = ? AND kind = ? AND ref_id = ?', [userId, kind, refId]);
  }

  private upsert(userId: number, kind: Kind, refId: number, f: Row) {
    this.store.run(
      `INSERT INTO archive_entries (user_id, kind, ref_id, title, channel_slug, source, format, duration_sec, size_bytes,
         publish_status, publish_platforms, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, kind, ref_id) DO UPDATE SET
         title = excluded.title, channel_slug = excluded.channel_slug, source = excluded.source,
         format = excluded.format, duration_sec = COALESCE(excluded.duration_sec, duration_sec),
         size_bytes = COALESCE(excluded.size_bytes, size_bytes),
         publish_status = COALESCE(excluded.publish_status, publish_status),
         publish_platforms = COALESCE(excluded.publish_platforms, publish_platforms),
         published_at = COALESCE(excluded.published_at, published_at)`,
      [userId, kind, refId, f.title, f.channel_slug, f.source, f.format, f.duration_sec, f.size_bytes,
        f.publish_status, f.publish_platforms, f.published_at],
    );
  }

  private markDeleted(userId: number, kind: Kind, refId: number) {
    this.store.run(
      "UPDATE archive_entries SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ? AND kind = ? AND ref_id = ? AND deleted_at IS NULL",
      [userId, kind, refId],
    );
  }

  private thumbPath(userId: number, kind: Kind, refId: number, mustExist = false): string | null {
    const p = path.join(config.archiveDir, String(userId), `${kind}-${refId}.jpg`);
    return !mustExist || fs.existsSync(p) ? p : null;
  }

  private setThumb(userId: number, kind: Kind, refId: number, file: string) {
    this.store.run('UPDATE archive_entries SET thumb_path = ? WHERE user_id = ? AND kind = ? AND ref_id = ?', [file, userId, kind, refId]);
  }

  /** Klibin küçük görselini arşive kopyalar — klip silinse de görsel kalır. */
  private keepThumb(userId: number, kind: Kind, refId: number, source: string | null) {
    if (!source || !fs.existsSync(source)) return;
    const target = this.thumbPath(userId, kind, refId)!;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      this.setThumb(userId, kind, refId, target);
    } catch (err) {
      console.warn(`[Arşiv] Küçük görsel kopyalanamadı (${kind} #${refId}):`, (err as Error).message);
    }
  }

  /** Kayıt videosundan tek kare alır (arka planda, hata olursa sessizce geçer). */
  private grabFrame(userId: number, refId: number, video: string) {
    if (!fs.existsSync(video)) return;
    const target = this.thumbPath(userId, 'recording', refId)!;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFile(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-ss', '20', '-i', video, '-frames:v', '1', '-vf', 'scale=480:-2', '-y', target],
      { timeout: 60_000 },
      (err) => {
        if (!err && fs.existsSync(target)) this.setThumb(userId, 'recording', refId, target);
      },
    );
  }
}
