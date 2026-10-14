/**
 * HighlightDetector — saatlerce süren bir VOD'un tamamından "en önemli
 * anlar" (heyecan/komedi/duygusal doruk) aday pencerelerini çıkarır.
 *
 * 1. VOD'u parça parça (varsayılan 10 dk) transkribe eder — Transcriber
 *    hiç değiştirilmeden, her parça için ayrı çağrılır; zaman damgaları
 *    parçanın VOD içindeki başlangıcına göre offset'lenir.
 * 2. Transcriber._scoreSegments (RMS + heyecan kelimesi + ünlem/CAPS)
 *    çıktısını kullanarak yerel tepe noktalarını 20-90sn'lik pencerelerde
 *    kümeler (bu skorlar parçalar arası doğrudan kıyaslanabilir değil —
 *    bu yüzden kaba bir ön-filtre olarak kullanılır, nihai seçim LLM'e
 *    bırakılır).
 * 3. En yüksek puanlı adaylar VisionLLM'e (metin) gönderilip gerçekten
 *    güçlü olanlar seçilir, kategori + kısa gerekçe etiketlenir.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Transcriber = require('./Transcriber');
const VisionLLM = require('./VisionLLM');

const DEFAULT_CHUNK_SEC = 600;      // transkript parça uzunluğu (10 dk)
const WINDOW_MIN_SEC = 20;
const WINDOW_MAX_SEC = 90;
const WINDOW_MERGE_GAP_SEC = 15;    // bu aralıktaki tepe noktaları tek pencerede birleşir
const WINDOW_PAD_SEC = 3;           // pencere sınırına eklenen tampon
const MAX_LLM_CANDIDATES = 40;      // LLM promptuna gönderilecek üst sınır

class HighlightDetector {
    constructor() {
        this.transcriber = new Transcriber();
    }

    static isAvailable() {
        return Transcriber.isAvailable();
    }

    /**
     * VOD'u parçalara bölerek transkribe eder, zaman damgalarını
     * VOD-geneline offset'ler. Transcriber'ın kendisi değiştirilmez.
     * @returns {{segments: Array<{start,end,text,score}>, language: string}}
     */
    async transcribeInChunks(videoPath, workDir, { language = null, durationSec = 0, chunkSec = DEFAULT_CHUNK_SEC, onProgress } = {}) {
        if (!Transcriber.isAvailable() || durationSec <= 0) {
            return { segments: [], language: language || 'tr' };
        }

        const chunkCount = Math.max(1, Math.ceil(durationSec / chunkSec));
        const segments = [];
        let resolvedLanguage = language;

        for (let i = 0; i < chunkCount; i++) {
            const start = i * chunkSec;
            const dur = Math.min(chunkSec, durationSec - start);
            if (dur <= 1) continue;

            const chunkDir = path.join(workDir, `chunk-${i}`);
            const chunkPath = path.join(chunkDir, 'chunk.mp4');
            try {
                fs.mkdirSync(chunkDir, { recursive: true });
                await this._cutChunk(videoPath, chunkPath, start, dur);

                const result = await this.transcriber.transcribe(chunkPath, chunkDir, {
                    language,
                    durationSec: dur,
                }).catch(err => {
                    console.error(`[HighlightDetector] Parça ${i + 1}/${chunkCount} transkript hatası:`, err.message);
                    return null;
                });

                if (result) {
                    resolvedLanguage = resolvedLanguage || result.language;
                    for (const seg of result.segments) {
                        segments.push({ ...seg, start: seg.start + start, end: seg.end + start });
                    }
                }
            } finally {
                fs.rmSync(chunkDir, { recursive: true, force: true });
            }
            if (onProgress) onProgress(i + 1, chunkCount);
        }

        return { segments, language: resolvedLanguage || 'tr' };
    }

    /** Yaklaşık (keyframe hizalı) hızlı kesim — dakika bazlı öndeğerlendirme için yeterli hassasiyet */
    _cutChunk(videoPath, outPath, startSec, durSec) {
        return new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', [
                '-y', '-loglevel', 'error',
                '-ss', String(startSec), '-i', videoPath, '-t', String(durSec),
                '-c', 'copy', '-avoid_negative_ts', 'make_zero',
                outPath,
            ]);
            let stderr = '';
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', reject);
            proc.on('exit', code => {
                if (code === 0) resolve();
                else reject(new Error(`Parça kesme hatası (code ${code}): ${stderr.slice(0, 300)}`));
            });
        });
    }

    /**
     * Yerel tepe noktalarını (skoru ortalamanın üstünde olan segmentler)
     * 20-90sn'lik aday pencerelerde kümeler.
     * @returns {Array<{start,end,score,text}>}
     */
    clusterWindows(segments) {
        if (segments.length === 0) return [];

        const scores = segments.map(s => s.score || 0);
        const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
        const std = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length) || 1;
        const seedThreshold = mean + 0.5 * std;

        const seeds = segments.filter(s => (s.score || 0) > seedThreshold && (s.score || 0) > 1)
            .sort((a, b) => a.start - b.start);
        if (seeds.length === 0) return [];

        // Yakın tepe noktalarını tek kümede birleştir
        const clusters = [];
        let current = null;
        for (const seed of seeds) {
            if (current && seed.start - current.rawEnd <= WINDOW_MERGE_GAP_SEC) {
                current.rawEnd = Math.max(current.rawEnd, seed.end);
                current.seeds.push(seed);
            } else {
                if (current) clusters.push(current);
                current = { rawStart: seed.start, rawEnd: seed.end, seeds: [seed] };
            }
        }
        if (current) clusters.push(current);

        return clusters.map(cluster => this._toWindow(cluster, segments));
    }

    /** Kümeyi min/max sınırlarına göre pencereye çevirir, metnini toplar */
    _toWindow(cluster, allSegments) {
        let start = Math.max(0, cluster.rawStart - WINDOW_PAD_SEC);
        let end = cluster.rawEnd + WINDOW_PAD_SEC;

        if (end - start < WINDOW_MIN_SEC) {
            const extra = (WINDOW_MIN_SEC - (end - start)) / 2;
            start = Math.max(0, start - extra);
            end = end + extra;
        } else if (end - start > WINDOW_MAX_SEC) {
            // Çok uzun kümeyi en yüksek puanlı tohumun etrafında ortala
            const peak = cluster.seeds.reduce((a, b) => (b.score > a.score ? b : a));
            start = Math.max(cluster.rawStart, peak.start - WINDOW_MAX_SEC / 2);
            end = Math.min(cluster.rawEnd, start + WINDOW_MAX_SEC);
        }

        const text = allSegments
            .filter(s => s.end >= start && s.start <= end)
            .map(s => s.text)
            .join(' ')
            .trim();
        const windowScore = Math.max(...cluster.seeds.map(s => s.score))
            + 0.2 * (cluster.seeds.reduce((a, s) => a + s.score, 0) / cluster.seeds.length);

        return { start: Math.round(start), end: Math.round(end), score: Math.round(windowScore * 100) / 100, text };
    }

    /** Çakışan pencereleri ele — yüksek puanlı olan kazanır */
    _dedupeOverlaps(windows) {
        const sorted = [...windows].sort((a, b) => b.score - a.score);
        const kept = [];
        for (const w of sorted) {
            const overlaps = kept.some(k => w.start < k.end && w.end > k.start);
            if (!overlaps) kept.push(w);
        }
        return kept.sort((a, b) => a.start - b.start);
    }

    /**
     * Aday pencereleri LLM ile nihai sıralamaya sok — sıkıcı/yanlış-pozitif
     * adayları ele, kategori + kısa gerekçe ekle. LLM yoksa ham skora göre
     * ilk maxClips döner (ViralScorer'daki heuristic-fallback deseniyle aynı).
     */
    async rankWithLLM(windows, { maxClips = 8, language = 'tr' } = {}) {
        const deduped = this._dedupeOverlaps(windows);
        if (deduped.length === 0) return [];

        if (!VisionLLM.isAvailable()) {
            return deduped
                .sort((a, b) => b.score - a.score)
                .slice(0, maxClips)
                .map(w => ({ ...w, kind: 'otomatik', reason: 'Ses enerjisi ve heyecan kelimelerine göre otomatik seçildi.' }));
        }

        const candidates = deduped.sort((a, b) => b.score - a.score).slice(0, MAX_LLM_CANDIDATES);
        const list = candidates
            .map((w, i) => `[${i}] (${this._ts(w.start)}-${this._ts(w.end)}) "${w.text.slice(0, 220)}"`)
            .join('\n');

        const prompt = `Sen bir Kick canlı yayın prodüktörüsün. Aşağıda saatlerce süren bir yayından, ses enerjisi ve heyecan kelimelerine göre önceden filtrelenmiş ADAY an listesi var. Her satırda zaman aralığı ve o aralıktaki konuşma metni var.

Adaylar:
${list}

Görev: Bunlardan KISA DİKEY VİDEO (TikTok/Reels/Shorts) olarak en güçlü en fazla ${maxClips} tanesini seç. Sıkıcı, bağlamsız, tekrarlı, reklam/sessizlik kaynaklı yanlış pozitifleri ELE. Az ama güçlü seçmek, çok ama vasat seçmekten iyidir.

SADECE JSON: {"picks": [{"index": 0, "kind": "heyecan|komedi|duygusal|diger", "reason": "kısa ${language === 'en' ? 'İngilizce' : 'Türkçe'} gerekçe"}]}`;

        try {
            const d = await VisionLLM.generateJson({
                prompt,
                purpose: 'text',
                maxOutput: 900,
                temperature: 0.3,
                timeout: 60000,
            });
            const picks = Array.isArray(d.picks) ? d.picks : [];
            const result = [];
            for (const pick of picks.slice(0, maxClips)) {
                const w = candidates[pick.index];
                if (!w) continue;
                result.push({
                    ...w,
                    kind: String(pick.kind || 'diger').slice(0, 20),
                    reason: String(pick.reason || '').slice(0, 300),
                });
            }
            return result.length > 0 ? result : candidates.slice(0, maxClips).map(w => ({ ...w, kind: 'otomatik', reason: 'Otomatik seçildi.' }));
        } catch (err) {
            console.error('[HighlightDetector] LLM sıralama hatası:', err.message);
            return candidates.slice(0, maxClips).map(w => ({ ...w, kind: 'otomatik', reason: 'Ses enerjisi ve heyecan kelimelerine göre otomatik seçildi (LLM yanıt vermedi).' }));
        }
    }

    /**
     * Uçtan uca: VOD → parçalı transkript → pencereleme → LLM seçimi.
     * @returns {Array<{start,end,score,text,kind,reason}>}
     */
    async detect(videoPath, workDir, { language = null, durationSec = 0, maxClips = 8, onProgress } = {}) {
        const { segments, language: resolvedLanguage } = await this.transcribeInChunks(videoPath, workDir, {
            language, durationSec, onProgress,
        });
        if (segments.length === 0) return [];

        const windows = this.clusterWindows(segments);
        return this.rankWithLLM(windows, { maxClips, language: resolvedLanguage });
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

module.exports = HighlightDetector;
