/**
 * FacecamDetector v2 — Video içindeki ekran üstü kamera (facecam) bölgesini tespit eder
 *
 * İki aşamalı yaklaşım (bkz. USPTO 10360687 — "static borders" tekniği):
 *  1. YÜZ ÇAPASI: pico.js (saf JS, MIT) örneklenen karelerde yüz arar.
 *     Kareler arası aynı konumda tekrarlayan yüz kümesi = facecam adayı.
 *  2. KENAR KALICILIK HARİTASI: Her karede gradyan (kenar) haritası çıkarılır.
 *     Webcam overlay'inin çerçeve kenarları SABİTTİR — karelerin >%75'inde aynı
 *     pikselde kenar varsa "kalıcı kenar"dır. Yüz çapasından dışa taranarak
 *     kalıcı kenarlardan oluşan dikdörtgen sınırlar bulunur.
 *
 *  Dikdörtgen bulunamazsa (çerçevesiz kamera) genişletilmiş yüz kutusuna düşülür.
 *  Yüz kareye göre çok büyükse video "tam kamera" (IRL) sayılır.
 */
const { spawn } = require('child_process');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// pico.js tarayıcı-global stilinde yazılmış; fonksiyon kapsamında çalıştırıp alıyoruz
const picoSource = fs.readFileSync(path.join(__dirname, 'vendor', 'pico.js'), 'utf8');
const pico = new Function(`${picoSource}; return pico;`)();

const cascadeBytes = fs.readFileSync(path.join(__dirname, 'vendor', 'facefinder'));
const classifyFace = pico.unpack_cascade(new Int8Array(cascadeBytes.buffer, cascadeBytes.byteOffset, cascadeBytes.length));

const SAMPLE_FRAMES = 12;    // videodan örneklenen kare sayısı
const DETECT_WIDTH = 640;    // tespit için küçültülmüş genişlik (küçük köşe kameraları için yeterli detay)
const MIN_QUALITY = 5.0;     // pico tespit kalite eşiği
const MIN_FRAME_HITS = 0.35; // yüzün karelerin en az %35'inde görünmesi gerekir
const GRADIENT_THRESHOLD = 24;   // kenar sayılma eşiği (0-255 gri)
const PERSISTENCE_RATIO = 0.75;  // kenarın "kalıcı" sayılması için kare oranı
const EDGE_LINE_MIN_SCORE = 0.42; // sınır çizgisi kabul eşiği (kalıcı piksel oranı)

class FacecamDetector {
    /**
     * Videonun metadata'sını döndür
     */
    async probe(videoPath) {
        const out = await new Promise((resolve, reject) => {
            execFile('ffprobe', [
                '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=width,height:format=duration',
                '-of', 'json', videoPath,
            ], (err, stdout) => err ? reject(err) : resolve(stdout));
        });
        const info = JSON.parse(out);
        const stream = info.streams?.[0] || {};
        return {
            width: stream.width || 1920,
            height: stream.height || 1080,
            duration: parseFloat(info.format?.duration) || 0,
        };
    }

    /**
     * Videodan eşit aralıklı gri tonlamalı kareler çıkar
     */
    async _extractGrayFrames(videoPath, srcW, srcH, duration, count = SAMPLE_FRAMES, targetW = DETECT_WIDTH) {
        const w = targetW;
        const h = Math.round((srcH / srcW) * targetW / 2) * 2;
        const fps = Math.max(0.1, count / Math.max(duration, 1));

        const raw = await new Promise((resolve, reject) => {
            const chunks = [];
            const proc = spawn('ffmpeg', [
                '-loglevel', 'error',
                '-i', videoPath,
                '-vf', `fps=${fps.toFixed(4)},scale=${w}:${h},format=gray`,
                '-frames:v', String(count),
                '-f', 'rawvideo', 'pipe:1',
            ]);
            proc.stdout.on('data', c => chunks.push(c));
            let stderr = '';
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', reject);
            proc.on('exit', code => {
                if (code === 0) resolve(Buffer.concat(chunks));
                else reject(new Error(`Kare çıkarma hatası: ${stderr.slice(0, 200)}`));
            });
        });

        const frameSize = w * h;
        const frames = [];
        for (let off = 0; off + frameSize <= raw.length; off += frameSize) {
            frames.push(new Uint8Array(raw.buffer, raw.byteOffset + off, frameSize));
        }
        return { frames, w, h };
    }

    _detectFacesInFrame(pixels, w, h) {
        const image = { pixels, nrows: h, ncols: w, ldim: w };
        const params = {
            shiftfactor: 0.08,  // sık tarama — küçük köşe kameralarındaki yüzler için
            minsize: Math.max(14, Math.round(h * 0.04)),
            maxsize: Math.round(h * 0.9),
            scalefactor: 1.08,
        };
        let dets = pico.run_cascade(image, classifyFace, params);
        dets = pico.cluster_detections(dets, 0.2);
        // det = [satır(y), sütun(x), boyut, kalite]
        return dets.filter(d => d[3] > MIN_QUALITY);
    }

    /**
     * IRL / tek-parça (webcam'siz) videolar için yüz TAKİBİ.
     *
     * Videoyu `count` (varsayılan 30) karede örnekler, her karede pico ile yüz
     * arar, süreklilik (önceki seçime yakınlık) + kaliteye göre en kararlı yüzü
     * seçer. Yüz bulunmayan kareleri komşulardan lineer interpolasyonla doldurur,
     * tekil sıçramaları medyan-3 ile temizler ve iki yönlü EMA ile yumuşatır
     * (faz kaymasız → kamera takılmadan akıcı kayar).
     *
     * @param {string} videoPath
     * @param {{width,height,duration}} meta
     * @param {{count?:number}} opts
     * @returns {{keyframes: Array<{t:number, cx:number, cy:number}>, coverage:number}|null}
     *   Yüz karelerin %40'ından azında görünüyorsa (yüz-merkezli değil) null döner.
     */
    async trackFace(videoPath, meta, { count = 30 } = {}) {
        const duration = Math.max(meta.duration || 0, 0.5);
        const { frames, w, h } = await this._extractGrayFrames(
            videoPath, meta.width, meta.height, duration, count, DETECT_WIDTH
        );
        const n = frames.length;
        if (n < 2) return null;

        // 1) Her karede en iyi yüz — kalite + önceki merkeze yakınlık (süreklilik)
        const cxs = new Array(n).fill(null);
        const cys = new Array(n).fill(null);
        let prev = null;
        for (let i = 0; i < n; i++) {
            const dets = this._detectFacesInFrame(frames[i], w, h);
            if (!dets.length) continue;
            let best = null, bestScore = -Infinity;
            for (const d of dets) {
                const dy = d[0], dx = d[1], dq = d[3];
                // Süreklilik: önceki seçime uzaklık başına küçük ceza; kalite
                // çok daha yüksek olmadıkça yakın yüzü koru (arka plandaki
                // kişilere atlamayı önler).
                let score = dq;
                if (prev) score -= 0.05 * Math.hypot(dx - prev.x, dy - prev.y);
                if (score > bestScore) { bestScore = score; best = { x: dx, y: dy }; }
            }
            if (best) { cxs[i] = best.x; cys[i] = best.y; prev = best; }
        }

        const detected = cxs.filter(v => v !== null).length;
        const coverage = detected / n;
        if (coverage < 0.4) return null; // yüz-merkezli video değil → hareket odağı

        // 2) Boşlukları lineer doldur (uçlarda en yakın değeri tut)
        this._fillGaps(cxs);
        this._fillGaps(cys);

        // 3) Tekil sıçramaları medyan-3 ile bastır, ardından iki yönlü EMA
        const cxS = this._smoothSeries(cxs);
        const cyS = this._smoothSeries(cys);

        // 4) Anahtar kareler — ölçekli koordinatları tam çözünürlüğe çevir
        const sx = meta.width / w;
        const sy = meta.height / h;
        const keyframes = [];
        for (let i = 0; i < n; i++) {
            const t = ((i + 0.5) * duration) / n;
            keyframes.push({ t, cx: cxS[i] * sx, cy: cyS[i] * sy });
        }
        return { keyframes, coverage };
    }

    /** Dizideki null'ları komşu değerlerden lineer interpolasyonla doldurur */
    _fillGaps(arr) {
        const n = arr.length;
        let i = 0;
        // baştaki null'lar → ilk gerçek değer
        while (i < n && arr[i] === null) i++;
        if (i === n) return; // hiç değer yok
        for (let k = 0; k < i; k++) arr[k] = arr[i];
        // sondaki null'lar → son gerçek değer (döngü sonunda)
        let last = i;
        for (let j = i + 1; j < n; j++) {
            if (arr[j] === null) continue;
            if (j - last > 1) { // aradaki boşluğu doldur
                const step = (arr[j] - arr[last]) / (j - last);
                for (let k = last + 1; k < j; k++) arr[k] = arr[last] + step * (k - last);
            }
            last = j;
        }
        for (let k = last + 1; k < n; k++) arr[k] = arr[last];
    }

    /** Medyan-3 (sıçrama temizliği) + iki yönlü EMA (faz kaymasız yumuşatma) */
    _smoothSeries(arr, alpha = 0.5) {
        const n = arr.length;
        if (n < 3) return arr.slice();
        const med = arr.slice();
        for (let i = 1; i < n - 1; i++) {
            const a = arr[i - 1], b = arr[i], c = arr[i + 1];
            med[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); // 3'ün medyanı
        }
        const f = med.slice();
        for (let i = 1; i < n; i++) f[i] = alpha * med[i] + (1 - alpha) * f[i - 1];
        const b = f.slice();
        for (let i = n - 2; i >= 0; i--) b[i] = alpha * f[i] + (1 - alpha) * b[i + 1];
        return b;
    }

    /**
     * Zamansal kenar kalıcılık haritası — karelerin çoğunda aynı yerde
     * kenar bulunan pikseller 1, diğerleri 0.
     * Webcam çerçevesi, HUD gibi sabit overlay kenarlarını ortaya çıkarır.
     */
    _buildEdgePersistenceMap(frames, w, h) {
        const count = new Uint16Array(w * h);

        for (const f of frames) {
            for (let y = 1; y < h - 1; y++) {
                const row = y * w;
                for (let x = 1; x < w - 1; x++) {
                    const i = row + x;
                    const gx = Math.abs(f[i + 1] - f[i - 1]);
                    const gy = Math.abs(f[i + w] - f[i - w]);
                    if (gx + gy > GRADIENT_THRESHOLD) count[i]++;
                }
            }
        }

        const need = Math.ceil(frames.length * PERSISTENCE_RATIO);
        const persistent = new Uint8Array(w * h);
        for (let i = 0; i < count.length; i++) {
            persistent[i] = count[i] >= need ? 1 : 0;
        }
        return persistent;
    }

    /**
     * Webcam overlay dikdörtgenini TAM ÇEVRE skorlamasıyla bul.
     *
     * Gerçek kamera çerçevesinin ayırt edici özelliği: DÖRT kenarı da
     * kesintisiz kalıcı kenardan oluşan tam bir dikdörtgendir. Kamera
     * içindeki oda detayları (kapı, duvar kenarı) güçlü çizgiler üretse de
     * diğer kenarlarla tam dikdörtgen kapatmaz. Bu yüzden aday üst/alt/sol/sağ
     * çizgi kombinasyonları denenir ve her dikdörtgen, DÖRT kenarının en
     * zayıfının kalıcılık skoruyla puanlanır (min-kenar). En yüksek puanlı,
     * eşitlikte EN BÜYÜK dikdörtgen seçilir — böylece yüze yapışık iç
     * dikdörtgenler değil, overlay'in tamamı alınır.
     *
     * @returns {{x0,y0,x1,y1}|null} ölçekli koordinatlarda sınırlar
     */
    _refineRectFromEdges(persistent, w, h, face) {
        const s = face.s;
        const FRAME_EDGE_SCORE = 0.45; // kare kenarına dayalı kenar için varsayılan skor
        const MIN_CAND_SCORE = 0.18;   // aday çizgi alt eşiği (zayıf kenarlar da aday olur;
                                       // eleme dikdörtgen seviyesinde yapılır)
        const MAX_CANDS = 14;          // kenar başına maksimum aday

        // --- Prefix toplamları: O(1) çizgi parçası skorlaması için
        // rowPrefix[y*(w+1)+x] = persistent[y][0..x-1] toplamı
        const rowPrefix = new Uint32Array(h * (w + 1));
        for (let y = 0; y < h; y++) {
            const base = y * (w + 1);
            const row = y * w;
            for (let x = 0; x < w; x++) {
                rowPrefix[base + x + 1] = rowPrefix[base + x] + persistent[row + x];
            }
        }
        const colPrefix = new Uint32Array(w * (h + 1));
        for (let x = 0; x < w; x++) {
            const base = x * (h + 1);
            for (let y = 0; y < h; y++) {
                colPrefix[base + y + 1] = colPrefix[base + y] + persistent[y * w + x];
            }
        }
        const rowSegScore = (y, x0, x1) => {
            if (y < 1 || y >= h - 1 || x1 <= x0) return 0;
            const base = y * (w + 1);
            return (rowPrefix[base + x1] - rowPrefix[base + x0]) / (x1 - x0);
        };
        const colSegScore = (x, y0, y1) => {
            if (x < 1 || x >= w - 1 || y1 <= y0) return 0;
            const base = x * (h + 1);
            return (colPrefix[base + y1] - colPrefix[base + y0]) / (y1 - y0);
        };
        // Kenar 1-2px kayabilir — komşu çizgilerle birlikte en iyisini al
        const rowScore3 = (y, x0, x1) => Math.max(rowSegScore(y - 1, x0, x1), rowSegScore(y, x0, x1), rowSegScore(y + 1, x0, x1));
        const colScore3 = (x, y0, y1) => Math.max(colSegScore(x - 1, y0, y1), colSegScore(x, y0, y1), colSegScore(x + 1, y0, y1));

        // --- Aday çizgiler: yüz çevresindeki bantta yerel maksimumlar
        const collectCandidates = (from, to, scoreFn) => {
            const scores = new Map();
            for (let p = from; p <= to; p++) scores.set(p, scoreFn(p));
            const cands = [];
            for (let p = from; p <= to; p++) {
                const sc = scores.get(p);
                if (sc < MIN_CAND_SCORE) continue;
                // ±2 komşuluğunda yerel maksimum olsun (çizgi tekilleştirme)
                let isPeak = true;
                for (let d = -2; d <= 2; d++) {
                    if ((scores.get(p + d) ?? 0) > sc) { isPeak = false; break; }
                }
                if (isPeak) cands.push({ pos: p, score: sc });
            }
            cands.sort((a, b) => b.score - a.score);
            return cands.slice(0, MAX_CANDS);
        };

        const bandX0 = Math.max(1, Math.round(face.x - s * 1.5));
        const bandX1 = Math.min(w - 1, Math.round(face.x + s * 1.5));
        const bandY0f = Math.max(1, Math.round(face.y - s * 1.5));
        const bandY1f = Math.min(h - 1, Math.round(face.y + s * 1.5));

        const V_SPAN = 6, H_SPAN = 9; // arama açıklıkları (yüz boyutu katı)

        const topCands = collectCandidates(
            Math.max(1, Math.round(face.y - s * V_SPAN)),
            Math.round(face.y - s * 0.7),
            y => rowScore3(y, bandX0, bandX1)
        );
        const bottomCands = collectCandidates(
            Math.round(face.y + s * 0.7),
            Math.min(h - 2, Math.round(face.y + s * V_SPAN)),
            y => rowScore3(y, bandX0, bandX1)
        );
        const leftCands = collectCandidates(
            Math.max(1, Math.round(face.x - s * H_SPAN)),
            Math.round(face.x - s * 0.7),
            x => colScore3(x, bandY0f, bandY1f)
        );
        const rightCands = collectCandidates(
            Math.round(face.x + s * 0.7),
            Math.min(w - 2, Math.round(face.x + s * H_SPAN)),
            x => colScore3(x, bandY0f, bandY1f)
        );

        // Kare kenarları da geçerli sınır adayı (köşeye/kenara dayalı kameralar)
        if (face.y - s * V_SPAN <= 0) topCands.push({ pos: 0, score: FRAME_EDGE_SCORE, frameEdge: true });
        if (face.y + s * V_SPAN >= h - 1) bottomCands.push({ pos: h - 1, score: FRAME_EDGE_SCORE, frameEdge: true });
        if (face.x - s * H_SPAN <= 0) leftCands.push({ pos: 0, score: FRAME_EDGE_SCORE, frameEdge: true });
        if (face.x + s * H_SPAN >= w - 1) rightCands.push({ pos: w - 1, score: FRAME_EDGE_SCORE, frameEdge: true });

        if (topCands.length === 0 || bottomCands.length === 0 || leftCands.length === 0 || rightCands.length === 0) {
            return null;
        }

        // --- Kombinasyonları tam çevre skoruyla değerlendir
        const frameArea = w * h;
        let best = null;

        for (const top of topCands) {
            for (const bottom of bottomCands) {
                const rh = bottom.pos - top.pos;
                if (rh < s * 1.6 || rh > h * 0.85) continue;

                for (const left of leftCands) {
                    for (const right of rightCands) {
                        const rw = right.pos - left.pos;
                        if (rw < s * 1.6) continue;

                        const aspect = rw / rh;
                        if (aspect < 1.15 || aspect > 2.8) continue; // tipik kamera oranları (4:3 – 16:9 ve geniş)
                        if ((rw * rh) / frameArea > 0.4) continue;  // overlay tüm ekran olamaz

                        // Yüz, kenarlara yapışık olmadan içinde olmalı
                        if (face.x < left.pos + s * 0.3 || face.x > right.pos - s * 0.3) continue;
                        if (face.y < top.pos + s * 0.3 || face.y > bottom.pos - s * 0.3) continue;

                        // Dört kenarın çevre skorları. Katı min-kenar yerine
                        // yumuşak kural: en az 3 kenar güçlü, 4. kenar zayıf ama
                        // mevcut olmalı (koyu arka plana karışan kenarlar için —
                        // ör. karanlık odada kameranın alt sınırı).
                        const sTop = top.frameEdge ? FRAME_EDGE_SCORE : rowScore3(top.pos, left.pos, right.pos);
                        const sBottom = bottom.frameEdge ? FRAME_EDGE_SCORE : rowScore3(bottom.pos, left.pos, right.pos);
                        const sLeft = left.frameEdge ? FRAME_EDGE_SCORE : colScore3(left.pos, top.pos, bottom.pos);
                        const sRight = right.frameEdge ? FRAME_EDGE_SCORE : colScore3(right.pos, top.pos, bottom.pos);
                        const sorted = [sTop, sBottom, sLeft, sRight].sort((a, b) => b - a);
                        if (sorted[2] < 0.38 || sorted[3] < 0.12) continue;
                        const rectScore = sorted[2] * 0.7 + sorted[3] * 0.3;

                        // Eşit güçteki adaylar arasında BÜYÜK dikdörtgeni tercih et
                        // (overlay'in tamamı, yüze yapışık iç dikdörtgen değil).
                        // Bonus ölçülü — aksi halde overlay dışına taşan dev
                        // dikdörtgenler kazanır.
                        const totalScore = rectScore + ((rw * rh) / frameArea) * 0.3;

                        if (!best || totalScore > best.totalScore) {
                            best = { x0: left.pos, y0: top.pos, x1: right.pos, y1: bottom.pos, totalScore, rectScore };
                        }
                    }
                }
            }
        }

        return best ? { x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1 } : null;
    }

    /**
     * Tam çözünürlükte kamera çerçeve/border bandını piksel-temelli kırp.
     *
     * Yaklaşık dikdörtgenin biraz genişletilmiş bölgesi native çözünürlükte
     * örneklenir; kalıcı kenar haritası çıkarılır (statik çerçeve = kalıcı,
     * içindeki hareket eden yayıncı = değişken). Her kenardan içeri doğru,
     * çerçeve bandının yoğun kalıcı-kenar satır/sütunları bitene kadar taranır.
     * Böylece 640px tespitinin ±scale belirsizliği tam çözünürlükte giderilir.
     *
     * @returns {{x,y,w,h}|null}
     */
    async _trimBorderFullRes(videoPath, meta, approx) {
        // Bölgeyi kenarları görebilmek için biraz genişlet
        const pad = Math.max(6, Math.round(Math.max(approx.w, approx.h) * 0.06));
        const rx = Math.max(0, approx.x - pad);
        const ry = Math.max(0, approx.y - pad);
        const rw = Math.min(meta.width - rx, approx.w + pad * 2);
        const rh = Math.min(meta.height - ry, approx.h + pad * 2);
        if (rw < 20 || rh < 20) return null;

        // Bölgeyi native çözünürlükte, gri tonlamalı, birkaç kare örnekle
        const count = 8;
        const fps = Math.max(0.1, count / Math.max(meta.duration, 1));
        const raw = await new Promise((resolve, reject) => {
            const chunks = [];
            const proc = spawn('ffmpeg', [
                '-loglevel', 'error',
                '-i', videoPath,
                '-vf', `fps=${fps.toFixed(4)},crop=${rw}:${rh}:${rx}:${ry},format=gray`,
                '-frames:v', String(count),
                '-f', 'rawvideo', 'pipe:1',
            ]);
            proc.stdout.on('data', c => chunks.push(c));
            let stderr = '';
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', reject);
            proc.on('exit', code => code === 0
                ? resolve(Buffer.concat(chunks))
                : reject(new Error(`bölge kare çıkarma: ${stderr.slice(0, 120)}`)));
        });

        const frameSize = rw * rh;
        const frameCount = Math.floor(raw.length / frameSize);
        if (frameCount < 2) return null;

        // Bölge kalıcı-kenar haritası (gradyan, karelerin >%70'i)
        const count16 = new Uint16Array(frameSize);
        for (let f = 0; f < frameCount; f++) {
            const base = f * frameSize;
            for (let y = 1; y < rh - 1; y++) {
                const row = y * rw;
                for (let x = 1; x < rw - 1; x++) {
                    const i = row + x;
                    const gx = Math.abs(raw[base + i + 1] - raw[base + i - 1]);
                    const gy = Math.abs(raw[base + i + rw] - raw[base + i - rw]);
                    if (gx + gy > GRADIENT_THRESHOLD) count16[i]++;
                }
            }
        }
        const need = Math.ceil(frameCount * 0.7);
        const persist = new Uint8Array(frameSize);
        for (let i = 0; i < frameSize; i++) persist[i] = count16[i] >= need ? 1 : 0;

        // Yaklaşık dikdörtgenin bölge-yerel sınırları
        let lx = approx.x - rx;
        let ty = approx.y - ry;
        let rxi = approx.x + approx.w - rx;
        let byi = approx.y + approx.h - ry;

        const rowDensity = (y, x0, x1) => {
            if (y < 1 || y >= rh - 1) return 0;
            let hits = 0; const row = y * rw;
            const a = Math.max(1, x0), b = Math.min(rw - 1, x1);
            for (let x = a; x < b; x++) hits += persist[row + x];
            return hits / Math.max(1, b - a);
        };
        const colDensity = (x, y0, y1) => {
            if (x < 1 || x >= rw - 1) return 0;
            let hits = 0;
            const a = Math.max(1, y0), b = Math.min(rh - 1, y1);
            for (let y = a; y < b; y++) hits += persist[y * rw + x];
            return hits / Math.max(1, b - a);
        };

        // Çerçeve bandını kenardan içeri tarayarak geç.
        const BORDER_DENSITY = 0.35;
        const SAFETY = 3; // border bandının iç kenarından bu kadar px daha içeri
        const maxBandY = Math.max(4, Math.round(approx.h * 0.14));
        const maxBandX = Math.max(4, Math.round(approx.w * 0.14));

        // Kenardan `pad` kadar dışarıdan başlayıp `maxBand` kadar içeriye tarar;
        // penceredeki EN İÇ yoğun (border) çizgiyi bulur ve ondan SAFETY px içeri
        // geçer. Asla approx kenarından maxBand'den fazla içeri kaçmaz; border
        // bulunamazsa yalnızca küçük güvenlik payı uygular.
        const findEdge = (start, dir, maxBand, densityFn, a, b) => {
            let innermostHigh = null;
            for (let k = 0; k <= pad + maxBand; k++) {
                const p = start - dir * pad + dir * k; // dıştan içe
                if (p < 1 || p >= (densityFn === rowDensity ? rh - 1 : rw - 1)) continue;
                if (densityFn(p, a, b) >= BORDER_DENSITY) innermostHigh = p;
            }
            let edge = innermostHigh !== null ? innermostHigh + dir * SAFETY : start + dir * SAFETY;
            const cap = start + dir * maxBand; // aşırı içeri kaçmayı engelle
            if (dir > 0 ? edge > cap : edge < cap) edge = cap;
            return edge;
        };

        ty = findEdge(ty, +1, maxBandY, rowDensity, lx, rxi);
        byi = findEdge(byi, -1, maxBandY, rowDensity, lx, rxi);
        lx = findEdge(lx, +1, maxBandX, colDensity, ty, byi);
        rxi = findEdge(rxi, -1, maxBandX, colDensity, ty, byi);

        if (rxi - lx < 20 || byi - ty < 20) return null;

        // Bölge-yerelden tam kare koordinatlarına geri çevir
        return {
            x: rx + lx,
            y: ry + ty,
            w: rxi - lx,
            h: byi - ty,
        };
    }

    /**
     * Gemini görüntü analizi ile webcam VAR MI + kaba konum tespiti.
     * Gemini "webcam var mı / IRL mi" ve hangi köşede sorusunda çok güvenilir;
     * ama tam sınırları abartabilir — bu yüzden sadece KAPI + REHBER olarak
     * kullanılır, piksel hassasiyeti kenar-tespitinden gelir.
     * @returns {{hasWebcam:boolean, box?:{x,y,w,h}}|null}
     */
    async _geminiDetect(videoPath, meta) {
        const VisionLLM = require('./VisionLLM');
        if (!VisionLLM.isAvailable()) return null;
        const fs = require('fs');
        const dur = meta.duration || 10;
        // İki kare: klibin 1/3 ve 2/3'ü (webcam bir anda kapalı/belirsiz olabilir)
        const stamps = [Math.max(1, dur * 0.33), Math.max(2, dur * 0.66)];
        const tmps = stamps.map((_, i) => path.join(require('os').tmpdir(), `fd_${process.pid}_${i}_${meta.width}.jpg`));
        try {
            const imgs = [];
            for (let i = 0; i < stamps.length; i++) {
                await new Promise((resolve) => {
                    execFile('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(stamps[i]), '-i', videoPath,
                        '-frames:v', '1', '-vf', 'scale=1280:-1', tmps[i]], () => resolve());
                });
                if (fs.existsSync(tmps[i])) imgs.push(fs.readFileSync(tmps[i]).toString('base64'));
            }
            if (imgs.length === 0) return null;

            const prompt = [
                'Aynı Kick yayınından İKİ kare veriyorum. Yayıncının WEBCAM OVERLAY\'ini bul.',
                '',
                'WEBCAM OVERLAY NEDİR: Yayın yazılımının (OBS) ekran görüntüsünün ÜSTÜNE bindirdiği,',
                'yayıncının KENDİ kamerasının küçük dikdörtgen görüntüsü. Genelde bir köşede durur ve',
                'ekranın içeriğinden BAĞIMSIZ bir katmandır.',
                '',
                '⚠️ EN SIK YAPILAN HATA — BUNU YAPMA:',
                'Yayıncının ekranında bir video/site açık olabilir (Instagram reel, YouTube, TikTok, film).',
                'O videonun İÇİNDEKİ insan WEBCAM DEĞİLDİR — o, yayıncının İZLEDİĞİ içeriktir.',
                'Ekranda oynayan videodaki yüz büyük ve net olsa bile onu SEÇME.',
                'Webcam, o videoyu izleyen KİŞİDİR ve genelde daha küçük, köşededir.',
                '',
                'Ayrıca webcam DEĞİL: oyun karakteri yüzü, arayüz/skorboard portreleri, avatar,',
                'profil fotoğrafı, yorum bölümündeki avatarlar, tarayıcı sekmesi ikonu.',
                '',
                'hasWebcam=false ver EĞER: overlay yok ve tüm ekran zaten kamera görüntüsüyse (IRL yayın),',
                'veya ekranda yayıncının kendi kamerası hiç görünmüyorsa.',
                '',
                'Kutu [ymin,xmin,ymax,xmax], 0-1000 normalize. reason alanına neden o kutuyu seçtiğini',
                've varsa ekrandaki videoyu neden elediğini tek cümleyle yaz.',
                'SADECE JSON: {"hasWebcam":true/false,"box":[ymin,xmin,ymax,xmax],"reason":"..."}',
            ].join('\n');

            const d = await VisionLLM.generateJson({
                prompt,
                images: imgs.map((b, i) => ({ data: b, label: `Kare ${i + 1}:` })),
                maxOutput: 400,
                timeout: 45000,
                geminiModel: process.env.GEMINI_QC_MODEL || process.env.GEMINI_MODEL,
                schema: {
                    name: 'webcam_detection',
                    schema: {
                        type: 'object',
                        properties: {
                            hasWebcam: { type: 'boolean' },
                            box: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
                            reason: { type: 'string' },
                        },
                        required: ['hasWebcam', 'box', 'reason'],
                        additionalProperties: false,
                    },
                },
            });
            if (d?.reason) console.log(`[FacecamDetector] LLM: ${d.hasWebcam ? 'webcam VAR' : 'webcam YOK'} — ${String(d.reason).slice(0, 120)}`);
            if (!d.hasWebcam) return { hasWebcam: false };
            if (!Array.isArray(d.box) || d.box.length !== 4) return { hasWebcam: true };
            const [ymin, xmin, ymax, xmax] = d.box.map(Number);
            return {
                hasWebcam: true,
                box: {
                    x: Math.max(0, Math.round(xmin / 1000 * meta.width)),
                    y: Math.max(0, Math.round(ymin / 1000 * meta.height)),
                    w: Math.round((xmax - xmin) / 1000 * meta.width),
                    h: Math.round((ymax - ymin) / 1000 * meta.height),
                },
            };
        } catch (err) {
            console.error('[FacecamDetector] LLM tespit hatası:', err.response?.status || err.message);
            return null;
        } finally {
            tmps.forEach(t => { try { fs.unlinkSync(t); } catch { /* ignore */ } });
        }
    }

    /**
     * Gemini'ye ODAKLI bölge kırpıp webcam'in TAM kutusunu sordur.
     * Tüm karede Gemini bazen webcam'i konumlandıramıyor (özellikle ekran-
     * paylaşımı); yüzün olduğu köşe yarısı kırpılıp sorulunca çok daha net
     * kutu veriyor. Sonuç tam-kare koordinatlarına geri çevrilir.
     * @param {object} faceFullRes - {x,y} tam çözünürlükte yüz merkezi
     * @returns {{x,y,w,h}|null}
     */
    async _geminiBoxInRegion(videoPath, meta, faceFullRes) {
        const VisionLLM = require('./VisionLLM');
        if (!VisionLLM.isAvailable()) return null;
        const fs = require('fs');
        // Pico yüzüne MERKEZLENMİŞ bölge kırp — webcam kırpmanın merkezinde
        // olur, etraftaki dashboard azalır, Gemini webcam'i net boxlar.
        const regW = Math.round(meta.width * 0.42 / 2) * 2;
        const regH = Math.round(meta.height * 0.5 / 2) * 2;
        let rx = Math.round(faceFullRes.x - regW / 2);
        let ry = Math.round(faceFullRes.y - regH * 0.42); // yüz kırpmanın üst-orta kısmında
        rx = Math.max(0, Math.min(rx, meta.width - regW));
        ry = Math.max(0, Math.min(ry, meta.height - regH));
        const halfW = regW, halfH = regH;

        const prompt = [
            'Bu görüntüde bir yayıncı WEBCAM overlay\'i (yayıncının kendi kamerasının küçük',
            'dikdörtgen görüntüsü) var. Webcam kamera karesinin TAM ve DAR sınırlayıcı kutusunu ver.',
            '',
            '⚠️ Ekranda açık olan bir video/site (Instagram, YouTube, TikTok) içindeki insanı SEÇME —',
            'o, yayıncının izlediği içeriktir, webcam değildir. Webcam, o içeriği izleyen kişidir.',
            '',
            'Kutu SADECE kamera görüntüsünü içersin — etrafındaki ekran/dashboard/sohbet DEĞİL.',
            'Kenarlar kamera görüntüsünün bittiği yere TAM otursun; boşluk bırakma.',
            'Kutu [ymin,xmin,ymax,xmax], bu görüntüye göre 0-1000 normalize.',
            'SADECE JSON: {"box":[ymin,xmin,ymax,xmax]}',
        ].join('\n');

        // Tek kare tek örnek yanıltıcı olabiliyor (kişi eğilir, kutu bir yana
        // kayar) — iki farklı kare paralel sorulur, kutular birleştirilir.
        const dur = meta.duration || 10;
        const askAt = async (ts, idx) => {
            const tmp = path.join(require('os').tmpdir(), `fdr_${process.pid}_${idx}.jpg`);
            try {
                await new Promise((resolve, reject) => {
                    execFile('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(ts), '-i', videoPath,
                        '-frames:v', '1', '-vf', `crop=${halfW}:${halfH}:${rx}:${ry},scale=1024:-1`, tmp],
                        (e) => e ? reject(e) : resolve());
                });
                const b64 = fs.readFileSync(tmp).toString('base64');
                const d = await VisionLLM.generateJson({
                    prompt,
                    images: [{ data: b64 }],
                    maxOutput: 150,
                    timeout: 45000,
                    geminiModel: process.env.GEMINI_QC_MODEL || process.env.GEMINI_MODEL,
                });
                if (!Array.isArray(d.box) || d.box.length !== 4) return null;
                const [ymin, xmin, ymax, xmax] = d.box.map(Number);
                if (!(xmax > xmin && ymax > ymin)) return null;
                // Kırpılmış bölge koordinatından tam-kareye çevir
                return {
                    x: rx + Math.round(xmin / 1000 * halfW),
                    y: ry + Math.round(ymin / 1000 * halfH),
                    w: Math.round((xmax - xmin) / 1000 * halfW),
                    h: Math.round((ymax - ymin) / 1000 * halfH),
                };
            } catch (err) {
                console.error('[FacecamDetector] LLM bölge kutu hatası:', err.response?.status || err.message);
                return null;
            } finally {
                try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
        };

        const ts1 = Math.max(1, Math.min(dur / 3, 20));
        const ts2 = Math.max(1, Math.min(dur * 2 / 3, 40));
        const boxes = (await Promise.all([askAt(ts1, 0), askAt(ts2, 1)])).filter(Boolean);
        if (boxes.length === 0) return null;
        if (boxes.length === 1) return boxes[0];

        // İki kutu makul ölçüde örtüşüyorsa koordinat ortalaması al;
        // örtüşmüyorsa yüz merkezine yakın olanı kullan
        const [a, b] = boxes;
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const iou = (ix * iy) / (a.w * a.h + b.w * b.h - ix * iy || 1);
        if (iou >= 0.4) {
            return {
                x: Math.round((a.x + b.x) / 2),
                y: Math.round((a.y + b.y) / 2),
                w: Math.round((a.w + b.w) / 2),
                h: Math.round((a.h + b.h) / 2),
            };
        }
        const distTo = (r) => Math.hypot(r.x + r.w / 2 - faceFullRes.x, r.y + r.h / 2 - faceFullRes.y);
        return distTo(a) <= distTo(b) ? a : b;
    }

    /**
     * Gemini bölge kutusunun kenarlarını kalıcı-kenar haritasındaki en güçlü
     * çizgilere oturt (snap). Gemini kutuları yaklaşıktır — özellikle çerçevesiz
     * webcam'lerde bir kenarda fazla boşluk bırakabiliyor. Çerçevesiz webcam'de
     * bile webcam görüntüsü ile ekran içeriği arasındaki sınır kalıcı bir
     * gradyan çizgisi üretir; her kenar dar bir bantta (±%10) aranır, güçlü
     * çizgi bulunursa kenar oraya çekilir, bulunamazsa Gemini kenarı korunur.
     * @param {object} box - tam çözünürlükte {x,y,w,h}
     * @returns {{x,y,w,h}} düzeltilmiş kutu (tam çözünürlük)
     */
    _snapBoxToEdges(persistent, w, h, box, meta) {
        const sd = w / meta.width; // tam çözünürlük → tespit çözünürlüğü
        let x0 = box.x * sd, y0 = box.y * sd;
        let x1 = (box.x + box.w) * sd, y1 = (box.y + box.h) * sd;

        const rowSeg = (y, a, b) => {
            if (y < 1 || y >= h - 1 || b <= a) return 0;
            let sum = 0;
            const row = y * w;
            const a0 = Math.max(1, Math.round(a)), b0 = Math.min(w - 1, Math.round(b));
            for (let x = a0; x < b0; x++) sum += persistent[row + x];
            return sum / Math.max(1, b0 - a0);
        };
        const colSeg = (x, a, b) => {
            if (x < 1 || x >= w - 1 || b <= a) return 0;
            let sum = 0;
            const a0 = Math.max(1, Math.round(a)), b0 = Math.min(h - 1, Math.round(b));
            for (let y = a0; y < b0; y++) sum += persistent[y * w + x];
            return sum / Math.max(1, b0 - a0);
        };
        // Kenar 1-2px kayabilir — komşu çizgilerle birlikte en iyisi
        const rowScore3 = (y, a, b) => Math.max(rowSeg(y - 1, a, b), rowSeg(y, a, b), rowSeg(y + 1, a, b));
        const colScore3 = (x, a, b) => Math.max(colSeg(x - 1, a, b), colSeg(x, a, b), colSeg(x + 1, a, b));

        const SNAP_MIN = 0.35; // bu skorun altındaki çizgilere oturtma yapılmaz
        const findLine = (from, to, limit, fn) => {
            let best = null;
            const p0 = Math.max(1, Math.round(from)), p1 = Math.min(limit - 2, Math.round(to));
            for (let p = p0; p <= p1; p++) {
                const sc = fn(p);
                if (sc >= SNAP_MIN && (!best || sc > best.score)) best = { pos: p, score: sc };
            }
            return best;
        };

        const bandX = Math.max(4, (x1 - x0) * 0.10);
        const bandY = Math.max(4, (y1 - y0) * 0.10);
        // Köşe/çerçeve gürültüsünden kaçınmak için segment içeriden puanlanır
        const inX = (x1 - x0) * 0.12, inY = (y1 - y0) * 0.12;

        const top = findLine(y0 - bandY, y0 + bandY, h, y => rowScore3(y, x0 + inX, x1 - inX));
        const bottom = findLine(y1 - bandY, y1 + bandY, h, y => rowScore3(y, x0 + inX, x1 - inX));
        const left = findLine(x0 - bandX, x0 + bandX, w, x => colScore3(x, y0 + inY, y1 - inY));
        const right = findLine(x1 - bandX, x1 + bandX, w, x => colScore3(x, y0 + inY, y1 - inY));

        const nx0 = left ? left.pos : x0;
        const nx1 = right ? right.pos : x1;
        const ny0 = top ? top.pos : y0;
        const ny1 = bottom ? bottom.pos : y1;
        if (nx1 - nx0 < 4 || ny1 - ny0 < 4) return box; // dejenere — dokunma

        const snapped = ['left', 'right', 'top', 'bottom'].filter((_, i) => [left, right, top, bottom][i]);
        if (snapped.length > 0) {
            console.log(`[FacecamDetector] LLM kutusu kenara oturtuldu: ${snapped.join(',')}`);
        }
        return {
            x: Math.round(nx0 / sd),
            y: Math.round(ny0 / sd),
            w: Math.round((nx1 - nx0) / sd),
            h: Math.round((ny1 - ny0) / sd),
        };
    }

    /**
     * Kutunun içindeki en kararlı pico yüz kümesini tam-çözünürlük koordinatıyla
     * döndür. Kompozisyonun webcam'deki KİŞİYİ ortalayabilmesi için gerçek yüz
     * konumu gerekir — kutu merkezi kişi yana oturduğunda yanıltıcıdır.
     * @param {Array} clusters - tespit çözünürlüğünde yüz kümeleri
     * @param {number} scale - tespit → tam çözünürlük çarpanı
     * @param {object} box - tam çözünürlükte {x,y,w,h}
     * @returns {{x,y,s}|null}
     */
    _bestFaceInBox(clusters, scale, box) {
        const inside = clusters.filter(c => {
            const x = c.x * scale, y = c.y * scale;
            return x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h;
        });
        if (inside.length === 0) return null;
        inside.sort((a, b) => (b.frameHits + b.anchorQ / 20) - (a.frameHits + a.anchorQ / 20));
        const c = inside[0];
        if (c.frameHits < 2) return null;
        return { x: c.x * scale, y: c.y * scale, s: c.s * scale };
    }

    /**
     * Facecam bölgesini tespit et — Gemini kapı/rehber + pico/kenar hassasiyeti
     * @returns {{found, fullCam, rect: {x,y,w,h}|null, meta, method}}
     */
    async detect(videoPath) {
        const meta = await this.probe(videoPath);

        // --- Gemini kapı: webcam var mı? (IRL/oyun-portre yanılmalarını önler)
        let geminiBox = null;
        let geminiWebcamConfirmed = false;
        const g = await this._geminiDetect(videoPath, meta).catch(() => null);
        if (g) {
            if (!g.hasWebcam) {
                // Webcam yok → tek parça 9:16 (Gemini IRL/webcam'siz kliplerde güvenilir)
                return { found: true, fullCam: true, rect: null, meta, method: 'gemini-single', face: undefined };
            }
            geminiWebcamConfirmed = true;
            geminiBox = g.box || null;
            // Ekran-paylaşımı kliplerinde (dashboard/tarayıcı üstünde küçük webcam)
            // Gemini bazen TÜM kareyi webcam sanıyor — bu çöp kutu pico'yu yanıltır.
            // Kutu karenin çoğunu kaplıyorsa yok say; pico/kenar tespiti gerçek
            // küçük webcam'i (yüz tespitiyle) bulur.
            if (geminiBox) {
                const areaFrac = (geminiBox.w * geminiBox.h) / (meta.width * meta.height);
                if (areaFrac > 0.5 || (geminiBox.w > meta.width * 0.88 && geminiBox.h > meta.height * 0.88)) {
                    console.log(`[FacecamDetector] Gemini kutusu çok geniş (${Math.round(areaFrac * 100)}%) — yok sayılıyor, pico/kenar kullanılacak`);
                    geminiBox = null;
                }
            }
        }

        const { frames, w, h } = await this._extractGrayFrames(
            videoPath, meta.width, meta.height, meta.duration
        );

        if (frames.length === 0) {
            return { found: false, fullCam: false, rect: null, meta, method: null };
        }

        // Gemini kutusunu tespit çözünürlüğüne çevir (rehber olarak)
        const scaleDown = w / meta.width;
        const gBoxDet = geminiBox ? {
            cx: (geminiBox.x + geminiBox.w / 2) * scaleDown,
            cy: (geminiBox.y + geminiBox.h / 2) * scaleDown,
            x0: geminiBox.x * scaleDown, y0: geminiBox.y * scaleDown,
            x1: (geminiBox.x + geminiBox.w) * scaleDown, y1: (geminiBox.y + geminiBox.h) * scaleDown,
        } : null;

        // --- Yüz çapası: tüm karelerdeki tespitleri topla
        const allDets = [];
        for (const frame of frames) {
            allDets.push(this._detectFacesInFrame(frame, w, h));
        }

        const flat = allDets.flatMap((dets, fi) => dets.map(d => ({ y: d[0], x: d[1], s: d[2], q: d[3], frame: fi })));
        if (flat.length === 0) {
            return { found: false, fullCam: false, rect: null, meta, method: null };
        }

        const median = arr => {
            const sorted = [...arr].sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length / 2)];
        };

        // --- Yüz tespitlerini konum kümelerine ayır (birden çok aday olabilir:
        // gerçek webcam + oyun UI'sındaki karakter portreleri gibi)
        const clusters = [];
        for (const det of flat) {
            let placed = false;
            for (const c of clusters) {
                const radius = Math.max(c.anchorS * 0.9, 14);
                if (Math.abs(det.x - c.cx) < radius && Math.abs(det.y - c.cy) < radius) {
                    c.members.push(det);
                    if (det.q > c.anchorQ) { c.anchorQ = det.q; c.anchorS = det.s; }
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                clusters.push({ cx: det.x, cy: det.y, members: [det], anchorQ: det.q, anchorS: det.s });
            }
        }
        for (const c of clusters) {
            c.frameHits = new Set(c.members.map(m => m.frame)).size;
            c.x = median(c.members.map(m => m.x));
            c.y = median(c.members.map(m => m.y));
            c.s = Math.max(median(c.members.map(m => m.s)), c.anchorS);
        }

        const scale = meta.width / w;
        const even = v => Math.round(v / 2) * 2;
        const clampRect = (r) => {
            const x = Math.max(0, Math.min(even(r.x), meta.width - 2));
            const y = Math.max(0, Math.min(even(r.y), meta.height - 2));
            return {
                x, y,
                w: Math.max(2, Math.min(even(r.w), meta.width - x)),
                h: Math.max(2, Math.min(even(r.h), meta.height - y)),
            };
        };

        // Tam kamera (IRL) kontrolü: kararlı ve çok büyük bir yüz varsa bölme yapma
        const prominent = clusters
            .filter(c => c.frameHits >= frames.length * MIN_FRAME_HITS)
            .sort((a, b) => b.s - a.s)[0];
        if (prominent && prominent.s * scale > meta.height * 0.42) {
            return {
                found: true, fullCam: true, rect: null, meta, method: null,
                face: { x: prominent.x * scale, y: prominent.y * scale, s: prominent.s * scale },
            };
        }

        // Kenar kalıcılık haritası — hem gemini-region kutusunun kenara
        // oturtulması (snap) hem de kenar-tespiti yolu için kullanılır
        const persistent = this._buildEdgePersistenceMap(frames, w, h);

        // --- BİRİNCİL: Gemini webcam onayladıysa, pico yüzünün olduğu köşeyi
        // kırpıp Gemini'ye TAM webcam kutusunu sordur (gemini-region). Bu yöntem
        // hem oyun hem ekran-paylaşımı/tarayıcı kliplerinde güvenilir ve tam kutu
        // veriyor — kenar-tespitinin "kafa dikdörtgeni yakalama" sorununu çözer.
        // Kutu, kalıcı-kenar haritasındaki gerçek sınır çizgilerine oturtulur
        // (çerçevesiz webcam'lerde Gemini'nin bıraktığı yan boşlukları temizler).
        if (geminiWebcamConfirmed) {
            // Kırpma merkezi: Gemini kutusu GEÇERLİYSE onun merkezi (doğru köşe;
            // "en çok karede görünen" pico yüzü Valorant'ta statik oyun portresi
            // olabiliyor). Kutu çöp/yoksa pico'nun en kararlı yüzü.
            let faceFR = null;
            if (geminiBox) {
                faceFR = { x: geminiBox.x + geminiBox.w / 2, y: geminiBox.y + geminiBox.h * 0.4 };
            } else {
                const bestForRegion = clusters.sort((a, b) => b.frameHits - a.frameHits)[0];
                if (bestForRegion && bestForRegion.frameHits >= 2) {
                    faceFR = { x: bestForRegion.x * scale, y: bestForRegion.y * scale };
                }
            }
            if (faceFR) {
                const raw = await this._geminiBoxInRegion(videoPath, meta, faceFR).catch(() => null);
                if (raw && raw.w > meta.width * 0.06 && raw.h > meta.height * 0.06
                    && raw.w < meta.width * 0.75 && raw.h < meta.height * 0.8) {
                    const box = this._snapBoxToEdges(persistent, w, h, raw, meta);
                    // face = kutudaki GERÇEK yüz (kompozisyon kişiyi ortalar);
                    // pico yüz bulamadıysa kutu merkezi
                    const realFace = this._bestFaceInBox(clusters, scale, box);
                    return {
                        found: true, fullCam: false, meta, method: 'gemini-region',
                        rect: clampRect(box),
                        face: realFace || { x: box.x + box.w / 2, y: box.y + box.h * 0.4, s: box.h * 0.35 },
                    };
                }
            }
        }

        // --- Kenar-tespiti yolu: her aday için ÇERÇEVE dikdörtgeni dene.
        // Gerçek webcam kapalı bir çerçeve oluşturur; statik oyun UI portreleri
        // oluşturmaz — bu, "en çok karede görünen"den daha güvenilir ayraçtır.

        // En umut verici adayları dene (kalite+kararlılığa göre, en fazla 8)
        const ranked = [...clusters]
            .filter(c => c.frameHits >= 2)
            .sort((a, b) => (b.frameHits + b.anchorQ / 20) - (a.frameHits + a.anchorQ / 20))
            .slice(0, 8);
        const pool = ranked.length > 0 ? ranked : clusters;

        // Her aday için çerçeve dikdörtgeni dene ve WEBCAM PROFİLİNE göre puanla.
        // Gerçek webcam: yüz, kutu yüksekliğinin ~%42'si (baş+omuz) + makul boyut.
        // "En büyük alan" değil profil önemli — aksi halde arka plandaki paravan/
        // duvar gibi büyük yapılar webcam sanılıp dev/yanlış kutu seçiliyordu.
        // Bir noktanın Gemini kutusuna yakınlığı (0=uzak, 1=tam içinde)
        const gemProximity = (cx, cy) => {
            if (!gBoxDet) return 0;
            const inside = cx >= gBoxDet.x0 && cx <= gBoxDet.x1 && cy >= gBoxDet.y0 && cy <= gBoxDet.y1;
            if (inside) return 1;
            const dx = Math.max(gBoxDet.x0 - cx, 0, cx - gBoxDet.x1);
            const dy = Math.max(gBoxDet.y0 - cy, 0, cy - gBoxDet.y1);
            const dist = Math.hypot(dx, dy);
            return Math.max(0, 1 - dist / (w * 0.25));
        };

        const framed = [];
        for (const c of pool) {
            const face = { x: c.x, y: c.y, s: c.s };
            const er = this._refineRectFromEdges(persistent, w, h, face);
            if (!er) continue;
            const rw = er.x1 - er.x0;
            const rh = er.y1 - er.y0;
            const faceRatio = c.s / Math.max(1, rh);       // yüz / kutu yüksekliği
            const wFrac = rw / w, hFrac = rh / h;           // kutu / kare oranı
            const prox = gemProximity((er.x0 + er.x1) / 2, (er.y0 + er.y1) / 2);
            // Gemini bu bölgede webcam onayladıysa profil/kenar filtrelerini gevşet
            const geminiConfirmed = prox >= 0.8;

            // Webcam olamayacak dikdörtgenleri ele (Gemini onayladıysa daha toleranslı)
            if (faceRatio < (geminiConfirmed ? 0.18 : 0.24) || faceRatio > 0.78) continue;
            if (wFrac < 0.10 || wFrac > 0.55) continue;
            if (hFrac < 0.10 || hFrac > 0.62) continue;

            // Webcam overlay'leri kare kenarina/kosesine yaslidir (Gemini onayı bunu geçersiz kılar)
            const M = 0.10;
            const nearEdge = (er.x0 / w < M) || ((w - er.x1) / w < M)
                || (er.y0 / h < M) || ((h - er.y1) / h < M);
            if (!nearEdge && !geminiConfirmed) continue;

            const profileScore = 1 - Math.min(1, Math.abs(faceRatio - 0.42) / 0.42);
            framed.push({ face, edgeRect: er, profileScore, frameHits: c.frameHits, prox });
        }

        let face, edgeRect;
        if (framed.length > 0) {
            // Gemini kutusu varsa ona yakınlık birincil; sonra webcam profili
            framed.sort((a, b) =>
                (b.prox * 2 + b.profileScore + 0.04 * b.frameHits) -
                (a.prox * 2 + a.profileScore + 0.04 * a.frameHits));
            face = framed[0].face;
            edgeRect = framed[0].edgeRect;
        } else if (gBoxDet) {
            // Kenar-tespiti aday bulamadı ama Gemini webcam onayladı → Gemini
            // kutusundan çapa üretip kenar keskinleştirmeyi dene; olmazsa
            // Gemini kutusunu doğrudan kullan (tek-parçaya DÜŞME)
            const gFace = { x: gBoxDet.cx, y: gBoxDet.y0 + (gBoxDet.y1 - gBoxDet.y0) * 0.4, s: (gBoxDet.y1 - gBoxDet.y0) * 0.35 };
            const gEr = this._refineRectFromEdges(persistent, w, h, gFace);
            if (gEr) {
                face = gFace;
                edgeRect = gEr;
            } else {
                // Gemini kutusunu doğrudan kullan (küçük içeri pay ile)
                const inX = geminiBox.w * 0.03, inY = geminiBox.h * 0.03;
                const gRealFace = this._bestFaceInBox(clusters, scale, geminiBox);
                return {
                    found: true, fullCam: false, meta, method: 'gemini',
                    rect: clampRect({ x: geminiBox.x + inX, y: geminiBox.y + inY, w: geminiBox.w - inX * 2, h: geminiBox.h - inY * 2 }),
                    face: gRealFace || { x: geminiBox.x + geminiBox.w / 2, y: geminiBox.y + geminiBox.h * 0.4, s: geminiBox.h * 0.35 },
                };
            }
        } else {
            const best = clusters.sort((a, b) => b.frameHits - a.frameHits)[0];
            const stableFace = best && best.frameHits >= Math.max(2, frames.length * MIN_FRAME_HITS);

            // Gemini webcam onayladı ama kenar-tespiti çerçeve bulamadı
            // (ekran-paylaşımı / çerçevesiz webcam) → pico yüzünün olduğu köşeyi
            // kırpıp Gemini'ye TAM webcam kutusunu sordur (odaklı → çok isabetli)
            if (geminiWebcamConfirmed && stableFace) {
                const faceFR = { x: best.x * scale, y: best.y * scale, s: best.s * scale };
                const raw = await this._geminiBoxInRegion(videoPath, meta, faceFR).catch(() => null);
                if (raw && raw.w > meta.width * 0.06 && raw.h > meta.height * 0.06
                    && raw.w < meta.width * 0.7 && raw.h < meta.height * 0.75) {
                    const box = this._snapBoxToEdges(persistent, w, h, raw, meta);
                    const realFace = this._bestFaceInBox(clusters, scale, box);
                    return {
                        found: true, fullCam: false, meta, method: 'gemini-region',
                        rect: clampRect(box),
                        face: realFace || { x: box.x + box.w / 2, y: box.y + box.h * 0.4, s: box.h * 0.35 },
                    };
                }
            }

            // Aksi halde tek parça 9:16
            const dominantFace = stableFace ? { x: best.x * scale, y: best.y * scale, s: best.s * scale } : undefined;
            return {
                found: true, fullCam: true, rect: null, meta, method: 'single',
                face: dominantFace,
            };
        }

        if (edgeRect) {
            // Kaba dikdörtgeni tam çözünürlüğe ölçekle
            const rw0 = (edgeRect.x1 - edgeRect.x0) * scale;
            const rh0 = (edgeRect.y1 - edgeRect.y0) * scale;

            // Çerçeve çizgisini ve 640px→1920px ölçek belirsizliğini gidermek için
            // KÜÇÜK SABİT inset uygula (her kenardan ~%1.5, min 6px). ESKİDEN
            // _trimBorderFullRes her kenardan %14'e kadar kırpıp yüze zoom
            // yapabiliyordu — kaldırıldı; webcam artık TAM alınır, sadece ince
            // border çizgisi temizlenir.
            const insetX = Math.max(6, Math.round(rw0 * 0.015));
            const insetY = Math.max(6, Math.round(rh0 * 0.015));
            const rect = clampRect({
                x: edgeRect.x0 * scale + insetX,
                y: edgeRect.y0 * scale + insetY,
                w: rw0 - insetX * 2,
                h: rh0 - insetY * 2,
            });

            return {
                found: true,
                fullCam: false,
                rect,
                meta,
                method: 'edge',
                face: { x: face.x * scale, y: face.y * scale, s: face.s * scale },
            };
        }

        // Buraya normalde ulaşılmaz (framed varsa edgeRect set edilir; yoksa
        // yukarıda tek-parça dönülür). Güvenlik için tek parçaya düş.
        return { found: true, fullCam: true, rect: null, meta, method: 'single', face: undefined };
    }
}

module.exports = FacecamDetector;
