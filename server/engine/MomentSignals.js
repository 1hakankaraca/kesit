/**
 * MomentSignals — bir yayının tamamından "an" adaylarını çıkaran saf sinyal
 * hesapları. Ağ ya da disk işi yok; MomentScanner veriyi toplar, burası
 * puanlar (bu yüzden birim testi kolay).
 *
 * Sinyaller:
 *  1. Sohbet (en güçlü): mesaj hızının kanalın o saatteki olağan hızına göre
 *     patlaması, patlamaya katılan tekil kişi sayısı, aynı tepkinin tekrarı
 *     (copypasta / emote seli) ve tepkinin türü (kahkaha, heyecan, hüzün).
 *  2. Ses: saniyelik ses seviyesinin çevresindeki olağan seviyeden belirgin
 *     yükselmesi (bağırma, patlama, kahkaha).
 *  3. Konuşma: transkript varsa mevcut HighlightDetector pencereleri.
 *
 * Sohbet olaydan sonra gelir (yayın gecikmesi + yazma süresi), bu yüzden
 * sohbet pencereleri patlamanın biraz öncesinden başlatılır.
 */

const BUCKET_SEC = 5;
const BASELINE_RADIUS_SEC = 300;     // olağan hız: ±5 dk'lık medyan
const CHAT_LEAD_SEC = 30;            // patlamadan bu kadar önce başla
const CHAT_TAIL_SEC = 10;            // tepe noktasından bu kadar sonra bitir
const AUDIO_LEAD_SEC = 20;
const AUDIO_TAIL_SEC = 15;
const MIN_WINDOW_SEC = 20;
const MAX_WINDOW_SEC = 90;
const PEAK_SPACING_SEC = 45;         // iki aday tepe arasında en az bu kadar

/* ── Sözlükler ──────────────────────────────────────────────────────────── */

const LAUGH_EMOTES = new Set(['kekw', 'kekl', 'kek', 'lul', 'lulw', 'omegalul', 'icant', 'pepelaugh', 'lmao', 'xd', 'kekwait', 'emilaugh', 'ahahaha', 'dead', 'skull', 'jokerge', 'pepepoint', 'lolw']);
const HYPE_EMOTES = new Set(['pog', 'pogchamp', 'poggers', 'pogu', 'poggies', 'waytoodank', 'monkas', 'monkaw', 'ez', 'clap', 'gigachad', 'catjam', 'pogo', 'omg', 'wow', 'pepega', 'hype', 'letsgo', 'w', 'goat']);
const SAD_EMOTES = new Set(['sadge', 'pepehands', 'biblethump', 'f', 'feelsbadman', 'sadcat', 'cry', 'crying', 'peepoSad'.toLowerCase(), 'heart', 'love', 'hug', 'peepohug']);

const LAUGH_RE = /(?:a?ha){2,}|(?:h?ah){3,}|(?:he){3,}|(?:jsj|sjs){1,}|(?:asd|sdf|dfg|fgh|ghj|jkl|klş|şlk|ğpo)+|xd+\b|\blo+l\b|\blmao\b|\brofl\b|g[uü]ld[uüe]m|[oö]ld[uü]m|kopt[uıu]m|kahkaha|komik|😂|🤣|💀|😆|😹/i;
const HYPE_RE = /^o+h+a+!*$|\boha+\b|\bvay+\b|\bvoo+v\b|^a{3,}!*$|^o{3,}!*$|^w+$|\bgo+l+\b|\bez+\b|kl[iıİI]+p+\b|\bclip\b|efsane|inan[ıi]lmaz|helal|[çc]ılg[ıi]n|🔥|😱|😮|🤯|‼|!{3,}/i;
const SAD_RE = /(?:^|\s)f(?:\s|$)|😢|😭|💔|🥺|<3|❤|ağla|agla|üz[uü]l|uzul|duygulan|geçmiş olsun|gecmis olsun|başın sağ|basin sag|\brip\b|yazık|yazik/i;

const EMOTE_RE = /\[emote:\d+:([^\]\s]+)\]/g;

/** Sohbet botları ve komutlar sinyale katılmaz (çekiliş/komut seli patlama sanılmasın). */
const BOT_USERS = new Set(['botrix', 'kickbot', 'nightbot', 'streamelements', 'fossabot', 'moobot', 'sery_bot', 'wizebot', 'streamlabs', 'kicklet']);
function isNoise(m) {
    const text = String(m.x || '').trim();
    return !text || text.startsWith('!') || BOT_USERS.has(String(m.u || '').toLowerCase());
}

/** Mesaj metnini emote adlarıyla birlikte düz metne indirger. */
function emoteNames(text) {
    const names = [];
    String(text || '').replace(EMOTE_RE, (_, name) => { names.push(name); return ''; });
    return names;
}

function plainText(text) {
    return String(text || '').replace(EMOTE_RE, ' $1 ').replace(/\s+/g, ' ').trim();
}

/** Copypasta karşılaştırması için normal biçim: küçük harf, tekrar eden harfler kısalır. */
function normalizeForRepeat(text) {
    return plainText(text).toLowerCase().replace(/(.)\1{2,}/g, '$1$1').replace(/[^\p{L}\p{N}\s]/gu, '').trim().slice(0, 40);
}

/** Bir mesajın tepki türleri. */
function reactionOf(text) {
    const emotes = emoteNames(text).map(e => e.toLowerCase());
    const plain = plainText(text);
    const tokens = plain.toLowerCase().split(/\s+/);
    return {
        laugh: emotes.some(e => LAUGH_EMOTES.has(e)) || tokens.some(t => LAUGH_EMOTES.has(t)) || LAUGH_RE.test(plain),
        hype: emotes.some(e => HYPE_EMOTES.has(e)) || HYPE_RE.test(plain),
        sad: emotes.some(e => SAD_EMOTES.has(e)) || SAD_RE.test(plain),
    };
}

/* ── Yardımcılar ────────────────────────────────────────────────────────── */

function median(values) {
    if (!values.length) return 0;
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Her indeks için çevresindeki (±radius) değerlerin medyanı. */
function rollingMedian(values, radius) {
    const out = new Array(values.length);
    // Seyrek örnekle: tam medyan pahalı değil ama 8 saatlik yayında n≈5800, pencere ≈120 → sorun yok.
    for (let i = 0; i < values.length; i++) {
        const from = Math.max(0, i - radius);
        const to = Math.min(values.length, i + radius + 1);
        out[i] = median(values.slice(from, to));
    }
    return out;
}

function clampWindow(start, end, durationSec) {
    let s = Math.max(0, start);
    let e = durationSec > 0 ? Math.min(durationSec, end) : end;
    if (e - s < MIN_WINDOW_SEC) {
        const extra = (MIN_WINDOW_SEC - (e - s)) / 2;
        s = Math.max(0, s - extra);
        e = durationSec > 0 ? Math.min(durationSec, e + extra) : e + extra;
    }
    if (e - s > MAX_WINDOW_SEC) e = s + MAX_WINDOW_SEC;
    return { start: Math.round(s), end: Math.round(e) };
}

/** Yerel tepe seçimi: puana göre sırala, birbirine çok yakın olanları ele. */
function pickPeaks(items, key, spacingSec) {
    const sorted = [...items].sort((a, b) => b[key] - a[key]);
    const kept = [];
    for (const it of sorted) {
        if (kept.some(k => Math.abs(k.t - it.t) < spacingSec)) continue;
        kept.push(it);
    }
    return kept;
}

/* ── 1. Sohbet ──────────────────────────────────────────────────────────── */

/**
 * Mesajları 5 sn'lik kovalara böler.
 * @param {Array<{t:number,u:string,x:string}>} messages t: yayın saniyesi
 */
function chatBuckets(messages, durationSec) {
    const lastT = messages.reduce((m, msg) => Math.max(m, msg.t || 0), 0);
    const total = Math.max(durationSec || 0, lastT);
    const n = Math.max(1, Math.ceil(total / BUCKET_SEC));
    const buckets = Array.from({ length: n }, (_, i) => ({ i, t: i * BUCKET_SEC, count: 0, users: new Set(), laugh: 0, hype: 0, sad: 0, repeats: new Map(), messages: [] }));
    for (const m of messages) {
        if (!(m.t >= 0) || isNoise(m)) continue;
        const b = buckets[Math.min(n - 1, Math.floor(m.t / BUCKET_SEC))];
        b.count++;
        b.users.add(m.u);
        const r = reactionOf(m.x);
        if (r.laugh) b.laugh++;
        if (r.hype) b.hype++;
        if (r.sad) b.sad++;
        const key = normalizeForRepeat(m.x);
        if (key) b.repeats.set(key, (b.repeats.get(key) || 0) + 1);
        if (b.messages.length < 60) b.messages.push(m);
    }
    return buckets;
}

/**
 * Sohbet patlamalarını aday pencereye çevirir.
 * @returns {Array<{start,end,t,chatScore,chat:{rate,baseline,multiple,users,laugh,hype,sad,repeat,top:string[],samples:string[]}}>}
 */
function chatCandidates(messages, durationSec, { limit = 60 } = {}) {
    if (!Array.isArray(messages) || messages.length < 20) return [];
    const buckets = chatBuckets(messages, durationSec);
    const radius = Math.round(BASELINE_RADIUS_SEC / BUCKET_SEC);
    const counts = buckets.map(b => b.count);
    const users = buckets.map(b => b.users.size);
    const baseCount = rollingMedian(counts, radius);
    const baseUsers = rollingMedian(users, radius);

    // Patlama 1-3 kova sürebilir: komşu kovayla toplayıp (10 sn) değerlendir.
    const scored = [];
    for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        const next = buckets[i + 1];
        const count = b.count + (next ? next.count : 0);
        const uniq = new Set([...b.users, ...(next ? next.users : [])]).size;
        const base = (baseCount[i] + (next ? baseCount[i + 1] : baseCount[i]));
        const baseU = (baseUsers[i] + (next ? baseUsers[i + 1] : baseUsers[i]));
        const multiple = (count + 1) / (base + 1);
        const userMultiple = (uniq + 1) / (baseU + 1);
        // Hem oran hem mutlak artış gerekir: ölü saatte 1 → 4 mesaj patlama sayılmaz.
        if (multiple < 1.8 || count - base < 6 || uniq < 4) continue;
        const laugh = b.laugh + (next ? next.laugh : 0);
        const hype = b.hype + (next ? next.hype : 0);
        const sad = b.sad + (next ? next.sad : 0);
        const reactionShare = Math.min(1, (laugh + hype + sad) / Math.max(1, count));
        let repeatTop = 0;
        for (const [, c] of b.repeats) repeatTop = Math.max(repeatTop, c);
        if (next) for (const [, c] of next.repeats) repeatTop = Math.max(repeatTop, c);
        const repeatShare = repeatTop / Math.max(1, count);
        const chatScore = Math.log2(multiple) * 1.0
            + Math.log2(userMultiple) * 0.6
            + reactionShare * 1.2
            + repeatShare * 0.6;
        scored.push({ i, t: b.t + BUCKET_SEC, chatScore, count, base, multiple, uniq, laugh, hype, sad, repeatShare });
    }

    const peaks = pickPeaks(scored, 'chatScore', PEAK_SPACING_SEC).slice(0, limit);
    return peaks.map(p => {
        // Patlamanın başladığı kovayı geriye doğru bul (hız olağana dönene kadar)
        let s = p.i;
        while (s > 0 && buckets[s - 1].count > baseCount[s - 1] * 1.5 + 2 && p.i - s < 6) s--;
        const { start, end } = clampWindow(buckets[s].t - CHAT_LEAD_SEC, p.t + BUCKET_SEC + CHAT_TAIL_SEC, durationSec);
        const near = buckets.slice(s, Math.min(buckets.length, p.i + 3));
        const emoteCount = new Map();
        const samples = [];
        for (const b of near) {
            for (const m of b.messages) {
                for (const e of emoteNames(m.x)) emoteCount.set(e, (emoteCount.get(e) || 0) + 1);
                const text = plainText(m.x);
                if (text && samples.length < 14 && !samples.includes(text)) samples.push(text.slice(0, 80));
            }
        }
        const top = [...emoteCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e, c]) => `${e}×${c}`);
        return {
            start, end, t: p.t,
            chatScore: Math.round(p.chatScore * 100) / 100,
            chat: {
                rate: p.count,
                baseline: Math.round(p.base * 10) / 10,
                multiple: Math.round(p.multiple * 10) / 10,
                users: p.uniq,
                laugh: p.laugh, hype: p.hype, sad: p.sad,
                repeat: Math.round(p.repeatShare * 100) / 100,
                top, samples,
            },
        };
    });
}

/* ── 2. Ses ─────────────────────────────────────────────────────────────── */

/**
 * Saniyelik ses seviyelerinden (dBFS, sessizlik ≈ -90) yükselme adayları.
 * @param {number[]} levels levels[s] = s. saniyenin RMS seviyesi
 */
function audioCandidates(levels, durationSec, { limit = 40 } = {}) {
    if (!Array.isArray(levels) || levels.length < 60) return [];
    const clean = levels.map(v => (Number.isFinite(v) ? Math.max(-90, v) : -90));
    const base = rollingMedian(clean, 120);
    const scored = [];
    for (let s = 1; s < clean.length - 1; s++) {
        // 3 sn'lik ortalama: tek bir tık/patlama sesi değil, süren yükselme
        const avg = (clean[s - 1] + clean[s] + clean[s + 1]) / 3;
        const delta = avg - base[s];
        if (delta < 7 || base[s] < -70) continue;
        scored.push({ t: s, delta, audioScore: Math.min(3, (delta - 5) / 4) });
    }
    return pickPeaks(scored, 'audioScore', PEAK_SPACING_SEC).slice(0, limit).map(p => ({
        ...clampWindow(p.t - AUDIO_LEAD_SEC, p.t + AUDIO_TAIL_SEC, durationSec),
        t: p.t,
        audioScore: Math.round(p.audioScore * 100) / 100,
        audio: { deltaDb: Math.round(p.delta * 10) / 10 },
    }));
}

/* ── 3. Birleştirme ─────────────────────────────────────────────────────── */

const WEIGHTS = { chat: 1.0, audio: 0.6, speech: 0.5 };

/**
 * Üç kaynağın adaylarını çakışmaya göre birleştirir; birden çok sinyalin
 * aynı anı göstermesi puanı yükseltir.
 * @param {{chat?:any[], audio?:any[], speech?:Array<{start,end,score,text}>}} sources
 */
function mergeCandidates({ chat = [], audio = [], speech = [] }, durationSec, { limit = 40 } = {}) {
    const all = [
        ...chat.map(c => ({ ...c, src: 'chat', w: WEIGHTS.chat * c.chatScore })),
        ...audio.map(a => ({ ...a, src: 'audio', w: WEIGHTS.audio * a.audioScore })),
        ...speech.map(s => ({ start: s.start, end: s.end, t: (s.start + s.end) / 2, speechScore: s.score, text: s.text, src: 'speech', w: WEIGHTS.speech * Math.min(3, s.score || 0) })),
    ].sort((a, b) => b.w - a.w);

    const merged = [];
    for (const c of all) {
        const hit = merged.find(m => c.start < m.end && c.end > m.start);
        if (!hit) {
            merged.push({ start: c.start, end: c.end, t: c.t, score: c.w, sources: [c.src], chat: c.chat || null, audio: c.audio || null, speechText: c.text || '' });
            continue;
        }
        if (!hit.sources.includes(c.src)) {
            hit.sources.push(c.src);
            hit.score += c.w + 0.5;   // farklı sinyaller aynı anda: güçlü kanıt
        }
        hit.start = Math.min(hit.start, c.start);
        hit.end = Math.max(hit.end, c.end);
        if (hit.end - hit.start > MAX_WINDOW_SEC) {
            // En güçlü sinyalin tepe noktası çevresinde kal
            const w = clampWindow(hit.t - MAX_WINDOW_SEC / 2, hit.t + MAX_WINDOW_SEC / 2, durationSec);
            hit.start = w.start; hit.end = w.end;
        }
        hit.chat = hit.chat || c.chat || null;
        hit.audio = hit.audio || c.audio || null;
        if (c.text && !hit.speechText) hit.speechText = c.text;
    }
    return merged
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(m => ({ ...m, score: Math.round(m.score * 100) / 100 }));
}

/* ── 4. LLM'siz etiket ──────────────────────────────────────────────────── */

const KINDS = ['komik', 'heyecanli', 'aksiyon', 'duygusal'];
const KIND_LABELS = { komik: 'Komik', heyecanli: 'Heyecanlı', aksiyon: 'Aksiyon', duygusal: 'Duygusal' };

/** Claude yokken sohbet ve ses sinyalinden kaba kategori + açıklama. */
function heuristicLabel(c) {
    const ch = c.chat;
    let kind = 'heyecanli';
    if (ch) {
        const { laugh, hype, sad } = ch;
        if (laugh >= Math.max(3, hype, sad)) kind = 'komik';
        else if (sad >= Math.max(3, hype)) kind = 'duygusal';
        else if (c.audio && c.audio.deltaDb >= 12) kind = 'aksiyon';
    } else if (c.audio && c.audio.deltaDb >= 12) {
        kind = 'aksiyon';
    }
    const parts = [];
    if (ch) parts.push(`sohbet ${ch.multiple}x hızlandı (${ch.users} kişi)`);
    if (ch && ch.top.length) parts.push(ch.top.slice(0, 3).join(', '));
    if (c.audio) parts.push(`ses +${c.audio.deltaDb} dB`);
    return { kind, title: '', reason: parts.join(' · ') || 'Sinyal yükselmesi' };
}

module.exports = {
    BUCKET_SEC,
    KINDS,
    KIND_LABELS,
    reactionOf,
    emoteNames,
    plainText,
    chatBuckets,
    chatCandidates,
    audioCandidates,
    mergeCandidates,
    heuristicLabel,
    rollingMedian,
};
