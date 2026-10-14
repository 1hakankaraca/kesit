import { execFile } from 'node:child_process';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.ts';
import type { AppContext } from '../context.ts';
import { HttpError, badRequest, intParam, notFound, requireLocal } from '../http.ts';

const run = promisify(execFile);
const RECENT_MS = 24 * 60 * 60_000;

/** Görev yöneticisindeki bir satır. Arayüz bölüme (group) göre sekmeler. */
export interface Task {
  key: string;
  group: 'iniyor' | 'hazirlaniyor' | 'bitti' | 'hata';
  kind: 'yayin' | 'klip-indir' | 'video' | 'kayit' | 'hazir-video' | 'model' | 'proje';
  title: string;
  channel: string | null;
  step: string;
  progress: number | null;
  sizeBytes: number | null;
  error: string | null;
  at: string;
  /** Kullanıcının gideceği yer: bölüm + alt kimlik ve düğme metni. */
  link: { section: string; sub: number | string | null; label: string } | null;
  /** Yayın indirme işinin kimliği (duraklat/sürdür/iptal için). */
  vodJobId?: number;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? new Date().toISOString()));
const recent = (v: unknown) => !!v && Date.now() - new Date(v as string).getTime() < RECENT_MS;

/** Görev yöneticisi ve ekran görüntüsü uçları. */
export function taskRoutes({ store, workspaces, captions, exporter, harvester, projects }: AppContext) {
  const r = express.Router();

  r.get('/tasks', async (req, res) => {
    const userId = req.user!.id;
    const ws = await workspaces.get(userId);
    const tasks: Task[] = [];

    for (const j of await store.getVodScanJobs(userId, 60)) {
      const active = ['queued', 'processing', 'paused'].includes(j.status);
      if (!active && !recent(j.downloaded_at ?? j.completed_at ?? j.created_at)) continue;
      tasks.push({
        key: `yayin-${j.id}`,
        group: active ? 'iniyor' : j.status === 'downloaded' ? 'bitti' : 'hata',
        kind: 'yayin',
        title: j.title || 'Geçmiş yayın',
        channel: j.channel_slug,
        step:
          j.status === 'queued' ? 'Sırada'
          : j.status === 'paused' ? 'Duraklatıldı'
          : j.status === 'downloaded' ? 'İndirildi'
          : j.status === 'processing' ? 'İndiriliyor'
          : j.status === 'expired' ? 'Süresi doldu'
          : j.status === 'cancelled' ? 'İptal edildi'
          : 'İndirilemedi',
        progress: active ? j.progress ?? 0 : null,
        sizeBytes: j.vod_file_size_bytes ?? null,
        error: j.error ?? null,
        at: iso(j.created_at),
        link: j.status === 'downloaded' ? { section: 'yayinlar', sub: j.id, label: 'Kesmeye git' } : { section: 'yayinlar', sub: null, label: 'Yayın geçmişine git' },
        vodJobId: j.id,
      });
    }

    for (const c of harvester.list(userId)) {
      if (c.status !== 'downloading' && !recent(c.createdAt)) continue;
      tasks.push({
        key: `klip-indir-${c.id}`,
        group: c.status === 'downloading' ? 'iniyor' : c.status === 'failed' ? 'hata' : 'bitti',
        kind: 'klip-indir',
        title: c.title || 'Kick klibi',
        channel: c.channel,
        step: c.status === 'downloading' ? 'İndiriliyor' : c.status === 'failed' ? 'İndirilemedi' : 'İndirildi',
        progress: c.status === 'downloading' ? null : null,
        sizeBytes: c.sizeBytes ?? null,
        error: c.error ?? null,
        at: c.createdAt,
        link: c.jobId ? { section: 'galeri', sub: c.jobId, label: 'Videoyu gör' } : { section: 'canli', sub: null, label: 'Klibi gör' },
      });
    }

    for (const j of await store.getEditedClips(userId, 120)) {
      const active = j.status === 'queued' || j.status === 'processing';
      if (!active && !recent(j.created_at)) continue;
      tasks.push({
        key: `video-${j.id}`,
        group: active ? 'hazirlaniyor' : j.status === 'ready' ? 'bitti' : 'hata',
        kind: 'video',
        title: j.title || `Video #${j.id}`,
        channel: j.channel_slug || null,
        step: j.status === 'queued' ? 'Sırada' : j.status === 'ready' ? 'Hazır' : j.status === 'failed' ? 'Hazırlanamadı' : j.step || 'Hazırlanıyor',
        progress: null,
        sizeBytes: j.file_size_bytes ?? null,
        error: j.error ?? null,
        at: iso(j.created_at),
        link: { section: 'galeri', sub: j.id, label: j.status === 'ready' ? 'Videoyu gör' : 'Videoya git' },
      });
    }

    const recorder = ws.recorder.getStatus();
    for (const rec of await store.getStreamRecordings(userId, 40)) {
      const pct: number | null = ws.finalizer.yuzde(rec.id) ?? null;
      if (rec.id === recorder?.id && recorder.recording) {
        tasks.push({
          key: `kayit-${rec.id}`,
          group: 'iniyor',
          kind: 'kayit',
          title: rec.title || `${rec.channel_slug} yayını`,
          channel: rec.channel_slug,
          step: recorder.finishing ? 'Bitiriliyor' : 'Kaydediliyor',
          progress: null,
          sizeBytes: recorder.sizeBytes ?? null,
          error: null,
          at: iso(rec.started_at),
          link: { section: 'canli', sub: null, label: 'Canlıya git' },
        });
      }
      if (pct != null || (rec.final_status && recent(rec.completed_at ?? rec.started_at))) {
        const running = pct != null;
        tasks.push({
          key: `hazir-video-${rec.id}`,
          group: running ? 'hazirlaniyor' : rec.final_status === 'ready' ? 'bitti' : 'hata',
          kind: 'hazir-video',
          title: `${rec.title || rec.channel_slug} — paylaşıma hazır video`,
          channel: rec.channel_slug,
          step: running ? 'Hazırlanıyor' : rec.final_status === 'ready' ? 'Hazır' : 'Hazırlanamadı',
          progress: pct,
          sizeBytes: rec.final_size ?? null,
          error: rec.final_error ?? null,
          at: iso(rec.completed_at ?? rec.started_at),
          link: { section: 'galeri', sub: `k${rec.id}`, label: 'Kayda git' },
        });
      }
    }

    for (const r of projects.renderStatus(userId)) {
      const done = r.jobId !== null;
      tasks.push({
        key: `proje-${r.projectId}`,
        group: r.error ? 'hata' : done ? 'bitti' : 'hazirlaniyor',
        kind: 'proje',
        title: r.title,
        channel: null,
        step: r.error ? 'Dışa aktarılamadı' : done ? 'Hazır' : 'Dışa aktarılıyor',
        progress: done || r.error ? null : r.percent,
        sizeBytes: null,
        error: r.error,
        at: new Date(r.startedAt).toISOString(),
        link: done ? { section: 'galeri', sub: r.jobId, label: 'Videoyu gör' } : { section: 'editor', sub: r.projectId, label: 'Projeye git' },
      });
    }

    const model = captions.status().whisper.download;
    if (model) {
      tasks.push({
        key: 'model',
        group: 'iniyor',
        kind: 'model',
        title: 'Altyazı modeli',
        channel: null,
        step: 'İndiriliyor',
        progress: model.percent,
        sizeBytes: null,
        error: null,
        at: new Date().toISOString(),
        link: { section: 'ayarlar', sub: null, label: 'Ayarlara git' },
      });
    }

    tasks.sort((a, b) => b.at.localeCompare(a.at));
    res.json({ tasks });
  });

  /**
   * Ekran görüntüsü: kaynağın istenen saniyesinden tek kare alır ve çıktı
   * klasörüne (İndirilenler/Kesit/Ekran görüntüleri) kaydeder.
   */
  r.post('/snapshot', async (req, res) => {
    const userId = req.user!.id;
    const source = String(req.body?.source || '');
    const id = intParam(req.body?.id);
    const t = Number(req.body?.t);
    if (!Number.isFinite(t) || t < 0) throw badRequest('Geçersiz saniye');
    let file: string | null = null;
    let title = 'Kesit';
    if (source === 'vod') {
      const job = await store.getVodScanJobById(id, userId);
      file = job?.vod_path ?? null;
      title = job?.title || 'Yayın';
    } else if (source === 'recording') {
      const rec = await store.getStreamRecordingById(id, userId);
      file = rec?.file_path ?? null;
      title = rec?.title || 'Kayıt';
    } else if (source === 'clip') {
      const job = await store.getEditedClipById(id, userId);
      file = job ? path.join(config.clipDir, String(userId), 'vertical', `${job.id}.mp4`) : null;
      title = job?.title || 'Video';
    } else throw badRequest('Geçersiz kaynak');
    if (!file || !fs.existsSync(file)) throw notFound('Video dosyası bulunamadı');

    const target = exporter.snapshotPath(title, t);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-q:v', '2', target], { timeout: 30_000 }).catch(() => {
      throw new HttpError(500, 'Ekran görüntüsü alınamadı');
    });
    res.json({ path: target, name: path.basename(target), folder: path.dirname(target) });
  });

  r.post('/snapshot/reveal', requireLocal, (_req, res) => {
    exporter.reveal(exporter.snapshotDir);
    res.json({ ok: true });
  });

  return r;
}

