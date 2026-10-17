/**
 * VerticalComposer — Yatay klibi dikey (1080x1920) formata dönüştürür
 *
 * Facecam bulunduysa: kamera üstte, içerik altta (hareket odaklı kırpma).
 * Facecam yoksa / tam kamera: içerik odak noktasına ortalanmış tek kırpma.
 * Altyazı ASS dosyası varsa videoya gömülür.
 */
const { execFile } = require('./ProcTracker');
const fs = require('fs');
const path = require('path');
const CamFull = require('./CamFull');

const OUT_W = 1080;
const OUT_H = 1920;
// Üst bölüm (webcam) yüksekliği: taban 16:9 (1080x608). Sabit 16:9 zorlanınca
// 4:3/kare webcam'lerde dikeyde %25-44 kırpılıyor, yüz kadrajın sınırlarına
// dayanıyordu. Artık kutunun kendi oranı bir bant içinde korunur: en fazla
// MAX_CAM_V_CROP kadar kırpılır, gerekirse üst bölüm MAX_CAM_H'e kadar uzar.
const MIN_CAM_H = Math.round(OUT_W * 9 / 16 / 2) * 2; // 608 — 16:9 taban
const MAX_CAM_H = 760;          // ~1.42:1 — daha uzun üst bölüm içeriği ezer
const MAX_CAM_V_CROP = 0.18;    // webcam'den dikeyde izin verilen azami kayıp
// Cover-crop'ta yüzün dikey konumu (0.5 = tam orta). Biraz üstte tutulur:
// baş üstünde nefes payı kalır, altta omuz/gövde görünür.
const FACE_HEADROOM = 0.45;
const LOGO_W = Math.round(OUT_W / 3); // logo genişliği: 1080/3 = 360px
const LOGO_TOP_Y = 60;          // tek parça düzende logonun üstten uzaklığı

class VerticalComposer {
    /**
     * Bölünmüş düzen kullanılsın mı? Stüdyo Ayarları'ndaki kompozisyon
     * tercihi tespit sonucunu ezebilir:
     *  - 'single': facecam bulunsa da tek parça (zorla)
     *  - 'split'/'auto': facecam kutusu tespit edildiyse bölünmüş
     *    (kamera kutusu yokken bölünmüş düzen üretilemez)
     */
    static isSplit(facecam, composition = 'auto') {
        if (composition === 'single') return false;
        return !!(facecam.found && !facecam.fullCam && facecam.rect);
    }

    /**
     * @param {object} job
     *   - inputPath: kaynak mp4
     *   - outputPath: hedef mp4
     *   - facecam: FacecamDetector.detect() sonucu
     *   - focus: SmartCropper.findFocus() sonucu
     *   - faceTrack: FacecamDetector.trackFace() sonucu (opsiyonel) — tek parça
     *     düzende kişinin yüzünü zamanla takip eden akıcı kamera kaydırması
     *   - assPath: altyazı dosyası (opsiyonel)
     *   - logoPath: logo görseli (opsiyonel) — bölünmüş düzende facecam/içerik
     *     birleşim çizgisine dikey ortalanır, tek parçada üst-ortaya konur
     *   - composition: 'auto'|'split'|'single' (Stüdyo Ayarları)
     *   - logoPosition: 'seam'|'top-center'|'custom' — logonun dikey konumu
     *     ('custom' → logoX/logoY serbest yüzde koordinatları kullanılır)
     *   - logoScale: 0.5-2.0 — logo genişlik çarpanı
     *   - logoOpacity: 0.05-1 — logo saydamlığı
     *   - logoX/logoY: 0-1 — 'custom' modda logo MERKEZ noktasının video
     *     genişliğine/yüksekliğine oranı (VOD editör popup'ının sürükle-bırak
     *     UI'sıyla aynı referans noktası)
     *   - camFullRanges: [{start,end}] klip saniyesi — bu anlarda webcam kutusu
     *     kadrajı tamamen doldurur ("tam ekran bölgesi"). Webcam kutusu
     *     tespit edilmemişse sessizce yok sayılır.
     */
    async compose({ inputPath, outputPath, facecam, focus, faceTrack = null, assPath, logoPath,
        composition = 'auto', logoPosition = 'seam', logoScale = 1, logoOpacity = 1, logoX = null, logoY = null,
        camFullRanges = [], contentRect = null }) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const meta = facecam.meta;
        const even = v => Math.max(2, Math.round(v / 2) * 2);

        let filterGraph;
        let subtitleMarginV;
        let seamY = null; // bölünmüş düzende facecam-içerik birleşim çizgisi

        // Tam ekran bölgeleri: ana görüntü [stacked0] olarak biter, üstüne
        // tam kadraj webcam bindirilip [stacked] elde edilir.
        const camFull = VerticalComposer.camFullPlan(facecam, camFullRanges, even);
        const stackedLabel = camFull ? 'stacked0' : 'stacked';

        if (VerticalComposer.isSplit(facecam, composition)) {
            // === Bölünmüş düzen: facecam üstte, içerik altta ===
            // Tespit kutusunu her kenardan minik payla içe kırp — sınır
            // çizgisi/dış kalıntı üstte ince boşluk bırakmasın.
            // Elle çizilen kutu olduğu gibi kullanılır; tespit kutusu içe kırpılır.
            const cam = facecam.method === 'manual' ? facecam.rect : this._insetRect(facecam.rect, 0.01, meta, even);

            // Kişi-merkezli pencere + camH — computeLayout ile AYNI hesap
            // (altyazı hizası kaymasın diye tek yardımcıda)
            const { camView, camFace, camH } = this._camLayout(facecam, cam, even);
            const contentH = OUT_H - camH;

            // İçerik kırpması: kullanıcı "yayın alanı" çizdiyse o bölge hedef
            // orana "cover" sığdırılır; yoksa kaynak tam yükseklik, ORTALI.
            // (Eskiden odak noktasına hizalanıp facecam'den kaçınılıyordu; sonuçta
            // yayın ekranı SOLA DAYALI çıkıyordu. Yayıncı ekranın ortasını ister.)
            const { cropW, cropH, cropX, cropY } = VerticalComposer.contentCrop(meta, contentH, contentRect, even);

            // Altyazı iki bölümün birleşim yerinin biraz altında dursun
            seamY = camH;
            subtitleMarginV = OUT_H - camH - 140;

            // Facecam'i EN-BOY ORANINI KORUYARAK 1080xcamH kutusuna yerleştir
            // ("cover": oran bozulmadan kutu dolar, fazlalık kırpılır).
            // DİKKAT: setsar=1 olmadan çıktı oynatıcılarda basık görünür.
            const { scaledW, scaledH, camCropX, camCropY } =
                this._camCrop(camView, camFace, camH, even);
            filterGraph =
                `[0:v]split=${camFull ? 3 : 2}[camsrc][mainsrc]${camFull ? '[cfsrc]' : ''};` +
                `[camsrc]crop=${camView.w}:${camView.h}:${camView.x}:${camView.y},scale=${scaledW}:${scaledH}:flags=lanczos,crop=${OUT_W}:${camH}:${camCropX}:${camCropY},setsar=1[cam];` +
                `[mainsrc]crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${OUT_W}:${contentH}:flags=lanczos,setsar=1[main];` +
                `[cam][main]vstack=inputs=2[${stackedLabel}]`;
        } else {
            // === Tek parça düzen: odak merkezli 9:16 kırpma ===
            const aspect = OUT_W / OUT_H;
            let cropH = meta.height;
            let cropW = even(cropH * aspect);
            if (cropW > meta.width) {
                cropW = meta.width;
                cropH = even(cropW / aspect);
            }
            const cropX = even(Math.max(0, Math.min(focus.focusX - cropW / 2, meta.width - cropW)));
            const cropY = even(Math.max(0, Math.min(focus.focusY - cropH / 2, meta.height - cropH)));

            subtitleMarginV = 320;

            // Yüz takibi varsa kırpma penceresi zamanla kişinin yüzüne kayar.
            // Yatay boşluk varsa X, dikey boşluk varsa Y zamanla değişir.
            const maxX = meta.width - cropW;
            const maxY = meta.height - cropH;
            let xExpr = String(cropX);
            let yExpr = String(cropY);
            if (faceTrack && faceTrack.keyframes && faceTrack.keyframes.length >= 2) {
                if (maxX > 1) {
                    const ptsX = faceTrack.keyframes.map(k => ({
                        t: k.t,
                        v: Math.round(Math.max(0, Math.min(k.cx - cropW / 2, maxX))),
                    }));
                    xExpr = this._panExpr(ptsX);
                }
                if (maxY > 1) {
                    const ptsY = faceTrack.keyframes.map(k => ({
                        t: k.t,
                        v: Math.round(Math.max(0, Math.min(k.cy - cropH / 2, maxY))),
                    }));
                    yExpr = this._panExpr(ptsY);
                }
            }

            // Tek tırnak: ifade içindeki virgüller filtre ayıracı sanılmaz.
            filterGraph =
                (camFull ? '[0:v]split=2[single][cfsrc];[single]' : '[0:v]') +
                `crop=${cropW}:${cropH}:'${xExpr}':'${yExpr}',scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1[${stackedLabel}]`;
        }

        if (camFull) filterGraph += ';' + camFull.chain;

        let finalLabel = 'stacked';

        // Logo bindirme: bölünmüş düzende yarısı facecam, yarısı içerik
        // üstünde olacak şekilde birleşim çizgisine dikey ortalanır;
        // Stüdyo Ayarları konumu üst-ortaya sabitleyebilir + ölçek çarpanı
        const hasLogo = logoPath && fs.existsSync(logoPath);
        if (hasLogo) {
            const scale = Math.min(2, Math.max(0.1, Number(logoScale) || 1));
            const logoW = even(LOGO_W * scale);
            const opacity = Math.min(1, Math.max(0.05, Number(logoOpacity) || 1));

            let overlayX;
            let overlayY;
            if (logoPosition === 'custom' && logoX !== null && logoY !== null) {
                // Serbest konum: logoX/logoY logonun MERKEZ noktasının video
                // genişliğine/yüksekliğine oranı.
                overlayX = `(main_w*${logoX})-(overlay_w/2)`;
                overlayY = `(main_h*${logoY})-(overlay_h/2)`;
            } else {
                overlayX = '(main_w-overlay_w)/2';
                overlayY = (seamY !== null && logoPosition !== 'top-center')
                    ? `${seamY}-overlay_h/2`   // birleşim çizgisine ortala
                    : String(LOGO_TOP_Y);       // tek parça veya tercih: üst-orta
            }

            // opacity===1 iken colorchannelmixer no-op olsa da her zaman uygulanır
            // (küçük bir ek filtre maliyeti, ölçülebilir performans farkı yaratmaz).
            filterGraph += `;[1:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=${opacity}[logo]` +
                `;[${finalLabel}][logo]overlay=x='${overlayX}':y='${overlayY}'[logod]`;
            finalLabel = 'logod';
        }

        // Altyazı gömme
        if (assPath && fs.existsSync(assPath)) {
            // ffmpeg filter içinde yol kaçışlama (':' ve '\' sorun çıkarır)
            const escapedAss = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
            filterGraph += `;[${finalLabel}]subtitles='${escapedAss}'[subbed]`;
            finalLabel = 'subbed';
        }
        filterGraph += `;[${finalLabel}]format=yuv420p,setsar=1[out]`;

        const inputs = ['-i', inputPath];
        if (hasLogo) inputs.push('-i', logoPath);

        // Adaptif timeout: sabit süre uzun kliplerde meşru encode'u SIGTERM
        // ile kesiyordu — klip süresiyle ölçeklenir (10 dk taban)
        const composeTimeout = Math.max(600000, Math.round((meta.duration || 0) * 10000));

        await this._run('ffmpeg', [
            '-y', '-loglevel', 'error',
            ...inputs,
            '-filter_complex', filterGraph,
            '-map', '[out]',
            '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:a', 'aac', '-b:a', '160k',
            '-movflags', '+faststart',
            outputPath,
        ], composeTimeout);

        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 10000) {
            throw new Error('Kompozisyon çıktısı boş veya bozuk');
        }

        return { outputPath, subtitleMarginV };
    }

    /**
     * "Tam ekran bölgesi" filtre parçası (saf fonksiyon): webcam kutusunu
     * 9:16'ya cover-kırpıp tam kadraja ölçekler, [stacked0] üstüne yalnız
     * verilen aralıklarda bindirir. Webcam kutusu yoksa null.
     * @returns {{chain: string, crop: object, ranges: Array}|null}
     */
    static camFullPlan(facecam, camFullRanges, even = v => Math.max(2, Math.round(v / 2) * 2)) {
        const ranges = CamFull.normalizeCamFullRanges(camFullRanges, { maxDuration: facecam?.meta?.duration || Infinity });
        if (ranges.length === 0 || !facecam?.rect || !facecam?.meta) return null;
        const inset = new VerticalComposer()._insetRect(facecam.rect, 0.01, facecam.meta, even);
        const crop = CamFull.coverCrop(inset, OUT_W, OUT_H, facecam.face || null);
        const chain =
            `[cfsrc]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1[camfull];` +
            `[stacked0][camfull]overlay=enable='${CamFull.enableExpr(ranges)}'[stacked]`;
        return { chain, crop, ranges };
    }

    /**
     * Zamanla değişen kırpma ofseti için ffmpeg ifadesi üretir.
     * Anahtar kareler arası lineer interpolasyon; aralık dışında uçlarda sabit.
     * (Tek tırnak içinde kullanılır, o yüzden virgüller düz.)
     * @param {Array<{t:number, v:number}>} pts - zaman sıralı ofset noktaları
     */
    _panExpr(pts) {
        let expr = `${pts[pts.length - 1].v}`;
        for (let i = pts.length - 2; i >= 0; i--) {
            const t0 = pts[i].t.toFixed(3);
            const t1 = pts[i + 1].t.toFixed(3);
            const v0 = pts[i].v;
            const dt = (pts[i + 1].t - pts[i].t) || 0.001;
            const slope = ((pts[i + 1].v - v0) / dt).toFixed(4);
            expr = `if(lt(t,${t1}),(${v0}+(${slope})*(t-${t0})),${expr})`;
        }
        // İlk anahtar kareden önce ilk değerde sabit tut
        return `if(lt(t,${pts[0].t.toFixed(3)}),${pts[0].v},${expr})`;
    }

    /**
     * Dikdörtgeni her kenardan küçük bir payla İÇE kırp ve kare sınırlarına
     * kıstır. Tespit kutusu kenara-oturtma (snap) sayesinde tam sınır
     * çizgisinde durur; sınır çizgisinin kendisi ve 1-2px dış kalıntı üstte
     * ince boşluk olarak görünüyordu — ESKİ dışa-genişletme (%1) bunu
     * büyütüyordu, içe kırpma temizler. Pay minik tutulur (webcam'den kırpılan
     * 2-3px göze görünmez).
     */
    _insetRect(rect, frac, meta, even) {
        const dx = Math.max(4, rect.w * frac);
        const dy = Math.max(4, rect.h * frac);
        let x = rect.x + dx;
        let y = rect.y + dy;
        let w = rect.w - dx * 2;
        let h = rect.h - dy * 2;
        x = Math.max(0, x);
        y = Math.max(0, y);
        w = Math.min(w, meta.width - x);
        h = Math.min(h, meta.height - y);
        return { x: even(x), y: even(y), w: even(w), h: even(h) };
    }


    /**
     * Altyazı konumu için kompozisyon öncesi hesaplanan margin (ASS üretimi kompozisyondan
     * önce yapıldığından, düzeni önceden hesaplamak için kullanılır).
     * Logo varsa altyazı, logonun içerik tarafındaki yarısının altına itilir.
     */
    async computeLayout(facecam, logoPath = null, { composition = 'auto', logoPosition = 'seam', logoScale = 1 } = {}) {
        // Logo birleşim çizgisindeyse altyazıyı aşağı iter; üst-ortadaysa itmez
        let logoHalfH = 0;
        if (logoPath && fs.existsSync(logoPath) && logoPosition !== 'top-center') {
            const dims = await this._probeImage(logoPath).catch(() => null);
            if (dims && dims.w > 0) {
                const scale = Math.min(2, Math.max(0.1, Number(logoScale) || 1));
                logoHalfH = Math.round((LOGO_W * scale * (dims.h / dims.w)) / 2);
            }
        }

        if (VerticalComposer.isSplit(facecam, composition)) {
            const even = v => Math.max(2, Math.round(v / 2) * 2);
            const cam = this._insetRect(facecam.rect, 0.01, facecam.meta, even);
            const { camH } = this._camLayout(facecam, cam, even);
            return {
                playResX: OUT_W,
                playResY: OUT_H,
                marginV: OUT_H - camH - 140 - logoHalfH,
                split: true,
                camH,
            };
        }
        return { playResX: OUT_W, playResY: OUT_H, marginV: 320, split: false, camH: 0 };
    }

    /**
     * Bölünmüş düzenin alt (içerik) bölümü için kaynak kırpma penceresi.
     * `region` verilirse (manuel "yayın alanı") pencere o bölgenin içinde,
     * hedef orana göre en büyük ve ortalı kutudur; verilmezse tüm kare ortalı.
     * @returns {{cropW:number, cropH:number, cropX:number, cropY:number}}
     */
    static contentCrop(meta, contentH, region = null, even = v => Math.max(2, Math.round(v / 2) * 2)) {
        const contentAspect = OUT_W / contentH;
        const box = region
            ? { x: Math.max(0, region.x), y: Math.max(0, region.y), w: Math.min(region.w, meta.width - region.x), h: Math.min(region.h, meta.height - region.y) }
            : { x: 0, y: 0, w: meta.width, h: meta.height };
        let cropH = box.h;
        let cropW = even(cropH * contentAspect);
        if (cropW > box.w) {
            cropW = even(box.w);
            cropH = even(cropW / contentAspect);
        }
        const cropX = even(Math.max(0, box.x + (box.w - cropW) / 2));
        const cropY = even(Math.max(0, box.y + (box.h - cropH) / 2));
        return { cropW, cropH, cropX, cropY };
    }

    /**
     * Bölünmüş düzenin üst (webcam) bölümü için pencere ve camH.
     *
     * Pencere webcam kutusunun TAMAMIDIR — daraltma yapılmaz. Eskiden yüz kutu
     * merkezinden kaymışsa pencere %62'ye kadar daraltılıyordu; sabit 16:9 üst
     * bölümle birleşince zoom iki kez uygulanıyor ve yüz kadrajın sınırlarına
     * dayanıyordu. Konumlandırma artık tek yerde, cover-crop ofsetinde yapılır.
     *
     * camH kutunun kendi oranından türetilir; dikey kayıp MAX_CAM_V_CROP ile
     * sınırlıdır ve sonuç [MIN_CAM_H, MAX_CAM_H] bandına kıstırılır. compose ve
     * computeLayout aynı sonucu kullanır (altyazı hizası için).
     * @returns {{camView: {x,y,w,h}, camFace: {x,y,s?}|null, camH: number}}
     */
    _camLayout(facecam, cam, even) {
        const camFace = facecam.face
            && facecam.face.x > cam.x && facecam.face.x < cam.x + cam.w
            && facecam.face.y > cam.y && facecam.face.y < cam.y + cam.h
            ? facecam.face : null;
        const camView = cam;

        // Kırpmasız yükseklik: kutu 1080 genişliğe ölçeklenseydi ne olurdu?
        const idealH = OUT_W * (camView.h / camView.w);
        const camH = even(Math.min(MAX_CAM_H, Math.max(MIN_CAM_H, idealH * (1 - MAX_CAM_V_CROP))));
        return { camView, camFace, camH };
    }

    /**
     * Webcam penceresini 1080xcamH kutusuna "cover" yerleştirmek için ölçek ve
     * kırpma ofsetleri. Kırpma merkezi ortası değil YÜZ konumudur; dikeyde yüz
     * FACE_HEADROOM oranına oturur ve yüz kutusunun tamamı kadrajda kalacak
     * şekilde kıstırılır (çene/alın kesilmesin).
     * @returns {{scaledW:number, scaledH:number, camCropX:number, camCropY:number}}
     */
    _camCrop(camView, camFace, camH, even) {
        const evenFloor = v => Math.max(0, 2 * Math.floor(v / 2));
        const camScale = Math.max(OUT_W / camView.w, camH / camView.h);
        const scaledW = Math.max(OUT_W, even(camView.w * camScale));
        const scaledH = Math.max(camH, even(camView.h * camScale));

        const faceSX = camFace ? (camFace.x - camView.x) * camScale : scaledW / 2;
        const faceSY = camFace ? (camFace.y - camView.y) * camScale : scaledH / 2;
        const camCropX = evenFloor(Math.max(0, Math.min(faceSX - OUT_W / 2, scaledW - OUT_W)));

        let cropY = camFace ? faceSY - camH * FACE_HEADROOM : (scaledH - camH) / 2;
        // Yüz sınırları kadraj dışında kalmasın (saç/çene payıyla birlikte)
        const faceHalf = camFace && camFace.s ? camFace.s * camScale * 0.6 : 0;
        if (faceHalf > 0) {
            cropY = Math.min(cropY, faceSY - faceHalf);          // alın içeride
            cropY = Math.max(cropY, faceSY + faceHalf - camH);   // çene içeride
        }
        const camCropY = evenFloor(Math.max(0, Math.min(cropY, scaledH - camH)));
        return { scaledW, scaledH, camCropX, camCropY };
    }

    /**
     * Görsel dosyasının boyutlarını oku
     */
    async _probeImage(imagePath) {
        const out = await this._run('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'json', imagePath,
        ]);
        const s = JSON.parse(out).streams?.[0];
        return s ? { w: s.width, h: s.height } : null;
    }

    /**
     * Üretilen klibi doğrula — boyut, piksel oranı, süre, akışlar.
     * Bir sorun bulunursa iş 'ready' olarak İŞARETLENMEMELİ.
     * @param {string} outputPath
     * @param {number} expectedDuration - kaynak videonun süresi (saniye)
     * @returns {{ok: boolean, issues: string[], info: object}}
     */
    async verifyOutput(outputPath, expectedDuration = 0) {
        const issues = [];

        if (!fs.existsSync(outputPath)) {
            return { ok: false, issues: ['Çıktı dosyası yok'], info: {} };
        }
        const size = fs.statSync(outputPath).size;
        if (size < 50_000) issues.push(`Dosya şüpheli derecede küçük (${Math.round(size / 1024)}KB)`);

        let probe;
        try {
            const out = await this._run('ffprobe', [
                '-v', 'error',
                '-show_entries',
                'stream=index,codec_type,codec_name,width,height,sample_aspect_ratio:format=duration',
                '-of', 'json', outputPath,
            ]);
            probe = JSON.parse(out);
        } catch (err) {
            return { ok: false, issues: [`ffprobe okuyamadı: ${err.message.slice(0, 120)}`], info: {} };
        }

        const video = (probe.streams || []).find(s => s.codec_type === 'video');
        const audio = (probe.streams || []).find(s => s.codec_type === 'audio');
        const duration = parseFloat(probe.format?.duration) || 0;

        if (!video) {
            issues.push('Video akışı yok');
        } else {
            if (video.width !== OUT_W || video.height !== OUT_H) {
                issues.push(`Boyut ${video.width}x${video.height} — ${OUT_W}x${OUT_H} olmalı`);
            }
            // SAR 1:1 olmalı, yoksa oynatıcılar videoyu basık gösterir
            const sar = video.sample_aspect_ratio;
            if (sar && sar !== '1:1' && sar !== 'N/A' && sar !== '0:1') {
                issues.push(`Piksel oranı bozuk (SAR ${sar}) — 1:1 olmalı`);
            }
        }

        if (!audio) issues.push('Ses akışı yok');

        if (expectedDuration > 2 && Math.abs(duration - expectedDuration) > Math.max(2, expectedDuration * 0.1)) {
            issues.push(`Süre uyumsuz: ${duration.toFixed(1)}sn üretildi, ~${expectedDuration.toFixed(1)}sn bekleniyor`);
        }

        return {
            ok: issues.length === 0,
            issues,
            info: {
                width: video?.width,
                height: video?.height,
                sar: video?.sample_aspect_ratio || '1:1',
                duration: Math.round(duration * 10) / 10,
                sizeKB: Math.round(size / 1024),
                hasAudio: !!audio,
            },
        };
    }

    /**
     * Zaten üretilmiş 1080x1920 çıktıyı ("Paylaş" modalındaki kırpma aracı)
     * elle seçilen yatay pencereye göre kırpıp yeniden 1080 genişliğe
     * ölçekler. Orijinal ham kaynağı DEĞİL, mevcut kompoze çıktıyı işler —
     * altyazı/logo zaten gömülü olduğundan onlar da kırpılan alanla birlikte
     * etkilenir (kaynak video üretim bitince saklanmadığından yeniden
     * facecam tespiti yapmak yerine bu ikincil kırpma tercih edildi).
     * @param {number} cropLeft - 0-1, kırpma penceresinin sol kenarı
     * @param {number} cropRight - 0-1, kırpma penceresinin sağ kenarı (cropLeft'ten büyük)
     * @param {number} [durationSec] - adaptif timeout için klip süresi
     */
    async recrop({ inputPath, outputPath, cropLeft, cropRight, durationSec = 0 }) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const even = v => Math.max(2, Math.round(v / 2) * 2);
        const cropW = even(Math.round((cropRight - cropLeft) * OUT_W));
        const cropX = even(Math.max(0, Math.min(OUT_W - cropW, Math.round(cropLeft * OUT_W))));
        const timeout = Math.max(300000, Math.round(durationSec * 8000));

        await this._run('ffmpeg', [
            '-y', '-loglevel', 'error',
            '-i', inputPath,
            '-filter:v', `crop=${cropW}:${OUT_H}:${cropX}:0,scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1`,
            '-c:a', 'copy',
            '-movflags', '+faststart',
            outputPath,
        ], timeout);

        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 10000) {
            throw new Error('Kırpma çıktısı boş veya bozuk');
        }
        return { outputPath };
    }

    /**
     * Küçük önizleme görseli üret
     */
    async thumbnail(videoPath, thumbPath) {
        await this._run('ffmpeg', [
            '-y', '-loglevel', 'error',
            '-ss', '1', '-i', videoPath,
            '-frames:v', '1', '-vf', 'scale=270:480',
            thumbPath,
        ]);
        return fs.existsSync(thumbPath) ? thumbPath : null;
    }

    _run(bin, args, timeout = 120000) {
        return new Promise((resolve, reject) => {
            execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) reject(new Error(`${bin} hatası: ${(stderr || err.message).slice(0, 400)}`));
                else resolve(stdout);
            });
        });
    }
}

module.exports = VerticalComposer;
