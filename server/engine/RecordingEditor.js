/**
 * RecordingEditor — gerçek zamanlı yayın kayıtlarında kırpma ve kesme.
 *
 * Kullanıcı panelde kaydın başını/sonunu kırpar (trim) ve ortadan istemediği
 * aralıkları işaretler (kesme). Burada geriye kalan "korunan" aralıklar
 * hesaplanır, her biri yeniden kodlanmadan (-c copy) ayrı bir MPEG-TS
 * parçasına alınır ve parçalar tek MP4'te birleştirilir.
 *
 * Yeniden kodlama yapılmadığından saatlik bir kayıt bile saniyeler içinde
 * işlenir; bedeli, kesim noktalarının en yakın anahtar kareye (Kick'te
 * ~2 sn) oturmasıdır. Yayın kaydı için bu hassasiyet yeterli.
 *
 * İki kayıt modu vardır:
 *  - kopya (varsayılan): sonuç yeni bir kayıt satırı olarak eklenir, orijinal durur;
 *  - üzerine yaz: sonuç geçici dosyaya yazılır, bitince orijinalin yerine taşınır —
 *    işlem yarıda kalırsa orijinal dosya bozulmaz.
 *
 * Ayrıca kayıttan işaretlenen kesitler ayrı parçalar olarak alınabilir
 * (exportSegments): her kesit kendi dosyasına kesilir ve VOD editöründeki
 * manuel kesitlerle aynı şekilde klip hattına (yatay kesit / dikey klip) devredilir.
 */
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { sureOku, dosyaBoyutu } = require('./StreamRecorder');
const CamFull = require('./CamFull');

const CLIP_OUTPUT_DIR = process.env.CLIP_OUTPUT_DIR || 'data/clips';
// Bundan kısa aralıklar anlamsız: -c copy kesimi zaten anahtar kareye oturur.
const MIN_ARALIK_SN = 1;
const MAX_KESIT = 100;
const CIKTI_FORMATLARI = ['horizontal', 'vertical'];

/**
 * Kırpma + kesme talimatından korunacak aralıkları hesaplar (saf fonksiyon).
 *
 * @param {number} sure - kaydın saniye cinsinden süresi
 * @param {object} talimat
 * @param {number} [talimat.trimStart=0] - baştan kırpılacak nokta
 * @param {number} [talimat.trimEnd=sure] - sondan kırpılacak nokta
 * @param {Array<{start:number,end:number}>} [talimat.cuts=[]] - ortadan çıkarılacak aralıklar
 * @returns {Array<{start:number,end:number}>} sıralı, çakışmasız korunan aralıklar
 */
function korunanAraliklar(sure, { trimStart = 0, trimEnd = sure, cuts = [] } = {}) {
    if (!Number.isFinite(sure) || sure <= 0) return [];

    const sinirla = v => Math.max(0, Math.min(sure, Number(v)));
    const bas = sinirla(Number.isFinite(Number(trimStart)) ? trimStart : 0);
    const son = sinirla(Number.isFinite(Number(trimEnd)) ? trimEnd : sure);
    if (son - bas < MIN_ARALIK_SN) return [];

    // Kesilecek aralıkları kırpma penceresine sıkıştır, sırala, çakışanları birleştir.
    const kesilenler = (Array.isArray(cuts) ? cuts : [])
        .map(c => ({ start: Math.max(bas, sinirla(c?.start)), end: Math.min(son, sinirla(c?.end)) }))
        .filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
        .sort((a, b) => a.start - b.start)
        .reduce((birlesik, c) => {
            const onceki = birlesik[birlesik.length - 1];
            if (onceki && c.start <= onceki.end) onceki.end = Math.max(onceki.end, c.end);
            else birlesik.push({ ...c });
            return birlesik;
        }, []);

    const korunan = [];
    let imlec = bas;
    for (const c of kesilenler) {
        if (c.start - imlec >= MIN_ARALIK_SN) korunan.push({ start: imlec, end: c.start });
        imlec = Math.max(imlec, c.end);
    }
    if (son - imlec >= MIN_ARALIK_SN) korunan.push({ start: imlec, end: son });
    return korunan;
}

/**
 * Parça olarak alınacak kesitleri doğrular (saf fonksiyon): süreye sıkıştırır,
 * 1 sn'den kısaları atar, başlangıca göre sıralar. Çakışan kesitler bilerek
 * BİRLEŞTİRİLMEZ — kullanıcı aynı anı iki ayrı parçada isteyebilir.
 *
 * @param {number} sure
 * @param {Array<{start:number,end:number}>} kesitler
 * @returns {Array<{start:number,end:number}>}
 */
function gecerliKesitler(sure, kesitler) {
    if (!Number.isFinite(sure) || sure <= 0 || !Array.isArray(kesitler)) return [];
    return kesitler
        .map(k => ({
            start: Math.max(0, Math.min(sure, Number(k?.start))),
            end: Math.max(0, Math.min(sure, Number(k?.end))),
            // Tam ekran bölgeleri (kayıt saniyesi) — kesit dosyasına çevrimi _kesitleriIsle'de
            camFull: Array.isArray(k?.camFull) ? k.camFull : [],
        }))
        .filter(k => Number.isFinite(k.start) && Number.isFinite(k.end) && k.end - k.start >= MIN_ARALIK_SN)
        .sort((a, b) => a.start - b.start);
}

/** Varsayılan klip hattı: kayıttaki kanalın adıyla ayrı bir ClipEditorManager (VodScanManager ile aynı desen). */
function varsayilanKlipHatti({ db, io, userId, channelSlug }) {
    const ClipEditorManager = require('./ClipEditorManager');
    return new ClipEditorManager({ db, io, userId, channelSlug });
}

class RecordingEditor {
    /**
     * @param {object} p
     * @param {Function} [p.clipEditorFactory] - kesitleri klip hattına devreden nesneyi üretir (testte sahtelenir)
     */
    constructor({ db, io, userId, clipEditorFactory = varsayilanKlipHatti }) {
        this.db = db;
        this.io = io;
        this.userId = userId;
        this.clipEditorFactory = clipEditorFactory;
        this.outputDir = path.join(CLIP_OUTPUT_DIR, String(userId), 'recordings');
        // Kesit dosyaları klip hattı arka planda işleyene kadar durmalı —
        // RetentionService bu dizindeki artıkları 24 saat sonra temizler.
        this.segmentDir = path.join(CLIP_OUTPUT_DIR, String(userId), 'recording-work');
        // Aynı kaynak kayıt üzerinde eşzamanlı iki düzenleme (özellikle "üzerine
        // yaz") dosyayı yarışa sokar — kaynak id'si işlem bitene kadar kilitlenir.
        this._kilitli = new Set();
        // Kesitleri alınmakta olan kayıtlar — bu sırada "üzerine yaz" dosyayı değiştirmesin.
        this._aktarimda = new Set();
    }

    /**
     * Düzenlemeyi doğrular, hedef kaydı 'processing' olarak açar ve işlemi
     * arka planda başlatır. Sonuç socket ile 'recorder:edited' olarak bildirilir.
     *
     * @param {number} kayitId
     * @param {object} talimat - { trimStart, trimEnd, cuts, replace }
     * @returns {Promise<object>} işlenmekte olan hedef kayıt satırı
     */
    async edit(kayitId, { trimStart, trimEnd, cuts, replace = false } = {}) {
        if (this._kilitli.has(kayitId)) {
            throw new Error('Bu kayıt zaten düzenleniyor — bitmesini bekleyin');
        }
        if (replace && this._aktarimda.has(kayitId)) {
            throw new Error('Kayıttan kesitler alınıyor — bitince üzerine yazabilirsiniz');
        }

        const kaynak = await this._hazirKayit(kayitId);
        const sure = (await sureOku(kaynak.file_path)) || Number(kaynak.duration_sec) || 0;
        const araliklar = korunanAraliklar(sure, { trimStart, trimEnd, cuts });
        if (araliklar.length === 0) {
            throw new Error('Düzenleme sonrası geriye bir şey kalmıyor — kırpma/kesme aralıklarını kontrol edin');
        }
        const korunanSure = araliklar.reduce((t, a) => t + (a.end - a.start), 0);
        if (sure - korunanSure < MIN_ARALIK_SN) {
            throw new Error('Kırpılacak ya da kesilecek bir aralık işaretlenmedi');
        }

        this._kilitli.add(kayitId);
        let hedef;
        try {
            hedef = replace
                ? await this.db.updateStreamRecording(kayitId, this.userId, { status: 'processing', error: null })
                : await this.db.createStreamRecording({
                    userId: this.userId,
                    channelSlug: kaynak.channel_slug,
                    title: kaynak.title ? `${kaynak.title} (düzenlendi)` : 'Düzenlenmiş kayıt',
                    quality: kaynak.quality,
                    status: 'processing',
                    startedAt: kaynak.started_at,
                });
        } catch (err) {
            this._kilitli.delete(kayitId);
            throw err;
        }

        this._isle(kaynak, hedef, araliklar, replace)
            .finally(() => this._kilitli.delete(kayitId));

        return hedef;
    }

    /**
     * İşaretlenen kesitleri ayrı parçalar olarak klip hattına gönderir.
     * Doğrulama senkron yapılır; kesme + kuyruğa alma arka planda sürer,
     * ilerleme 'recorder:segments' socket olayıyla bildirilir.
     *
     * @param {number} kayitId
     * @param {object} p - { segments: [{start,end}], outputFormat: 'horizontal'|'vertical', options }
     *   options: tek seferlik üretim override'ı (ör. { intro: false }) — grup
     *   varsayılanlarının üstüne yazılır, ClipEditorManager.normalizeClipOptions süzer.
     * @returns {Promise<{ total: number }>}
     */
    async exportSegments(kayitId, { segments, outputFormat = 'horizontal', options = null } = {}) {
        if (!CIKTI_FORMATLARI.includes(outputFormat)) throw new Error('Geçersiz çıktı biçimi');
        if (options !== null && (typeof options !== 'object' || Array.isArray(options))) throw new Error('Geçersiz seçenekler');
        if (!Array.isArray(segments) || segments.length === 0) throw new Error('En az bir kesit ekleyin');
        if (segments.length > MAX_KESIT) throw new Error(`Tek seferde en fazla ${MAX_KESIT} kesit alınabilir`);
        if (this._kilitli.has(kayitId)) throw new Error('Bu kayıt düzenleniyor — bitmesini bekleyin');

        const kaynak = await this._hazirKayit(kayitId);
        const sure = (await sureOku(kaynak.file_path)) || Number(kaynak.duration_sec) || 0;
        const kesitler = gecerliKesitler(sure, segments);
        if (kesitler.length === 0) {
            throw new Error('Geçerli bir kesit bulunamadı — her kesit en az 1 saniye olmalı');
        }

        this._aktarimda.add(kayitId);
        this._kesitleriIsle(kaynak, kesitler, outputFormat, options || {})
            .catch(err => console.error(`[RecordingEditor:${this.userId}] Kesit aktarımı hatası: ${err.message}`))
            .finally(() => this._aktarimda.delete(kayitId));
        return { total: kesitler.length };
    }

    /**
     * Sunucu düzenleme sürerken kapandıysa 'processing' asılı kalan satırları
     * toparlar. "Üzerine yaz" modunda orijinal dosya hiç ellenmediği için kayıt
     * hazır durumuna geri alınır; yarım kalan kopyalar ise başarısız sayılır.
     */
    async recoverOrphans() {
        const asili = await this.db.getStreamRecordings(this.userId, 50)
            .then(list => list.filter(r => r.status === 'processing'))
            .catch(() => []);

        for (const kayit of asili) {
            const dosyaDuruyor = !!kayit.file_path && fs.existsSync(kayit.file_path);
            await this.db.updateStreamRecording(kayit.id, this.userId, dosyaDuruyor
                ? { status: 'ready', error: 'Sunucu yeniden başladı, düzenleme uygulanamadı' }
                : { status: 'failed', error: 'Sunucu yeniden başladı, düzenleme yarım kaldı', completed_at: new Date() },
            ).catch(() => {});
        }
    }

    /* ------------------------------------------------------------- iç akış */

    async _hazirKayit(kayitId) {
        const kaynak = await this.db.getStreamRecordingById(kayitId, this.userId);
        if (!kaynak) throw new Error('Kayıt bulunamadı');
        if (kaynak.status !== 'ready' || !kaynak.file_path || !fs.existsSync(kaynak.file_path)) {
            throw new Error('Yalnızca tamamlanmış ve dosyası duran kayıtlar düzenlenebilir');
        }
        return kaynak;
    }

    async _kesitleriIsle(kaynak, kesitler, outputFormat, secenekler = {}) {
        const dikey = outputFormat === 'vertical';
        const hat = this.clipEditorFactory({
            db: this.db, io: this.io, userId: this.userId, channelSlug: kaynak.channel_slug,
        });
        const dizin = path.join(this.segmentDir, `rec-${kaynak.id}`);
        fs.mkdirSync(dizin, { recursive: true });
        const damga = Date.now();

        let tamam = 0;
        let hatali = 0;
        const bildir = (bitti) => this._yayinla('recorder:segments', {
            recordingId: kaynak.id, total: kesitler.length, done: tamam, failed: hatali, finished: bitti,
        });

        for (const [i, k] of kesitler.entries()) {
            const dosya = path.join(dizin, `kesit-${damga}-${i + 1}.mp4`);
            try {
                await kesitCikar(kaynak.file_path, dosya, k.start, k.end - k.start);
                const kesitSecenekleri = { ...secenekler, outputFormat };
                if (k.camFull.length) {
                    // Dosya istenen andan değil ondan önceki anahtar kareden başlar
                    const dosyaBasi = await CamFull.keyframeBefore(kaynak.file_path, k.start);
                    kesitSecenekleri.camFullRanges = CamFull.toRelative(k.camFull, { fileStart: dosyaBasi, cutStart: k.start, cutEnd: k.end });
                }
                await hat.enqueueLocalClip(dosya, {
                    title: `${kaynak.title || kaynak.channel_slug} — ${zamanMetni(k.start)}`,
                    source: 'recording',
                    group: dikey ? 'live' : 'horizontal',
                    options: kesitSecenekleri,
                });
                tamam++;
            } catch (err) {
                hatali++;
                console.error(`[RecordingEditor:${this.userId}] Kesit ${i + 1} alınamadı (#${kaynak.id}): ${err.message}`);
            }
            if (i < kesitler.length - 1) bildir(false);
        }
        bildir(true);
        console.log(`[RecordingEditor:${this.userId}] 🎬 Kayıt #${kaynak.id}: ${tamam}/${kesitler.length} kesit klip hattına alındı`);
    }

    async _isle(kaynak, hedef, araliklar, uzerineYaz) {
        const calismaDizini = path.join(this.outputDir, `edit-${hedef.id}-${Date.now()}`);
        const geciciCikti = path.join(calismaDizini, 'sonuc.mp4');
        const sonYol = uzerineYaz
            ? kaynak.file_path
            // "rec-" öneki bilerek: RetentionService kota süpürmesi `<id>.mp4`
            // desenini edited_clips kaydı sanmasın (bkz. StreamRecorder).
            : path.join(this.outputDir, `rec-${hedef.id}.mp4`);

        try {
            fs.mkdirSync(calismaDizini, { recursive: true });

            const parcalar = [];
            for (const [i, a] of araliklar.entries()) {
                const parca = path.join(calismaDizini, `parca-${i}.ts`);
                await parcaKes(kaynak.file_path, parca, a.start, a.end - a.start);
                parcalar.push(parca);
            }
            await parcalariBirlestir(parcalar, geciciCikti, calismaDizini);
            fs.renameSync(geciciCikti, sonYol);

            const sure = await sureOku(sonYol);
            const guncel = await this.db.updateStreamRecording(hedef.id, this.userId, {
                status: 'ready',
                file_path: sonYol,
                file_size: dosyaBoyutu(sonYol),
                duration_sec: Math.round(sure || araliklar.reduce((t, a) => t + (a.end - a.start), 0)),
                error: null,
                completed_at: new Date(),
            });
            this._yayinla('recorder:edited', { ok: true, recording: guncel });
            console.log(`[RecordingEditor:${this.userId}] ✂️ Kayıt #${kaynak.id} düzenlendi → #${hedef.id}`);
        } catch (err) {
            console.error(`[RecordingEditor:${this.userId}] Düzenleme başarısız (#${kaynak.id}): ${err.message}`);
            const hata = `Düzenleme başarısız: ${err.message}`.slice(0, 300);
            // Üzerine yazmada orijinal dosya yerinde — kayıt kullanılabilir kalır.
            const guncel = await this.db.updateStreamRecording(hedef.id, this.userId, uzerineYaz
                ? { status: 'ready', error: hata }
                : { status: 'failed', error: hata, completed_at: new Date() },
            ).catch(() => null);
            this._yayinla('recorder:edited', { ok: false, error: hata, recording: guncel });
        } finally {
            try { fs.rmSync(calismaDizini, { recursive: true, force: true }); } catch { /* yok */ }
        }
    }

    _yayinla(olay, veri) {
        try { this.io?.to(`user:${this.userId}`).emit(olay, veri); } catch { /* socket yoksa sorun değil */ }
    }
}

/* ----------------------------------------------------------- ffmpeg yardımcıları */

function ffmpegCalistir(args) {
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let hata = '';
        proc.stderr.on('data', v => { hata += v.toString(); });
        proc.on('error', err => reject(new Error(`ffmpeg çalıştırılamadı: ${err.message}`)));
        proc.on('exit', code => code === 0
            ? resolve()
            : reject(new Error(`ffmpeg kodu ${code}: ${hata.trim().slice(0, 200)}`)));
    });
}

/**
 * Bir aralığı yeniden kodlamadan MPEG-TS parçasına al. TS seçildi: parçalar
 * birleştirilirken zaman damgaları MP4 kaplarına göre çok daha sorunsuz ekleniyor.
 */
function parcaKes(kaynak, hedef, baslangic, sure) {
    return ffmpegCalistir([
        '-ss', baslangic.toFixed(3),
        '-i', kaynak,
        '-t', sure.toFixed(3),
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-f', 'mpegts',
        '-y', hedef,
    ]);
}

/** Tek kesiti doğrudan oynatılabilir bir MP4'e al (klip hattı girdisi). */
function kesitCikar(kaynak, hedef, baslangic, sure) {
    return ffmpegCalistir([
        '-ss', baslangic.toFixed(3),
        '-i', kaynak,
        '-t', sure.toFixed(3),
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        '-y', hedef,
    ]);
}

function zamanMetni(sn) {
    const s = Math.max(0, Math.round(sn || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
        : `${m}:${String(r).padStart(2, '0')}`;
}

/** Parçaları concat demuxer ile tek MP4'e birleştir (+faststart: web'de anında oynar). */
async function parcalariBirlestir(parcalar, hedef, calismaDizini) {
    const liste = path.join(calismaDizini, 'liste.txt');
    // Yol mutlak ve tek tırnaklar kaçışlı — concat demuxer göreli yolları
    // liste dosyasının dizinine göre çözer, bu da çalışma dizinine bağımlılık yaratır.
    const satirlar = parcalar.map(p => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(liste, satirlar.join('\n') + '\n');

    await ffmpegCalistir([
        '-f', 'concat', '-safe', '0',
        '-i', liste,
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y', hedef,
    ]);
}

module.exports = RecordingEditor;
module.exports.korunanAraliklar = korunanAraliklar;
module.exports.gecerliKesitler = gecerliKesitler;
