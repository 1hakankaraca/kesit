/**
 * ViralScorer — Klibin sosyal medyada tutma potansiyelini 0-100 puanlar
 *
 * Rakiplerde (Opus, Vizard, StreamLadder) standart özellik: kullanıcı hangi
 * klibi paylaşacağına puana bakarak karar veriyor. Bizim QC katmanımız
 * "çıktı bozuk mu" sorusunu yanıtlıyor; bu modül "bu klip tutar mı" sorusunu.
 *
 * Sinyaller:
 *  1. Transkript (ne söyleniyor — LLM yargısı)
 *  2. Ses enerjisi dinamiği (patlama/kahkaha/bağırma → segment score'ları)
 *  3. Kaynak klip izlenme sayısı (varsa — sosyal kanıt)
 *  4. Süre uygunluğu (kısa video için ideal bant)
 *
 * LLM yoksa yalnızca sinyal-tabanlı sezgisel puan döner (heuristic).
 */
const VisionLLM = require('./VisionLLM');

// Kısa video için ideal süre bandı (saniye)
const IDEAL_MIN = 15;
const IDEAL_MAX = 60;

class ViralScorer {
    static isAvailable() {
        return true; // LLM yoksa da sezgisel puan üretir
    }

    /**
     * @param {object} p
     *   - segments: transkript segmentleri [{start,end,text,score}]
     *   - duration: klip süresi (sn)
     *   - viewCount: kaynak klip izlenmesi (varsa)
     * @returns {{score: number, reason: string, factors: object}}
     */
    async score({ segments = [], duration = 0, viewCount = 0, language = 'tr' } = {}) {
        const factors = this._signals({ segments, duration, viewCount });

        // LLM yoksa sezgisel puanla yetin
        if (!VisionLLM.isAvailable() || segments.length === 0) {
            return {
                score: factors.heuristic,
                reason: segments.length === 0
                    ? 'Konuşma bulunamadı — puan yalnızca süre/izlenme sinyallerinden hesaplandı.'
                    : 'Sezgisel puan (LLM kapalı).',
                factors,
            };
        }

        const transcript = segments
            .map(s => `[${this._ts(s.start)}] ${String(s.text || '').trim()}`)
            .filter(l => l.length > 8)
            .join('\n')
            .slice(0, 3000);

        const prompt = `Sen kısa video (TikTok/Reels/Shorts) uzmanısın. Aşağıda bir Kick canlı yayın klibinin transkripti var.

Klip süresi: ${Math.round(duration)} saniye
${viewCount > 0 ? `Kaynak klip izlenmesi: ${viewCount}\n` : ''}
Transkript:
"""
${transcript || '(konuşma yok)'}
"""

Görev: Bu klibin kısa video olarak TUTMA potansiyelini 0-100 arası puanla.

Değerlendirme kriterleri:
- Hook: ilk 3 saniye dikkat çekiyor mu?
- Duygu: kahkaha, şaşkınlık, öfke, gerilim, samimiyet var mı?
- Anlaşılabilirlik: bağlam olmadan (yayını izlemeyen biri için) anlaşılıyor mu?
- Doruk noktası: net bir "an" var mı, yoksa dağınık sohbet mi?
- Paylaşılabilirlik: insanlar arkadaşına gönderir mi?

Puanlama rehberi: 0-30 sıkıcı/bağlamsız, 31-55 vasat, 56-75 iyi, 76-90 çok güçlü, 91-100 viral potansiyeli yüksek.
Cömert davranma; ortalama klip 40-60 bandındadır.

SADECE JSON: {"score": 0-100 sayı, "reason": "tek cümle ${language === 'en' ? 'İngilizce' : 'Türkçe'} gerekçe", "hook": "klibin en güçlü anı, kısa"}`;

        try {
            const d = await VisionLLM.generateJson({
                prompt,
                purpose: 'text',
                maxOutput: 300,
                temperature: 0.3,
                timeout: 45000,
            });
            const llmScore = Math.max(0, Math.min(100, Math.round(Number(d.score) || 0)));

            // LLM içerik yargısı ağırlıklı (%70), sinyaller (%30) düzeltici
            const final = Math.round(llmScore * 0.7 + factors.heuristic * 0.3);

            return {
                score: Math.max(0, Math.min(100, final)),
                reason: String(d.reason || '').slice(0, 300),
                hook: String(d.hook || '').slice(0, 200),
                factors: { ...factors, llm: llmScore },
            };
        } catch (err) {
            console.error('[ViralScorer] LLM hatası:', err.message);
            return {
                score: factors.heuristic,
                reason: 'Sezgisel puan (LLM yanıt vermedi).',
                factors,
            };
        }
    }

    /**
     * Sinyal-tabanlı sezgisel puan (LLM olmadan da anlamlı sonuç)
     */
    _signals({ segments, duration, viewCount }) {
        // 1. Enerji dinamiği: segment önem puanlarının tepe değeri ve yayılımı.
        // Transcriber score'ları RMS z-skoru + hype kelime + CAPS'ten geliyor;
        // yüksek tepe = klipte "an" var demektir.
        const scores = segments.map(s => Number(s.score) || 0);
        const peak = scores.length ? Math.max(...scores) : 0;
        const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        // peak 0-5 bandında geliyor; 3+ güçlü an sayılır
        const energy = Math.min(100, Math.round((peak / 4) * 70 + (avg / 2) * 30));

        // 2. Süre uygunluğu: 15-60sn ideal, dışına çıkınca ceza
        let durationFit;
        if (duration <= 0) durationFit = 50;
        else if (duration >= IDEAL_MIN && duration <= IDEAL_MAX) durationFit = 100;
        else if (duration < IDEAL_MIN) durationFit = Math.max(30, Math.round((duration / IDEAL_MIN) * 100));
        else durationFit = Math.max(25, Math.round(100 - (duration - IDEAL_MAX) * 0.7));

        // 3. Sosyal kanıt: kaynak klip izlenmesi (logaritmik — 1000+ güçlü)
        const social = viewCount > 0
            ? Math.min(100, Math.round(Math.log10(viewCount + 1) * 30))
            : 40; // bilinmiyorsa nötr

        // 4. Konuşma yoğunluğu: sessiz klip kısa videoda zayıf
        const talkRatio = duration > 0
            ? Math.min(1, segments.reduce((a, s) => a + (s.end - s.start), 0) / duration)
            : 0;
        const speech = Math.round(Math.min(100, talkRatio * 130)); // %75 konuşma ≈ tam puan

        const heuristic = Math.round(
            energy * 0.4 + durationFit * 0.25 + social * 0.2 + speech * 0.15
        );

        return {
            energy, durationFit, social, speech,
            heuristic: Math.max(0, Math.min(100, heuristic)),
        };
    }

    _ts(sec) {
        const s = Math.max(0, Math.round(sec || 0));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
}

module.exports = ViralScorer;
