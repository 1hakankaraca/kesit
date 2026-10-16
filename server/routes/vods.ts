import express from 'express';
import type { AppContext } from '../context.ts';
import { badRequest, camFullFrom, clipOptionsFrom, engine, intParam, notFound, oneOf, slugOrThrow } from '../http.ts';

const QUALITIES = ['source', '1080p', '720p', '480p', '360p'] as const;

/** İsteğe bağlı aralık (saniye, yayın başından). İkisi de yoksa tamamı indirilir. */
function rangeFrom(body: Record<string, unknown> | undefined) {
  const start = body?.startSec;
  const end = body?.endSec;
  if ((start === undefined || start === null || start === '') && (end === undefined || end === null || end === '')) return null;
  const startSec = Number(start);
  const endSec = Number(end);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) throw badRequest('Aralık için başlangıç ve bitiş gerekli');
  if (startSec < 0) throw badRequest('Başlangıç 0\'dan küçük olamaz');
  if (endSec <= startSec) throw badRequest('Bitiş başlangıçtan sonra olmalı');
  return { startSec, endSec };
}

/**
 * Geçmiş yayınlar: Kick VOD listesi → indirme → zaman çizelgesinde kesit
 * işaretleme (elle) ya da otomatik en iyi anları dikey klibe çevirme.
 */
export function vodRoutes({ store, vodScanner }: AppContext) {
  const r = express.Router();

  const downloadedJob = async (id: number, userId: number) => {
    const job = await store.getVodScanJobById(id, userId);
    if (!job) throw notFound('Yayın işi bulunamadı');
    if (job.status !== 'downloaded') throw badRequest('Yayın henüz inmedi ya da saklama süresi doldu');
    return job;
  };

  r.get('/vods', async (req, res) => {
    const channel = slugOrThrow(req.query.channel || req.user!.channelSlug);
    res.json({ channel, videos: await engine(() => vodScanner.listVideos(channel), 502) });
  });

  r.post('/vods/download', async (req, res) => {
    const channel = slugOrThrow(req.body?.channel || req.user!.channelSlug);
    const videoId = String(req.body?.videoId || '').trim();
    if (!videoId) throw badRequest('Yayın seçin');
    const quality = oneOf(req.body?.quality, QUALITIES, '720p');
    const range = rangeFrom(req.body);
    res.json({ job: await engine(() => vodScanner.enqueue(req.user!.id, { channelSlug: channel, videoId, quality, range }), 502) });
  });

  /**
   * Süren yayının başından şu ana kadarki bölümünü indirir — yayın akarken kesit
   * almanın yolu. `startSec`/`endSec` verilirse yalnız o aralık alınır; bitiş
   * henüz yayınlanmadıysa yayın o ana gelene kadar beklenir.
   */
  r.post('/vods/capture-live', async (req, res) => {
    const channel = slugOrThrow(req.body?.channel || req.user!.channelSlug);
    const quality = oneOf(req.body?.quality, QUALITIES, '1080p');
    const range = rangeFrom(req.body);
    res.json({ job: await engine(() => vodScanner.enqueueLive(req.user!.id, { channelSlug: channel, quality, range }), 502) });
  });

  r.get('/vod-jobs', async (req, res) => {
    res.json({ jobs: await vodScanner.getJobs(req.user!.id, 40) });
  });

  r.get('/vod-jobs/:id', async (req, res) => {
    const userId = req.user!.id;
    const detail = await engine(() => vodScanner.getJobDetail(intParam(req.params.id), userId), 404);
    // Sunucu içi dosya yolu tarayıcıya verilmez; aynı deterministik yoldan adres türetilir.
    const vodUrl = detail.job.vod_path ? `/clips/${userId}/vod-work/${detail.job.id}/vod.mp4` : null;
    const { vod_path: _hidden, ...job } = detail.job;
    res.json({ ...detail, job, vodUrl });
  });

  r.get('/vod-jobs/:id/filmstrip', async (req, res) => {
    res.json({ frames: await engine(() => vodScanner.getFilmstrip(intParam(req.params.id), req.user!.id), 404) });
  });

  r.post('/vod-jobs/:id/cuts', async (req, res) => {
    const userId = req.user!.id;
    const id = intParam(req.params.id);
    const job = await downloadedJob(id, userId);
    const raw: any[] = Array.isArray(req.body?.cuts) ? req.body.cuts.slice(0, 100) : [];
    if (!raw.length) throw badRequest('En az bir kesit işaretleyin');
    const duration = job.duration_sec || Number.POSITIVE_INFINITY;
    const cuts: { id: number; start: number; end: number; label: string | null; camFull: { start: number; end: number }[] }[] = [];
    for (const c of raw) {
      const start = Math.max(0, Number(c?.start) || 0);
      const end = Math.min(duration, Number(c?.end) || 0);
      if (!(end > start)) continue;
      const row = await store.addVodManualClip(id, {
        label: typeof c?.label === 'string' ? c.label.slice(0, 100) : null,
        color: typeof c?.color === 'string' ? c.color.slice(0, 20) : null,
        startSec: start,
        endSec: end,
      });
      cuts.push({ id: row!.id, start, end, label: row!.label, camFull: camFullFrom(c?.camFull, start, end) });
    }
    if (!cuts.length) throw badRequest('Geçerli kesit yok — başlangıç ve bitişi kontrol edin');
    await engine(() => vodScanner.queueManualCut(id, userId, cuts, clipOptionsFrom(req.body)), 502);
    res.json({ clips: cuts });
  });

  r.post('/vod-jobs/:id/auto', async (req, res) => {
    const userId = req.user!.id;
    const id = intParam(req.params.id);
    await downloadedJob(id, userId);
    const count = Math.min(30, Math.max(1, Number.parseInt(req.body?.count, 10) || 3));
    await engine(() => vodScanner.queueAutoVertical(id, userId, count, clipOptionsFrom(req.body)), 502);
    res.json({ ok: true, count });
  });

  for (const action of ['cancel', 'pause', 'resume'] as const) {
    r.post(`/vod-jobs/:id/${action}`, async (req, res) => {
      await engine(() => vodScanner[action](intParam(req.params.id), req.user!.id));
      res.json({ ok: true });
    });
  }

  r.delete('/vod-jobs/:id', async (req, res) => {
    await engine(() => vodScanner.remove(intParam(req.params.id), req.user!.id));
    res.json({ ok: true });
  });

  return r;
}
