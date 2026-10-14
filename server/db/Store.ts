import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { seal, unseal } from '../lib/secrets.ts';
import { MIGRATIONS } from './schema.ts';

export type Row = Record<string, any>;

/** Okurken boolean'a çevrilecek kolonlar (SQLite 0/1 tutar, motor true/false bekler). */
const BOOLEAN_COLUMNS = new Set(['subtitles', 'from_live', 'auto_edit_clips']);
/** Okurken Date'e çevrilecek zaman kolonları — motor bazılarında getTime() çağırır. */
const isDateColumn = (key: string) => key.endsWith('_at') || key === 'scheduled_for';

/** Güncellenebilir kolon beyaz listeleri — dış kaynaklı anahtarlarla SQL kurulmasını önler. */
const EDITED_CLIP_COLUMNS = new Set([
  'status', 'step', 'error', 'video_url', 'thumbnail_url', 'duration', 'layout', 'transcript', 'highlights',
  'title', 'qc', 'gen_title', 'gen_description', 'gen_hashtags', 'qc_verdict', 'qc_issues', 'publish_status',
  'publish_post_id', 'publish_started_at', 'scheduled_for', 'publish_timezone', 'publish_platforms',
  'published_at', 'options', 'viral_score', 'viral_reason', 'file_size_bytes',
]);
const VOD_SCAN_JOB_COLUMNS = new Set([
  'status', 'step', 'progress', 'error', 'duration_sec', 'clips_created', 'segments_created', 'completed_at',
  'vod_path', 'vod_file_size_bytes', 'downloaded_at', 'vod_expires_at', 'transcript_language',
]);
const STREAM_RECORDING_COLUMNS = new Set([
  'status', 'title', 'quality', 'file_path', 'file_size', 'duration_sec', 'error', 'completed_at',
  'final_status', 'final_path', 'final_size', 'final_error', 'publish_status', 'publish_post_id',
  'publish_account_id', 'publish_title', 'publish_content', 'publish_visibility', 'publish_url',
  'publish_error', 'published_at',
]);
const SETTINGS_COLUMNS = new Set([
  'auto_edit_clips', 'clip_defaults', 'clip_next_publish_at', 'subtitle_style', 'brand_color', 'accent_color',
  'language', 'zernio_profile_id', 'zernio_profile_name', 'recording_output', 'autopilot', 'channel_tabs',
]);
const MANUAL_CLIP_COLUMNS = new Set(['status', 'error', 'edited_clip_id']);

const EDITED_CLIP_LIST_COLUMNS =
  'id, user_id, source, source_clip_id, title, channel_slug, view_count, status, step, error, video_url, ' +
  'thumbnail_url, duration, layout, qc, gen_title, gen_description, gen_hashtags, qc_verdict, qc_issues, ' +
  'publish_status, publish_post_id, scheduled_for, publish_timezone, publish_platforms, published_at, ' +
  'viral_score, viral_reason, subtitles, options, file_size_bytes, vod_scan_job_id, created_at';

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function toSql(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value as SQLInputValue;
}

function fromSql<T extends Row | undefined>(row: T): T {
  if (!row) return row;
  const out: Row = { ...row };
  for (const [key, value] of Object.entries(out)) {
    if (BOOLEAN_COLUMNS.has(key) && typeof value === 'number') out[key] = value === 1;
    else if (isDateColumn(key) && typeof value === 'string') out[key] = new Date(value);
  }
  return out as T;
}

export interface ArchiveHooks {
  clipChanged(row: Row): void;
  clipDeleted(userId: number, id: number): void;
  recordingChanged(row: Row): void;
  recordingDeleted(userId: number, id: number): void;
  vodChanged(row: Row): void;
  vodDeleted(userId: number, id: number): void;
}

/**
 * Kesit'in tek veri erişim noktası. Klip motoru LivoBot'un Database sınıfıyla
 * aynı imzalı async metotları çağırır; bu sınıf onları SQLite üzerinde
 * karşılar. Arşiv defteri kancaları (ArchiveHooks) üretim/silme anlarında
 * çağrılır ki dosya silinse bile geçmiş görülebilsin.
 */
export class Store {
  readonly sql: DatabaseSync;
  private archive: ArchiveHooks | null = null;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  setArchiveHooks(hooks: ArchiveHooks) {
    this.archive = hooks;
  }

  private migrate() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const done = new Set(this.all('SELECT id FROM schema_migrations').map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      this.sql.exec('BEGIN');
      try {
        this.sql.exec(m.sql);
        this.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [m.id, new Date()]);
        this.sql.exec('COMMIT');
      } catch (err) {
        this.sql.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /* ── Düşük seviye yardımcılar ─────────────────────────────────────────── */

  all(query: string, params: unknown[] = []): Row[] {
    return this.sql.prepare(query).all(...params.map(toSql)).map((r) => fromSql(r as Row));
  }

  get(query: string, params: unknown[] = []): Row | null {
    return fromSql(this.sql.prepare(query).get(...params.map(toSql)) as Row | undefined) ?? null;
  }

  run(query: string, params: unknown[] = []) {
    return this.sql.prepare(query).run(...params.map(toSql));
  }

  /** Beyaz listedeki kolonlarla `SET a = ?, b = ?` kurar; geçerli anahtar yoksa null. */
  private setClause(data: Row, allowed: Set<string>) {
    const keys = Object.keys(data).filter((k) => allowed.has(k));
    if (!keys.length) return null;
    return { sql: keys.map((k) => `${k} = ?`).join(', '), values: keys.map((k) => data[k]) };
  }

  /* ── Kullanıcılar ve oturumlar ────────────────────────────────────────── */

  upsertKickUser(u: { kickUserId: string; username: string; avatarUrl: string | null; channelSlug: string | null }) {
    const existing = this.get('SELECT * FROM users WHERE kick_user_id = ?', [u.kickUserId]);
    if (existing) {
      this.run(`UPDATE users SET username = ?, avatar_url = ?, channel_slug = COALESCE(channel_slug, ?), last_seen_at = ${NOW_SQL} WHERE id = ?`, [
        u.username, u.avatarUrl, u.channelSlug, existing.id,
      ]);
      return this.getUser(existing.id)!;
    }
    const res = this.run('INSERT INTO users (kind, kick_user_id, username, avatar_url, channel_slug) VALUES (?, ?, ?, ?, ?)', [
      'kick', u.kickUserId, u.username, u.avatarUrl, u.channelSlug,
    ]);
    return this.getUser(Number(res.lastInsertRowid))!;
  }

  createGuestUser(username: string) {
    const res = this.run('INSERT INTO users (kind, username) VALUES (?, ?)', ['guest', username]);
    return this.getUser(Number(res.lastInsertRowid))!;
  }

  getUser(id: number) {
    return this.get('SELECT * FROM users WHERE id = ?', [id]);
  }

  setUserChannel(id: number, channelSlug: string | null) {
    this.run('UPDATE users SET channel_slug = ? WHERE id = ?', [channelSlug, id]);
  }

  /** Yayın takibi açık kullanıcılar — sunucu açılışında nöbetçiler yeniden kurulur. */
  getAutopilotUsers(): Row[] {
    return this.all("SELECT user_id, autopilot FROM user_settings WHERE autopilot LIKE '%\"enabled\":true%'");
  }

  createSession(id: string, userId: number, expiresAt: Date) {
    this.run('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', [id, userId, expiresAt]);
  }

  getSessionUser(id: string) {
    const row = this.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ${NOW_SQL}`, [id]);
    if (row) this.run(`UPDATE users SET last_seen_at = ${NOW_SQL} WHERE id = ?`, [row.id]);
    return row;
  }

  deleteSession(id: string) {
    this.run('DELETE FROM sessions WHERE id = ?', [id]);
  }

  purgeExpiredSessions() {
    this.run(`DELETE FROM sessions WHERE expires_at <= ${NOW_SQL}`);
  }

  /* ── Uygulama ayarları (bilgisayar geneli) ────────────────────────────── */

  getAppSetting(key: string, { secret = false } = {}): string | null {
    const row = this.get('SELECT value FROM app_settings WHERE key = ?', [key]);
    if (!row?.value) return null;
    return secret ? unseal(row.value) : row.value;
  }

  setAppSetting(key: string, value: string | null, { secret = false } = {}) {
    if (value === null) {
      this.run('DELETE FROM app_settings WHERE key = ?', [key]);
      return;
    }
    this.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ${NOW_SQL})
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, secret ? seal(value) : value],
    );
  }

  /* ── Ayarlar ──────────────────────────────────────────────────────────── */

  async getSettings(userId: number): Promise<Row> {
    this.run('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)', [userId]);
    const row = this.get('SELECT * FROM user_settings WHERE user_id = ?', [userId])!;
    // Motor açık anahtarı `zernio_api_key` adıyla okur; şifreli kolon dışarı verilmez.
    const { zernio_api_key_enc, ...rest } = row;
    return { ...rest, zernio_api_key: unseal(zernio_api_key_enc) };
  }

  async updateSettings(userId: number, data: Row) {
    await this.getSettings(userId);
    const set = this.setClause(data, SETTINGS_COLUMNS);
    if (!set) return;
    this.run(`UPDATE user_settings SET ${set.sql} WHERE user_id = ?`, [...set.values, userId]);
  }

  setZernioConnection(userId: number, conn: { apiKey: string; profileId: string; profileName: string } | null) {
    this.run('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)', [userId]);
    this.run('UPDATE user_settings SET zernio_api_key_enc = ?, zernio_profile_id = ?, zernio_profile_name = ? WHERE user_id = ?', [
      conn ? seal(conn.apiKey) : null, conn?.profileId ?? null, conn?.profileName ?? null, userId,
    ]);
  }

  /* ── Düzenlenmiş klipler ──────────────────────────────────────────────── */

  async addEditedClip(userId: number, data: Row) {
    const res = this.run(
      `INSERT INTO edited_clips (user_id, source, source_clip_id, source_url, title, channel_slug, view_count,
         subtitles, options, vod_scan_job_id, viral_score, viral_reason, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
      [
        userId, data.source || 'popular', data.sourceClipId || null, data.sourceUrl || null, data.title || '',
        data.channelSlug || '', data.viewCount || 0, data.subtitles !== false,
        data.options ? JSON.stringify(data.options) : null, data.vodScanJobId || null,
        data.viralScore ?? null, data.viralReason || null,
      ],
    );
    return this.get('SELECT * FROM edited_clips WHERE id = ?', [res.lastInsertRowid]);
  }

  async getEditedClips(userId: number, limit = 50) {
    return this.all(`SELECT ${EDITED_CLIP_LIST_COLUMNS} FROM edited_clips WHERE user_id = ? ORDER BY id DESC LIMIT ?`, [userId, limit]);
  }

  async getEditedClipsByVodJob(vodScanJobId: number, userId: number) {
    return this.all(`SELECT ${EDITED_CLIP_LIST_COLUMNS} FROM edited_clips WHERE vod_scan_job_id = ? AND user_id = ? ORDER BY id DESC`, [
      vodScanJobId, userId,
    ]);
  }

  async getEditedClipById(id: number, userId: number) {
    return this.get('SELECT * FROM edited_clips WHERE id = ? AND user_id = ?', [id, userId]);
  }

  /** Paylaşım takvimi: önce yaklaşan planlar, sonra en yeni gönderiler. */
  async getPublishQueue(userId: number, limit = 100) {
    return this.all(
      `SELECT ${EDITED_CLIP_LIST_COLUMNS}, publish_started_at FROM edited_clips
        WHERE user_id = ? AND publish_status IS NOT NULL
        ORDER BY
          CASE WHEN scheduled_for > ${NOW_SQL} THEN 0 ELSE 1 END,
          CASE WHEN scheduled_for > ${NOW_SQL} THEN scheduled_for END,
          COALESCE(published_at, scheduled_for, created_at) DESC,
          id DESC
        LIMIT ?`,
      [userId, limit],
    );
  }

  /** Dış paylaşım için tek kazananlı atomik claim (bkz. LivoBot Database.claimEditedClipForPublish). */
  async claimEditedClipForPublish(id: number, userId: number) {
    const res = this.run(
      `UPDATE edited_clips
          SET publish_status = 'publishing', publish_post_id = NULL, publish_started_at = ${NOW_SQL},
              scheduled_for = NULL, publish_timezone = NULL, publish_platforms = NULL, published_at = NULL
        WHERE id = ? AND user_id = ? AND status = 'ready' AND (publish_status IS NULL OR publish_status = 'failed')`,
      [id, userId],
    );
    return res.changes ? this.getEditedClipById(id, userId) : null;
  }

  async updateEditedClip(id: number, userId: number, data: Row) {
    const set = this.setClause(data, EDITED_CLIP_COLUMNS);
    if (!set) return;
    this.run(`UPDATE edited_clips SET ${set.sql} WHERE id = ? AND user_id = ?`, [...set.values, id, userId]);
    if ('status' in data || 'publish_status' in data || 'title' in data || 'gen_title' in data) {
      const row = await this.getEditedClipById(id, userId);
      if (row) this.archive?.clipChanged(row);
    }
  }

  async deleteEditedClip(id: number, userId: number) {
    this.run('DELETE FROM edited_clips WHERE id = ? AND user_id = ?', [id, userId]);
    this.archive?.clipDeleted(userId, id);
  }

  async getPendingEditedClips(userId: number) {
    return this.all(
      "SELECT id, source_url, source, title FROM edited_clips WHERE user_id = ? AND status IN ('queued', 'processing') ORDER BY id ASC",
      [userId],
    );
  }

  async getEditedClipsBySourceIds(userId: number, sourceClipIds: string[]) {
    const map = new Map<string, { id: number; status: string }>();
    if (!sourceClipIds?.length) return map;
    const marks = sourceClipIds.map(() => '?').join(', ');
    const rows = this.all(
      `SELECT id, source_clip_id, status FROM edited_clips WHERE user_id = ? AND source_clip_id IN (${marks}) ORDER BY id ASC`,
      [userId, ...sourceClipIds.map(String)],
    );
    for (const row of rows) map.set(row.source_clip_id, { id: row.id, status: row.status });
    return map;
  }

  /* ── VOD taraması ─────────────────────────────────────────────────────── */

  async createVodScanJob(userId: number, data: Row) {
    const res = this.run(
      `INSERT INTO vod_scan_jobs (user_id, channel_slug, source, source_video_id, title, duration_sec, options,
         max_clips, thumbnail_url, from_live, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
      [
        userId, data.channelSlug || '', data.source || 'kick', String(data.sourceVideoId), data.title || '',
        data.durationSec || 0, data.options ? JSON.stringify(data.options) : null, data.maxClips || 8,
        data.thumbnailUrl || null, data.fromLive === true,
      ],
    );
    return this.get('SELECT * FROM vod_scan_jobs WHERE id = ?', [res.lastInsertRowid]);
  }

  async updateVodScanJob(id: number, userId: number, data: Row) {
    const set = this.setClause(data, VOD_SCAN_JOB_COLUMNS);
    if (!set) return;
    this.run(`UPDATE vod_scan_jobs SET ${set.sql} WHERE id = ? AND user_id = ?`, [...set.values, id, userId]);
    if (data.status === 'downloaded' || data.status === 'expired') {
      const row = await this.getVodScanJobById(id, userId);
      if (row) this.archive?.vodChanged(row);
    }
  }

  async getVodScanJobById(id: number, userId: number) {
    return this.get('SELECT * FROM vod_scan_jobs WHERE id = ? AND user_id = ?', [id, userId]);
  }

  async getVodScanJobs(userId: number, limit = 20) {
    return this.all('SELECT * FROM vod_scan_jobs WHERE user_id = ? ORDER BY id DESC LIMIT ?', [userId, limit]);
  }

  async deleteVodScanJob(id: number, userId: number) {
    this.run('DELETE FROM vod_scan_jobs WHERE id = ? AND user_id = ?', [id, userId]);
    this.archive?.vodDeleted(userId, id);
  }

  async getPendingVodScanJobs(userId: number) {
    return this.all("SELECT * FROM vod_scan_jobs WHERE user_id = ? AND status IN ('queued', 'processing') ORDER BY id ASC", [userId]);
  }

  async getExpiredVodDownloads(now = new Date()) {
    return this.all("SELECT * FROM vod_scan_jobs WHERE status = 'downloaded' AND vod_expires_at IS NOT NULL AND vod_expires_at < ?", [now]);
  }

  async addVodHighlight(vodScanJobId: number, d: Row) {
    const res = this.run('INSERT INTO vod_highlights (vod_scan_job_id, start_sec, end_sec, score, kind, reason) VALUES (?, ?, ?, ?, ?, ?)', [
      vodScanJobId, d.startSec, d.endSec, d.score || null, d.kind || null, d.reason || null,
    ]);
    return this.get('SELECT * FROM vod_highlights WHERE id = ?', [res.lastInsertRowid]);
  }

  async linkVodHighlightClip(id: number, editedClipId: number) {
    this.run('UPDATE vod_highlights SET edited_clip_id = ? WHERE id = ?', [editedClipId, id]);
  }

  async getVodHighlights(vodScanJobId: number) {
    return this.all('SELECT * FROM vod_highlights WHERE vod_scan_job_id = ? ORDER BY start_sec ASC', [vodScanJobId]);
  }

  async addVodSegment(vodScanJobId: number, d: Row) {
    const res = this.run('INSERT INTO vod_segments (vod_scan_job_id, label, start_sec, end_sec, score, reason) VALUES (?, ?, ?, ?, ?, ?)', [
      vodScanJobId, d.label, d.startSec, d.endSec, d.score ?? null, d.reason || null,
    ]);
    return this.get('SELECT * FROM vod_segments WHERE id = ?', [res.lastInsertRowid]);
  }

  async linkVodSegmentClip(id: number, editedClipId: number) {
    this.run('UPDATE vod_segments SET edited_clip_id = ? WHERE id = ?', [editedClipId, id]);
  }

  async getVodSegments(vodScanJobId: number) {
    return this.all('SELECT * FROM vod_segments WHERE vod_scan_job_id = ? ORDER BY start_sec ASC', [vodScanJobId]);
  }

  async addVodManualClip(vodScanJobId: number, d: Row) {
    const res = this.run(
      "INSERT INTO vod_manual_clips (vod_scan_job_id, label, color, start_sec, end_sec, status) VALUES (?, ?, ?, ?, ?, COALESCE(?, 'queued'))",
      [vodScanJobId, d.label || null, d.color || null, d.startSec, d.endSec, d.status || null],
    );
    return this.get('SELECT * FROM vod_manual_clips WHERE id = ?', [res.lastInsertRowid]);
  }

  async updateVodManualClip(id: number, data: Row) {
    const set = this.setClause(data, MANUAL_CLIP_COLUMNS);
    if (!set) return;
    this.run(`UPDATE vod_manual_clips SET ${set.sql} WHERE id = ?`, [...set.values, id]);
  }

  async getVodManualClips(vodScanJobId: number) {
    return this.all('SELECT * FROM vod_manual_clips WHERE vod_scan_job_id = ? ORDER BY start_sec ASC', [vodScanJobId]);
  }

  /* ── Canlı kayıtlar ───────────────────────────────────────────────────── */

  async createStreamRecording(p: { userId: number; channelSlug: string; title?: string; quality?: string; status?: string; startedAt?: Date | string | null }) {
    const res = this.run(
      `INSERT INTO stream_recordings (user_id, channel_slug, title, quality, status, started_at)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, ${NOW_SQL}))`,
      [p.userId, p.channelSlug, p.title || '', p.quality || null, p.status || 'recording', p.startedAt ?? null],
    );
    return this.get('SELECT * FROM stream_recordings WHERE id = ?', [res.lastInsertRowid]);
  }

  async updateStreamRecording(id: number, userId: number, data: Row) {
    const set = this.setClause(data, STREAM_RECORDING_COLUMNS);
    if (!set) return null;
    this.run(`UPDATE stream_recordings SET ${set.sql} WHERE id = ? AND user_id = ?`, [...set.values, id, userId]);
    const row = await this.getStreamRecordingById(id, userId);
    if (row && ('status' in data || 'final_status' in data || 'publish_status' in data)) this.archive?.recordingChanged(row);
    return row;
  }

  async getStreamRecordings(userId: number, limit = 50) {
    return this.all('SELECT * FROM stream_recordings WHERE user_id = ? ORDER BY id DESC LIMIT ?', [userId, limit]);
  }

  async getStreamRecordingById(id: number, userId: number) {
    return this.get('SELECT * FROM stream_recordings WHERE id = ? AND user_id = ?', [id, userId]);
  }

  async deleteStreamRecording(id: number, userId: number) {
    this.run('DELETE FROM stream_recordings WHERE id = ? AND user_id = ?', [id, userId]);
    this.archive?.recordingDeleted(userId, id);
  }
}
