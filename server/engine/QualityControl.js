/**
 * QualityControl — Üretilen dikey klibi yayından önce doğrular
 *
 * İki katmanlı kontrol:
 *  1. Yapısal (kod): boyut, piksel oranı, süre, ses (VerticalComposer.verifyOutput'tan)
 *  2. Görsel (VisionLLM — OpenAI birincil, Gemini yedek): kaynak ile çıktıyı
 *     karşılaştırır —
 *     - Kaynakta webcam varsa çıktıda üstte tam/bozulmamış mı?
 *     - Kaynakta webcam yoksa çıktı temiz dikey kırpma mı?
 *     - Esneme, siyah alan, çift görüntü, aşırı zoom, yanlış bölge var mı?
 *
 * Sonuç: verdict = 'ok' | 'suspicious' | 'broken'
 *  - broken  → yayınlanmamalı (webcam kayıp / ciddi bozukluk)
 *  - suspicious → şüpheli, insan kontrolü önerilir
 *
 * LLM anahtarı yoksa yalnızca yapısal kontrol yapılır.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const VisionLLM = require('./VisionLLM');

class QualityControl {
    static isVisionAvailable() {
        return VisionLLM.isAvailable();
    }

    /**
     * @param {object} p
     *   - sourcePath: orijinal klip
     *   - outputPath: üretilen dikey klip
     *   - facecam: FacecamDetector sonucu (method vb.)
     *   - verifyInfo: VerticalComposer.verifyOutput().info
     *   - workDir: geçici kare dosyaları için
     * @returns {{verdict:'ok'|'suspicious'|'broken', issues:string[], vision:object|null}}
     */
    async check({ sourcePath, outputPath, facecam, verifyInfo, workDir }) {
        const issues = [];
        let verdict = 'ok';
        const bump = (v) => {
            const rank = { ok: 0, suspicious: 1, broken: 2 };
            if (rank[v] > rank[verdict]) verdict = v;
        };

        // --- 1. Yapısal kontroller
        if (verifyInfo) {
            if (verifyInfo.width !== 1080 || verifyInfo.height !== 1920) {
                issues.push(`Boyut ${verifyInfo.width}x${verifyInfo.height} — 1080x1920 olmalı`);
                bump('broken');
            }
            if (verifyInfo.sar && verifyInfo.sar !== '1:1' && verifyInfo.sar !== 'N/A') {
                issues.push(`Piksel oranı bozuk (${verifyInfo.sar})`);
                bump('broken');
            }
            if (!verifyInfo.hasAudio) { issues.push('Ses akışı yok'); bump('suspicious'); }
        }

        // --- 2. Görsel kontrol (Gemini)
        let vision = null;
        if (QualityControl.isVisionAvailable()) {
            vision = await this._visionCheck({ sourcePath, outputPath, workDir }).catch(err => {
                console.error('[QC] Vision hatası:', err.message);
                return null;
            });
            if (vision) {
                // Kaynakta webcam var ama çıktıda üste konmamış → bozuk
                if (vision.sourceHasWebcam && !vision.outputHasWebcamOnTop) {
                    issues.push('Kaynakta webcam var ama çıktıda üste yerleştirilmemiş');
                    bump('broken');
                }
                if (vision.issues && vision.issues.length) {
                    issues.push(...vision.issues);
                }
                bump(vision.verdict === 'broken' ? 'broken'
                    : vision.verdict === 'suspicious' ? 'suspicious'
                    : (vision.layoutCorrect ? 'ok' : 'suspicious'));
            } else {
                // Görsel kontrol yapılamadıysa körlemesine yayınlama — şüpheli işaretle
                issues.push('Görsel kalite kontrolü yapılamadı');
                bump('suspicious');
            }
        }

        // Tekilleştir
        const uniqueIssues = [...new Set(issues)];
        return { verdict, issues: uniqueIssues, vision };
    }

    async _visionCheck({ sourcePath, outputPath, workDir }) {
        fs.mkdirSync(workDir, { recursive: true });
        const srcFrame = path.join(workDir, 'qc_src.jpg');
        const outFrame = path.join(workDir, 'qc_out.jpg');
        // Ortaya yakın bir kareden örnekle (giriş/çıkış karaltılarından kaçın)
        await this._frame(sourcePath, srcFrame, '512:-1');
        await this._frame(outputPath, outFrame, '360:640');

        const srcB64 = fs.readFileSync(srcFrame).toString('base64');
        const outB64 = fs.readFileSync(outFrame).toString('base64');

        const prompt = `Kısa video kalite kontrolörüsün. İki görsel:
1) KAYNAK: orijinal yatay yayın klibi
2) ÇIKTI: bundan üretilen dikey (9:16) video

Değerlendirme kuralları:
- KAYNAK'ta bir yayıncı webcam'i (köşede, bir insanın kamera görüntüsü) VARSA → ÇIKTI'da bu webcam ÜST kısımda, kişi ortalanmış ve bozulmamış (esnememiş, aşırı yakınlaşmamış) görünmeli; ALT kısımda oyun/içerik olmalı. Kişiyi ortalamak için webcam'in boş kenarının bir miktar kırpılmış olması NORMALDİR — kişi görünür ve doğal durduğu sürece bozukluk sayma.
- KAYNAK'ta webcam YOKSA → ÇIKTI, ana içeriğin/konuşan kişinin temiz dikey kırpması olmalı.
- BOZUK sayılacak durumlar: yüz yatay esnemiş/yamuk, siyah veya boş alan var, aynı kişi hem üstte hem altta görünüyor, webcam yerine alakasız bölge alınmış, aşırı yakın (sadece yüz) kırpma, üst-alt uyumsuz.

Bu sınırların dışına çıkan her şey 'broken' veya 'suspicious' olmalı. Emin değilsen 'suspicious'.

SADECE şu JSON formatında yanıt ver:
{"sourceHasWebcam": true/false, "outputHasWebcamOnTop": true/false, "layoutCorrect": true/false, "issues": ["kısa Türkçe sorun"], "verdict": "ok"|"suspicious"|"broken"}`;

        const data = await VisionLLM.generateJson({
            prompt,
            images: [
                { data: srcB64, label: '--- KAYNAK (orijinal yatay) ---' },
                { data: outB64, label: '--- ÇIKTI (üretilen dikey) ---' },
            ],
            maxOutput: 400,
            temperature: 0.2,
            timeout: 50000,
            geminiModel: process.env.GEMINI_QC_MODEL || process.env.GEMINI_MODEL,
        });
        return {
            sourceHasWebcam: !!data.sourceHasWebcam,
            outputHasWebcamOnTop: !!data.outputHasWebcamOnTop,
            layoutCorrect: !!data.layoutCorrect,
            issues: Array.isArray(data.issues) ? data.issues.map(String).slice(0, 6) : [],
            verdict: ['ok', 'suspicious', 'broken'].includes(data.verdict) ? data.verdict : 'suspicious',
        };
    }

    _frame(video, out, scale) {
        return new Promise((resolve, reject) => {
            execFile('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '3', '-i', video, '-frames:v', '1', '-vf', `scale=${scale}`, out],
                (e) => e ? reject(e) : resolve());
        });
    }
}

module.exports = QualityControl;
