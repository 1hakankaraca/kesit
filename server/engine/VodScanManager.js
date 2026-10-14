/**
 * VodScanManager — geçmiş bir yayının (VOD) indirilmesini ve bu VOD üzerinde
 * kullanıcının talep ettiği düzenleme işlemlerini yönetir.
 *
 * Akış artık İKİ AYRI FAZ: (1) indirme — VOD'u kalıcı olarak diske çeker
 * (`-c copy`), bitince 'downloaded' durumuna geçer ve 7 gün saklanır; hiçbir
 * otomatik klip üretimi başlatmaz. (2) kullanıcı talebi üzerine — VOD editör
 * popup'ından "İşleme Al" (elle işaretlenmiş kesitler) veya "Dikey Klip Al"
 * (AI highlight tespiti, HighlightDetector) tetiklenir; her ikisi de aynı
 * kalıcı VOD dosyasından, istenildiği kadar ve istenildiği zaman kesit
 * üretebilir. Üretilen kesitler mevcut ClipEditorManager.enqueueLocalClip()
 * ile dikey/yatay kompozisyon hattına devredilir.
 *
 * Saatlerce sürebildiğinden BullMQ+Redis üzerinde ayrı, düşük eşzamanlılıklı
 * bir kuyrukta çalışır — ClipEditorManager'ın CPU-sınırlı bellek-içi
 * havuzunu tıkamaz. Redis tanımlı değilse özellik kapalı kalır (MessageQueue
 * ile aynı "opsiyonel altyapı" deseni).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// REDIS_URL varsa BullMQ (kalıcı, çok süreçli), yoksa süreç içi kuyruk.
const REDIS_VAR = !!process.env.REDIS_URL;
const { Queue, Worker } = REDIS_VAR ? require('bullmq') : require('./LocalQueue');
const KickVodFetcher = require('./KickVodFetcher');
const { GECERLI_KALITELER } = require('./KickVodFetcher');
const HighlightDetector = require('./HighlightDetector');
const SceneSegmenter = require('./SceneSegmenter');
const CamFull = require('./CamFull');
const ClipEditorManager = require('./ClipEditorManager');

const CLIP_OUTPUT_DIR = process.env.CLIP_OUTPUT_DIR || 'data/clips';
const QUEUE_NAME = 'vod-processing';

class VodScanManager {
    constructor({ db, io }) {
        this.db = db;
        this.io = io;
        this.fetcher = new KickVodFetcher();
        this.highlighter = new HighlightDetector();
        this.segmenter = new SceneSegmenter();

        this.available = true;
        this.worker = null;
        this.connection = null;

        if (REDIS_VAR) {
            const IORedis = require('ioredis');
            this.connection = new IORedis(process.env.REDIS_URL, {
                maxRetriesPerRequest: null,
                enableReadyCheck: false,
            });
            this._lastRedisErrorLog = 0;
            this.connection.on('error', (err) => {
                const now = Date.now();
                if (now - this._lastRedisErrorLog > 30000) {
                    this._lastRedisErrorLog = now;
                    console.error(`[VodScan] Redis bağlantı hatası: ${err.message}`);
                }
            });
        }

        this.queue = new Queue(QUEUE_NAME, {
            connection: this.connection,
            defaultJobOptions: { removeOnComplete: 20, removeOnFail: 20, attempts: 1 },
        });

        // vodJobId → { bullJob, controller, cancelled } — kuyrukta bekleyen
        // (henüz worker'a düşmemiş) işi Redis'ten kaldırabilmek ve aktif
        // indirmeyi anında durdurabilmek için süreç içi (in-memory) takip.
        // Sunucu yeniden başlarsa bu harita da sıfırlanır — reconcile() zaten
        // yarım kalan 'processing' işleri 'failed' yapıyor, tutarlı.
        this._active = new Map();
    }

    /** Worker'ı başlat — uzun/ağır iş olduğundan varsayılan eşzamanlılık düşük */
    start() {
        if (!this.available || this.worker) return;
        const concurrency = Math.max(1, parseInt(process.env.VOD_SCAN_WORKERS) || 1);
        this.worker = new Worker(QUEUE_NAME, (job) => {
            if (job.name === 'manual-cut') return this._processManualCut(job.data);
            if (job.name === 'auto-vertical') return this._processAutoVertical(job.data);
            return this._processDownload(job.data); // 'download' (eski işler için de varsayılan)
        }, {
            connection: this.connection,
            concurrency,
            // BullMQ'nun varsayılan kilit süresi (30sn) bu iş için ÖLÜMCÜL:
            // whisper transkripsiyonu/sahne tarama gibi CPU-yoğun adımlar
            // sırasında event loop kısa süreliğine tıkanabilir, kilit tam
            // zamanında yenilenemezse BullMQ işi "stalled" sayıp AYNI job'ı
            // İKİNCİ KEZ worker'a veriyor — bu da zaten ilerlemekte/tamamlanmış
            // olan bir taramanın SIFIRDAN yeniden başlamasına yol açıyordu
            // (gerçek olayda: iş 15:11'de 4 klip + 95 segmentle tamamlanmıştı,
            // stalled-retry onu tekrar "indiriliyor"a döndürüp DB'yi bozdu).
            // Saatlerce sürebilen bu işler için kilit süresini çok büyütüp
            // (1 saat) otomatik yeniden denemeyi tamamen kapatıyoruz — iptal/
            // hata yönetimi zaten kendi checkCancelled()/reconcile() mantığımızda.
            lockDuration: 60 * 60 * 1000,
            maxStalledCount: 0,
        });
        this.worker.on('failed', (job, err) => {
            console.error(`[VodScan] İş ${job?.data?.vodJobId} kuyrukta başarısız:`, err.message);
        });
        this.worker.on('stalled', (jobId) => {
            console.error(`[VodScan] ⚠️ BullMQ job ${jobId} stalled sayıldı (event loop gecikmesi olabilir) — yeniden denenmeyecek.`);
        });
        console.log(`[VodScan] Worker başladı (concurrency=${concurrency})`);
    }

    async stop() {
        if (this.worker) {
            await this.worker.close();
            this.worker = null;
        }
    }

    async close() {
        await this.stop();
        if (!this.available) return;
        await this.queue.close();
        await this.connection?.quit();
    }

    /**
     * Boot mutabakatı — 'processing' durumunda kalmış işler sunucu
     * yeniden başladığı için yarım kalmıştır (BullMQ job'ı bellekten gitti,
     * attempts:1 olduğundan otomatik devam etmez). Kullanıcı elle tekrar başlatır.
     */
    async reconcile(userId) {
        if (!this.available) return;
        const pending = await this.db.getPendingVodScanJobs(userId);
        for (const job of pending) {
            if (job.status !== 'processing') continue; // 'queued' — BullMQ'da hâlâ bekliyor olabilir, dokunma
            const msg = 'Sunucu yeniden başlatıldığı için tarama yarım kaldı. Tekrar başlatabilirsiniz.';
            await this.db.updateVodScanJob(job.id, userId, { status: 'failed', error: msg });
            this._emit(userId, job.id, 'failed', msg, 0);
        }
    }

    async listVideos(channelSlug, opts) {
        return this.fetcher.listVideos(channelSlug, opts);
    }

    /**
     * SÜREN yayının başından o ana kadarki bölümünü indirmeye al.
     * Kick, canlı yayının kaydını da (`is_live: true`) EVENT tipi playlist
     * olarak veriyor; yayın akarken geçmişi indirilip kesit alınabiliyor.
     * Yayın devam ederken tekrar çağrılabilir — her çağrı o ana kadarki
     * (daha uzun) bölümü indiren YENİ bir iş açar.
     */
    async enqueueLive(userId, { channelSlug, quality = '1080p' } = {}) {
        const video = await this.fetcher.getLiveVideo(channelSlug);
        if (!video) {
            throw new Error(`"${channelSlug}" şu anda yayında değil ya da yayın kaydı kapalı`);
        }
        return this.enqueue(userId, { channelSlug, videoId: video.id, quality });
    }

    /**
     * Bir VOD indirmesini kuyruğa ekle. Yalnızca indirme yapılır — highlight/
     * segment üretimi artık burada TETİKLENMEZ, kullanıcı VOD editör
     * popup'ından "İşleme Al"/"Dikey Klip Al" ile istediği zaman başlatır.
     * @param {object} p - { channelSlug, videoId, source, quality }
     */
    async enqueue(userId, { channelSlug, videoId, source = 'kick', quality = '720p' } = {}) {
        if (!this.available) {
            throw new Error('VOD tarama için Redis gerekli — REDIS_URL tanımlı değil');
        }
        // Süren yayın da aday: canlı kayıt akışı buradan geçiyor.
        const videos = await this.fetcher.listVideos(channelSlug, { includeLive: true });
        const video = videos.find(v => String(v.id) === String(videoId));
        if (!video) throw new Error('Seçilen yayın kanal listesinde bulunamadı (silinmiş olabilir)');

        const jobRow = await this.db.createVodScanJob(userId, {
            channelSlug, source, sourceVideoId: videoId,
            title: video.title, durationSec: video.durationSec,
            thumbnailUrl: video.thumbnailUrl,
            fromLive: video.isLive === true,
        });
        const bullJob = await this.queue.add('download', {
            vodJobId: jobRow.id, userId, channelSlug, videoId, source,
            quality: GECERLI_KALITELER.includes(quality) ? quality : '720p',
        });
        this._active.set(jobRow.id, { bullJob, controller: null, cancelled: false });
        return jobRow;
    }

    async getJobs(userId, limit = 20) {
        return this.db.getVodScanJobs(userId, limit);
    }

    async getJobDetail(vodJobId, userId) {
        const job = await this.db.getVodScanJobById(vodJobId, userId);
        if (!job) throw new Error('İş bulunamadı');
        const [manualClips, highlights, segments, clips] = await Promise.all([
            this.db.getVodManualClips(vodJobId),
            this.db.getVodHighlights(vodJobId),
            this.db.getVodSegments(vodJobId),
            this.db.getEditedClipsByVodJob(vodJobId, userId),
        ]);
        return { job, manualClips, highlights, segments, clips };
    }

    /**
     * Timeline'dan işaretlenen kesitleri işleme kuyruğuna al. `cuts` DB'ye
     * önceden 'queued' olarak yazılmış olmalı (route katmanında) — burada
     * sadece BullMQ job'ı atılır.
     */
    async queueManualCut(vodJobId, userId, cuts, options) {
        if (!this.available) throw new Error('VOD işleme için Redis gerekli — REDIS_URL tanımlı değil');
        await this.queue.add('manual-cut', { vodJobId, userId, cuts, options });
    }

    /** Sayı belirtilen otomatik dikey klip üretimini kuyruğa al. */
    async queueAutoVertical(vodJobId, userId, count, options) {
        if (!this.available) throw new Error('VOD işleme için Redis gerekli — REDIS_URL tanımlı değil');
        await this.queue.add('auto-vertical', { vodJobId, userId, count, options });
    }

    /**
     * Devam eden bir taramayı iptal et.
     * - 'queued' (BullMQ'ya henüz düşmemiş/worker almamış): kuyruktan kaldırılır.
     * - 'processing': iptal bayrağı set edilir; aktif indirme varsa anında
     *   öldürülür, sonraki adımlarda (transkript/sahne/klip döngüleri)
     *   bir sonraki kontrol noktasında iş kendini durdurur.
     * - 'downloaded'/'failed'/'cancelled'/'expired': iptal edilecek bir şey yok, silme kullanılmalı.
     */
    async cancel(vodJobId, userId) {
        const job = await this.db.getVodScanJobById(vodJobId, userId);
        if (!job) throw new Error('İş bulunamadı');
        if (!['queued', 'processing', 'paused'].includes(job.status)) {
            throw new Error('Bu iş zaten sonuçlanmış — iptal edilemez, silebilirsiniz');
        }

        const state = this._active.get(vodJobId);
        if (job.status === 'queued') {
            try { await state?.bullJob?.remove(); } catch { /* worker az önce almış olabilir — processing yoluna düşer */ }
        }
        if (state) state.cancelled = true;
        // SIGKILL, durdurulmuş (SIGSTOP'lu) bir sürece de anında etki eder —
        // duraklatılmışken iptal edilirse önce devam ettirmeye gerek yok.
        state?.controller?.abort();

        // step/progress KASITLI olarak değiştirilmiyor — panel son ulaşılan
        // aşamayı donuk göstersin diye (bkz. frontend computeVodStages).
        await this.db.updateVodScanJob(vodJobId, userId, { status: 'cancelled' });
        this._emit(userId, vodJobId, 'cancelled', job.step, job.progress);
        // DİKKAT: workDir (vod-work/{id}/) burada SİLİNMEZ — kesilmiş highlight/
        // segment dosyaları ClipEditorManager'ın AYRI, bağımsız global kuyruğunda
        // hâlâ işleniyor olabilir (bkz. _cutAndEnqueue yorumu: fire-and-forget).
        // Daha önce burada bir temizlik çağrısı vardı ve tam bu yüzden gerçek bir
        // veri kaybına yol açtı: iptal anında henüz kuyrukta bekleyen segment
        // dosyaları silinince ClipEditorManager onları işlerken "dosya bulunamadı"
        // hatası veriyordu. RetentionService zaten vod-work/'ü 24 saat sonra
        // otomatik temizliyor — kuyruk o süre içinde işini bitirir.
        return true;
    }

    /**
     * Aktif indirmeyi duraklat (SIGSTOP). Yalnız indirme aşamasında çalışır —
     * transkript/sahne tarama/klip kesme gibi diğer adımlarda duraklatılabilecek
     * tek bir uzun süreç yoktur (kısa ffmpeg/whisper çağrılarının art arda
     * dizisidir), bu yüzden o adımlarda hata döner.
     */
    async pause(vodJobId, userId) {
        const job = await this.db.getVodScanJobById(vodJobId, userId);
        if (!job) throw new Error('İş bulunamadı');
        if (job.status !== 'processing') throw new Error('Yalnızca işlenmekte olan bir tarama duraklatılabilir');
        const state = this._active.get(vodJobId);
        if (!state?.proc || state.proc.exitCode !== null || state.proc.signalCode !== null) {
            throw new Error('Şu an duraklatılabilecek bir indirme yok (indirme dışındaki adımlar duraklatılamaz)');
        }
        state.proc.kill('SIGSTOP');
        state.paused = true;
        await this.db.updateVodScanJob(vodJobId, userId, { status: 'paused' });
        this._emit(userId, vodJobId, 'paused', job.step, job.progress);
        return true;
    }

    /** Duraklatılan indirmeyi devam ettir (SIGCONT). */
    async resume(vodJobId, userId) {
        const job = await this.db.getVodScanJobById(vodJobId, userId);
        if (!job) throw new Error('İş bulunamadı');
        if (job.status !== 'paused') throw new Error('Bu iş duraklatılmış durumda değil');
        const state = this._active.get(vodJobId);
        if (!state?.proc || state.proc.exitCode !== null) {
            throw new Error('Duraklatılan indirme artık mevcut değil (sunucu yeniden başlamış olabilir)');
        }
        state.proc.kill('SIGCONT');
        state.paused = false;
        await this.db.updateVodScanJob(vodJobId, userId, { status: 'processing' });
        this._emit(userId, vodJobId, 'processing', job.step, job.progress);
        return true;
    }

    /**
     * İşi kalıcı olarak sil. Hâlâ aktifse önce iptal edilir (fire-and-forget —
     * indirme/işleme bir sonraki kontrol noktasında zaten kendini durduracak;
     * DB kaydı gittiği için `updateVodScanJob` çağrıları sessizce etkisiz kalır).
     * VOD artık kalıcı saklandığından (7 gün), iş kaydı silinirken `workDir`
     * (ham vod.mp4 + transcript cache + varsa artık dosyalar) de silinir —
     * aksi halde 7 günlük TTL tetikleyicisi (DB satırı) gittiği için disk
     * asla boşalmaz.
     */
    async remove(vodJobId, userId) {
        const job = await this.db.getVodScanJobById(vodJobId, userId);
        if (!job) throw new Error('İş bulunamadı');

        if (['queued', 'processing', 'paused'].includes(job.status)) {
            const state = this._active.get(vodJobId);
            if (job.status === 'queued') {
                try { await state?.bullJob?.remove(); } catch { /* yoksay */ }
            }
            if (state) state.cancelled = true;
            state?.controller?.abort();
        }

        this._active.delete(vodJobId);
        await this.db.deleteVodScanJob(vodJobId, userId);
        if (job.vod_path) {
            try { fs.rmSync(path.dirname(job.vod_path), { recursive: true, force: true }); } catch { /* ignore */ }
        }
        return true;
    }

    async getHighlights(jobId, userId) {
        const job = await this.db.getVodScanJobById(jobId, userId);
        if (!job) throw new Error('İş bulunamadı');
        return this.db.getVodHighlights(jobId);
    }

    async getSegments(jobId, userId) {
        const job = await this.db.getVodScanJobById(jobId, userId);
        if (!job) throw new Error('İş bulunamadı');
        return this.db.getVodSegments(jobId);
    }

    // ==========================================
    // İŞLEME
    // ==========================================

    /**
     * FAZ 1 — indirme. Tamamlanınca 'downloaded' durumuna geçer, VOD 7 gün
     * kalıcı saklanır (RetentionService süresi dolunca siler). Hiçbir
     * highlight/segment üretimi burada TETİKLENMEZ.
     */
    async _processDownload({ vodJobId, userId, channelSlug, videoId, quality }) {
        const workDir = path.join(CLIP_OUTPUT_DIR, String(userId), 'vod-work', String(vodJobId));
        const vodPath = path.join(workDir, 'vod.mp4');
        fs.mkdirSync(workDir, { recursive: true });

        // enqueue() sırasında konan giriş normalde burada bulunur; sunucu
        // yeniden başladıysa (harita sıfırlanmış) yeni bir giriş açılır —
        // reconcile() zaten böyle yarım kalmış işleri 'failed' yapıp bu
        // fonksiyonun tekrar çalışmasını engelliyor, yine de güvenlik ağı.
        let state = this._active.get(vodJobId);
        if (!state) {
            state = { bullJob: null, controller: null, cancelled: false };
            this._active.set(vodJobId, state);
        }
        const controller = new AbortController();
        state.controller = controller;

        /** İptal istenmişse iş akışını burada kes — döngülerde her adımdan önce çağrılır. */
        const checkCancelled = () => {
            if (state.cancelled) throw new Error('İptal edildi');
        };

        let downloadSucceeded = false;
        try {
            checkCancelled();
            await this._setStep(vodJobId, userId, 'kaynak bulunuyor', 5);
            // Kaydedilen değil TAZE kaynak alınır — m3u8 linki zamanla geçersizleşebilir.
            // includeLive: iş süren bir yayından açıldıysa kaynak hâlâ canlı
            // listede; yayın bu arada bittiyse aynı id normal VOD olarak gelir
            // (o durumda yayının tamamı inmiş olur).
            const videos = await this.fetcher.listVideos(channelSlug, { includeLive: true });
            const video = videos.find(v => String(v.id) === String(videoId));
            if (!video) throw new Error('VOD artık mevcut değil (kanaldan kaldırılmış olabilir)');

            // İndirme saatlerce sürebilir (uzun VOD + yavaş/tıkanan bağlantı) —
            // gerçek yüzde gösterilir; 5dk boyunca hiç ilerleme olmazsa
            // (gerçek bir olayda 2 saat 0 byte'ta takılı kalmıştı) iptal edilir.
            // Kullanıcı elle iptal ederse `controller.signal` indirmeyi anında durdurur.
            checkCancelled();
            await this._setStep(vodJobId, userId, 'indiriliyor', 5);
            await this.fetcher.download(video.sourceUrl, vodPath, {
                durationSec: video.durationSec || 0,
                quality: quality || '720p',
                signal: controller.signal,
                onProcess: (proc) => { state.proc = proc; },
                isPaused: () => state.paused === true,
                onProgress: (pct, meta) => {
                    const progress = 5 + Math.round((pct ?? 0) * 0.95); // 5-100 aralığı
                    this._setStep(vodJobId, userId, 'indiriliyor', progress, meta).catch(() => {});
                },
            });
            state.proc = null; // indirme bitti — pause/resume artık bu iş için geçersiz
            downloadSucceeded = true;

            const st = fs.statSync(vodPath);
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            await this.db.updateVodScanJob(vodJobId, userId, {
                status: 'downloaded', step: 'indirildi', progress: 100,
                vod_path: vodPath, vod_file_size_bytes: st.size,
                downloaded_at: new Date(), vod_expires_at: expiresAt,
                duration_sec: video.durationSec || 0,
            });
            this._emit(userId, vodJobId, 'downloaded', 'indirildi', 100, { vodExpiresAt: expiresAt });
            console.log(`[VodScan] ✅ İş ${vodJobId} indirildi (${Math.round(st.size / 1024 / 1024)}MB)`);
        } catch (err) {
            if (state.cancelled) {
                // DB durumu + emit zaten cancel()/remove() tarafından yapıldı — sadece logla.
                console.log(`[VodScan] ⏹️ İş ${vodJobId} iptal edildi`);
            } else {
                console.error(`[VodScan] ❌ İş ${vodJobId} hatası:`, err.message);
                const friendly = VodScanManager.friendlyError(err.message);
                await this.db.updateVodScanJob(vodJobId, userId, { status: 'failed', error: friendly }).catch(() => {});
                this._emit(userId, vodJobId, 'failed', friendly, 0);
            }
        } finally {
            this._active.delete(vodJobId);
            // Yalnız BAŞARISIZ/İPTAL indirmede kısmi dosya silinir — başarılı
            // indirmede vod.mp4 7 gün kalıcı kalmalı (RetentionService siler).
            if (!downloadSucceeded) { try { fs.unlinkSync(vodPath); } catch { /* ignore */ } }
        }
    }

    /**
     * Whisper transkriptini `workDir/transcript.json`'da önbelleğe alır —
     * "Dikey Klip Al" birden çok kez tetiklenebildiğinden (ör. önce 3 klip,
     * sonra "3 tane daha") aynı VOD için whisper'ı tekrar tekrar çalıştırmamak
     * için. Chunk ses parçaları kullanıldıktan sonra silinir (disk şişmesin).
     */
    async _getOrBuildTranscript(vodPath, workDir, video, language, onProgress) {
        const cachePath = path.join(workDir, 'transcript.json');
        if (fs.existsSync(cachePath)) {
            try {
                return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            } catch { /* bozuk cache — yeniden üret */ }
        }
        const result = await this.highlighter.transcribeInChunks(vodPath, workDir, {
            language, durationSec: video.duration_sec || video.durationSec || 0, onProgress,
        });
        try { fs.writeFileSync(cachePath, JSON.stringify(result)); } catch { /* ignore */ }
        try {
            for (const entry of fs.readdirSync(workDir, { withFileTypes: true })) {
                if (entry.isDirectory() && entry.name.startsWith('chunk-')) {
                    fs.rmSync(path.join(workDir, entry.name), { recursive: true, force: true });
                }
            }
        } catch { /* ignore */ }
        return result;
    }

    /** VOD'un hâlâ diskte olduğunu doğrular — süresi dolmuş/silinmiş olabilir. */
    async _requireVod(vodJobId, userId) {
        const job = await this.db.getVodScanJobById(vodJobId, userId);
        if (!job || !job.vod_path || !fs.existsSync(job.vod_path)) return null;
        return job;
    }

    /**
     * Timeline üzerinde film şeridi (küçük kare önizlemeleri) — ilk istekte
     * üretilir (her biri ayrı `-ss` ile hızlı bir seek+tek-kare, N adet ffmpeg
     * çağrısı), `filmstrip/manifest.json` ile önbelleğe alınır; sonraki
     * açılışlarda anında döner. Kesit sayısı/süresi VOD uzunluğuna göre
     * ölçeklenir (çok uzun yayınlarda da makul sürede biter).
     */
    async getFilmstrip(vodJobId, userId) {
        const job = await this._requireVod(vodJobId, userId);
        if (!job) throw new Error('VOD bulunamadı — süresi dolmuş olabilir');
        const workDir = path.dirname(job.vod_path);
        const framesDir = path.join(workDir, 'filmstrip');
        const manifestPath = path.join(framesDir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* bozuk — yeniden üret */ }
        }

        fs.mkdirSync(framesDir, { recursive: true });
        const duration = job.duration_sec || 0;
        const count = Math.max(8, Math.min(60, Math.round(duration / 20) || 8));
        const frames = [];
        for (let i = 0; i < count; i++) {
            const t = ((i + 0.5) / count) * duration;
            const file = `f-${i}.jpg`;
            const outPath = path.join(framesDir, file);
            try {
                await this._grabFrame(job.vod_path, outPath, t);
                frames.push({ t: Math.round(t), url: `/clips/${userId}/vod-work/${vodJobId}/filmstrip/${file}` });
            } catch (err) {
                console.error(`[VodScan] Filmstrip karesi alınamadı (t=${Math.round(t)}s):`, err.message);
            }
        }
        try { fs.writeFileSync(manifestPath, JSON.stringify(frames)); } catch { /* ignore */ }
        return frames;
    }

    _grabFrame(vodPath, outPath, atSec) {
        return new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', [
                '-y', '-loglevel', 'error',
                '-ss', String(Math.max(0, atSec)), '-i', vodPath,
                '-frames:v', '1', '-vf', 'scale=160:-1',
                outPath,
            ]);
            let stderr = '';
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', reject);
            const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('zaman aşımı')); }, 15000);
            proc.on('exit', code => {
                clearTimeout(timer);
                if (code === 0) resolve();
                else reject(new Error(`kare alma hatası (code ${code}): ${stderr.slice(0, 200)}`));
            });
        });
    }

    /**
     * FAZ 2a — timeline'dan elle işaretlenen kesitleri kes. `cuts` her biri
     * DB'de önceden 'queued' olarak yazılmış vod_manual_clips satırlarına
     * karşılık gelir (route katmanında oluşturulur). Kesit sayısında/süresinde
     * gizli bir üst sınır YOK — kullanıcı ne kadar işaretlerse o kadar kesilir.
     */
    async _processManualCut({ vodJobId, userId, cuts, options }) {
        const job = await this._requireVod(vodJobId, userId);
        if (!job) {
            for (const c of cuts) {
                await this.db.updateVodManualClip(c.id, { status: 'failed', error: 'Ham VOD artık mevcut değil (süresi dolmuş olabilir)' }).catch(() => {});
            }
            this._emit(userId, vodJobId, 'manual-cut-failed', 'VOD bulunamadı', 0);
            return;
        }
        const workDir = path.dirname(job.vod_path);
        const clipEditor = new ClipEditorManager({ db: this.db, io: this.io, userId, channelSlug: job.channel_slug });

        let done = 0;
        for (const c of cuts) {
            try {
                await this.db.updateVodManualClip(c.id, { status: 'processing' });
                const clipPath = path.join(workDir, `manual-${c.id}.mp4`);
                await this._cutSegment(job.vod_path, clipPath, c.start, c.end - c.start);
                const isVertical = options?.outputFormat === 'vertical';
                // Tam ekran bölgeleri (VOD saniyesi) → kesit dosyası saniyesi.
                // Dosya istenen andan değil ondan önceki anahtar kareden başlar.
                let kesitSecenekleri = isVertical ? { ...(options || {}) } : { ...(options || {}), outputFormat: 'horizontal' };
                if (Array.isArray(c.camFull) && c.camFull.length) {
                    const dosyaBasi = await CamFull.keyframeBefore(job.vod_path, c.start);
                    kesitSecenekleri.camFullRanges = CamFull.toRelative(c.camFull, { fileStart: dosyaBasi, cutStart: c.start, cutEnd: c.end });
                }
                const record = await clipEditor.enqueueLocalClip(clipPath, {
                    title: `${job.title || job.channel_slug} — ${this._ts(c.start)}`,
                    source: 'vod-manual',
                    group: isVertical ? 'vodscan' : 'horizontal',
                    options: kesitSecenekleri,
                    vodScanJobId: vodJobId,
                });
                await this.db.updateVodManualClip(c.id, { status: 'ready', edited_clip_id: record.id });
                done++;
                this._emit(userId, vodJobId, 'manual-cut-progress', `${done}/${cuts.length} kesit hazır`, Math.round((done / cuts.length) * 100), { manualClipId: c.id, editedClipId: record.id });
            } catch (err) {
                console.error(`[VodScan] Manuel kesit ${c.id} işlenemedi:`, err.message);
                await this.db.updateVodManualClip(c.id, { status: 'failed', error: String(err.message || '').slice(0, 200) }).catch(() => {});
                this._emit(userId, vodJobId, 'manual-cut-progress', `kesit hata: ${err.message}`, null, { manualClipId: c.id, error: err.message });
            }
        }
        this._emit(userId, vodJobId, 'manual-cut-done', `${done}/${cuts.length} kesit tamamlandı`, 100);
    }

    /**
     * FAZ 2b — istenen sayıda dikey highlight klibi üretir (mevcut AI
     * pipeline'ının yeniden kullanımı). `count` üzerinde yalnız >=1 kontrolü
     * vardır, gizli bir üst sınır YOK.
     */
    async _processAutoVertical({ vodJobId, userId, count, options }) {
        const job = await this._requireVod(vodJobId, userId);
        if (!job) {
            this._emit(userId, vodJobId, 'auto-vertical-failed', 'VOD bulunamadı', 0);
            return;
        }
        const workDir = path.dirname(job.vod_path);
        const clipEditor = new ClipEditorManager({ db: this.db, io: this.io, userId, channelSlug: job.channel_slug });
        const userSettings = await this.db.getSettings(userId).catch(() => null);
        const language = userSettings?.language === 'en' ? 'en' : 'tr';

        this._emit(userId, vodJobId, 'auto-vertical-progress', 'transkript çıkarılıyor', 5);
        let transcriptResult;
        try {
            transcriptResult = await this._getOrBuildTranscript(job.vod_path, workDir, job, language, (done, total) => {
                const pct = 5 + Math.round((done / total) * 30);
                this._emit(userId, vodJobId, 'auto-vertical-progress', 'transkript çıkarılıyor', pct);
            });
        } catch (err) {
            console.error(`[VodScan] İş ${vodJobId} — transkript hatası (dikey klip):`, err.message);
            this._emit(userId, vodJobId, 'auto-vertical-failed', VodScanManager.friendlyError(err.message), 0);
            return;
        }
        if (transcriptResult.language) {
            await this.db.updateVodScanJob(vodJobId, userId, { transcript_language: transcriptResult.language }).catch(() => {});
        }

        const highlights = transcriptResult.segments.length > 0
            ? await this.highlighter.rankWithLLM(this.highlighter.clusterWindows(transcriptResult.segments), {
                maxClips: Math.max(1, parseInt(count) || 1),
                language: transcriptResult.language || language,
            })
            : [];

        this._emit(userId, vodJobId, 'auto-vertical-progress', 'klipler kesiliyor', 35);
        let created = 0;
        let clipsCreatedTotal = job.clips_created || 0;
        for (const h of highlights) {
            const row = await this.db.addVodHighlight(vodJobId, { startSec: h.start, endSec: h.end, score: h.score, kind: h.kind, reason: h.reason });
            try {
                const record = await this._cutAndEnqueue(clipEditor, job.vod_path, workDir, {
                    start: h.start, end: h.end,
                    title: `${job.title || job.channel_slug} — ${this._ts(h.start)}`,
                    vodJobId, outputFormat: 'vertical', options,
                    prefix: 'highlight', id: row.id,
                });
                await this.db.linkVodHighlightClip(row.id, record.id);
                created++;
                clipsCreatedTotal++;
                const pct = 35 + Math.round((created / highlights.length) * 65);
                this._emit(userId, vodJobId, 'auto-vertical-progress', `${created}/${highlights.length} klip kesildi`, pct);
            } catch (err) {
                console.error(`[VodScan] Highlight ${row.id} işlenemedi:`, err.message);
            }
        }
        await this.db.updateVodScanJob(vodJobId, userId, { clips_created: clipsCreatedTotal }).catch(() => {});
        this._emit(userId, vodJobId, 'auto-vertical-done', `${created} dikey klip üretildi`, 100, { count: created });
    }

    /**
     * Bir aralığı yerel dosyaya kes (kalıcı work dizinine — enqueueLocalClip
     * arka planda fire-and-forget işlediğinden burada silinmez; mevcut !clip
     * akışıyla aynı "kalıcı dosya" konvansiyonu izlenir) ve dikey/yatay klip
     * hattına devret.
     */
    async _cutAndEnqueue(clipEditor, vodPath, workDir, { start, end, title, vodJobId, outputFormat, options, prefix, id, score, reason }) {
        const clipPath = path.join(workDir, `${prefix}-${id}.mp4`);
        await this._cutSegment(vodPath, clipPath, start, end - start);
        const isHorizontal = outputFormat === 'horizontal';
        return clipEditor.enqueueLocalClip(clipPath, {
            title,
            source: 'vod-scan',
            group: isHorizontal ? 'horizontal' : 'vodscan',
            options: isHorizontal ? { ...options, outputFormat: 'horizontal' } : options,
            vodScanJobId: vodJobId,
            // Yatay kesitler için SceneSegmenter.scoreSegments'ten gelen "konu
            // önemi" puanı — ViralScorer (kısa video odaklı) burada çalıştırılmaz,
            // panel bu puanla sıralar (bkz. ClipEditorManager.enqueueLocalClip).
            precomputedScore: isHorizontal ? score : undefined,
            precomputedScoreReason: isHorizontal ? reason : undefined,
        });
    }

    _cutSegment(vodPath, outPath, startSec, durSec) {
        return new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', [
                '-y', '-loglevel', 'error',
                '-ss', String(Math.max(0, startSec)), '-i', vodPath, '-t', String(durSec),
                '-c', 'copy', '-avoid_negative_ts', 'make_zero',
                outPath,
            ]);
            let stderr = '';
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', reject);
            proc.on('exit', code => {
                if (code === 0) resolve();
                else reject(new Error(`Segment kesme hatası (code ${code}): ${stderr.slice(0, 300)}`));
            });
        });
    }

    static friendlyError(msg = '') {
        const m = String(msg);
        if (/bulunamadı|kaldırılmış/i.test(m)) return m;
        if (/VOD indirme hatası|İndirilen VOD/i.test(m)) return 'Yayın indirilemedi. Yayın süresi dolmuş veya erişilemez olabilir.';
        if (/timeout|ETIMEDOUT|ECONNRESET/i.test(m)) return 'Bağlantı zaman aşımına uğradı. Tekrar deneyin.';
        return m.slice(0, 200);
    }

    /**
     * @param {object} [extra] - bytesDownloaded/speedBps gibi canlı-yalnız
     *   (ephemeral) alanlar — DB'ye YAZILMAZ, sadece socket ile iletilir.
     */
    async _setStep(vodJobId, userId, step, progress, extra) {
        await this.db.updateVodScanJob(vodJobId, userId, { status: 'processing', step, progress }).catch(() => {});
        this._emit(userId, vodJobId, 'processing', step, progress, extra);
    }

    _emit(userId, vodJobId, status, step, progress, extra) {
        if (this.io) {
            this.io.to(`user:${userId}`).emit('vodscan:update', { vodJobId, status, step, progress, ...extra });
        }
    }

    _ts(sec) {
        const s = Math.max(0, Math.round(sec || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        return h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
            : `${m}:${String(r).padStart(2, '0')}`;
    }
}

module.exports = VodScanManager;
