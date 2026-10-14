/**
 * SubtitleStyles — ASS altyazı stil kataloğu
 *
 * Rakiplerde (StreamLadder, Opus, Klap) kullanıcı hazır stiller arasından
 * seçiyor. Burada 6 stil sunulur; her biri Normal + Vurgu çifti üretir.
 * Vurgu stili, önem puanı yüksek segmentlerde (üst %25) kullanılır.
 *
 * ASS renk formatı: &HAABBGGRR (alfa-mavi-yeşil-kırmızı, ters sıra!)
 */

/** #RRGGBB → &H00BBGGRR (ASS ters bayt sırası) */
function hexToAss(hex, alpha = '00') {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '&H00FFFFFF';
    const [r, g, b] = [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)];
    return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

/**
 * Stil kataloğu. Her stil bir ASS [V4+ Styles] satır çifti üretir.
 * accent: kullanıcının marka rengi (vurgu stilinde kullanılır)
 */
const STYLES = {
    // Varsayılan: beyaz, kalın kenarlıklı; vurgu marka renginde
    classic: {
        label: 'Klasik',
        hint: 'Beyaz metin, kalın siyah kenarlık — her arka planda okunur',
        build: ({ accent, marginV }) => [
            `Style: Normal,Arial,58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,60,60,${marginV},1`,
            `Style: Vurgu,Arial,64,${hexToAss(accent)},&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,60,60,${marginV},1`,
        ],
        effect: '{\\fad(120,120)}',
    },

    // TikTok tarzı: büyük, sıkı, siyah kutu arkalı
    tiktok: {
        label: 'TikTok',
        hint: 'Kutu arkalı, büyük ve sıkı — mobilde çok net',
        build: ({ accent, marginV }) => [
            `Style: Normal,Arial,62,&H00FFFFFF,&H00FFFFFF,&H00000000,&HC0000000,-1,0,0,0,100,100,0,0,3,6,0,2,70,70,${marginV},1`,
            `Style: Vurgu,Arial,68,${hexToAss(accent)},&H00FFFFFF,&H00000000,&HC0000000,-1,0,0,0,100,100,0,0,3,6,0,2,70,70,${marginV},1`,
        ],
        effect: '{\\fad(80,80)}',
    },

    // Pop: büyük, sarı vurgulu, hafif ölçek animasyonu
    pop: {
        label: 'Pop',
        hint: 'Sarı vurgu + giriş animasyonu — enerjik klipler için',
        build: ({ accent, marginV }) => [
            `Style: Normal,Arial,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,${marginV},1`,
            `Style: Vurgu,Arial,72,&H0000E5FF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,105,105,0,0,1,5,3,2,60,60,${marginV},1`,
        ],
        effect: '{\\fad(60,60)}',
        highlightEffect: '{\\fad(60,60)\\t(0,150,\\fscx112\\fscy112)\\t(150,300,\\fscx100\\fscy100)}',
    },

    // Minimal: ince, gölgesiz, sade
    minimal: {
        label: 'Minimal',
        hint: 'Sade ve ince — sohbet/röportaj klipleri için',
        build: ({ accent, marginV }) => [
            `Style: Normal,Arial,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,80,80,${marginV},1`,
            `Style: Vurgu,Arial,56,${hexToAss(accent)},&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,80,80,${marginV},1`,
        ],
        effect: '{\\fad(200,200)}',
    },

    // Neon: marka renginde parlayan kenarlık
    neon: {
        label: 'Neon',
        hint: 'Marka renginde parlak kenarlık — oyun klipleri için',
        build: ({ accent, marginV }) => [
            `Style: Normal,Arial,60,&H00FFFFFF,&H00FFFFFF,${hexToAss(accent)},&H80000000,-1,0,0,0,100,100,0,0,1,4,4,2,60,60,${marginV},1`,
            `Style: Vurgu,Arial,68,${hexToAss(accent)},&H00FFFFFF,&H00FFFFFF,&H80000000,-1,0,0,0,100,100,0,0,1,4,5,2,60,60,${marginV},1`,
        ],
        effect: '{\\fad(100,100)}',
    },

    // Podcast: alt-orta, geniş, okunaklı; uzun cümleler için
    podcast: {
        label: 'Podcast',
        hint: 'Geniş satır, yumuşak gölge — uzun konuşmalar için',
        build: ({ accent, marginV }) => [
            `Style: Normal,Arial,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,0,0,0,0,100,100,0,0,3,4,0,2,50,50,${marginV},1`,
            `Style: Vurgu,Arial,54,${hexToAss(accent)},&H00FFFFFF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,3,4,0,2,50,50,${marginV},1`,
        ],
        effect: '{\\fad(150,150)}',
    },
};

const DEFAULT_STYLE = 'classic';

/** Panelde listelemek için stil kataloğu */
function listStyles() {
    return Object.entries(STYLES).map(([key, s]) => ({
        key, label: s.label, hint: s.hint,
    }));
}

/** Stil anahtarını doğrula */
function normalize(key) {
    return STYLES[key] ? key : DEFAULT_STYLE;
}

/** ASS [V4+ Styles] satırlarını ve efektleri üret */
function build(key, { accent = '#53fc18', marginV = 640 } = {}) {
    const style = STYLES[normalize(key)];
    const [normal, highlight] = style.build({ accent, marginV });
    return {
        styleLines: `${normal}\n${highlight}`,
        effect: style.effect || '',
        highlightEffect: style.highlightEffect || style.effect || '',
    };
}

module.exports = { STYLES, DEFAULT_STYLE, listStyles, normalize, build, hexToAss };
