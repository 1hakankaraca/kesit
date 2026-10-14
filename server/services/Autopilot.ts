import type { Server as IOServer } from 'socket.io';
import {
  normalizeAutopilot,
  type AutopilotConfig,
  type AutopilotEvent,
  type AutopilotEventKind,
  type AutopilotStatus,
} from '../../shared/autopilot.ts';
import { config } from '../config.ts';
import type { Store } from '../db/Store.ts';
import { fetchChannel } from '../lib/kick.ts';
import type { Workspaces } from './Workspaces.ts';

/** Kick API anlık "çevrimdışı" dönebiliyor; yayın ancak art arda bu kadar yoklamada kapalı görülürse bitmiş sayılır. */
const OFFLINE_CONFIRMATIONS = 2;
const MAX_EVENTS = 30;
/** Kick yayın kaydını yayından birkaç dakika sonra yayımlar; bu aralıkla ve bu kadar kez aranır. */
const VOD_RETRY_MS = 2 * 60_000;
const VOD_MAX_TRIES = 20;

interface Watch {
  config: AutopilotConfig;
  timer: NodeJS.Timeout | null;
  live: boolean | null;
  offlineStreak: number;
  title: string | null;
  viewers: number;
  lastCheckAt: Date | null;
  nextCheckAt: Date | null;
  /** Yayının başladığı an (Kick'ten) — biten yayının kaydını eşlemek için. */
  liveSince: Date | null;
  vodTimer: NodeJS.Timeout | null;
  events: AutopilotEvent[];
  busy: boolean;
}

/**
 * Nöbet: kullanıcı bilgisayar başında değilken takip ettiği kanalı yoklar.
 *  - Kanal canlıya geçince: chat'teki klipler yakalanır, istenirse otomatik
 *    düzenlenip paylaşılır.
 *  - Yayın bitince: Kick'in yayın kaydı yayımlanınca indirilir ve Geçmiş
 *    yayınlar'a düşer. Otomatik işlenmez — kullanıcı editörde keser.
 * Ayar kalıcıdır; sunucu yeniden başlarsa açık nöbetler geri kurulur.
 */
export class Autopilot {
  private watches = new Map<number, Watch>();

  constructor(
    private store: Store,
    private io: IOServer,
    private workspaces: Workspaces,
    private vodScanner: any,
  ) {}

  /** Sunucu açılışında kalıcı nöbetleri geri kurar. */
  async restore() {
    for (const row of this.store.getAutopilotUsers()) {
      const cfg = normalizeAutopilot(safeJson(row.autopilot));
      if (cfg.enabled && cfg.channel) this.arm(row.user_id, cfg, 'Sunucu açıldı, nöbet yeniden kuruldu');
    }
  }

  async getConfig(userId: number): Promise<AutopilotConfig> {
    const settings = await this.store.getSettings(userId);
    return normalizeAutopilot(safeJson(settings.autopilot));
  }

  async update(userId: number, raw: unknown): Promise<AutopilotStatus> {
    const cfg = normalizeAutopilot(raw);
    if (cfg.enabled && !cfg.channel) throw new Error('Nöbet için takip edilecek kanalı seçin');
    if (cfg.autoPublish && !cfg.publishAccounts.length) throw new Error('Otomatik paylaşım için en az bir hesap seçin');
    await this.store.updateSettings(userId, { autopilot: JSON.stringify(cfg) });

    const current = this.watches.get(userId);
    if (!cfg.enabled) {
      if (current) await this.disarm(userId);
    } else if (current && current.config.channel === cfg.channel) {
      current.config = cfg;
      if (current.live) await this.applyLiveSettings(userId, current);
      this.emit(userId);
    } else {
      if (current) await this.disarm(userId, false);
      this.arm(userId, cfg, `${cfg.channel} kanalı için nöbet başladı`);
    }
    return this.status(userId, cfg);
  }

  async status(userId: number, known?: AutopilotConfig): Promise<AutopilotStatus> {
    const w = this.watches.get(userId);
    return {
      config: w?.config ?? known ?? (await this.getConfig(userId)),
      live: w?.live ?? null,
      title: w?.title ?? null,
      viewers: w?.viewers ?? 0,
      lastCheckAt: w?.lastCheckAt?.toISOString() ?? null,
      nextCheckAt: w?.nextCheckAt?.toISOString() ?? null,
      events: w?.events ?? [],
    };
  }

  stopAll() {
    for (const w of this.watches.values()) {
      if (w.timer) clearTimeout(w.timer);
      if (w.vodTimer) clearTimeout(w.vodTimer);
    }
    this.watches.clear();
  }

  /* ── İç işleyiş ──────────────────────────────────────────────────────── */

  private arm(userId: number, cfg: AutopilotConfig, note: string) {
    const w: Watch = {
      config: cfg,
      timer: null,
      live: null,
      offlineStreak: 0,
      title: null,
      viewers: 0,
      lastCheckAt: null,
      nextCheckAt: null,
      liveSince: null,
      vodTimer: null,
      events: [],
      busy: false,
    };
    this.watches.set(userId, w);
    this.log(userId, w, 'armed', note);
    void this.tick(userId);
  }

  private async disarm(userId: number, announce = true) {
    const w = this.watches.get(userId);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    if (w.vodTimer) clearTimeout(w.vodTimer);
    this.watches.delete(userId);
    const ws = await this.workspaces.get(userId);
    // Nöbetin açtığı klip takibi kapanır.
    if (w.config.clips && ws.clipWatcher.isWatching) ws.clipWatcher.unwatch();
    if (announce) {
      w.events.unshift({ at: new Date().toISOString(), kind: 'disarmed', text: 'Nöbet kapatıldı' });
      this.io.to(`user:${userId}`).emit('autopilot:status', await this.status(userId, { ...w.config, enabled: false }));
    }
  }

  private schedule(userId: number, w: Watch) {
    if (this.watches.get(userId) !== w) return;
    w.nextCheckAt = new Date(Date.now() + config.autopilotPollMs);
    w.timer = setTimeout(() => void this.tick(userId), config.autopilotPollMs);
    w.timer.unref?.();
  }

  private async tick(userId: number) {
    const w = this.watches.get(userId);
    if (!w || w.busy || !w.config.channel) return;
    w.busy = true;
    try {
      const info = await fetchChannel(w.config.channel);
      w.lastCheckAt = new Date();
      w.title = info.title;
      w.viewers = info.viewers;
      if (info.isLive) {
        w.offlineStreak = 0;
        if (w.live !== true) {
          w.live = true;
          w.liveSince = info.startedAt ? new Date(info.startedAt) : new Date();
          this.log(userId, w, 'live', `${w.config.channel} canlı yayına geçti${info.title ? `: ${info.title}` : ''}`);
        }
        await this.applyLiveSettings(userId, w);
      } else {
        w.offlineStreak++;
        if (w.live === null) w.live = false;
        if (w.live && w.offlineStreak >= OFFLINE_CONFIRMATIONS) {
          w.live = false;
          this.log(userId, w, 'offline', `${w.config.channel} yayını bitti`);
          await this.wrapUp(userId, w);
        }
      }
    } catch (err) {
      w.lastCheckAt = new Date();
      this.log(userId, w, 'error', `Kanal yoklanamadı: ${(err as Error).message}`, true);
    } finally {
      w.busy = false;
      this.schedule(userId, w);
      this.emit(userId);
    }
  }

  /** Canlıyken istenen her şeyin açık olduğundan emin olur (idempotent). */
  private async applyLiveSettings(userId: number, w: Watch) {
    const ws = await this.workspaces.get(userId);
    if (!w.config.clips) {
      // Yayın sürerken klip yakalama kapatıldıysa nöbetin açtığı takip bırakılır.
      if (ws.clipWatcher.isWatching && ws.clipWatcher.channelSlug === w.config.channel) ws.clipWatcher.unwatch();
      return;
    }
    await ws.clipWatcher.watch(w.config.channel!, {
      autoEdit: w.config.autoEdit,
      autoPublish: w.config.autoPublish,
      publishAccounts: w.config.publishAccounts,
      subtitles: w.config.subtitles,
    });
  }

  /** Yayın bitti: klip takibini bırakır, istenirse yayın kaydını indirmeye başlar. */
  private async wrapUp(userId: number, w: Watch) {
    const ws = await this.workspaces.get(userId);
    if (w.config.clips && ws.clipWatcher.isWatching) ws.clipWatcher.unwatch();
    if (w.config.downloadVod) {
      this.log(userId, w, 'vod-wait', 'Kick yayın kaydını yayımlayınca indirilecek');
      this.findVod(userId, w, w.config.channel!, w.liveSince, 1);
    }
    w.liveSince = null;
  }

  /** Biten yayının Kick kaydını arar; bulunca indirme sırasına koyar (işlemez). */
  private findVod(userId: number, w: Watch, channel: string, since: Date | null, attempt: number) {
    w.vodTimer = setTimeout(async () => {
      if (this.watches.get(userId) !== w) return;
      try {
        const videos: { id: string | number; title?: string; startedAt?: string; isLive?: boolean }[] = await this.vodScanner.listVideos(channel);
        // Yayının başlangıcından (ya da son bir günden) sonraki ilk kapanmış kayıt.
        const floor = (since?.getTime() ?? Date.now() - 86_400_000) - 15 * 60_000;
        const vod = videos.find((v) => !v.isLive && v.startedAt && Date.parse(v.startedAt.replace(' ', 'T') + 'Z') >= floor);
        if (vod) {
          const known = (await this.store.getVodScanJobs(userId, 100)).some((j) => String(j.source_video_id) === String(vod.id));
          if (!known) await this.vodScanner.enqueue(userId, { channelSlug: channel, videoId: String(vod.id), quality: '1080p' });
          this.log(userId, w, 'vod-queued', `Yayın kaydı indiriliyor${vod.title ? `: ${vod.title}` : ''} — Geçmiş yayınlar'dan düzenleyebilirsin`);
          this.emit(userId);
          return;
        }
      } catch (err) {
        this.log(userId, w, 'error', `Yayın kaydı aranamadı: ${(err as Error).message}`, true);
      }
      if (attempt >= VOD_MAX_TRIES) {
        this.log(userId, w, 'error', 'Kick yayın kaydını yayımlamadı (yayıncı kaydı kapatmış olabilir)');
        this.emit(userId);
      } else this.findVod(userId, w, channel, since, attempt + 1);
    }, attempt === 1 ? 60_000 : VOD_RETRY_MS);
    w.vodTimer.unref?.();
  }

  private log(userId: number, w: Watch, kind: AutopilotEventKind, text: string, dedupe = false) {
    if (dedupe && w.events[0]?.text === text) return;
    w.events.unshift({ at: new Date().toISOString(), kind, text });
    w.events.length = Math.min(w.events.length, MAX_EVENTS);
    console.log(`[Nöbetçi ${userId}] ${text}`);
  }

  private emit(userId: number) {
    void this.status(userId).then((s) => this.io.to(`user:${userId}`).emit('autopilot:status', s));
  }
}

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
