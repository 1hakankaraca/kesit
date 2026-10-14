import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import type { Server as IOServer } from 'socket.io';
import { config } from '../config.ts';
import { Transcriber } from '../engine.ts';
import type { Store } from '../db/Store.ts';
import { HttpError, badRequest } from '../http.ts';

/** Yerel (whisper.cpp) model: Türkçede en isabetli olan tek seçenek sunulur. */
export const WHISPER_MODELS = [
  { id: 'turbo', file: 'ggml-large-v3-turbo-q5_0.bin', label: 'Whisper Large v3 Turbo', sizeBytes: 574_041_195, hint: 'Türkçede en doğru sonuç; bir kez indirilir, internet olmadan çalışır' },
] as const;

type ModelId = (typeof WHISPER_MODELS)[number]['id'];

const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const KEY_ELEVENLABS = 'captions.elevenlabs_key';
const KEY_MODEL = 'captions.whisper_model';

export interface CaptionsStatus {
  engine: 'elevenlabs' | 'whisper' | null;
  platform: string;
  elevenlabs: { connected: boolean; keyHint: string | null };
  whisper: {
    binary: boolean;
    binaryPath: string | null;
    active: ModelId | null;
    models: { id: ModelId; label: string; hint: string; sizeBytes: number; installed: boolean }[];
    download: { id: ModelId; percent: number } | null;
  };
}

/**
 * Altyazı motoru: ElevenLabs Scribe (bulut, anahtar ister) ya da bu
 * bilgisayarda çalışan whisper.cpp (ücretsiz, model bir kez indirilir).
 * Ayarlar bilgisayar genelidir; motor (Transcriber) değerleri ortam
 * değişkenlerinden çalışma anında okur, bu sınıf onları günceller.
 */
export class Captions {
  private modelsDir = path.join(config.dataDir, 'models');
  private download: { id: ModelId; percent: number; abort: AbortController } | null = null;

  constructor(
    private store: Store,
    private io: IOServer,
  ) {}

  /** Açılışta kayıtlı ayarları motora uygular. */
  apply() {
    const key = this.store.getAppSetting(KEY_ELEVENLABS, { secret: true });
    if (key) process.env.ELEVENLABS_API_KEY = key;
    else if (!process.env.ELEVENLABS_API_KEY) delete process.env.ELEVENLABS_API_KEY;

    const chosen = this.store.getAppSetting(KEY_MODEL) as ModelId | null;
    const installed = WHISPER_MODELS.filter((m) => fs.existsSync(this.modelPath(m.id)));
    const active = installed.find((m) => m.id === chosen) ?? installed[0];
    if (active) process.env.WHISPER_MODEL = this.modelPath(active.id);
  }

  status(): CaptionsStatus {
    const key = this.store.getAppSetting(KEY_ELEVENLABS, { secret: true });
    const activePath = process.env.WHISPER_MODEL;
    const active = WHISPER_MODELS.find((m) => this.modelPath(m.id) === activePath && fs.existsSync(activePath))?.id ?? null;
    const binaryPath = this.binaryPath();
    const binary = !!binaryPath;
    return {
      engine: key ? 'elevenlabs' : binary && active ? 'whisper' : null,
      platform: process.platform,
      elevenlabs: { connected: !!key, keyHint: key ? `••••${key.slice(-4)}` : null },
      whisper: {
        binary,
        binaryPath,
        active,
        models: WHISPER_MODELS.map((m) => ({ id: m.id, label: m.label, hint: m.hint, sizeBytes: m.sizeBytes, installed: fs.existsSync(this.modelPath(m.id)) })),
        download: this.download ? { id: this.download.id, percent: this.download.percent } : null,
      },
    };
  }

  /** ElevenLabs anahtarını doğrular ve kaydeder; null kaldırır. */
  async setElevenLabsKey(raw: string | null) {
    if (raw === null) {
      this.store.setAppSetting(KEY_ELEVENLABS, null);
      delete process.env.ELEVENLABS_API_KEY;
      return this.status();
    }
    const key = raw.trim();
    if (key.length < 20) throw badRequest('Anahtar geçersiz görünüyor');
    try {
      await axios.get('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': key }, timeout: 10_000 });
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      throw badRequest(status === 401 ? 'ElevenLabs anahtarı reddedildi' : 'ElevenLabs\'e ulaşılamadı, bağlantını kontrol et');
    }
    this.store.setAppSetting(KEY_ELEVENLABS, key, { secret: true });
    process.env.ELEVENLABS_API_KEY = key;
    return this.status();
  }

  useModel(id: string) {
    const model = WHISPER_MODELS.find((m) => m.id === id);
    if (!model || !fs.existsSync(this.modelPath(model.id))) throw badRequest('Model kurulu değil');
    this.store.setAppSetting(KEY_MODEL, model.id);
    process.env.WHISPER_MODEL = this.modelPath(model.id);
    return this.status();
  }

  /** Modeli arka planda indirir; ilerleme 'captions:download' olayıyla herkese gider. */
  startDownload(id: string) {
    const model = WHISPER_MODELS.find((m) => m.id === id);
    if (!model) throw badRequest('Bilinmeyen model');
    if (this.download) throw new HttpError(409, 'Zaten bir model iniyor');
    if (!this.hasBinary()) throw badRequest(process.platform === 'win32' ? 'whisper-cli bulunamadı — Kesit App\'te "Kurulumu yeniden çalıştır" ile indirilir' : 'whisper-cli bulunamadı — Kesit App\'teki kurulum ya da "brew install whisper-cpp" ile kurulmalı');
    const abort = new AbortController();
    this.download = { id: model.id, percent: 0, abort };
    void this.runDownload(model, abort).catch(() => {});
    return this.status();
  }

  cancelDownload() {
    this.download?.abort.abort();
  }

  remove(id: string) {
    const model = WHISPER_MODELS.find((m) => m.id === id);
    if (!model) throw badRequest('Bilinmeyen model');
    fs.rmSync(this.modelPath(model.id), { force: true });
    if (process.env.WHISPER_MODEL === this.modelPath(model.id)) delete process.env.WHISPER_MODEL;
    this.apply();
    return this.status();
  }

  private async runDownload(model: (typeof WHISPER_MODELS)[number], abort: AbortController) {
    const target = this.modelPath(model.id);
    const tmp = `${target}.part`;
    fs.mkdirSync(this.modelsDir, { recursive: true });
    const emit = (extra: Record<string, unknown> = {}) => this.io.emit('captions:download', { id: model.id, percent: this.download?.percent ?? 0, ...extra });
    try {
      const res = await axios.get(`${MODEL_BASE}/${model.file}`, { responseType: 'stream', signal: abort.signal, timeout: 30_000 });
      const total = Number(res.headers['content-length']) || model.sizeBytes;
      let received = 0;
      let lastEmit = 0;
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        res.data.on('data', (chunk: Buffer) => {
          received += chunk.length;
          const percent = Math.floor((received / total) * 100);
          if (this.download && percent !== this.download.percent) {
            this.download.percent = percent;
            if (Date.now() - lastEmit > 500) {
              lastEmit = Date.now();
              emit();
            }
          }
        });
        res.data.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        res.data.pipe(out);
      });
      if (fs.statSync(tmp).size < model.sizeBytes * 0.9) throw new Error('Dosya eksik indi');
      fs.renameSync(tmp, target);
      this.download = null;
      this.useModel(model.id);
      emit({ done: true, status: this.status() });
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      this.download = null;
      emit({ failed: true, error: abort.signal.aborted ? 'İndirme iptal edildi' : (err as Error).message, status: this.status() });
    }
  }

  private modelPath(id: ModelId) {
    const model = WHISPER_MODELS.find((m) => m.id === id)!;
    return path.join(this.modelsDir, model.file);
  }

  /** whisper-cli yolu; `which` yerine PATH taranır (Windows'ta da çalışır). */
  private binaryPath(): string | null {
    return (Transcriber.findWhisperBin as () => string | null)();
  }

  private hasBinary() {
    return !!this.binaryPath();
  }
}
