import path from 'node:path';
import { config } from '../config.ts';
import type { Row, Store } from '../db/Store.ts';
import { ClipEditorManager, PublishingPolicy, ZernioPublisher } from '../engine.ts';
import { HttpError, badRequest, notFound } from '../http.ts';

const {
  commonTikTokInteractions,
  createPublishRequestId,
  isValidProfileId,
  normalizePlatformResults,
  normalizePrivacyLevels,
  normalizePublishStatus,
  normalizeScheduleInput,
  summarizePlatformResults,
} = PublishingPolicy;

type Account = { platform: string; accountId: string };

const LOCKED_STATUSES = new Set(['pending', 'publishing', 'published', 'partial', 'scheduled', 'unknown']);
const TIKTOK_PRIVACY = new Set(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']);
const STALE_CLAIM_MS = 15 * 60_000;

function parsePlatforms(raw: unknown) {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    return normalizePlatformResults(JSON.parse(raw));
  } catch {
    return [];
  }
}

function safeDate(value: unknown, fallback: Date | null = new Date()) {
  if (!value) return fallback;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/** Paylaşım takvimi satırı — arayüz bunu doğrudan basar. */
export function toScheduleEntry(job: Row) {
  return {
    jobId: job.id,
    title: job.gen_title || job.title || `Klip #${job.id}`,
    thumbnailUrl: job.thumbnail_url || null,
    videoUrl: job.video_url || null,
    duration: job.duration || 0,
    source: job.source || null,
    publishStatus: job.publish_status || null,
    postId: job.publish_post_id || null,
    scheduledFor: job.scheduled_for || null,
    timezone: job.publish_timezone || null,
    publishedAt: job.published_at || null,
    createdAt: job.created_at || null,
    platforms: parsePlatforms(job.publish_platforms),
  };
}

/**
 * Zernio bağlantısı ve klip paylaşımı. Her kullanıcı kendi Zernio API
 * anahtarını ve profilini bağlar; anahtar veritabanında şifreli durur.
 * Paylaşım kuralları LivoBot'taki akışla aynıdır: hesaplar her gönderide
 * Zernio'dan yeniden doğrulanır, tek kazananlı claim mükerrer gönderiyi
 * önler, sonucu belirsiz gönderi yeniden denenmeye kilitlenir.
 */
export class Publishing {
  constructor(private store: Store) {}

  /* ── Bağlantı ────────────────────────────────────────────────────────── */

  async connection(userId: number) {
    const s = await this.store.getSettings(userId);
    const apiKey: string | null = s.zernio_api_key;
    const profileId = String(s.zernio_profile_id || '').trim();
    const connected = !!apiKey && isValidProfileId(profileId);
    return {
      connected,
      profile: connected ? { id: profileId, name: s.zernio_profile_name || 'Default' } : null,
      keyHint: apiKey ? `••••${apiKey.slice(-4)}` : null,
      publisher: connected ? new ZernioPublisher({ profileId, apiKey }) : null,
    };
  }

  async requirePublisher(userId: number) {
    const conn = await this.connection(userId);
    if (!conn.publisher) throw new HttpError(403, 'Önce Zernio hesabınızı bağlayın');
    return conn.publisher;
  }

  async listProfiles(apiKey: string) {
    const key = apiKey.trim();
    if (key.length < 10) throw badRequest('API anahtarı geçersiz görünüyor');
    try {
      const profiles = await ZernioPublisher.listProfiles(key);
      if (!profiles.length) throw badRequest('Bu anahtarla erişilebilen Zernio profili yok');
      return profiles;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const status = (err as { response?: { status?: number } }).response?.status;
      throw badRequest(status === 401 || status === 403 ? 'Zernio anahtarı reddedildi' : 'Zernio\'ya ulaşılamadı');
    }
  }

  async connect(userId: number, apiKey: string, profileId: string) {
    const profiles = await this.listProfiles(apiKey);
    const profile = profiles.find((p: { id: string }) => p.id === profileId);
    if (!profile) throw badRequest('Seçilen profil bu anahtarla erişilebilir değil');
    this.store.setZernioConnection(userId, { apiKey: apiKey.trim(), profileId: profile.id, profileName: profile.name });
    return this.summary(userId);
  }

  disconnect(userId: number) {
    this.store.setZernioConnection(userId, null);
  }

  async summary(userId: number) {
    const conn = await this.connection(userId);
    let accounts: unknown[] = [];
    let error: string | null = null;
    if (conn.publisher) {
      accounts = await conn.publisher.listAccounts().catch((err: Error) => {
        error = `Hesaplar alınamadı: ${err.message}`;
        return [];
      });
    }
    return { connected: conn.connected, profile: conn.profile, keyHint: conn.keyHint, accounts, error };
  }

  /** Otomatik paylaşım hesaplarının bağlı olduğunu doğrular (TikTok otomatik paylaşılamaz). */
  async assertAutoPublishAccounts(userId: number, accounts: Account[]) {
    if (!accounts.length) throw badRequest('Otomatik paylaşım için en az bir hesap seçin');
    if (accounts.some((a) => a.platform === 'tiktok')) {
      throw badRequest('TikTok her gönderide açık onay istediği için yalnız elle paylaşılabilir');
    }
    const publisher = await this.requirePublisher(userId);
    const keys = new Set((await publisher.listAccounts()).map((a: Row) => `${a.platform}:${a.id}`));
    if (accounts.some((a) => !keys.has(`${a.platform}:${a.accountId}`))) {
      throw badRequest('Seçilen hesaplardan biri Zernio\'da bağlı değil');
    }
  }

  async tiktokCreatorInfo(userId: number, accountId: string) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(accountId)) throw badRequest('Geçersiz hesap kimliği');
    const publisher = await this.requirePublisher(userId);
    const accounts = await publisher.listAccounts();
    if (!accounts.some((a: Row) => a.id === accountId && a.platform === 'tiktok')) throw notFound('TikTok hesabı bulunamadı');
    const info = await publisher.getTikTokCreatorInfo(accountId);
    return { privacyLevels: normalizePrivacyLevels(info.privacyLevels), postingLimits: info.postingLimits || null };
  }

  /* ── Klip paylaşımı ──────────────────────────────────────────────────── */

  async publishClip(userId: number, jobId: number, body: any, accounts: Account[]) {
    const job = await this.store.getEditedClipById(jobId, userId);
    if (!job) throw notFound('Klip bulunamadı');
    if (job.status !== 'ready') throw badRequest('Klip henüz hazır değil');
    if (LOCKED_STATUSES.has(job.publish_status)) {
      throw new HttpError(
        409,
        job.publish_status === 'unknown'
          ? 'Önceki paylaşımın sonucu belirsiz; Zernio panelinden doğrulamadan yeniden gönderilemez'
          : ['pending', 'publishing'].includes(job.publish_status)
            ? 'Bu klibin paylaşımı zaten sürüyor'
            : 'Bu klip daha önce paylaşıldı ya da planlandı',
        { publishStatus: job.publish_status },
      );
    }
    if (!accounts.length) throw badRequest('En az bir hesap seçin');

    let schedule: { mode: string; scheduledAt: Date | null; timezone: string };
    try {
      schedule = normalizeScheduleInput({ scheduledFor: body?.scheduledFor, timezone: body?.timezone, accounts });
    } catch (err) {
      throw badRequest((err as Error).message);
    }

    const publisher = await this.requirePublisher(userId);
    const connected = new Set((await publisher.listAccounts()).map((a: Row) => `${a.platform}:${a.id}`));
    if (accounts.some((a) => !connected.has(`${a.platform}:${a.accountId}`))) {
      throw badRequest('Seçilen hesaplardan biri bağlı değil ya da artık kullanılamıyor');
    }
    const tiktokSettings = await this.tiktokSettings(publisher, accounts, body?.tiktokSettings);

    let tags: string[] = [];
    try {
      tags = JSON.parse(job.gen_hashtags || '[]');
    } catch {
      /* etiket yok */
    }
    const fallback = (job.gen_description || '') + (tags.length ? `\n\n${tags.map((h) => `#${h}`).join(' ')}` : '');
    const content = String(body?.content || fallback || '').trim().slice(0, 2000);
    const videoPath = path.join(config.clipDir, String(userId), 'vertical', `${job.id}.mp4`);

    const claimed = await this.store.claimEditedClipForPublish(job.id, userId);
    if (!claimed) throw new HttpError(409, 'Bu klip için başka bir paylaşım zaten başladı');

    try {
      const result = await publisher.publish({
        videoPath,
        content,
        accounts,
        scheduledFor: schedule.scheduledAt,
        tiktokSettings,
        requestId: createPublishRequestId({ userId, jobId: job.id, accounts, content, scheduledFor: schedule.scheduledAt }),
      });
      const publishStatus = normalizePublishStatus(result.status, { scheduledFor: result.scheduledFor });
      const platforms = result.platforms?.length
        ? result.platforms
        : normalizePlatformResults(accounts.map((a) => ({ platform: a.platform, status: publishStatus === 'scheduled' ? 'scheduled' : 'pending' })));
      await this.store
        .updateEditedClip(job.id, userId, {
          publish_status: publishStatus,
          publish_post_id: result.postId || null,
          publish_started_at: null,
          scheduled_for: result.scheduledFor ? safeDate(result.scheduledFor, schedule.scheduledAt) : null,
          publish_timezone: result.scheduledFor ? schedule.timezone : null,
          publish_platforms: JSON.stringify(platforms),
          published_at: publishStatus === 'published' ? new Date() : null,
        })
        .catch((err: Error) => console.error(`[Paylaşım ${userId}] Durum kaydedilemedi (${job.id}):`, err.message));
      return {
        publishStatus,
        postId: result.postId || null,
        platforms,
        scheduled: publishStatus === 'scheduled',
        publishedImmediately: !!result.publishedImmediately,
      };
    } catch (err: any) {
      await this.store
        .updateEditedClip(job.id, userId, { publish_status: err.publishOutcomeUnknown ? 'unknown' : 'failed', publish_started_at: null })
        .catch(() => {});
      const message = err.publishOutcomeUnknown
        ? 'Paylaşımın sonucu doğrulanamadı. Mükerrer gönderiyi önlemek için yeniden paylaşım kilitlendi; Zernio panelinden kontrol edin.'
        : err.response?.data?.error || ClipEditorManager.friendlyError(err.message || 'Paylaşım servisi hatası');
      throw new HttpError(502, message, { publishStatus: err.publishOutcomeUnknown ? 'unknown' : 'failed', fileTooLarge: !!err.fileTooLarge });
    }
  }

  /** Sağlayıcı asenkron yayınladığı için kesin durumu sonradan tazeler. */
  async refreshStatus(userId: number, jobId: number) {
    const job = await this.store.getEditedClipById(jobId, userId);
    if (!job) throw notFound('Klip bulunamadı');
    if (!job.publish_post_id) {
      const startedAt = new Date(job.publish_started_at || 0).getTime();
      if (job.publish_status === 'publishing' && startedAt <= Date.now() - STALE_CLAIM_MS) {
        await this.store.updateEditedClip(job.id, userId, { publish_status: 'unknown', publish_started_at: null });
        return { publishStatus: 'unknown', platforms: [] };
      }
      return { publishStatus: job.publish_status || null, platforms: [] };
    }
    const publisher = await this.requirePublisher(userId);
    const result = await publisher.getStatus(job.publish_post_id);
    const platforms = result.platforms?.length ? result.platforms : parsePlatforms(job.publish_platforms);
    const base = normalizePublishStatus(result.status, { scheduledFor: job.scheduled_for });
    const status = result.status ? base : summarizePlatformResults(platforms, { fallback: base });
    const done = !['pending', 'publishing', 'scheduled'].includes(status);
    await this.store.updateEditedClip(job.id, userId, {
      publish_status: status,
      publish_started_at: ['pending', 'publishing'].includes(status) ? job.publish_started_at : null,
      publish_platforms: platforms.length ? JSON.stringify(platforms) : job.publish_platforms,
      published_at: ['published', 'partial'].includes(status) ? job.published_at || safeDate(result.publishedAt) : done ? job.published_at : null,
    });
    return { publishStatus: status, platforms };
  }

  async schedule(userId: number) {
    const rows = await this.store.getPublishQueue(userId, 200);
    return rows.map(toScheduleEntry);
  }

  /** TikTok: gizlilik seviyesi ve açık onaylar zorunlu; hesabın izinleriyle doğrulanır. */
  private async tiktokSettings(publisher: any, accounts: Account[], raw: any) {
    const tiktok = accounts.filter((a) => a.platform === 'tiktok');
    if (!tiktok.length) return null;
    const privacy = String(raw?.privacy_level || '');
    if (!TIKTOK_PRIVACY.has(privacy)) throw badRequest('TikTok için bir gizlilik seçeneği belirleyin');
    if (raw?.content_preview_confirmed !== true || raw?.express_consent_given !== true) {
      throw badRequest('TikTok paylaşımı için önizleme ve yayın onayı zorunlu');
    }
    const infos = await Promise.all(tiktok.map((a) => publisher.getTikTokCreatorInfo(a.accountId)));
    if (!infos.every((i) => normalizePrivacyLevels(i.privacyLevels).some((l: Row) => l.value === privacy))) {
      throw badRequest('Seçilen gizlilik seviyesi bu TikTok hesabında kullanılamıyor');
    }
    const allowed = commonTikTokInteractions(infos);
    const wanted = { comment: raw.allow_comment === true, duet: raw.allow_duet === true, stitch: raw.allow_stitch === true };
    for (const [k, on] of Object.entries(wanted)) {
      if (on && !allowed[k]) throw badRequest('Seçilen TikTok hesaplarından biri bu etkileşime izin vermiyor');
    }
    return {
      privacy_level: privacy,
      allow_comment: wanted.comment,
      allow_duet: wanted.duet,
      allow_stitch: wanted.stitch,
      content_preview_confirmed: true,
      express_consent_given: true,
    };
  }
}
