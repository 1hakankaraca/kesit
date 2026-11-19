import express from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.ts';
import type { AppContext } from '../context.ts';
import { ClipEditorManager, IntroStore, RecordingFinalizer, SubscribeCta, SubtitleStyles } from '../engine.ts';
import { HttpError, badRequest, engine, receiveFile, slugOrThrow } from '../http.ts';
import { FRAME_FILE, FRAME_MAX_BYTES, installFrame, readRegions, removeFrameFiles, writeRegions } from '../services/StreamFrame.ts';
import { normalizeCrop } from '../../shared/project.ts';

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

/**
 * Kanal sekmesine özel marka profili: logo dosyası (brand/<kanal>/logo.png) ve
 * renk/altyazı stili. Üretim kuralları (yerleşim, kadraj, altyazı açık/kapalı,
 * logo yerleşimi) sekmeye özel DEĞİLDİR; tek yerden, genel ayardan gelir.
 */
interface ChannelProfile {
  brand: { subtitle_style?: string; brand_color?: string; accent_color?: string; cta?: unknown };
}

function readProfiles(settings: Record<string, any>): Record<string, ChannelProfile> {
  const all = parseJson(settings.channel_brands);
  const out: Record<string, ChannelProfile> = {};
  for (const [slug, p] of Object.entries(all)) {
    if (p && typeof p === 'object') out[slug] = { brand: (p as ChannelProfile).brand || {} };
  }
  return out;
}

const channelParam = (value: unknown) => (value ? slugOrThrow(value) : null);
/** Sekmeye özel logo klasörü; klasörün varlığı profilin varlığıdır (motor da buna bakar). */
const brandDir = (userId: number, channel: string) => path.join(userDir(userId), 'brand', channel);
/** Sekme profili klasörü varsa dosyalar (logo, abone kesiti) oraya; yoksa kullanıcı köküne. */
function mediaDir(userId: number, channel: string | null) {
  const custom = !!channel && fs.existsSync(brandDir(userId, channel));
  return { dir: custom ? brandDir(userId, channel!) : userDir(userId), prefix: custom ? `brand/${channel}/` : '', custom };
}
const CTA_FILE: string = SubscribeCta.FILE_NAME;

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
    // Üretim varsayılanları her kapsamda aynıdır (genel).
    const saved = parseJson(s.clip_defaults);
    const read = (group: string) => ClipEditorManager.groupDefaults(saved, group);
    const defaults = { vertical: read('gezgin'), horizontal: read('horizontal') };
    const ws = await workspaces.get(userId);
    const logo = ws.clipEditor.getLogoPath(profile ? channel : null);
    const brandSrc = profile ? { ...s, ...profile.brand } : s;
    const ctaClipPath: string | null = SubscribeCta.clipPath(userId, profile ? channel : null);
    const ctaClip = await SubscribeCta.clipInfo(ctaClipPath);
    const frameScope = mediaDir(userId, profile ? channel : null);
    const frameRegions = fs.existsSync(path.join(frameScope.dir, FRAME_FILE)) ? readRegions(frameScope.dir) : null;
    res.json({
      styles: SubtitleStyles.listStyles(),
      scope: { channel, custom: !!profile },
      customTabs: Object.keys(readProfiles(s)),
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
      cta: {
        config: SubscribeCta.resolve(s, profile),
        clip: {
          exists: !!ctaClip.exists,
          url: ctaClipPath ? fileUrl(userId, `${profile ? `brand/${channel}/` : ''}${CTA_FILE}`) : null,
          durationSec: ctaClip.durationSec ?? null,
          sizeBytes: ctaClip.sizeBytes ?? null,
          width: ctaClip.width ?? null,
          height: ctaClip.height ?? null,
          hasAudio: ctaClip.hasAudio ?? null,
        },
      },
      frame: {
        exists: !!frameRegions,
        url: frameRegions ? fileUrl(userId, `${frameScope.prefix}${FRAME_FILE}`) : null,
        window: frameRegions?.window ?? null,
        chat: frameRegions?.chat ?? null,
      },
      limits: {
        mediaMaxSeconds: IntroStore.MAX_SURE_SN, mediaMaxBytes: IntroStore.MAX_BOYUT_BYTE, logoMaxBytes: LOGO_MAX_BYTES,
        ctaMaxSeconds: SubscribeCta.CLIP_MAX_SECONDS, ctaMaxBytes: SubscribeCta.CLIP_MAX_BYTES, frameMaxBytes: FRAME_MAX_BYTES,
      },
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

  /* ── Abone çağrısı: animasyon + dikilecek kesit ──────────────────────── */

  /** Ayar: sekme profili varsa onun markasına, yoksa genel ayara yazılır. */
  r.put('/studio/cta', async (req, res) => {
    const userId = req.user!.id;
    const channel = channelParam(req.body?.channel ?? req.query.channel);
    const config = SubscribeCta.normalize(req.body?.config);
    const s = await store.getSettings(userId);
    const profiles = readProfiles(s);
    if (channel && profiles[channel]) {
      profiles[channel].brand = { ...profiles[channel].brand, cta: config };
      await store.updateSettings(userId, { channel_brands: JSON.stringify(profiles) });
    } else await store.updateSettings(userId, { cta: JSON.stringify(config) });
    res.json({ config });
  });

  r.post('/studio/cta/clip', async (req, res) => {
    const type = String(req.headers['content-type'] || '');
    if (!/^(video\/|application\/octet-stream)/.test(type)) throw badRequest('Video dosyası (MP4/MOV) yükleyin');
    const userId = req.user!.id;
    const { dir, prefix } = mediaDir(userId, channelParam(req.query.channel));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `cta_upload_${Date.now()}.tmp`);
    await receiveFile(req, tmp, SubscribeCta.CLIP_MAX_BYTES);
    const info = await engine(() => SubscribeCta.saveClip(tmp, path.join(dir, CTA_FILE)));
    res.json({ ...info, exists: true, url: fileUrl(userId, `${prefix}${CTA_FILE}`) });
  });

  r.delete('/studio/cta/clip', (req, res) => {
    const { dir } = mediaDir(req.user!.id, channelParam(req.query.channel));
    fs.rmSync(path.join(dir, CTA_FILE), { force: true });
    res.json({ ok: true });
  });

  /**
   * Animasyon önizlemesi: kaydedilmemiş ayarla kısa bir MP4 üretir. Arka plan
   * örnek kare (varsa), yoksa düz koyu renk. Dikey ya da yatay ölçüde.
   */
  r.post('/studio/cta/preview', async (req, res) => {
    const userId = req.user!.id;
    const channel = channelParam(req.body?.channel);
    const config = SubscribeCta.normalize(req.body?.config);
    const horizontal = req.body?.format === 'horizontal';
    const s = await store.getSettings(userId);
    const profile = channel ? readProfiles(s)[channel] ?? null : null;
    const colors = profile ? { ...s, ...profile.brand } : s;
    const brandColor = HEX.test(req.body?.brandColor) ? req.body.brandColor : colors.brand_color;
    const accentColor = HEX.test(req.body?.accentColor) ? req.body.accentColor : colors.accent_color;
    const dir = userDir(userId);
    fs.mkdirSync(dir, { recursive: true });
    const framePath = await sampleFrame(userId).catch(() => null);
    // `all: true` → her tasarım ayrı dosyaya; seçim galerisi hepsini yan yana oynatır.
    // Boyut/yer önizlemede de ayardan okunur; biçim ölçüden (PlayRes) çıkar.
    const styles: string[] = req.body?.all === true ? SubscribeCta.STYLES : [config.overlay.style];
    const urls: Record<string, string> = {};
    for (const style of styles) {
      const name = `cta-preview-${style}-${horizontal ? 'h' : 'v'}.mp4`;
      await engine(
        () =>
          SubscribeCta.renderPreview({
            cfg: { ...config, overlay: { ...config.overlay, style } },
            outputPath: path.join(dir, name),
            playResX: horizontal ? 1920 : 1080,
            playResY: horizontal ? 1080 : 1920,
            outW: horizontal ? 960 : 540,
            outH: horizontal ? 540 : 960,
            brandColor,
            accentColor,
            channel: channel ?? req.user!.channelSlug ?? null,
            framePath,
            workDir: dir,
          }),
        500,
      );
      urls[style] = fileUrl(userId, name);
    }
    res.json({ url: urls[config.overlay.style] ?? Object.values(urls)[0], urls });
  });

  /** Dikey/yatay üretim varsayılanları — her zaman genel; sekme profili bunları ezmez. */
  r.put('/studio/defaults', async (req, res) => {
    const format = req.body?.format as Format;
    if (!(format in FORMAT_GROUPS)) throw badRequest('Biçim dikey ya da yatay olmalı');
    const raw = req.body?.options || {};
    // Dikey çıktılara intro/outro eklenmez.
    const defaults = ClipEditorManager.normalizeClipOptions(
      format === 'vertical' ? { ...raw, outputFormat: 'vertical', intro: false, outro: false } : { ...raw, outputFormat: 'horizontal' },
    );
    const s = await store.getSettings(req.user!.id);
    const parsed = parseJson(s.clip_defaults);
    const groups: string[] = ClipEditorManager.SETTINGS_GROUPS;
    const grouped: Record<string, unknown> = groups.every((g) => parsed[g] && typeof parsed[g] === 'object')
      ? { ...parsed }
      : Object.fromEntries(groups.map((g) => [g, parsed]));
    for (const g of FORMAT_GROUPS[format]) grouped[g] = defaults;
    await store.updateSettings(req.user!.id, { clip_defaults: JSON.stringify(grouped) });
    res.json({ format, defaults });
  });

  /* ── Sekmeye özel profil: oluştur (genelden kopya) / kaldır ─────────────── */

  r.post('/studio/profile', async (req, res) => {
    const userId = req.user!.id;
    const channel = slugOrThrow(req.body?.channel);
    const s = await store.getSettings(userId);
    const profiles = readProfiles(s);
    if (!profiles[channel]) {
      profiles[channel] = {
        brand: { subtitle_style: s.subtitle_style || 'classic', brand_color: s.brand_color, accent_color: s.accent_color, cta: SubscribeCta.normalize(s.cta) },
      };
      await store.updateSettings(userId, { channel_brands: JSON.stringify(profiles) });
    }
    // Klasör profilin varlığıdır; genel logo başlangıç olarak kopyalanır.
    const dir = brandDir(userId, channel);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['logo.png', CTA_FILE, FRAME_FILE, 'frame.json']) {
      const general = path.join(userDir(userId), f);
      if (fs.existsSync(general) && !fs.existsSync(path.join(dir, f))) fs.copyFileSync(general, path.join(dir, f));
    }
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

  /* ── Yayın çerçevesi: saydam pencereli tam kare PNG ───────────────────── */

  /**
   * Çerçeve logo gibi saklanır (genel ya da sekme profiline). Pencere
   * yüklemede kendiliğinden bulunur (alfası düşük en büyük bölge); sohbet
   * alanı varsayılanla başlar, kullanıcı küçük resim üstünde çizerek düzeltir.
   */
  r.post('/studio/frame', async (req, res) => {
    const type = String(req.headers['content-type'] || '');
    if (!/^image\/png$/.test(type)) throw badRequest('Saydam pencereli PNG yükleyin');
    const userId = req.user!.id;
    const { dir, prefix } = mediaDir(userId, channelParam(req.query.channel));
    fs.mkdirSync(dir, { recursive: true });
    const upload = path.join(dir, `frame_upload_${Date.now()}.png`);
    await receiveFile(req, upload, FRAME_MAX_BYTES);
    const info = await installFrame(upload, dir);
    res.json({ exists: true, url: fileUrl(userId, `${prefix}${FRAME_FILE}`), window: info.window, chat: info.chat });
  });

  /** Sohbet alanı (karenin oranı) ya da null: çerçevede sohbet paneli yok. */
  r.put('/studio/frame', (req, res) => {
    const { dir } = mediaDir(req.user!.id, channelParam(req.query.channel ?? req.body?.channel));
    const regions = fs.existsSync(path.join(dir, FRAME_FILE)) ? readRegions(dir) : null;
    if (!regions) throw badRequest('Önce bir çerçeve yükle');
    const chat = req.body?.chat == null ? null : normalizeCrop(req.body.chat);
    writeRegions(dir, { window: regions.window, chat });
    res.json({ window: regions.window, chat });
  });

  r.delete('/studio/frame', (req, res) => {
    const { dir } = mediaDir(req.user!.id, channelParam(req.query.channel));
    removeFrameFiles(dir);
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
  async function sampleFrame(userId: number): Promise<string> {
    const sources = [
      ...(await store.getVodScanJobs(userId, 10)).map((j) => j.vod_path),
      ...(await store.getStreamRecordings(userId, 10)).map((rec) => rec.file_path),
    ].filter((p): p is string => !!p && fs.existsSync(p));
    if (!sources.length) throw new HttpError(404, 'Örnek için ham kaynak yok');
    const frame = path.join(userDir(userId), 'sample-horizontal.jpg');
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '60', '-i', sources[0], '-frames:v', '1', '-vf', 'scale=960:-2', frame], { timeout: 30_000 }).catch(() => {
      throw new HttpError(500, 'Kare alınamadı');
    });
    return frame;
  }

  r.get('/studio/sample-frame', async (req, res) => {
    res.sendFile(await sampleFrame(req.user!.id));
  });

  return r;
}
