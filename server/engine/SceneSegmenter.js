/**
 * SceneSegmenter — VOD'un tamamından periyodik kare örnekleyip içerik türüne
 * göre bölümlere ayırır (ör. "irl", "reddit", "oyun", "sohbet"). Yatay YouTube
 * kesitleri bu bölüm sınırlarından üretilir.
 *
 * 1. Tek ffmpeg geçişiyle (fps filtresi) her N saniyede bir JPEG kare alınır —
 *    saatlik VOD'da yüzlerce ayrı seek yerine tek sıralı okuma.
 * 2. Kareler toplu halde (varsayılan 8'li) VisionLLM'e (görsel) gönderilip
 *    serbest metin kısa bir tür etiketi aldırılır — sabit bir kategori
 *    listesiyle sınırlanmaz, model gördüğünü etiketler.
 * 3. Tek karelik "titreme" komşu oydaşmasıyla düzeltilir, ardışık aynı
 *    etiketler segmentlere birleştirilir, minimum süreden kısa segmentler
 *    daha büyük komşusuna yedirilir.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const VisionLLM = require('./VisionLLM');

const DEFAULT_INTERVAL_SEC = 30;
// Yatay YouTube kesitleri kısa/parçalı olmasın diye en az 10 dakika (600sn) —
// daha kısa sahne değişimleri komşusuna yedirilerek bu süreye tamamlanır.
// BİLEREK bir üst sınır YOK — bir sahne/konu gerçekten saatlerce sürebilir
// (kullanıcı isteği); dosya boyutu sorununu burada değil, paylaşım
// aşamasında (ZernioPublisher) net bir uyarıyla ele alıyoruz.
const MIN_SEGMENT_SEC = 600;
const BATCH_SIZE = 8;

class SceneSegmenter {
    static isAvailable() {
        return VisionLLM.isAvailable();
    }

    /**
     * @returns {Array<{label, startSec, endSec}>}
     */
    async detect(videoPath, workDir, { durationSec = 0, intervalSec = DEFAULT_INTERVAL_SEC, onProgress } = {}) {
        if (!VisionLLM.isAvailable() || durationSec <= intervalSec) return [];

        const frameDir = path.join(workDir, 'scene-frames');
        fs.mkdirSync(frameDir, { recursive: true });
        try {
            const frameCount = await this._extractFrames(videoPath, frameDir, durationSec, intervalSec);
            if (frameCount === 0) return [];

            const labels = await this._labelFrames(frameDir, frameCount, onProgress);
            const smoothed = this._smooth(labels);
            const segments = this._mergeIntoSegments(smoothed, intervalSec);
            return this._absorbShortSegments(segments);
        } finally {
            fs.rmSync(frameDir, { recursive: true, force: true });
        }
    }

    /** Tek ffmpeg geçişiyle her intervalSec'te bir küçük JPEG kare çıkarır */
    _extractFrames(videoPath, frameDir, durationSec, intervalSec) {
        return new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', [
                '-y', '-loglevel', 'error',
                '-i', videoPath,
                '-vf', `fps=1/${intervalSec},scale=480:-2`,
                '-q:v', '5',
                path.join(frameDir, 'frame_%05d.jpg'),
            ]);
            let stderr = '';
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', reject);
            proc.on('exit', code => {
                if (code !== 0) return reject(new Error(`Kare örnekleme hatası (code ${code}): ${stderr.slice(0, 300)}`));
                const count = fs.readdirSync(frameDir).filter(f => f.endsWith('.jpg')).length;
                resolve(count);
            });
        });
    }

    /** Kareleri BATCH_SIZE'lık gruplar halinde VisionLLM'e gönderip etiket alır */
    async _labelFrames(frameDir, frameCount, onProgress) {
        const labels = [];
        const batchCount = Math.ceil(frameCount / BATCH_SIZE);

        for (let b = 0; b < batchCount; b++) {
            const start = b * BATCH_SIZE + 1;
            const end = Math.min(frameCount, start + BATCH_SIZE - 1);
            const images = [];
            for (let i = start; i <= end; i++) {
                const file = path.join(frameDir, `frame_${String(i).padStart(5, '0')}.jpg`);
                if (!fs.existsSync(file)) continue;
                images.push({ data: fs.readFileSync(file).toString('base64'), label: `Kare ${i - start + 1}` });
            }
            if (images.length === 0) continue;

            const batchLabels = await this._labelBatch(images).catch(err => {
                console.error('[SceneSegmenter] Kare etiketleme hatası:', err.message);
                return images.map(() => 'bilinmiyor');
            });
            labels.push(...batchLabels);
            if (onProgress) onProgress(b + 1, batchCount);
        }
        return labels;
    }

    async _labelBatch(images) {
        const prompt = `Sen bir Kick canlı yayın içerik sınıflandırıcısısın. Aşağıda bir yayından sırayla alınmış ${images.length} kare var.

Her karenin ne tür içerik gösterdiğini KISA bir Türkçe etiketle sınıflandır. Örnek etiketler: "irl" (sokak/kamera gezintisi, dışarıda), "reddit" (reddit/forum gönderisi okuma), "oyun" (video oyunu ekranı), "sohbet" (yalnızca webcam/masa başı sohbet), "izleme" (video/klip/yayın izleme), "diger". Bu listeyle sınırlı değilsin, gördüğün en uygun kısa etiketi kullan.

SADECE JSON: {"labels": ["etiket1", "etiket2", ...]} — tam olarak ${images.length} eleman, kare sırasına göre.`;

        const d = await VisionLLM.generateJson({
            prompt, images, purpose: 'vision', maxOutput: 400, temperature: 0, timeout: 45000,
        });
        const labels = Array.isArray(d.labels) ? d.labels.map(l => String(l || 'bilinmiyor').toLowerCase().slice(0, 30)) : [];
        while (labels.length < images.length) labels.push('bilinmiyor');
        return labels.slice(0, images.length);
    }

    /** Tek karelik titremeyi komşu oydaşmasıyla düzelt */
    _smooth(labels) {
        const smoothed = [...labels];
        for (let i = 1; i < labels.length - 1; i++) {
            if (labels[i] !== labels[i - 1] && labels[i - 1] === labels[i + 1]) {
                smoothed[i] = labels[i - 1];
            }
        }
        return smoothed;
    }

    _mergeIntoSegments(labels, intervalSec) {
        const segments = [];
        let current = null;
        labels.forEach((label, i) => {
            const start = i * intervalSec;
            const end = start + intervalSec;
            if (current && current.label === label) {
                current.endSec = end;
            } else {
                if (current) segments.push(current);
                current = { label, startSec: start, endSec: end };
            }
        });
        if (current) segments.push(current);
        return segments;
    }

    /** Minimum süreden kısa segmentleri daha büyük komşusuna yedir */
    _absorbShortSegments(segments) {
        const list = segments.map(s => ({ ...s }));
        let changed = true;
        while (changed && list.length > 1) {
            changed = false;
            for (let i = 0; i < list.length; i++) {
                if (list[i].endSec - list[i].startSec >= MIN_SEGMENT_SEC) continue;
                const prev = list[i - 1];
                const next = list[i + 1];
                if (!prev && !next) continue;
                const prevDur = prev ? prev.endSec - prev.startSec : -1;
                const nextDur = next ? next.endSec - next.startSec : -1;
                if (prevDur >= nextDur) prev.endSec = list[i].endSec;
                else next.startSec = list[i].startSec;
                list.splice(i, 1);
                changed = true;
                break;
            }
        }
        return list.filter(s => s.endSec - s.startSec >= MIN_SEGMENT_SEC || list.length === 1);
    }

    /**
     * Segmentleri "YouTube'da ayrı video olarak ne kadar ilgi çeker" açısından
     * 0-100 puanlar — HighlightDetector.rankWithLLM ile aynı fikir, ama kısa
     * video süre bandı YOK (ViralScorer 15-60sn'ye göre kurulu, 10+ dakikalık
     * yatay kesitler için uygunsuz düşer). Segmentin zaman aralığına denk
     * gelen transkript metni bağlam olarak verilir — VOD zaten HighlightDetector
     * tarafından transkript edildiğinden burada whisper TEKRAR ÇALIŞTIRILMAZ,
     * çağıran (VodScanManager) aynı transkripti paylaşır.
     * @param {Array<{label,startSec,endSec}>} segments
     * @param {Array<{start,end,text}>} transcriptSegments - VOD'un tam transkripti
     * @returns {Array<{label,startSec,endSec,score,reason}>}
     */
    async scoreSegments(segments, transcriptSegments = [], { language = 'tr' } = {}) {
        if (segments.length === 0) return [];

        const withText = segments.map(seg => {
            const text = transcriptSegments
                .filter(t => t.end >= seg.startSec && t.start <= seg.endSec)
                .map(t => t.text)
                .join(' ')
                .trim()
                .slice(0, 600);
            return { ...seg, _text: text };
        });

        if (!VisionLLM.isAvailable()) {
            // LLM yoksa nötr sezgisel puan: konuşma metni bulunan bölümler
            // sessiz/duraklama ağırlıklı bölümlerden hafifçe öndedir.
            return withText.map(s => ({
                ...s, score: s._text ? 55 : 40,
                reason: 'Sezgisel puan (LLM kapalı).',
                _text: undefined,
            }));
        }

        const list = withText
            .map((s, i) => `[${i}] (${this._ts(s.startSec)}-${this._ts(s.endSec)}, ${Math.round((s.endSec - s.startSec) / 60)}dk, etiket: ${s.label}) "${s._text || '(konuşma yok)'}"`)
            .join('\n');

        const prompt = `Sen bir YouTube video editörüsün. Aşağıda saatlerce süren bir Kick canlı yayından tespit edilmiş bölüm listesi var — her biri ayrı bir YouTube videosu olarak yayınlanma adayı. Her satırda zaman aralığı, süre, görsel içerik etiketi ve o bölümde geçen konuşmadan bir örnek var.

Bölümler:
${list}

Görev: Her bölümü, YouTube'da AYRI bir video olarak yayınlandığında izleyici ilgisini ne kadar çekeceğine göre 0-100 puanla.

Değerlendirme kriterleri:
- Konu ilginç/eğlenceli/gündem oluşturacak nitelikte mi, yoksa sıradan/durağan mı?
- Başından sonuna izlemeyi sağlayacak bir gelişme/olay örgüsü var mı?
- Bağlamsız (yayını hiç izlemeyen biri) anlayıp ilgilenir mi?
- Uzun sessizlik/tekrar/reklam arası gibi zayıf bölümlere düşük puan ver.

Puanlama rehberi: 0-30 zayıf, 31-55 vasat, 56-75 iyi, 76-100 çok güçlü. Cömert davranma.

SADECE JSON: {"scores": [{"index": 0, "score": 0-100, "reason": "tek cümle ${language === 'en' ? 'İngilizce' : 'Türkçe'} gerekçe"}, ...]} — TÜM bölümler için, sırasıyla.`;

        try {
            const d = await VisionLLM.generateJson({
                prompt, purpose: 'text', maxOutput: 1200, temperature: 0.3, timeout: 60000,
            });
            const scores = Array.isArray(d.scores) ? d.scores : [];
            const byIndex = new Map(scores.map(s => [Number(s.index), s]));
            return withText.map((s, i) => {
                const found = byIndex.get(i);
                return {
                    ...s,
                    score: found ? Math.max(0, Math.min(100, Math.round(Number(found.score) || 0))) : 40,
                    reason: found ? String(found.reason || '').slice(0, 300) : 'LLM bu bölüm için puan döndürmedi.',
                    _text: undefined,
                };
            });
        } catch (err) {
            console.error('[SceneSegmenter] Puanlama hatası:', err.message);
            return withText.map(s => ({ ...s, score: s._text ? 55 : 40, reason: 'Sezgisel puan (LLM yanıt vermedi).', _text: undefined }));
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

module.exports = SceneSegmenter;
