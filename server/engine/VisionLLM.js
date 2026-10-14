/**
 * VisionLLM — klip editörünün LLM köprüsü (görüntü analizi + metin üretimi)
 *
 * Birincil: OpenAI Responses API (OPENAI_API_KEY, varsayılan gpt-5.6-luna —
 * en güncel ailenin verimli kademesi; 5.4 ileride kaldırılabilir).
 * Gerçek kliple test edildi: kutu tespitinde Gemini kadar isabetli
 * (gerçek [476,0,735,256] → luna [478,0,740,259], 5.4-mini [476,0,738,262]).
 * NOT: OpenAI'da ucuz kademe için otomatik-güncel alias YOK (gpt-5.6 alias'ı
 * pahalı sol'a gider) — yeni aile çıkınca .env'den OPENAI_VISION_MODEL /
 * OPENAI_TEXT_MODEL güncellenir, kod değişikliği gerekmez.
 * Yedek: Google Gemini (GEMINI_API_KEY) — OpenAI anahtarı yoksa veya çağrı
 * kalıcı hata verirse otomatik düşülür; iki anahtar da yoksa modül kapalıdır.
 *
 * Modeller env ile değiştirilebilir:
 *   OPENAI_VISION_MODEL (görüntü işleri) / OPENAI_TEXT_MODEL (metin üretimi)
 */
const axios = require('axios');

class VisionLLM {
    static isAvailable() {
        return !!(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
    }

    /**
     * Prompt + görüntülerden JSON yanıt üret.
     * @param {object} p
     *   - prompt: string
     *   - images: Array<{data: string(base64 jpeg), label?: string}>
     *   - purpose: 'vision' | 'text' (OpenAI model seçimi)
     *   - maxOutput: beklenen yanıt token bütçesi
     *   - temperature: yalnız Gemini yedeğinde kullanılır (gpt-5.x desteklemez)
     *   - geminiModel: Gemini yedeğinde kullanılacak model (ops.)
     * @returns {object} parse edilmiş JSON — başarısızlıkta throw
     */
    static async generateJson({ prompt, images = [], purpose = 'vision', maxOutput = 800, temperature = 0, timeout = 45000, geminiModel, schema } = {}) {
        if (process.env.OPENAI_API_KEY) {
            try {
                return await VisionLLM._openai({ prompt, images, purpose, maxOutput, timeout, schema });
            } catch (err) {
                const st = err.response?.status || err.message;
                if (!process.env.GEMINI_API_KEY) throw err;
                console.error(`[VisionLLM] OpenAI hatası (${st}) — Gemini yedeğine düşülüyor`);
            }
        }
        if (!process.env.GEMINI_API_KEY) {
            throw new Error('LLM anahtarı yok (OPENAI_API_KEY veya GEMINI_API_KEY gerekli)');
        }
        return VisionLLM._gemini({ prompt, images, maxOutput, temperature, timeout, geminiModel });
    }

    static async _openai({ prompt, images, purpose, maxOutput, timeout, schema }) {
        const model = purpose === 'text'
            ? (process.env.OPENAI_TEXT_MODEL || 'gpt-5.6-luna')
            : (process.env.OPENAI_VISION_MODEL || 'gpt-5.6-luna');

        const content = [{ type: 'input_text', text: prompt }];
        for (const img of images) {
            if (img.label) content.push({ type: 'input_text', text: img.label });
            content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${img.data}`, detail: 'high' });
        }

        const body = {
            model,
            // Kutu/karar işleri için düşük akıl yürütme yeterli ve hızlı
            reasoning: { effort: 'low' },
            // gpt-5.x akıl yürütme tokenleri de bu bütçeden düşer — pay bırak
            max_output_tokens: Math.max(1000, maxOutput + 600),
            input: [{ role: 'user', content }],
            // JSON zorlaması: modelin serbest metin/bozuk JSON dönmesi engellenir.
            // Eskiden zorlama yoktu; "Expected ',' or ']'" parse hataları alınıp
            // sessizce Gemini'ye düşülüyordu (tespit tutarsızlığının ana kaynağı).
            text: schema
                ? { format: { type: 'json_schema', name: schema.name, strict: true, schema: schema.schema } }
                : { format: { type: 'json_object' } },
        };

        // Geçici hatalarda (429/5xx/ağ) bir kez tekrar dene
        let res;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                res = await axios.post('https://api.openai.com/v1/responses', body, {
                    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
                    timeout,
                });
                break;
            } catch (e) {
                const st = e.response?.status;
                if (attempt === 0 && (st === 429 || st >= 500 || !st)) {
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                throw e;
            }
        }

        const msg = (res.data?.output || []).find(o => o.type === 'message');
        const text = msg?.content?.map(c => c.text || '').join('') || '';
        return VisionLLM._parse(text);
    }

    static async _gemini({ prompt, images, maxOutput, temperature, timeout, geminiModel }) {
        const model = geminiModel || process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
        const parts = [{ text: prompt }];
        for (const img of images) {
            if (img.label) parts.push({ text: img.label });
            parts.push({ inline_data: { mime_type: 'image/jpeg', data: img.data } });
        }

        let res;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                res = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
                    {
                        contents: [{ parts }],
                        generationConfig: { temperature, maxOutputTokens: maxOutput, responseMimeType: 'application/json' },
                    },
                    { headers: { 'Content-Type': 'application/json' }, timeout }
                );
                break;
            } catch (e) {
                const st = e.response?.status;
                if (attempt === 0 && (st === 503 || st === 429 || !st)) {
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                throw e;
            }
        }

        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return VisionLLM._parse(text);
    }

    static _parse(text) {
        const cleaned = String(text).replace(/```json\s*|\s*```/g, '').trim();
        return JSON.parse(cleaned);
    }
}

module.exports = VisionLLM;
