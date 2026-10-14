/**
 * ZernioPublisher — Dikey klipleri Zernio üzerinden sosyal medyaya paylaşır
 *
 * Zernio tek API ile YouTube, Instagram, TikTok vb. platformlara gönderim yapar.
 * Kullanıcı sosyal hesaplarını Zernio panelinden bağlar; biz sadece bağlı
 * hesapları listeleyip video + başlık/açıklama ile paylaşım oluştururuz.
 *
 * Akış:
 *  1. POST /media/presign → presigned R2 upload URL + publicUrl
 *  2. PUT (dosya)  → R2'ye yükle
 *  3. POST /posts  → publicUrl + seçilen hesaplar ile yayınla
 *
 * Her kullanıcı kendi Zernio API anahtarını bağlar; anahtar verilmezse
 * ZERNIO_API_KEY ortam değişkenine düşülür. İkisi de yoksa devre dışı.
 */
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    isValidProfileId,
    normalizePlatformResults,
} = require('./PublishingPolicy');

const BASE_URL = 'https://zernio.com/api/v1';
const MAX_UPLOAD_TIMEOUT_MS = 12 * 60 * 1000;
// Zernio'nun /media/presign uç noktasının kabul ettiği gerçek üst sınır —
// canlı ölçümle doğrulandı: 5*1024^3 (5368709120) bayt kabul ediliyor,
// bir üstü "size is invalid" (400) ile reddediliyor. Kod tarafında BİLEREK
// bir üretim sınırı yok (kullanıcı isteği: kesitler saatlerce sürebilir) —
// sadece paylaşım anında net bir uyarı verip presign isteğini hiç atmıyoruz.
const ZERNIO_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024;

class ZernioPublisher {
    constructor({ profileId, apiKey = null } = {}) {
        const normalizedProfileId = String(profileId || '').trim();
        if (!isValidProfileId(normalizedProfileId)) {
            throw new Error('Zernio profili bu kullanıcı için yapılandırılmamış');
        }
        this.profileId = normalizedProfileId;
        this.apiKey = String(apiKey || process.env.ZERNIO_API_KEY || '').trim();
        if (!this.apiKey) throw new Error('Zernio hesabı bağlı değil');
    }

    static isAvailable(apiKey = null) {
        return !!(apiKey || process.env.ZERNIO_API_KEY);
    }

    /**
     * Anahtarın erişebildiği Zernio profilleri — hesap bağlarken anahtarı
     * doğrulamak ve profil seçtirmek için kullanılır.
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    static async listProfiles(apiKey) {
        const res = await axios.get(`${BASE_URL}/profiles`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 15000,
        });
        const liste = res.data?.profiles || res.data?.data || [];
        return liste.map(p => ({ id: String(p._id || p.id), name: p.name || 'Default' }));
    }

    get _headers() {
        return { Authorization: `Bearer ${this.apiKey}` };
    }

    /**
     * Bağlı sosyal medya hesaplarını listele
     * @returns {Array<{id, platform, displayName, profile}>}
     */
    async listAccounts() {
        const res = await axios.get(`${BASE_URL}/accounts`, {
            headers: this._headers,
            params: { status: 'connected', profileId: this.profileId },
            timeout: 15000,
        });
        return (res.data?.accounts || []).map(a => ({
            id: a._id,
            platform: String(a.platform || '').toLowerCase(),
            displayName: a.displayName || a.username || a.platform,
            profile: a.profileId?.name || 'Default',
        }));
    }

    /**
     * Videoyu Zernio depolamasına yükle (presigned PUT), publicUrl döndür
     */
    async uploadVideo(filePath, { maxTimeoutMs = MAX_UPLOAD_TIMEOUT_MS } = {}) {
        if (!fs.existsSync(filePath)) throw new Error('Video dosyası bulunamadı');
        // Dosya belleğe okunmaz (büyük video readFileSync ile event loop'u
        // bloklar + RAM şişirir) — stream ile yüklenir
        const size = fs.statSync(filePath).size;

        if (size > ZERNIO_MAX_FILE_SIZE_BYTES) {
            const err = new Error(
                `Bu video Zernio'nun desteklediği ${ZernioPublisher._formatGB(ZERNIO_MAX_FILE_SIZE_BYTES)} GB dosya boyutu sınırını aşıyor `
                + `(dosya: ${ZernioPublisher._formatGB(size)} GB). Zernio üzerinden paylaşılamaz — videoyu indirip ilgili platforma kendiniz yükleyebilirsiniz.`
            );
            err.fileTooLarge = true;
            err.fileSizeBytes = size;
            err.maxSizeBytes = ZERNIO_MAX_FILE_SIZE_BYTES;
            throw err;
        }

        // Zernio/Cloudflare R2 ara sıra kısa süreli ağ hatası veriyor (timeout,
        // ECONNRESET) — tek denemede vazgeçmek yerine kısa backoff ile tekrar dene.
        let presign;
        try {
            presign = await this._withRetry(() => axios.post(
                `${BASE_URL}/media/presign`,
                { filename: path.basename(filePath), contentType: 'video/mp4', size },
                { headers: { ...this._headers, 'Content-Type': 'application/json' }, timeout: 20000 }
            ));
        } catch (err) {
            // Yukarıdaki ön-kontrol normalde bunu hiç tetiklemez — Zernio
            // limiti ileride değişirse diye bir güvenlik ağı olarak kalsın.
            const msg = String(err.response?.data?.error || err.message || '');
            if (/size/i.test(msg) && /invalid|large|exceed|limit/i.test(msg)) {
                const friendly = new Error(
                    `Bu video Zernio'nun desteklediği boyutu aşıyor (dosya: ${ZernioPublisher._formatGB(size)} GB). `
                    + 'Zernio üzerinden paylaşılamaz — videoyu indirip ilgili platforma kendiniz yükleyebilirsiniz.'
                );
                friendly.fileTooLarge = true;
                friendly.fileSizeBytes = size;
                throw friendly;
            }
            throw err;
        }
        const { uploadUrl, publicUrl } = presign.data || {};
        if (!uploadUrl || !publicUrl) throw new Error('Zernio upload linki alınamadı');

        // Timeout dosya boyutuyla ölçeklenir (en az 2 dk, ~128KB/s varsayımı)
        // ancak atomik paylaşım claim süresini aşmaması için 12 dk'da kesilir.
        // Yayın kaydı taslakları claim kullanmaz ve GB'larca olabilir; onlar
        // daha uzun bir tavan verir (maxTimeoutMs).
        const uploadTimeout = Math.min(
            maxTimeoutMs,
            Math.max(120000, Math.round(size / (128 * 1024)) * 1000)
        );
        await this._withRetry(() => axios.put(uploadUrl, fs.createReadStream(filePath), {
            headers: { 'Content-Type': 'video/mp4', 'Content-Length': size },
            timeout: uploadTimeout,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
        }));

        return publicUrl;
    }

    /**
     * Geçici ağ hatalarında (timeout, DNS, bağlantı reset, R2/Cloudflare 5xx)
     * kısa backoff ile 1 kez tekrar dener. Kalıcı hatalar (4xx doğrulama vb.)
     * hemen fırlatılır — sonsuz beklemeye gerek yok.
     */
    async _withRetry(fn) {
        try {
            return await fn();
        } catch (err) {
            const status = Number(err.response?.status) || 0;
            const transient = status === 0 || status >= 500
                || /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(err.message || '');
            if (!transient) throw err;
            await new Promise(r => setTimeout(r, 4000));
            return fn();
        }
    }

    static _formatGB(bytes) {
        return (bytes / (1024 * 1024 * 1024)).toFixed(2);
    }

    /**
     * Klibi seçilen platformlara yayınla veya ileri tarihe planla
     * @param {object} params
     *   - videoPath: yerel mp4 yolu
     *   - title: başlık (YouTube/Pinterest — platformSpecificData'ya gider)
     *   - content: açıklama/caption (+hashtag) — video açıklaması
     *   - accounts: Array<{platform, accountId}>
     *   - scheduledFor: Date|ISO string (opsiyonel) — MUTLAK an; verilirse
     *     hemen yerine planlanır. Saat dilimi burada YOKTUR: sağlayıcıya her
     *     zaman UTC bildirilir, kullanıcının seçtiği dilim sunum katmanının
     *     işidir (bkz. body.timezone yorumu).
     * @returns {{postId, status, platforms, scheduledFor, publishedImmediately}}
     */
    async publish({
        videoPath,
        title,
        content,
        accounts,
        scheduledFor = null,
        tiktokSettings = null,
        requestId = null,
    }) {
        if (!Array.isArray(accounts) || accounts.length === 0) {
            throw new Error('En az bir hesap seçilmeli');
        }
        const mediaUrl = await this.uploadVideo(videoPath);

        // Başlık top-level değil, platform bazında platformSpecificData.title'a gider.
        // content = video açıklaması. media = mediaItems:[{url,type}].
        // Başlık boşsa açıklamanın ilk satırından türet (YouTube "Untitled" almasın).
        let cleanTitle = (title || '').trim().slice(0, 100);
        if (!cleanTitle && content) cleanTitle = content.split('\n')[0].trim().slice(0, 100);
        if (!cleanTitle) cleanTitle = 'Kick Klip';
        const body = {
            content: content || title || '',
            mediaItems: [{ url: mediaUrl, type: 'video' }],
            platforms: accounts.map(a => {
                const p = { platform: a.platform, accountId: a.accountId };
                // YouTube/Pinterest başlık ister
                if (cleanTitle && (a.platform === 'youtube' || a.platform === 'pinterest')) {
                    p.platformSpecificData = { title: cleanTitle, visibility: 'public' };
                }
                return p;
            }),
        };
        if (accounts.some(a => a.platform === 'tiktok') && tiktokSettings) {
            body.tiktokSettings = tiktokSettings;
        }

        const schedISO = scheduledFor
            ? (scheduledFor instanceof Date ? scheduledFor.toISOString() : new Date(scheduledFor).toISOString())
            : null;
        // Video yüklemesi dakikalarca sürebildiği için plan anı BU NOKTADA
        // gerçekten geçmiş olabilir. Ancak "5 dk kala planlama" ön koşulunu
        // burada tekrar uygulamak, yükleme uzadığında kullanıcının açıkça
        // istediği planı sessizce anlık paylaşıma çevirirdi. Yükleme sonrası
        // tek soru şudur: an hâlâ gelecekte mi? Yalnızca saat kayması payı
        // bırakılır.
        const POST_UPLOAD_SKEW_MS = 30 * 1000;
        const isFutureSchedule = !!schedISO
            && new Date(schedISO).getTime() > Date.now() + POST_UPLOAD_SKEW_MS;
        if (isFutureSchedule) {
            // scheduledFor MUTLAK bir an (UTC ISO). Sağlayıcının `timezone`
            // alanını bu metinle birleştirip yerel duvar saati olarak yorumlama
            // ihtimali var; o durumda 'Europe/Istanbul' göndermek anı UTC
            // ofseti kadar GERİYE kaydırır ve yakın planlar geçmişe düşüp
            // anında yayınlanır. İkisi de UTC olunca yorum ne olursa olsun
            // sonuç aynı andır. Kullanıcının seçtiği dilim yalnız panelde
            // gösterim içindir (edited_clips.publish_timezone).
            body.scheduledFor = schedISO;
            body.timezone = 'UTC';
        } else {
            body.publishNow = true;
        }

        let res;
        try {
            res = await axios.post(`${BASE_URL}/posts`, body, {
                headers: {
                    ...this._headers,
                    'Content-Type': 'application/json',
                    'x-request-id': requestId || crypto.randomUUID(),
                },
                timeout: 60000,
            });
        } catch (error) {
            const status = Number(error.response?.status) || 0;
            // POST sunucuya ulaştıktan sonra ağ koptuysa veya 5xx döndüyse dış
            // gönderi oluşmuş olabilir. Çağıran kod bunu retry'a açmamalı.
            error.publishOutcomeUnknown = status === 0 || status === 408 || status >= 500;
            throw error;
        }
        const post = res.data?.post || res.data?.existingPost || {};
        return {
            postId: post._id,
            status: post.status,
            scheduledFor: isFutureSchedule ? (post.scheduledFor || schedISO) : (post.scheduledFor || null),
            // Plan istendi ama an yükleme sırasında geçti → çağıran kod
            // kullanıcıya "planlanamadı, hemen paylaşıldı" diyebilsin.
            publishedImmediately: !!schedISO && !isFutureSchedule,
            platforms: normalizePlatformResults(post.platforms),
        };
    }

    /* ------------------------------------------------------------- taslak akışı */

    /**
     * Videoyu Zernio'ya yükleyip TASLAK gönderi oluşturur — hiçbir platforma
     * gitmez. `isDraft: true` sağlayıcıda publishNow/scheduledFor'un önüne
     * geçer; gönderi `publishDraft` çağrılana kadar taslak kalır.
     *
     * @param {object} p
     * @param {string} p.videoPath
     * @param {string} p.title - YouTube başlığı
     * @param {string} p.content - video açıklaması
     * @param {Array<{platform, accountId}>} p.accounts
     * @param {'public'|'unlisted'|'private'} [p.visibility]
     * @param {number} [p.uploadTimeoutMs] - büyük dosyalar için yükleme tavanı
     * @returns {Promise<{postId: string, status: string}>}
     */
    async createDraft({ videoPath, title, content, accounts, visibility = 'public', requestId = null, uploadTimeoutMs }) {
        if (!Array.isArray(accounts) || accounts.length === 0) {
            throw new Error('En az bir hesap seçilmeli');
        }
        const mediaUrl = await this.uploadVideo(videoPath, uploadTimeoutMs ? { maxTimeoutMs: uploadTimeoutMs } : {});
        const res = await axios.post(`${BASE_URL}/posts`, {
            ...ZernioPublisher.draftFields({ title, content, accounts, visibility }),
            mediaItems: [{ url: mediaUrl, type: 'video' }],
            isDraft: true,
        }, {
            headers: {
                ...this._headers,
                'Content-Type': 'application/json',
                'x-request-id': requestId || crypto.randomUUID(),
            },
            timeout: 60000,
        });
        const post = res.data?.post || res.data?.existingPost || {};
        if (!post._id) throw new Error('Zernio taslak kimliği döndürmedi');
        return { postId: post._id, status: post.status || 'draft' };
    }

    /**
     * Taslağı yayınlar. Başlık/açıklama/görünürlük verilirse gönderimden önce
     * güncellenir. `isDraft: false` ŞART: sağlayıcı bu alan olmadan yalnız
     * `publishNow` gelirse 200 dönüp gönderiyi taslak bırakıyor.
     *
     * @returns {Promise<{status: string, platforms: Array}>}
     */
    async publishDraft(postId, { title, content, accounts, visibility } = {}) {
        const id = encodeURIComponent(String(postId || ''));
        const alanlar = Array.isArray(accounts) && accounts.length
            ? ZernioPublisher.draftFields({ title, content, accounts, visibility })
            : {};
        let res;
        try {
            res = await axios.put(`${BASE_URL}/posts/${id}`, { ...alanlar, isDraft: false, publishNow: true }, {
                headers: { ...this._headers, 'Content-Type': 'application/json' },
                // Sağlayıcı videoyu bu istek içinde platforma aktarır; uzun kayıtta dakikalar sürer.
                timeout: 10 * 60 * 1000,
            });
        } catch (error) {
            const status = Number(error.response?.status) || 0;
            // İstek sunucuya ulaştıktan sonra koptuysa gönderim sürüyor olabilir —
            // çağıran kod yeniden göndermek yerine durumu sorgulamalı.
            error.publishOutcomeUnknown = status === 0 || status === 408 || status >= 500;
            throw error;
        }
        const post = res.data?.post || {};
        return { status: post.status, platforms: normalizePlatformResults(post.platforms) };
    }

    /** Taslak (ya da yayınlanmamış) gönderiyi Zernio'dan siler; yüklenen medya da gider. */
    async deletePost(postId) {
        const id = encodeURIComponent(String(postId || ''));
        await axios.delete(`${BASE_URL}/posts/${id}`, { headers: this._headers, timeout: 20000 });
    }

    /**
     * Taslak gövdesinin metin/hedef alanları (saf fonksiyon). YouTube başlığı
     * ve görünürlüğü üst düzeyde değil platformSpecificData'da taşınır.
     */
    static draftFields({ title, content, accounts, visibility = 'public' }) {
        const baslik = String(title || '').trim().slice(0, 100) || 'Yayın kaydı';
        const gorunurluk = ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'public';
        return {
            content: String(content || '').trim() || baslik,
            platforms: accounts.map(a => ({
                platform: a.platform,
                accountId: a.accountId,
                ...(a.platform === 'youtube' ? { platformSpecificData: { title: baslik, visibility: gorunurluk } } : {}),
            })),
        };
    }

    /**
     * Paylaşım durumunu sorgula
     */
    async getStatus(postId) {
        const id = encodeURIComponent(String(postId || ''));
        const res = await axios.get(`${BASE_URL}/posts/${id}`, { headers: this._headers, timeout: 15000 });
        const post = res.data?.post || {};
        return {
            status: post.status,
            scheduledFor: post.scheduledFor || null,
            publishedAt: post.publishedAt || null,
            platforms: normalizePlatformResults(post.platforms),
        };
    }

    /** TikTok hesabının izin verdiği gizlilik seçeneklerini getirir. */
    async getTikTokCreatorInfo(accountId) {
        const id = encodeURIComponent(String(accountId || ''));
        const res = await axios.get(`${BASE_URL}/accounts/${id}/tiktok/creator-info`, {
            headers: this._headers,
            params: { mediaType: 'video' },
            timeout: 15000,
        });
        return res.data || {};
    }
}

module.exports = ZernioPublisher;
