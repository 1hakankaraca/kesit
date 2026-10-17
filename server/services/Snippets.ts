import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Server as IOServer } from 'socket.io';
import { config } from '../config.ts';
import type { Row, Store } from '../db/Store.ts';
import { StreamRecorder, VodSegmentFollower } from '../engine.ts';
import { badRequest, notFound } from '../http.ts';
import type { Workspaces } from './Workspaces.ts';

export const SNIPPET_SECONDS = [30, 60, 90, 120, 180] as const;

/** Kick'in süren yayın kaydı canlıdan ~30 sn geride gelir; o kadar beklenir. */
const PLAYLIST_LAG_NOTE = 'Yayın kaydı canlıdan yarım dakika kadar geride gelir; kesit birkaç saniye içinde iner.';

interface Active {
  follower: { abort(): unknown } | null;
  cancelled: boolean;
}

/**
 * Kesitler: Canlı'daki anlık klip düğmesi sohbete komut yazmak yerine yayının
 * son N saniyesini Kick'in süren yayın kaydından alır, ham olarak saklar ve
 * istenirse dikey videoya çevirir. Liste "Kesitler" bölümünde görünür.
 */
export class Snippets {
  private active = new Map<number, Active>();

  constructor(
    private store: Store,
    private io: IOServer,
    private workspaces: Workspaces,
    private vodScanner: any,
  ) {}

  list(userId: number) {
    return this.store.all('SELECT * FROM snippets WHERE user_id = ? ORDER BY id DESC LIMIT 200', [userId]).map((r) => this.toSnippet(r));
  }

  get(userId: number, id: number) {
    const row = this.store.get('SELECT * FROM snippets WHERE id = ? AND user_id = ?', [id, userId]);
    return row ? this.toSnippet(row) : null;
  }

  /** Yayının son `seconds` saniyesini kesit olarak almaya başlar; satır hemen döner, indirme arkada sürer. */
  async capture(userId: number, channel: string, seconds: number, { autoEdit = true } = {}) {
    if (!SNIPPET_SECONDS.includes(seconds as (typeof SNIPPET_SECONDS)[number])) throw badRequest('Geçersiz süre');
    const video = await this.vodScanner.fetcher.getLiveVideo(channel).catch(() => null);
    if (!video) throw badRequest(`"${channel}" şu anda yayında değil ya da yayın kaydı kapalı`);
    const untilMs = Date.now();
    const title = `${channel} · son ${seconds} sn · ${new Date(untilMs).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`;
    const res = this.store.run('INSERT INTO snippets (user_id, channel_slug, title, seconds, status) VALUES (?, ?, ?, ?, ?)', [userId, channel, title, seconds, 'downloading']);
    const id = Number(res.lastInsertRowid);
    const state: Active = { follower: null, cancelled: false };
    this.active.set(id, state);
    this.emit(userId);
    void this.download(userId, id, video, seconds, untilMs, autoEdit, state);
    return { snippet: this.get(userId, id)!, note: PLAYLIST_LAG_NOTE };
  }

  cancel(userId: number, id: number) {
    const row = this.store.get('SELECT * FROM snippets WHERE id = ? AND user_id = ?', [id, userId]);
    if (!row) throw notFound('Kesit bulunamadı');
    const state = this.active.get(id);
    if (!state) return false;
    state.cancelled = true;
    state.follower?.abort();
    return true;
  }

  async remove(userId: number, id: number) {
    const row = this.store.get('SELECT * FROM snippets WHERE id = ? AND user_id = ?', [id, userId]);
    if (!row) return false;
    this.cancel(userId, id);
    for (const f of [row.file_path, row.thumb_path]) if (f) fs.rmSync(f, { force: true });
    this.store.run('DELETE FROM snippets WHERE id = ?', [id]);
    this.emit(userId);
    return true;
  }

  /** Hazır kesiti dikey videoya çevirir (Galeri'ye düşer). */
  async edit(userId: number, id: number) {
    const row = this.store.get('SELECT * FROM snippets WHERE id = ? AND user_id = ?', [id, userId]);
    if (!row) throw notFound('Kesit bulunamadı');
    if (row.status !== 'ready' || !row.file_path || !fs.existsSync(row.file_path)) throw badRequest('Kesit henüz hazır değil');
    const ws = await this.workspaces.get(userId);
    const job = await ws.clipEditor.enqueueLocalClip(row.file_path, { title: row.title || 'Kesit', source: 'quick', group: 'live', channelSlug: row.channel_slug });
    this.store.run('UPDATE snippets SET job_id = ? WHERE id = ?', [job.id, id]);
    this.emit(userId);
    return job;
  }

  private dir(userId: number) {
    return path.join(config.clipDir, String(userId), 'snippets');
  }

  private async download(userId: number, id: number, video: any, seconds: number, untilMs: number, autoEdit: boolean, state: Active) {
    const dir = this.dir(userId);
    const ts = path.join(dir, `${id}.ts`);
    const whole = path.join(dir, `${id}_full.mp4`);
    const mp4 = path.join(dir, `${id}.mp4`);
    const thumb = path.join(dir, `${id}_thumb.jpg`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const baseMs = Date.parse(String(video.startedAt || '').replace(' ', 'T') + 'Z');
      if (!Number.isFinite(baseMs)) throw new Error('Yayının başlangıç saati okunamadı');
      const fetcher = this.vodScanner.fetcher;
      let playlistUrl = video.sourceUrl;
      for (const q of ['1080p', '720p', '480p', '360p']) {
        playlistUrl = await fetcher.resolveVariantUrl(video.sourceUrl, q);
        if (playlistUrl !== video.sourceUrl) break;
      }
      if (playlistUrl === video.sourceUrl) throw new Error('Yayın kaydının parça listesi çözülemedi');
      if (state.cancelled) throw new Error('İptal edildi');

      // Parçalar ~12 sn; istenen aralığı kapsayan parçalar inince dosya kapanır.
      const follower = new VodSegmentFollower({ playlistUrl, outputPath: ts, baseMs, fromMs: untilMs - seconds * 1000, untilMs });
      state.follower = follower;
      const result = await follower.start();
      state.follower = null;
      if (state.cancelled || result.reason === 'aborted') throw new Error('İptal edildi');
      if (result.reason === 'error') throw new Error(result.error || 'Yayın kaydı okunamadı');
      if (follower.bytes === 0) throw new Error('Yayın kaydında bu aralık bulunamadı');

      await StreamRecorder.mp4eSarmala(ts, whole);
      fs.rmSync(ts, { force: true });
      // Parça sınırları yüzünden fazlası gelir: yalnız son N saniye bırakılır.
      const total: number = (await StreamRecorder.sureOku(whole)) || 0;
      if (total > seconds + 1.5) {
        await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', (total - seconds).toFixed(2), '-i', whole, '-c', 'copy', '-avoid_negative_ts', 'make_zero', mp4]);
        fs.rmSync(whole, { force: true });
      } else fs.renameSync(whole, mp4);
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1', '-i', mp4, '-frames:v', '1', '-vf', 'scale=480:-2', thumb]).catch(() => {});
      const duration = (await StreamRecorder.sureOku(mp4)) || seconds;
      this.store.run("UPDATE snippets SET status = 'ready', file_path = ?, file_size = ?, duration_sec = ?, thumb_path = ? WHERE id = ?", [
        mp4, fs.statSync(mp4).size, Math.round(duration), fs.existsSync(thumb) ? thumb : null, id,
      ]);
      this.emit(userId);
      if (autoEdit) await this.edit(userId, id).catch((err) => console.warn(`[Kesitler ${userId}] Dikey üretim başlatılamadı:`, (err as Error).message));
    } catch (err) {
      for (const f of [ts, whole, mp4, thumb]) fs.rmSync(f, { force: true });
      const cancelled = state.cancelled;
      if (cancelled) this.store.run('DELETE FROM snippets WHERE id = ?', [id]);
      else this.store.run("UPDATE snippets SET status = 'failed', error = ? WHERE id = ?", [(err as Error).message.slice(0, 300), id]);
      this.emit(userId);
    } finally {
      this.active.delete(id);
    }
  }

  private emit(userId: number) {
    this.io.to(`user:${userId}`).emit('snippet:update', { snippets: this.list(userId) });
  }

  private toSnippet(r: Row) {
    const available = !!r.file_path && fs.existsSync(r.file_path);
    const base = `/clips/${r.user_id}/snippets`;
    return {
      id: r.id as number,
      channel: r.channel_slug as string,
      title: r.title as string,
      seconds: r.seconds as number,
      status: r.status as 'downloading' | 'ready' | 'failed',
      error: r.error as string | null,
      sizeBytes: r.file_size as number | null,
      durationSec: r.duration_sec as number | null,
      jobId: r.job_id as number | null,
      videoUrl: available ? `${base}/${r.id}.mp4` : null,
      thumbUrl: r.thumb_path && fs.existsSync(r.thumb_path) ? `${base}/${r.id}_thumb.jpg` : null,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    };
  }
}

export type Snippet = ReturnType<Snippets['toSnippet']>;

function run(bin: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(bin, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(`${bin} hatası: ${String(stderr || err.message).slice(0, 300)}`));
      else resolve();
    });
  });
}
