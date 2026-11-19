/**
 * SubscribeCta — "Abone ol" çağrısı.
 *
 * Üretilen her videoya (dikey ve yatay) iki şekilde abone çağrısı eklenir:
 *  1. Animasyon: marka renginde çizilen kısa "Abone ol" hareketi. Altyazı
 *     gibi ASS olarak gömülür (libass çizim komutlarıyla hap/şerit/kart);
 *     ek dosya ya da yazı tipi gerekmez, kompozisyonla tek geçişte basılır.
 *  2. Abone kesiti: kullanıcının yüklediği kısa video (ör. "abone ol"
 *     animasyonu) nihai çıktının başına, ortasına ya da sonuna dikilir.
 *     Çıktının ölçüsüne sığdırılır; oran uymuyorsa arkası bulanık kopyayla dolar.
 *
 * Ayar kanal sekmesinin marka profilinden (channel_brands[slug].brand.cta)
 * ya da genel ayardan (user_settings.cta) okunur. Kesit dosyası logo gibi
 * durur: `<clips>/<user>/cta.mp4`, sekme profili varsa `brand/<slug>/cta.mp4`.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('./ProcTracker');
const IntroStore = require('./IntroStore');
const VideoEncoder = require('./VideoEncoder');

const CLIP_OUTPUT_DIR = process.env.CLIP_OUTPUT_DIR || 'data/clips';
const PLACES = ['start', 'middle', 'end'];
const STYLES = ['pill', 'bar', 'card', 'cursor', 'icons', 'side'];
/** Çağrılar: anahtar → simge ve varsayılan yazı. Sıra: beğen, yorum, abone (abone sonda, doruk). */
const ACTIONS = ['like', 'comment', 'subscribe'];
const ACTION_DEFAULTS = Object.freeze({ subscribe: 'Abone ol', like: 'Beğen', comment: 'Yorum yap' });
const ACTION_ICON = Object.freeze({ subscribe: 'bell', like: 'heart', comment: 'bubble' });
const POSITIONS = ['top', 'center', 'bottom'];
/** Çıktı biçimleri: animasyon ve kesit her biri için ayrı açılıp kapanır. */
const FORMATS = ['vertical', 'horizontal'];
/** Boyut yüzde olarak saklanır (100 = tasarım ölçüsü); eski adlı kademeler yüzdeye çevrilir. */
const SIZE_PRESETS = Object.freeze({ tiny: 45, xsmall: 60, small: 80, medium: 100, large: 125, xlarge: 150 });
const SIZE_MIN = 30;
const SIZE_MAX = 200;
const HEX = /^#[0-9a-f]{6}$/i;
/** Renkler: null → marka/vurgu rengi ve varsayılan beyaz/koyu. */
const COLOR_KEYS = ['primary', 'accent', 'text', 'dark'];
const FILE_NAME = 'cta.mp4';
const CLIP_MAX_SECONDS = 20;
const CLIP_MAX_BYTES = 100 * 1024 * 1024;
/** Ortaya dikmek için klibin en az bu kadar uzun olması gerekir. */
const MIN_MIDDLE_DURATION = 10;
const SES_BICIMI = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const f = (n) => Math.round(n);

function places(list, fallback) {
    const arr = Array.isArray(list) ? list : typeof list === 'string' ? [list] : [];
    const out = PLACES.filter(p => arr.includes(p));
    return out.length ? out : [...fallback];
}

/** ASS zaman damgası (h:mm:ss.cs). */
function toAssTime(sec) {
    const s = Math.max(0, sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const cs = Math.floor((s % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** #rrggbb → ASS renk gövdesi (bbggrr). Geçersizse Kick yeşili. */
function assRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    const v = (m ? m[1] : '53fc18').toLowerCase();
    return `${v.slice(4, 6)}${v.slice(2, 4)}${v.slice(0, 2)}`.toUpperCase();
}

const escapeAss = (text) => String(text).replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/[\r\n]+/g, ' ');

/** Kare hızı dizesi ("30000/1001") geçerliyse olduğu gibi, değilse 30. */
function fpsString(fps) {
    const m = /^(\d+)(?:\/(\d+))?$/.exec(String(fps || ''));
    if (!m) return '30';
    const val = Number(m[1]) / Number(m[2] || 1);
    return val > 0 && val <= 120 ? (m[2] ? `${m[1]}/${m[2]}` : m[1]) : '30';
}

class SubscribeCta {
    static PLACES = PLACES;
    static STYLES = STYLES;
    static POSITIONS = POSITIONS;
    static FILE_NAME = FILE_NAME;
    static CLIP_MAX_SECONDS = CLIP_MAX_SECONDS;
    static CLIP_MAX_BYTES = CLIP_MAX_BYTES;
    static MIN_MIDDLE_DURATION = MIN_MIDDLE_DURATION;

    static DEFAULTS = Object.freeze({
        overlay: Object.freeze({
            enabled: false, at: ['start'], seconds: 5, labels: ACTION_DEFAULTS, style: 'pill',
            // Biçim başına: dikeyde ortada orta boy, yatayda altta küçük (oyun görüntüsünü kapatmasın).
            formats: Object.freeze({
                vertical: Object.freeze({ enabled: true, place: 'center', size: 100 }),
                horizontal: Object.freeze({ enabled: true, place: 'bottom', size: 80 }),
            }),
            colors: Object.freeze({ primary: null, accent: null, text: null, dark: null }),
        }),
        insert: Object.freeze({ enabled: false, at: ['end'], formats: Object.freeze({ vertical: true, horizontal: true }) }),
    });
    static ACTIONS = ACTIONS;
    static FORMATS = FORMATS;
    static SIZE_PRESETS = SIZE_PRESETS;
    static SIZE_MIN = SIZE_MIN;
    static SIZE_MAX = SIZE_MAX;

    /** Boyut: yüzde sayısı ya da eski kademe adı; geçersizse yedek. */
    static sizeOf(v, fallback) {
        if (typeof v === 'string' && Object.hasOwn(SIZE_PRESETS, v)) return SIZE_PRESETS[v];
        const n = Math.round(Number(v));
        return Number.isFinite(n) && n > 0 ? clamp(n, SIZE_MIN, SIZE_MAX) : fallback;
    }
    static ACTION_DEFAULTS = ACTION_DEFAULTS;

    /** Ham ayarı (JSON dizesi ya da nesne) güvenli biçime getirir. */
    static normalize(raw) {
        let src = raw;
        if (typeof src === 'string') {
            try { src = JSON.parse(src); } catch { src = null; }
        }
        if (!src || typeof src !== 'object') src = {};
        const o = src.overlay && typeof src.overlay === 'object' ? src.overlay : {};
        const i = src.insert && typeof src.insert === 'object' ? src.insert : {};
        const d = SubscribeCta.DEFAULTS;
        // Yazılar: boş bırakılan çağrı videoda görünmez; hepsi boşsa abone yazısı geri gelir.
        const rawLabels = o.labels && typeof o.labels === 'object' ? o.labels : null;
        const labels = {};
        for (const key of ACTIONS) {
            const v = rawLabels ? rawLabels[key] : key === 'subscribe' ? (o.text ?? ACTION_DEFAULTS[key]) : ACTION_DEFAULTS[key];
            labels[key] = String(v ?? '').trim().slice(0, 24);
        }
        if (!ACTIONS.some(k => labels[k])) labels.subscribe = ACTION_DEFAULTS.subscribe;
        // Biçim başına yer/boyut; eski tek `place` alanı her iki biçime taşınır.
        const rawFormats = o.formats && typeof o.formats === 'object' ? o.formats : {};
        const formats = {};
        for (const fmt of FORMATS) {
            const r = rawFormats[fmt] && typeof rawFormats[fmt] === 'object' ? rawFormats[fmt] : {};
            const def = d.overlay.formats[fmt];
            formats[fmt] = {
                enabled: r.enabled !== false,
                place: POSITIONS.includes(r.place) ? r.place : POSITIONS.includes(o.place) ? o.place : def.place,
                size: SubscribeCta.sizeOf(r.size, def.size),
            };
        }
        const rawColors = o.colors && typeof o.colors === 'object' ? o.colors : {};
        const colors = {};
        for (const k of COLOR_KEYS) colors[k] = HEX.test(String(rawColors[k] || '')) ? String(rawColors[k]).toLowerCase() : null;
        const rawInsertFormats = i.formats && typeof i.formats === 'object' ? i.formats : {};
        const insertFormats = {};
        for (const fmt of FORMATS) insertFormats[fmt] = rawInsertFormats[fmt] !== false;
        return {
            overlay: {
                enabled: o.enabled === true,
                at: places(o.at, d.overlay.at),
                seconds: clamp(Math.round(Number(o.seconds)) || d.overlay.seconds, 2, 10),
                labels,
                style: STYLES.includes(o.style) ? o.style : d.overlay.style,
                formats,
                colors,
            },
            insert: { enabled: i.enabled === true, at: places(i.at, d.insert.at), formats: insertFormats },
        };
    }

    /** Bu biçimde animasyon çizilecek mi. */
    static overlayActive(cfg, format) {
        return !!(cfg && cfg.overlay.enabled && cfg.overlay.formats[format] && cfg.overlay.formats[format].enabled);
    }

    /** Bu biçimde abone kesiti dikilecek mi. */
    static insertActive(cfg, format) {
        return !!(cfg && cfg.insert.enabled && cfg.insert.formats[format]);
    }

    /**
     * Otomatik işleme yerleşimi: yalnız "ne zaman"ı belirler — animasyon başta
     * (intro sonrası) ve sonda (outro öncesi), abone kesiti tam ortada.
     * Aç/kapa anahtarları (animasyon, biçim başına, kesit, hangi videolara)
     * Stüdyo ayarından aynen gelir: kapatılan çağrı otomatikte de eklenmez.
     * hasClip=false ise (kesit yüklenmemiş) dikme kapalı kalır.
     */
    static autoPlan(cfg, { hasClip = true } = {}) {
        const c = SubscribeCta.normalize(cfg);
        return {
            overlay: { ...c.overlay, at: ['start', 'end'] },
            insert: { ...c.insert, enabled: c.insert.enabled && !!hasClip, at: ['middle'] },
        };
    }

    /**
     * Biçime göre çizim ayarı: ortak alanlar + o biçimin yeri ve ölçeği.
     * eventsFor bu düz nesneyi kullanır (place, scale).
     */
    static overlayFor(cfg, format) {
        const fmt = cfg.overlay.formats[format] || SubscribeCta.DEFAULTS.overlay.formats.vertical;
        return { ...cfg.overlay, place: fmt.place, scale: (fmt.size || 100) / 100 };
    }

    /** Çizim renkleri: ayarda özel renk varsa o, yoksa marka/vurgu ve beyaz/koyu. */
    static colorsOf(cfg, brandColor, accentColor) {
        const c = (cfg && cfg.overlay && cfg.overlay.colors) || {};
        const primary = c.primary || brandColor || '#53fc18';
        return { primary, accent: c.accent || accentColor || primary, text: c.text || '#ffffff', dark: c.dark || '#2a2d33' };
    }

    /** Sekme profili kendi ayarını taşıyorsa o, yoksa genel ayar. */
    static resolve(settings, profile) {
        const own = profile && profile.brand && profile.brand.cta !== undefined && profile.brand.cta !== null;
        return SubscribeCta.normalize(own ? profile.brand.cta : settings?.cta);
    }

    /** Abone kesiti dosyası; sekme profili klasörü varsa yalnız oradaki geçerlidir (logo kuralı). */
    static clipPath(userId, channelSlug = null) {
        const base = path.join(CLIP_OUTPUT_DIR, String(userId));
        if (channelSlug) {
            const dir = path.join(base, 'brand', String(channelSlug).toLowerCase());
            if (fs.existsSync(dir)) {
                const own = path.join(dir, FILE_NAME);
                return fs.existsSync(own) ? own : null;
            }
        }
        const p = path.join(base, FILE_NAME);
        return fs.existsSync(p) ? p : null;
    }

    /**
     * Animasyonun görüneceği zaman pencereleri (saniye). Kısa kliplerde
     * çakışan pencereler atlanır; ortaya kesit dikiliyorsa ortadaki animasyon
     * dikiş noktasının hemen sonrasına alınır ki ikiye bölünmesin.
     */
    static windows(overlay, duration, { middleInsert = false } = {}) {
        const D = Number(duration) || 0;
        const S = overlay.seconds;
        if (D < 2) return [];
        const starts = {
            start: 0.8,
            middle: middleInsert ? D / 2 : D / 2 - S / 2,
            end: D - S - 0.4,
        };
        const out = [];
        for (const at of PLACES) {
            if (!overlay.at.includes(at)) continue;
            const s = Math.max(0, starts[at]);
            const e = Math.min(D - 0.2, s + S);
            if (e - s < 1) continue;
            const last = out[out.length - 1];
            if (last && s < last.end + 0.5) continue;
            out.push({ start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100, at });
        }
        return out;
    }

    /** Abone kesitinin dikileceği noktalar (çıktı zamanı). offset: başta intro varsa onun süresi. */
    static insertPoints(at, duration, { offset = 0 } = {}) {
        const D = Number(duration) || 0;
        if (D <= 0) return [];
        const pts = [];
        if (at.includes('start')) pts.push(offset);
        if (at.includes('middle') && D >= MIN_MIDDLE_DURATION) pts.push(offset + D / 2);
        if (at.includes('end')) pts.push(offset + D);
        return [...new Set(pts.map(p => Math.round(p * 1000) / 1000))].sort((a, b) => a - b);
    }

    /* ── ASS çizimleri ───────────────────────────────────────────────────── */

    /** Köşeleri yuvarlak dikdörtgen (0,0)-(w,h); r köşe yarıçapı. */
    static roundedRect(w, h, r) {
        const rr = Math.min(r, w / 2, h / 2);
        const k = rr * 0.5523;
        return `m ${f(rr)} 0 l ${f(w - rr)} 0 b ${f(w - rr + k)} 0 ${f(w)} ${f(rr - k)} ${f(w)} ${f(rr)} ` +
            `l ${f(w)} ${f(h - rr)} b ${f(w)} ${f(h - rr + k)} ${f(w - rr + k)} ${f(h)} ${f(w - rr)} ${f(h)} ` +
            `l ${f(rr)} ${f(h)} b ${f(rr - k)} ${f(h)} 0 ${f(h - rr + k)} 0 ${f(h - rr)} ` +
            `l 0 ${f(rr)} b 0 ${f(rr - k)} ${f(rr - k)} 0 ${f(rr)} 0`;
    }

    /** Daire (0,0)-(2r,2r). */
    static circle(r) {
        const k = r * 0.5523;
        return `m ${f(r)} 0 b ${f(r + k)} 0 ${f(2 * r)} ${f(r - k)} ${f(2 * r)} ${f(r)} ` +
            `b ${f(2 * r)} ${f(r + k)} ${f(r + k)} ${f(2 * r)} ${f(r)} ${f(2 * r)} ` +
            `b ${f(r - k)} ${f(2 * r)} 0 ${f(r + k)} 0 ${f(r)} b 0 ${f(r - k)} ${f(r - k)} 0 ${f(r)} 0`;
    }

    static STYLE_LINE = 'Style: Cta,Arial,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1';

    /** Simge yolları: 100×100 kutuda; \fscx/\fscy ile piksel boyuta ölçeklenir. */
    static ICONS = Object.freeze({
        heart: 'm 50 90 b 20 70 0 50 0 30 b 0 10 15 0 27 0 b 38 0 46 6 50 14 b 54 6 62 0 73 0 b 85 0 100 10 100 30 b 100 50 80 70 50 90',
        bubble: 'm 12 0 l 88 0 b 95 0 100 5 100 12 l 100 58 b 100 65 95 70 88 70 l 42 70 l 20 90 l 25 70 l 12 70 b 5 70 0 65 0 58 l 0 12 b 0 5 5 0 12 0',
        bell: 'm 50 0 b 32 0 22 14 22 34 l 22 58 l 8 74 l 92 74 l 78 58 l 78 34 b 78 14 68 0 50 0 m 38 80 l 62 80 b 62 92 38 92 38 80',
        cursor: 'm 0 0 l 0 74 l 19 58 l 31 88 l 44 82 l 32 53 l 55 53',
        check: 'm 0 52 l 12 40 l 36 62 l 88 10 l 100 22 l 36 86',
    });

    /** Ayardaki yazılara göre gösterilecek çağrılar (boş yazı → yok). */
    static actionsOf(overlay, order = ACTIONS) {
        return order.filter(k => overlay.labels[k]).map(k => ({ key: k, label: escapeAss(overlay.labels[k]), icon: ACTION_ICON[k] }));
    }

    /**
     * Bir pencere için ASS olayları. Ölçü PlayRes'e göre; birim
     * u = min(PlayResX, PlayResY)/1080, böylece dikey ve yatay çıktıda aynı
     * büyüklükte görünür. Her stil kendi zaman çizelgesini pencere süresine
     * (len) sığdırır.
     */
    static eventsFor(overlay, win, { playResX, playResY, brandColor, accentColor, textColor = null, darkColor = null, channel = null }) {
        const X = playResX;
        const Y = playResY;
        // Ölçek: boyut ayarı (küçük/orta/büyük/çok büyük) birimi çarpar.
        const u = (Math.min(X, Y) / 1080) * (overlay.scale || 1);
        // Merkez: editör parçası x/y (kareye oran) verir; Stüdyo ayarı üst/orta/alt der.
        const cx = typeof overlay.x === 'number' ? clamp(X * overlay.x, 0, X) : X / 2;
        const cy = typeof overlay.y === 'number' ? clamp(Y * overlay.y, 0, Y) : Y * ({ top: 0.2, center: 0.5, bottom: 0.78 })[overlay.place || 'center'];
        const brand = assRgb(brandColor);
        const accent = assRgb(accentColor || brandColor);
        const len = win.end - win.start;
        const out = [];
        const T = (sec) => toAssTime(win.start + sec);
        /** Olay: layer, başlangıç/bitiş (pencereye göre sn), etiketler, gövde. */
        const ev = (layer, s, e, tags, body) => out.push(`Dialogue: ${layer},${T(s)},${T(e)},Cta,,0,0,0,,{${tags}}${body}`);
        const draw = (layer, s, e, tags, pathStr) => ev(layer, s, e, `${tags}\\p1`, `${pathStr}{\\p0}`);
        /** Simge: merkez (x,y), piksel boyutu, renk; ek etiketler (animasyon) sonda. */
        const icon = (layer, s, e, name, x, y, size, color, extra = '') =>
            draw(layer, s, e, `\\an5\\pos(${f(x)},${f(y)})\\fscx${f(size)}\\fscy${f(size)}\\1c&H${color}&\\bord0\\shad0${extra}`, SubscribeCta.ICONS[name]);
        const pop = (size, from = 0.6) => `\\fscx${f(size * from)}\\fscy${f(size * from)}\\t(0,220,\\fscx${f(size * 1.08)}\\fscy${f(size * 1.08)})\\t(220,360,\\fscx${f(size)}\\fscy${f(size)})`;
        const textPop = '\\fscx60\\fscy60\\t(0,220,\\fscx108\\fscy108)\\t(220,360,\\fscx100\\fscy100)';
        const fad = '\\fad(180,220)';
        // "white": yazı ve simge rengi, "ink": koyu zemin — ikisi de ayardan değişebilir.
        const white = textColor ? assRgb(textColor) : 'FFFFFF';
        const ink = darkColor ? assRgb(darkColor) : '2A2D33';
        /** Tıklama dalgası: (x,y) merkezli büyüyüp solan halka. */
        const ripple = (s, x, y, color = white) => {
            if (s + 0.7 > len) return;
            draw(12, s, s + 0.7, `\\an5\\pos(${f(x)},${f(y)})\\1c&H${color}&\\bord0\\shad0\\alpha&H30&\\t(0,700,\\fscx320\\fscy320\\alpha&HFF&)`, SubscribeCta.circle(16 * u));
        };
        /** İmleç: (x,y) uç noktası; legs = [{x,y,t}] duraklar, click = tıklanan durak dizinleri. */
        const cursor = (legs, clicks) => {
            const size = 64 * u;
            const base = `\\an7\\fscx${f(size)}\\fscy${f(size)}\\1c&H${white}&\\3c&H${ink}&\\bord2\\shad1`;
            for (let i = 0; i < legs.length - 1; i++) {
                const a = legs[i];
                const b = legs[i + 1];
                const ms = Math.max(1, Math.round((b.t - a.t) * 1000));
                draw(13, a.t, b.t, `${base}\\move(${f(a.x)},${f(a.y)},${f(b.x)},${f(b.y)},0,${ms})${i === 0 ? '\\fad(150,0)' : ''}`, SubscribeCta.ICONS.cursor);
            }
            for (const i of clicks) {
                const l = legs[i];
                const hold = (legs[i + 1] ? legs[i + 1].t : l.t) - l.t;
                if (hold <= 0.05) continue;
                // Durakta basma: küçülüp geri büyür, altında dalga
                draw(13, l.t, l.t + hold, `${base}\\pos(${f(l.x)},${f(l.y)})\\t(0,120,\\fscx${f(size * 0.82)}\\fscy${f(size * 0.82)})\\t(120,260,\\fscx${f(size)}\\fscy${f(size)})`, SubscribeCta.ICONS.cursor);
                ripple(l.t + 0.05, l.x, l.y, ink);
            }
        };
        const actions = SubscribeCta.actionsOf(overlay);
        const n = actions.length;

        /* ── Haplar: sırayla yükselen haplar (simge + yazı); sığmazsa alt alta ── */
        if (overlay.style === 'pill') {
            const fs = 56 * u;
            const gap = 18 * u;
            const h = fs * 1.9;
            const ws = actions.map(a => a.label.length * fs * 0.6 + fs * 0.75 + 110 * u);
            const rowTotal = ws.reduce((a, b) => a + b, 0) + gap * (n - 1);
            const column = rowTotal > X * 0.92;
            let x = cx - rowTotal / 2;
            actions.forEach((a, i) => {
                const w = ws[i];
                const mx = column ? cx : x + w / 2;
                const my = column ? cy + (i - (n - 1) / 2) * (h + gap) : cy;
                const px = mx - w / 2;
                const s = Math.min(i * 0.45, Math.max(0, len - 1.2));
                const rise = (xx, yy) => `\\move(${f(xx)},${f(yy + 70 * u)},${f(xx)},${f(yy)},0,320)`;
                draw(10, s, len, `\\an5${rise(mx, my)}${fad}\\1c&H${a.key === 'subscribe' ? brand : ink}&\\1a&H${a.key === 'subscribe' ? '00' : '38'}&\\bord0\\shad0`, SubscribeCta.roundedRect(w, h, h / 2));
                const iconSize = fs * 0.75;
                const ix = px + 44 * u + iconSize / 2;
                draw(11, s, len, `\\an5${rise(ix, my)}${fad}\\fscx${f(iconSize)}\\fscy${f(iconSize)}\\1c&H${white}&\\bord0\\shad0\\p1`, SubscribeCta.ICONS[a.icon]);
                const tx = ix + iconSize / 2 + 14 * u + (a.label.length * fs * 0.6) / 2;
                ev(11, s, len, `\\an5${rise(tx, my)}${fad}\\1c&H${white}&\\bord0\\shad0\\b1\\fs${f(fs)}`, a.label);
                if (a.key === 'subscribe') ripple(s + 0.9, px + w - 30 * u, my + h / 2 - 10 * u);
                x += w + gap;
            });
            return out;
        }

        /* ── Şerit: tam genişlik bant, çağrılar yan yana, vurgu çizgisi ─── */
        if (overlay.style === 'bar') {
            const h = 150 * u;
            let fs = 52 * u;
            const sep = 70 * u;
            const widths = (size) => actions.map(a => a.label.length * size * 0.6 + size * 0.8 + 16 * u);
            let ws = widths(fs);
            let total = ws.reduce((a, b) => a + b, 0) + sep * (n - 1);
            if (total > X * 0.9) {
                fs = Math.max(32 * u, fs * X * 0.9 / total);
                ws = widths(fs);
                total = ws.reduce((a, b) => a + b, 0) + sep * (n - 1);
            }
            const bx = X / 2; // şerit tam genişlik: yatay konum yok
            const move = `\\move(${f(bx - X)},${f(cy)},${f(bx)},${f(cy)},0,350)`;
            draw(10, 0, len, `\\an5${move}${fad}\\1c&H${brand}&\\1a&H20&\\bord0\\shad0`, `m 0 0 l ${f(X)} 0 l ${f(X)} ${f(h)} l 0 ${f(h)}`);
            const ly = cy + h / 2 - 3 * u;
            draw(10, 0, len, `\\an5\\move(${f(bx - X)},${f(ly)},${f(bx)},${f(ly)},0,350)${fad}\\1c&H${accent}&\\bord0\\shad0`, `m 0 0 l ${f(X)} 0 l ${f(X)} ${f(6 * u)} l 0 ${f(6 * u)}`);
            let x = bx - total / 2;
            actions.forEach((a, i) => {
                const s = Math.min(0.35 + i * 0.35, Math.max(0.35, len - 1));
                const iconSize = fs * 0.8;
                icon(11, s, len, a.icon, x + iconSize / 2, cy, iconSize, white, `${fad}${pop(iconSize)}`);
                const tx = x + iconSize + 16 * u + (a.label.length * fs * 0.6) / 2;
                ev(11, s, len, `\\an5\\pos(${f(tx)},${f(cy)})${fad}${textPop}\\1c&H${white}&\\bord0\\shad0\\b1\\fs${f(fs)}`, a.label);
                x += ws[i] + sep;
            });
            return out;
        }

        /* ── Kart: satır satır beliren çağrılar, altta kanal adı ─────────── */
        if (overlay.style === 'card') {
            const fs = 54 * u;
            const row = 92 * u;
            const subFs = 38 * u;
            const sub = channel ? `@${escapeAss(String(channel))}` : '';
            const maxLabel = Math.max(...actions.map(a => a.label.length), sub.length * 0.7);
            const w = clamp(maxLabel * fs * 0.6 + 210 * u, 520 * u, X * 0.84);
            const h = 40 * u + n * row + (sub ? 56 * u : 0) + 24 * u;
            const popTags = `\\fscx80\\fscy80\\t(0,260,\\fscx104\\fscy104)\\t(260,420,\\fscx100\\fscy100)`;
            draw(10, 0, len, `\\an5\\pos(${f(cx)},${f(cy)})${fad}${popTags}\\1c&H${brand}&\\bord0\\shad0`, SubscribeCta.roundedRect(w, h, 28 * u));
            const left = cx - w / 2 + 60 * u;
            actions.forEach((a, i) => {
                const s = Math.min(0.3 + i * 0.35, Math.max(0.3, len - 1));
                const y = cy - h / 2 + 40 * u + row * i + row / 2;
                const iconSize = fs * 0.85;
                draw(11, s, len, `\\an5\\move(${f(left - 30 * u)},${f(y)},${f(left)},${f(y)},0,260)${fad}\\fscx${f(iconSize)}\\fscy${f(iconSize)}\\1c&H${white}&\\bord0\\shad0\\p1`, SubscribeCta.ICONS[a.icon]);
                const tx = left + iconSize / 2 + 26 * u + (a.label.length * fs * 0.6) / 2;
                ev(11, s, len, `\\an5\\move(${f(tx - 30 * u)},${f(y)},${f(tx)},${f(y)},0,260)${fad}\\1c&H${white}&\\bord0\\shad0\\b1\\fs${f(fs)}`, a.label);
            });
            if (sub) ev(11, 0.3, len, `\\an5\\pos(${f(cx)},${f(cy + h / 2 - 24 * u - 28 * u)})${fad}\\1c&H${white}&\\alpha&H50&\\bord0\\shad0\\fs${f(subFs)}`, sub);
            ripple(1.1, cx + w / 2 - 30 * u, cy + h / 2 - 12 * u);
            return out;
        }

        /* ── Tıkla: beyaz alt şerit, abone butonu, imleç sırayla tıklar ──── */
        if (overlay.style === 'cursor') {
            const order = SubscribeCta.actionsOf(overlay, ['subscribe', 'like', 'comment']);
            const panelH = 190 * u;
            const btnFs = 46 * u;
            const btnH = 96 * u;
            const subA = order.find(a => a.key === 'subscribe');
            const btnW = subA ? subA.label.length * btnFs * 0.6 + 100 * u : 0;
            const iconSize = 66 * u;
            const slot = 150 * u;
            const others = order.filter(a => a.key !== 'subscribe');
            const bellW = subA ? slot : 0;
            const content = (subA ? btnW + 30 * u : 0) + bellW + others.length * slot;
            const w = clamp(content + 90 * u, 600 * u, X * 0.92);
            const left = cx - (content) / 2;
            draw(10, 0, len, `\\an5\\move(${f(cx)},${f(cy + 80 * u)},${f(cx)},${f(cy)},0,320)${fad}\\1c&H${white}&\\1a&H12&\\bord0\\shad0`, SubscribeCta.roundedRect(w, panelH, 30 * u));
            // Zaman çizelgesi: imleç giriş, her hedefte dur + tıkla, çıkış. Pencereye sığdırılır.
            const targets = [];
            let x = left;
            if (subA) {
                targets.push({ key: 'subscribe', x: x + btnW / 2, y: cy, w: btnW });
                x += btnW + 30 * u;
                targets.push({ key: 'bell', x: x + slot / 2, y: cy - 14 * u });
                x += slot;
            }
            for (const a of others) {
                targets.push({ key: a.key, x: x + slot / 2, y: cy - 14 * u, label: a.label, icon: a.icon });
                x += slot;
            }
            const steps = targets.length;
            const k = Math.min(1, (len - 0.9) / (0.9 + steps * 0.8 + 0.4));
            const legs = [{ x: cx + w / 2 + 40 * u, y: cy + panelH, t: 0.35 }];
            const clicks = [];
            const clickAt = [];
            targets.forEach((t, i) => {
                const arrive = (0.9 + i * 0.8) * k + 0.35;
                legs.push({ x: t.x + 6 * u, y: t.y + 10 * u, t: arrive });
                clicks.push(legs.length - 1);
                clickAt.push(arrive + 0.08);
                legs.push({ x: t.x + 6 * u, y: t.y + 10 * u, t: arrive + 0.45 * k });
            });
            legs.push({ x: cx + w / 2 + 60 * u, y: cy + panelH, t: Math.min(len, legs[legs.length - 1].t + 0.5) });
            cursor(legs, clicks);
            targets.forEach((t, i) => {
                const c = clickAt[i];
                if (t.key === 'subscribe') {
                    const before = Math.min(c, len);
                    draw(10, 0.2, before, `\\an5\\pos(${f(t.x)},${f(t.y)})${fad}\\1c&H${brand}&\\bord0\\shad0`, SubscribeCta.roundedRect(btnW, btnH, 20 * u));
                    ev(11, 0.2, before, `\\an5\\pos(${f(t.x)},${f(t.y)})${fad}\\1c&H${white}&\\bord0\\shad0\\b1\\fs${f(btnFs)}`, subA.label);
                    if (c < len) {
                        draw(10, c, len, `\\an5\\pos(${f(t.x)},${f(t.y)})\\1c&H${accent}&\\bord0\\shad0\\fscx96\\fscy96\\t(0,160,\\fscx100\\fscy100)`, SubscribeCta.roundedRect(btnW, btnH, 20 * u));
                        const checkSize = btnFs * 0.8;
                        icon(11, c, len, 'check', t.x - btnW / 2 + 34 * u + checkSize / 2, t.y, checkSize, white);
                        ev(11, c, len, `\\an5\\pos(${f(t.x + checkSize / 2 + 8 * u)},${f(t.y)})\\1c&H${white}&\\bord0\\shad0\\b1\\fs${f(btnFs * 0.92)}`, subA.label);
                    }
                } else if (t.key === 'bell') {
                    const before = Math.min(c, len);
                    icon(11, 0.2, before, 'bell', t.x, t.y, iconSize, ink, fad);
                    if (c < len) {
                        // Çalma: üstten asılı sallanır
                        icon(11, c, len, 'bell', t.x, t.y, iconSize, brand, `\\org(${f(t.x)},${f(t.y - iconSize / 2)})\\t(0,120,\\frz18)\\t(120,260,\\frz-16)\\t(260,400,\\frz10)\\t(400,520,\\frz0)`);
                    }
                    ev(11, 0.2, len, `\\an5\\pos(${f(t.x)},${f(cy + 58 * u)})${fad}\\1c&H${ink}&\\bord0\\shad0\\fs${f(26 * u)}`, 'Zil');
                } else {
                    const before = Math.min(c, len);
                    icon(11, 0.2, before, t.icon, t.x, t.y, iconSize, ink, fad);
                    if (c < len) icon(11, c, len, t.icon, t.x, t.y, iconSize, t.key === 'like' ? accent : brand, pop(iconSize, 0.8));
                    ev(11, 0.2, len, `\\an5\\pos(${f(t.x)},${f(cy + 58 * u)})${fad}\\1c&H${ink}&\\bord0\\shad0\\fs${f(26 * u)}`, t.label);
                }
            });
            return out;
        }

        /* ── Simgeler: daire içinde üç simge, sırayla belirip tıklanır ───── */
        if (overlay.style === 'icons') {
            const d = 150 * u;
            const gap = 50 * u;
            const total = n * d + (n - 1) * gap;
            const left = cx - total / 2;
            actions.forEach((a, i) => {
                const x = left + i * (d + gap) + d / 2;
                const s = Math.min(i * 0.4, Math.max(0, len - 1.5));
                // Hepsi belirdikten sonra sırayla "tıklanır" (renk değişir, dalga)
                const click = Math.min(n * 0.4 + 0.6 + i * 0.45, len - 0.3);
                draw(10, s, len, `\\an5\\pos(${f(x)},${f(cy)})${fad}${pop(d, 0.5)}\\1c&H${ink}&\\1a&H28&\\bord0\\shad0`, SubscribeCta.circle(50));
                icon(11, s, len, a.icon, x, cy, 70 * u, white, `${fad}${pop(70 * u)}`);
                ev(11, s, len, `\\an5\\pos(${f(x)},${f(cy + d / 2 + 32 * u)})${fad}\\1c&H${white}&\\bord0\\shad0\\b1\\fs${f(34 * u)}`, a.label);
                if (click > s + 0.5) {
                    draw(10, click, len, `\\an5\\pos(${f(x)},${f(cy)})\\fscx${f(d)}\\fscy${f(d)}\\1c&H${a.key === 'like' ? accent : brand}&\\bord0\\shad0\\t(0,160,\\fscx${f(d * 1.08)}\\fscy${f(d * 1.08)})\\t(160,320,\\fscx${f(d)}\\fscy${f(d)})`, SubscribeCta.circle(50));
                    icon(11, click, len, a.icon, x, cy, 70 * u, white, pop(70 * u, 0.8));
                    ripple(click, x + d / 2 - 24 * u, cy + d / 2 - 24 * u);
                }
            });
            return out;
        }

        /* ── Yan dizi: sağ kenarda alt alta daireler (sağdan kayar) ───────── */
        if (overlay.style === 'side') {
            const d = 120 * u;
            const step = 170 * u;
            const x = typeof overlay.x === 'number' ? cx : X - 100 * u;
            const top = cy - ((n - 1) * step) / 2;
            actions.forEach((a, i) => {
                const y = top + i * step;
                const s = Math.min(i * 0.35, Math.max(0, len - 1.2));
                const move = `\\move(${f(x + 220 * u)},${f(y)},${f(x)},${f(y)},0,320)`;
                draw(10, s, len, `\\an5${move}${fad}\\fscx${f(d)}\\fscy${f(d)}\\1c&H${a.key === 'subscribe' ? brand : ink}&\\1a&H${a.key === 'subscribe' ? '00' : '30'}&\\bord0\\shad0\\p1`, SubscribeCta.circle(50));
                draw(11, s, len, `\\an5${move}${fad}\\fscx${f(56 * u)}\\fscy${f(56 * u)}\\1c&H${white}&\\bord0\\shad0\\p1`, SubscribeCta.ICONS[a.icon]);
                ev(11, s, len, `\\an5\\move(${f(x + 220 * u)},${f(y + d / 2 + 26 * u)},${f(x)},${f(y + d / 2 + 26 * u)},0,320)${fad}\\1c&H${white}&\\bord0\\shad0\\b1\\fs${f(28 * u)}`, a.label);
                if (a.key === 'subscribe') ripple(s + 1.0, x + d / 2 - 20 * u, y + d / 2 - 20 * u);
            });
            return out;
        }
        return out;
    }

    /**
     * Ayara göre tüm animasyon olayları; kapalıysa ya da klip çok kısaysa boş.
     * middleInsert: ortaya abone kesiti dikilecekse (animasyon dikiş sonrası).
     */
    static overlayEvents(cfg, { duration, format = null, playResX = 1080, playResY = 1920, brandColor, accentColor, channel = null, middleInsert = false, windows = null }) {
        const fmt = format || (playResY > playResX ? 'vertical' : 'horizontal');
        if (!SubscribeCta.overlayActive(cfg, fmt)) return [];
        const overlay = SubscribeCta.overlayFor(cfg, fmt);
        const colors = SubscribeCta.colorsOf(cfg, brandColor, accentColor);
        const wins = windows || SubscribeCta.windows(overlay, duration, { middleInsert });
        const out = [];
        for (const win of wins) out.push(...SubscribeCta.eventsFor(overlay, win, { playResX, playResY, brandColor: colors.primary, accentColor: colors.accent, textColor: colors.text, darkColor: colors.dark, channel }));
        return out;
    }

    /** Yalnız çağrı olaylarını taşıyan ASS dosyası (altyazı yokken). */
    static writeAss(assPath, { playResX = 1080, playResY = 1920, events }) {
        const ass = `[Script Info]
Title: Kesit abone çağrısı
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${SubscribeCta.STYLE_LINE}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
        fs.writeFileSync(assPath, ass, 'utf8');
        return assPath;
    }

    /** Var olan altyazı ASS'ine stil + olayları ekler. */
    static mergeInto(assPath, events) {
        let ass = fs.readFileSync(assPath, 'utf8');
        if (!ass.includes('Style: Cta,')) ass = ass.replace(/\r?\n\[Events\]/, `\n${SubscribeCta.STYLE_LINE}\n\n[Events]`);
        if (!ass.endsWith('\n')) ass += '\n';
        ass += events.join('\n') + '\n';
        fs.writeFileSync(assPath, ass, 'utf8');
        return assPath;
    }

    /**
     * Altyazı dosyası varsa olayları ona katar, yoksa yeni dosya yazar.
     * @returns {string|null} kullanılacak ASS yolu (olay yoksa gelen assPath)
     */
    static attach(events, assPath, fallbackPath, { playResX, playResY }) {
        if (!events.length) return assPath;
        if (assPath && fs.existsSync(assPath)) return SubscribeCta.mergeInto(assPath, events);
        return SubscribeCta.writeAss(fallbackPath, { playResX, playResY, events });
    }

    /* ── Abone kesitini dikme ────────────────────────────────────────────── */

    /**
     * Dikiş planı (saf): nihai çıktı (0) ve kesit (1) girdilerinden concat
     * süzgeç çizgesi. Kesit, çıktının ölçüsüne sığdırılır; oran uymuyorsa
     * arkası bulanık kopyasıyla dolar. Sessiz taraflar sessizlikle tamamlanır.
     */
    static insertPlan({ main, clip, points }) {
        const W = main.width;
        const H = main.height;
        const D = main.duration;
        const fps = fpsString(main.fps);
        const pts = [...new Set(points.map(p => clamp(p, 0, D)))].sort((a, b) => a - b);
        const segs = [];
        let prev = 0;
        for (const p of pts) {
            if (p - prev > 0.05) segs.push({ type: 'main', s: prev, e: p });
            segs.push({ type: 'clip' });
            prev = p;
        }
        if (D - prev > 0.05) segs.push({ type: 'main', s: prev, e: D });
        const mainCount = segs.filter(s => s.type === 'main').length;
        const clipCount = segs.filter(s => s.type === 'clip').length;
        if (!clipCount) return null;

        const parts = [];
        const labels = (p, n) => Array.from({ length: n }, (_, i) => `[${p}${i}]`).join('');
        // Ana video/ses dalları
        if (mainCount) {
            parts.push(`[0:v]split=${mainCount}${labels('mv', mainCount)}`);
            if (main.hasAudio) parts.push(`[0:a]${SES_BICIMI},asplit=${mainCount}${labels('ma', mainCount)}`);
        }
        // Kesit dalı: sığdır (+ bulanık arka plan), kare hızını eşitle
        const ratioOff = clip.width && clip.height ? Math.abs(clip.width / clip.height - W / H) > 0.03 : false;
        if (ratioOff) {
            parts.push('[1:v]split=2[cb][cf]');
            parts.push(`[cb]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=min(w\\,h)/40:2:min(cw\\,ch)/40:2,eq=brightness=-0.08[cbb]`);
            parts.push(`[cf]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos[cff]`);
            parts.push(`[cbb][cff]overlay=(W-w)/2:(H-h)/2,fps=${fps},format=yuv420p,setsar=1[cv]`);
        } else {
            parts.push(`[1:v]scale=${W}:${H}:flags=lanczos,fps=${fps},format=yuv420p,setsar=1[cv]`);
        }
        const clipDur = Math.max(0.1, clip.duration || 0.1).toFixed(3);
        parts.push(clipCount > 1 ? `[cv]split=${clipCount}${labels('cv', clipCount)}` : '[cv]null[cv0]');
        if (clip.hasAudio) {
            parts.push(`[1:a]${SES_BICIMI},apad,atrim=0:${clipDur},asetpts=PTS-STARTPTS${clipCount > 1 ? `,asplit=${clipCount}${labels('ca', clipCount)}` : '[ca0]'}`);
        }

        const order = [];
        let mi = 0;
        let ci = 0;
        for (const seg of segs) {
            const idx = order.length;
            if (seg.type === 'main') {
                parts.push(`[mv${mi}]trim=start=${seg.s.toFixed(3)}:end=${seg.e.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p,setsar=1[v${idx}]`);
                if (main.hasAudio) parts.push(`[ma${mi}]atrim=start=${seg.s.toFixed(3)}:end=${seg.e.toFixed(3)},asetpts=PTS-STARTPTS[a${idx}]`);
                else parts.push(`anullsrc=r=48000:cl=stereo:d=${(seg.e - seg.s).toFixed(3)},${SES_BICIMI}[a${idx}]`);
                mi++;
            } else {
                parts.push(`[cv${ci}]null[v${idx}]`);
                if (clip.hasAudio) parts.push(`[ca${ci}]anull[a${idx}]`);
                else parts.push(`anullsrc=r=48000:cl=stereo:d=${clipDur},${SES_BICIMI}[a${idx}]`);
                ci++;
            }
            order.push(`[v${idx}][a${idx}]`);
        }
        parts.push(`${order.join('')}concat=n=${order.length}:v=1:a=1[outv][outa]`);
        return { filterGraph: parts.join(';'), segments: segs.length, clipCount, addedSeconds: clipCount * (clip.duration || 0) };
    }

    /**
     * Kesiti verilen noktalara diker; `outputPath` yeni dosyadır (çağıran
     * üstüne taşır). @returns {{clipCount:number, addedSeconds:number}}
     */
    static async insertClip({ inputPath, outputPath, clipPath, points, main = null, clip = null }) {
        const mainInfo = main || await IntroStore.probe(inputPath);
        const clipInfo = clip || await IntroStore.probe(clipPath);
        if (!clipInfo.hasVideo || !(clipInfo.duration > 0)) throw new Error('Abone kesiti okunamadı');
        const plan = SubscribeCta.insertPlan({ main: mainInfo, clip: clipInfo, points });
        if (!plan) return { clipCount: 0, addedSeconds: 0 };
        const total = (mainInfo.duration || 0) + plan.addedSeconds;
        const timeout = Math.max(600000, Math.round(total * 10000));
        // GPU ile kodlanır; GPU hata verirse işlemciyle bir kez daha
        await VideoEncoder.withFallback('h264', enc => new Promise((resolve, reject) => {
            const cozme = VideoEncoder.inputArgs(enc);
            execFile('ffmpeg', [
                '-y', '-loglevel', 'error',
                ...cozme, '-i', inputPath, ...cozme, '-i', clipPath,
                '-filter_complex', plan.filterGraph,
                '-map', '[outv]', '-map', '[outa]',
                ...VideoEncoder.videoArgs(enc, { width: mainInfo.width, height: mainInfo.height, fps: mainInfo.fps }),
                '-c:a', 'aac', '-b:a', '160k',
                '-movflags', '+faststart',
                outputPath,
            ], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
                if (err) return reject(VideoEncoder.markAbort(new Error(`Abone kesiti dikilemedi: ${String(stderr || err.message).slice(0, 300)}`), err));
                resolve();
            });
        }), { label: 'Abone kesiti' });
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 10000) throw new Error('Abone kesiti dikilemedi: çıktı boş');
        return { clipCount: plan.clipCount, addedSeconds: plan.addedSeconds };
    }

    /** Yüklenen kesiti doğrular ve hedefe yerleştirir (geçici dosya silinir). */
    static async saveClip(tmpPath, targetPath) {
        try {
            const size = fs.statSync(tmpPath).size;
            if (size === 0) throw new Error('Boş dosya');
            if (size > CLIP_MAX_BYTES) throw new Error(`Abone kesiti ${Math.round(CLIP_MAX_BYTES / 1048576)} MB'dan küçük olmalı`);
            let info;
            try { info = await IntroStore.probe(tmpPath); } catch { throw new Error('Dosya bir video olarak okunamadı — MP4/MOV yükleyin'); }
            if (!info.hasVideo) throw new Error('Dosyada video akışı yok');
            if (!(info.duration > 0)) throw new Error('Video süresi okunamadı');
            if (info.duration > CLIP_MAX_SECONDS) throw new Error(`Abone kesiti en fazla ${CLIP_MAX_SECONDS} saniye olabilir`);
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.copyFileSync(tmpPath, targetPath);
        } finally {
            try { fs.unlinkSync(tmpPath); } catch { /* yok */ }
        }
        return SubscribeCta.clipInfo(targetPath);
    }

    /** Panel için dosya bilgisi; yoksa `{ exists: false }`. */
    static async clipInfo(p) {
        if (!p || !fs.existsSync(p)) return { exists: false };
        let info = {};
        try { info = await IntroStore.probe(p); } catch { /* bozuk dosya: listelenir, kaldırılabilir */ }
        return {
            exists: true,
            path: p,
            sizeBytes: fs.statSync(p).size,
            durationSec: Math.round((info.duration || 0) * 10) / 10,
            width: info.width || 0,
            height: info.height || 0,
            hasAudio: !!info.hasAudio,
        };
    }

    /**
     * Önizleme: düz (ya da verilen kare üstüne) arka planda animasyonu
     * tek pencerede oynatan kısa MP4 üretir.
     */
    static async renderPreview({ cfg, outputPath, playResX = 1080, playResY = 1920, outW = null, outH = null, brandColor, accentColor, channel = null, framePath = null, workDir }) {
        // Önizleme yarı boyutta kodlanır; ASS PlayRes'i gerçek ölçü kalır (libass ölçekler).
        const W = outW || playResX;
        const H = outH || playResY;
        // Önizleme her zaman çizer: anahtar kapalı olsa da bu biçim açık sayılır.
        const format = playResY > playResX ? 'vertical' : 'horizontal';
        const overlay = { ...cfg.overlay, enabled: true, formats: { ...cfg.overlay.formats, [format]: { ...cfg.overlay.formats[format], enabled: true } } };
        const win = { start: 0.6, end: 0.6 + overlay.seconds, at: 'start' };
        const events = SubscribeCta.overlayEvents({ ...cfg, overlay }, { duration: win.end + 1, format, playResX, playResY, brandColor, accentColor, channel, windows: [win] });
        const assPath = path.join(workDir, `cta-preview-${Date.now()}.ass`);
        SubscribeCta.writeAss(assPath, { playResX, playResY, events });
        const total = (win.end + 0.8).toFixed(2);
        const escaped = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
        const useFrame = framePath && fs.existsSync(framePath);
        const input = useFrame
            ? ['-loop', '1', '-framerate', '30', '-t', total, '-i', framePath]
            : ['-f', 'lavfi', '-i', `color=c=0x1b1d22:s=${W}x${H}:r=30:d=${total}`];
        const vf = (useFrame ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},eq=brightness=-0.08,` : '') + `subtitles='${escaped}',format=yuv420p`;
        try {
            await VideoEncoder.withFallback('h264', enc => new Promise((resolve, reject) => {
                const video = VideoEncoder.videoArgs(enc, { quality: 'draft', width: W, height: H, fps: 30 });
                execFile('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-vf', vf, '-t', total, ...video, '-an', '-movflags', '+faststart', outputPath],
                    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, _o, stderr) => (err ? reject(VideoEncoder.markAbort(new Error(`Önizleme üretilemedi: ${String(stderr || err.message).slice(0, 200)}`), err)) : resolve()));
            }), { label: 'Abone önizlemesi' });
        } finally {
            try { fs.unlinkSync(assPath); } catch { /* yok */ }
        }
        return outputPath;
    }
}

module.exports = SubscribeCta;
