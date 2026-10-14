/**
 * ClipEditorManager — Dikey klip düzenleme iş kuyruğu
 *
 * Akış (her iş için):
 *  1. İndir (popüler klip / chat klibi ise) veya yerel dosyayı kullan (!clip çıktısı)
 *  2. Facecam tespiti (pico.js)
 *  3. Hareket analizi ile odak noktası
 *  4. Transkript + önem sıralama + ASS altyazı (whisper varsa)
 *  5. Dikey kompozisyon (1080x1920) + küçük görsel
 *
 * ffmpeg/whisper makine genelinde ağır olduğundan işler TÜM kullanıcılar
 * arasında sıralı işlenir (global kuyruk zinciri).
 */
const fs = require('fs');
const path = require('path');
const KickClipFetcher = require('./KickClipFetcher');
const FacecamDetector = require('./FacecamDetector');
const SmartCropper = require('./SmartCropper');
const Transcriber = require('./Transcriber');
const VerticalComposer = require('./VerticalComposer');
const HorizontalComposer = require('./HorizontalComposer');
const IntroStore = require('./IntroStore');
const CamFull = require('./CamFull');
const ProfanityCensor = require('./ProfanityCensor');
const AudioCensor = require('./AudioCensor');
const MetadataGenerator = require('./MetadataGenerator');
const QualityControl = require('./QualityControl');
const ZernioPublisher = require('./ZernioPublisher');
const {
    createPublishRequestId,
    isValidProfileId,
    normalizePlatformResults,
    normalizePublishStatus,
} = require('./PublishingPolicy');
const ViralScorer = require('./ViralScorer');

// Kesit: otomatik başlık/açıklama üretimi kapalı (ürün kararı) — kod yerinde, açmak tek satır.
const AUTO_METADATA = false;

const PUBLISH_INTERVAL_MS = 60 * 60 * 1000; // otomatik paylaşımlar arası 1 saat
// Otomatik (canlı yakalama) paylaşımlarda plan saati sunucu tarafında mutlak
// zaman damgası olarak hesaplanır; panelde de UTC olarak gösterilir.
const AUTO_PUBLISH_TIMEZONE = 'UTC';

const CLIP_OUTPUT_DIR = process.env.CLIP_OUTPUT_DIR || 'data/clips';

// Yatay kesitler saatlerce sürebilir (ör. 2 saatlik oyun bölümü) — sansür
// kapalıyken salt açıklama/başlık üretmek için bu süreden uzun segmentler
// transkribe edilmez (maliyet/süre). Sansür açıksa bu sınır uygulanmaz.
const HORIZONTAL_METADATA_TRANSCRIBE_CAP_SEC = 900; // 15 dk

// ffmpeg/whisper CPU-yoğun olduğundan işler makine genelinde SINIRLI eşzamanlılıkla
// çalışır. Eskiden tek zincir vardı (aynı anda 1 iş) — çok kiracıda bir kullanıcının
// uzun klibi diğer herkesi bekletiyordu. Havuz, çekirdek sayısına göre ölçeklenir.
const MAX_CONCURRENT_JOBS = Math.max(1, Math.min(
    parseInt(process.env.CLIP_WORKERS) || Math.floor(require('os').cpus().length / 3),
    4
));

// Makine genelinde paylaşılan iş kuyruğu
const jobQueue = [];
let runningJobs = 0;

function scheduleJob(task) {
    return new Promise((resolve) => {
        jobQueue.push({ task, resolve });
        drainQueue();
    });
}

function drainQueue() {
    while (runningJobs < MAX_CONCURRENT_JOBS && jobQueue.length > 0) {
        const { task, resolve } = jobQueue.shift();
        runningJobs++;
        Promise.resolve()
            .then(task)
            .catch(err => console.error('[ClipEditor] İş hatası:', err.message))
            .finally(() => {
                runningJobs--;
                resolve();
                drainQueue();
            });
    }
}

/** Kuyruk durumu (panel/izleme için) */
function getQueueStatus() {
    return { running: runningJobs, waiting: jobQueue.length, capacity: MAX_CONCURRENT_JOBS };
}

class ClipEditorManager {
    constructor({ db, io, userId, channelSlug }) {
        this.db = db;
        this.io = io;
        this.userId = userId;
        this.channelSlug = channelSlug || '';

        this.fetcher = new KickClipFetcher();
        this.detector = new FacecamDetector();
        this.cropper = new SmartCropper();
        this.transcriber = new Transcriber();
        this.composer = new VerticalComposer();
        this.horizontalComposer = new HorizontalComposer();
        this.metadata = new MetadataGenerator();
        this.qc = new QualityControl();
        this.scorer = new ViralScorer();
        // Otomatik planlı paylaşım — { enabled, accounts }
        this._autoPublish = { enabled: false, accounts: [] };
        this._nextPublishAt = null; // bir sonraki paylaşım zaman damgası (stagger)

        this.outputDir = path.join(CLIP_OUTPUT_DIR, String(userId), 'vertical');
        this.workDir = path.join(CLIP_OUTPUT_DIR, String(userId), 'work');
    }

    // ==========================================
    // STÜDYO AYARLARI (üretim seçenekleri)
    // ==========================================

    /**
     * Üretim seçenekleri şeması. Kullanıcı varsayılanları
     * user_settings.clip_defaults'ta (JSON), iş bazlı kopya
     * edited_clips.options'ta tutulur — retry/kurtarma aynı ayarla döner.
     */
    static CLIP_OPTION_DEFAULTS = {
        subtitles: true,
        subtitleStyle: null,        // null → kullanıcının subtitle_style ayarı
        subtitleLang: 'auto',       // auto → içerik dili ayarını izler | tr | en
        subtitleFollowsTheme: false, // true → altyazı vurgusu tema renginden
        logo: true,
        logoPosition: 'seam',       // seam | top-center | custom (serbest X/Y — VOD editör popup'ından)
        logoScale: 1,               // 0.5 - 2.0
        logoOpacity: 1,             // 0.05 - 1 (VOD editör logo sürükle-bırak paneli)
        logoX: null,                // 0-1, logoPosition==='custom' iken kullanılır (logo merkezinin video genişliğine oranı)
        logoY: null,                // 0-1, logoPosition==='custom' iken kullanılır
        composition: 'auto',        // auto | split | single
        autoPublishMinScore: 0,     // 0 = viral skor eşiği yok
        outputFormat: 'vertical',   // vertical (9:16) | horizontal (16:9 ham kesit — VOD sahne taraması)
        censor: false,              // true → küfür geçen anlar biplenir (ProfanityCensor + AudioCensor)
        intro: true,                // yatay kesitlerin başına kullanıcı introsu eklensin mi (intro yüklüyse)
        introAsk: true,             // true → panel her kesit alımında intro eklensin mi diye sorar (yalnız yatay)
        outro: true,                // yatay kesitlerin sonuna kullanıcı outrosu eklensin mi (outro yüklüyse)
        camFullRanges: [],          // [{start,end}] klip saniyesi — bu anlarda webcam kadrajı doldurur ("tam ekran bölgesi")
    };

    /** Dış kaynaklı options nesnesini doğrula ve varsayılanlarla doldur */
    static normalizeClipOptions(raw = {}) {
        const d = ClipEditorManager.CLIP_OPTION_DEFAULTS;
        const pick = (val, allowed, dflt) => (allowed.includes(val) ? val : dflt);
        return {
            subtitles: raw.subtitles === undefined ? d.subtitles : raw.subtitles !== false,
            subtitleStyle: (typeof raw.subtitleStyle === 'string' && /^[a-z0-9-]{1,30}$/.test(raw.subtitleStyle))
                ? raw.subtitleStyle : d.subtitleStyle,
            subtitleLang: pick(raw.subtitleLang, ['auto', 'tr', 'en'], d.subtitleLang),
            subtitleFollowsTheme: raw.subtitleFollowsTheme === true,
            logo: raw.logo !== false,
            logoPosition: pick(raw.logoPosition, ['seam', 'top-center', 'custom'], d.logoPosition),
            logoScale: Math.min(2, Math.max(0.5, Number(raw.logoScale) || 1)),
            logoOpacity: Math.min(1, Math.max(0.05, raw.logoOpacity === undefined || raw.logoOpacity === null ? d.logoOpacity : Number(raw.logoOpacity))),
            logoX: raw.logoX !== undefined && raw.logoX !== null && !Number.isNaN(Number(raw.logoX)) ? Math.min(1, Math.max(0, Number(raw.logoX))) : null,
            logoY: raw.logoY !== undefined && raw.logoY !== null && !Number.isNaN(Number(raw.logoY)) ? Math.min(1, Math.max(0, Number(raw.logoY))) : null,
            composition: pick(raw.composition, ['auto', 'split', 'single'], d.composition),
            autoPublishMinScore: Math.min(100, Math.max(0, parseInt(raw.autoPublishMinScore) || 0)),
            outputFormat: pick(raw.outputFormat, ['vertical', 'horizontal'], d.outputFormat),
            censor: raw.censor === true,
            intro: raw.intro === undefined ? d.intro : raw.intro !== false,
            introAsk: raw.introAsk === undefined ? d.introAsk : raw.introAsk !== false,
            outro: raw.outro === undefined ? d.outro : raw.outro !== false,
            camFullRanges: CamFull.normalizeCamFullRanges(raw.camFullRanges),
        };
    }

    // Ayar grupları: her üretim yöntemi kendi altyazı/logo/kompozisyon/sansür
    // varsayılanlarını ayrı tutar (Ayarlar sekmesinde 4 bağımsız blok).
    static SETTINGS_GROUPS = ['gezgin', 'vodscan', 'live', 'horizontal'];

    /**
     * clip_defaults JSON'u gruplu formatta mı ({gezgin,vodscan,live,horizontal})
     * yoksa eski düz formatta mı (tüm üretimlerde ortak tek obje) ayırt eder.
     * Eski format tüm gruplara aynı şekilde uygulanır — ilk "Varsayılan Yap"
     * kaydında ilgili grup ayrılıp geri kalanlar eski değerde kalır.
     */
    static _extractGroupDefaults(parsed, group) {
        const isGrouped = ClipEditorManager.SETTINGS_GROUPS.every(g => parsed[g] && typeof parsed[g] === 'object');
        return isGrouped ? (parsed[group] || {}) : parsed;
    }

    /**
     * Gruba özgü şema varsayılanları: yatay kesitlerde altyazı varsayılan
     * olarak kapalıdır (kullanıcı açarsa açılır).
     */
    static GROUP_BASE_DEFAULTS = { horizontal: { subtitles: false, outputFormat: 'horizontal' } };

    /** Kayıtlı ayar (clip_defaults JSON) + grup tabanı → normalize edilmiş grup varsayılanları */
    static groupDefaults(parsed, group) {
        const saved = ClipEditorManager._extractGroupDefaults(parsed || {}, group);
        return ClipEditorManager.normalizeClipOptions({ ...(ClipEditorManager.GROUP_BASE_DEFAULTS[group] || {}), ...saved });
    }

    /** Kullanıcı varsayılanları + iş bazlı override → normalize edilmiş seçenekler */
    async resolveOptions(override = {}, group = 'live') {
        let parsed = {};
        try {
            const settings = await this.db.getSettings(this.userId);
            parsed = JSON.parse(settings?.clip_defaults || '{}') || {};
        } catch { /* bozuk ayar → şema varsayılanları */ }
        return ClipEditorManager.normalizeClipOptions({ ...ClipEditorManager.groupDefaults(parsed, group), ...override });
    }

    /**
     * Kanalın popüler kliplerini kuyruğa ekle
     * @returns {Array} oluşturulan iş kayıtları
     */
    async enqueuePopularClips(channelSlug, { limit = 5, time = 'all', subtitles, options = null } = {}) {
        const clips = await this.fetcher.listPopularClips(channelSlug, { limit, time });
        if (clips.length === 0) {
            throw new Error('Kanalda klip bulunamadı');
        }
        const merged = await this._mergeOptions(subtitles, options, 'gezgin');

        const jobs = [];
        for (const clip of clips) {
            const record = await this.db.addEditedClip(this.userId, {
                source: 'popular',
                sourceClipId: clip.id,
                sourceUrl: clip.videoUrl,
                title: clip.title || clip.id,
                channelSlug: channelSlug.toLowerCase(),
                viewCount: clip.viewCount,
                subtitles: merged.subtitles,
                options: merged,
            });
            jobs.push(record);
            this._schedule(record.id, { videoUrl: clip.videoUrl });
        }
        return jobs;
    }

    /**
     * Eski `subtitles` parametresi + yeni `options` override'ını kullanıcı
     * varsayılanlarıyla birleştir. `subtitles` yalnız açıkça false ise
     * varsayılanı ezer (true çağıranların "belirtmedim" durumudur).
     */
    async _mergeOptions(subtitles, options, group = 'live') {
        const override = { ...(options || {}) };
        if (subtitles === false && override.subtitles === undefined) {
            override.subtitles = false;
        }
        return this.resolveOptions(override, group);
    }

    /**
     * !clip komutuyla / hızlı klip butonlarıyla üretilen yerel klibi kuyruğa
     * ekle — VOD taramasının seçtiği highlight/sahne pencereleri de aynı
     * yoldan (source='vod-scan', group='vodscan'|'horizontal', vodScanJobId
     * ile ilişkilendirilerek) girer.
     */
    async enqueueLocalClip(localPath, {
        title = '', source = 'chat', subtitles, options = null, vodScanJobId = null, group = 'live',
        precomputedScore = undefined, precomputedScoreReason = undefined,
    } = {}) {
        if (!fs.existsSync(localPath)) {
            throw new Error('Yerel klip dosyası bulunamadı');
        }
        const merged = await this._mergeOptions(subtitles, options, group);
        const record = await this.db.addEditedClip(this.userId, {
            source,
            sourceClipId: null,
            sourceUrl: null,
            title: title || path.basename(localPath, '.mp4'),
            channelSlug: this.channelSlug,
            viewCount: 0,
            subtitles: merged.subtitles,
            options: merged,
            vodScanJobId,
            // VOD tarama yatay kesitleri için önceden hesaplanmış puan —
            // _processHorizontal bu alana hiç dokunmadığından üretim
            // bitince de kalıcı kalır (bkz. VodScanManager._cutAndEnqueue).
            viralScore: precomputedScore,
            viralReason: precomputedScoreReason,
        });
        this._schedule(record.id, { localPath });
        return record;
    }

    /**
     * Bir Kick klibini kuyruğa ekle (gezginden seçilen veya chatte tespit edilen)
     */
    async enqueueKickClip(clipId, { title = '', channelSlug = '', source = 'chat', subtitles, options = null, group = 'gezgin' } = {}) {
        const info = await this.fetcher.getClipInfo(clipId);
        const merged = await this._mergeOptions(subtitles, options, group);
        const record = await this.db.addEditedClip(this.userId, {
            source,
            sourceClipId: clipId,
            sourceUrl: info.videoUrl,
            title: title || info.title || clipId,
            channelSlug: channelSlug || this.channelSlug,
            viewCount: info.viewCount,
            subtitles: merged.subtitles,
            options: merged,
        });
        this._schedule(record.id, { videoUrl: info.videoUrl });
        return record;
    }

    /**
     * Bir KickBot klibini kuyruğa ekle (kickbot.com/clip/xxx)
     * KickBot klipleri Kick native değildir; ayrı CDN'den HLS indirilir.
     */
    async enqueueKickbotClip(clipId, { title = '', channelSlug = '', source = 'chat', subtitles, options = null, group = 'gezgin' } = {}) {
        const info = await this.fetcher.resolveKickbotClip(clipId);
        const merged = await this._mergeOptions(subtitles, options, group);
        const record = await this.db.addEditedClip(this.userId, {
            source,
            // Kick native ID'lerle çakışmasın diye önek
            sourceClipId: `kickbot_${clipId}`,
            sourceUrl: info.videoUrl,
            title: title || info.title || `KickBot ${clipId}`,
            channelSlug: channelSlug || this.channelSlug,
            viewCount: 0,
            subtitles: merged.subtitles,
            options: merged,
        });
        this._schedule(record.id, { videoUrl: info.videoUrl });
        return record;
    }

    /**
     * Kanal kliplerini gez ve her birini "işlenmiş mi" bilgisiyle işaretle
     */
    async browseChannelClips(channelSlug, { cursor = 0, time = 'all', sort = 'view' } = {}) {
        const page = await this.fetcher.browseClips(channelSlug, { cursor, time, sort });
        const processedMap = await this.db.getEditedClipsBySourceIds(
            this.userId,
            page.clips.map(c => c.id)
        );
        for (const clip of page.clips) {
            const job = processedMap.get(clip.id);
            clip.processed = !!job;
            clip.jobId = job?.id || null;
            clip.jobStatus = job?.status || null;
        }
        return page;
    }

    /**
     * KickBot'taki kanal kliplerini gez — "işlenmiş mi" bilgisi kickbot_
     * önekli sourceClipId üzerinden eşlenir
     */
    async browseKickbotChannelClips(channelSlug, { offset = 0, sort = 'view', time = 'all' } = {}) {
        const page = await this.fetcher.browseKickbotClips(channelSlug, { offset, sort, time });
        const processedMap = await this.db.getEditedClipsBySourceIds(
            this.userId,
            page.clips.map(c => `kickbot_${c.id}`)
        );
        for (const clip of page.clips) {
            const job = processedMap.get(`kickbot_${clip.id}`);
            clip.processed = !!job;
            clip.jobId = job?.id || null;
            clip.jobStatus = job?.status || null;
        }
        return page;
    }

    /**
     * Otomatik planlı paylaşımı ayarla (LiveClipWatcher tarafından çağrılır).
     * enabled + hesaplar verilir; canlı-tespit (source='live') klipleri işlenince
     * 1'er saat aralıkla planlanarak yayınlanır (ilki hemen).
     */
    setAutoPublish({ enabled, accounts } = {}) {
        this._autoPublish = {
            // Hesap bağlantısı paylaşım anında kullanıcının ayarlarından doğrulanır.
            enabled: !!enabled,
            accounts: Array.isArray(accounts) ? accounts : [],
        };
        // Yeniden açılışta stagger sıfırlanır — ilk klip hemen gider
        if (!this._autoPublish.enabled) this._nextPublishAt = null;
    }

    /**
     * Kullanıcının yüklediği logonun dosya yolu (varsa)
     */
    getLogoPath() {
        const logoPath = path.join(CLIP_OUTPUT_DIR, String(this.userId), 'logo.png');
        return fs.existsSync(logoPath) ? logoPath : null;
    }

    /**
     * Boot mutabakatı — restart'ta yarım kalan işleri toparla.
     *
     * Kuyruk bellek-içi olduğundan sunucu yeniden başlayınca 'queued' ve
     * 'processing' kayıtlar sonsuza dek donuk kalıyordu (%75'te takılı bar).
     * Kaynağı URL olan işler yeniden kuyruğa alınır; yerel kaynaklılar
     * (work dizini temizlendiği için) anlaşılır bir mesajla failed yapılır.
     * Session kurulurken (UserSessionManager) çağrılır.
     */
    async recoverPendingJobs() {
        const pending = await this.db.getPendingEditedClips(this.userId);
        if (pending.length === 0) return { requeued: 0, failed: 0 };

        let requeued = 0;
        let failed = 0;
        for (const job of pending) {
            if (job.source_url) {
                await this.db.updateEditedClip(job.id, this.userId, {
                    status: 'queued', step: '', error: null,
                });
                this._schedule(job.id, { videoUrl: job.source_url });
                requeued++;
            } else {
                const msg = 'Sunucu yeniden başlatıldığı için iş yarım kaldı; kaynak yerel dosyaydı ve artık yok. Klibi yeniden alın.';
                await this.db.updateEditedClip(job.id, this.userId, {
                    status: 'failed', error: msg,
                });
                this._emit(job.id, 'failed', msg);
                failed++;
            }
        }
        console.log(`[ClipEditor:${this.userId}] ♻️ Boot mutabakatı: ${requeued} iş yeniden kuyruğa alındı, ${failed} iş failed işaretlendi`);
        return { requeued, failed };
    }

    /**
     * Başarısız işi yeniden dene
     */
    async retry(jobId) {
        const job = await this.db.getEditedClipById(jobId, this.userId);
        if (!job) throw new Error('İş bulunamadı');
        // Yalnız başarısız iş yeniden denenir: işlenen bir iş ikinci kez kuyruğa
        // girerse iki süreç aynı çalışma dizinine ve çıktıya yazar.
        if (job.status !== 'failed') throw new Error('Yalnız başarısız klipler yeniden denenebilir');
        // Yerel kaynaklı işlerde (!clip çıktısı) source_url NULL olur; çalışma
        // dizini de temizlendiğinden yeniden denenecek bir kaynak yoktur
        if (!job.source_url) {
            throw new Error('Bu klibin kaynağı yerel dosyaydı ve artık yok — yeniden deneme yapılamaz.');
        }
        await this.db.updateEditedClip(jobId, this.userId, { status: 'queued', step: '', error: null });
        this._schedule(jobId, { videoUrl: job.source_url });
        return true;
    }

    /**
     * "Paylaş" modalındaki kırpma aracı — hazır bir dikey klibin ÇIKTI
     * dosyasını elle seçilen yatay pencereye kırpıp yeniden kaydeder.
     * Orijinal ham kaynak klip üretimi bitince saklanmadığından (jobWorkDir
     * finally'de silinir) yeniden facecam tespiti yapmak yerine mevcut
     * kompoze çıktı üzerinde ikincil bir kırpma uygulanır — bu yüzden
     * yalnızca dikey (`layout !== 'horizontal'`) ve `status:'ready'` klipler
     * desteklenir. Mevcut iş kuyruğunu (scheduleJob) kullanır ki CPU'yu
     * normal klip üretimiyle aynı eşzamanlılık sınırı paylaşsın.
     */
    async recropClip(jobId, { cropLeft, cropRight } = {}) {
        const job = await this.db.getEditedClipById(jobId, this.userId);
        if (!job) throw new Error('İş bulunamadı');
        if (job.status !== 'ready') throw new Error('Yalnızca hazır klipler kırpılabilir');
        if (job.layout === 'horizontal') throw new Error('Kırpma yalnızca dikey klipler için kullanılabilir');

        const left = Math.max(0, Math.min(0.75, Number(cropLeft) || 0));
        const right = Math.max(left + 0.25, Math.min(1, cropRight === undefined || cropRight === null ? 1 : Number(cropRight)));
        if (right - left >= 0.999) throw new Error('Kırpma alanı seçilmedi — bir bölge belirleyin');

        await this._setStep(jobId, 'processing', 'kırpılıyor');
        let failure = null;
        await scheduleJob(async () => {
            try {
                await this._runRecrop(jobId, left, right, job.duration);
            } catch (err) {
                failure = err;
                // Orijinal çıktı dosyasına DOKUNULMADI (ffmpeg geçici dosyaya
                // yazıyor, yalnız başarıda taşınıyor) — klip hâlâ geçerli,
                // 'failed' yerine 'ready'ye geri dönülür ki panelde video/
                // indir linki kaybolmasın.
                await this.db.updateEditedClip(jobId, this.userId, { status: 'ready', step: 'tamamlandı' }).catch(() => {});
                this._emit(jobId, 'ready', 'tamamlandı');
                console.error(`[ClipEditor:${this.userId}] Kırpma hatası (${jobId}):`, err.message);
            }
        });
        if (failure) throw new Error(ClipEditorManager.friendlyError(failure.message));
        return this.db.getEditedClipById(jobId, this.userId);
    }

    async _runRecrop(jobId, left, right, durationSec) {
        const outputPath = path.join(this.outputDir, `${jobId}.mp4`);
        const tmpPath = path.join(this.outputDir, `${jobId}_recrop_tmp.mp4`);
        if (!fs.existsSync(outputPath)) throw new Error('Klip dosyası bulunamadı — süresi dolmuş olabilir');
        try {
            await this.composer.recrop({ inputPath: outputPath, outputPath: tmpPath, cropLeft: left, cropRight: right, durationSec });
            fs.renameSync(tmpPath, outputPath);
        } finally {
            try { fs.unlinkSync(tmpPath); } catch { /* başarıda zaten taşınmış — yoksay */ }
        }

        const thumbPath = path.join(this.outputDir, `${jobId}_thumb.jpg`);
        const thumbOk = await this.composer.thumbnail(outputPath, thumbPath).catch(() => null);
        const size = fs.statSync(outputPath).size;
        // Dosya adı aynı kalıyor (içerik değişti) — tarayıcı önbelleğini
        // atlatmak için sürüm sorgu parametresi eklenir.
        const stamp = Date.now();
        const update = {
            status: 'ready', step: 'tamamlandı',
            video_url: `/clips/${this.userId}/vertical/${jobId}.mp4?v=${stamp}`,
            file_size_bytes: size,
        };
        if (thumbOk) update.thumbnail_url = `/clips/${this.userId}/vertical/${jobId}_thumb.jpg?v=${stamp}`;
        await this.db.updateEditedClip(jobId, this.userId, update);
        this._emit(jobId, 'ready', 'tamamlandı');
        console.log(`[ClipEditor:${this.userId}] ✅ İş ${jobId} kırpıldı (%${Math.round((right - left) * 100)} genişlik)`);
    }

    /**
     * İşi ve dosyalarını sil
     */
    async remove(jobId) {
        const job = await this.db.getEditedClipById(jobId, this.userId);
        if (!job) return false;
        // İşlenmekte olan klip silinemez — süreç bitince yetim çıktı dosyası kalırdı.
        if (job.status === 'queued' || job.status === 'processing') throw new Error('İşlenmekte olan klip silinemez — bitmesini bekle');
        for (const suffix of ['.mp4', '_thumb.jpg']) {
            try { fs.unlinkSync(path.join(this.outputDir, `${jobId}${suffix}`)); } catch { /* yok */ }
        }
        await this.db.deleteEditedClip(jobId, this.userId);
        return true;
    }

    // ==========================================
    // İŞLEME
    // ==========================================

    /**
     * Canlı-tespit klibini (source='live') otomatik planlı yayınla.
     * İlk klip hemen, sonrakiler 1'er saat aralıkla planlanır (stagger).
     * Bozuk (qc broken) klipler yayınlanmaz.
     */
    async _maybeAutoPublish(jobId, qcVerdict) {
        if (!this._autoPublish.enabled || this._autoPublish.accounts.length === 0) return;
        if (qcVerdict === 'broken') {
            console.log(`[ClipEditor:${this.userId}] İş ${jobId} bozuk — otomatik paylaşılmadı`);
            return;
        }

        const job = await this.db.getEditedClipById(jobId, this.userId);
        if (!job || job.source !== 'live') return; // sadece canlı-tespit klipleri

        // Viral skor eşiği (Stüdyo Ayarları): eşik tanımlı ve skor hesaplanmışsa
        // altında kalan klip paylaşılmaz; skor hesaplanamadıysa (AI yok) engel olmaz
        let minScore = 0;
        const settings = await this.db.getSettings(this.userId).catch(() => null);
        try {
            minScore = ClipEditorManager.normalizeClipOptions(JSON.parse(job.options || '{}')).autoPublishMinScore;
        } catch { /* eski kayıt — eşiksiz */ }
        const profileId = String(settings?.zernio_profile_id || '').trim();
        const apiKey = settings?.zernio_api_key || null;
        if (!isValidProfileId(profileId) || !ZernioPublisher.isAvailable(apiKey)) return;
        const publisher = new ZernioPublisher({ profileId, apiKey });
        if (minScore > 0 && Number.isFinite(job.viral_score) && job.viral_score < minScore) {
            console.log(`[ClipEditor:${this.userId}] İş ${jobId} viral skor ${job.viral_score} < eşik ${minScore} — otomatik paylaşılmadı`);
            return;
        }

        // Watch başlatıldıktan sonra hesap bağlantısı/profili değişmiş olabilir;
        // dış çağrıdan hemen önce kullanıcının güncel profil kapsamını doğrula.
        const connectedAccounts = await publisher.listAccounts();
        const connectedKeys = new Set(connectedAccounts.map(account => `${account.platform}:${account.id}`));
        const hasUnavailableAccount = this._autoPublish.accounts.some(account =>
            !connectedKeys.has(`${account.platform}:${account.accountId}`));
        if (hasUnavailableAccount) {
            console.warn(`[ClipEditor:${this.userId}] İş ${jobId} otomatik paylaşılmadı — hesap bağlantısı veya profil kapsamı değişti`);
            return;
        }

        const claimedJob = await this.db.claimEditedClipForPublish(jobId, this.userId);
        if (!claimedJob) {
            console.log(`[ClipEditor:${this.userId}] İş ${jobId} için başka bir paylaşım işlemi zaten başladı`);
            return;
        }

        // Stagger: ilk klip hemen, sonrakiler +1 saat.
        // Zaman damgası DB'de tutulur — restart'ta sıfırlanıp aynı saate
        // birden çok paylaşım yığılmasın.
        const now = Date.now();
        if (this._nextPublishAt === null) {
            const freshSettings = settings || await this.db.getSettings(this.userId).catch(() => null);
            const saved = parseInt(freshSettings?.clip_next_publish_at) || 0;
            this._nextPublishAt = saved > now ? saved : null;
        }
        let publishAt;
        if (!this._nextPublishAt || this._nextPublishAt <= now) {
            publishAt = now;
            this._nextPublishAt = now + PUBLISH_INTERVAL_MS;
        } else {
            publishAt = this._nextPublishAt;
            this._nextPublishAt += PUBLISH_INTERVAL_MS;
        }
        await this.db.updateSettings(this.userId, { clip_next_publish_at: this._nextPublishAt }).catch(() => {});
        const immediate = publishAt <= now + 60000;

        // Açıklama = gen_description + hashtag
        let hashtags = [];
        try { hashtags = JSON.parse(job.gen_hashtags || '[]'); } catch { /* boş */ }
        const tagStr = hashtags.map(h => '#' + h).join(' ');
        const content = (job.gen_description || '') + (tagStr ? '\n\n' + tagStr : '');
        const videoPath = path.join(this.outputDir, `${jobId}.mp4`);

        let providerAccepted = false;
        try {
            const requestId = createPublishRequestId({
                userId: this.userId,
                jobId,
                accounts: this._autoPublish.accounts,
                content,
                scheduledFor: immediate ? null : new Date(publishAt),
            });
            // title YOK — ZernioPublisher açıklamanın ilk satırını YouTube
            // başlığı olarak otomatik türetir (orijinal klip başlığı hiç
            // kullanılmaz, yayıncı adı sızmasın diye).
            const result = await publisher.publish({
                videoPath,
                content,
                accounts: this._autoPublish.accounts,
                scheduledFor: immediate ? null : new Date(publishAt),
                requestId,
            });
            providerAccepted = true;
            const publishStatus = normalizePublishStatus(result.status, {
                scheduledFor: immediate ? null : new Date(publishAt),
            });
            // Panelin "Planlanan Gönderiler" listesi platform kırılımını okur;
            // sağlayıcı henüz vermediyse seçilen hesaplardan iskelet yazılır.
            const platformResults = result.platforms?.length
                ? result.platforms
                : normalizePlatformResults(this._autoPublish.accounts.map(account => ({
                    platform: account.platform,
                    status: immediate ? 'pending' : 'scheduled',
                })));
            await this.db.updateEditedClip(jobId, this.userId, {
                publish_status: publishStatus,
                publish_post_id: result.postId || null,
                publish_started_at: null,
                scheduled_for: immediate ? null : new Date(publishAt),
                publish_timezone: immediate ? null : AUTO_PUBLISH_TIMEZONE,
                publish_platforms: JSON.stringify(platformResults),
                published_at: publishStatus === 'published' ? new Date() : null,
            });
            const whenStr = immediate
                ? `yayın servisine gönderildi (${publishStatus})`
                : `${new Date(publishAt).toLocaleString('tr-TR')} için planlandı`;
            console.log(`[ClipEditor:${this.userId}] 📤 İş ${jobId} ${whenStr}`);
            this._emit(jobId, 'ready', 'tamamlandı');
            if (this.io) {
                this.io.to(`user:${this.userId}`).emit('clipedit:published', {
                    jobId, status: publishStatus, scheduledFor: immediate ? null : publishAt,
                });
            }
        } catch (err) {
            if (err.publishOutcomeUnknown) {
                // POST sonucu ağ nedeniyle belirsizse tekrar denemeyi açma;
                // dış gönderi oluşmuş olabilir.
                await this.db.updateEditedClip(jobId, this.userId, {
                    publish_status: 'unknown',
                    publish_started_at: null,
                }).catch(() => {});
            } else if (!providerAccepted) {
                // Yalnız dış sağlayıcı isteği gerçekten başarısızsa yeniden denemeyi
                // aç. Sağlayıcı kabulünden sonraki DB hatasında claim kilitli kalır;
                // aksi halde oluşturulmuş dış gönderi ikinci kez yollanabilir.
                this._nextPublishAt -= PUBLISH_INTERVAL_MS;
                await this.db.updateSettings(this.userId, { clip_next_publish_at: this._nextPublishAt }).catch(() => {});
                await this.db.updateEditedClip(jobId, this.userId, {
                    publish_status: 'failed',
                    publish_started_at: null,
                }).catch(() => {});
            }
            throw err;
        }
    }

    /**
     * Klibi indir; geçici hatalarda (CDN henüz hazır değil) backoff ile tekrar dene.
     * KickBot klipleri chat'e düştüğü an CDN kodlaması bitmemiş olabilir.
     */
    async _downloadWithRetry(jobId, videoUrl, inputPath) {
        const delays = [0, 15000, 30000, 45000]; // ilk deneme + 3 tekrar
        let lastErr;
        for (let i = 0; i < delays.length; i++) {
            if (delays[i] > 0) {
                // Adım adı STEP_PROGRESS'te tanımlı 'indiriliyor' olarak KALIR,
                // aksi halde ilerleme çubuğu %10'dan %0'a düşüyordu
                await this._setStep(jobId, 'processing', 'indiriliyor');
                await new Promise(r => setTimeout(r, delays[i]));
            }
            try {
                await this.fetcher.downloadClip(videoUrl, inputPath);
                return;
            } catch (err) {
                lastErr = err;
                // Geçici sunucu/erişim hataları tekrar denenir; kalıcı olanlar (404) hemen çıkar
                const msg = err.message || '';
                if (/404|not found|Geçersiz/i.test(msg)) break;
                console.warn(`[ClipEditor:${this.userId}] İndirme denemesi ${i + 1} başarısız: ${msg.slice(0, 80)}`);
            }
        }
        throw lastErr || new Error('İndirme başarısız');
    }

    _schedule(jobId, inputs) {
        scheduleJob(() => this._process(jobId, inputs));
    }

    /** İş kuyruğu durumu — makine geneli (panel gösterir) */
    static getQueueStatus() {
        return getQueueStatus();
    }

    async _process(jobId, { videoUrl, localPath }) {
        // Session yok edildiyse eski closure çalışmasın — iş DB'de 'queued'
        // kalır, bir sonraki session açılışında recoverPendingJobs devralır.
        if (this._destroyed) {
            console.log(`[ClipEditor:${this.userId}] İş ${jobId} atlandı — session kapatılmış`);
            return;
        }
        const jobWorkDir = path.join(this.workDir, String(jobId));
        fs.mkdirSync(jobWorkDir, { recursive: true });
        fs.mkdirSync(this.outputDir, { recursive: true });

        try {
            // İş kaydı + kullanıcı ayarları + üretim seçenekleri (Stüdyo Ayarları).
            // Seçenekler iş kaydından okunur — retry/kurtarma aynı ayarla döner.
            const jobRow = await this.db.getEditedClipById(jobId, this.userId).catch(() => null);
            const userSettings = await this.db.getSettings(this.userId).catch(() => null);
            let rawOpts = {};
            try { rawOpts = JSON.parse(jobRow?.options || '{}') || {}; } catch { /* eski kayıt */ }
            // options'sız eski işlerde subtitles kolonundaki tercih korunur
            if (rawOpts.subtitles === undefined && jobRow) rawOpts.subtitles = jobRow.subtitles !== false;
            const opts = ClipEditorManager.normalizeClipOptions(rawOpts);
            // İçerik dili — transkript ve AI çıktıları (açıklama, hashtag) bu dilde
            const language = opts.subtitleLang !== 'auto'
                ? opts.subtitleLang
                : (userSettings?.language === 'en' ? 'en' : 'tr');

            // 1. Kaynak video
            let inputPath = localPath;
            if (!inputPath) {
                await this._setStep(jobId, 'processing', 'indiriliyor');
                inputPath = path.join(jobWorkDir, 'source.mp4');
                // Yeni oluşturulan klipler (özellikle KickBot) CDN'de henüz hazır
                // olmayabilir — geçici indirme hatalarında backoff ile tekrar dene
                await this._downloadWithRetry(jobId, videoUrl, inputPath);
            } else {
                await this._setStep(jobId, 'processing', 'hazırlanıyor');
            }

            // 1b. Yatay kesit (VOD sahne taraması) — facecam/dikey kompozisyon
            // tamamen atlanır; kaynak zaten doğru segmente kesilmiş olarak gelir.
            if (opts.outputFormat === 'horizontal') {
                await this._processHorizontal(jobId, inputPath, jobWorkDir, jobRow, opts, language);
                return;
            }

            // 2. Facecam tespiti — kompozisyon tercihi tespiti ezebilir ('single')
            await this._setStep(jobId, 'processing', 'facecam tespiti');
            const facecam = await this.detector.detect(inputPath);
            const isSplit = VerticalComposer.isSplit(facecam, opts.composition);

            // 3. Odak belirleme: bölünmüş düzende hareket analizi; tek parça
            // düzende konuşan kişiye (tespit edilen yüze) odaklan
            await this._setStep(jobId, 'processing', 'hareket analizi');
            let focus;
            if (!isSplit && facecam.face) {
                focus = { focusX: facecam.face.x, focusY: facecam.face.y };
            } else {
                focus = await this.cropper.findFocus(
                    inputPath, facecam.meta,
                    isSplit ? facecam.rect : null
                );
            }

            // 3b. IRL / tek-parça (webcam yok) → kişinin yüzünü takip et.
            // Yumuşatılmış anahtar karelerle kamera akıcı kayar (takılma yok).
            let faceTrack = null;
            if (!isSplit) {
                await this._setStep(jobId, 'processing', 'yüz takibi');
                faceTrack = await this.detector.trackFace(inputPath, facecam.meta, { count: 30 })
                    .catch(err => {
                        console.error(`[ClipEditor:${this.userId}] Yüz takibi hatası:`, err.message);
                        return null;
                    });
                if (faceTrack) {
                    console.log(`[ClipEditor:${this.userId}] 🎯 Yüz takibi: ${faceTrack.keyframes.length} kare, kapsam %${Math.round(faceTrack.coverage * 100)}`);
                }
            }

            // Logo (yüklüyse + tercihte açıksa) — altyazı konumu logoya göre hesaplanır
            const logoPath = opts.logo ? this.getLogoPath() : null;

            // 4. Transkript + altyazı — iş bazında kapatılabilir (subtitles=false).
            // Sansür (censor) altyazı kapalıyken de transkripti gerektirir —
            // hangi anların biplenceğini bilmek için kelime zamanlaması şart.
            const wantSubtitles = opts.subtitles;
            let transcript = null;
            let assPath = null;
            if ((wantSubtitles || opts.censor) && Transcriber.isAvailable()) {
                await this._setStep(jobId, 'processing', 'transkript çıkarılıyor');
                transcript = await this.transcriber.transcribe(inputPath, jobWorkDir, {
                    language,
                    // Adaptif timeout: uzun klipler sabit 120 sn'de SIGTERM yiyordu
                    durationSec: facecam.meta.duration || 0,
                }).catch(err => {
                    console.error(`[ClipEditor:${this.userId}] Transkript hatası:`, err.message);
                    return null;
                });
                if (wantSubtitles && transcript && transcript.segments.length > 0) {
                    const layout = await this.composer.computeLayout(facecam, logoPath, {
                        composition: opts.composition,
                        logoPosition: opts.logoPosition,
                        logoScale: opts.logoScale,
                    });
                    assPath = path.join(jobWorkDir, 'subtitles.ass');
                    // Altyazı stili + vurgu rengi: iş seçeneği > kullanıcı marka kiti;
                    // "temayı izle" açıksa vurgu panel accent renginden gelir
                    this.transcriber.buildAss(transcript.segments, assPath, layout, {
                        key: opts.subtitleStyle || userSettings?.subtitle_style || 'classic',
                        accent: (opts.subtitleFollowsTheme
                            ? userSettings?.accent_color
                            : userSettings?.brand_color) || '#53fc18',
                    });
                }
            } else if (!wantSubtitles) {
                console.log(`[ClipEditor:${this.userId}] İş ${jobId} — altyazı kullanıcı tercihiyle kapalı, transkript atlandı`);
            }

            // 5. Kompozisyon
            await this._setStep(jobId, 'processing', 'video oluşturuluyor');
            const outputPath = path.join(this.outputDir, `${jobId}.mp4`);
            await this.composer.compose({
                inputPath, outputPath, facecam, focus, faceTrack, assPath, logoPath,
                composition: opts.composition,
                logoPosition: opts.logoPosition,
                logoScale: opts.logoScale,
                logoOpacity: opts.logoOpacity,
                logoX: opts.logoX,
                logoY: opts.logoY,
                camFullRanges: opts.camFullRanges,
            });
            if (opts.camFullRanges.length && !facecam.rect) {
                console.warn(`[ClipEditor:${this.userId}] İş ${jobId} — tam ekran bölgesi istendi ama webcam kutusu tespit edilemedi, atlandı`);
            }

            // 5b. Sansür — küfür geçen anlar biplenir (opsiyonel)
            await this._applyCensorIfNeeded(jobId, opts, transcript, outputPath, jobWorkDir, facecam.meta.duration || 0);

            // 6. Kalite kontrolü — boyut/SAR/süre/akış doğrulaması geçmeyen
            // klip 'ready' işaretlenmez
            await this._setStep(jobId, 'processing', 'kontrol ediliyor');
            const check = await this.composer.verifyOutput(outputPath, facecam.meta.duration);
            if (!check.ok) {
                try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
                throw new Error(`Kalite kontrolü başarısız: ${check.issues.join('; ')}`);
            }
            console.log(`[ClipEditor:${this.userId}] Kontrol OK — ${check.info.width}x${check.info.height} SAR ${check.info.sar} ${check.info.duration}sn ${check.info.sizeKB}KB ses:${check.info.hasAudio ? 'var' : 'yok'}`);

            const thumbPath = path.join(this.outputDir, `${jobId}_thumb.jpg`);
            await this.composer.thumbnail(outputPath, thumbPath).catch(() => null);

            // 6b. Görsel kalite kontrolü — kaynak ile çıktıyı karşılaştır (Gemini).
            // Bozuk/şüpheli çıktılar işaretlenir; 'broken' yayınlanamaz.
            await this._setStep(jobId, 'processing', 'kalite denetimi');
            const qcResult = await this.qc.check({
                sourcePath: inputPath,
                outputPath,
                facecam,
                verifyInfo: check.info,
                workDir: jobWorkDir,
            }).catch(err => {
                console.error(`[ClipEditor:${this.userId}] QC hatası:`, err.message);
                return { verdict: 'suspicious', issues: ['Kalite denetimi yapılamadı'] };
            });
            console.log(`[ClipEditor:${this.userId}] QC: ${qcResult.verdict}${qcResult.issues.length ? ' — ' + qcResult.issues.join('; ') : ''}`);

            // Önem sıralı vurgu listesi (en yüksek puanlı 10 segment)
            const highlights = transcript
                ? [...transcript.segments].sort((a, b) => b.score - a.score).slice(0, 10)
                : [];

            // 7. Paylaşım metadatası — transkriptten makara açıklama + hashtag (Gemini)
            //    Başlık ÜRETİLMEZ; kanal adı bilerek gönderilmez.
            let meta = null;
            if (AUTO_METADATA && MetadataGenerator.isAvailable()) {
                await this._setStep(jobId, 'processing', 'açıklama üretiliyor');
                meta = await this.metadata.generate({
                    segments: transcript?.segments || [],
                    sourceTitle: jobRow?.title || '',
                    language,
                }).catch(err => {
                    console.error(`[ClipEditor:${this.userId}] Metadata hatası:`, err.message);
                    return null;
                });
            }

            // 7b. Viral skor — "hangi klibi paylaşayım" kararı için 0-100 puan
            await this._setStep(jobId, 'processing', 'viral skor');
            const viral = await this.scorer.score({
                segments: transcript?.segments || [],
                duration: facecam.meta.duration || 0,
                viewCount: jobRow?.view_count || 0,
                language,
            }).catch(err => {
                console.error(`[ClipEditor:${this.userId}] Viral skor hatası:`, err.message);
                return null;
            });
            if (viral) {
                console.log(`[ClipEditor:${this.userId}] 🔥 Viral skor: ${viral.score}/100 — ${viral.reason}`);
            }

            await this.db.updateEditedClip(jobId, this.userId, {
                status: 'ready',
                step: 'tamamlandı',
                video_url: `/clips/${this.userId}/vertical/${jobId}.mp4`,
                thumbnail_url: fs.existsSync(thumbPath) ? `/clips/${this.userId}/vertical/${jobId}_thumb.jpg` : null,
                duration: Math.round(facecam.meta.duration || 0),
                layout: isSplit ? 'split' : 'single',
                transcript: transcript ? JSON.stringify(transcript.segments) : null,
                highlights: JSON.stringify(highlights),
                qc: JSON.stringify(check.info),
                gen_description: meta?.description || null,
                gen_hashtags: meta?.hashtags ? JSON.stringify(meta.hashtags) : null,
                qc_verdict: qcResult.verdict,
                qc_issues: JSON.stringify(qcResult.issues || []),
                file_size_bytes: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : null,
                viral_score: viral?.score ?? null,
                viral_reason: viral ? [viral.reason, viral.hook ? `En güçlü an: ${viral.hook}` : ''].filter(Boolean).join(' ') : null,
            });
            this._emit(jobId, 'ready', 'tamamlandı');
            console.log(`[ClipEditor:${this.userId}] ✅ İş ${jobId} hazır (facecam: ${facecam.found ? (facecam.fullCam ? 'tam-kamera' : 'bölünmüş') : 'yok'}, altyazı: ${assPath ? 'var' : 'yok'})`);

            // 8. Otomatik planlı paylaşım (canlı-tespit klipleri, ayar açıksa)
            await this._maybeAutoPublish(jobId, qcResult.verdict).catch(err => {
                console.error(`[ClipEditor:${this.userId}] Otomatik paylaşım hatası (${jobId}):`, err.message);
            });

        } catch (err) {
            console.error(`[ClipEditor:${this.userId}] ❌ İş ${jobId} hatası:`, err.message);
            // Ham ffmpeg/ffprobe çıktısı kullanıcıya hiçbir şey ifade etmiyordu
            const friendly = ClipEditorManager.friendlyError(err.message);
            await this.db.updateEditedClip(jobId, this.userId, {
                status: 'failed',
                error: friendly,
            }).catch(() => {});
            this._emit(jobId, 'failed', friendly);
        } finally {
            // Çalışma dizinini temizle
            try { fs.rmSync(jobWorkDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }

    /**
     * Küfür geçen anları biplenmiş sesle değiştirir (opsiyonel — opts.censor).
     * Hem dikey hem yatay akış tarafından, kompozisyondan SONRA çağrılır
     * (nihai çıktı dosyası üzerinde çalışır, üstüne yazar).
     */
    async _applyCensorIfNeeded(jobId, opts, transcript, outputPath, jobWorkDir, duration, offsetSec = 0) {
        if (!opts.censor || !transcript?.words?.length) return;
        // offsetSec: çıktının başına intro eklendiyse transkript zamanları o kadar kayar
        const ranges = ProfanityCensor.detectRanges(transcript.words)
            .map(r => ({ ...r, start: r.start + offsetSec, end: r.end + offsetSec }));
        if (ranges.length === 0) return;

        await this._setStep(jobId, 'processing', 'küfür bipleniyor');
        const censoredPath = path.join(jobWorkDir, 'censored.mp4');
        await AudioCensor.apply(outputPath, censoredPath, ranges, duration);
        fs.renameSync(censoredPath, outputPath);
        console.log(`[ClipEditor:${this.userId}] 🔇 İş ${jobId} — ${ranges.length} an biplendi`);
    }

    /**
     * Yatay kesit akışı — VOD sahne taramasından gelen, zaten doğru aralığa
     * kesilmiş ham segmenti işler. Facecam/kırpma/kompozisyon yok; yalnızca
     * hedef konuma taşı, doğrula, küçük görsel üret, isteğe bağlı transkriptten
     * başlık/açıklama üret. Hata durumunda throw eder — çağıran (_process)
     * ortak catch/finally ile karşılar.
     *
     * Transkript sansür AÇIKSA süre sınırı olmadan (saatlik segment olsa
     * bile — hangi anların biplenceğini bilmek şart), değilse yalnız kısa
     * segmentlerde (açıklama üretimi için) alınır; çok uzun ham kesitleri
     * (ör. 2 saatlik oyun bölümü) salt açıklama üretmek için transkribe
     * etmek gereksiz maliyetli olurdu.
     */
    async _processHorizontal(jobId, inputPath, jobWorkDir, jobRow, opts, language) {
        await this._setStep(jobId, 'processing', 'kontrol ediliyor');
        const meta = await this.detector.probe(inputPath);
        const duration = meta.duration || 0;

        // Transkript: sansür açıksa süre sınırı yok (bipleme için şart);
        // değilse yalnız kısa segmentlerde açıklama üretimi için alınır —
        // saatlik ham kesitleri salt başlık/açıklama için transkribe etmek
        // gereksiz maliyetli olurdu.
        let transcript = null;
        const wantsMetadataTranscript = AUTO_METADATA && duration <= HORIZONTAL_METADATA_TRANSCRIBE_CAP_SEC;
        if (Transcriber.isAvailable() && (opts.censor || opts.subtitles || wantsMetadataTranscript)) {
            await this._setStep(jobId, 'processing', 'transkript çıkarılıyor');
            transcript = await this.transcriber.transcribe(inputPath, jobWorkDir, {
                language, durationSec: duration,
            }).catch(err => {
                console.error(`[ClipEditor:${this.userId}] Transkript hatası (yatay):`, err.message);
                return null;
            });
        }

        const outputPath = path.join(this.outputDir, `${jobId}.mp4`);
        const logoPath = opts.logo ? this.getLogoPath() : null;

        // Altyazı: kesitin kendi ölçüsünde (PlayRes) üretilir ki her çözünürlükte oran aynı kalsın.
        let assPath = null;
        if (opts.subtitles && transcript?.segments?.length && meta.width && meta.height) {
            const userSettings = await this.db.getSettings(this.userId).catch(() => null);
            assPath = path.join(jobWorkDir, 'subtitles.ass');
            this.transcriber.buildAss(transcript.segments, assPath, HorizontalComposer.subtitleLayout(meta), {
                key: opts.subtitleStyle || userSettings?.subtitle_style || 'classic',
                accent: (opts.subtitleFollowsTheme ? userSettings?.accent_color : userSettings?.brand_color) || '#53fc18',
            });
        }

        // Tam ekran bölgeleri: webcam kutusu gerekir — yatay akış normalde
        // facecam tespiti yapmaz, yalnız bölge işaretlendiyse çalıştırılır.
        let camFull = null;
        if (opts.camFullRanges.length) {
            await this._setStep(jobId, 'processing', 'facecam tespiti');
            const facecam = await this.detector.detect(inputPath).catch(err => {
                console.error(`[ClipEditor:${this.userId}] Facecam tespiti hatası (yatay):`, err.message);
                return null;
            });
            if (facecam?.rect) {
                camFull = { rect: facecam.rect, face: facecam.face || null, ranges: opts.camFullRanges };
            } else {
                console.warn(`[ClipEditor:${this.userId}] İş ${jobId} — tam ekran bölgesi istendi ama webcam kutusu tespit edilemedi, atlandı`);
            }
        }
        // Intro/outro yalnız yatay kesitlerde ve kullanıcı yüklediyse eklenir;
        // süreleri çıktı süresine katılır (doğrulama + kart süresi).
        const introPath = opts.intro ? IntroStore.getIntroPath(this.userId) : null;
        const outroPath = opts.outro ? IntroStore.getOutroPath(this.userId) : null;
        const sureOku = (yol) => yol ? IntroStore.probe(yol).then(b => b.duration || 0).catch(() => 0) : 0;
        const introDuration = await sureOku(introPath);
        const outroDuration = await sureOku(outroPath);
        if (introPath || outroPath || logoPath || camFull) {
            await this._setStep(jobId, 'processing', 'video oluşturuluyor');
        }
        await this.horizontalComposer.compose({
            inputPath, outputPath, logoPath, introPath, outroPath, assPath, camFull,
            logoScale: opts.logoScale, logoOpacity: opts.logoOpacity,
            logoX: opts.logoX ?? 0.92, logoY: opts.logoY ?? 0.08,
        });

        // Sansür — küfür geçen anlar biplenir (opsiyonel). Transkript zaman
        // damgaları kesite göre olduğundan intro eklendiyse o kadar kaydırılır.
        await this._applyCensorIfNeeded(jobId, opts, transcript, outputPath, jobWorkDir, duration + introDuration + outroDuration, introDuration);

        const check = await this.horizontalComposer.verifyOutput(outputPath, duration + introDuration + outroDuration);
        if (!check.ok) {
            try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
            throw new Error(`Kalite kontrolü başarısız: ${check.issues.join('; ')}`);
        }
        console.log(`[ClipEditor:${this.userId}] Kontrol OK (yatay) — ${check.info.width}x${check.info.height} ${check.info.duration}sn ${check.info.sizeKB}KB ses:${check.info.hasAudio ? 'var' : 'yok'}`);

        // Küçük görsel introdan değil kesitin kendisinden alınır
        const thumbPath = path.join(this.outputDir, `${jobId}_thumb.jpg`);
        await this.horizontalComposer.thumbnail(outputPath, thumbPath, { offsetSec: introDuration + 1 }).catch(() => null);

        let meta2 = null;
        if (AUTO_METADATA && MetadataGenerator.isAvailable()) {
            await this._setStep(jobId, 'processing', 'açıklama üretiliyor');
            meta2 = await this.metadata.generate({
                segments: transcript?.segments || [], sourceTitle: jobRow?.title || '', language,
            }).catch(err => {
                console.error(`[ClipEditor:${this.userId}] Metadata hatası (yatay):`, err.message);
                return null;
            });
        }

        await this.db.updateEditedClip(jobId, this.userId, {
            status: 'ready',
            step: 'tamamlandı',
            video_url: `/clips/${this.userId}/vertical/${jobId}.mp4`,
            thumbnail_url: fs.existsSync(thumbPath) ? `/clips/${this.userId}/vertical/${jobId}_thumb.jpg` : null,
            duration: Math.round(check.info.duration || (duration + introDuration)),
            layout: 'horizontal',
            transcript: transcript ? JSON.stringify(transcript.segments) : null,
            highlights: JSON.stringify([]),
            qc: JSON.stringify(check.info),
            gen_description: meta2?.description || null,
            gen_hashtags: meta2?.hashtags ? JSON.stringify(meta2.hashtags) : null,
            qc_verdict: 'ok',
            qc_issues: JSON.stringify([]),
            file_size_bytes: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : null,
        });
        this._emit(jobId, 'ready', 'tamamlandı');
        console.log(`[ClipEditor:${this.userId}] ✅ İş ${jobId} hazır (yatay kesit)`);
    }

    /**
     * Teknik hata mesajını yayıncının anlayacağı dile çevir.
     * Panelde "Command failed: ffprobe -v error -select_streams v:0..." gibi
     * ham çıktılar gösteriliyordu.
     */
    static friendlyError(msg = '') {
        const m = String(msg);
        if (/404|not found|Server returned/i.test(m)) {
            return 'Klip kaynağına ulaşılamadı (silinmiş veya henüz hazır değil). Biraz sonra tekrar deneyin.';
        }
        if (/ffprobe|Invalid data|moov atom/i.test(m)) {
            return 'Klip dosyası bozuk veya eksik indirildi. Tekrar deneyin.';
        }
        if (/ffmpeg/i.test(m)) {
            return 'Video işlenirken hata oluştu. Tekrar deneyin; sorun sürerse klip desteklenmiyor olabilir.';
        }
        if (/cloudflare|r2\.cloudflarestorage/i.test(m)) {
            return 'Video depolama servisine ulaşılamadı (geçici bir sorun olabilir). Tekrar deneyin.';
        }
        if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(m)) {
            return 'Paylaşım servisine bağlanılamadı (zaman aşımı/ağ hatası). Tekrar deneyin.';
        }
        if (/Kalite kontrolü/i.test(m)) return m; // zaten Türkçe ve anlamlı
        if (/yerel dosyaydı/i.test(m)) return m;
        return m.slice(0, 200);
    }

    // Adım → tahmini ilerleme yüzdesi (frontend ilerleme çubuğu için)
    static STEP_PROGRESS = {
        'indiriliyor': 10,
        'hazırlanıyor': 10,
        'facecam tespiti': 30,
        'hareket analizi': 45,
        'yüz takibi': 50,
        'transkript çıkarılıyor': 60,
        'video oluşturuluyor': 75,
        'kontrol ediliyor': 85,
        'kalite denetimi': 90,
        'açıklama üretiliyor': 94,
        'viral skor': 97,
        'tamamlandı': 100,
    };

    async _setStep(jobId, status, step) {
        await this.db.updateEditedClip(jobId, this.userId, { status, step }).catch(() => {});
        this._emit(jobId, status, step);
    }

    _emit(jobId, status, step) {
        if (this.io) {
            this.io.to(`user:${this.userId}`).emit('clipedit:update', {
                jobId,
                status,
                step,
                progress: ClipEditorManager.STEP_PROGRESS[step] ?? (status === 'ready' ? 100 : 0),
            });
        }
    }

    destroy() {
        // Devam eden ffmpeg işi tamamlanır; kuyrukta bekleyen işler ise
        // _process başında bu bayrakla atlanır (eski closure çalışmaz)
        this._destroyed = true;
    }
}

module.exports = ClipEditorManager;
