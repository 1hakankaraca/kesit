/**
 * KickClipFetcher — Kick kanalının popüler kliplerini listeler ve indirir
 *
 * Kick'in dahili API'si Cloudflare korumalıdır; curl engellenir ama
 * Node'un TLS parmak izi geçer — bu yüzden axios ile doğrudan erişilir.
 * Klip video_url'leri m3u8 playlist'tir, ffmpeg ile mp4'e indirilir.
 */
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// DİKKAT: Cloudflare, tam Chrome UA + Node TLS parmak izi uyuşmazlığını engelliyor.
// Bu minimal kombinasyon test edilmiş ve geçiyor — header eklemeyin.
const BROWSER_HEADERS = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};

const SLUG_PATTERN = /^[a-z0-9_-]{1,50}$/;

// KickBot MP4 indirme akışı (kickbot.com klip sayfasındaki "Download" butonu):
//  1. GET kickbot.com/api/get_clip_download_status?video_id={id} → download_exists
//  2. false ise GET kickbot.com/api/init_clip_download?clip_id={id} ile sunucuda MP4 oluşturmayı tetikle
//  3. Hazır olunca doğrudan: clips.kickbotcdn.com/kickbot-hls/{id}/{id}.mp4
const KICKBOT_MP4_PATTERN = /^https:\/\/clips\.kickbotcdn\.com\/kickbot-hls\/([a-z0-9]+)\/[a-z0-9]+\.mp4$/i;

function kickbotMp4Url(clipId) {
    return `https://clips.kickbotcdn.com/kickbot-hls/${clipId}/${clipId}.mp4`;
}

function kickbotHlsUrl(clipId) {
    return `https://clips.kickbotcdn.com/kickbot-hls/${clipId}/playlist.m3u8`;
}

function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** KickBot'un beklediği YYYY-MM-DD tarih aralığını üretir. */
function kickbotDateRange(time, now = new Date()) {
    const dayCount = { month: 30, week: 7, day: 1 }[time];
    if (!dayCount) return { startDate: '', endDate: '' };

    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(end);
    start.setDate(start.getDate() - dayCount);
    return { startDate: formatLocalDate(start), endDate: formatLocalDate(end) };
}

class KickClipFetcher {
    /**
     * Kanal kliplerinden bir sayfa getir (gezinme/sayfalama için)
     * @param {string} channelSlug
     * @param {object} opts - { cursor: 0, time: 'all'|'month'|'week'|'day', sort: 'view'|'date' }
     * @returns {{clips: Array, nextCursor: string|null}}
     */
    async browseClips(channelSlug, { cursor = 0, time = 'all', sort = 'view' } = {}) {
        const slug = String(channelSlug || '').trim().toLowerCase();
        if (!SLUG_PATTERN.test(slug)) {
            throw new Error('Geçersiz kanal adı');
        }
        const safeSort = ['view', 'date'].includes(sort) ? sort : 'view';
        const safeTime = ['all', 'month', 'week', 'day'].includes(time) ? time : 'all';
        const safeCursor = encodeURIComponent(String(cursor));

        const url = `https://kick.com/api/v2/channels/${slug}/clips?cursor=${safeCursor}&sort=${safeSort}&time=${safeTime}`;
        const res = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 15000 });

        const clips = (res.data?.clips || []).map(c => ({
            id: c.id,
            title: c.title || '',
            viewCount: c.view_count || c.views || 0,
            duration: c.duration || 0,
            videoUrl: c.video_url || c.clip_url,
            thumbnailUrl: c.thumbnail_url || '',
            createdAt: c.created_at || null,
        }));

        return { clips, nextCursor: res.data?.nextCursor || null };
    }

    /**
     * Kanalın en popüler kliplerini listele
     * @param {string} channelSlug
     * @param {object} opts - { limit: 10, time: 'all'|'month'|'week'|'day' }
     * @returns {Array<{id, title, viewCount, duration, videoUrl, thumbnailUrl, createdAt}>}
     */
    async listPopularClips(channelSlug, { limit = 10, time = 'all' } = {}) {
        const clips = [];
        let cursor = 0;

        while (clips.length < limit) {
            const page = await this.browseClips(channelSlug, { cursor, time });
            if (page.clips.length === 0) break;
            for (const c of page.clips) {
                clips.push(c);
                if (clips.length >= limit) break;
            }
            cursor = page.nextCursor;
            if (!cursor) break;
        }

        return clips;
    }

    /**
     * KickBot streamer_id çözümü — /clips/{slug} sayfasının SvelteKit data
     * bloğundan okunur, bellek içinde önbelleklenir.
     */
    async _kickbotStreamerId(channelSlug) {
        const slug = String(channelSlug || '').trim().toLowerCase();
        if (!SLUG_PATTERN.test(slug)) {
            throw new Error('Geçersiz kanal adı');
        }
        this._kbStreamerIds = this._kbStreamerIds || new Map();
        if (this._kbStreamerIds.has(slug)) return this._kbStreamerIds.get(slug);

        let res;
        try {
            res = await axios.get(`https://kickbot.com/clips/${slug}`, {
                headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
                timeout: 15000,
            });
        } catch (err) {
            // Ham "Request failed with status code 404" yerine anlaşılır mesaj
            if (err.response?.status === 404) {
                throw new Error(`"${slug}" kanalı KickBot'ta bulunamadı`);
            }
            throw err;
        }
        const m = String(res.data || '').match(/streamer_id:(\d+)/);
        if (!m) throw new Error(`"${slug}" kanalının KickBot klibi yok`);
        const id = parseInt(m[1], 10);
        this._kbStreamerIds.set(slug, id);
        return id;
    }

    /**
     * KickBot'taki kanal kliplerinden bir sayfa getir (gezgin için).
     * KickBot API: get_user_clips?streamer_id&offset&sort_by=views|date
     * @param {string} channelSlug
     * @param {object} opts - { offset: 0, sort: 'view'|'date', time: 'all'|'month'|'week'|'day' }
     * @returns {{clips: Array, nextCursor: number|null}}
     */
    async browseKickbotClips(channelSlug, { offset = 0, sort = 'view', time = 'all' } = {}) {
        const streamerId = await this._kickbotStreamerId(channelSlug);
        const off = Math.max(0, parseInt(offset, 10) || 0);
        const sortBy = sort === 'date' ? 'date' : 'views';
        const safeTime = ['all', 'month', 'week', 'day'].includes(time) ? time : 'all';
        const { startDate, endDate } = kickbotDateRange(safeTime);

        const params = new URLSearchParams({
            streamer_id: String(streamerId),
            offset: String(off),
            clipper_username: '',
            start_date: startDate,
            end_date: endDate,
            sort_by: sortBy,
            sort_order: 'desc',
            view_range: '',
            length_range: '',
        });
        const res = await axios.get(`https://kickbot.com/api/get_user_clips?${params}`, {
            headers: BROWSER_HEADERS,
            timeout: 15000,
        });

        const rawClips = res.data?.clips || [];
        // KickBot klip alındıktan sonra videoyu arka planda encode ediyor —
        // bu süreç bitene kadar length=0 dönüyor (doğrulandı: bu klipler için
        // get_clip_download_status da download_exists:false veriyor, yani
        // video dosyası henüz yok). Listede gösterilirlerse tıklanınca "boş"
        // klip gibi görünüp kafa karıştırıyorlardı — henüz hazır olmayanlar
        // elenir, KickBot işleyip length doldurunca bir sonraki listelemede
        // otomatik görünürler.
        const clips = rawClips
            .filter(c => (c.length || 0) > 0)
            .map(c => ({
                id: c.video_id,
                title: c.clipper_username ? `Klip — ${c.clipper_username}` : c.video_id,
                viewCount: c.views || 0,
                duration: c.length || 0,
                videoUrl: kickbotMp4Url(c.video_id),
                thumbnailUrl: `https://clips.kickbotcdn.com/kickbot-hls/${c.video_id}/first_frame.jpg`,
                createdAt: c.created_at || null,
                type: 'kickbot',
            }));

        // nextCursor HAM (filtrelenmemiş) sayıya göre ilerler — KickBot'un
        // kendi sayfalama offset'i buna göre çalışıyor, filtrelenmiş sayıya
        // göre ilerletilirse bazı klipler atlanır/tekrarlanır.
        return { clips, nextCursor: rawClips.length > 0 ? off + rawClips.length : null };
    }

    /**
     * Tek bir klibin bilgilerini getir (chatte tespit edilen klipler için)
     */
    async getClipInfo(clipId) {
        if (!/^clip_[A-Za-z0-9]+$/.test(clipId)) {
            throw new Error('Geçersiz klip ID');
        }
        const res = await axios.get(`https://kick.com/api/v2/clips/${clipId}`, {
            headers: BROWSER_HEADERS,
            timeout: 15000,
        });
        const c = res.data?.clip || res.data;
        if (!c) throw new Error('Klip bulunamadı');
        return {
            id: c.id,
            title: c.title || '',
            viewCount: c.view_count || 0,
            duration: c.duration || 0,
            videoUrl: c.video_url || c.clip_url,
            thumbnailUrl: c.thumbnail_url || '',
        };
    }

    /**
     * KickBot klibini çöz — KickBot klipleri Kick'in native klibi değildir,
     * ayrı CDN'de (clips.kickbotcdn.com) barınır. Sitedeki "Download" butonunun
     * kullandığı doğrudan MP4 adresini döndürür; MP4 sunucuda henüz yoksa
     * oluşturmayı şimdiden tetikler (asıl bekleme downloadClip aşamasında).
     * @param {string} clipId - kickbot.com/clip/{id} içindeki id
     * @returns {{videoUrl, title}}
     */
    async resolveKickbotClip(clipId) {
        if (!/^[a-z0-9]+$/i.test(clipId)) {
            throw new Error('Geçersiz KickBot klip ID');
        }

        // MP4 hazır değilse sunucuda oluşturmayı tetikle (fire-and-forget)
        this.primeKickbotDownload(clipId);

        let title = '';
        try {
            const res = await axios.get(`https://kickbot.com/clip/${clipId}`, {
                headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
                timeout: 15000,
            });
            const html = res.data || '';
            const titleMatch = html.match(/<meta[^>]+og:title[^>]+content="([^"]+)"/i)
                || html.match(/<title>([^<]+)<\/title>/i);
            title = titleMatch ? titleMatch[1].trim() : '';
        } catch { /* başlık opsiyonel — indirme MP4 URL'siyle devam eder */ }

        return { videoUrl: kickbotMp4Url(clipId), title };
    }

    /**
     * KickBot MP4'ünün sunucuda oluşturulmasını tetikle (idempotent, beklemez).
     * Klip panelde oynatılmadan/indirilmeden önce hazır olsun diye çağrılır.
     */
    primeKickbotDownload(clipId) {
        if (!/^[a-z0-9]+$/i.test(clipId)) return;
        axios.get(`https://kickbot.com/api/init_clip_download?clip_id=${clipId}`, {
            headers: BROWSER_HEADERS,
            timeout: 10000,
        }).catch(() => { /* en kötü ihtimalle indirme anında tekrar denenir */ });
    }

    /**
     * MP4 sunucuda hazır mı?
     */
    async _kickbotDownloadExists(clipId) {
        const res = await axios.get(`https://kickbot.com/api/get_clip_download_status?video_id=${clipId}`, {
            headers: BROWSER_HEADERS,
            timeout: 10000,
        });
        return res.data?.download_exists === true;
    }

    /**
     * MP4 hazır olana kadar tetikle + bekle (toplam ~45sn bütçe)
     * @returns {boolean} hazır mı
     */
    async _ensureKickbotMp4(clipId) {
        if (await this._kickbotDownloadExists(clipId).catch(() => false)) return true;
        this.primeKickbotDownload(clipId);
        const delays = [4000, 6000, 8000, 12000, 15000];
        for (const d of delays) {
            await new Promise(r => setTimeout(r, d));
            if (await this._kickbotDownloadExists(clipId).catch(() => false)) return true;
        }
        return false;
    }

    /**
     * Klibi mp4 olarak indir.
     * KickBot MP4 URL'lerinde önce sunucuda hazır olması beklenir, sonra doğrudan
     * HTTP ile indirilir; MP4 oluşmazsa HLS playlist'e (ffmpeg) düşülür.
     * Diğer .mp4 URL'leri doğrudan, m3u8 URL'leri ffmpeg ile indirilir.
     * @returns {string} indirilen dosyanın yolu
     */
    async downloadClip(videoUrl, outputPath) {
        if (!videoUrl || !/^https:\/\//.test(videoUrl)) {
            throw new Error('Geçersiz video URL');
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        const kickbotMatch = videoUrl.match(KICKBOT_MP4_PATTERN);
        if (kickbotMatch) {
            const clipId = kickbotMatch[1];
            if (await this._ensureKickbotMp4(clipId)) {
                await this._downloadHttp(videoUrl, outputPath);
            } else {
                await this._downloadHls(kickbotHlsUrl(clipId), outputPath);
            }
        } else if (/\.mp4(\?|$)/i.test(videoUrl)) {
            await this._downloadHttp(videoUrl, outputPath);
        } else {
            await this._downloadHls(videoUrl, outputPath);
        }

        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 10000) {
            throw new Error('İndirilen dosya boş veya bozuk');
        }
        return outputPath;
    }

    /**
     * Doğrudan HTTP dosya indirme (mp4)
     */
    async _downloadHttp(url, outputPath) {
        const res = await axios.get(url, {
            headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 3,
        });
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(outputPath);
            res.data.pipe(out);
            res.data.on('error', reject);
            out.on('error', reject);
            out.on('finish', resolve);
        });
    }

    /**
     * HLS playlist'i mp4'e indir (m3u8 → mp4, stream copy)
     */
    async _downloadHls(videoUrl, outputPath) {
        await new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', [
                '-y', '-loglevel', 'error',
                '-user_agent', BROWSER_HEADERS['User-Agent'],
                '-i', videoUrl,
                '-c', 'copy',
                '-movflags', '+faststart',
                outputPath,
            ]);

            let stderr = '';
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', reject);
            proc.on('exit', code => {
                if (code === 0) resolve();
                else reject(new Error(`ffmpeg indirme hatası (code ${code}): ${stderr.slice(0, 300)}`));
            });
        });
    }
}

module.exports = KickClipFetcher;
module.exports.BROWSER_HEADERS = BROWSER_HEADERS;
module.exports.SLUG_PATTERN = SLUG_PATTERN;
