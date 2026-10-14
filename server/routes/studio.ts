import express from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.ts';
import type { AppContext } from '../context.ts';
import { ClipEditorManager, IntroStore, RecordingFinalizer, SubtitleStyles } from '../engine.ts';
import { HttpError, badRequest, engine, receiveFile } from '../http.ts';

const run = promisify(execFile);
const HEX = /^#[0-9a-f]{6}$/i;
const LOGO_MAX_BYTES = 5 * 1024 * 1024;
const BRAND_KINDS = ['intro', 'outro'] as const;
type BrandKind = (typeof BRAND_KINDS)[number];

const userDir = (userId: number) => path.join(config.clipDir, String(userId));
const fileUrl = (userId: number, name: string) => `/clips/${userId}/${name}?t=${Date.now()}`;

function parseJson(value: unknown): Record<string, any> {
  try {
    return (typeof value === 'string' && JSON.parse(value)) || {};
  } catch {
    return {};
  }
}

function brandKind(value: unknown): BrandKind {
  if (!BRAND_KINDS.includes(value as BrandKind)) throw badRequest('Tür intro ya da outro olmalı');
  return value as BrandKind;
}

async function mediaInfo(userId: number, kind: BrandKind) {
  const info = await IntroStore.getInfo(userId, kind);
  return {
    exists: !!info.exists,
    url: info.exists ? fileUrl(userId, IntroStore.TURLER[kind]) : null,
    durationSec: info.durationSec ?? null,
    sizeBytes: info.sizeBytes ?? null,
    width: info.width ?? null,
    height: info.height ?? null,
    hasAudio: info.hasAudio ?? null,
  };
}

/**
 * Stüdyo: marka kiti (logo, intro, outro, renkler, altyazı stili), üretim
 * varsayılanları (gruplara göre) ve kayıt çıktısı ayarları.
 */
export function studioRoutes({ store, workspaces }: AppContext) {
  const r = express.Router();

  r.get('/studio', async (req, res) => {
    const userId = req.user!.id;
    const s = await store.getSettings(userId);
    const saved = parseJson(s.clip_defaults);
    const defaults = Object.fromEntries(
      ClipEditorManager.SETTINGS_GROUPS.map((g: string) => [g, ClipEditorManager.normalizeClipOptions(ClipEditorManager._extractGroupDefaults(saved, g))]),
    );
    const ws = await workspaces.get(userId);
    const logo = ws.clipEditor.getLogoPath();
    res.json({
      styles: SubtitleStyles.listStyles(),
      brand: {
        subtitleStyle: s.subtitle_style || 'classic',
        brandColor: s.brand_color,
        accentColor: s.accent_color,
        language: s.language || 'tr',
      },
      groups: ClipEditorManager.SETTINGS_GROUPS,
      defaults,
      logo: { exists: !!logo, url: logo ? fileUrl(userId, 'logo.png') : null },
      intro: await mediaInfo(userId, 'intro'),
      outro: await mediaInfo(userId, 'outro'),
      limits: { mediaMaxSeconds: IntroStore.MAX_SURE_SN, mediaMaxBytes: IntroStore.MAX_BOYUT_BYTE, logoMaxBytes: LOGO_MAX_BYTES },
      recordingOutput: await ws.finalizer.getOptions(),
      hevcAvailable: await RecordingFinalizer.hevcVarMi(),
    });
  });

  r.put('/studio/brand', async (req, res) => {
    const b = req.body || {};
    const data: Record<string, string> = {};
    if (b.subtitleStyle !== undefined) data.subtitle_style = SubtitleStyles.normalize(String(b.subtitleStyle));
    if (HEX.test(b.brandColor)) data.brand_color = b.brandColor;
    if (HEX.test(b.accentColor)) data.accent_color = b.accentColor;
    if (['tr', 'en'].includes(b.language)) data.language = b.language;
    if (!Object.keys(data).length) throw badRequest('Güncellenecek alan yok');
    await store.updateSettings(req.user!.id, data);
    res.json({ ok: true });
  });

  r.put('/studio/defaults', async (req, res) => {
    const groups: string[] = ClipEditorManager.SETTINGS_GROUPS;
    const group = groups.includes(req.body?.group) ? req.body.group : null;
    if (!group) throw badRequest('Geçersiz ayar grubu');
    const defaults = ClipEditorManager.normalizeClipOptions(req.body?.options || {});
    const s = await store.getSettings(req.user!.id);
    const parsed = parseJson(s.clip_defaults);
    const grouped = groups.every((g) => parsed[g] && typeof parsed[g] === 'object')
      ? { ...parsed }
      : Object.fromEntries(groups.map((g) => [g, parsed]));
    grouped[group] = defaults;
    await store.updateSettings(req.user!.id, { clip_defaults: JSON.stringify(grouped) });
    res.json({ group, defaults });
  });

  r.put('/studio/recording-output', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    res.json({ options: await ws.finalizer.saveOptions(req.body?.options) });
  });

  /* ── Logo: ham görsel gövdesi, her zaman PNG olarak saklanır ─────────── */

  r.post('/studio/logo', async (req, res) => {
    const type = String(req.headers['content-type'] || '');
    if (!/^image\/(png|jpeg|webp)$/.test(type)) throw badRequest('PNG, JPEG ya da WebP yükleyin');
    const dir = userDir(req.user!.id);
    const upload = path.join(dir, `logo_upload_${Date.now()}`);
    const target = path.join(dir, 'logo.png');
    await receiveFile(req, upload, LOGO_MAX_BYTES);
    try {
      // Şeffaflık korunarak PNG'ye çevrilir; çok büyük görseller 1024 px'e indirilir.
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', upload, '-vf', "scale='min(1024,iw)':-2", '-frames:v', '1', target], { timeout: 30_000 });
    } catch {
      throw badRequest('Görsel okunamadı');
    } finally {
      fs.rmSync(upload, { force: true });
    }
    res.json({ exists: true, url: fileUrl(req.user!.id, 'logo.png') });
  });

  r.delete('/studio/logo', (req, res) => {
    fs.rmSync(path.join(userDir(req.user!.id), 'logo.png'), { force: true });
    res.json({ ok: true });
  });

  /* ── Intro / outro: ham video gövdesi diske akıtılır ─────────────────── */

  r.post('/studio/media/:kind', async (req, res) => {
    const kind = brandKind(req.params.kind);
    const type = String(req.headers['content-type'] || '');
    if (!/^(video\/|application\/octet-stream)/.test(type)) throw badRequest('Video dosyası (MP4/MOV) yükleyin');
    const tmp = path.join(userDir(req.user!.id), `${kind}_upload_${Date.now()}.tmp`);
    await receiveFile(req, tmp, IntroStore.MAX_BOYUT_BYTE);
    await engine(() => IntroStore.save(req.user!.id, kind, tmp));
    res.json(await mediaInfo(req.user!.id, kind));
  });

  r.delete('/studio/media/:kind', (req, res) => {
    IntroStore.remove(req.user!.id, brandKind(req.params.kind));
    res.json({ ok: true });
  });

  /** Örnek kare: en son hazır klipten bir kare (marka önizlemesinde gerçek görüntü için). */
  r.get('/studio/sample-frame', async (req, res) => {
    const orientation = req.query.orientation === 'vertical' ? 'vertical' : 'horizontal';
    const jobs = await store.getEditedClips(req.user!.id, 40);
    const job = jobs.find((j) => {
      if (j.status !== 'ready') return false;
      const horizontal = parseJson(j.options).outputFormat === 'horizontal';
      return orientation === 'horizontal' ? horizontal : !horizontal;
    });
    if (!job) throw new HttpError(404, 'Örnek için hazır klip yok');
    const ws = await workspaces.get(req.user!.id);
    const video = path.join(ws.clipEditor.outputDir, `${job.id}.mp4`);
    const frame = path.join(userDir(req.user!.id), `sample-${orientation}.jpg`);
    if (!fs.existsSync(video)) throw new HttpError(404, 'Örnek klibin dosyası yok');
    // Logo/altyazı bindirilmemiş ham görüntü yok; klibin ortasından kare alınır.
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(1, (job.duration || 4) / 2)), '-i', video, '-frames:v', '1', '-vf', 'scale=720:-2', frame], {
      timeout: 30_000,
    }).catch(() => {
      throw new HttpError(500, 'Kare alınamadı');
    });
    res.sendFile(frame);
  });

  return r;
}
