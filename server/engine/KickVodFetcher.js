/**
 * KickVodFetcher — kanalın geçmiş yayınlarını (VOD) listeler ve indirir.
 *
 * Kick'in resmi bir VOD API'si yok; `kick.com/api/v2/channels/{slug}/videos`
 * ters mühendislikle bulunmuş, her öğede doğrudan (auth gerektirmeyen)
 * master.m3u8 linkini (`source`) veriyor. Endpoint yalnızca kanalın en
 * son ~18 yayınını döndürüyor, sayfalama (cursor/offset/page) çalışmıyor —
 * bu Kick'in kendi VOD saklama sınırı, istemci tarafında çözülemez.
 *
 * DİKKAT: KickClipFetcher.js'teki Cloudflare uyarısı burada da geçerli —
 * aynı minimal header seti kullanılır, ekleme yapılmaz.
 */
const axios = require('axios');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { BROWSER_HEADERS, SLUG_PATTERN } = require('./KickClipFetcher');

// master.m3u8'deki GROUP-ID değerleri (Kick'in AWS IVS kaynaklı HLS'i sabit
// olarak bu adları kullanıyor). 'source' = master.m3u8'in kendisi — ffmpeg
// AUTOSELECT/DEFAULT işaretli varyantı (genelde en yüksek kalite) seçer.
const QUALITY_GROUP_IDS = { '1080p': '1080p60', '720p': '720p60', '480p': '480p30', '360p': '360p30' };

// GROUP-ID adları yayıncının kodlayıcısına göre değişebiliyor (ör. 1080p30).
// Bu yüzden GROUP-ID tutmazsa çözünürlük yüksekliğinden eşleştirilir.
const QUALITY_HEIGHTS = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 };

const GECERLI_KALITELER = ['source', '1080p', '720p', '480p', '360p'];

class KickVodFetcher {
    /**
     * Kanalın yayın kayıtlarını listele (en yeniden eskiye, en fazla ~18 kayıt).
     *
     * SÜREN yayının da bir kaydı vardır (`is_live: true`) ve `source` linki
     * yayın başından O ANA kadarki bölümü EVENT tipi playlist olarak verir —
     * yani yayın akarken geçmişi indirilebilir. Varsayılan olarak listelenmez
     * (Yayın Tarama yalnız bitmiş yayınları gösterir); canlı kayıt akışı
     * `includeLive: true` ile ister.
     *
     * @param {string} channelSlug
     * @param {{includeLive?: boolean}} opts
     * @returns {Array<{id, title, startedAt, durationSec, viewCount, thumbnailUrl, sourceUrl, isLive}>}
     */
    async listVideos(channelSlug, { includeLive = false } = {}) {
        const slug = String(channelSlug || '').trim().toLowerCase();
        if (!SLUG_PATTERN.test(slug)) {
            throw new Error('Geçersiz kanal adı');
        }

        let res;
        try {
            res = await axios.get(`https://kick.com/api/v2/channels/${slug}/videos`, {
                headers: BROWSER_HEADERS,
                timeout: 15000,
            });
        } catch (err) {
            if (err.response?.status === 404) {
                throw new Error(`"${slug}" kanalı bulunamadı`);
            }
            throw err;
        }

        const videos = Array.isArray(res.data) ? res.data : [];
        return videos
            .filter(v => v.source && (includeLive || !v.is_live))
            .map(v => ({
                id: v.id,
                title: v.session_title || '',
                startedAt: v.start_time || null,
                // Süren yayında `duration` 0 gelir (yayın bitmediği için) —
                // o ana kadarki uzunluk başlangıç saatinden hesaplanır ki
                // indirme ilerleme yüzdesi çalışsın.
                durationSec: v.is_live
                    ? KickVodFetcher._elapsedSec(v.start_time)
                    : Math.round((v.duration || 0) / 1000),
                viewCount: v.views || 0,
                thumbnailUrl: v.thumbnail?.src || '',
                sourceUrl: v.source,
                isLive: v.is_live === true,
            }));
    }

    /**
     * Kanalda SÜREN yayının kaydı (yoksa null). Kick `start_time`'ı UTC verir.
     */
    async getLiveVideo(channelSlug) {
        const videos = await this.listVideos(channelSlug, { includeLive: true });
        return videos.find(v => v.isLive) || null;
    }

    /** Master playlist'ten istenen kalitenin varyant adresi (geçmişe dönük kayıt bunu izler). */
    resolveVariantUrl(masterUrl, quality) {
        return this._resolveVariantUrl(masterUrl, quality);
    }

    /** "2026-09-16 18:14:00" (UTC) → şu ana kadar geçen saniye. */
    static _elapsedSec(startTime) {
        if (!startTime) return 0;
        const baslangic = Date.parse(String(startTime).replace(' ', 'T') + 'Z');
        if (!Number.isFinite(baslangic)) return 0;
        return Math.max(0, Math.round((Date.now() - baslangic) / 1000));
    }

    /**
     * master.m3u8'i indirip istenen kalite varyantının (720p/480p/360p)
     * doğrudan playlist URL'sini döndürür. Kick'in CDN'i burada segment
     * başına ~1.5MB/s ile sınırlı ölçüldü — 1080p60 kaynağı saatlerce süren
     * yayınlarda onlarca GB'a çıkıp indirmeyi gerçekçi olmayan sürelere
     * taşıyor; düşük kalite aynı süre için çok daha az veri gerektirir.
     * Varyant bulunamazsa (beklenmeyen playlist yapısı) orijinal master'a
     * sessizce düşülür — indirme yine de çalışsın diye.
     */
    async _resolveVariantUrl(masterUrl, quality) {
        const groupId = QUALITY_GROUP_IDS[quality];
        if (!groupId) return masterUrl;

        try {
            const res = await axios.get(masterUrl, { headers: BROWSER_HEADERS, timeout: 15000 });
            const lines = String(res.data).split('\n').map(l => l.trim());
            let cozunurlukEslesmesi = null;

            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
                const rel = lines[i + 1];
                if (!rel || rel.startsWith('#')) continue;

                if (lines[i].includes(`VIDEO="${groupId}"`)) {
                    return new URL(rel, masterUrl).toString();
                }
                // GROUP-ID adı farklıysa (ör. 1080p30) çözünürlükten yakala
                const m = lines[i].match(/RESOLUTION=\d+x(\d+)/);
                if (m && Number(m[1]) === QUALITY_HEIGHTS[quality]) {
                    cozunurlukEslesmesi = new URL(rel, masterUrl).toString();
                }
            }
            if (cozunurlukEslesmesi) return cozunurlukEslesmesi;
        } catch { /* çözülemezse master'a düş */ }
        return masterUrl;
    }

    /**
     * VOD'u mp4 olarak indir (HLS → stream copy, yeniden kodlama yok — hız
     * ve kalite kaybı olmaması için).
     *
     * Saatlerce sürebilen bir yayında ağ tıkanırsa/CDN bağlantısı donarsa
     * ffmpeg süresiz beklerdi (gerçek bir olayda 2 saat boyunca 0 byte
     * yazılmadan takılı kaldı) — bu yüzden ilerleme (`-progress`) izlenir;
     * belirli bir süre hiç ilerleme olmazsa süreç öldürülüp hata verilir.
     *
     * @param {string} sourceUrl - listVideos'tan gelen master.m3u8 linki
     * @param {string} outputPath
     * @param {object} opts
     *   - durationSec: VOD toplam süresi (yüzde hesaplamak için)
     *   - onProgress: (percent, {bytesDownloaded, speedBps}) => void — periyodik ilerleme bildirimi
     *   - stallTimeoutMs: bu süre boyunca hiç ilerleme olmazsa indirme iptal edilir (varsayılan 5dk)
     *   - quality: 'source'|'720p'|'480p'|'360p' — indirme kalitesi (varsayılan 720p, saatlerce süren
     *     yayınlarda indirme süresini ciddi kısaltır; 'source' orijinal en yüksek kaliteyi indirir)
     *   - signal: AbortSignal — kullanıcı elle iptal ederse indirme süreci anında öldürülür
     *   - onProcess: (proc: ChildProcess) => void — çağıran, süreci duraklatabilsin/devam
     *     ettirebilsin diye (SIGSTOP/SIGCONT) ffmpeg süreç referansını dışarı verir
     *   - isPaused: () => boolean — true dönerse stall-timer o tur sayılmaz (duraklatılmışken
     *     "ilerleme yok" diye otomatik iptal etmesin)
     * @returns {string} indirilen dosyanın yolu
     */
    async download(sourceUrl, outputPath, {
        durationSec = 0, onProgress, stallTimeoutMs = 5 * 60 * 1000, quality = '720p', signal, onProcess, isPaused,
    } = {}) {
        if (!sourceUrl || !/^https:\/\/stream\.kick\.com\//.test(sourceUrl)) {
            throw new Error('Geçersiz VOD kaynağı');
        }
        if (signal?.aborted) throw new Error('İndirme iptal edildi');
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const fetchUrl = await this._resolveVariantUrl(sourceUrl, quality);

        await new Promise((resolve, reject) => {
            const proc = childProcess.spawn('ffmpeg', [
                '-y', '-loglevel', 'error',
                '-user_agent', BROWSER_HEADERS['User-Agent'],
                '-i', fetchUrl,
                '-c', 'copy',
                '-movflags', '+faststart',
                '-progress', 'pipe:1', '-nostats',
                outputPath,
            ]);
            onProcess?.(proc);

            let stderr = '';
            let settled = false;
            let lastProgressAt = Date.now();
            const finish = (fn, arg) => {
                if (settled) return;
                settled = true;
                clearInterval(stallTimer);
                signal?.removeEventListener('abort', onAbort);
                fn(arg);
            };

            const onAbort = () => {
                proc.kill('SIGKILL');
                finish(reject, new Error('İndirme iptal edildi'));
            };
            signal?.addEventListener('abort', onAbort);

            const checkIntervalMs = Math.max(50, Math.min(15000, stallTimeoutMs / 3));
            const stallTimer = setInterval(() => {
                // Kullanıcı bilerek duraklattıysa "ilerleme yok" sayılmasın —
                // sayaç sürekli sıfırlanır, duraklatma süresince tetiklenmez.
                if (isPaused?.()) { lastProgressAt = Date.now(); return; }
                if (Date.now() - lastProgressAt > stallTimeoutMs) {
                    proc.kill('SIGKILL');
                    finish(reject, new Error(`VOD indirme durdu (${Math.round(stallTimeoutMs / 60000)} dk boyunca ilerleme yok) — bağlantı kesilmiş olabilir`));
                }
            }, checkIntervalMs);
            stallTimer.unref?.();

            let stdoutBuf = '';
            let lastSizeBytes = 0;
            let lastSampleAt = Date.now();
            // out_time= ve total_size= normalde aynı ffmpeg progress bloğunda
            // birlikte gelir, ama chunk sınırı teorik olarak ikisini ayırabilir —
            // percent'i her zaman SON bilinen değerde tutup NaN/undefined bildirimi
            // olmasın diye kalıcı (chunk'lar arası) bir değişkende saklanır.
            let lastKnownPercent;
            proc.stdout.on('data', chunk => {
                lastProgressAt = Date.now(); // ffmpeg canlı, en azından çıktı üretiyor
                stdoutBuf += chunk.toString();
                const lines = stdoutBuf.split('\n');
                stdoutBuf = lines.pop(); // son satır yarım olabilir, sakla

                let pendingMeta;
                for (const line of lines) {
                    const timeMatch = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
                    if (timeMatch && durationSec > 0) {
                        const sec = parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseFloat(timeMatch[3]);
                        lastKnownPercent = Math.max(0, Math.min(99, Math.round((sec / durationSec) * 100)));
                    }
                    const sizeMatch = line.match(/^total_size=(\d+)/);
                    if (sizeMatch) {
                        const size = parseInt(sizeMatch[1], 10);
                        const now = Date.now();
                        const elapsedSec = (now - lastSampleAt) / 1000;
                        // Çok kısa aralıkta örnekleme gürültülü hız üretir — en az ~0.5sn beklenir
                        if (elapsedSec >= 0.5) {
                            const speedBps = Math.max(0, (size - lastSizeBytes) / elapsedSec);
                            pendingMeta = { bytesDownloaded: size, speedBps };
                            lastSizeBytes = size;
                            lastSampleAt = now;
                        } else {
                            pendingMeta = { bytesDownloaded: size, speedBps: undefined };
                        }
                    }
                }
                // ffmpeg tek "chunk"ta birden çok satır gönderebilir — her satırda
                // değil, chunk başına en fazla 1 kez bildir (gereksiz çağrıyı önler)
                if (onProgress && (lastKnownPercent !== undefined || pendingMeta !== undefined)) {
                    onProgress(lastKnownPercent, pendingMeta);
                }
            });

            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', err => finish(reject, err));
            proc.on('exit', code => {
                if (code === 0) finish(resolve);
                else finish(reject, new Error(`VOD indirme hatası (code ${code}): ${stderr.slice(0, 300)}`));
            });
        });

        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 100000) {
            throw new Error('İndirilen VOD dosyası boş veya bozuk');
        }
        return outputPath;
    }
}

module.exports = KickVodFetcher;
module.exports.GECERLI_KALITELER = GECERLI_KALITELER;
