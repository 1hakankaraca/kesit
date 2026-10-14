import fs from 'node:fs';
import path from 'node:path';
import type { Server as IOServer } from 'socket.io';
import { config } from '../config.ts';
import type { Row, Store } from '../db/Store.ts';
import { KickClipFetcher } from '../engine.ts';
import { badRequest } from '../http.ts';
import { normalizeSlug } from '../lib/kick.ts';
import type { Workspaces } from './Workspaces.ts';

const POLL_MS = Math.max(60_000, Number(process.env.CLIP_HARVEST_SECONDS) * 1000 || 3 * 60_000);

export interface HarvestConfig {
  enabled: boolean;
  channel: string | null;
  /** İnen klip ayrıca dikey videoya çevrilsin mi. */
  autoEdit: boolean;
  /** Takibin başladığı an; yalnız bundan sonra eklenen klipler indirilir. */
  since: string | null;
}

export function normalizeHarvest(raw: unknown): HarvestConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<HarvestConfig>;
  return {
    enabled: r.enabled === true,
    channel: typeof r.channel === 'string' ? normalizeSlug(r.channel) : null,
    autoEdit: r.autoEdit === true,
    since: typeof r.since === 'string' && !Number.isNaN(Date.parse(r.since)) ? r.since : null,
  };
}

function parse(value: unknown) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

/**
 * Kanal klip takibi: yayıncının Kick'teki kliplerini arka planda yoklar,
 * takip başladıktan sonra eklenen her yeni klibi bu bilgisayara indirir
 * (istenirse dikey videoya da çevirir). Takipten önceki klipler yalnız
 * "görüldü" işaretlenir — geçmiş klipler toplu indirilmez.
 */
export class ClipHarvester {
  private timers = new Map<number, NodeJS.Timeout>();
  private running = new Set<number>();
  private fetcher = new KickClipFetcher();

  constructor(
    private store: Store,
    private io: IOServer,
    private workspaces: Workspaces,
  ) {}

  restore() {
    for (const row of this.store.getHarvestUsers()) {
      const cfg = normalizeHarvest(parse(row.clip_harvest));
      if (cfg.enabled && cfg.channel) this.schedule(row.user_id, 0);
    }
  }

  async getConfig(userId: number) {
    return normalizeHarvest(parse((await this.store.getSettings(userId)).clip_harvest));
  }

  async update(userId: number, raw: unknown) {
    const cfg = normalizeHarvest(raw);
    if (cfg.enabled && !cfg.channel) throw badRequest('Takip edilecek kanalı seç');
    const before = await this.getConfig(userId);
    // Takip açıldığında ya da kanal değiştiğinde sayaç sıfırlanır: geçmiş klipler indirilmez.
    const restarted = cfg.enabled && (!before.enabled || cfg.channel !== before.channel);
    cfg.since = restarted ? new Date().toISOString() : (before.since ?? new Date().toISOString());
    await this.store.updateSettings(userId, { clip_harvest: JSON.stringify(cfg) });
    this.stop(userId);
    if (cfg.enabled) this.schedule(userId, 0);
    return this.state(userId);
  }

  /** Dinleme başlayınca çağrılır: kanalı takibe alır (zaten takipteyse dokunmaz). */
  async follow(userId: number, channel: string, autoEdit: boolean) {
    const cfg = await this.getConfig(userId);
    if (cfg.enabled && cfg.channel === channel && cfg.autoEdit === autoEdit) return;
    await this.update(userId, { ...cfg, enabled: true, channel, autoEdit });
  }

  /** Dinleme bitince takibi kapatır; indirilenler yerinde kalır. */
  async unfollow(userId: number) {
    const cfg = await this.getConfig(userId);
    if (cfg.enabled) await this.update(userId, { ...cfg, enabled: false });
  }

  async state(userId: number) {
    return {
      config: await this.getConfig(userId),
      clips: this.list(userId),
      pollSeconds: Math.round(POLL_MS / 1000),
    };
  }

  list(userId: number) {
    return this.store
      .all("SELECT * FROM harvested_clips WHERE user_id = ? AND status != 'seen' ORDER BY id DESC LIMIT 100", [userId])
      .map((r) => this.toClip(r));
  }

  async remove(userId: number, id: number) {
    const row = this.store.get('SELECT * FROM harvested_clips WHERE id = ? AND user_id = ?', [id, userId]);
    if (!row) return false;
    if (row.file_path) fs.rmSync(row.file_path, { force: true });
    // Satır "görüldü" olarak kalır ki aynı klip yeniden indirilmesin.
    this.store.run("UPDATE harvested_clips SET status = 'seen', file_path = NULL WHERE id = ?", [id]);
    return true;
  }

  /** İndirilen klibi dikey videoya çevirir (Kütüphane'ye düşer). */
  async edit(userId: number, id: number) {
    const row = this.store.get('SELECT * FROM harvested_clips WHERE id = ? AND user_id = ?', [id, userId]);
    if (!row) throw badRequest('Klip bulunamadı');
    const ws = await this.workspaces.get(userId);
    const job = await ws.clipEditor.enqueueKickClip(row.clip_id, { title: row.title || '', channelSlug: row.channel_slug, source: 'popular', group: 'gezgin' });
    this.store.run('UPDATE harvested_clips SET job_id = ? WHERE id = ?', [job.id, id]);
    return job;
  }

  stopAll() {
    for (const id of this.timers.keys()) this.stop(id);
  }

  private stop(userId: number) {
    const t = this.timers.get(userId);
    if (t) clearTimeout(t);
    this.timers.delete(userId);
  }

  private schedule(userId: number, delay: number) {
    this.stop(userId);
    const t = setTimeout(() => void this.tick(userId), delay);
    t.unref?.();
    this.timers.set(userId, t);
  }

  private async tick(userId: number) {
    const cfg = await this.getConfig(userId);
    if (!cfg.enabled || !cfg.channel) return;
    if (this.running.has(userId)) return this.schedule(userId, POLL_MS);
    this.running.add(userId);
    try {
      const page = await this.fetcher.browseClips(cfg.channel, { sort: 'date', time: 'day' });
      const clips: Row[] = page?.clips ?? [];
      const known = new Set(this.store.all('SELECT clip_id FROM harvested_clips WHERE user_id = ?', [userId]).map((r) => r.clip_id));
      const since = Date.parse(cfg.since ?? new Date().toISOString());
      for (const clip of clips.reverse()) {
        if (known.has(clip.id)) continue;
        const isNew = Date.parse(clip.createdAt) > since;
        this.store.run(
          'INSERT OR IGNORE INTO harvested_clips (user_id, clip_id, channel_slug, title, duration_sec, thumbnail_url, clip_created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [userId, clip.id, cfg.channel, clip.title || '', clip.duration || 0, clip.thumbnailUrl || null, clip.createdAt || null, isNew ? 'downloading' : 'seen'],
        );
        if (isNew) await this.download(userId, clip, cfg);
      }
    } catch (err) {
      console.warn(`[Klip takibi ${userId}] Yoklama hatası:`, (err as Error).message);
    } finally {
      this.running.delete(userId);
      this.schedule(userId, POLL_MS);
    }
  }

  private async download(userId: number, clip: Row, cfg: HarvestConfig) {
    const row = this.store.get('SELECT id FROM harvested_clips WHERE user_id = ? AND clip_id = ?', [userId, clip.id])!;
    const target = path.join(config.clipDir, String(userId), 'harvest', `${clip.id}.mp4`);
    this.emit(userId);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await this.fetcher.downloadClip(clip.videoUrl, target);
      // İndirme sürerken kullanıcı sildiyse dosya atılır, klip geri dönmez.
      const res = this.store.run("UPDATE harvested_clips SET status = 'ready', file_path = ?, file_size = ? WHERE id = ? AND status = 'downloading'", [
        target,
        fs.statSync(target).size,
        row.id,
      ]);
      if (!res.changes) {
        fs.rmSync(target, { force: true });
        return;
      }
      if (cfg.autoEdit) await this.edit(userId, row.id).catch(() => {});
    } catch (err) {
      this.store.run("UPDATE harvested_clips SET status = 'failed', error = ? WHERE id = ? AND status = 'downloading'", [(err as Error).message.slice(0, 300), row.id]);
    }
    this.emit(userId);
  }

  private emit(userId: number) {
    this.io.to(`user:${userId}`).emit('harvest:update', { clips: this.list(userId) });
  }

  private toClip(r: Row) {
    const available = !!r.file_path && fs.existsSync(r.file_path);
    return {
      id: r.id,
      clipId: r.clip_id,
      channel: r.channel_slug,
      title: r.title,
      durationSec: r.duration_sec,
      thumbnailUrl: r.thumbnail_url,
      clipCreatedAt: r.clip_created_at,
      status: r.status,
      error: r.error,
      sizeBytes: r.file_size,
      jobId: r.job_id,
      videoUrl: available ? `/clips/${r.user_id}/harvest/${encodeURIComponent(path.basename(r.file_path))}` : null,
      createdAt: r.created_at,
    };
  }
}
