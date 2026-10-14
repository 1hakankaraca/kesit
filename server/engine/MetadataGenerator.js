/**
 * MetadataGenerator — Klip transkriptinden açıklama ve hashtag üretir
 *
 * VisionLLM köprüsü kullanır (OpenAI birincil, Gemini yedek).
 * LLM anahtarı tanımlı değilse sessizce atlanır (klip yine de üretilir).
 *
 * TikTok / YouTube Shorts / Instagram Reels için klibin KONUSUNU/olayını net
 * şekilde anlatan bir açıklama + hashtag döndürür — yorum/şaka/kişisel görüş
 * katılmaz, sadece "ne oluyor" anlatılır. BAŞLIK ÜRETMEZ (ayrı bir başlık
 * alanı yok — bu açıklama YouTube'da başlık, Instagram/TikTok'ta açıklama
 * olarak kullanılır). Kanal/yayıncı adı ASLA geçmez.
 */
const VisionLLM = require('./VisionLLM');

// Açıklama/hashtag'de asla geçmemesi gereken kanal/yayıncı adları
const BANNED_WORDS = ['livorass', 'livo rass', 'livo_rass'];

class MetadataGenerator {
    static _BANNED_TAGS = new Set(['livorass', 'livo', 'livorasss']);

    /** Metinden yasaklı kanal/yayıncı adlarını (ve @etiketlerini) söker */
    static _scrubBanned(text) {
        if (!text) return text;
        let out = text;
        for (const w of BANNED_WORDS) {
            // @isim, #isim ve düz isim geçişlerini kaldır (harf sınırına bakmadan)
            const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            out = out.replace(new RegExp(`[@#]?${esc}`, 'gi'), '');
        }
        // Temizlikten arta kalan çift boşluk/boşluklu noktalama düzelt
        return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
    }

    static isAvailable() {
        return VisionLLM.isAvailable();
    }

    /**
     * Transkript segmentlerinden metadata üret
     * @param {object} params
     *   - segments: Array<{start,end,text,score}> (transkript)
     *   - sourceTitle: string (varsa orijinal klip başlığı — yalnızca bağlam)
     * @returns {{description, hashtags: string[]}|null}
     *
     * NOT: channelSlug bilerek KULLANILMAZ — açıklamada kanal/yayıncı adı
     * geçmemeli. Başlık üretilmez.
     */
    async generate({ segments = [], sourceTitle = '', language = 'tr' } = {}) {
        if (!MetadataGenerator.isAvailable()) return null;

        // Zaman damgalı satırlar: model konuşma akışını (duraklar, cevaplar,
        // konuşmacı değişimi) görebilsin — düz birleştirme ikili konuşmalarda
        // kimin ne dediğini karıştırıyordu.
        const transcript = segments
            .map(s => `[${this._ts(s.start)}] ${String(s.text || '').trim()}`)
            .filter(l => l.length > 8)
            .join('\n')
            .trim();
        if (!transcript && !sourceTitle) return null;

        const prompt = language === 'en'
            ? this._buildPromptEn(transcript, sourceTitle)
            : this._buildPrompt(transcript, sourceTitle);

        try {
            const data = await VisionLLM.generateJson({
                prompt,
                purpose: 'text',
                temperature: 0.8,
                maxOutput: 1024, // analysis alanı için pay
                timeout: 45000,
            });
            return this._parseData(data);
        } catch (err) {
            const detail = err.response?.data?.error?.message || err.message;
            console.error(`[MetadataGenerator] LLM hatası: ${String(detail).slice(0, 160)}`);
            return null;
        }
    }

    /** Saniyeyi m:ss biçimine çevir (transkript satır zaman damgası) */
    _ts(sec) {
        const s = Math.max(0, Math.round(sec || 0));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    _buildPrompt(transcript, sourceTitle) {
        return `Sen bir kısa video (TikTok, YouTube Shorts, Instagram Reels) klip açıklaması yazan bir editörsün.
Aşağıda bir Kick canlı yayın klibinin OTOMATİK ses transkripti var (zaman damgalı satırlar).

${sourceTitle ? `Bağlam (orijinal klip başlığı): ${sourceTitle}\n` : ''}Transkript:
"""
${transcript.slice(0, 3000) || '(konuşma yok)'}
"""

Transkripti yorumlarken DİKKAT:
- Bu otomatik konuşma tanıma çıktısı: kelime hataları, eksik/yanlış yazımlar olabilir. Garip görünen kelimeleri bağlama göre düzelt.
- Konuşmacı etiketleri YOK ama klipte BİRDEN FAZLA kişi olabilir: yayıncı, yanındaki kişi, telefondaki kişi, oyun içi sesler, izleyici mesajı okuma. Satır aralarındaki cevaplaşmadan (soru→cevap, laf atma→gülme) kimin kime ne dediğini ÇIKARIM yap.
- Şaka, ironi, laf sokma, abartı olabilir — kelimenin düz anlamına takılma, olayın gerçek bağlamını anla. Söylenen bir şeyi yanlış kişiye mal etme.
- Emin olamadığın detayı UYDURMA; sadece transkriptten net anlaşılan olayı kullan.

Görev: ÖNCE olayı analiz et, SONRA klibin KONUSUNU anlatan bir açıklama yaz. Başlık ÜRETME.

Alanlar:
- analysis: 2-3 cümle: klipte gerçekte ne oluyor? Kaç kişi konuşuyor, kim ne diyor/yapıyor, öne çıkan an tam olarak ne? (Bu alan yayınlanmaz, sadece senin akıl yürütmen.)
- description: analysis'teki olaya dayanan, klipte NE OLDUĞUNU net ve doğrudan anlatan 1-2 cümlelik açıklama. Bu bir KONU/ÖZET anlatımıdır — yorum, şaka, kişisel görüş, tepki cümlesi ("koptum", "efsane", "bu ne ya" gibi) YAZMA; sadece olayı anlat (kim ne yaptı/dedi, ne oldu). Sade, gündelik Türkçe kullan, emoji ekleme. Uydurma yok.
- ÇOK ÖNEMLİ: description'da yayıncının/kanalın ADINI ASLA geçirme (isim, @kullanıcı, "livorass" vb. YASAK). Kişileri "yayıncı", "yanındaki kişi", "izleyici" gibi genel ifadelerle an.
- hashtags: 5-8 adet, # OLMADAN, küçük harf. Klibin konusuna uygun + "kick", "klip", "shorts", "reels" gibi genel etiketler. Kanal/yayıncı adını hashtag olarak da EKLEME.

Örnek açıklama tarzı: "Yayıncı canlı yayında beklenmedik bir ödül kazanıp anlık tepki veriyor.", "İzleyicisiyle telefon şakası yapan yayıncının anı."

Sadece şu JSON formatında yanıt ver:
{"analysis": "...", "description": "...", "hashtags": ["...", "..."]}`;
    }

    /** İngilizce içerik üreten yayıncılar için (global kullanım) */
    _buildPromptEn(transcript, sourceTitle) {
        return `You are an editor who writes topic/summary captions for short-form video clips (TikTok, YouTube Shorts, Instagram Reels).
Below is the automatic speech transcript of a Kick live stream clip (timestamped lines).

${sourceTitle ? `Context (original clip title): ${sourceTitle}\n` : ''}Transcript:
"""
${transcript.slice(0, 3000) || '(no speech)'}
"""

When interpreting the transcript, BE CAREFUL:
- This is ASR output: expect misheard words and typos. Correct odd-looking words from context.
- There are no speaker labels but the clip MAY have multiple people: the streamer, someone next to them, a caller, in-game voices, or the streamer reading chat. Infer who says what from the back-and-forth.
- There may be jokes, irony, trash talk, exaggeration — don't take words literally; understand the real situation. Don't attribute a line to the wrong person.
- NEVER invent details you're unsure about; use only what's clearly in the transcript.

Task: FIRST analyze what happens, THEN write a caption describing the clip's TOPIC. Do NOT generate a title.

Fields:
- analysis: 2-3 sentences: what is actually happening? How many people speak, who says/does what, what exactly is the standout moment? (Not published — your reasoning only.)
- description: a 1-2 sentence caption that states PLAINLY what happens in the clip, grounded in your analysis. This is a TOPIC/SUMMARY statement — do NOT write commentary, jokes, personal opinion, or reaction lines (no "I'm crying", "insane", etc.); just describe the event (who did/said what). Plain, everyday English, no emojis. No made-up details.
- VERY IMPORTANT: NEVER mention the streamer's or channel's NAME (no name, no @handle). Refer to people generically ("the streamer", "the person next to him", "a viewer").
- hashtags: 5-8 items, WITHOUT the # sign, lowercase. Relevant to the clip's topic plus generic ones like "kick", "clip", "shorts", "reels". Do NOT use the channel/streamer name as a hashtag.

Respond ONLY in this JSON format:
{"analysis": "...", "description": "...", "hashtags": ["...", "..."]}`;
    }

    _parseData(data) {
        try {
            let description = String(data.description || '').trim().slice(0, 600);
            let hashtags = Array.isArray(data.hashtags) ? data.hashtags : [];
            hashtags = hashtags
                .map(h => String(h).replace(/^#/, '').trim().toLowerCase())
                .filter(h => /^[a-z0-9çğıöşü_]+$/i.test(h))
                .filter(h => !MetadataGenerator._BANNED_TAGS.has(h))
                .slice(0, 8);
            // Model kurala uymayıp kanal adını sızdırırsa açıklamadan sök
            description = MetadataGenerator._scrubBanned(description);
            if (!description) return null;
            // Başlık üretmiyoruz — çağıranlar sadece description + hashtags kullanır
            return { description, hashtags };
        } catch {
            return null;
        }
    }
}

module.exports = MetadataGenerator;
