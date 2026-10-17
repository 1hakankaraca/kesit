/**
 * SmartCropper — Videodaki hareket yoğunluğuna göre önemli bölgeyi bulur
 *
 * Küçültülmüş gri kareler arasındaki farkları biriktirerek hareket haritası
 * çıkarır. Dikey formata kırpılırken pencere, hareketin en yoğun olduğu
 * bölgeye ortalanır (ör. oyunda aksiyonun geçtiği taraf).
 */
const { spawn } = require('./ProcTracker');

const MAP_W = 96; // hareket haritası çözünürlüğü
const SAMPLE_FPS = 2;
const MAX_SAMPLE_SECONDS = 60;

class SmartCropper {
    /**
     * Hareket ağırlık merkezini ve yoğunluk haritasını hesapla
     * @param {string} videoPath
     * @param {{width, height, duration}} meta
     * @param {{x,y,w,h}|null} excludeRect - facecam bölgesi (harekete dahil edilmez)
     * @returns {{focusX: number, focusY: number}} orijinal çözünürlükte odak noktası
     */
    async findFocus(videoPath, meta, excludeRect = null) {
        const w = MAP_W;
        const h = Math.round((meta.height / meta.width) * w / 2) * 2 || 54;
        const sampleDur = Math.min(meta.duration || MAX_SAMPLE_SECONDS, MAX_SAMPLE_SECONDS);

        const raw = await new Promise((resolve, reject) => {
            const chunks = [];
            const proc = spawn('ffmpeg', [
                '-loglevel', 'error',
                '-t', String(sampleDur),
                '-i', videoPath,
                '-vf', `fps=${SAMPLE_FPS},scale=${w}:${h},format=gray`,
                '-f', 'rawvideo', 'pipe:1',
            ]);
            proc.stdout.on('data', c => chunks.push(c));
            proc.on('error', reject);
            proc.on('exit', code => code === 0
                ? resolve(Buffer.concat(chunks))
                : reject(new Error('Hareket analizi kare çıkarma hatası')));
        });

        const frameSize = w * h;
        const frameCount = Math.floor(raw.length / frameSize);
        if (frameCount < 2) {
            return { focusX: meta.width / 2, focusY: meta.height / 2 };
        }

        // Facecam bölgesini harita koordinatlarına çevir
        let ex = null;
        if (excludeRect) {
            const sx = w / meta.width;
            const sy = h / meta.height;
            ex = {
                x0: Math.floor(excludeRect.x * sx),
                y0: Math.floor(excludeRect.y * sy),
                x1: Math.ceil((excludeRect.x + excludeRect.w) * sx),
                y1: Math.ceil((excludeRect.y + excludeRect.h) * sy),
            };
        }

        // Ardışık kare farklarını biriktir
        const motion = new Float64Array(frameSize);
        for (let f = 1; f < frameCount; f++) {
            const prev = f * frameSize - frameSize;
            const cur = f * frameSize;
            for (let i = 0; i < frameSize; i++) {
                motion[i] += Math.abs(raw[cur + i] - raw[prev + i]);
            }
        }

        // Ağırlıklı merkez (facecam bölgesi hariç)
        let totalWeight = 0, sumX = 0, sumY = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (ex && x >= ex.x0 && x < ex.x1 && y >= ex.y0 && y < ex.y1) continue;
                const m = motion[y * w + x];
                totalWeight += m;
                sumX += m * x;
                sumY += m * y;
            }
        }

        if (totalWeight === 0) {
            return { focusX: meta.width / 2, focusY: meta.height / 2 };
        }

        return {
            focusX: (sumX / totalWeight) * (meta.width / w),
            focusY: (sumY / totalWeight) * (meta.height / h),
        };
    }
}

module.exports = SmartCropper;
