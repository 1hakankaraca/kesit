/**
 * CamFull — "tam ekran bölgesi": kesitin belirli anlarında webcam'in kadrajı
 * tamamen doldurması.
 *
 * Panelde kullanıcı, kesitin üstünde alt aralıklar işaretler (VOD editörü ve
 * kayıt düzenleyici). Aralıklar burada doğrulanır, kesit zamanına çevrilir ve
 * ffmpeg `overlay` filtresinin `enable` ifadesine dönüştürülür; kompozitörler
 * (VerticalComposer / HorizontalComposer) bu anlarda webcam kutusunu tam
 * kadraja büyütülmüş olarak ana görüntünün üstüne bindirir.
 *
 * Zaman referansı: kesit dosyaları `-ss` + `-c copy` ile kesildiğinden dosya
 * istenen andan değil ondan önceki ANAHTAR KAREDEN başlar. Aralıklar kesit
 * dosyasına göre hesaplanırken bu kayma keyframeBefore() ile telafi edilir;
 * aksi hâlde tam ekran anları 1-2 sn erken gelirdi.
 */
const { execFile } = require('child_process');

const MAX_ARALIK = 50;
const MIN_SURE_SN = 0.3;

/**
 * Ham aralık listesini doğrular: sayı olmayanları/kısaları atar, sıralar,
 * çakışanları birleştirir, sayıyı sınırlar. Sonuç kesit zamanına göredir.
 * @param {*} raw
 * @param {object} [p]
 * @param {number} [p.maxDuration] - kesit süresi (biliniyorsa aralıklar buna kıstırılır)
 * @returns {Array<{start:number,end:number}>}
 */
function normalizeCamFullRanges(raw, { maxDuration = Infinity } = {}) {
    if (!Array.isArray(raw)) return [];
    const temiz = raw
        .slice(0, MAX_ARALIK)
        .map(r => ({ start: Number(r?.start), end: Number(r?.end) }))
        .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end))
        .map(r => ({
            start: Math.max(0, Math.min(maxDuration, Math.min(r.start, r.end))),
            end: Math.max(0, Math.min(maxDuration, Math.max(r.start, r.end))),
        }))
        .filter(r => r.end - r.start >= MIN_SURE_SN)
        .sort((a, b) => a.start - b.start);

    const birlesik = [];
    for (const r of temiz) {
        const son = birlesik[birlesik.length - 1];
        if (son && r.start <= son.end) son.end = Math.max(son.end, r.end);
        else birlesik.push({ start: yuvarla(r.start), end: yuvarla(r.end) });
    }
    return birlesik;
}

/**
 * Kaynak (VOD/kayıt) zamanındaki aralıkları kesit dosyası zamanına çevirir.
 * @param {Array<{start:number,end:number}>} ranges - mutlak (kaynak) saniye
 * @param {number} fileStart - kesit dosyasının kaynaktaki gerçek başlangıcı (anahtar kare)
 * @param {number} cutStart - kullanıcının istediği kesit başı
 * @param {number} cutEnd - kullanıcının istediği kesit sonu
 */
function toRelative(ranges, { fileStart, cutStart, cutEnd }) {
    if (!Array.isArray(ranges)) return [];
    const kesitIci = ranges.map(r => ({
        start: Math.max(cutStart, Number(r?.start)),
        end: Math.min(cutEnd, Number(r?.end)),
    }));
    return normalizeCamFullRanges(
        kesitIci.map(r => ({ start: r.start - fileStart, end: r.end - fileStart })),
        { maxDuration: cutEnd - fileStart },
    );
}

/** ffmpeg `enable=` ifadesi: between(t,a,b)+between(t,c,d)… (tek tırnak içinde kullanılır). */
function enableExpr(ranges) {
    return ranges.map(r => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`).join('+');
}

/**
 * `t` anından önceki (ya da tam o andaki) son anahtar karenin zamanı.
 * Okunamazsa `t` döner — o zaman kayma telafi edilmez ama akış bozulmaz.
 * @param {string} file
 * @param {number} t
 * @param {number} [window=6] - geriye doğru taranacak saniye (Kick GOP ~2 sn)
 * @returns {Promise<number>}
 */
function keyframeBefore(file, t, window = 6) {
    const bas = Math.max(0, t - window);
    return new Promise(resolve => {
        execFile('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-skip_frame', 'nokey',
            '-read_intervals', `${bas.toFixed(3)}%${(t + 0.05).toFixed(3)}`,
            '-show_entries', 'frame=pts_time',
            '-of', 'csv=p=0', file,
        ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
            if (err) return resolve(t);
            const zamanlar = String(stdout).split('\n')
                .map(s => parseFloat(s.trim().replace(/,+$/, '')))
                .filter(v => Number.isFinite(v) && v <= t + 0.001);
            resolve(zamanlar.length ? Math.max(...zamanlar) : t);
        });
    });
}

/**
 * Webcam kutusunu W×H kadraja "cover" dolduracak kırpma (oran korunur, fazlalık
 * kırpılır; varsa yüz merkeze alınır). Değerler çift sayıya yuvarlanır.
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function coverCrop(rect, targetW, targetH, face = null) {
    const even = v => Math.max(2, 2 * Math.floor(v / 2));
    const oran = targetW / targetH;
    let h = rect.h;
    let w = h * oran;
    if (w > rect.w) { w = rect.w; h = w / oran; }
    w = even(w); h = even(h);
    const merkezX = face && face.x > rect.x && face.x < rect.x + rect.w ? face.x : rect.x + rect.w / 2;
    const merkezY = face && face.y > rect.y && face.y < rect.y + rect.h ? face.y : rect.y + rect.h / 2;
    const x = even(Math.max(rect.x, Math.min(merkezX - w / 2, rect.x + rect.w - w)));
    const y = even(Math.max(rect.y, Math.min(merkezY - h / 2, rect.y + rect.h - h)));
    return { x, y, w, h };
}

function yuvarla(v) { return Math.round(v * 1000) / 1000; }

module.exports = { normalizeCamFullRanges, toRelative, enableExpr, keyframeBefore, coverCrop, MAX_ARALIK, MIN_SURE_SN };
