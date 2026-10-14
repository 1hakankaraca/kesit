/**
 * HorizontalComposer — yatay (16:9, kaynak çözünürlüğü korunur) YouTube
 * kesitlerini son çıktı konumuna taşır.
 *
 * VerticalComposer'ın aksine kırpma/kompozisyon/altyazı gömme YAPILMAZ —
 * VodScanManager sahne segmentini zaten -c copy ile kesip teslim ettiğinden
 * burada yalnızca hedef konuma taşıma (+ opsiyonel logo bindirme, + opsiyonel
 * intro ekleme) + doğrulama + küçük görsel üretimi var.
 *
 * İki yol vardır:
 *  - logo yok, intro yok, tam ekran bölgesi yok: hızlı `-c copy` (saniyeler);
 *  - aksi hâlde tek geçişli yeniden kodlama (renderPlan): tam ekran bölgeleri
 *    (webcam kutusu belirli anlarda kadrajı doldurur) ve logo ana görüntüye
 *    bindirilir; intro varsa kesitin ölçüsüne/kare hızına eşitlenip başa
 *    dikilir. İki farklı kaynağın (intro + Kick yayını) H.264 parametreleri
 *    asla aynı olmadığından `-c copy` ile birleştirme güvenli değil — concat
 *    filtresiyle tüm çıktı yeniden kodlanır. Uzun kesitlerde bu, düz kesime
 *    göre belirgin şekilde daha uzun sürer.
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CamFull = require('./CamFull');

// Yatay altyazı oranları (bkz. subtitleLayout).
const HORIZONTAL_FONT_BOOST = 1.55;
const HORIZONTAL_SUB_MARGIN = 0.07;

// Concat için iki tarafın ses biçimi eşitlenir; ses akışı olmayan taraf
// (sessiz intro gibi) aynı biçimde sessizlikle doldurulur.
const SES_BICIMI = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

class HorizontalComposer {
    /**
     * @param {object} p
     * @param {string} p.inputPath
     * @param {string} p.outputPath
     * @param {string|null} [p.logoPath]
     * @param {string|null} [p.introPath] - başa eklenecek intro videosu (varsa)
     * @param {string|null} [p.outroPath] - sona eklenecek outro videosu (varsa)
     * @param {string|null} [p.assPath] - kesite gömülecek ASS altyazı (varsa; intro/outro'ya basılmaz)
     * @param {{rect:{x,y,w,h}, face?:{x,y}, ranges:Array<{start,end}>}|null} [p.camFull]
     *   - tam ekran bölgeleri: webcam kutusu (kaynak piksel) + kesit saniyesi aralıkları
     */
    async compose({ inputPath, outputPath, logoPath = null, introPath = null, outroPath = null, assPath = null, camFull = null,
        logoScale = 1, logoOpacity = 1, logoX = 0.92, logoY = 0.08 }) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const hasLogo = !!logoPath && fs.existsSync(logoPath);
        const hasIntro = !!introPath && fs.existsSync(introPath);
        const hasOutro = !!outroPath && fs.existsSync(outroPath);
        const hasAss = !!assPath && fs.existsSync(assPath);
        const hasCamFull = !!(camFull?.rect && Array.isArray(camFull.ranges) && camFull.ranges.length);

        if (!hasLogo && !hasIntro && !hasOutro && !hasAss && !hasCamFull) {
            await this._copy(inputPath, outputPath);
        } else {
            await this._render({
                inputPath, outputPath,
                introPath: hasIntro ? introPath : null,
                outroPath: hasOutro ? outroPath : null,
                assPath: hasAss ? assPath : null,
                logoPath: hasLogo ? logoPath : null,
                camFull: hasCamFull ? camFull : null,
                logoScale, logoOpacity, logoX, logoY,
            });
        }

        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 10000) {
            throw new Error('Yatay kesit çıktısı boş veya bozuk');
        }
        return { outputPath };
    }

    /* ------------------------------------------------------------- yollar */

    _copy(inputPath, outputPath) {
        return this._ffmpeg([
            '-i', inputPath,
            '-c', 'copy', '-movflags', '+faststart',
            outputPath,
        ], { timeout: 600000, hataOnek: 'Yatay kesit hazırlama hatası' });
    }

    async _render({ inputPath, outputPath, introPath, outroPath = null, assPath = null, logoPath, camFull, logoScale, logoOpacity, logoX, logoY }) {
        const ana = await this._probe(inputPath);
        if (!ana.width || !ana.height) throw new Error('Kesitin çözünürlüğü okunamadı');
        const ekProbe = async (yol, ad) => {
            if (!yol) return null;
            const bilgi = await this._probe(yol);
            if (!bilgi.width || !bilgi.height) throw new Error(`${ad} videosunun çözünürlüğü okunamadı`);
            return bilgi;
        };
        const intro = await ekProbe(introPath, 'Intro');
        const outro = await ekProbe(outroPath, 'Outro');

        const plan = HorizontalComposer.renderPlan({
            main: ana,
            intro,
            outro,
            assPath,
            logo: logoPath ? HorizontalComposer.logoParams({ width: ana.width, logoScale, logoOpacity, logoX, logoY }) : null,
            camFull,
        });

        const args = ['-i', inputPath];
        if (logoPath) args.push('-i', logoPath);
        if (introPath) args.push('-i', introPath);
        if (outroPath) args.push('-i', outroPath);
        if (plan.needsSilence) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
        args.push('-filter_complex', plan.filterGraph, '-map', '[outv]');
        if (intro || outro) {
            args.push('-map', '[outa]', '-c:a', 'aac', '-b:a', '160k');
        } else {
            args.push('-map', '0:a?', '-c:a', 'copy');
        }
        args.push(
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            outputPath,
        );
        const toplamSure = (ana.duration || 0) + (intro?.duration || 0) + (outro?.duration || 0);
        await this._ffmpeg(args, {
            timeout: Math.max(900000, Math.round(toplamSure * 15000)),
            hataOnek: intro || outro ? 'Intro/outro ekleme hatası' : 'Yatay kesit bindirme hatası',
        });
    }

    /* ------------------------------------------------------------- saf yardımcılar (test edilebilir) */

    /**
     * Yatay altyazı geometrisi (saf fonksiyon). Stiller 1080x1920 düzlem için
     * yazılı; yatayda yazı yüksekliğin ~%4.6'sı, alt boşluk %7 olur. PlayRes
     * kesitin kendi ölçüsü olduğundan her çözünürlükte oran aynı kalır.
     * Arayüz önizlemesi (src/lib/frame.ts) aynı oranları kullanır.
     */
    static subtitleLayout({ width, height }) {
        return {
            playResX: width,
            playResY: height,
            fontScale: (height / 1920) * HORIZONTAL_FONT_BOOST,
            marginV: Math.round(height * HORIZONTAL_SUB_MARGIN),
        };
    }

    /** Logo genişliği/opaklık/konum — VOD editöründeki sürükle-bırak değerleriyle aynı sınırlar. */
    static logoParams({ width, logoScale = 1, logoOpacity = 1, logoX = 0.92, logoY = 0.08 }) {
        const scale = Math.min(2, Math.max(0.5, Number(logoScale) || 1));
        return {
            logoW: Math.max(2, Math.round((width || 1920) / 3 * scale / 2) * 2),
            opacity: Math.min(1, Math.max(0.05, Number(logoOpacity) || 1)),
            x: Math.min(1, Math.max(0, Number(logoX))),
            y: Math.min(1, Math.max(0, Number(logoY))),
        };
    }

    static logoChain({ logoW, opacity }) {
        return `scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=${opacity}`;
    }

    /**
     * Logo konumu. Varsayılan: (x, y) logonun MERKEZİdir. `bottomMargin` verilirse
     * dikeyde alt kenardan o oranda boşlukla hizalanır — merkezden hizalamada
     * büyük logo alt kenara yakınken kadrajın dışına taşıyordu.
     */
    static overlayExpr({ x, y, bottomMargin = null }) {
        const dikey = bottomMargin === null
            ? `(main_h*${y})-(overlay_h/2)`
            : `main_h*${1 - bottomMargin}-overlay_h`;
        return `overlay=x='(main_w*${x})-(overlay_w/2)':y='${dikey}'`;
    }

    /**
     * Yeniden kodlama filtre grafiğini kurar (saf fonksiyon).
     *
     * Girdi sırası: 0 = kesit, [1 = logo], [sonraki = intro], [sonraki = outro], [sonraki = anullsrc].
     * Ana görüntü zinciri: [0:v] → (tam ekran bölgeleri: webcam kutusu cover-kırpılıp
     * kadraja büyütülür, yalnız verilen aralıklarda bindirilir) → (logo) → [mainv].
     * Intro varsa kesitin çözünürlüğüne oran koruyarak sığdırılır (letterbox),
     * kare hızı eşitlenir; ses iki tarafta 48 kHz stereo'ya çekilir, ses akışı
     * olmayan taraf sessizlikle doldurulur; sonuç concat ile [outv][outa].
     * Outro aynı kurallarla sona dikilir. Intro da outro da yoksa çıktı yalnız
     * [outv]'dir (ses `-c:a copy` ile kaynaktan gelir).
     *
     * @param {object} p
     * @param {{width:number,height:number,fps:string|null,hasAudio:boolean,duration:number}} p.main
     * @param {{hasAudio:boolean,duration:number}|null} [p.intro]
     * @param {{hasAudio:boolean,duration:number}|null} [p.outro]
     * @param {{logoW:number,opacity:number,x:number,y:number}|null} [p.logo]
     * @param {{rect:object, face?:object, ranges:Array}|null} [p.camFull]
     * @param {{width:number,height:number}|null} [p.output] - kaynaktan farklı çıktı ölçüsü
     * @returns {{filterGraph: string, needsSilence: boolean, introIndex: number|null, outroIndex: number|null, silenceIndex: number|null}}
     */
    static renderPlan({ main, intro = null, outro = null, logo = null, camFull = null, output = null, assPath = null }) {
        const W = main.width;
        const H = main.height;
        // Çıktı ölçüsü kaynaktan küçükse (kayıt çıktısı 720p gibi) ana zincirin
        // SONUNDA ölçeklenir: tam ekran kırpması ve logo konumu kaynak pikselinde kalır.
        const outW = output?.width || W;
        const outH = output?.height || H;
        const olcek = outW !== W || outH !== H ? `scale=${outW}:${outH}:flags=bicubic,` : '';
        let sonrakiGirdi = logo ? 2 : 1;
        const introIndex = intro ? sonrakiGirdi++ : null;
        const outroIndex = outro ? sonrakiGirdi++ : null;
        const ekler = [intro, outro].filter(Boolean);
        const needsSilence = ekler.length > 0 && (!main.hasAudio || ekler.some(e => !e.hasAudio));
        const silenceIndex = needsSilence ? sonrakiGirdi : null;

        const parcalar = [];
        let src = '[0:v]';

        // Tam ekran bölgeleri
        const ranges = camFull ? CamFull.normalizeCamFullRanges(camFull.ranges, { maxDuration: main.duration || Infinity }) : [];
        if (camFull?.rect && ranges.length) {
            const crop = CamFull.coverCrop(camFull.rect, W, H, camFull.face || null);
            parcalar.push('[0:v]split=2[base][cfsrc]');
            parcalar.push(`[cfsrc]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${W}:${H}:flags=lanczos,setsar=1[camfull]`);
            parcalar.push(`[base][camfull]overlay=enable='${CamFull.enableExpr(ranges)}'[cf]`);
            src = '[cf]';
        }

        // Logo
        if (logo) {
            parcalar.push(`[1:v]${HorizontalComposer.logoChain(logo)}[logo]`);
            parcalar.push(`${src}[logo]${HorizontalComposer.overlayExpr(logo)}[lg]`);
            src = '[lg]';
        }

        // Altyazı logonun üstüne, ölçeklemeden önce (kaynak pikselinde) gömülür.
        if (assPath) {
            const kacisli = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
            parcalar.push(`${src}subtitles='${kacisli}'[sub]`);
            src = '[sub]';
        }

        if (!ekler.length) {
            parcalar.push(`${src}${olcek}format=yuv420p,setsar=1[outv]`);
            return { filterGraph: parcalar.join(';'), needsSilence: false, introIndex: null, outroIndex: null, silenceIndex: null };
        }

        const fps = HorizontalComposer.gecerliFps(main.fps) || '30';
        parcalar.push(`${src}${olcek}format=yuv420p,setsar=1[mainv]`);
        const sessizlik = (sure, etiket) =>
            `[${silenceIndex}:a]atrim=0:${Math.max(0.1, sure).toFixed(3)},asetpts=PTS-STARTPTS,${SES_BICIMI}[${etiket}]`;
        // Ek video (intro/outro): kesitin ölçüsüne letterbox ile sığdırılır, kare hızı eşitlenir.
        const ekZinciri = (bilgi, index, ad) => {
            parcalar.push(
                `[${index}:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease,` +
                `pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p,setsar=1[${ad}v]`,
            );
            parcalar.push(bilgi.hasAudio ? `[${index}:a]${SES_BICIMI}[${ad}a]` : sessizlik(bilgi.duration, `${ad}a`));
        };
        if (intro) ekZinciri(intro, introIndex, 'intro');
        parcalar.push(main.hasAudio ? `[0:a]${SES_BICIMI}[maina]` : sessizlik(main.duration, 'maina'));
        if (outro) ekZinciri(outro, outroIndex, 'outro');

        const sira = [intro && '[introv][introa]', '[mainv][maina]', outro && '[outrov][outroa]'].filter(Boolean);
        parcalar.push(`${sira.join('')}concat=n=${sira.length}:v=1:a=1[outv][outa]`);

        return { filterGraph: parcalar.join(';'), needsSilence, introIndex, outroIndex, silenceIndex };
    }

    /** Geriye dönük ad — testler ve eski çağrılar için renderPlan'a yönlendirir. */
    static introPlan(p) { return HorizontalComposer.renderPlan(p); }

    /** ffprobe r_frame_rate ("60/1", "30000/1001") → fps filtresine verilebilir mi? */
    static gecerliFps(fps) {
        if (typeof fps !== 'string' || !/^\d+\/\d+$/.test(fps)) return null;
        const [pay, payda] = fps.split('/').map(Number);
        if (!payda || !pay) return null;
        const deger = pay / payda;
        return deger >= 1 && deger <= 240 ? fps : null;
    }

    /* ------------------------------------------------------------- ffmpeg/ffprobe */

    _ffmpeg(args, { timeout, hataOnek }) {
        return new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
            let stderr = '';
            let killed = false;
            const timer = setTimeout(() => { killed = true; proc.kill('SIGTERM'); }, timeout);
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', (err) => { clearTimeout(timer); reject(err); });
            proc.on('exit', code => {
                clearTimeout(timer);
                if (killed) reject(new Error(`${hataOnek}: zaman aşımı`));
                else if (code === 0) resolve();
                else reject(new Error(`${hataOnek} (code ${code}): ${stderr.slice(0, 300)}`));
            });
        });
    }

    async _probe(inputPath) {
        const out = await this._run('ffprobe', [
            '-v', 'error',
            '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration',
            '-of', 'json', inputPath,
        ]);
        const j = JSON.parse(out);
        const video = (j.streams || []).find(s => s.codec_type === 'video') || {};
        const audio = (j.streams || []).find(s => s.codec_type === 'audio');
        return {
            width: video.width || 0,
            height: video.height || 0,
            fps: video.r_frame_rate || null,
            hasAudio: !!audio,
            duration: parseFloat(j.format?.duration) || 0,
        };
    }

    /**
     * Üretilen kesiti doğrula — VerticalComposer.verifyOutput'tan farklı olarak
     * sabit boyut ZORLANMAZ (kaynak çözünürlüğü korunuyor).
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
                '-show_entries', 'stream=index,codec_type,width,height:format=duration',
                '-of', 'json', outputPath,
            ]);
            probe = JSON.parse(out);
        } catch (err) {
            return { ok: false, issues: [`ffprobe okuyamadı: ${err.message.slice(0, 120)}`], info: {} };
        }

        const video = (probe.streams || []).find(s => s.codec_type === 'video');
        const audio = (probe.streams || []).find(s => s.codec_type === 'audio');
        const duration = parseFloat(probe.format?.duration) || 0;

        if (!video) issues.push('Video akışı yok');
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
                duration: Math.round(duration * 10) / 10,
                sizeKB: Math.round(size / 1024),
                hasAudio: !!audio,
            },
        };
    }

    async thumbnail(videoPath, thumbPath, { offsetSec = 1 } = {}) {
        await this._run('ffmpeg', [
            '-y', '-loglevel', 'error',
            '-ss', String(Math.max(0, offsetSec)), '-i', videoPath,
            '-frames:v', '1', '-vf', 'scale=480:270',
            thumbPath,
        ]);
        return fs.existsSync(thumbPath) ? thumbPath : null;
    }

    _run(bin, args, timeout = 60000) {
        return new Promise((resolve, reject) => {
            execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) reject(new Error(`${bin} hatası: ${(stderr || err.message).slice(0, 400)}`));
                else resolve(stdout);
            });
        });
    }
}

module.exports = HorizontalComposer;
