/**
 * RecordingPublisher — yayın kaydı çıktısını YouTube'a iki adımda gönderir.
 *
 *  1. Taslak: çıktı dosyası Zernio'ya yüklenir ve TASLAK gönderi oluşturulur.
 *     Bu adımda YouTube'a hiçbir şey gitmez.
 *  2. Gönder: kullanıcı onaylayınca taslak yayınlanır (başlık/açıklama/
 *     görünürlük son kez düzeltilebilir).
 *
 * Yükleme GB'larca dosyada dakikalar sürdüğünden iki adım da arka planda
 * yürür; durum kayıt satırının publish_* kolonlarında tutulur ve
 * 'recorder:publish' socket olayıyla panele bildirilir.
 *
 * Durumlar: uploading → draft → publishing → published
 *           (yükleme hatası: failed · gönderim hatası: taslak korunur, draft'a döner)
 *
 * Zernio istemcisi (ZernioPublisher) çağrı başına dışarıdan verilir: profil
 * eşlemesi kullanıcı ayarından çözülür ve bu sınıfın bilmesi gerekmez.
 */
const fs = require('fs');
const { normalizePublishStatus, summarizePlatformResults } = require('./PublishingPolicy');

const GORUNURLUKLER = ['public', 'unlisted', 'private'];
const YUKLEME_TAVANI_MS = 60 * 60 * 1000;
const ACIKLAMA_SINIRI = 5000; // YouTube açıklama sınırı
const MESGUL_DURUMLAR = new Set(['uploading', 'publishing']);

/** Panelden gelen taslak alanlarını doğrular (saf fonksiyon). */
function normalizeDraftInput({ title, content, visibility } = {}, { varsayilanBaslik = '' } = {}) {
    const baslik = String(title || '').trim().slice(0, 100) || String(varsayilanBaslik || '').trim().slice(0, 100);
    if (!baslik) throw new Error('Video başlığı gerekli');
    return {
        title: baslik,
        content: String(content || '').trim().slice(0, ACIKLAMA_SINIRI),
        visibility: GORUNURLUKLER.includes(visibility) ? visibility : 'public',
    };
}

class RecordingPublisher {
    constructor({ db, io, userId }) {
        this.db = db;
        this.io = io;
        this.userId = userId;
        this._mesgul = new Set(); // aynı kayıtta eşzamanlı iki işlem olmasın
    }

    /**
     * Çıktıyı Zernio'ya yükleyip taslak gönderi oluşturur (arka planda).
     * @returns {Promise<object>} 'uploading' işaretlenmiş kayıt satırı
     */
    async taslakYukle(kayitId, publisher, girdi = {}) {
        const kayit = await this._kayit(kayitId);
        if (this._mesgul.has(kayitId) || MESGUL_DURUMLAR.has(kayit.publish_status)) {
            throw new Error('Bu kayıt için süren bir yükleme/gönderim var');
        }
        if (kayit.publish_status === 'draft') throw new Error('Bu kaydın zaten bir taslağı var — gönderebilir ya da silebilirsiniz');
        if (kayit.publish_status === 'published') throw new Error('Bu kayıt zaten YouTube\'a gönderildi');
        if (kayit.final_status !== 'ready' || !kayit.final_path || !fs.existsSync(kayit.final_path)) {
            throw new Error('Önce yayına hazır çıktı üretilmeli');
        }

        const alanlar = normalizeDraftInput(girdi, { varsayilanBaslik: kayit.title || kayit.channel_slug });
        const hesap = await this._youtubeHesabi(publisher, girdi.accountId);

        this._mesgul.add(kayitId);
        let guncel;
        try {
            guncel = await this.db.updateStreamRecording(kayitId, this.userId, {
                publish_status: 'uploading',
                publish_post_id: null,
                publish_account_id: hesap.id,
                publish_title: alanlar.title,
                publish_content: alanlar.content,
                publish_visibility: alanlar.visibility,
                publish_url: null,
                publish_error: null,
                published_at: null,
            });
        } catch (err) {
            this._mesgul.delete(kayitId);
            throw err;
        }

        publisher.createDraft({
            videoPath: kayit.final_path,
            ...alanlar,
            accounts: [{ platform: 'youtube', accountId: hesap.id }],
            uploadTimeoutMs: YUKLEME_TAVANI_MS,
        })
            .then(sonuc => this._guncelle(kayitId, { publish_status: 'draft', publish_post_id: sonuc.postId }))
            .catch(err => this._guncelle(kayitId, {
                publish_status: 'failed',
                publish_error: `Taslak yüklenemedi: ${hataMetni(err)}`.slice(0, 300),
            }))
            .finally(() => this._mesgul.delete(kayitId));

        return guncel;
    }

    /**
     * Taslağı YouTube'a gönderir (arka planda). Alan verilirse taslak önce güncellenir.
     * @returns {Promise<object>} 'publishing' işaretlenmiş kayıt satırı
     */
    async gonder(kayitId, publisher, girdi = {}) {
        const kayit = await this._kayit(kayitId);
        if (this._mesgul.has(kayitId)) throw new Error('Bu kayıt için süren bir yükleme/gönderim var');
        if (kayit.publish_status !== 'draft' || !kayit.publish_post_id) {
            throw new Error('Gönderilecek bir taslak yok — önce taslak olarak yükleyin');
        }
        const alanlar = normalizeDraftInput({
            title: girdi.title ?? kayit.publish_title,
            content: girdi.content ?? kayit.publish_content,
            visibility: girdi.visibility ?? kayit.publish_visibility,
        });

        this._mesgul.add(kayitId);
        let guncel;
        try {
            guncel = await this.db.updateStreamRecording(kayitId, this.userId, {
                publish_status: 'publishing',
                publish_title: alanlar.title,
                publish_content: alanlar.content,
                publish_visibility: alanlar.visibility,
                publish_error: null,
            });
        } catch (err) {
            this._mesgul.delete(kayitId);
            throw err;
        }

        publisher.publishDraft(kayit.publish_post_id, {
            ...alanlar,
            accounts: [{ platform: 'youtube', accountId: kayit.publish_account_id }],
        })
            .then(sonuc => this._sonucuIsle(kayitId, sonuc))
            .catch(err => (err.publishOutcomeUnknown
                // Sonuç belirsiz: gönderim sürüyor olabilir → durum sorgusu çözer, yeniden gönderilmez.
                ? this._guncelle(kayitId, { publish_error: null })
                // Kesin ret: taslak duruyor, kullanıcı düzeltip yeniden gönderebilir.
                : this._guncelle(kayitId, {
                    publish_status: 'draft',
                    publish_error: `Gönderilemedi: ${hataMetni(err)}`.slice(0, 300),
                })))
            .finally(() => this._mesgul.delete(kayitId));

        return guncel;
    }

    /** Süren gönderimin sonucunu Zernio'dan sorgular (socket kaçarsa / sonuç belirsizse). */
    async durumYenile(kayitId, publisher) {
        const kayit = await this._kayit(kayitId);
        if (kayit.publish_status !== 'publishing' || !kayit.publish_post_id || this._mesgul.has(kayitId)) return kayit;
        const sonuc = await publisher.getStatus(kayit.publish_post_id);
        return this._sonucuIsle(kayitId, sonuc);
    }

    /** Taslağı Zernio'dan siler ve kaydı "paylaşılmamış" durumuna döndürür. */
    async taslakSil(kayitId, publisher) {
        const kayit = await this._kayit(kayitId);
        if (this._mesgul.has(kayitId) || MESGUL_DURUMLAR.has(kayit.publish_status)) {
            throw new Error('Süren yükleme/gönderim bitmeden taslak silinemez');
        }
        if (kayit.publish_status === 'published') throw new Error('Yayınlanmış video buradan silinemez');
        if (kayit.publish_post_id) await publisher.deletePost(kayit.publish_post_id);
        return this._guncelle(kayitId, {
            publish_status: null, publish_post_id: null, publish_error: null, publish_url: null,
        });
    }

    /** Sunucu yükleme sürerken kapandıysa 'uploading' asılı kalan satırları işaretler. */
    async recoverOrphans() {
        const asili = await this.db.getStreamRecordings(this.userId, 50)
            .then(list => list.filter(r => r.publish_status === 'uploading'))
            .catch(() => []);
        for (const kayit of asili) {
            await this.db.updateStreamRecording(kayit.id, this.userId, {
                publish_status: 'failed', publish_error: 'Sunucu yeniden başladı, taslak yüklemesi yarım kaldı',
            }).catch(() => {});
        }
    }

    /* ------------------------------------------------------------- iç akış */

    async _kayit(kayitId) {
        const kayit = await this.db.getStreamRecordingById(kayitId, this.userId);
        if (!kayit) throw new Error('Kayıt bulunamadı');
        return kayit;
    }

    /** Seçilen (ya da tek olan) bağlı YouTube hesabı — istemcinin gönderdiği kimliğe güvenilmez. */
    async _youtubeHesabi(publisher, accountId) {
        const hesaplar = (await publisher.listAccounts()).filter(h => h.platform === 'youtube');
        if (hesaplar.length === 0) throw new Error('Bağlı bir YouTube hesabı yok — Zernio panelinden bağlayın');
        const hesap = accountId ? hesaplar.find(h => h.id === accountId) : hesaplar[0];
        if (!hesap) throw new Error('Seçilen YouTube hesabı bağlı değil');
        return hesap;
    }

    _sonucuIsle(kayitId, sonuc) {
        if (String(sonuc.status || '').toLowerCase() === 'draft') {
            return this._guncelle(kayitId, { publish_status: 'draft', publish_error: 'Zernio gönderimi başlatmadı — yeniden deneyin' });
        }
        const durum = summarizePlatformResults(sonuc.platforms, { fallback: normalizePublishStatus(sonuc.status) });
        const youtube = (sonuc.platforms || []).find(p => p.platform === 'youtube');
        if (durum === 'published') {
            return this._guncelle(kayitId, {
                publish_status: 'published', publish_url: youtube?.url || null, publish_error: null, published_at: new Date(),
            });
        }
        if (durum === 'failed') {
            // Sağlayıcı reddetti; gönderi Zernio'da duruyor → taslak gibi yeniden denenebilir.
            return this._guncelle(kayitId, {
                publish_status: 'draft',
                publish_error: `YouTube reddetti: ${youtube?.error || 'bilinmeyen hata'}`.slice(0, 300),
            });
        }
        return this._guncelle(kayitId, { publish_status: 'publishing' });
    }

    async _guncelle(kayitId, veri) {
        const guncel = await this.db.updateStreamRecording(kayitId, this.userId, veri).catch(() => null);
        try {
            this.io?.to(`user:${this.userId}`).emit('recorder:publish', { recordingId: kayitId, recording: guncel });
        } catch { /* socket yoksa sorun değil */ }
        return guncel;
    }
}

function hataMetni(err) {
    return String(err?.response?.data?.error || err?.response?.data?.message || err?.message || 'bilinmeyen hata');
}

module.exports = RecordingPublisher;
module.exports.normalizeDraftInput = normalizeDraftInput;
