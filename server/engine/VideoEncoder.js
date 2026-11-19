/**
 * VideoEncoder — video kodlamayı (ve kodlama hattında çözmeyi) GPU'ya taşır.
 *
 * Kompozisyon, dışa aktarma, sıkıştırma ve kayıt çıktısı eskiden libx264 /
 * libx265 ile tamamen işlemcide kodlanıyordu. Burada makinedeki ffmpeg'in
 * donanım kodlayıcıları sırayla denenir, ilk çalışan seçilir:
 *  - macOS: Apple VideoToolbox (Apple Silicon ve Intel)
 *  - Windows: NVIDIA NVENC → Intel Quick Sync → AMD AMF
 *  - Linux: NVENC → Quick Sync
 * `ffmpeg -encoders` listesinde görünmek yetmez (NVENC derlenmiş ama kart
 * yok, sürücü eski, sanal makine…): her aday, işlerde kullanılacak bayrakların
 * aynısıyla küçük bir deneme kodlamasından geçer. Hiçbiri çalışmazsa eski
 * davranış (libx264 / libx265) sürer.
 *
 * Ölçüm (M5 Pro, 1080p60 kaynak → 1080x1920 dikey kompozisyon, 17 sn):
 *   libx264 veryfast crf 20       6,6 sn · 31 sn işlemci · VMAF 93,9
 *   VideoToolbox q 65             3,9 sn · 11 sn işlemci · VMAF 94,5
 *   + VideoToolbox ile çözme      4,5 sn · 4,4 sn işlemci
 * Kayıt çıktısı (2,5 Mbps): 27,5 sn → 1,1 sn işlemci, süre aynı.
 *
 * GPU ile başlayan iş hata verirse (oturum sınırı, sürücü sorunu) iş bir kez
 * işlemciyle yeniden denenir; aynı kodekte üst üste 3 hata olursa GPU o kodek
 * için süreç ömrü boyunca kapatılır. İptal ve zaman aşımı yeniden denenmez.
 *
 * KESIT_VIDEO_ENCODER: auto (varsayılan) | cpu (GPU kapalı) |
 * videotoolbox | nvenc | qsv | amf (yalnız o aile denenir).
 */
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AILELER = {
    videotoolbox: { label: 'Apple VideoToolbox', h264: 'h264_videotoolbox', hevc: 'hevc_videotoolbox' },
    nvenc: { label: 'NVIDIA NVENC', h264: 'h264_nvenc', hevc: 'hevc_nvenc' },
    qsv: { label: 'Intel Quick Sync', h264: 'h264_qsv', hevc: 'hevc_qsv' },
    amf: { label: 'AMD AMF', h264: 'h264_amf', hevc: 'hevc_amf' },
};
const CPU_KODLAYICI = { h264: 'libx264', hevc: 'libx265' };

// Sabit kalite modu. "high" eski `-preset veryfast -crf 20` karşılığıdır
// (VideoToolbox q 65 aynı içerikte VMAF'ta x264'ün biraz üstünde, boyut benzer);
// "draft" önizlemeler içindir (eski `ultrafast -crf 24`).
const KALITE = {
    high: { x264: 'veryfast', crf: 20, vt: 65, nvencPreset: 'p4', nvencCq: 23, qsvPreset: 'medium', qsvQ: 23, amf: 'balanced', amfQp: [20, 22] },
    draft: { x264: 'ultrafast', crf: 24, vt: 50, nvencPreset: 'p1', nvencCq: 28, qsvPreset: 'veryfast', qsvQ: 28, amf: 'speed', amfQp: [26, 28] },
};
// Bit hızı modunda kodlayıcı emeği (kayıt çıktısındaki hız seçeneği).
// VideoToolbox'ta karşılığı yok; donanım tek hızda çalışır.
const HIZ = {
    fast: { x264: 'veryfast', x265: 'fast', nvenc: 'p2', qsv: 'veryfast', amf: 'speed' },
    balanced: { x264: 'medium', x265: 'medium', nvenc: 'p4', qsv: 'medium', amf: 'balanced' },
    quality: { x264: 'slow', x265: 'slow', nvenc: 'p6', qsv: 'slow', amf: 'quality' },
};
// Üst üste bu kadar GPU hatasından sonra kodek işlemciye sabitlenir.
const HATA_SINIRI = 3;
// Proje dışa aktarmada her klip ayrı girdi; çok sayıda donanım çözücü oturumu
// açmamak için bu sayının üstünde çözme işlemcide kalır.
const DONANIM_COZME_SINIRI = 4;

/** İşlemci kodlayıcısı (eski davranış). */
function cpu(codec = 'h264') {
    return { family: 'cpu', hw: false, codec, encoder: CPU_KODLAYICI[codec] || 'libx264', label: 'İşlemci', qscale: true, hwaccel: null };
}

/** Platforma göre denenecek GPU aileleri (saf). */
function adaylar(platform = process.platform) {
    if (platform === 'darwin') return ['videotoolbox'];
    if (platform === 'win32') return ['nvenc', 'qsv', 'amf'];
    return ['nvenc', 'qsv'];
}

/** Ailenin donanım çözme yöntemi (saf); Windows'ta d3d11va her GPU'da çalışır. */
function cozmeYontemi(family, platform = process.platform) {
    if (family === 'videotoolbox') return 'videotoolbox';
    if (platform === 'win32') return 'd3d11va';
    if (family === 'nvenc') return 'cuda';
    return null;
}

/** '6M' / '1500k' / 2500 → kbps sayısı. */
function kbps(v) {
    if (typeof v === 'number') return Math.round(v);
    const m = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(String(v));
    if (!m) throw new Error(`Geçersiz bit hızı: ${v}`);
    const n = Number(m[1]);
    return Math.round(/m/i.test(m[2]) ? n * 1000 : m[2] ? n : n / 1000);
}

/**
 * Sabit kalitenin desteklenmediği kodlayıcıda (Intel Mac'te VideoToolbox)
 * ölçüye göre bit hızı (kbps). 1080x1920 30 fps ≈ 6,6 Mbps.
 */
function tahminiBitHizi({ width, height, fps } = {}, quality = 'high') {
    // ffprobe kare hızı "60/1" / "30000/1001" biçiminde de gelebilir
    const [pay, payda = 1] = String(fps ?? 30).split('/').map(Number);
    const kare = pay / payda || 30;
    const piksel = (Number(width) || 1920) * (Number(height) || 1080);
    const v = (piksel * 3.2) / 1000 * (kare > 40 ? 1.4 : 1) * (quality === 'draft' ? 0.5 : 1);
    return Math.round(Math.min(20000, Math.max(1500, v)));
}

/**
 * Video kodlayıcı argümanları (saf fonksiyon).
 *
 * İki mod var: bit hızı verilmezse sabit kalite (`quality`: high | draft),
 * verilirse VBV ile ortalama ve tepe hedefte tutulur (`bitrateKbps`,
 * `maxrateKbps` = bit hızı, `bufsizeKbps` = 2 × bit hızı varsayılan).
 * Çıktı her zaman 8 bit 4:2:0; H.265'te Safari/QuickTime için `hvc1` etiketi.
 *
 * @param {{family:string, codec:'h264'|'hevc', encoder:string, qscale:boolean}} enc - select() çıktısı
 * @param {object} [o]
 * @param {'high'|'draft'} [o.quality]
 * @param {number|string} [o.bitrateKbps]
 * @param {number|string} [o.maxrateKbps]
 * @param {number|string} [o.bufsizeKbps]
 * @param {'fast'|'balanced'|'quality'} [o.speed] - bit hızı modunda emek
 * @param {number} [o.width] @param {number} [o.height] @param {number} [o.fps] - tahmini bit hızı için
 */
function videoArgs(enc, { quality = 'high', bitrateKbps = null, maxrateKbps = null, bufsizeKbps = null, speed = 'fast', width, height, fps } = {}) {
    const k = KALITE[quality] || KALITE.high;
    const h = HIZ[speed] || HIZ.fast;
    const hevc = enc.codec === 'hevc';
    let b = bitrateKbps ? kbps(bitrateKbps) : null;
    let max = maxrateKbps ? kbps(maxrateKbps) : b;
    let buf = bufsizeKbps ? kbps(bufsizeKbps) : b && b * 2;
    if (!b && enc.family === 'videotoolbox' && !enc.qscale) {
        b = tahminiBitHizi({ width, height, fps }, quality);
        max = Math.round(b * 1.5);
        buf = b * 2;
    }
    const vbv = b ? ['-b:v', `${b}k`, '-maxrate', `${max}k`, '-bufsize', `${buf}k`] : [];
    const profil = ['-profile:v', hevc ? 'main' : 'high'];
    const etiket = hevc ? ['-tag:v', 'hvc1'] : [];

    switch (enc.family) {
        case 'videotoolbox':
            return ['-c:v', enc.encoder, ...(b ? vbv : ['-q:v', String(k.vt)]), ...profil, '-pix_fmt', 'yuv420p', ...etiket];
        case 'nvenc':
            return ['-c:v', enc.encoder, '-preset', b ? h.nvenc : k.nvencPreset, '-tune', 'hq', '-rc', 'vbr',
                ...(b ? vbv : ['-cq', String(k.nvencCq), '-b:v', '0']), ...profil, '-pix_fmt', 'yuv420p', ...etiket];
        case 'qsv':
            return ['-c:v', enc.encoder, '-preset', b ? h.qsv : k.qsvPreset,
                ...(b ? vbv : ['-global_quality', String(k.qsvQ)]), ...profil, '-pix_fmt', 'nv12', ...etiket];
        case 'amf':
            return ['-c:v', enc.encoder, '-quality', b ? h.amf : k.amf,
                ...(b ? ['-rc', 'vbr_peak', ...vbv] : ['-rc', 'cqp', '-qp_i', String(k.amfQp[0]), '-qp_p', String(k.amfQp[1])]),
                ...profil, '-pix_fmt', 'nv12', ...etiket];
        default:
            if (hevc) {
                return b
                    ? ['-c:v', 'libx265', '-preset', h.x265, '-b:v', `${b}k`, '-pix_fmt', 'yuv420p',
                        '-x265-params', `vbv-maxrate=${max}:vbv-bufsize=${buf}:log-level=error`, '-tag:v', 'hvc1']
                    : ['-c:v', 'libx265', '-preset', 'fast', '-crf', String(k.crf + 3), '-pix_fmt', 'yuv420p',
                        '-x265-params', 'log-level=error', '-tag:v', 'hvc1'];
            }
            return b
                ? ['-c:v', 'libx264', '-preset', h.x264, ...vbv, '-profile:v', 'high', '-pix_fmt', 'yuv420p']
                : ['-c:v', 'libx264', '-preset', k.x264, '-crf', String(k.crf), '-pix_fmt', 'yuv420p'];
    }
}

/** Girdi (`-i`) öncesine konacak donanım çözme bayrakları; GPU yoksa boş. */
function inputArgs(enc) {
    return enc && enc.hwaccel ? ['-hwaccel', enc.hwaccel] : [];
}

/** Proje dışa aktarmada video girdisi sayısı sınırın altındaysa çözme bayrakları. */
function inputArgsFor(enc, videoInputs) {
    return videoInputs <= DONANIM_COZME_SINIRI ? inputArgs(enc) : [];
}

/* ----------------------------------------------------------- tespit */

/** ffmpeg'i çalıştırır; başarıda null, hatada son stderr satırı döner. */
function dene(args, timeout = 20_000) {
    return new Promise(resolve => {
        childProcess.execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { timeout, windowsHide: true },
            (err, _o, stderr) => resolve(err ? (String(stderr || '').trim().split('\n').pop() || err.message).slice(0, 200) : null));
    });
}

let kodlayiciListesi = null;
function kodlayicilar() {
    kodlayiciListesi ??= new Promise(resolve => {
        childProcess.execFile('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 15_000, windowsHide: true },
            (err, stdout) => resolve(err ? '' : String(stdout)));
    });
    return kodlayiciListesi;
}

function tercih() {
    return String(process.env.KESIT_VIDEO_ENCODER || 'auto').trim().toLowerCase();
}

/** Bir GPU ailesini kodekte dener; çalışıyorsa tanımını, değilse null döner. */
async function aileyiDene(family, codec, liste) {
    const encoder = AILELER[family][codec];
    if (!new RegExp(`\\b${encoder}\\b`).test(liste)) return null;
    const enc = { family, hw: true, codec, encoder, label: AILELER[family].label, qscale: true, hwaccel: null };
    const dosya = path.join(os.tmpdir(), `kesit-gpu-${process.pid}-${encoder}.mp4`);
    const kaynak = ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30', '-frames:v', '15'];
    try {
        // Sabit kalite (Intel Mac'te VideoToolbox desteklemez → tahmini bit hızına düşülür)
        let hata = await dene([...kaynak, ...videoArgs(enc), '-y', dosya]);
        if (hata && family === 'videotoolbox') {
            enc.qscale = false;
            hata = await dene([...kaynak, ...videoArgs(enc), '-y', dosya]);
        }
        // Bit hızı modu da çalışmalı (kayıt çıktısı, sıkıştırma)
        hata ||= await dene([...kaynak, ...videoArgs(enc, { bitrateKbps: 3000 }), '-f', 'null', '-']);
        if (hata) {
            console.log(`[VideoEncoder] ${encoder} kullanılamıyor: ${hata}`);
            return null;
        }
        const yontem = cozmeYontemi(family);
        if (yontem && !(await dene(['-hwaccel', yontem, '-i', dosya, '-f', 'null', '-']))) enc.hwaccel = yontem;
        return enc;
    } finally {
        fs.rmSync(dosya, { force: true });
    }
}

async function bul(codec) {
    const t = tercih();
    if (['cpu', 'off', '0', 'none', 'false'].includes(t)) return cpu(codec);
    const liste = await kodlayicilar();
    const aileler = AILELER[t] ? [t] : adaylar();
    for (const family of aileler) {
        const enc = await aileyiDene(family, codec, liste).catch(() => null);
        if (enc) return enc;
    }
    return cpu(codec);
}

/** @type {Map<string, Promise<object>>} */
const secimler = new Map();
/** @type {Map<string, object>} çözülmüş seçimler (eşzamanlı durum okuması için) */
const sonuclar = new Map();
const ardisikHata = new Map();

/** Kodek için kullanılacak kodlayıcı (ilk çağrıda tespit edilir, sonra önbellekten). */
function select(codec = 'h264') {
    if (!CPU_KODLAYICI[codec]) codec = 'h264';
    if (!secimler.has(codec)) {
        secimler.set(codec, bul(codec).catch(() => cpu(codec)).then(enc => {
            sonuclar.set(codec, enc);
            console.log(enc.hw
                ? `[VideoEncoder] ${codec.toUpperCase()} → GPU: ${enc.label} (${enc.encoder}${enc.hwaccel ? `, çözme: ${enc.hwaccel}` : ''})`
                : `[VideoEncoder] ${codec.toUpperCase()} → işlemci (${enc.encoder})`);
            return enc;
        }));
    }
    return secimler.get(codec);
}

/** Arayüz için anlık durum (tespit bitmediyse null). */
function status() {
    const ozet = enc => enc && { hw: enc.hw, label: enc.label, encoder: enc.encoder, decode: enc.hwaccel };
    return { h264: ozet(sonuclar.get('h264')), hevc: ozet(sonuclar.get('hevc')) };
}

/** İptal ya da zaman aşımı: yeniden denemenin anlamı yok. */
function isAbort(err) {
    return !!(err && (err.killed || err.signal || err.aborted));
}

function hataSay(enc) {
    const n = (ardisikHata.get(enc.codec) || 0) + 1;
    ardisikHata.set(enc.codec, n);
    if (n >= HATA_SINIRI) {
        const yedek = cpu(enc.codec);
        secimler.set(enc.codec, Promise.resolve(yedek));
        sonuclar.set(enc.codec, yedek);
        console.warn(`[VideoEncoder] ${enc.label} üst üste ${n} kez başarısız — ${enc.codec.toUpperCase()} işlemciye alındı`);
    }
}

/**
 * Kodlama işini seçili kodlayıcıyla çalıştırır; GPU ile başarısız olursa
 * aynı işi bir kez işlemciyle yeniden dener.
 * @template T
 * @param {'h264'|'hevc'} codec
 * @param {(enc: object) => Promise<T>} task - argümanları enc'e göre kurup ffmpeg'i çalıştırır
 * @param {{label?: string, canRetry?: () => boolean}} [o]
 * @returns {Promise<T>}
 */
async function withFallback(codec, task, { label = 'Kodlama', canRetry = null } = {}) {
    const enc = await select(codec);
    if (!enc.hw) return task(enc);
    try {
        const sonuc = await task(enc);
        ardisikHata.set(enc.codec, 0);
        return sonuc;
    } catch (err) {
        if (isAbort(err) || (canRetry && !canRetry())) throw err;
        hataSay(enc);
        console.warn(`[VideoEncoder] ${label}: ${enc.label} başarısız, işlemciyle yeniden deneniyor — ${String(err?.message || err).slice(0, 200)}`);
        return task(cpu(enc.codec));
    }
}

/** Sürecin hata nesnesine iptal bilgisini taşır (withFallback yeniden denemesin). */
function markAbort(err, { signal = null, killed = false } = {}) {
    if (signal) err.signal = signal;
    if (killed) err.killed = true;
    return err;
}

/** Testler için: önbelleği sıfırlar. */
function _reset() {
    secimler.clear();
    sonuclar.clear();
    ardisikHata.clear();
    kodlayiciListesi = null;
}

/** Testler için: kodek seçimini elle verir (tespit çalışmaz). */
function _use(codec, enc) {
    secimler.set(codec, Promise.resolve(enc));
    sonuclar.set(codec, enc);
    ardisikHata.set(codec, 0);
}

module.exports = {
    select,
    status,
    cpu,
    videoArgs,
    inputArgs,
    inputArgsFor,
    withFallback,
    isAbort,
    markAbort,
    adaylar,
    cozmeYontemi,
    tahminiBitHizi,
    kbps,
    _reset,
    _use,
};
