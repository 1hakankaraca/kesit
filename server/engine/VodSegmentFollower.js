/**
 * VodSegmentFollower — süren yayının Kick kaydından (VOD) geçmişe dönük kayıt.
 *
 * Canlı IVS playlist'i yalnız son ~30 saniyeyi taşır; "10 dakika öncesinden
 * başla" demek için geçmiş oradan alınamaz. Kick ise süren yayının kaydını da
 * (`is_live: true`) yayın başından o ana kadar listeler ve bu playlist yayın
 * akarken büyür (canlı ölçüm: ~12,7 sn'lik parçalar, canlıdan ~30 sn geride,
 * her parçada EXT-X-PROGRAM-DATE-TIME var).
 *
 * DİKKAT: Bu playlist her yüklendiğinde `#EXT-X-ENDLIST` ile BİTMİŞ gibi gelir
 * (anlık görüntü). ffmpeg'in HLS okuyucusu bu yüzden onu canlı diye izlemez —
 * o anki sonda durur. Takip burada elle yapılır: playlist periyodik yeniden
 * okunur, yeni parçalar indirilip sırayla tek bir .ts dosyasına eklenir.
 * MPEG-TS parçaları bayt düzeyinde uç uca eklenebildiğinden sonuç, canlı
 * kaydın ürettiğiyle aynı türde (yarıda kesilse de geçerli) bir dosyadır.
 *
 * İki kullanım:
 *  - "N dk öncesinden başla ve devam et": untilMs boş başlar, `stop()` gelene
 *    kadar izlenir;
 *  - "yalnız son N dk": untilMs = başlangıç anı; o ana kadarki parçalar inince
 *    kendiliğinden biter.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { BROWSER_HEADERS } = require('./KickClipFetcher');

const VOD_KAYNAK_DESENI = /^https:\/\/stream\.kick\.com\//;
// Parça başına bağlantı ~1,5-5 MB/sn ile sınırlı; birkaçı aynı anda inince
// geçmiş, gerçek zamandan birkaç kat hızlı kapanır.
const ESZAMANLI_INDIRME = 4;
const YOKLAMA_MS = 6000;
// "Durdur"dan sonra son parçanın playlist'e düşmesi beklenir (parça süresi +
// Kick'in yayınlama gecikmesi); bu kadar bekleyip gelmezse eldekiyle bitirilir.
const KAPANIS_BEKLEME_MS = 90_000;
// Hiç yeni parça gelmiyorsa yayın bitmiştir (ya da kayıt akışı durmuştur).
const DURGUNLUK_MS = 3 * 60_000;
const PARCA_DENEME = 3;

/**
 * Medya playlist'ini parçalara ayırır (saf fonksiyon).
 * Başlangıç anı EXT-X-PROGRAM-DATE-TIME'dan gelir; etiketi olmayan parça
 * öncekinin bitişinden devam eder. Hiç tarih yoksa `baseMs` (yayının başlangıç
 * saati) ilk parçanın başlangıcı sayılır.
 *
 * @param {string} metin
 * @param {string} playlistUrl - göreli parça adları buna göre çözülür
 * @param {{baseMs?: number|null}} [opts]
 * @returns {Array<{seq:number, url:string, startMs:number|null, durationSec:number}>}
 */
function parsePlaylist(metin, playlistUrl, { baseMs = null } = {}) {
    const parcalar = [];
    let sira = 0;
    let imlec = Number.isFinite(baseMs) ? baseMs : null;
    let sure = 0;

    for (const ham of String(metin || '').split('\n')) {
        const satir = ham.trim();
        if (!satir) continue;
        if (satir.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            sira = parseInt(satir.split(':')[1], 10) || 0;
        } else if (satir.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
            const an = Date.parse(satir.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
            if (Number.isFinite(an)) imlec = an;
        } else if (satir.startsWith('#EXTINF:')) {
            sure = parseFloat(satir.slice('#EXTINF:'.length)) || 0;
        } else if (!satir.startsWith('#')) {
            parcalar.push({
                seq: sira + parcalar.length,
                url: new URL(satir, playlistUrl).toString(),
                startMs: imlec,
                durationSec: sure,
            });
            if (imlec !== null) imlec += sure * 1000;
            sure = 0;
        }
    }
    return parcalar;
}

/**
 * `fromMs` anını içeren parçanın dizini (saf fonksiyon). An playlist'ten
 * önceyse 0 (yayın o kadar eski değil → baştan), sondan sonraysa son parça.
 */
function selectStartIndex(parcalar, fromMs) {
    if (!parcalar.length) return -1;
    const i = parcalar.findIndex(p => p.startMs !== null && p.startMs + p.durationSec * 1000 > fromMs);
    return i === -1 ? parcalar.length - 1 : i;
}

class VodSegmentFollower {
    /**
     * @param {object} p
     * @param {string} p.playlistUrl - VOD varyant playlist'i (stream.kick.com)
     * @param {string} p.outputPath - parçaların ekleneceği .ts dosyası
     * @param {number} p.fromMs - kaydın başlayacağı an (epoch ms)
     * @param {number|null} [p.untilMs] - kaydın biteceği an; boşsa `stop()` beklenir
     * @param {number|null} [p.baseMs] - playlist'te tarih yoksa yayının başlangıç anı
     * @param {object} [p.http] - axios uyumlu istemci (testte sahtelenir)
     */
    constructor({ playlistUrl, outputPath, fromMs, untilMs = null, baseMs = null, http = axios,
        pollMs = YOKLAMA_MS, drainMs = KAPANIS_BEKLEME_MS, stallMs = DURGUNLUK_MS }) {
        if (!VOD_KAYNAK_DESENI.test(String(playlistUrl || ''))) throw new Error('Geçersiz yayın kaydı kaynağı');
        this.playlistUrl = playlistUrl;
        this.outputPath = outputPath;
        this.fromMs = fromMs;
        this.untilMs = untilMs;
        this.baseMs = baseMs;
        this.http = http;
        this.pollMs = pollMs;
        this.drainMs = drainMs;
        this.stallMs = stallMs;

        this.bytes = 0;
        this.coveredSec = 0;      // dosyaya yazılan toplam süre
        this.firstStartMs = null; // kaydın gerçekte başladığı an (parça sınırına oturur)
        this.lastEndMs = null;

        this._sonrakiSira = null;
        this._iptal = false;
        this._bitisIstendiMs = untilMs !== null ? Date.now() : null;
        this._uyandir = null;
        this._done = null;
    }

    /** Kaydı bitiş anına göre tamamlanma oranı (0-1); bitiş anı yoksa null. */
    get progress() {
        if (this.untilMs === null || this.firstStartMs === null) return null;
        const hedef = this.untilMs - this.firstStartMs;
        return hedef > 0 ? Math.min(1, (this.coveredSec * 1000) / hedef) : 1;
    }

    get finishing() { return this.untilMs !== null; }

    /**
     * İzlemeyi başlatır.
     * @returns {Promise<{reason: 'completed'|'ended'|'aborted'|'error', error: string|null}>}
     */
    start() {
        if (!this._done) {
            fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
            fs.writeFileSync(this.outputPath, '');
            this._done = this._dongu().catch(err => ({ reason: 'error', error: err.message }));
        }
        return this._done;
    }

    /** Kaydı `untilMs` anına kadar tamamlayıp bitir (o ana kadarki parçalar beklenir). */
    stop(untilMs = Date.now()) {
        if (this.untilMs === null) {
            this.untilMs = untilMs;
            this._bitisIstendiMs = Date.now();
        }
        this._uyandir?.();
        return this._done;
    }

    /** Beklemeden kes — eldeki dosya olduğu gibi kalır. */
    abort() {
        this._iptal = true;
        this._uyandir?.();
        return this._done;
    }

    /* ------------------------------------------------------------- iç akış */

    async _dongu() {
        let sonIlerleme = Date.now();

        while (!this._iptal) {
            const parcalar = await this._playlistOku();

            if (this._sonrakiSira === null && parcalar.length) {
                this._sonrakiSira = parcalar[selectStartIndex(parcalar, this.fromMs)].seq;
            }

            const bekleyen = parcalar.filter(p => p.seq >= this._sonrakiSira
                && (this.untilMs === null || p.startMs === null || p.startMs < this.untilMs));

            for (let i = 0; i < bekleyen.length && !this._iptal; i += ESZAMANLI_INDIRME) {
                const grup = bekleyen.slice(i, i + ESZAMANLI_INDIRME);
                const veriler = await Promise.all(grup.map(p => this._parcaIndir(p.url)));
                for (const [j, veri] of veriler.entries()) {
                    await fs.promises.appendFile(this.outputPath, veri);
                    this._yazildi(grup[j], veri.length);
                }
                sonIlerleme = Date.now();
            }
            if (this._iptal) break;

            if (this.untilMs !== null) {
                if (this.lastEndMs !== null && this.lastEndMs >= this.untilMs) return { reason: 'completed', error: null };
                // Son parça playlist'e hiç düşmediyse (yayın tam o an kapandı) sonsuza dek bekleme
                if (Date.now() - Math.max(this._bitisIstendiMs, sonIlerleme) > this.drainMs) {
                    return { reason: 'completed', error: null };
                }
            } else if (Date.now() - sonIlerleme > this.stallMs) {
                return { reason: 'ended', error: null };
            }

            await this._bekle(this.pollMs);
        }
        return { reason: 'aborted', error: null };
    }

    _yazildi(parca, boyut) {
        this.bytes += boyut;
        this.coveredSec += parca.durationSec;
        this._sonrakiSira = parca.seq + 1;
        if (parca.startMs !== null) {
            if (this.firstStartMs === null) this.firstStartMs = parca.startMs;
            this.lastEndMs = parca.startMs + parca.durationSec * 1000;
        }
    }

    async _playlistOku() {
        const cevap = await this._dene(() => this.http.get(this.playlistUrl, {
            headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
            timeout: 15_000,
            responseType: 'text',
        }));
        return parsePlaylist(cevap.data, this.playlistUrl, { baseMs: this.baseMs });
    }

    async _parcaIndir(url) {
        if (!VOD_KAYNAK_DESENI.test(url)) throw new Error('Yayın kaydı beklenmeyen bir adrese yönlendirdi');
        const cevap = await this._dene(() => this.http.get(url, {
            headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
            timeout: 60_000,
            responseType: 'arraybuffer',
        }));
        return Buffer.from(cevap.data);
    }

    /** Geçici ağ hatalarında kısa aralıklarla yeniden dener; tükenince son hatayı fırlatır. */
    async _dene(istek) {
        let sonHata;
        for (let deneme = 1; deneme <= PARCA_DENEME; deneme++) {
            try {
                return await istek();
            } catch (err) {
                sonHata = err;
                if (this._iptal || deneme === PARCA_DENEME) break;
                await this._bekle(1500 * deneme);
            }
        }
        throw new Error(`Yayın kaydına ulaşılamadı: ${sonHata.message}`);
    }

    /** stop()/abort() ile erken uyandırılabilen bekleme. */
    _bekle(ms) {
        return new Promise(resolve => {
            const zamanlayici = setTimeout(bitir, ms);
            zamanlayici.unref?.();
            const self = this;
            function bitir() {
                clearTimeout(zamanlayici);
                self._uyandir = null;
                resolve();
            }
            this._uyandir = bitir;
        });
    }
}

module.exports = VodSegmentFollower;
module.exports.parsePlaylist = parsePlaylist;
module.exports.selectStartIndex = selectStartIndex;
