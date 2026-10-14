/**
 * IntroStore — kesitlerin başına/sonuna eklenen marka videolarını (intro, outro) yönetir.
 *
 * Her kullanıcının tür başına en fazla bir dosyası vardır ve logo gibi klip
 * dizininin kökünde durur: `<CLIP_OUTPUT_DIR>/<userId>/intro.mp4` ve
 * `outro.mp4`. Yükleme sırasında dosya ffprobe ile doğrulanır (video akışı
 * şart, süre sınırı var); kabul edilen dosya olduğu gibi saklanır —
 * çözünürlük/kare hızı eşitleme üretim anında HorizontalComposer'da yapılır.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLIP_OUTPUT_DIR = process.env.CLIP_OUTPUT_DIR || 'data/clips';
const TURLER = Object.freeze({ intro: 'intro.mp4', outro: 'outro.mp4' });
const DOSYA_ADI = TURLER.intro;
const MAX_SURE_SN = parseInt(process.env.INTRO_MAX_SECONDS) || 60;
const MAX_BOYUT_BYTE = (parseInt(process.env.INTRO_MAX_MB) || 200) * 1024 * 1024;

function turDogrula(tur) {
    if (!TURLER[tur]) throw new Error(`Geçersiz marka videosu türü: ${tur}`);
    return tur;
}

function dosyaYolu(userId, tur) {
    return path.join(CLIP_OUTPUT_DIR, String(userId), TURLER[turDogrula(tur)]);
}

/** Video dosyasının akış bilgisi; okunamazsa hata fırlatır. */
function probe(dosya) {
    return new Promise((resolve, reject) => {
        execFile('ffprobe', [
            '-v', 'error',
            '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration',
            '-of', 'json', dosya,
        ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`ffprobe hatası: ${(stderr || err.message).slice(0, 200)}`));
            let j;
            try { j = JSON.parse(stdout); } catch { return reject(new Error('ffprobe çıktısı okunamadı')); }
            const video = (j.streams || []).find(s => s.codec_type === 'video');
            const audio = (j.streams || []).find(s => s.codec_type === 'audio');
            resolve({
                hasVideo: !!video,
                hasAudio: !!audio,
                width: video?.width || 0,
                height: video?.height || 0,
                fps: video?.r_frame_rate || null,
                duration: parseFloat(j.format?.duration) || 0,
            });
        });
    });
}

/** Kullanıcının bu türde dosyası varsa yolu, yoksa null. */
function getPath(userId, tur) {
    const p = dosyaYolu(userId, tur);
    return fs.existsSync(p) ? p : null;
}

/** Panel için dosya bilgisi; dosya yoksa `{ exists: false }`. */
async function getInfo(userId, tur) {
    const p = getPath(userId, tur);
    if (!p) return { exists: false };
    let bilgi = {};
    try { bilgi = await probe(p); } catch { /* bozuk dosya: yine listelenir, kullanıcı kaldırabilir */ }
    return {
        exists: true,
        path: p,
        sizeBytes: fs.statSync(p).size,
        durationSec: Math.round((bilgi.duration || 0) * 10) / 10,
        width: bilgi.width || 0,
        height: bilgi.height || 0,
        hasAudio: !!bilgi.hasAudio,
    };
}

/**
 * Geçici dosyayı doğrulayıp kullanıcının marka videosu olarak yerleştirir.
 * Hata durumunda geçici dosya silinir, eski dosya (varsa) yerinde kalır.
 */
async function save(userId, tur, geciciDosya) {
    const ad = tur === 'outro' ? 'Outro' : 'Intro';
    try {
        const boyut = fs.statSync(geciciDosya).size;
        if (boyut === 0) throw new Error('Boş dosya');
        if (boyut > MAX_BOYUT_BYTE) throw new Error(`${ad} ${Math.round(MAX_BOYUT_BYTE / 1048576)} MB'dan küçük olmalı`);

        let bilgi;
        try {
            bilgi = await probe(geciciDosya);
        } catch {
            throw new Error('Dosya bir video olarak okunamadı — MP4/MOV yükleyin');
        }
        if (!bilgi.hasVideo) throw new Error('Dosyada video akışı yok');
        if (!(bilgi.duration > 0)) throw new Error('Video süresi okunamadı');
        if (bilgi.duration > MAX_SURE_SN) throw new Error(`${ad} en fazla ${MAX_SURE_SN} saniye olabilir`);

        const hedef = dosyaYolu(userId, tur);
        fs.mkdirSync(path.dirname(hedef), { recursive: true });
        fs.copyFileSync(geciciDosya, hedef);
        fs.unlinkSync(geciciDosya);
    } catch (err) {
        try { fs.unlinkSync(geciciDosya); } catch { /* yok */ }
        throw err;
    }
    return getInfo(userId, tur);
}

function remove(userId, tur) {
    try { fs.unlinkSync(dosyaYolu(userId, tur)); } catch { /* zaten yok */ }
}

// Geriye dönük intro API'si — motorun eski çağrıları bunları kullanır.
const getIntroPath = (userId) => getPath(userId, 'intro');
const getIntro = (userId) => getInfo(userId, 'intro');
const saveIntro = (userId, dosya) => save(userId, 'intro', dosya);
const removeIntro = (userId) => remove(userId, 'intro');
const getOutroPath = (userId) => getPath(userId, 'outro');

module.exports = {
    TURLER, getPath, getInfo, save, remove,
    getIntroPath, getIntro, saveIntro, removeIntro, getOutroPath,
    probe, DOSYA_ADI, MAX_SURE_SN, MAX_BOYUT_BYTE,
};
