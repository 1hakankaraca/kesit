import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Server as IOServer } from 'socket.io';
import {
  FORMAT_SIZE,
  emptyProject,
  fitFrame,
  normalizeProject,
  projectDuration,
  timelineCaptions,
  type Asset,
  type AssetOrigin,
  type Caption,
  type Clip,
  type Project,
  type ProjectFormat,
  type Rect,
} from '../../shared/project.ts';
import { config } from '../config.ts';
import type { Store } from '../db/Store.ts';
import { FacecamDetector, HorizontalComposer, IntroStore, Transcriber } from '../engine.ts';
import { HttpError, badRequest, notFound, receiveFile } from '../http.ts';
import { probe, runFfmpeg, thumbnail, type FfmpegRun } from '../lib/media.ts';
import { buildRenderPlan, type ClipSource } from './ProjectRenderer.ts';

const MAX_UPLOAD = { video: 6 * 1024 ** 3, audio: 300 * 1024 ** 2, image: 40 * 1024 ** 2 } as const;
const PROJECT_LIMIT = 200;

export interface RenderStatus {
  projectId: number;
  title: string;
  percent: number;
  startedAt: number;
  error: string | null;
  jobId: number | null;
}

interface ActiveRender extends RenderStatus {
  run: FfmpegRun | null;
  cancelled: boolean;
}

const newId = (prefix: string) => `${prefix}${randomBytes(5).toString('hex')}`;
const safeName = (name: string) => name.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Dosya';

/**
 * Editör projeleri: kayıt, varlıklar (yükleme / Galeri'den bağlama),
 * konuşma dökümü, yüz kamerası tespiti ve dışa aktarma (render).
 * Dışa aktarılan video Galeri'ye hazır bir video olarak düşer.
 */
export class Projects {
  private renders = new Map<number, ActiveRender>();
  private transcribing = new Set<string>();

  constructor(
    private store: Store,
    private io: IOServer,
  ) {}

  /* ── Dizinler ──────────────────────────────────────────────────────────── */

  private userDir(userId: number) {
    return path.join(config.clipDir, String(userId));
  }

  private dir(userId: number, projectId: number) {
    return path.join(this.userDir(userId), 'projects', String(projectId));
  }

  private assetsDir(userId: number, projectId: number) {
    return path.join(this.dir(userId, projectId), 'assets');
  }

  /* ── CRUD ──────────────────────────────────────────────────────────────── */

  list(userId: number) {
    return this.store.getProjects(userId, PROJECT_LIMIT).map((r) => ({
      id: r.id,
      title: r.title,
      format: r.format as ProjectFormat,
      durationSec: Number(r.duration_sec) || 0,
      thumbUrl: r.thumb_path && fs.existsSync(r.thumb_path) ? `/api/projects/${r.id}/thumb?t=${new Date(r.updated_at).getTime()}` : null,
      lastExportId: r.last_export_id ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      rendering: this.renders.get(r.id) ? this.publicStatus(this.renders.get(r.id)!) : null,
    }));
  }

  get(userId: number, id: number): Project {
    const row = this.store.getProject(id, userId);
    if (!row) throw notFound('Proje bulunamadı');
    let data: unknown = {};
    try {
      data = JSON.parse(row.data || '{}');
    } catch {
      /* bozuk veri → boş proje */
    }
    return normalizeProject({ ...(data as object), title: row.title, format: row.format }, { id: row.id, title: row.title });
  }

  thumbPath(userId: number, id: number) {
    const row = this.store.getProject(id, userId);
    return row?.thumb_path && fs.existsSync(row.thumb_path) ? row.thumb_path : null;
  }

  async create(userId: number, { title, format, from, ranges }: { title?: unknown; format?: unknown; from?: unknown; ranges?: unknown }) {
    const fmt: ProjectFormat = format === 'vertical' ? 'vertical' : 'horizontal';
    const row = this.store.createProject(userId, { title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : 'Yeni proje', format: fmt, data: {} });
    let project = emptyProject(row.id, row.title, fmt);
    fs.mkdirSync(this.assetsDir(userId, row.id), { recursive: true });
    const origin = originFrom(from);
    if (origin) {
      const asset = await this.link(userId, project, origin);
      // İstenirse yalnız belirli aralıklar (ör. yayın editöründe işaretlenen kesitler) art arda dizilir.
      const parts = rangesFrom(ranges, asset.duration);
      if (parts.length) for (const r of parts) project = addClipFor(project, asset, undefined, r);
      else project = addClipFor(project, asset);
      if (!title && asset.name) project.title = asset.name;
      // Kaynak dikeyse proje de dikey açılır.
      if (format === undefined && asset.width && asset.height && asset.height > asset.width) {
        project.format = 'vertical';
        project.clips = project.clips.map((c) => ({ ...c, frame: fitFrame(asset.width!, asset.height!, c.crop, 'vertical') }));
      }
      this.save(userId, project);
    }
    return this.get(userId, row.id);
  }

  save(userId: number, raw: unknown) {
    const current = this.store.getProject((raw as Project)?.id, userId);
    if (!current) throw notFound('Proje bulunamadı');
    const project = normalizeProject(raw, { id: current.id, title: current.title });
    // Varlık kayıtları yalnız sunucu tarafından eklenir; istemci varlık listesini değiştiremez.
    const known = this.get(userId, current.id).assets;
    const knownIds = new Set(known.map((a) => a.id));
    project.assets = known;
    project.clips = project.clips.filter((c) => (c.assetId ? knownIds.has(c.assetId) : true)).map((c) => ({ ...c, renderAssetId: c.renderAssetId && knownIds.has(c.renderAssetId) ? c.renderAssetId : null }));
    this.store.updateProject(current.id, userId, { title: project.title, format: project.format, data: project, duration_sec: projectDuration(project) });
    void this.refreshThumb(userId, project).catch(() => {});
    return project;
  }

  remove(userId: number, id: number) {
    if (this.renders.get(id)) throw new HttpError(409, 'Proje dışa aktarılıyor — önce iptal et');
    if (!this.store.deleteProject(id, userId)) throw notFound('Proje bulunamadı');
    fs.rmSync(this.dir(userId, id), { recursive: true, force: true });
  }

  /** Küçük resim: ilk görsel klibin kaynağından bir kare. */
  private async refreshThumb(userId: number, project: Project) {
    const first = [...project.clips].filter((c) => c.kind === 'video' || c.kind === 'image').sort((a, b) => a.start - b.start)[0];
    const row = this.store.getProject(project.id, userId);
    if (!row) return;
    if (!first) {
      if (row.thumb_path) {
        fs.rmSync(row.thumb_path, { force: true });
        this.store.updateProject(project.id, userId, { thumb_path: null });
      }
      return;
    }
    const asset = project.assets.find((a) => a.id === first.assetId);
    const file = asset && this.resolveFile(userId, project.id, asset.origin);
    if (!file) return;
    const key = `${asset.id}:${Math.round(first.in)}`;
    if (row.thumb_path && fs.existsSync(row.thumb_path) && this.store.get('SELECT 1 FROM projects WHERE id = ? AND thumb_path LIKE ?', [project.id, `%${encodeURIComponent(key)}%`])) return;
    const target = path.join(this.dir(userId, project.id), `thumb-${encodeURIComponent(key)}.jpg`);
    const ok = await thumbnail(file, target, { at: asset.kind === 'image' ? 0 : first.in + 0.5 }).catch(() => false);
    if (!ok) return;
    if (row.thumb_path && row.thumb_path !== target) fs.rmSync(row.thumb_path, { force: true });
    this.store.updateProject(project.id, userId, { thumb_path: target });
  }

  /* ── Varlıklar ─────────────────────────────────────────────────────────── */

  /** Varlığın diskteki dosyası (Galeri kaynakları kopyalanmaz, yerinden okunur). */
  resolveFile(userId: number, projectId: number, origin: AssetOrigin): string | null {
    const exists = (p: string | null | undefined) => (p && fs.existsSync(p) ? p : null);
    switch (origin.type) {
      case 'upload':
      case 'render':
        return exists(path.join(this.assetsDir(userId, projectId), origin.file));
      case 'job':
        return exists(path.join(this.userDir(userId), 'vertical', `${origin.id}.mp4`));
      case 'recording': {
        const rec = this.store.get('SELECT file_path FROM stream_recordings WHERE id = ? AND user_id = ?', [origin.id, userId]);
        return exists(rec?.file_path);
      }
      case 'vod': {
        const job = this.store.get('SELECT vod_path FROM vod_scan_jobs WHERE id = ? AND user_id = ?', [origin.id, userId]);
        return exists(job?.vod_path);
      }
      case 'harvest': {
        const row = this.store.get('SELECT file_path FROM harvested_clips WHERE id = ? AND user_id = ?', [origin.id, userId]);
        return exists(row?.file_path);
      }
      case 'logo':
        return exists(path.join(this.userDir(userId), 'logo.png'));
      case 'intro':
      case 'outro':
        return exists(path.join(this.userDir(userId), IntroStore.TURLER[origin.type]));
      default:
        return null;
    }
  }

  assetFile(userId: number, projectId: number, assetId: string) {
    const project = this.get(userId, projectId);
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) throw notFound('Varlık bulunamadı');
    const file = this.resolveFile(userId, projectId, asset.origin);
    if (!file) throw notFound('Varlığın dosyası artık yok');
    return { asset, file };
  }

  assetThumb(userId: number, projectId: number, assetId: string) {
    const p = path.join(this.assetsDir(userId, projectId), `${assetId}.jpg`);
    return fs.existsSync(p) ? p : null;
  }

  /** Galeri'deki bir kaynağı (klip, kayıt, yayın, logo…) projeye bağlar. */
  async link(userId: number, project: Project, origin: AssetOrigin): Promise<Asset> {
    const same = project.assets.find((a) => JSON.stringify(a.origin) === JSON.stringify(origin));
    if (same) return same;
    const file = this.resolveFile(userId, project.id, origin);
    if (!file) throw notFound('Kaynak dosya bulunamadı');
    const name = this.originName(userId, origin) || path.basename(file);
    const asset = await this.describe(userId, project.id, newId('a'), file, name, origin);
    project.assets.push(asset);
    this.store.updateProject(project.id, userId, { data: project });
    return asset;
  }

  private originName(userId: number, origin: AssetOrigin): string | null {
    switch (origin.type) {
      case 'job': {
        const r = this.store.get('SELECT title, gen_title FROM edited_clips WHERE id = ? AND user_id = ?', [origin.id, userId]);
        return r ? r.gen_title || r.title || `Video #${origin.id}` : null;
      }
      case 'recording': {
        const r = this.store.get('SELECT title, channel_slug FROM stream_recordings WHERE id = ? AND user_id = ?', [origin.id, userId]);
        return r ? r.title || `${r.channel_slug} yayın kaydı` : null;
      }
      case 'vod': {
        const r = this.store.get('SELECT title, channel_slug FROM vod_scan_jobs WHERE id = ? AND user_id = ?', [origin.id, userId]);
        return r ? r.title || `${r.channel_slug} yayını` : null;
      }
      case 'harvest': {
        const r = this.store.get('SELECT title FROM harvested_clips WHERE id = ? AND user_id = ?', [origin.id, userId]);
        return r?.title || 'Kick klibi';
      }
      case 'logo':
        return 'Logo';
      case 'intro':
        return 'Açılış videosu';
      case 'outro':
        return 'Kapanış videosu';
      default:
        return null;
    }
  }

  /** Bilgisayardan dosya yükleme (ham gövde). */
  async upload(userId: number, project: Project, req: Request, { name, kind }: { name: string; kind: 'upload' | 'render' }): Promise<Asset> {
    const type = String(req.headers['content-type'] || '');
    const group = /^image\//.test(type) ? 'image' : /^audio\//.test(type) ? 'audio' : /^(video\/|application\/octet-stream)/.test(type) ? 'video' : null;
    if (!group) throw badRequest('Video, görsel ya da ses dosyası yükleyin');
    const ext = (path.extname(name) || mimeExt(type)).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 8) || '.bin';
    const id = newId(kind === 'render' ? 'r' : 'u');
    const file = `${id}${ext}`;
    const target = path.join(this.assetsDir(userId, project.id), file);
    await receiveFile(req, target, MAX_UPLOAD[group]);
    const asset = await this.describe(userId, project.id, id, target, safeName(name), { type: kind, file }).catch((err) => {
      fs.rmSync(target, { force: true });
      throw badRequest(`Dosya okunamadı: ${(err as Error).message}`);
    });
    project.assets.push(asset);
    this.store.updateProject(project.id, userId, { data: project });
    return asset;
  }

  removeAsset(userId: number, project: Project, assetId: string) {
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) throw notFound('Varlık bulunamadı');
    if (asset.origin.type === 'upload' || asset.origin.type === 'render') fs.rmSync(path.join(this.assetsDir(userId, project.id), asset.origin.file), { force: true });
    fs.rmSync(path.join(this.assetsDir(userId, project.id), `${assetId}.jpg`), { force: true });
    project.assets = project.assets.filter((a) => a.id !== assetId);
    project.clips = project.clips.filter((c) => c.assetId !== assetId).map((c) => (c.renderAssetId === assetId ? { ...c, renderAssetId: null } : c));
    this.store.updateProject(project.id, userId, { data: project, duration_sec: projectDuration(project) });
    return project;
  }

  private async describe(userId: number, projectId: number, id: string, file: string, name: string, origin: AssetOrigin): Promise<Asset> {
    const info = await probe(file);
    const kind = info.isImage ? 'image' : info.hasVideo ? 'video' : 'audio';
    const thumb = path.join(this.assetsDir(userId, projectId), `${id}.jpg`);
    let hasThumb = false;
    if (kind !== 'audio') hasThumb = await thumbnail(file, thumb, { at: kind === 'image' ? 0 : Math.min(1, info.duration / 2) }).catch(() => false);
    return {
      id,
      kind,
      name,
      duration: kind === 'image' ? 0 : info.duration,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
      origin,
      thumb: hasThumb ? `/api/projects/${projectId}/assets/${id}/thumb` : null,
    };
  }

  /* ── Konuşma dökümü ve yüz kamerası ───────────────────────────────────── */

  /** Varlığın belirli aralığını yazıya döker; kaynak zamanında satırlar döner. */
  async transcribe(userId: number, projectId: number, assetId: string, { from, to, language }: { from: number; to: number; language: 'tr' | 'en' | null }): Promise<Caption[]> {
    if (!Transcriber.isAvailable()) throw badRequest('Otomatik altyazı için Ayarlar\'dan altyazı modelini indir ya da ElevenLabs anahtarını bağla');
    const key = `${userId}:${projectId}:${assetId}`;
    if (this.transcribing.has(key)) throw new HttpError(409, 'Bu dosya zaten yazıya dökülüyor');
    const { asset, file } = this.assetFile(userId, projectId, assetId);
    if (asset.kind === 'image') throw badRequest('Görselde konuşma yok');
    const start = Math.max(0, from);
    const end = Math.min(asset.duration || to, Math.max(start + 0.5, to));
    if (end - start > 3 * 3600) throw badRequest('Tek seferde en fazla 3 saatlik bölüm yazıya dökülebilir');
    const work = path.join(this.dir(userId, projectId), 'work', `tr-${Date.now()}`);
    fs.mkdirSync(work, { recursive: true });
    this.transcribing.add(key);
    try {
      const part = path.join(work, 'part.mp4');
      await runFfmpeg(['-ss', start.toFixed(3), '-t', (end - start).toFixed(3), '-i', file, '-map', '0:a:0', '-c:a', 'aac', '-vn', '-y', part], { totalSec: 0 }).done;
      const transcriber = new Transcriber();
      const res = await transcriber.transcribe(part, work, { language, durationSec: end - start });
      const segs: Caption[] = (res?.segments ?? []).map((s: { start: number; end: number; text: string }) => ({ start: s.start + start, end: s.end + start, text: String(s.text || '').trim() })).filter((s: Caption) => s.text);
      return segs;
    } finally {
      this.transcribing.delete(key);
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /** Yüz kamerası kutusu (kaynağın oranı olarak) — bulunamazsa null. */
  async facecam(userId: number, projectId: number, assetId: string): Promise<Rect | null> {
    const { asset, file } = this.assetFile(userId, projectId, assetId);
    if (asset.kind !== 'video') return null;
    const detector = new FacecamDetector();
    const res = await detector.detect(file);
    if (!res?.found || res.fullCam || !res.rect || !res.meta?.width) return null;
    const { width, height } = res.meta;
    return { x: res.rect.x / width, y: res.rect.y / height, w: res.rect.w / width, h: res.rect.h / height };
  }

  /* ── Dışa aktarma ──────────────────────────────────────────────────────── */

  renderStatus(userId: number) {
    return [...this.renders.values()].filter((r) => this.owns(userId, r.projectId)).map((r) => this.publicStatus(r));
  }

  private owns(userId: number, projectId: number) {
    return !!this.store.getProject(projectId, userId);
  }

  private publicStatus(r: ActiveRender): RenderStatus {
    return { projectId: r.projectId, title: r.title, percent: r.percent, startedAt: r.startedAt, error: r.error, jobId: r.jobId };
  }

  async startRender(userId: number, raw: unknown) {
    const project = this.save(userId, raw);
    if (this.renders.has(project.id)) throw new HttpError(409, 'Bu proje zaten dışa aktarılıyor');
    if (!project.clips.some((c) => c.kind !== 'audio' && !project.tracks.find((t) => t.id === c.trackId)?.hidden)) throw badRequest('Zaman çizelgesinde görüntü yok');

    const dir = path.join(this.dir(userId, project.id), 'renders');
    fs.mkdirSync(dir, { recursive: true });
    const output = path.join(dir, `export-${Date.now()}.mp4`);
    const assPath = await this.buildSubtitles(userId, project, dir);
    const plan = buildRenderPlan(project, (clip) => this.sourceFor(userId, project, clip), { output, assPath });
    if (plan.warnings.length) console.warn(`[Proje ${project.id}] ${plan.warnings.join('; ')}`);

    const state: ActiveRender = { projectId: project.id, title: project.title, percent: 0, startedAt: Date.now(), error: null, jobId: null, run: null, cancelled: false };
    this.renders.set(project.id, state);
    const emit = (extra: Record<string, unknown> = {}) => this.io.to(`user:${userId}`).emit('project:render', { ...this.publicStatus(state), ...extra });
    emit();

    void (async () => {
      try {
        state.run = runFfmpeg(plan.args, {
          totalSec: plan.totalSec,
          onProgress: (pct) => {
            if (pct !== state.percent) {
              state.percent = pct;
              emit();
            }
          },
        });
        await state.run.done;
        if (state.cancelled) throw new Error('İptal edildi');
        const jobId = await this.registerExport(userId, project, output, plan.totalSec);
        state.jobId = jobId;
        state.percent = 100;
        this.store.updateProject(project.id, userId, { last_export_id: jobId });
        emit({ done: true });
      } catch (err) {
        state.error = state.cancelled ? 'İptal edildi' : (err as Error).message;
        fs.rmSync(output, { force: true });
        emit({ failed: true });
      } finally {
        if (assPath) fs.rmSync(assPath, { force: true });
        // Bitti bilgisi kısa süre okunabilsin; sonra listeden düşer.
        setTimeout(() => this.renders.delete(project.id), 15_000).unref();
      }
    })();
    return this.publicStatus(state);
  }

  cancelRender(userId: number, projectId: number) {
    const r = this.renders.get(projectId);
    if (!r || !this.owns(userId, projectId)) return false;
    r.cancelled = true;
    r.run?.proc.kill('SIGKILL');
    return true;
  }

  private sourceFor(userId: number, project: Project, clip: Clip): ClipSource | null {
    const assetId = clip.kind === 'text' ? clip.renderAssetId : clip.assetId;
    const asset = assetId ? project.assets.find((a) => a.id === assetId) : null;
    if (!asset) return null;
    const file = this.resolveFile(userId, project.id, asset.origin);
    if (!file) return null;
    return { file, kind: asset.kind, hasAudio: asset.hasAudio && asset.kind !== 'image' };
  }

  private async buildSubtitles(userId: number, project: Project, dir: string): Promise<string | null> {
    if (!project.subtitles.enabled) return null;
    const caps = timelineCaptions(project);
    if (!caps.length) return null;
    const settings = await this.store.getSettings(userId);
    const { w, h } = FORMAT_SIZE[project.format];
    const layout = project.format === 'horizontal' ? HorizontalComposer.subtitleLayout({ width: w, height: h }) : { playResX: w, playResY: h, marginV: 320 };
    const transcriber = new Transcriber();
    const assPath = path.join(dir, `sub-${Date.now()}.ass`);
    transcriber.buildAss(
      caps.map((c) => ({ ...c, score: 0 })),
      assPath,
      layout,
      { key: project.subtitles.style || settings.subtitle_style || 'classic', accent: project.subtitles.followTheme ? settings.accent_color : settings.brand_color },
    );
    return assPath;
  }

  /** Çıktıyı Galeri'ye hazır video olarak kaydeder (edited_clips satırı). */
  private async registerExport(userId: number, project: Project, output: string, durationSec: number) {
    const user = this.store.getUser(userId);
    const row = await this.store.addEditedClip(userId, {
      source: 'editor',
      title: project.title,
      channelSlug: user?.channel_slug || '',
      options: { outputFormat: project.format, subtitles: project.subtitles.enabled },
      subtitles: project.subtitles.enabled,
    });
    if (!row) throw new Error('Video kaydı oluşturulamadı');
    const outDir = path.join(this.userDir(userId), 'vertical');
    fs.mkdirSync(outDir, { recursive: true });
    const finalPath = path.join(outDir, `${row.id}.mp4`);
    fs.renameSync(output, finalPath);
    const thumb = path.join(outDir, `${row.id}_thumb.jpg`);
    const hasThumb = await thumbnail(finalPath, thumb, { at: Math.min(1, durationSec / 2), width: 640 }).catch(() => false);
    const info = await probe(finalPath).catch(() => null);
    await this.store.updateEditedClip(row.id, userId, {
      status: 'ready',
      step: 'tamamlandı',
      video_url: `/clips/${userId}/vertical/${row.id}.mp4`,
      thumbnail_url: hasThumb ? `/clips/${userId}/vertical/${row.id}_thumb.jpg` : null,
      duration: Math.round(info?.duration ?? durationSec),
      layout: 'editor',
      file_size_bytes: fs.statSync(finalPath).size,
      gen_title: project.title,
    });
    this.io.to(`user:${userId}`).emit('clipedit:update', { jobId: row.id, status: 'ready', step: 'tamamlandı', progress: 100 });
    return row.id as number;
  }
}

/* ── Yardımcılar ─────────────────────────────────────────────────────────── */

function mimeExt(type: string) {
  const m = type.split(';')[0].trim();
  const map: Record<string, string> = {
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv',
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/flac': '.flac', 'audio/aac': '.aac',
  };
  return map[m] || '';
}

export function originFrom(raw: unknown): AssetOrigin | null {
  const o = (raw ?? {}) as { type?: string; id?: unknown };
  if (o.type === 'job' || o.type === 'recording' || o.type === 'vod' || o.type === 'harvest') {
    const id = Number(o.id);
    return Number.isInteger(id) && id > 0 ? { type: o.type, id } : null;
  }
  if (o.type === 'logo' || o.type === 'intro' || o.type === 'outro') return { type: o.type };
  return null;
}

function rangesFrom(raw: unknown, max: number): { start: number; end: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 100)
    .map((r) => ({ start: Math.max(0, Number(r?.start)), end: Math.min(max || Infinity, Number(r?.end)) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end - r.start >= 0.5)
    .sort((a, b) => a.start - b.start);
}

/** Varlığı ilk boş yere, kareye oran koruyarak oturtan klip ekler. */
export function addClipFor(project: Project, asset: Asset, at?: number, range?: { start: number; end: number }): Project {
  const videoTrack = project.tracks.find((t) => t.kind === 'video') ?? project.tracks[0];
  const audioTrack = project.tracks.find((t) => t.kind === 'audio') ?? videoTrack;
  const track = asset.kind === 'audio' ? audioTrack : videoTrack;
  const onTrack = project.clips.filter((c) => c.trackId === track.id);
  const start = at ?? onTrack.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  const duration = range ? range.end - range.start : asset.kind === 'image' ? 5 : Math.max(0.1, asset.duration);
  const crop = { x: 0, y: 0, w: 1, h: 1 };
  const frame = asset.kind === 'audio' ? crop : fitFrame(asset.width || 16, asset.height || 9, crop, project.format);
  const clip: Clip = {
    id: newId('c'),
    trackId: track.id,
    kind: asset.kind,
    assetId: asset.id,
    start,
    duration,
    in: range?.start ?? 0,
    frame,
    crop,
    opacity: 1,
    volume: 1,
    muted: false,
    speed: 1,
    fadeIn: 0,
    fadeOut: 0,
    color: { brightness: 0, contrast: 1, saturation: 1, hue: 0 },
    text: null,
    captions: null,
    renderAssetId: null,
  };
  return { ...project, clips: [...project.clips, clip] };
}

