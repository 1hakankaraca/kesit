/**
 * ClipCompressor — üretilmiş bir klibi ya da yayın kaydını indirmeden önce küçültür.
 *
 * Neden gerekli: kaynak Kick yayını 1080p60'ta ~9 Mbps geliyor ve klipler
 * `-c copy` ile kesildiği için aynı bitrate'i taşıyor (saatte ~3,9 GB). Bir
 * kesiti "10 Mbps" gibi kaynağın ÜSTÜNDE bir hedefle yeniden kodlamak dosyayı
 * küçültmez; hedefin kaynağın altında olması gerekir. Bu modül bunu hazır
 * profillerle yapar.
 *
 * Anahtar: klipler için sayısal iş id'si, yayın kayıtları için "rec-<id>"
 * (aynı önbellek dizinini paylaştıklarından çakışmasın diye).
 *
 * Çıktı önbelleklenir: aynı anahtar+profil ikinci kez istenirse yeniden
 * kodlama yapılmaz. Aynı anda gelen istekler tek işe bağlanır. İlerleme
 * ffmpeg'in `-progress` çıktısından okunup socket ile yayınlanır — saatlik
 * bir kaydın sıkıştırılması dakikalar sürebildiğinden panel yüzdeyi gösterir.
 *
 * Kalite seçimi: hedef bitrate (VBV ile sınırlı) kullanılır — CRF daha iyi
 * kalite/boyut verirdi ama boyutu öngörülemez kılar; buradaki amaç kullanıcının
 * "şu boyutun altına insin" ihtiyacı.
 */
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const CLIP_OUTPUT_DIR = process.env.CLIP_OUTPUT_DIR || 'data/clips';

// Kısa kenar hedefi + video bitrate. Kaynak ~9 Mbps olduğu için en yüksek
// profil bile belirgin küçülme sağlar (1080p: ~9 → 6 Mbps ≈ üçte bir tasarruf).
// bufsize = 2 × bitrate: ani hareketli sahnelerde kodlayıcıya nefes alanı
// bırakır, ortalama hedefi bozmadan kalite düşüşünü engeller.
const PROFILLER = {
    '1080p': { kisaKenar: 1080, videoBitrate: '6M', bufsize: '12M', sesBitrate: '160k', etiket: '1080p · ~6 Mbps' },
    '720p': { kisaKenar: 720, videoBitrate: '3M', bufsize: '6M', sesBitrate: '128k', etiket: '720p · ~3 Mbps' },
    '480p': { kisaKenar: 480, videoBitrate: '1500k', bufsize: '3000k', sesBitrate: '128k', etiket: '480p · ~1,5 Mbps' },
};

const ANAHTAR_DESENI = /^[A-Za-z0-9_-]{1,40}$/;

class ClipCompressor {
    constructor({ io, userId }) {
        this.io = io;
        this.userId = userId;
        this.outputDir = path.join(CLIP_OUTPUT_DIR, String(userId), 'compressed');
        /** @type {Map<string, {promise: Promise, proc: object|null, percent: number}>} devam eden işler */
        this._aktif = new Map();
    }

    static get PROFILLER() { return PROFILLER; }
    static gecerliProfil(ad) { return Object.prototype.hasOwnProperty.call(PROFILLER, ad); }
    static gecerliAnahtar(anahtar) { return ANAHTAR_DESENI.test(String(anahtar)); }

    /** Bu anahtar+profil için çıktı dosyasının yolu (var olmayabilir). */
    ciktiYolu(clipId, profil) {
        // Dosya adı bilerek "<anahtar>-<profil>.mp4": RetentionService'in
        // "<id>.mp4" desenli korumalı klip regex'ine TAKILMAZ, yani kota
        // baskısında bu türetilmiş dosya asıl klipten önce silinir.
        return path.join(this.outputDir, `${clipId}-${profil}.mp4`);
    }

    /**
     * Hazır mı? Kaynak dosya sıkıştırılmış çıktıdan yeniyse (klip yeniden
     * üretilmiş olabilir) önbellek geçersiz sayılır.
     */
    hazirMi(clipId, profil, kaynakYolu) {
        const cikti = this.ciktiYolu(clipId, profil);
        try {
            const c = fs.statSync(cikti);
            if (c.size === 0) return false;
            const k = fs.statSync(kaynakYolu);
            return c.mtimeMs >= k.mtimeMs;
        } catch {
            return false;
        }
    }

    isleniyorMu(clipId, profil) {
        return this._aktif.has(`${clipId}:${profil}`);
    }

    /** Süren işin yüzdesi (0-100); iş yoksa null. */
    ilerleme(clipId, profil) {
        const giris = this._aktif.get(`${clipId}:${profil}`);
        return giris ? giris.percent : null;
    }

    /**
     * Sıkıştırmayı başlat (zaten sürüyorsa aynı işe bağlanır, zaten hazırsa
     * hemen döner).
     * @returns {Promise<{path: string, sizeBytes: number}>}
     */
    async sikistir(clipId, profil, kaynakYolu) {
        if (!ClipCompressor.gecerliProfil(profil)) {
            throw new Error('Geçersiz kalite profili');
        }
        if (!ClipCompressor.gecerliAnahtar(clipId)) {
            throw new Error('Geçersiz sıkıştırma anahtarı');
        }
        if (!fs.existsSync(kaynakYolu)) {
            throw new Error('Kaynak dosya bulunamadı (süresi dolmuş olabilir)');
        }

        const cikti = this.ciktiYolu(clipId, profil);
        if (this.hazirMi(clipId, profil, kaynakYolu)) {
            return { path: cikti, sizeBytes: fs.statSync(cikti).size };
        }

        const anahtar = `${clipId}:${profil}`;
        const mevcut = this._aktif.get(anahtar);
        if (mevcut) return mevcut.promise;

        const giris = { proc: null, promise: null, percent: 0 };
        giris.promise = this._calistir(clipId, profil, kaynakYolu, cikti, giris)
            .finally(() => this._aktif.delete(anahtar));
        this._aktif.set(anahtar, giris);
        return giris.promise;
    }

    /** Devam eden sıkıştırmayı iptal et (kullanıcı vazgeçerse). */
    iptal(clipId, profil) {
        const giris = this._aktif.get(`${clipId}:${profil}`);
        if (!giris?.proc) return false;
        giris.proc.kill('SIGKILL');
        return true;
    }

    destroy() {
        for (const giris of this._aktif.values()) {
            try { giris.proc?.kill('SIGKILL'); } catch { /* ignore */ }
        }
        this._aktif.clear();
    }

    async _calistir(clipId, profil, kaynakYolu, ciktiYolu, giris) {
        const { kisaKenar, videoBitrate, bufsize, sesBitrate } = PROFILLER[profil];
        fs.mkdirSync(this.outputDir, { recursive: true });

        // Yüzde hesabı için toplam süre; okunamazsa ilerleme 0'da kalır, iş yine biter.
        const toplamSure = await sureOku(kaynakYolu);

        // Kısa kenarı hedefe indir, oranı koru, ASLA büyütme (min(...)).
        // Klipler hem dikey (1080x1920) hem yatay (1920x1080) olabildiği için
        // hangi kenarın kısa olduğu videodan videoya değişir.
        const scale = `scale='if(gt(iw,ih),-2,min(iw,${kisaKenar}))':'if(gt(iw,ih),min(ih,${kisaKenar}),-2)'`;

        await new Promise((resolve, reject) => {
            const proc = childProcess.spawn('ffmpeg', [
                '-hide_banner', '-loglevel', 'error',
                '-progress', 'pipe:1', '-nostats',
                '-i', kaynakYolu,
                '-vf', scale,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-b:v', videoBitrate,
                '-maxrate', videoBitrate,
                '-bufsize', bufsize,
                '-profile:v', 'high',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac',
                '-b:a', sesBitrate,
                '-movflags', '+faststart',
                '-y', ciktiYolu,
            ], { stdio: ['ignore', 'pipe', 'pipe'] });

            giris.proc = proc;

            let hata = '';
            let sonYayin = 0;
            let tampon = '';
            proc.stdout.on('data', v => {
                tampon += v.toString();
                const satirlar = tampon.split('\n');
                tampon = satirlar.pop();
                for (const satir of satirlar) {
                    const yuzde = ilerlemeYuzdesi(satir, toplamSure);
                    if (yuzde === null || yuzde <= giris.percent) continue;
                    giris.percent = yuzde;
                    // Socket'i boğmamak için saniyede en fazla bir yayın
                    const simdi = Date.now();
                    if (simdi - sonYayin >= 1000) {
                        sonYayin = simdi;
                        this._yayinla('clipcompress:progress', { clipId, profil, percent: yuzde });
                    }
                }
            });
            proc.stderr.on('data', v => { hata += v.toString(); });
            proc.on('error', err => reject(new Error(`ffmpeg çalıştırılamadı: ${err.message}`)));
            proc.on('exit', (code, signal) => {
                giris.proc = null;
                if (code === 0) return resolve();
                // Yarım kalan çıktı bırakma — sonraki istek onu "hazır" sanmasın.
                try { fs.unlinkSync(ciktiYolu); } catch { /* yok */ }
                const mesaj = signal
                    ? 'Sıkıştırma iptal edildi'
                    : `Sıkıştırma başarısız (ffmpeg ${code}): ${hata.trim().slice(0, 200)}`;
                this._yayinla('clipcompress:failed', { clipId, profil, error: mesaj });
                reject(new Error(mesaj));
            });
        });

        const sizeBytes = fs.statSync(ciktiYolu).size;
        giris.percent = 100;
        this._yayinla('clipcompress:done', { clipId, profil, sizeBytes });
        console.log(`[ClipCompressor:${this.userId}] ✅ ${clipId} → ${profil} (${Math.round(sizeBytes / 1048576)} MB)`);
        return { path: ciktiYolu, sizeBytes };
    }

    _yayinla(olay, veri) {
        try { this.io?.to(`user:${this.userId}`).emit(olay, veri); } catch { /* socket yoksa sorun değil */ }
    }
}

/* ----------------------------------------------------------- yardımcılar */

/**
 * ffmpeg -progress satırından yüzde çıkarır (saf fonksiyon).
 * "out_time_us=12345678" ya da eski sürümlerde "out_time_ms=..." (aslında µs).
 * @returns {number|null} 0-99 arası tam sayı; satır ilerleme satırı değilse null
 */
function ilerlemeYuzdesi(satir, toplamSure) {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(satir);
    if (!m || !toplamSure) return null;
    const saniye = Number(m[1]) / 1_000_000;
    return Math.max(0, Math.min(99, Math.floor((saniye / toplamSure) * 100)));
}

/** Videonun saniye cinsinden süresi; okunamazsa 0. */
function sureOku(dosyaYolu) {
    return new Promise(resolve => {
        const proc = childProcess.spawn('ffprobe', [
            '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=nw=1:nk=1', dosyaYolu,
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
        let cikti = '';
        proc.stdout.on('data', v => { cikti += v.toString(); });
        proc.on('error', () => resolve(0));
        proc.on('exit', () => {
            const saniye = parseFloat(cikti.trim());
            resolve(Number.isFinite(saniye) && saniye > 0 ? saniye : 0);
        });
    });
}

module.exports = ClipCompressor;
module.exports.ilerlemeYuzdesi = ilerlemeYuzdesi;
