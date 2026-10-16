/**
 * StreamRecorder — canlı yayını baştan sona dosyaya kaydeder (kullanıcı başına bir kayıt).
 *
 * HlsRecorder'dan farkı: o, "son N dakika" dairesel tamponunu tutar (klip
 * kesmek için); bu ise kullanıcı "başlat" dediği andan "durdur" dediği ana
 * kadar yayının tamamını tek dosyaya yazar.
 *
 * Kayıt önce .ts olarak yazılır: MPEG-TS akışı sunucu çökse, ffmpeg öldürülse
 * ya da yayın koparsa bile geçerli kalır (MP4 olsaydı moov atomu yazılmadan
 * kesilen dosya tamamen okunamaz olurdu). "Durdur" denince akış yeniden
 * kodlanmadan (-c copy) saniyeler içinde .mp4'e sarmalanır.
 *
 * Yeniden kodlama yapılmaz: CPU maliyeti sıfıra yakındır, böylece aynı sunucu
 * üzerinde klip üretimi sürerken de kayıt alınabilir.
 *
 * Geçmişe dönük kayıt (`backfillSec`): canlı playlist yalnız son ~30 saniyeyi
 * taşıdığından geçmiş, Kick'in süren yayın için tuttuğu kayıttan alınır
 * (bkz. VodSegmentFollower). O yolda ffmpeg çalışmaz; parçalar aynı .ts
 * dosyasına eklenir ve bitiş yolu (_sonlandir) ortaktır.
 *
 * Kayıt 'ready' olunca ham dosya RecordingFinalizer'a devredilir (intro +
 * logo + hedef bit hızıyla "yayına hazır" çıktı).
 */
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { resolveLiveStream, HEDEF_YUKSEKLIK } = require('./KickLiveFetcher');
const { BROWSER_HEADERS } = require('./KickClipFetcher');
const KickVodFetcher = require('./KickVodFetcher');
const VodSegmentFollower = require('./VodSegmentFollower');

const CLIP_OUTPUT_DIR = process.env.CLIP_OUTPUT_DIR || 'data/clips';
// Kayıt saatte ~3,5 GB yer kaplıyor; sınırsız bırakılırsa tek bir unutulmuş
// kayıt diski doldurur. Süre dolunca kayıt kendiliğinden kapanır ve dosya
// normal şekilde MP4'e çevrilir — kullanıcı hiçbir şey kaybetmez.
const MAX_SURE_DK = parseInt(process.env.RECORDER_MAX_MINUTES) || 240;
const GECMIS_KALITE = '1080p';

class StreamRecorder {
    /**
     * @param {object} p
     * @param {{baslat: Function}|null} [p.finalizer] - hazır kaydı yayına hazır çıktıya çeviren hat
     * @param {object} [p.vodFetcher] - süren yayının kaydını çözer (testte sahtelenir)
     * @param {Function} [p.followerFactory] - VodSegmentFollower üretir (testte sahtelenir)
     */
    constructor({ db, io, userId, finalizer = null, vodFetcher = new KickVodFetcher(),
        followerFactory = secenekler => new VodSegmentFollower(secenekler) }) {
        this.db = db;
        this.io = io;
        this.userId = userId;
        this.finalizer = finalizer;
        this.vodFetcher = vodFetcher;
        this.followerFactory = followerFactory;
        this.takipci = null;     // geçmişe dönük kayıtta ffmpeg yerine çalışan parça takipçisi

        this.outputDir = path.join(CLIP_OUTPUT_DIR, String(userId), 'recordings');
        this.proc = null;
        this.aktif = null;       // { id, channelSlug, title, quality, tsPath, startedAt }
        this._durduruluyor = false;
        this._sureSiniriTimer = null;
    }

    get isRecording() { return this.proc !== null || this.takipci !== null; }

    /**
     * Kaydı başlat.
     *  - backfillSec yok: yayının O ANKİ canlı noktasından yeni dosya açılır;
     *  - backfillSec > 0, follow açık: o kadar öncesinden başlar, canlıyı izleyerek sürer;
     *  - backfillSec > 0, follow kapalı: yalnız o geçmiş dilimi alınır ve kayıt kendiliğinden biter.
     *
     * @param {string} channelSlug
     * @param {{backfillSec?: number, follow?: boolean}} [opts]
     * @returns {Promise<object>} oluşturulan kayıt satırı
     */
    async start(channelSlug, opts = {}) {
        // Çift istekte ilk ffmpeg süreci sahipsiz kalmasın: kaynak çözülürken ikinci başlatma reddedilir.
        if (this._starting) throw new Error('Kayıt zaten başlatılıyor');
        this._starting = true;
        try {
            return await this._start(channelSlug, opts);
        } finally {
            this._starting = false;
        }
    }

    async _start(channelSlug, { backfillSec = 0, follow = true } = {}) {
        if (this.isRecording) {
            throw new Error('Zaten süren bir kayıt var');
        }
        const gecmis = Math.min(MAX_SURE_DK * 60, Math.max(0, Math.round(Number(backfillSec) || 0)));
        if (gecmis > 0) return this._gecmistenBaslat(channelSlug, gecmis, follow !== false);
        if (follow === false) throw new Error('Yalnız geçmişi almak için bir süre seçin');

        const { url, height, title, masterUrl } = await resolveLiveStream(channelSlug, {
            targetHeight: HEDEF_YUKSEKLIK,
        });
        const quality = height ? `${height}p` : 'auto';

        const kayit = await this.db.createStreamRecording({
            userId: this.userId,
            channelSlug,
            title,
            quality,
        });

        fs.mkdirSync(this.outputDir, { recursive: true });
        // Dosya adı bilerek "rec-" önekli: RetentionService kota süpürmesinde
        // `<id>.mp4` desenini edited_clips kaydı sanıp korumaya almasın.
        const tsPath = path.join(this.outputDir, `rec-${kayit.id}.ts`);

        this.proc = childProcess.spawn('ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            '-user_agent', BROWSER_HEADERS['User-Agent'],
            // Canlı yayında CDN bağlantısı anlık koparsa ffmpeg kendi toparlasın.
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '10',
            '-i', url,
            '-c', 'copy',
            '-f', 'mpegts',
            '-y', tsPath,
        ], { stdio: ['pipe', 'ignore', 'pipe'] });

        this.aktif = {
            id: kayit.id,
            channelSlug,
            title,
            quality,
            tsPath,
            startedAt: Date.now(),
            // Panelde canlı önizleme: playlist sunucu üzerinden vekillenir (bkz.
            // api.js recorder/live) — Kick'in IVS playback token'ı yalnız kick.com
            // origin'ine CORS izni verdiğinden tarayıcı CDN'e doğrudan gidemez.
            playlistUrl: url,
            masterUrl,
        };
        this._durduruluyor = false;

        let sonHata = '';
        this.proc.stderr.on('data', veri => {
            sonHata = veri.toString().trim().slice(-500);
            console.error(`[StreamRecorder:${this.userId}] ${sonHata}`);
        });

        this.proc.on('error', err => {
            console.error(`[StreamRecorder:${this.userId}] ffmpeg başlatılamadı: ${err.message}`);
            this.proc = null;
            this._sureSiniriniTemizle();
            this._sonlandir({ hata: `Kayıt başlatılamadı: ${err.message}` }).catch(() => {});
        });

        this.proc.on('exit', (code) => {
            this.proc = null;
            // "durdur" kendi bekleme mantığını çalıştırıyor; burada yalnızca
            // beklenmedik çıkışlar (yayın kapandı, ağ koptu) ele alınır.
            if (this._durduruluyor) return;
            this._sureSiniriniTemizle();
            console.warn(`[StreamRecorder:${this.userId}] Kayıt beklenmedik şekilde bitti (kod ${code})`);
            this._sonlandir({
                hata: code === 0 ? null : `Yayın kesildi (ffmpeg kodu ${code})${sonHata ? ': ' + sonHata : ''}`,
            }).catch(err => console.error(`[StreamRecorder:${this.userId}] Sonlandırma hatası: ${err.message}`));
        });

        this._sureSiniriTimer = setTimeout(() => {
            console.warn(`[StreamRecorder:${this.userId}] ${MAX_SURE_DK} dk sınırına ulaşıldı, kayıt kapatılıyor`);
            this.stop().catch(() => {});
        }, MAX_SURE_DK * 60 * 1000);
        this._sureSiniriTimer.unref?.();

        this._yayinla('recorder:status', this.getStatus());
        console.log(`[StreamRecorder:${this.userId}] ✅ Kayıt başladı — ${channelSlug} (${quality})`);

        return { ...kayit, quality };
    }

    /**
     * Kaydı bitir, dosyayı MP4'e çevir ve kaydı 'ready' işaretle.
     * @returns {Promise<object|null>} tamamlanan kayıt satırı
     */
    async stop() {
        if (!this.isRecording) return null;

        if (this.takipci) {
            // Kayıt, "durdur" anına kadarki son parçalar inince kendiliğinden
            // biter (bkz. _gecmistenBaslat) — istek o kadar bekletilmez.
            this._sureSiniriniTemizle();
            this.takipci.stop();
            this._yayinla('recorder:status', this.getStatus());
            return { id: this.aktif?.id, finishing: true };
        }

        this._durduruluyor = true;
        this._sureSiniriniTemizle();

        const proc = this.proc;
        this.proc = null;

        await new Promise(resolve => {
            // 'q' ffmpeg'e akışı düzgün kapatmasını söyler; yanıt vermezse
            // önce SIGTERM, o da işe yaramazsa SIGKILL. Süreç çıkınca her iki
            // zamanlayıcı da iptal edilir — ölmüş sürece sinyal gitmesin.
            const term = setTimeout(() => proc.kill('SIGTERM'), 3000);
            const zorla = setTimeout(() => proc.kill('SIGKILL'), 8000);
            proc.once('exit', () => {
                clearTimeout(term);
                clearTimeout(zorla);
                resolve();
            });
            try { proc.stdin.write('q'); proc.stdin.end(); } catch { /* kapanmış olabilir */ }
        });

        return this._sonlandir({});
    }

    getStatus() {
        if (!this.aktif || !this.isRecording) {
            return { recording: false };
        }
        const ortak = {
            recording: true,
            id: this.aktif.id,
            channel: this.aktif.channelSlug,
            title: this.aktif.title,
            quality: this.aktif.quality,
            startedAt: this.aktif.startedAt,
            sizeBytes: dosyaBoyutu(this.aktif.tsPath),
            maxMinutes: MAX_SURE_DK,
            previewUrl: this.aktif.playlistUrl
                ? `/api/live/preview/playlist.m3u8?rec=${this.aktif.id}`
                : null,
        };
        if (this.takipci) {
            return {
                ...ortak,
                // Süre duvar saatinden değil dosyaya yazılandan okunur: geçmiş
                // gerçek zamandan hızlı iner, canlı kısım ~30 sn geriden gelir.
                elapsedSec: Math.floor(this.takipci.coveredSec),
                backfillSec: this.aktif.backfillSec,
                finishing: this.takipci.finishing,
                progress: this.takipci.progress,
            };
        }
        return { ...ortak, elapsedSec: Math.floor((Date.now() - this.aktif.startedAt) / 1000) };
    }

    /**
     * Canlı önizleme vekili için kaynak playlist (yalnız kayıt sürerken).
     * @returns {{playlistUrl: string, masterUrl: string}|null}
     */
    getLiveSource() {
        if (!this.isRecording || !this.aktif?.playlistUrl) return null;
        return { playlistUrl: this.aktif.playlistUrl, masterUrl: this.aktif.masterUrl };
    }

    /**
     * Sunucu kayıt sürerken kapandıysa DB'de 'recording' asılı kalan satırlar
     * olur. Açılışta çağrılır: yarım .ts dosyası varsa kurtarılıp MP4 yapılır,
     * yoksa kayıt 'failed' işaretlenir.
     */
    async recoverOrphans() {
        const asili = await this.db.getStreamRecordings(this.userId, 50)
            .then(list => list.filter(r => r.status === 'recording'))
            .catch(() => []);

        for (const kayit of asili) {
            const tsPath = path.join(this.outputDir, `rec-${kayit.id}.ts`);
            if (dosyaBoyutu(tsPath) > 0) {
                this.aktif = { id: kayit.id, tsPath, startedAt: new Date(kayit.started_at).getTime() };
                await this._sonlandir({ hata: 'Sunucu yeniden başladı, kayıt kesildi' }).catch(() => {});
                console.log(`[StreamRecorder:${this.userId}] Yarım kayıt #${kayit.id} kurtarıldı`);
            } else {
                try { fs.rmSync(tsPath, { force: true }); } catch { /* yok */ }
                await this.db.updateStreamRecording(kayit.id, this.userId, {
                    status: 'failed',
                    error: 'Sunucu yeniden başladığında kayıt kaybolmuştu',
                    completed_at: new Date(),
                }).catch(() => {});
            }
        }
        this.aktif = null;
    }

    destroy() {
        this._sureSiniriniTemizle();
        // Geçmişe dönük kayıt: beklemeden kes, eldeki dosya MP4'e çevrilir.
        this.takipci?.abort();
        if (this.proc) {
            // Session kapanıyor: kaydı düzgün bitirmeye çalış, dosya kurtulsun.
            this.stop().catch(() => {});
        }
    }

    /* ------------------------------------------------------------- iç akış */

    /**
     * Geçmişe dönük kayıt: süren yayının Kick'teki kaydından `gecmisSn` saniye
     * öncesinden başlar. Kanalda yayın kaydı kapalıysa geçmiş hiçbir yerde
     * durmadığından açık bir hata verilir.
     */
    async _gecmistenBaslat(channelSlug, gecmisSn, devamEt) {
        const video = await this.vodFetcher.getLiveVideo(channelSlug);
        if (!video) {
            throw new Error(`"${channelSlug}" yayında değil ya da kanalda yayın kaydı kapalı — geçmişe dönük kayıt alınamaz. "Şu andan itibaren" kaydedebilirsiniz.`);
        }
        const playlistUrl = await this.vodFetcher.resolveVariantUrl(video.sourceUrl, GECMIS_KALITE);
        // Canlı önizleme yalnız kayıt canlıyı izleyecekse anlamlı; çözülemezse kayıt yine alınır.
        const canli = devamEt
            ? await resolveLiveStream(channelSlug, { targetHeight: HEDEF_YUKSEKLIK }).catch(() => null)
            : null;
        const quality = /\/(\d{3,4})p\d*\//.exec(playlistUrl)?.[1]?.concat('p') || 'auto';

        const kayit = await this.db.createStreamRecording({
            userId: this.userId, channelSlug, title: video.title, quality,
        });
        const tsPath = path.join(this.outputDir, `rec-${kayit.id}.ts`);
        const simdi = Date.now();

        let takipci;
        try {
            takipci = this.followerFactory({
                playlistUrl,
                outputPath: tsPath,
                fromMs: simdi - gecmisSn * 1000,
                untilMs: devamEt ? null : simdi,
                baseMs: Date.parse(String(video.startedAt || '').replace(' ', 'T') + 'Z'),
            });
        } catch (err) {
            // Satır 'recording' durumunda asılı kalmasın
            await this.db.updateStreamRecording(kayit.id, this.userId, {
                status: 'failed', error: err.message, completed_at: new Date(),
            }).catch(() => {});
            throw err;
        }
        this.takipci = takipci;
        this.aktif = {
            id: kayit.id, channelSlug, title: video.title, quality, tsPath,
            startedAt: simdi,
            backfillSec: gecmisSn,
            playlistUrl: canli?.url || null,
            masterUrl: canli?.masterUrl || null,
        };
        this._durduruluyor = false;

        takipci.start().then(sonuc => {
            this.takipci = null;
            this._sureSiniriniTemizle();
            const hata = sonuc.reason === 'error' ? sonuc.error
                : sonuc.reason === 'ended' ? 'Yayın bitti ya da yayın kaydı akışı durdu'
                    : null;
            return this._sonlandir({ hata });
        }).catch(err => console.error(`[StreamRecorder:${this.userId}] Sonlandırma hatası: ${err.message}`));

        if (devamEt) {
            this._sureSiniriTimer = setTimeout(() => {
                console.warn(`[StreamRecorder:${this.userId}] ${MAX_SURE_DK} dk sınırına ulaşıldı, kayıt kapatılıyor`);
                this.stop().catch(() => {});
            }, MAX_SURE_DK * 60 * 1000);
            this._sureSiniriTimer.unref?.();
        }

        this._yayinla('recorder:status', this.getStatus());
        console.log(`[StreamRecorder:${this.userId}] ✅ Geçmişe dönük kayıt başladı — ${channelSlug} (${Math.round(gecmisSn / 60)} dk öncesi, ${devamEt ? 'canlı devam' : 'yalnız geçmiş'})`);
        return { ...kayit, quality };
    }

    /**
     * Ortak bitiriş yolu (elle durdurma, yayın kopması, restart kurtarma):
     * .ts → .mp4 sarmalar, süre/boyut ölçer, DB'yi günceller, panele haber verir.
     */
    async _sonlandir({ hata }) {
        const aktif = this.aktif;
        this.aktif = null;
        if (!aktif) return null;

        const { id, tsPath } = aktif;

        if (dosyaBoyutu(tsPath) === 0) {
            try { fs.rmSync(tsPath, { force: true }); } catch { /* yok */ }
            const guncel = await this.db.updateStreamRecording(id, this.userId, {
                status: 'failed',
                error: hata || 'Yayından hiç veri alınamadı',
                completed_at: new Date(),
            }).catch(() => null);
            this._yayinla('recorder:status', { recording: false });
            this._yayinla('recorder:finished', guncel);
            return guncel;
        }

        const mp4Path = path.join(this.outputDir, `rec-${id}.mp4`);
        try {
            await mp4eSarmala(tsPath, mp4Path);
            fs.rmSync(tsPath, { force: true });
        } catch (err) {
            // Ham .ts bilerek bırakılır — dosya oynatılabilir durumda ve
            // kullanıcının kaydı sırf sarmalama hatası yüzünden yok olmasın.
            console.error(`[StreamRecorder:${this.userId}] MP4 dönüşümü başarısız: ${err.message}`);
            const guncel = await this.db.updateStreamRecording(id, this.userId, {
                status: 'failed',
                error: `MP4'e çevrilemedi: ${err.message}`,
                completed_at: new Date(),
            }).catch(() => null);
            this._yayinla('recorder:status', { recording: false });
            this._yayinla('recorder:finished', guncel);
            return guncel;
        }

        const duration = await sureOku(mp4Path);
        const guncel = await this.db.updateStreamRecording(id, this.userId, {
            status: 'ready',
            file_path: mp4Path,
            file_size: dosyaBoyutu(mp4Path),
            // Dosya süresi duvar saatinden birkaç saniye uzundur: HLS canlı
            // playlist'i hazır bir tampon içerdiğinden kayıt "başlat" anından
            // biraz öncesinden başlar. Gerçek süre bu yüzden dosyadan okunur.
            duration_sec: Math.round(duration || (Date.now() - aktif.startedAt) / 1000),
            error: hata || null,
            completed_at: new Date(),
        }).catch(() => null);

        this._yayinla('recorder:status', { recording: false });
        this._yayinla('recorder:finished', guncel);
        // Ham kayıt hazır: yayına hazır çıktı (intro + logo + bit hızı) arka planda üretilir.
        if (guncel) {
            this.finalizer?.baslat(id, { otomatik: true })
                .catch(err => console.error(`[StreamRecorder:${this.userId}] Çıktı üretimi başlatılamadı: ${err.message}`));
        }
        console.log(`[StreamRecorder:${this.userId}] 💾 Kayıt #${id} hazır (${Math.round(dosyaBoyutu(mp4Path) / 1048576)} MB)`);
        return guncel;
    }

    _yayinla(olay, veri) {
        try { this.io?.to(`user:${this.userId}`).emit(olay, veri); } catch { /* socket yoksa sorun değil */ }
    }

    _sureSiniriniTemizle() {
        if (this._sureSiniriTimer) clearTimeout(this._sureSiniriTimer);
        this._sureSiniriTimer = null;
    }
}

/* ----------------------------------------------------------- ffmpeg yardımcıları */

function dosyaBoyutu(p) {
    try { return fs.statSync(p).size; } catch { return 0; }
}

/** MPEG-TS akışını yeniden kodlamadan MP4 kabına al (+faststart: web'de anında oynar). */
function mp4eSarmala(tsPath, mp4Path) {
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            '-i', tsPath,
            '-c', 'copy',
            '-movflags', '+faststart',
            '-y', mp4Path,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        let hata = '';
        proc.stderr.on('data', v => { hata += v.toString(); });
        proc.on('error', err => reject(new Error(`ffmpeg çalıştırılamadı: ${err.message}`)));
        proc.on('exit', code => code === 0
            ? resolve()
            : reject(new Error(`ffmpeg kodu ${code}: ${hata.trim().slice(0, 200)}`)));
    });
}

/** Videonun saniye cinsinden süresi; okunamazsa null. */
function sureOku(dosyaYolu) {
    return new Promise(resolve => {
        const proc = childProcess.spawn('ffprobe', [
            '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=nw=1:nk=1', dosyaYolu,
        ], { stdio: ['ignore', 'pipe', 'ignore'] });

        let cikti = '';
        proc.stdout.on('data', v => { cikti += v.toString(); });
        proc.on('error', () => resolve(null));
        proc.on('exit', () => {
            const saniye = parseFloat(cikti.trim());
            resolve(Number.isFinite(saniye) ? saniye : null);
        });
    });
}

module.exports = StreamRecorder;
// Kayıt düzenleyici (RecordingEditor) aynı ölçüm yardımcılarını kullanır.
module.exports.sureOku = sureOku;
module.exports.dosyaBoyutu = dosyaBoyutu;
// Yayın aralığı indirmesi (VodScanManager) parça takipçisinin .ts çıktısını aynı yolla MP4'e sarar.
module.exports.mp4eSarmala = mp4eSarmala;
