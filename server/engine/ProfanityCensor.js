/**
 * ProfanityCensor — kelime-bazlı zaman damgalı transkriptten küfür/argo
 * geçen zaman aralıklarını bulur. Ses işleme (bipleme) BURADA yapılmaz —
 * yalnızca hangi [start,end] aralıklarının bipleneceğini hesaplar
 * (uygulama: AudioCensor).
 *
 * İki eşleşme modu:
 *  - PREFIX_STEMS: kelimenin TAMAMI kökle başlamalı (Türkçe sondan eklemeli
 *    yapı nedeniyle — "sik" kökü "sikik"/"siktiğim"/"sikeyim" gibi tüm
 *    çekimleri yakalar). Yaygın masum kelimeyle çakışma riski düşük köklerde
 *    kullanılır.
 *  - WHOLE_WORD_STEMS: yalnız TAM eşleşme. "göt" gibi çok kısa/çok anlamlı
 *    kökler prefix modunda kullanılırsa "götürmek" (taşımak) gibi son
 *    derece yaygın masum fiilleri yanlış yakalar — bu yüzden yalnız bilinen
 *    çekim biçimleriyle sınırlı tutulur.
 */

const TR_MAP = { ı: 'i', ğ: 'g', ü: 'u', ş: 's', ö: 'o', ç: 'c' };

function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .split('')
        .map(ch => TR_MAP[ch] ?? ch)
        .join('')
        .replace(/[^a-z0-9]/g, '');
}

const PREFIX_STEMS = [
    'amk', 'amina', 'amcik', 'yavsak', 'orospu', 'kahpe', 'serefsiz',
    'sik', 'yarrak', 'yarak', 'ibne', 'surtuk', 'pic',
].map(normalize);

const WHOLE_WORD_STEMS = [
    'got', 'gotu', 'gote', 'gotum', 'gotun', 'gotune', 'gotveren', 'gotlek',
].map(normalize);

class ProfanityCensor {
    /** Tek bir kelime küfür kökleriyle eşleşiyor mu? */
    static isMatch(word) {
        const w = normalize(word);
        if (!w) return false;
        if (WHOLE_WORD_STEMS.includes(w)) return true;
        return PREFIX_STEMS.some(stem => w.startsWith(stem));
    }

    /**
     * @param {Array<{text: string, start: number, end: number}>} words - kelime-bazlı zaman damgaları
     * @param {number} padSec - her eşleşmenin başına/sonuna eklenecek tampon (bip kelimeyi tam kapasın diye)
     * @returns {Array<{start: number, end: number}>} birleştirilmiş, çakışmayan bip aralıkları (zaman sıralı)
     */
    static detectRanges(words, { padSec = 0.08 } = {}) {
        const hits = (words || [])
            .filter(w => ProfanityCensor.isMatch(w.text))
            .map(w => ({ start: Math.max(0, (w.start ?? 0) - padSec), end: (w.end ?? w.start ?? 0) + padSec }))
            .filter(r => r.end > r.start);
        return ProfanityCensor._mergeRanges(hits);
    }

    /** Çakışan/bitişik aralıkları tek aralıkta birleştirir */
    static _mergeRanges(ranges) {
        if (ranges.length === 0) return [];
        const sorted = [...ranges].sort((a, b) => a.start - b.start);
        const merged = [{ ...sorted[0] }];
        for (let i = 1; i < sorted.length; i++) {
            const last = merged[merged.length - 1];
            if (sorted[i].start <= last.end) {
                last.end = Math.max(last.end, sorted[i].end);
            } else {
                merged.push({ ...sorted[i] });
            }
        }
        return merged;
    }
}

module.exports = ProfanityCensor;
