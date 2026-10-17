/**
 * Transcriber — transkript, önem sıralama ve ASS altyazı üretimi
 *
 * 1. Videodan 16kHz mono WAV çıkarır
 * 2. Transkript: ELEVENLABS_API_KEY tanımlıysa ElevenLabs Scribe (speech-to-text,
 *    kelime zaman damgalı); değilse veya hata verirse yerel whisper.cpp fallback
 * 3. Segmentleri önem derecesine göre puanlar:
 *    ses yüksekliği (RMS) + heyecan kelimeleri + ünlem/soru + büyük harf oranı
 * 4. Videoya gömülecek stilize ASS altyazı dosyası üretir
 */
const { spawn, execFile } = require('./ProcTracker');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Kesit: ikili ve model yolu çalışma anında okunur — model Ayarlar'dan
// indirilebildiği için süreç açıkken değişebilir (bkz. server/services/Captions.ts).
const whisperBin = () => process.env.WHISPER_BIN || 'whisper-cli';

/**
 * whisper-cli'nin yolu (platformdan bağımsız): WHISPER_BIN tam yolsa o,
 * değilse PATH dizinlerinde whisper-cli / whisper-cli.exe / whisper-cpp aranır.
 * `which` kullanılmaz — Windows'ta yok, ayrıca Kesit App PATH'i kendisi kurar.
 */
function findWhisperBin() {
    const env = process.env.WHISPER_BIN;
    if (env && path.isAbsolute(env)) return fs.existsSync(env) ? env : null;
    const names = env ? [env] : process.platform === 'win32' ? ['whisper-cli.exe', 'whisper-cli'] : ['whisper-cli', 'whisper-cpp'];
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
    for (const dir of dirs) {
        for (const name of names) {
            const p = path.join(dir, name);
            try {
                if (fs.statSync(p).isFile()) return p;
            } catch { /* yok */ }
        }
    }
    return null;
}
const whisperModel = () => process.env.WHISPER_MODEL || '';

const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const SEGMENT_MAX_CHARS = 38;  // altyazı satırı başına maksimum karakter
const SEGMENT_MAX_GAP = 0.8;   // saniye — bu kadar sessizlikte segment böl

// Whisper'ın sessizlikte ürettiği bilinen Türkçe halüsinasyon kalıpları
const HALLUCINATION_PATTERNS = [
    /altyaz[ıi]/i,
    /abone ol/i,
    /izledi[ğg]iniz i[çc]in te[şs]ekk[üu]r/i,
    /kanal[ıi]ma ho[şs] geldiniz/i,
    /www\./i,
    /subscribe/i,
    /thanks for watching/i,
];

// Türkçe yayın/hype bağlamında önem taşıyan kelimeler
const HYPE_WORDS = [
    'oha', 'vay', 'inanılmaz', 'inanilmaz', 'efsane', 'muhteşem', 'muhtesem',
    'aman', 'yok artık', 'yok artik', 'harika', 'süper', 'super', 'bravo',
    'delirdi', 'çıldır', 'cildir', 'kazandık', 'kazandik', 'kaybettik',
    'öldüm', 'oldum', 'öldürdüm', 'oldurdum', 'win', 'clutch', 'ace',
    'insane', 'crazy', 'omg', 'wtf', 'lets go', "let's go", 'gg',
];

class Transcriber {
    /**
     * En az bir transkript motoru kullanılabilir mi?
     */
    static isAvailable() {
        return Transcriber.hasElevenLabs() || Transcriber.hasWhisper();
    }

    static hasElevenLabs() {
        return !!process.env.ELEVENLABS_API_KEY;
    }

    static hasWhisper() {
        if (!whisperModel() || !fs.existsSync(whisperModel())) return false;
        return !!findWhisperBin();
    }

    /**
     * Videoyu transkribe et — önce ElevenLabs (anahtar varsa), sonra whisper
     * @param {object} opts - { language: 'tr'|'en'|null } — dil ipucu; otomatik
     *   tespit gürültülü yayın sesinde yanılabildiğinden doğruluğu artırır
     * @returns {{segments: Array<{start,end,text,score}>, language: string, engine: string}|null}
     */
    async transcribe(videoPath, workDir, { language = null, durationSec = 0 } = {}) {
        if (!Transcriber.isAvailable()) return null;

        fs.mkdirSync(workDir, { recursive: true });
        const wavPath = path.join(workDir, 'audio.wav');

        // Adaptif timeout: sabit 120 sn uzun kliplerde meşru işi SIGTERM ile
        // kesiyordu — klip süresiyle ölçeklenir
        const ffTimeout = Math.max(120000, Math.round(durationSec * 4000));

        // 1. WAV çıkar
        await this._run('ffmpeg', [
            '-y', '-loglevel', 'error',
            '-i', videoPath,
            '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
            wavPath,
        ], ffTimeout);

        // 2. Transkript motoru seçimi
        let result = null;
        if (Transcriber.hasElevenLabs()) {
            result = await this._transcribeElevenLabs(wavPath, language, ffTimeout).catch(err => {
                console.error(`[Transcriber] ElevenLabs hatası, whisper'a düşülüyor: ${err.message.slice(0, 200)}`);
                return null;
            });
        }
        if (!result && Transcriber.hasWhisper()) {
            result = await this._transcribeWhisper(wavPath, workDir, language, durationSec).catch(err => {
                console.error(`[Transcriber] Whisper hatası: ${err.message.slice(0, 200)}`);
                return null;
            });
        }
        if (!result) {
            try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
            return null;
        }

        const segments = result.segments
            .filter(s => s.text.length > 0 && !/^\[.*\]$/.test(s.text) && !/^\(.*\)$/.test(s.text))
            .filter(s => !HALLUCINATION_PATTERNS.some(p => p.test(s.text)));

        if (segments.length === 0) {
            try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
            return { segments: [], language: result.language, engine: result.engine, words: [] };
        }

        // Kelime-bazlı zaman damgaları (bipleme/censor için): ElevenLabs zaten
        // gerçek değerleri verdi (grouping sırasında korundu); whisper.cpp
        // segment-bazlı olduğundan kelimeler segment aralığına karakter
        // uzunluğuyla orantılı yaklaşık dağıtılır (tam hassasiyet değil ama
        // bip için yeterli).
        for (const seg of segments) {
            if (!seg.words) seg.words = this._approximateWords(seg);
        }

        // 3. Önem puanlama
        const loudness = await this._loudnessTimeline(wavPath).catch(() => null);
        this._scoreSegments(segments, loudness);

        try { fs.unlinkSync(wavPath); } catch { /* ignore */ }

        const words = segments.flatMap(s => s.words || []);
        return { segments, language: result.language, engine: result.engine, words };
    }

    /** Segment metnini kelimelere böler, karakter uzunluğuyla orantılı zaman dağıtır (whisper fallback) */
    _approximateWords(segment) {
        const parts = String(segment.text || '').split(/\s+/).filter(Boolean);
        if (parts.length === 0) return [];
        const totalChars = parts.reduce((a, p) => a + p.length, 0) || 1;
        const dur = Math.max(0, segment.end - segment.start);
        let t = segment.start;
        const words = [];
        for (const p of parts) {
            const share = (p.length / totalChars) * dur;
            words.push({ text: p, start: t, end: t + share });
            t += share;
        }
        return words;
    }

    /**
     * ElevenLabs Scribe ile speech-to-text — kelime zaman damgalı
     */
    async _transcribeElevenLabs(wavPath, language = null, timeoutMs = 120000) {
        const form = new FormData();
        const audio = fs.readFileSync(wavPath);
        form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
        form.append('model_id', 'scribe_v1');
        form.append('tag_audio_events', 'false');
        // Dil ipucu — otomatik tespit oyun sesi/müzik altında yanlış dile
        // kayabiliyor (bozuk transkript şikayetinin ana nedeni)
        if (language) form.append('language_code', language);

        const res = await axios.post(ELEVENLABS_STT_URL, form, {
            headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
            timeout: timeoutMs,
            maxBodyLength: Infinity,
        });

        const words = (res.data?.words || []).filter(w => w.type === 'word');
        if (words.length === 0) {
            return { segments: [], language: res.data?.language_code || 'tr', engine: 'elevenlabs' };
        }

        // Kelimeleri altyazı satırı boyutunda segmentlere grupla:
        // karakter sınırı, uzun sessizlik veya cümle sonu noktalamasında böl
        const segments = [];
        let current = null;
        for (const w of words) {
            const text = (w.text || '').trim();
            if (!text) continue;

            const wouldOverflow = current && (current.text.length + 1 + text.length) > SEGMENT_MAX_CHARS;
            const gapTooLong = current && (w.start - current.end) > SEGMENT_MAX_GAP;

            if (!current || wouldOverflow || gapTooLong) {
                if (current) segments.push(current);
                current = { start: w.start, end: w.end, text, words: [{ text, start: w.start, end: w.end }] };
            } else {
                current.text += ' ' + text;
                current.end = w.end;
                current.words.push({ text, start: w.start, end: w.end });
            }

            // Cümle bitiren noktalama — segmenti kapat
            if (current && /[.!?…]$/.test(text) && current.text.length > 12) {
                segments.push(current);
                current = null;
            }
        }
        if (current) segments.push(current);

        return { segments, language: res.data?.language_code || 'tr', engine: 'elevenlabs' };
    }

    /**
     * Yerel whisper.cpp ile transkript
     */
    async _transcribeWhisper(wavPath, workDir, language = null, durationSec = 0) {
        const outPrefix = path.join(workDir, 'transcript');

        // Whisper CPU'da gerçek-zamana yakın çalışır; yoğun makinede uzun
        // klipler 300 sn'yi meşru şekilde aşabilir — süreyle ölçekle
        const whisperTimeout = Math.max(300000, Math.round(durationSec * 8000));

        await this._run(findWhisperBin() || whisperBin(), [
            '-m', whisperModel(),
            '-f', wavPath,
            '-l', language || 'auto',
            '--max-len', '42',
            '--split-on-word',
            '-oj',
            '-of', outPrefix,
            '--no-prints',
        ], whisperTimeout);

        const jsonPath = `${outPrefix}.json`;
        if (!fs.existsSync(jsonPath)) return null;

        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const segments = (data.transcription || []).map(s => ({
            start: (s.offsets?.from ?? 0) / 1000,
            end: (s.offsets?.to ?? 0) / 1000,
            text: (s.text || '').trim(),
        }));

        return { segments, language: data.result?.language || 'tr', engine: 'whisper' };
    }

    /**
     * 0.5s pencereli RMS ses seviyesi zaman çizelgesi
     * @returns {Array<{t: number, rms: number}>}
     */
    async _loudnessTimeline(wavPath) {
        const stderr = await new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', [
                '-i', wavPath,
                '-af', 'astats=metadata=1:reset=0.5,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-',
                '-f', 'null', '-',
            ]);
            const chunks = [];
            proc.stdout.on('data', c => chunks.push(c));
            proc.on('error', reject);
            proc.on('exit', () => resolve(Buffer.concat(chunks).toString()));
        });

        const timeline = [];
        let currentTime = 0;
        for (const line of stderr.split('\n')) {
            const ptsMatch = line.match(/pts_time:([0-9.]+)/);
            if (ptsMatch) currentTime = parseFloat(ptsMatch[1]);
            const rmsMatch = line.match(/RMS_level=(-?[0-9.]+|-inf)/);
            if (rmsMatch) {
                const v = rmsMatch[1] === '-inf' ? -90 : parseFloat(rmsMatch[1]);
                timeline.push({ t: currentTime, rms: v });
            }
        }
        return timeline;
    }

    _scoreSegments(segments, loudness) {
        // Segment başına ortalama RMS
        const rmsValues = [];
        for (const seg of segments) {
            let rms = -60;
            if (loudness && loudness.length > 0) {
                const windows = loudness.filter(l => l.t >= seg.start && l.t <= seg.end + 0.5);
                if (windows.length > 0) {
                    rms = windows.reduce((a, l) => a + l.rms, 0) / windows.length;
                }
            }
            seg._rms = rms;
            rmsValues.push(rms);
        }

        const mean = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
        const std = Math.sqrt(rmsValues.reduce((a, b) => a + (b - mean) ** 2, 0) / rmsValues.length) || 1;

        for (const seg of segments) {
            let score = 0;

            // Ses yüksekliği z-skoru (bağırma/heyecan anları)
            score += Math.max(0, (seg._rms - mean) / std) * 2.0;

            const lower = seg.text.toLowerCase();

            // Heyecan kelimeleri
            for (const wordItem of HYPE_WORDS) {
                if (lower.includes(wordItem)) score += 1.5;
            }

            // Ünlem ve soru işaretleri
            score += Math.min((seg.text.match(/!/g) || []).length * 1.0, 3);
            score += (seg.text.match(/\?/g) || []).length * 0.5;

            // Büyük harf oranı (CAPS bağırma)
            const letters = seg.text.replace(/[^a-zA-ZçğıöşüÇĞİÖŞÜ]/g, '');
            if (letters.length > 4) {
                const upperRatio = letters.replace(/[^A-ZÇĞİÖŞÜ]/g, '').length / letters.length;
                if (upperRatio > 0.6) score += 1.5;
            }

            // Tekrarlı harfler (uzatma: "gooool", "nooo")
            if (/([a-zçğıöşü])\1{2,}/i.test(seg.text)) score += 1.0;

            seg.score = Math.round(score * 100) / 100;
            delete seg._rms;
        }
    }

    /**
     * Stilize ASS altyazı dosyası üret
     * @param {Array<{start,end,text,score}>} segments
     * @param {string} assPath - çıktı yolu
     * @param {object} layout - { playResX, playResY, marginV, fontScale } altyazı konumu.
     *   Stil ölçüleri 1080x1920 dikey düzlem için yazılmıştır; başka bir düzlemde
     *   (yatay) fontScale ile yazı boyutu, kenarlık, gölge ve yan boşluklar
     *   orantılı ölçeklenir. PlayRes çıktının oranıyla aynı olduğundan libass
     *   her çözünürlükte (720p, 1080p, 1440p) aynı oranda çizer.
     * @param {object} style - { key: stil anahtarı, accent: marka rengi }
     */
    buildAss(segments, assPath, layout = {}, style = {}) {
        const SubtitleStyles = require('./SubtitleStyles');
        const playResX = layout.playResX || 1080;
        const playResY = layout.playResY || 1920;
        const marginV = layout.marginV || 640;

        const fontScale = Number(layout.fontScale) > 0 ? Number(layout.fontScale) : 1;
        const theme = SubtitleStyles.build(style.key, {
            accent: style.accent || '#53fc18',
            marginV,
        });
        if (fontScale !== 1) theme.styleLines = Transcriber.scaleStyleLines(theme.styleLines, fontScale);

        // Önem eşiği: en üst %25'lik segmentler vurgulu renkte
        const scores = segments.map(s => s.score).sort((a, b) => b - a);
        const highlightThreshold = scores[Math.floor(scores.length * 0.25)] ?? Infinity;

        const toAssTime = (sec) => {
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = Math.floor(sec % 60);
            const cs = Math.floor((sec % 1) * 100);
            return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
        };

        const escapeAss = (text) => text.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')');

        let ass = `[Script Info]
Title: LivoBot Klip Altyazısı
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${theme.styleLines}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

        for (const seg of segments) {
            const isHighlight = seg.score >= highlightThreshold && seg.score > 1;
            const styleName = isHighlight ? 'Vurgu' : 'Normal';
            const effect = isHighlight ? theme.highlightEffect : theme.effect;
            const text = escapeAss(seg.text);
            ass += `Dialogue: 0,${toAssTime(seg.start)},${toAssTime(seg.end)},${styleName},,0,0,0,,${effect}${text}\n`;
        }

        fs.writeFileSync(assPath, ass, 'utf8');
        return assPath;
    }

    /**
     * "Style:" satırlarında boyuta bağlı alanları ölçekler (saf fonksiyon):
     * Fontsize (2), Outline (16), Shadow (17), MarginL (19), MarginR (20).
     * MarginV ayrıca verildiği için dokunulmaz.
     */
    static scaleStyleLines(lines, k) {
        const SIZE_FIELDS = [2, 16, 17, 19, 20];
        return String(lines).split('\n').map((line) => {
            if (!line.startsWith('Style:')) return line;
            const [head, rest] = [line.slice(0, 6), line.slice(6)];
            const f = rest.split(',');
            for (const i of SIZE_FIELDS) {
                const n = Number(f[i]);
                if (Number.isFinite(n)) f[i] = String(i === 16 || i === 17 ? Math.round(n * k * 10) / 10 : Math.max(1, Math.round(n * k)));
            }
            return head + f.join(',');
        }).join('\n');
    }

    _run(bin, args, timeout = 120000) {
        return new Promise((resolve, reject) => {
            execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) reject(new Error(`${bin} hatası: ${(stderr || err.message).slice(0, 300)}`));
                else resolve(stdout);
            });
        });
    }
}

Transcriber.findWhisperBin = findWhisperBin;

module.exports = Transcriber;
