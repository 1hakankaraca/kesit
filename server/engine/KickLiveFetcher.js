/**
 * KickLiveFetcher — canlı yayının HLS adresini ve istenen kalitedeki
 * varyantını çözer.
 *
 * Kick'in resmi API'sinde canlı yayın manifestosu yok; `kick.com/api/v1/
 * channels/{slug}` ters mühendislikle bulunmuş ve `playback_url` ile AWS IVS
 * master playlist'ini veriyor.
 *
 * DİKKAT: `playback_url` yayın KAPALIYKEN DE dolu gelir (IVS uç noktası kanala
 * sabit bağlıdır) — canlılık yalnızca `livestream` alanından anlaşılır. Bu
 * kontrol atlanırsa master.m3u8 404 döner ve hata kullanıcıya "bağlantı
 * hatası" gibi yansır.
 *
 * KickClipFetcher'daki Cloudflare uyarısı burada da geçerli: aynı minimal
 * header seti kullanılır, ekleme yapılmaz.
 */
const axios = require('axios');
const { BROWSER_HEADERS, SLUG_PATTERN } = require('./KickClipFetcher');

const HEDEF_YUKSEKLIK = 1080;

/**
 * Kanalın canlı yayın bilgisi.
 * @returns {{masterUrl: string, title: string, viewerCount: number}}
 * @throws kanal yoksa, yayın kapalıysa veya API'ye ulaşılamazsa
 */
async function getLiveStream(channelSlug) {
    const slug = String(channelSlug || '').trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
        throw new Error('Geçersiz kanal adı');
    }

    let res;
    try {
        res = await axios.get(`https://kick.com/api/v1/channels/${slug}`, {
            headers: BROWSER_HEADERS,
            timeout: 10_000,
        });
    } catch (err) {
        if (err.response?.status === 404) throw new Error(`"${slug}" kanalı bulunamadı`);
        throw new Error(`Kick API'sine ulaşılamadı: ${err.message}`);
    }

    const yayin = res.data?.livestream;
    if (!yayin || yayin.is_live === false) {
        throw new Error(`"${slug}" şu anda yayında değil`);
    }

    const masterUrl = res.data?.playback_url;
    if (!masterUrl) throw new Error(`"${slug}" için yayın adresi alınamadı`);

    return {
        masterUrl,
        title: yayin.session_title || '',
        viewerCount: yayin.viewer_count || 0,
    };
}

/**
 * master.m3u8 içinden hedef çözünürlüğü AŞMAYAN en yüksek varyantı seçer.
 * Playlist beklenmedik bir yapıdaysa master URL'ye sessizce düşülür — ffmpeg
 * o zaman varsayılan (genelde en yüksek) varyantı kendisi seçer, yani kayıt
 * yine de çalışır; yalnız çözünürlük garantisi kalkar (height: null).
 *
 * @returns {{url: string, height: number|null}}
 */
async function resolveVariant(masterUrl, targetHeight = HEDEF_YUKSEKLIK) {
    try {
        const res = await axios.get(masterUrl, { headers: BROWSER_HEADERS, timeout: 15_000 });
        const satirlar = String(res.data).split('\n').map(l => l.trim());

        const varyantlar = [];
        for (let i = 0; i < satirlar.length; i++) {
            if (!satirlar[i].startsWith('#EXT-X-STREAM-INF')) continue;
            const hedef = satirlar[i + 1];
            if (!hedef || hedef.startsWith('#')) continue;

            const cozunurluk = satirlar[i].match(/RESOLUTION=(\d+)x(\d+)/);
            varyantlar.push({
                url: new URL(hedef, masterUrl).toString(),
                height: cozunurluk ? Number(cozunurluk[2]) : 0,
            });
        }

        const uygun = varyantlar
            .filter(v => v.height && v.height <= targetHeight)
            .sort((a, b) => b.height - a.height)[0];

        if (uygun) return uygun;
    } catch { /* çözülemezse master'a düş */ }

    return { url: masterUrl, height: null };
}

/**
 * Tek adımda: canlı yayını bul + hedef kalitedeki varyantı çöz.
 * @returns {{url: string, height: number|null, title: string, masterUrl: string}}
 */
async function resolveLiveStream(channelSlug, { targetHeight = HEDEF_YUKSEKLIK } = {}) {
    const { masterUrl, title } = await getLiveStream(channelSlug);
    const { url, height } = await resolveVariant(masterUrl, targetHeight);
    return { url, height, title, masterUrl };
}

module.exports = {
    getLiveStream,
    resolveVariant,
    resolveLiveStream,
    HEDEF_YUKSEKLIK,
};
