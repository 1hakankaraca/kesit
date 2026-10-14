const crypto = require('crypto');

const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const PRIVACY_LEVELS = new Set([
    'PUBLIC_TO_EVERYONE',
    'MUTUAL_FOLLOW_FRIENDS',
    'FOLLOWER_OF_CREATOR',
    'SELF_ONLY',
]);
const PROVIDER_STATUSES = new Set([
    'pending',
    'publishing',
    'published',
    'partial',
    'failed',
    'scheduled',
]);

function isValidProfileId(profileId) {
    return PROFILE_ID_PATTERN.test(String(profileId || '').trim());
}

function normalizePrivacyLevels(levels) {
    if (!Array.isArray(levels)) return [];

    const unique = new Map();
    for (const level of levels) {
        const value = typeof level === 'string' ? level : level?.value;
        const label = typeof level === 'object' && level ? level.label : value;
        if (!PRIVACY_LEVELS.has(value) || unique.has(value)) continue;
        unique.set(value, { value, label: String(label || value).slice(0, 100) });
    }
    return [...unique.values()];
}

function commonTikTokInteractions(creatorInfos) {
    if (!Array.isArray(creatorInfos) || creatorInfos.length === 0) {
        return { comment: false, duet: false, stitch: false };
    }

    const isAllowedForEveryAccount = key => creatorInfos.every(info =>
        info?.postingLimits?.interactionSettings?.[key] === true);

    return {
        comment: isAllowedForEveryAccount('comment'),
        duet: isAllowedForEveryAccount('duet'),
        stitch: isAllowedForEveryAccount('stitch'),
    };
}

function normalizePublishStatus(status, { scheduledFor = null } = {}) {
    const normalized = String(status || '').trim().toLowerCase();
    if (PROVIDER_STATUSES.has(normalized)) return normalized;
    return scheduledFor ? 'scheduled' : 'publishing';
}

function createPublishRequestId({ userId, jobId, accounts, title, content, scheduledFor = null }) {
    const accountKeys = (Array.isArray(accounts) ? accounts : [])
        .map(account => `${account.platform}:${account.accountId}`)
        .sort();
    // Yayın zamanı da anahtarın parçası: "hemen paylaş" ile "20:00'a planla"
    // farklı niyetlerdir, sağlayıcı bunları aynı gönderiye indirgememeli.
    const scheduleKey = scheduledFor
        ? new Date(scheduledFor).toISOString()
        : '';
    const payload = JSON.stringify({
        userId: Number(userId),
        jobId: Number(jobId),
        accountKeys,
        title: String(title || ''),
        content: String(content || ''),
        scheduledFor: scheduleKey,
    });
    const hash = crypto.createHash('sha256').update(payload).digest('hex');

    // UUID biçimli deterministik anahtar: aynı mantıksal deneme sağlayıcıda
    // ikinci bir gönderi oluşturmaz. Sürüm biti 5, varyant biti RFC 4122'dir.
    return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        `5${hash.slice(13, 16)}`,
        `${(8 + (parseInt(hash[16], 16) % 4)).toString(16)}${hash.slice(17, 20)}`,
        hash.slice(20, 32),
    ].join('-');
}


// ==========================================
// ZAMANLAMA (PLANLI PAYLAŞIM)
// ==========================================

// Zernio gönderiyi kendi kuyruğunda tutup zamanı gelince platforma iletir;
// bu yüzden alt/üst sınır platformun değil kuyruğun sınırıdır. Alt sınır,
// videonun yüklenip sağlayıcıda işlenmesi için gereken paydır — bunun altına
// düşen bir plan pratikte "hemen"e denk gelir ve YouTube/Instagram tarafında
// "geçmiş tarih" hatası doğurabilir.
const MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1000;          // en erken +5 dk
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000; // en geç +1 yıl

// Planlı gönderimin doğrulandığı platformlar. YouTube ve Instagram bu listenin
// çekirdeğidir (kullanıcı isteği); diğerleri de Zernio kuyruğunu kullanır.
const SCHEDULABLE_PLATFORMS = new Set([
    'youtube', 'instagram', 'tiktok', 'facebook', 'threads',
    'linkedin', 'pinterest', 'twitter', 'bluesky', 'telegram',
]);

function isValidTimeZone(timezone) {
    const value = String(timezone || '').trim();
    if (!value || value.length > 64) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

function unschedulablePlatforms(accounts) {
    const seen = new Set();
    for (const account of Array.isArray(accounts) ? accounts : []) {
        const platform = String(account?.platform || '').trim().toLowerCase();
        if (platform && !SCHEDULABLE_PLATFORMS.has(platform)) seen.add(platform);
    }
    return [...seen];
}

/**
 * İstemciden gelen zamanlama isteğini doğrular ve normalize eder.
 *
 * @param {object} params
 *   - scheduledFor: ISO string | Date | null  (yoksa "hemen paylaş")
 *   - timezone: IANA saat dilimi (ör. 'Europe/Istanbul') — sağlayıcıya bildirilir
 *   - accounts: seçilen hesaplar (platform uyumluluğu için)
 *   - now: test edilebilirlik için referans zaman (ms)
 * @returns {{mode:'now'|'scheduled', scheduledAt: Date|null, timezone: string}}
 * @throws {Error} Türkçe, kullanıcıya doğrudan gösterilebilir hata
 */
function normalizeScheduleInput({ scheduledFor = null, timezone = null, accounts = [], now = Date.now() } = {}) {
    const tz = isValidTimeZone(timezone) ? String(timezone).trim() : 'UTC';

    if (scheduledFor === null || scheduledFor === undefined || scheduledFor === '') {
        return { mode: 'now', scheduledAt: null, timezone: tz };
    }

    const scheduledAt = scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor);
    if (Number.isNaN(scheduledAt.getTime())) {
        throw new Error('Geçersiz yayın tarihi — tarih ve saati yeniden seçin');
    }

    const delta = scheduledAt.getTime() - now;
    if (delta < MIN_SCHEDULE_LEAD_MS) {
        throw new Error('Yayın zamanı en az 5 dakika sonrası olmalı — video yüklemesi bu süreyi gerektiriyor');
    }
    if (delta > MAX_SCHEDULE_AHEAD_MS) {
        throw new Error('Yayın zamanı en fazla 1 yıl sonrasına planlanabilir');
    }

    const unsupported = unschedulablePlatforms(accounts);
    if (unsupported.length > 0) {
        throw new Error(`Şu platform(lar) planlı paylaşımı desteklemiyor: ${unsupported.join(', ')}`);
    }

    return { mode: 'scheduled', scheduledAt, timezone: tz };
}

// ==========================================
// PLATFORM SONUÇLARI (planlandı / yayınlandı)
// ==========================================

// Sağlayıcının platform bazlı durum sözcükleri panelde tek bir dile indirgenir.
const PLATFORM_STATUS_ALIASES = {
    published: 'published',
    posted: 'published',
    success: 'published',
    completed: 'published',
    live: 'published',
    scheduled: 'scheduled',
    queued: 'scheduled',
    pending: 'pending',
    processing: 'publishing',
    publishing: 'publishing',
    uploading: 'publishing',
    failed: 'failed',
    error: 'failed',
    rejected: 'failed',
    cancelled: 'cancelled',
    canceled: 'cancelled',
};

function normalizePlatformStatus(status) {
    const normalized = String(status || '').trim().toLowerCase();
    return PLATFORM_STATUS_ALIASES[normalized] || (normalized ? 'pending' : 'pending');
}

/**
 * Sağlayıcıdan gelen platform dizisini panelin beklediği sabit şemaya çevirir.
 * Alan adları sağlayıcı sürümleri arasında değişebildiği için birkaç yaygın
 * eşanlamlı da denenir; bilinmeyenler sessizce atlanır.
 */
function normalizePlatformResults(platforms) {
    if (!Array.isArray(platforms)) return [];
    const seen = new Map();
    for (const entry of platforms) {
        const platform = String(entry?.platform || '').trim().toLowerCase();
        if (!platform || seen.has(platform)) continue;
        const publishedAt = entry?.publishedAt || entry?.published_at || entry?.completedAt || null;
        const url = entry?.platformPostUrl || entry?.postUrl || entry?.url || entry?.permalink || entry?.link || null;
        const error = entry?.error || entry?.errorMessage || entry?.failureReason || null;
        seen.set(platform, {
            platform,
            status: normalizePlatformStatus(entry?.status),
            accountName: entry?.displayName || entry?.accountName || null,
            publishedAt: publishedAt ? String(publishedAt).slice(0, 40) : null,
            url: typeof url === 'string' && /^https?:\/\//i.test(url) ? url.slice(0, 500) : null,
            error: error ? String(error).slice(0, 300) : null,
        });
    }
    return [...seen.values()];
}

/** Platform sonuçlarından gönderi seviyesinde tek bir durum türetir. */
function summarizePlatformResults(platforms, { fallback = 'pending' } = {}) {
    const list = normalizePlatformResults(platforms);
    if (list.length === 0) return fallback;
    const statuses = list.map(item => item.status);
    if (statuses.every(status => status === 'published')) return 'published';
    if (statuses.every(status => status === 'failed')) return 'failed';
    if (statuses.some(status => status === 'published') && statuses.some(status => status === 'failed')) return 'partial';
    if (statuses.some(status => ['publishing', 'pending'].includes(status))) return 'publishing';
    if (statuses.every(status => status === 'scheduled')) return 'scheduled';
    return fallback;
}

module.exports = {
    MAX_SCHEDULE_AHEAD_MS,
    MIN_SCHEDULE_LEAD_MS,
    SCHEDULABLE_PLATFORMS,
    commonTikTokInteractions,
    createPublishRequestId,
    isValidProfileId,
    isValidTimeZone,
    normalizePlatformResults,
    normalizePlatformStatus,
    normalizePrivacyLevels,
    normalizePublishStatus,
    normalizeScheduleInput,
    summarizePlatformResults,
    unschedulablePlatforms,
};
