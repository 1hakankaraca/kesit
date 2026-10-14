/**
 * LiveClipWatcher — Canlı bir kanalın chat'ini takip edip klip linklerini yakalar
 *
 * Kullanıcının kendi kanalı yerine İSTENEN herhangi bir canlı kanalı takip eder:
 *  1. Kanalın kimliğini ve chatroom ID'sini alır (Kick v2 API)
 *  2. Kick'in gerçek zamanlı sunucusuna (Centrifugo, bkz. KickRealtime) abone olur
 *  3. Mesajlarda klip linki (kick.com/.../clips/clip_xxx, kickbot.com) tespit eder
 *  4. Yayın durumunu (canlı/kapalı + izleyici sayısı) periyodik izler
 *  5. Yakalanan klipleri canlı akışa ekler; otomatik editleme açıksa
 *     ClipEditorManager kuyruğuna gönderir
 *
 * Panel → gerçek zamanlı Socket.IO event'leri:
 *  - clipwatch:status   { watching, channel, chatConnected, isLive, viewerCount, autoEdit }
 *  - clipwatch:detected { clipId, url, sender, time, autoQueued, jobId }
 */
const axios = require('axios');
const { KickRealtime } = require('./KickRealtime');

const BROWSER_HEADERS = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};

const SLUG_PATTERN = /^[a-z0-9_-]{1,50}$/;
const LIVE_POLL_MS = 30000;       // yayın durumu kontrol aralığı
const FEED_MAX = 50;              // bellekte tutulan son yakalama sayısı
const DEDUP_MAX = 500;            // aynı klibi iki kez yakalamayı önleme

class LiveClipWatcher {
    constructor({ db, io, userId, clipEditor }) {
        this.db = db;
        this.io = io;
        this.userId = userId;
        this.clipEditor = clipEditor;

        this.channelSlug = null;
        this.broadcasterUserId = null; // hızlı klip için gerekli — kick.com/api/v2 user_id
        this.autoEdit = false;
        this.subtitles = true;
        this.realtime = null;
        this.chatConnected = false;
        this.isLive = false;
        this.viewerCount = 0;

        this._chatroomId = null;
        this._channelId = null;
        this._livePoll = null;
        this._seenClips = new Set();
        this._feed = []; // son yakalamalar (yeniden eskiye)
    }

    get isWatching() {
        return !!this.channelSlug;
    }

    /**
     * Bir kanalı takip etmeye başla
     * @param {string} channelSlug
     * @param {object} opts - { autoEdit, autoPublish, publishAccounts, subtitles }
     */
    async watch(channelSlug, { autoEdit = false, autoPublish = false, publishAccounts = [], subtitles = true } = {}) {
        const slug = String(channelSlug || '').trim().toLowerCase();
        if (!SLUG_PATTERN.test(slug)) {
            throw new Error('Geçersiz kanal adı');
        }

        // Otomatik paylaşım ayarını clipEditor'e bildir
        this.autoPublish = !!autoPublish;
        this.publishAccounts = Array.isArray(publishAccounts) ? publishAccounts : [];
        this.clipEditor?.setAutoPublish({ enabled: this.autoPublish, accounts: this.publishAccounts });

        // Zaten aynı kanalı takip ediyorsak sadece ayarları güncelle
        if (this.isWatching && this.channelSlug === slug) {
            this.autoEdit = !!autoEdit;
            this.subtitles = subtitles !== false;
            this._emitStatus();
            return this.getStatus();
        }

        // Aynı anda iki başlatma (ör. nöbet yoklaması + kullanıcı tıklaması) iki
        // chat bağlantısı kurmasın: ağ çağrısı sürerken ikinci istek reddedilir.
        if (this._starting) throw new Error('Takip zaten başlatılıyor');
        this._starting = true;
        try {
            return await this._startWatch(slug, { autoEdit, subtitles });
        } finally {
            this._starting = false;
        }
    }

    async _startWatch(slug, { autoEdit, subtitles }) {
        // Önceki takibi kapat
        if (this.isWatching) this.unwatch();

        // Chatroom ID + ilk yayın durumu
        const info = await this._fetchChannelInfo(slug);
        if (!info.chatroomId || !info.channelId) {
            throw new Error('Kanal bulunamadı veya chatroom ID alınamadı');
        }

        this.channelSlug = slug;
        this.broadcasterUserId = info.broadcasterUserId || null;
        this.autoEdit = !!autoEdit;
        this.subtitles = subtitles !== false;
        this._chatroomId = info.chatroomId;
        this._channelId = info.channelId;
        this.isLive = info.isLive;
        this.viewerCount = info.viewerCount;
        this._seenClips.clear();
        this._feed = [];

        this._connectChat();
        this._startLivePoll();

        console.log(`[LiveWatch:${this.userId}] Takip başladı: ${slug} (yayın: ${this.isLive ? 'açık' : 'kapalı'}, oto-edit: ${this.autoEdit})`);
        this._emitStatus();
        return this.getStatus();
    }

    /**
     * Takibi durdur
     */
    unwatch() {
        if (this._livePoll) { clearInterval(this._livePoll); this._livePoll = null; }
        if (this.realtime) {
            try { this.realtime.stop(); } catch { /* ignore */ }
            this.realtime = null;
        }
        const wasWatching = this.isWatching;
        this.channelSlug = null;
        this.broadcasterUserId = null;
        this.chatConnected = false;
        this.isLive = false;
        this.viewerCount = 0;
        this._chatroomId = null;
        this._channelId = null;
        this.autoPublish = false;
        this.clipEditor?.setAutoPublish({ enabled: false, accounts: [] });
        if (wasWatching) {
            console.log(`[LiveWatch:${this.userId}] Takip durduruldu`);
            this._emitStatus();
        }
    }

    /**
     * Otomatik editlemeyi aç/kapa (kanal değiştirmeden)
     */
    setAutoEdit(enabled) {
        this.autoEdit = !!enabled;
        this._emitStatus();
    }

    /**
     * Otomatik editlenen kliplerde altyazı üretimini aç/kapa (kanal değiştirmeden)
     */
    setSubtitles(enabled) {
        this.subtitles = !!enabled;
        this._emitStatus();
    }

    getStatus() {
        return {
            watching: this.isWatching,
            channel: this.channelSlug,
            canQuickClip: !!this.broadcasterUserId,
            chatConnected: this.chatConnected,
            isLive: this.isLive,
            viewerCount: this.viewerCount,
            autoEdit: this.autoEdit,
            subtitles: this.subtitles,
            autoPublish: !!this.autoPublish,
            detectedCount: this._feed.length,
            feed: this._feed.slice(0, 20),
        };
    }

    // ==========================================
    // CHAT BAĞLANTISI
    // ==========================================

    _connectChat() {
        this.realtime = new KickRealtime({
            channelId: this._channelId,
            channels: [`chatrooms.${this._chatroomId}.v2`],
            onEvent: (event, data) => {
                if (event === 'App\\Events\\ChatMessageEvent') this._onChatMessage(data);
            },
            onState: (connected) => {
                this.chatConnected = connected;
                this._emitStatus();
            },
            log: (msg, err) => console.warn(`[LiveWatch:${this.userId}] Chat bağlantısı: ${msg}`, err ? err.message : ''),
        });
        this.realtime.start();
    }

    _onChatMessage(data) {
        const text = data?.content || '';
        const sender = data?.sender?.username || 'bilinmiyor';
        if (!text) return;

        // KickBot klip URL'si (kickbot.com/clip/xxx) — ayrı CDN, Kick native değil
        const mkb = text.match(/kickbot\.com\/clip\/([a-z0-9]+)/i);
        if (mkb) {
            this._handleDetectedClip(mkb[1], `https://kickbot.com/clip/${mkb[1]}`, sender, 'kickbot');
            return;
        }

        // Kick native klip URL'si (?clip= veya /clips/ formatları)
        const m1 = text.match(/kick\.com\/[^?\s]+\?clip=(clip_[A-Za-z0-9]+)/i)
            || text.match(/kick\.com\/[^/\s]+\/clips\/(clip_[A-Za-z0-9]+)/i);
        if (m1) {
            const clipId = m1[1];
            this._handleDetectedClip(clipId, `https://kick.com/${this.channelSlug}/clips/${clipId}`, sender, 'kick');
        }
    }

    async _handleDetectedClip(clipId, url, sender, type = 'kick') {
        const dedupKey = `${type}:${clipId}`;
        if (this._seenClips.has(dedupKey)) return;
        this._seenClips.add(dedupKey);
        if (this._seenClips.size > DEDUP_MAX) {
            this._seenClips.delete(this._seenClips.values().next().value);
        }

        const entry = {
            clipId,
            type,
            url,
            sender,
            channel: this.channelSlug,
            time: new Date().toLocaleTimeString('tr-TR', { hour12: false }),
            ts: Date.now(),
            autoQueued: false,
            jobId: null,
        };

        console.log(`[LiveWatch:${this.userId}] 🎬 Klip yakalandı: ${type}/${clipId} (${sender}) @ ${this.channelSlug}`);

        // Otomatik editleme açıksa kuyruğa ekle
        if (this.autoEdit && this.clipEditor) {
            try {
                const opts = {
                    title: `Canlı — ${sender} @ ${this.channelSlug}`,
                    channelSlug: this.channelSlug,
                    source: 'live',
                    subtitles: this.subtitles,
                };
                const job = type === 'kickbot'
                    ? await this.clipEditor.enqueueKickbotClip(clipId, opts)
                    : await this.clipEditor.enqueueKickClip(clipId, opts);
                entry.autoQueued = true;
                entry.jobId = job.id;
            } catch (err) {
                console.error(`[LiveWatch:${this.userId}] Otomatik kuyruk hatası: ${err.message}`);
                entry.error = err.message;
            }
        }

        this._feed.unshift(entry);
        if (this._feed.length > FEED_MAX) this._feed.pop();

        if (this.io) {
            this.io.to(`user:${this.userId}`).emit('clipwatch:detected', entry);
        }
    }

    // ==========================================
    // YAYIN DURUMU
    // ==========================================

    _startLivePoll() {
        this._livePoll = setInterval(async () => {
            try {
                const info = await this._fetchChannelInfo(this.channelSlug, { chatroom: false });
                const changed = info.isLive !== this.isLive || info.viewerCount !== this.viewerCount;
                this.isLive = info.isLive;
                this.viewerCount = info.viewerCount;
                if (changed) this._emitStatus();
            } catch { /* geçici hata — bir sonraki turda tekrar dene */ }
        }, LIVE_POLL_MS);
        this._livePoll.unref?.();
    }

    /**
     * Kanal bilgisi: chatroom ID + yayın durumu + izleyici sayısı
     */
    async _fetchChannelInfo(slug, { chatroom = true } = {}) {
        const res = await axios.get(`https://kick.com/api/v2/channels/${slug}`, {
            headers: BROWSER_HEADERS,
            timeout: 10000,
        });
        const d = res.data || {};
        return {
            chatroomId: chatroom ? (d.chatroom?.id || d.chatroom_id || null) : this._chatroomId,
            channelId: d.id || this._channelId || null,
            broadcasterUserId: d.user_id || null,
            isLive: !!d.livestream,
            viewerCount: d.livestream?.viewer_count || d.livestream?.viewers || 0,
        };
    }

    /**
     * Takip edilen kanalın chat'ine "!clip <süre>" mesajı gönder. LivoBot'un
     * kendi `!clip` komutu yalnız bot sahibinin kendi kanalında çalışır —
     * bu, takip edilen kanalda VARSA üçüncü parti bir klip botunu tetiklemek
     * içindir. Yanıtı (klip linki) yakalamak için yeni kod GEREKMEZ — bu chat
     * zaten gerçek zamanlı sunucudan dinleniyor, gelen klip linki mevcut
     * `_handleDetectedClip` mekanizmasıyla otomatik yakalanır.
     */
    async sendQuickClip(durationSec, botService, opts = {}) {
        if (!this.isWatching) throw new Error('Şu an takip edilen bir kanal yok');
        if (!this.broadcasterUserId) throw new Error('Kanalın chat kimliği çözülemedi — takibi yeniden başlatın');
        const sec = Math.max(1, Math.min(300, parseInt(durationSec, 10) || 30));
        const ok = await botService.sendMessage(this.broadcasterUserId, `!clip ${sec}`, opts);
        if (!ok) throw new Error('Mesaj gönderilemedi — Kick hesap bağlantınızı kontrol edin');
        return { channel: this.channelSlug, durationSec: sec };
    }

    _emitStatus() {
        if (this.io) {
            this.io.to(`user:${this.userId}`).emit('clipwatch:status', this.getStatus());
        }
    }

    destroy() {
        this.unwatch();
    }
}

module.exports = LiveClipWatcher;
