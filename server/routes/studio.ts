import express from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.ts';
import type { AppContext } from '../context.ts';
import { ClipEditorManager, IntroStore, RecordingFinalizer, SubtitleStyles } from '../engine.ts';
import { HttpError, badRequest, engine, receiveFile, slugOrThrow } from '../http.ts';

const run = promisify(execFile);
const HEX = /^#[0-9a-f]{6}$/i;
const LOGO_MAX_BYTES = 5 * 1024 * 1024;
const BRAND_KINDS = ['intro', 'outro'] as const;

/**
 * Arayüzde yalnız iki biçim var; motor ise kaynağa göre dört grup okur.
 * Dikey ayar üç dikey gruba birden yazılır, yatay ayar yatay gruba.
 */
const FORMAT_GROUPS = {
  vertical: ['gezgin', 'vodscan', 'live'],
  horizontal: ['horizontal'],
} as const;
type Format = keyof typeof FORMAT_GROUPS;
type BrandKind = (typeof BRAND_KINDS)[number];

const userDir = (userId: number) => path.join(config.clipDir, String(userId));
const fileUrl = (userId: number, name: string) => `/clips/${userId}/${name}?t=${Date.now()}`;

/** Kanal sekmesine özel marka profili: genel ayarları ezen renk/stil ve üretim varsayılanları. */
interface ChannelProfile {
  brand: { subtitle_style?: string; brand_color?: string; accent_color?: string };
  clip_defaults: Record<string, unknown>;
}

function readProfiles(settings: Record<string, any>): Record<string, ChannelProfile> {
  const all = parseJson(settings.channel_brands);
  const out: Record<string, ChannelProfile> = {};
  for (const [slug, p] of Object.entries(all)) {
    if (p && typeof p === 'object') out[slug] = { brand: (p as ChannelProfile).brand || {}, clip_defaults: (p as ChannelProfile).clip_defaults || {} };
  }
  return out;
}

const channelParam = (value: unknown) => (value ? slugOrThrow(value) : null);
/** Sekmeye özel logo klasörü; klasörün varlığı profilin varlığıdır (motor da buna bakar). */
const brandDir = (userId: number, channel: string) => path.join(userDir(userId), 'brand', channel);

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

  /**
   * `?channel=` verilirse o sekmenin ayarları döner: sekmenin kendi profili
   * varsa (scope.custom) onun değerleri, yoksa genel ayarlar.
   */
  r.get('/studio', async (req, res) => {
    const userId = req.user!.id;
    const s = await store.getSettings(userId);
    const channel = channelParam(req.query.channel);
    const profile = channel ? readProfiles(s)[channel] ?? null : null;
    const saved = profile ? profile.clip_defaults : parseJson(s.clip_defaults);
    const read = (group: string) => ClipEditorManager.groupDefaults(saved, group);
    const defaults = { vertical: read('gezgin'), horizontal: read('horizontal') };
    const ws = await workspaces.get(userId);
    const logo = ws.clipEditor.getLogoPath(profile ? channel : null);
    const brandSrc = profile ? { ...s, ...profile.brand } : s;
    res.json({
      styles: SubtitleStyles.listStyles(),
      scope: { channel, custom: !!profile },
      brand: {
        subtitleStyle: brandSrc.subtitle_style || 'classic',
        brandColor: brandSrc.brand_color,
        accentColor: brandSrc.accent_color,
        language: s.language || 'tr',
      },
      defaults,
      logo: { exists: !!logo, url: logo ? fileUrl(userId, profile ? `brand/${channel}/logo.png` : 'logo.png') : null },
      intro: await mediaInfo(userId, 'intro'),
      outro: await mediaInfo(userId, 'outro'),
      limits: { mediaMaxSeconds: IntroStore.MAX_SURE_SN, mediaMaxBytes: IntroStore.MAX_BOYUT_BYTE, logoMaxBytes: LOGO_MAX_BYTES },
      recordingOutput: await ws.finalizer.getOptions(),
      hevcAvailable: await RecordingFinalizer.hevcVarMi(),
    });
  });

  r.put('/studio/brand', async (req, res) => {
    const b = req.body || {};
    const channel = channelParam(b.channel ?? req.query.channel);
    const data: Record<string, string> = {};
    if (b.subtitleStyle !== undefined) data.subtitle_style = SubtitleStyles.normalize(String(b.subtitleStyle));
    if (HEX.test(b.brandColor)) data.brand_color = b.brandColor;
    if (HEX.test(b.accentColor)) data.accent_color = b.accentColor;
    if (['tr', 'en'].includes(b.language)) data.language = b.language;
    if (!Object.keys(data).length) throw badRequest('Güncellenecek alan yok');
    const s = await store.getSettings(req.user!.id);
    const profiles = readProfiles(s);
    if (channel && profiles[channel]) {
      // Dil bilgisayar geneli kalır; renk ve stil sekmeye yazılır.
      const { language, ...brand } = data;
      profiles[channel].brand = { ...profiles[channel].brand, ...brand };
      await store.updateSettings(req.user!.id, { channel_brands: JSON.stringify(profiles), ...(language ? { language } : {}) });
    } else await store.updateSettings(req.user!.id, data);
    res.json({ ok: true });
  });

  /** Dikey/yatay varsayılanları; `channel` verilip o sekmenin profili varsa ona yazılır. */
  r.put('/studio/defaults', async (req, res) => {
    const format = req.body?.format as Format;
    if (!(format in FORMAT_GROUPS)) throw badRequest('Biçim dikey ya da yatay olmalı');
    const channel = channelParam(req.body?.channel);
    const raw = req.body?.options || {};
    // Dikey çıktılara intro/outro eklenmez.
    const defaults = ClipEditorManager.normalizeClipOptions(
      format === 'vertical' ? { ...raw, outputFormat: 'vertical', intro: false, outro: false } : { ...raw, outputFormat: 'horizontal' },
    );
    const s = await store.getSettings(req.user!.id);
    const profiles = readProfiles(s);
    const profile = channel ? profiles[channel] ?? null : null;
    const parsed = profile ? profile.clip_defaults : parseJson(s.clip_defaults);
    const groups: string[] = ClipEditorManager.SETTINGS_GROUPS;
    const grouped: Record<string, unknown> = groups.every((g) => parsed[g] && typeof parsed[g] === 'object')
      ? { ...parsed }
      : Object.fromEntries(groups.map((g) => [g, parsed]));
    for (const g of FORMAT_GROUPS[format]) grouped[g] = defaults;
    if (profile) {
      profile.clip_defaults = grouped;
      await store.updateSettings(req.user!.id, { channel_brands: JSON.stringify(profiles) });
    } else await store.updateSettings(req.user!.id, { clip_defaults: JSON.stringify(grouped) });
    res.json({ format, defaults, channel: profile ? channel : null });
  });

  /* ── Sekmeye özel profil: oluştur (genelden kopya) / kaldır ─────────────── */

  r.post('/studio/profile', async (req, res) => {
    const userId = req.user!.id;
    const channel = slugOrThrow(req.body?.channel);
    const s = await store.getSettings(userId);
    const profiles = readProfiles(s);
    if (!profiles[channel]) {
      profiles[channel] = {
        brand: { subtitle_style: s.subtitle_style || 'classic', brand_color: s.brand_color, accent_color: s.accent_color },
        clip_defaults: parseJson(s.clip_defaults),
      };
      await store.updateSettings(userId, { channel_brands: JSON.stringify(profiles) });
    }
    // Klasör profilin varlığıdır; genel logo başlangıç olarak kopyalanır.
    const dir = brandDir(userId, channel);
    fs.mkdirSync(dir, { recursive: true });
    const general = path.join(userDir(userId), 'logo.png');
    if (fs.existsSync(general) && !fs.existsSync(path.join(dir, 'logo.png'))) fs.copyFileSync(general, path.join(dir, 'logo.png'));
    res.json({ ok: true, channel });
  });

  r.delete('/studio/profile/:channel', async (req, res) => {
    const userId = req.user!.id;
    const channel = slugOrThrow(req.params.channel);
    const s = await store.getSettings(userId);
    const profiles = readProfiles(s);
    delete profiles[channel];
    await store.updateSettings(userId, { channel_brands: JSON.stringify(profiles) });
    fs.rmSync(brandDir(userId, channel), { recursive: true, force: true });
    res.json({ ok: true });
  });

  r.put('/studio/recording-output', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    res.json({ options: await ws.finalizer.saveOptions(req.body?.options) });
  });

  /* ── Logo: ham görsel gövdesi, her zaman PNG olarak saklanır ─────────── */

  r.post('/studio/logo', async (req, res) => {
    const type = String(req.headers['content-type'] || '');
    if (!/^image\/(png|jpeg|webp)$/.test(type)) throw badRequest('PNG, JPEG ya da WebP yükleyin');
    const channel = channelParam(req.query.channel);
    const custom = !!channel && fs.existsSync(brandDir(req.user!.id, channel));
    const dir = custom ? brandDir(req.user!.id, channel!) : userDir(req.user!.id);
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
    res.json({ exists: true, url: fileUrl(req.user!.id, custom ? `brand/${channel}/logo.png` : 'logo.png') });
  });

  r.delete('/studio/logo', (req, res) => {
    const channel = channelParam(req.query.channel);
    const custom = !!channel && fs.existsSync(brandDir(req.user!.id, channel));
    fs.rmSync(path.join(custom ? brandDir(req.user!.id, channel!) : userDir(req.user!.id), 'logo.png'), { force: true });
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

  /**
   * Örnek kare (yatay önizleme): ham kaynaktan — indirilen bir yayından ya da
   * kayıttan — alınır. Üretilmiş klipler kullanılmaz; onlarda logo ve altyazı
   * zaten basılıdır ve önizlemeyi yanıltır. Dikey önizleme şematiktir.
   */
  r.get('/studio/sample-frame', async (req, res) => {
    const userId = req.user!.id;
    const sources = [
      ...(await store.getVodScanJobs(userId, 10)).map((j) => j.vod_path),
      ...(await store.getStreamRecordings(userId, 10)).map((rec) => rec.file_path),
    ].filter((p): p is string => !!p && fs.existsSync(p));
    if (!sources.length) throw new HttpError(404, 'Örnek için ham kaynak yok');
    const frame = path.join(userDir(userId), 'sample-horizontal.jpg');
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '60', '-i', sources[0], '-frames:v', '1', '-vf', 'scale=960:-2', frame], { timeout: 30_000 }).catch(() => {
      throw new HttpError(500, 'Kare alınamadı');
    });
    res.sendFile(frame);
  });

  return r;
}
