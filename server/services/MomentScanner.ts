import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Server as IOServer } from 'socket.io';
import type { Store } from '../db/Store.ts';
import { HighlightDetector, MomentSignals, Transcriber, VisionLLM } from '../engine.ts';
import { HttpError, badRequest, notFound } from '../http.ts';
import type { ChatHistory } from './ChatHistory.ts';

const KEY_CLAUDE = 'ai.anthropic_key';
/** Transkript ve Claude'a gönderilecek en fazla aday. */
const MAX_CANDIDATES = 40;
const KINDS = ['komik', 'heyecanli', 'aksiyon', 'duygusal'] as const;
type Kind = (typeof KINDS)[number];

interface Candidate {
  start: number;
  end: number;
  t: number;
  score: number;
  sources: string[];
  chat: {
    rate: number;
    baseline: number;
    multiple: number;
    users: number;
    laugh: number;
    hype: number;
    sad: number;
    repeat: number;
    top: string[];
    samples: string[];
  } | null;
  audio: { deltaDb: number } | null;
  speechText: string;
}

export interface Moment {
  start: number;
  end: number;
  score: number;
  kind: Kind;
  title: string;
  reason: string;
}

interface Run {
  abort: AbortController;
  procs: Set<ChildProcess>;
}

/**
 * Yayın sonrası an taraması: indirilen yayının tamamında en komik, en
 * heyecanlı, en aksiyonlu ve en duygusal anları bulup liste olarak verir.
 * Hiçbir şey kesmez ya da üretmez — sonuç zaman çizelgesinde işaret ve
 * "Anlar" listesinde görünür.
 *
 * 1. Kick sohbetinin tamamı (patlama, tekil kişi, emote/kahkaha/hüzün) ve
 *    sesin saniyelik seviyesi koşut çıkarılır.
 * 2. MomentSignals iki sinyali (varsa tam transkripti de) birleştirip aday
 *    pencereleri puanlar.
 * 3. Yalnız adayların konuşması yazıya dökülür (tüm yayını değil — hızlı).
 * 4. Claude (anahtar varsa) adayları eleyip kategori + başlık + gerekçe
 *    verir; yoksa sinyallerden kaba etiket üretilir.
 */
export class MomentScanner {
  private runs = new Map<number, Run>();

  constructor(
    private store: Store,
    private io: IOServer,
    private chatHistory: ChatHistory,
  ) {}

  /* ── Claude anahtarı ───────────────────────────────────────────────── */

  /** Açılışta kayıtlı anahtarı motora uygular. */
  apply() {
    const key = this.store.getAppSetting(KEY_CLAUDE, { secret: true });
    if (key) process.env.ANTHROPIC_API_KEY = key;
  }

  aiStatus() {
    const key = this.store.getAppSetting(KEY_CLAUDE, { secret: true }) || process.env.ANTHROPIC_API_KEY || null;
    return {
      claude: { connected: !!key, keyHint: key ? `••••${key.slice(-4)}` : null },
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    };
  }

  /** Claude anahtarını doğrular ve şifreli saklar; null kaldırır. */
  async setClaudeKey(raw: string | null) {
    if (!raw) {
      this.store.setAppSetting(KEY_CLAUDE, null);
      delete process.env.ANTHROPIC_API_KEY;
      return this.aiStatus();
    }
    const key = raw.trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw badRequest('Bu bir Claude API anahtarına benzemiyor (sk-ant- ile başlar)');
    try {
      await VisionLLM.checkClaudeKey(key);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      throw badRequest(status === 401 || status === 403 ? 'Claude anahtarı reddedildi' : 'Claude\'a ulaşılamadı, bağlantını kontrol et');
    }
    this.store.setAppSetting(KEY_CLAUDE, key, { secret: true });
    process.env.ANTHROPIC_API_KEY = key;
    return this.aiStatus();
  }

  /* ── Tarama ────────────────────────────────────────────────────────── */

  isRunning(vodJobId: number) {
    return this.runs.has(vodJobId);
  }

  async start(userId: number, vodJobId: number, { max = 12 }: { max?: number } = {}) {
    const job = await this.store.getVodScanJobById(vodJobId, userId);
    if (!job) throw notFound('Yayın bulunamadı');
    if (!job.vod_path || !fs.existsSync(job.vod_path)) throw badRequest('Yayın dosyası yok — önce yayını indir');
    if (this.runs.has(vodJobId)) return { started: false };
    const run: Run = { abort: new AbortController(), procs: new Set() };
    this.runs.set(vodJobId, run);
    void this.scan(userId, job, Math.min(40, Math.max(1, max)), run)
      .catch((err) => {
        const msg = run.abort.signal.aborted ? 'İptal edildi' : err instanceof Error ? err.message : String(err);
        console.error(`[Anlar] Yayın ${vodJobId} taranamadı:`, msg);
        this.emit(userId, vodJobId, run.abort.signal.aborted ? 'moments-cancelled' : 'moments-failed', msg, 0);
      })
      .finally(() => this.runs.delete(vodJobId));
    return { started: true };
  }

  cancel(vodJobId: number) {
    const run = this.runs.get(vodJobId);
    if (!run) return false;
    run.abort.abort();
    for (const p of run.procs) p.kill('SIGKILL');
    return true;
  }

  private emit(userId: number, vodJobId: number, status: string, step: string, progress: number | null, extra: Record<string, unknown> = {}) {
    this.io.to(`user:${userId}`).emit('vodscan:update', { vodJobId, status, step, progress, ...extra });
  }

  private checkAbort(run: Run) {
    if (run.abort.signal.aborted) throw new HttpError(499, 'İptal edildi');
  }

  private async scan(userId: number, job: any, max: number, run: Run) {
    const id = Number(job.id);
    const vodPath = String(job.vod_path);
    const workDir = path.dirname(vodPath);
    const duration = Number(job.duration_sec) || (await probeDuration(vodPath));
    const settings = await this.store.getSettings(userId).catch(() => null);
    const language = settings?.language === 'en' ? 'en' : 'tr';

    // 1. Sohbet ve ses koşut: ikisi de bitmeden ilerleme ikisinin ortalaması
    let chatPct = 0;
    let audioPct = 0;
    let chatCount = 0;
    const report = () => this.emit(userId, id, 'moments-progress', `sohbet (${chatCount.toLocaleString('tr-TR')} mesaj) ve ses taranıyor`, Math.round(2 + ((chatPct + audioPct) / 2) * 0.48));
    report();

    let chatNote: string | null = null;
    const chatTask = this.chatHistory
      .streamMessages(userId, id, duration, {
        cacheFile: path.join(workDir, 'scan-chat.json'),
        onProgress: (p, c) => {
          chatPct = p;
          chatCount = c;
          report();
        },
      })
      .catch((err: unknown) => {
        chatNote = err instanceof Error ? err.message : String(err);
        console.error(`[Anlar] Yayın ${id} sohbeti alınamadı, yalnız ses ve konuşmayla devam:`, chatNote);
        return [] as { t: number; u: string; x: string }[];
      })
      .finally(() => {
        chatPct = 100;
      });
    const audioTask = this.loudness(vodPath, duration, path.join(workDir, 'scan-loudness.json'), run, (p) => {
      audioPct = p;
      report();
    }).catch((err: unknown) => {
      if (run.abort.signal.aborted) throw err;
      console.error(`[Anlar] Yayın ${id} ses seviyesi çıkarılamadı:`, err instanceof Error ? err.message : err);
      return [] as number[];
    });
    const [chat, levels] = await Promise.all([chatTask, audioTask]);
    this.checkAbort(run);

    // 2. Adaylar (tam transkript önceden çıkarıldıysa o da sinyal olur)
    let speech: { start: number; end: number; score: number; text: string }[] = [];
    try {
      const cached = JSON.parse(fs.readFileSync(path.join(workDir, 'transcript.json'), 'utf8'));
      if (Array.isArray(cached?.segments) && cached.segments.length) speech = new HighlightDetector().clusterWindows(cached.segments);
    } catch {
      /* tam transkript yok — olağan durum */
    }
    const candidates: Candidate[] = MomentSignals.mergeCandidates(
      {
        chat: MomentSignals.chatCandidates(chat, duration),
        audio: MomentSignals.audioCandidates(levels, duration),
        speech,
      },
      duration,
      { limit: MAX_CANDIDATES },
    );
    if (!candidates.length) {
      await this.store.clearUnusedVodHighlights(id);
      const why = chat.length ? 'Belirgin bir sohbet ya da ses patlaması bulunamadı' : 'Sohbet alınamadı ve seste belirgin bir yükselme yok';
      this.emit(userId, id, 'moments-done', why, 100, { count: 0, chatNote });
      return;
    }

    // 3. Yalnız adayların konuşması
    if (Transcriber.isAvailable()) {
      await this.transcribeCandidates(vodPath, workDir, candidates, language, run, (done, total) =>
        this.emit(userId, id, 'moments-progress', `konuşmalar yazıya dökülüyor (${done}/${total})`, 50 + Math.round((done / total) * 35)),
      );
    }
    this.checkAbort(run);

    // 4. Etiket ve seçim
    this.emit(userId, id, 'moments-progress', VisionLLM.isAvailable() ? 'anlar değerlendiriliyor' : 'anlar sıralanıyor', 88);
    const moments = await this.label(candidates, max, chat.length > 0);
    this.checkAbort(run);

    await this.store.clearUnusedVodHighlights(id);
    for (const m of moments) {
      await this.store.addVodHighlight(id, {
        startSec: m.start,
        endSec: m.end,
        score: m.score,
        kind: m.kind,
        reason: m.title ? `${m.title} — ${m.reason}` : m.reason,
      });
    }
    try {
      fs.writeFileSync(path.join(workDir, 'scan-moments.json'), JSON.stringify({ scannedAt: new Date().toISOString(), chatMessages: chat.length, chatNote, moments, candidates }));
    } catch {
      /* yalnız hata ayıklama kaydı */
    }
    this.emit(userId, id, 'moments-done', `${moments.length} an bulundu`, 100, { count: moments.length, chatNote });
  }

  /* ── Ses seviyesi ──────────────────────────────────────────────────── */

  /** Saniyelik RMS (dBFS). Yalnız ses çözülür; 6 saatlik yayın birkaç dakika sürer. */
  private loudness(vodPath: string, duration: number, cacheFile: string, run: Run, onProgress: (pct: number) => void): Promise<number[]> {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached) && cached.length) {
        onProgress(100);
        return Promise.resolve(cached);
      }
    } catch {
      /* yok */
    }
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-nostats', '-hide_banner', '-loglevel', 'error',
        '-i', vodPath, '-vn', '-sn', '-dn',
        '-af', 'aformat=channel_layouts=mono,aresample=8000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-',
        '-f', 'null', '-',
      ]);
      run.procs.add(proc);
      const levels: number[] = [];
      let buf = '';
      let sec = 0;
      let lastPct = -1;
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const pts = /pts_time:([\d.]+)/.exec(line);
          if (pts) {
            sec = Math.round(Number(pts[1]));
            continue;
          }
          const lv = /RMS_level=(-?[\d.]+|-inf|inf|nan)/.exec(line);
          if (lv) {
            const v = Number(lv[1]);
            levels[sec] = Number.isFinite(v) ? v : -90;
            const pct = duration > 0 ? Math.min(99, Math.floor((sec / duration) * 100)) : 0;
            if (pct !== lastPct) {
              lastPct = pct;
              onProgress(pct);
            }
          }
        }
      });
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        run.procs.delete(proc);
        if (run.abort.signal.aborted) return reject(new HttpError(499, 'İptal edildi'));
        if (code !== 0 && !levels.length) return reject(new Error(`ses okunamadı (code ${code}): ${stderr.slice(0, 200)}`));
        const out = Array.from(levels, (v) => (Number.isFinite(v) ? v : -90));
        try {
          fs.writeFileSync(cacheFile, JSON.stringify(out));
        } catch {
          /* önbellek isteğe bağlı */
        }
        onProgress(100);
        resolve(out);
      });
    });
  }

  /* ── Aday konuşmaları ──────────────────────────────────────────────── */

  private async transcribeCandidates(vodPath: string, workDir: string, candidates: Candidate[], language: string, run: Run, onProgress: (done: number, total: number) => void) {
    const cacheFile = path.join(workDir, 'scan-speech.json');
    let cache: Record<string, string> = {};
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {};
    } catch {
      /* yok */
    }
    const todo = candidates.filter((c) => !c.speechText);
    const transcriber = new Transcriber();
    const tmp = path.join(workDir, 'scan-tmp');
    let done = 0;
    for (const c of todo) {
      this.checkAbort(run);
      const key = `${c.start}-${c.end}`;
      if (typeof cache[key] === 'string') {
        c.speechText = cache[key];
      } else {
        const dir = path.join(tmp, key);
        try {
          fs.mkdirSync(dir, { recursive: true });
          const audio = path.join(dir, 'a.m4a');
          await runFfmpeg(['-y', '-loglevel', 'error', '-ss', String(c.start), '-i', vodPath, '-t', String(c.end - c.start), '-vn', '-c:a', 'copy', audio], run);
          const result = await transcriber.transcribe(audio, dir, { language, durationSec: c.end - c.start });
          c.speechText = (result?.segments ?? []).map((s: { text: string }) => s.text).join(' ').replace(/\s+/g, ' ').trim();
          cache[key] = c.speechText;
        } catch (err) {
          if (run.abort.signal.aborted) throw err;
          console.error(`[Anlar] ${key} yazıya dökülemedi:`, err instanceof Error ? err.message : err);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      onProgress(++done, todo.length);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(cache));
    } catch {
      /* isteğe bağlı */
    }
  }

  /* ── Etiketleme ────────────────────────────────────────────────────── */

  private async label(candidates: Candidate[], max: number, hasChat: boolean): Promise<Moment[]> {
    const fallback = (): Moment[] =>
      candidates.slice(0, max).map((c) => {
        const l = MomentSignals.heuristicLabel(c);
        return { start: c.start, end: c.end, score: c.score, kind: l.kind, title: '', reason: l.reason };
      });
    if (!VisionLLM.isAvailable()) return fallback();

    const lines = candidates.map((c, i) => {
      const parts = [`[${i}] ${clock(c.start)}–${clock(c.end)} · sinyal puanı ${c.score} (${c.sources.join('+')})`];
      if (c.chat) {
        parts.push(
          `  sohbet: olağanın ${c.chat.multiple} katı, ${c.chat.users} farklı kişi; kahkaha ${c.chat.laugh}, heyecan ${c.chat.hype}, hüzün ${c.chat.sad}; tekrar oranı ${c.chat.repeat}` +
            (c.chat.top.length ? `; emote: ${c.chat.top.join(', ')}` : ''),
        );
        if (c.chat.samples.length) parts.push(`  mesajlar: ${c.chat.samples.slice(0, 8).map((s) => `"${s}"`).join(' | ')}`);
      }
      if (c.audio) parts.push(`  ses: çevresinden ${c.audio.deltaDb} dB yüksek`);
      if (c.speechText) parts.push(`  konuşma: "${c.speechText.slice(0, 320)}"`);
      return parts.join('\n');
    });

    const prompt = `Sen bir Kick yayın klip kanalının editörüsün. Bir yayının tamamı taranıp ${hasChat ? 'sohbet patlamaları, ses yükselmeleri ve konuşmaya' : 'ses yükselmeleri ve konuşmaya'} göre aday anlar çıkarıldı. Her adayda zaman aralığı, sinyaller ve o aralıktaki konuşma var. Sohbet tepkisi olaydan birkaç saniye sonra gelir.

Adaylar:
${lines.join('\n')}

Görev: Klip kanalı için gerçekten izlenmeye değer en fazla ${max} anı seç ve en güçlüden zayıfa sırala.
- Kategori yalnız şunlardan biri: komik, heyecanli, aksiyon, duygusal.
  komik = kahkaha, şaka, gülünç olay; heyecanli = gerilim, büyük an, sürpriz, tartışma; aksiyon = oyunda/olayda hızlı çatışma, başarı, kaos; duygusal = hüzün, duygulanma, samimi an.
- Yanlış pozitifleri ELE: komut/çekiliş spamı, abone/bağış bildirimi, reklam, müzik, sohbetin olaysız tekrar seli.
- Az ama güçlü seçmek, çok ama vasat seçmekten iyidir.
- title: en fazla 6 kelimelik Türkçe klip başlığı. reason: neden güçlü olduğunu söyleyen tek kısa Türkçe cümle.

SADECE JSON: {"moments":[{"index":0,"kind":"komik","title":"...","reason":"..."}]}`;

    try {
      const d = await VisionLLM.generateJson({ prompt, purpose: 'text', maxOutput: 220 * max + 300, temperature: 0.3, timeout: 120_000, prefer: 'claude' });
      const picks: any[] = Array.isArray(d?.moments) ? d.moments : [];
      const seen = new Set<number>();
      const out: Moment[] = [];
      for (const p of picks) {
        const i = Number(p?.index);
        const c = candidates[i];
        if (!c || seen.has(i)) continue;
        seen.add(i);
        const kind = (KINDS as readonly string[]).includes(p?.kind) ? (p.kind as Kind) : MomentSignals.heuristicLabel(c).kind;
        out.push({
          start: c.start,
          end: c.end,
          score: c.score,
          kind,
          title: String(p?.title || '').slice(0, 80),
          reason: String(p?.reason || '').slice(0, 300),
        });
        if (out.length >= max) break;
      }
      return out.length ? out : fallback();
    } catch (err) {
      console.error('[Anlar] Etiketleme hatası, sinyal etiketine düşülüyor:', err instanceof Error ? err.message : err);
      return fallback();
    }
  }
}

function clock(sec: number) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function runFfmpeg(args: string[], run: Run): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    run.procs.add(proc);
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      run.procs.delete(proc);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg (code ${code}): ${stderr.slice(0, 200)}`));
    });
  });
}

function probeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    let out = '';
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.on('error', () => resolve(0));
    proc.on('exit', () => resolve(Number(out.trim()) || 0));
  });
}
