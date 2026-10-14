/**
 * AudioCensor — verilen zaman aralıklarında orijinal sesi susturup yerine
 * bip tonu (1000Hz) bindirir. Hangi aralıkların bipleneceği burada
 * belirlenmez (bkz. ProfanityCensor) — bu modül yalnızca uygulamayı yapar.
 *
 * Video akışı DOKUNULMADAN kopyalanır (-c:v copy); yalnız ses yeniden
 * kodlanır (filtre grafiği ses akışını decode etmeyi gerektirir, stream
 * copy ile bir arada kullanılamaz).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class AudioCensor {
    /**
     * @param {string} inputPath - video (ses dahil)
     * @param {string} outputPath
     * @param {Array<{start: number, end: number}>} ranges - bip aralıkları (saniye, zaman sıralı)
     * @param {number} totalDuration - video toplam süresi (bip tonu kaynağının süresi için)
     */
    static async apply(inputPath, outputPath, ranges, totalDuration) {
        if (!ranges || ranges.length === 0) {
            throw new Error('Bipleme için aralık yok');
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        const enableExpr = ranges.map(r => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`).join('+');
        const sineDuration = Math.max(1, Math.ceil(totalDuration || ranges[ranges.length - 1].end));

        await new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', [
                '-y', '-loglevel', 'error',
                '-i', inputPath,
                '-f', 'lavfi', '-i', `sine=frequency=1000:duration=${sineDuration}`,
                '-filter_complex',
                `[0:a]volume=enable='${enableExpr}':volume=0[muted];` +
                `[1:a]volume=enable='${enableExpr}':volume=1,volume=enable='not(${enableExpr})':volume=0[beep];` +
                `[muted][beep]amix=inputs=2:duration=first:normalize=0[aout]`,
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
                '-movflags', '+faststart',
                outputPath,
            ]);
            let stderr = '';
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', reject);
            proc.on('exit', code => {
                if (code === 0) resolve();
                else reject(new Error(`Bipleme hatası (code ${code}): ${stderr.slice(0, 300)}`));
            });
        });

        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 10000) {
            throw new Error('Biplenen çıktı boş veya bozuk');
        }
        return outputPath;
    }
}

module.exports = AudioCensor;
