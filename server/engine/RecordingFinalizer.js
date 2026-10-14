/**
 * RecordingFinalizer — ham yayın kaydını "yayına hazır" çıktıya çevirir.
 *
 * Gerçek zamanlı kayıt yeniden kodlanmadan alınır (~9 Mbps, saatte ~4 GB);
 * o hâliyle ne paylaşmaya ne saklamaya uygun. Kayıt bitince burada tek geçişte:
 *  - başına kullanıcının introsu eklenir (Yayın Tarama kesitleriyle aynı intro),
 *  - alt ortaya küçük, saydam bir logo bindirilir,
 *  - video hedef bit hızına (varsayılan 2,5 Mbps) indirilir.
 *
 * Ham dosya SİLİNMEZ: "Düzenle" ile alınan kesitler ondan kesilir (çıktıdan
 * kesilseydi klip hattı introyu ve logoyu ikinci kez eklerdi). Çıktı ayrı bir
 * dosyadır (`rec-<id>-yayin.mp4`) ve kayıt satırının final_* kolonlarında izlenir.
 *
 * Filtre grafiği HorizontalComposer.renderPlan'dan gelir — intro/logo
 * birleştirme kuralları (ölçü eşitleme, sessizlik doldurma) tek yerde durur.
 * Yeniden kodlama CPU'yu doldurduğundan kullanıcı başına aynı anda tek çıktı
 * üretilir; diğerleri sıraya girer.
 */
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const HorizontalComposer = require('./HorizontalComposer');
const IntroStore = require('./IntroStore');

const CLIP_OUTPUT_DIR = process.env.CLIP_OUTPUT_DIR || 'data/clips';
const COZUNURLUKLER = { source: null, '1080p': 1080, '720p': 720 };
// Logo alt ortada durur: yatayda ortalı, alt kenarı kadrajın altından %3 yukarıda.
// Alt kenardan hizalanır ki logo ne kadar büyütülürse büyütülsün kadrajda kalsın.
const LOGO_KONUM = { x: 0.5, y: 1, bottomMargin: 0.03 };
const SES_BIT_HIZI = '128k';

// Kodlayıcı × hız → ffmpeg ön ayarı. H.265 aynı kalitede ~%30-40 daha küçük
// dosya verir ama birkaç kat yavaş kodlanır; acelesi olmayan işler içindir.
// "fast" bilerek x264'te veryfast: kayıt biter bitmez çıkan varsayılan yol.
const KODLAYICILAR = {
    h264: { encoder: 'libx264', presets: { fast: 'veryfast', balanced: 'medium', quality: 'slow' } },
    hevc: { encoder: 'libx265', presets: { fast: 'fast', balanced: 'medium', quality: 'slow' } },
};
const HIZLAR = ['fast', 'balanced', 'quality'];

const VARSAYILAN_CIKTI = {
    auto: false,         // Kesit: kayıt bitince kendiliğinden ÜRETİLMEZ (ürün kararı) — çıktı elle başlatılır
    intro: true,         // intro yüklüyse başa ekle
    outro: true,         // outro yüklüyse sona ekle
    logo: true,          // logo yüklüyse alt ortaya bindir
    logoOpacity: 0.02,   // 0.01 - 1
    logoWidthPct: 6,     // logonun genişliği, video genişliğinin yüzdesi (2 - 30)
    bitrateMbps: 2.5,    // video bit hızı (1 - 8)
    resolution: 'source',
    codec: 'h264',       // h264 | hevc
    speed: 'fast',       // fast | balanced | quality — yavaşladıkça aynı bit hızında kalite artar
};

const sinirla = (deger, alt, ust, varsayilan) => {
    const n = Number(deger);
    return Number.isFinite(n) ? Math.min(ust, Math.max(alt, n)) : varsayilan;
};

/** Ham ayar nesnesini şemaya oturtur (saf fonksiyon) — bilinmeyen alanlar atılır. */
function normalizeOutputOptions(raw = {}) {
    const d = VARSAYILAN_CIKTI;
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
        auto: false, // Kesit: otomatik üretim seçeneği yok
        intro: r.intro === undefined ? d.intro : r.intro !== false,
        outro: r.outro === undefined ? d.outro : r.outro !== false,
        logo: r.logo === undefined ? d.logo : r.logo !== false,
        logoOpacity: Math.round(sinirla(r.logoOpacity, 0.01, 1, d.logoOpacity) * 100) / 100,
        logoWidthPct: Math.round(sinirla(r.logoWidthPct, 2, 30, d.logoWidthPct) * 10) / 10,
        bitrateMbps: Math.round(sinirla(r.bitrateMbps, 1, 8, d.bitrateMbps) * 10) / 10,
        resolution: Object.hasOwn(COZUNURLUKLER, r.resolution) ? r.resolution : d.resolution,
        codec: Object.hasOwn(KODLAYICILAR, r.codec) ? r.codec : d.codec,
        speed: HIZLAR.includes(r.speed) ? r.speed : d.speed,
    };
}

/**
 * Video kodlayıcı argümanları (saf fonksiyon). İkisinde de VBV ile ortalama ve
 * tepe hedefte tutulur — dosya boyutu öngörülebilir olur. libx265 VBV'yi
 * ffmpeg'in -maxrate/-bufsize bayraklarından almaz; x265-params ile verilir.
 * `hvc1` etiketi olmadan Safari/QuickTime H.265 MP4'ü oynatmaz.
 */
function videoArgs(options) {
    const { encoder, presets } = KODLAYICILAR[options.codec];
    const bitHizi = Math.round(options.bitrateMbps * 1000);
    const ortak = ['-c:v', encoder, '-preset', presets[options.speed], '-b:v', `${bitHizi}k`, '-pix_fmt', 'yuv420p'];
    return options.codec === 'hevc'
        ? [...ortak, '-x265-params', `vbv-maxrate=${bitHizi}:vbv-bufsize=${bitHizi * 2}:log-level=error`, '-tag:v', 'hvc1']
        : [...ortak, '-maxrate', `${bitHizi}k`, '-bufsize', `${bitHizi * 2}k`, '-profile:v', 'high'];
}

/** Bu makinedeki ffmpeg H.265 kodlayabiliyor mu? (süreç ömrü boyunca bir kez sorulur) */
let hevcSorgusu = null;
function hevcVarMi() {
    hevcSorgusu ??= new Promise(resolve => {
        childProcess.execFile('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 10_000 },
            (err, stdout) => resolve(!err && /\blibx265\b/.test(String(stdout))));
    });
    return hevcSorgusu;
}

/** Çıktı ölçüsü: hedef yükseklik kaynaktan küçükse oran korunarak indirilir, ASLA büyütülmez. */
function ciktiOlcusu(main, resolution) {
    const hedef = COZUNURLUKLER[resolution];
    if (!hedef || main.height <= hedef) return { width: main.width, height: main.height };
    return { width: Math.round(main.width * hedef / main.height / 2) * 2, height: hedef };
}

/**
 * ffmpeg argümanlarını kurar (saf fonksiyon).
 * Girdi sırası renderPlan'ın beklediği gibidir: kayıt, [logo], [intro], [outro], [sessizlik].
 *
 * @param {object} p
 * @param {{width,height,fps,hasAudio,duration}} p.main - ham kaydın akış bilgisi
 * @param {{hasAudio,duration}|null} [p.intro]
 * @param {{hasAudio,duration}|null} [p.outro]
 * @param {object} p.options - normalizeOutputOptions çıktısı
 */
function buildArgs({ inputPath, outputPath, logoPath = null, introPath = null, outroPath = null, main, intro = null, outro = null, options }) {
    const logo = logoPath ? {
        logoW: Math.max(2, Math.round(main.width * options.logoWidthPct / 100 / 2) * 2),
        opacity: options.logoOpacity,
        ...LOGO_KONUM,
    } : null;
    const plan = HorizontalComposer.renderPlan({
        main, intro: introPath ? intro : null, outro: outroPath ? outro : null, logo,
        output: ciktiOlcusu(main, options.resolution),
    });
    const args = ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-i', inputPath];
    if (logoPath) args.push('-i', logoPath);
    if (introPath) args.push('-i', introPath);
    if (outroPath) args.push('-i', outroPath);
    if (plan.needsSilence) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    args.push(
        '-filter_complex', plan.filterGraph,
        '-map', '[outv]', '-map', introPath || outroPath ? '[outa]' : '0:a?',
        ...videoArgs(options),
        '-c:a', 'aac', '-b:a', SES_BIT_HIZI,
        '-movflags', '+faststart',
        '-y', outputPath,
    );
    return args;
}

/** `-progress` satırından yüzde (0-99); ilgisiz satırda null. */
function ilerlemeYuzdesi(satir, toplamSure) {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(satir);
    if (!m || !(toplamSure > 0)) return null;
    return Math.max(0, Math.min(99, Math.floor((Number(m[1]) / 1e6 / toplamSure) * 100)));
}

class RecordingFinalizer {
    /**
     * @param {object} p
     * @param {Function} [p.probe] - akış bilgisi okur (testte sahtelenir)
     */
    constructor({ db, io, userId, probe = IntroStore.probe, hevcAvailable = hevcVarMi }) {
        this.hevcAvailable = hevcAvailable;
        this.db = db;
        this.io = io;
        this.userId = userId;
        this.probe = probe;
        this.outputDir = path.join(CLIP_OUTPUT_DIR, String(userId), 'recordings');
        this._aktif = new Map();           // kayıt id → { proc, percent, iptal }
        this._kuyruk = Promise.resolve();  // aynı anda tek yeniden kodlama
    }

    /** Kullanıcının kayıtlı çıktı ayarları (yoksa varsayılanlar). */
    async getOptions() {
        try {
            const ayarlar = await this.db.getSettings(this.userId);
            return normalizeOutputOptions(JSON.parse(ayarlar?.recording_output || '{}'));
        } catch {
            return normalizeOutputOptions();
        }
    }

    async saveOptions(raw) {
        const secenekler = normalizeOutputOptions(raw);
        await this.db.updateSettings(this.userId, { recording_output: JSON.stringify(secenekler) });
        return secenekler;
    }

    /** Logo, klip hattıyla aynı dosyadır (bkz. ClipEditorManager.getLogoPath). */
    logoYolu() {
        const p = path.join(CLIP_OUTPUT_DIR, String(this.userId), 'logo.png');
        return fs.existsSync(p) ? p : null;
    }

    ciktiYolu(kayitId) {
        return path.join(this.outputDir, `rec-${kayitId}-yayin.mp4`);
    }

    /** Süren üretimin yüzdesi; üretim yoksa null. */
    yuzde(kayitId) {
        return this._aktif.get(kayitId)?.percent ?? null;
    }

    /**
     * Çıktı üretimini sıraya alır; sonuç 'recorder:final' socket olayıyla bildirilir.
     *
     * @param {number} kayitId
     * @param {{otomatik?: boolean}} [p] - otomatik: kayıt bitişinden gelen çağrı; kullanıcı
     *   "kendiliğinden üret"i kapattıysa sessizce atlanır
     * @returns {Promise<object|null>} 'processing' işaretlenmiş kayıt satırı (atlandıysa null)
     */
    async baslat(kayitId, { otomatik = false } = {}) {
        const secenekler = await this.getOptions();
        if (otomatik && !secenekler.auto) return null;
        if (this._aktif.has(kayitId)) throw new Error('Bu kaydın çıktısı zaten üretiliyor');

        const kayit = await this.db.getStreamRecordingById(kayitId, this.userId);
        if (!kayit) throw new Error('Kayıt bulunamadı');
        if (kayit.status !== 'ready' || !kayit.file_path || !fs.existsSync(kayit.file_path)) {
            throw new Error('Yalnızca tamamlanmış ve dosyası duran kayıtların çıktısı üretilebilir');
        }

        const giris = { proc: null, percent: 0, iptal: false };
        this._aktif.set(kayitId, giris);
        let guncel;
        try {
            guncel = await this.db.updateStreamRecording(kayitId, this.userId, {
                final_status: 'processing', final_error: null,
            });
        } catch (err) {
            this._aktif.delete(kayitId);
            throw err;
        }
        this._bildir(kayitId, { status: 'processing', percent: 0 });

        this._kuyruk = this._kuyruk
            .then(() => this._uret(kayit, secenekler, giris))
            .finally(() => this._aktif.delete(kayitId));
        return guncel;
    }

    /** Süren (ya da sırada bekleyen) üretimi iptal eder. */
    iptal(kayitId) {
        const giris = this._aktif.get(kayitId);
        if (!giris) return false;
        giris.iptal = true;
        giris.proc?.kill('SIGKILL');
        return true;
    }

    /** Sunucu üretim sürerken kapandıysa 'processing' asılı kalan çıktıları işaretler. */
    async recoverOrphans() {
        const asili = await this.db.getStreamRecordings(this.userId, 50)
            // Bu süreçte üretilmekte olanlar (boot'ta kurtarılan kayıtlar) asılı değildir
            .then(list => list.filter(r => r.final_status === 'processing' && !this._aktif.has(r.id)))
            .catch(() => []);
        for (const kayit of asili) {
            try { fs.rmSync(this._geciciYol(kayit.id), { force: true }); } catch { /* yok */ }
            await this.db.updateStreamRecording(kayit.id, this.userId, {
                final_status: 'failed', final_error: 'Sunucu yeniden başladı, çıktı üretimi yarım kaldı',
            }).catch(() => {});
        }
    }

    destroy() {
        for (const giris of this._aktif.values()) {
            giris.iptal = true;
            try { giris.proc?.kill('SIGKILL'); } catch { /* ignore */ }
        }
    }

    /* ------------------------------------------------------------- iç akış */

    _geciciYol(kayitId) {
        return path.join(this.outputDir, `rec-${kayitId}-yayin.tmp.mp4`);
    }

    async _uret(kayit, secenekler, giris) {
        const gecici = this._geciciYol(kayit.id);
        const sonYol = this.ciktiYolu(kayit.id);
        try {
            if (giris.iptal) throw new Error('Çıktı üretimi iptal edildi');

            // H.265 seçili ama bu makinenin ffmpeg'inde yoksa çıktı hiç üretilmemesindense H.264'e düşülür
            if (secenekler.codec === 'hevc' && !(await this.hevcAvailable())) {
                console.warn(`[RecordingFinalizer:${this.userId}] libx265 yok — kayıt #${kayit.id} H.264 ile kodlanıyor`);
                secenekler = { ...secenekler, codec: 'h264' };
            }
            const logoPath = secenekler.logo ? this.logoYolu() : null;
            const introPath = secenekler.intro ? IntroStore.getIntroPath(this.userId) : null;
            const outroPath = secenekler.outro ? IntroStore.getOutroPath(this.userId) : null;
            const main = await this.probe(kayit.file_path);
            if (!main.width || !main.height) throw new Error('Kaydın çözünürlüğü okunamadı');
            const intro = introPath ? await this.probe(introPath) : null;
            const outro = outroPath ? await this.probe(outroPath) : null;

            const args = buildArgs({
                inputPath: kayit.file_path, outputPath: gecici, logoPath, introPath, outroPath, main, intro, outro, options: secenekler,
            });
            const toplamSure = (main.duration || 0) + (intro?.duration || 0) + (outro?.duration || 0);
            await this._ffmpeg(args, toplamSure, giris, kayit.id);
            fs.renameSync(gecici, sonYol);

            const guncel = await this.db.updateStreamRecording(kayit.id, this.userId, {
                final_status: 'ready',
                final_path: sonYol,
                final_size: fs.statSync(sonYol).size,
                final_error: null,
            });
            this._bildir(kayit.id, { status: 'ready', percent: 100, recording: guncel });
            console.log(`[RecordingFinalizer:${this.userId}] 🎞️ Kayıt #${kayit.id} çıktısı hazır (${Math.round(fs.statSync(sonYol).size / 1048576)} MB)`);
        } catch (err) {
            try { fs.rmSync(gecici, { force: true }); } catch { /* yok */ }
            const hata = (giris.iptal ? 'Çıktı üretimi iptal edildi' : `Çıktı üretilemedi: ${err.message}`).slice(0, 300);
            if (!giris.iptal) console.error(`[RecordingFinalizer:${this.userId}] Kayıt #${kayit.id}: ${err.message}`);
            const guncel = await this.db.updateStreamRecording(kayit.id, this.userId, {
                final_status: 'failed', final_error: hata,
            }).catch(() => null);
            this._bildir(kayit.id, { status: 'failed', error: hata, recording: guncel });
        }
    }

    _ffmpeg(args, toplamSure, giris, kayitId) {
        return new Promise((resolve, reject) => {
            const proc = childProcess.spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            giris.proc = proc;

            let hata = '';
            let tampon = '';
            let sonYayin = 0;
            proc.stdout.on('data', v => {
                tampon += v.toString();
                const satirlar = tampon.split('\n');
                tampon = satirlar.pop();
                for (const satir of satirlar) {
                    const yuzde = ilerlemeYuzdesi(satir, toplamSure);
                    if (yuzde === null || yuzde <= giris.percent) continue;
                    giris.percent = yuzde;
                    // Socket'i boğmamak için saniyede en fazla bir yayın
                    if (Date.now() - sonYayin >= 1000) {
                        sonYayin = Date.now();
                        this._bildir(kayitId, { status: 'processing', percent: yuzde });
                    }
                }
            });
            proc.stderr.on('data', v => { hata += v.toString(); });
            proc.on('error', err => reject(new Error(`ffmpeg çalıştırılamadı: ${err.message}`)));
            proc.on('exit', code => {
                giris.proc = null;
                if (code === 0) resolve();
                else reject(new Error(`ffmpeg kodu ${code}: ${hata.trim().slice(0, 200)}`));
            });
        });
    }

    _bildir(kayitId, veri) {
        try {
            this.io?.to(`user:${this.userId}`).emit('recorder:final', { recordingId: kayitId, ...veri });
        } catch { /* socket yoksa sorun değil */ }
    }
}

module.exports = RecordingFinalizer;
module.exports.normalizeOutputOptions = normalizeOutputOptions;
module.exports.buildArgs = buildArgs;
module.exports.ciktiOlcusu = ciktiOlcusu;
module.exports.VARSAYILAN_CIKTI = VARSAYILAN_CIKTI;
module.exports.hevcVarMi = hevcVarMi;
