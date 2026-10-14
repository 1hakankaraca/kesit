import express from 'express';
import fs from 'node:fs';
import type { AppContext } from '../context.ts';
import { ClipCompressor, ClipEditorManager } from '../engine.ts';
import { accountsFrom, badRequest, clipOptionsFrom, downloadName, engine, intParam, notFound, oneOf, slugOrThrow } from '../http.ts';

const KICK_CLIP_ID = /^clip_[A-Za-z0-9]+$/;
const KICKBOT_CLIP_ID = /^[a-z0-9]{1,40}$/i;

/** Bağlantıdan klip kimliği: kick.com ya da kickbot.com biçimleri. */
function parseClipLink(url: string): { type: 'kick' | 'kickbot'; id: string } | null {
  const kickbot = url.match(/kickbot\.com\/clip\/([a-z0-9]+)/i);
  if (kickbot) return { type: 'kickbot', id: kickbot[1] };
  const kick =
    url.match(/kick\.com\/[^?\s]+\?clip=(clip_[A-Za-z0-9]+)/i) ||
    url.match(/kick\.com\/(?:[^/\s]+\/)?clips\/(clip_[A-Za-z0-9]+)/i) ||
    url.match(/^(clip_[A-Za-z0-9]+)$/);
  return kick ? { type: 'kick', id: kick[1] } : null;
}

/** Kick klipleri: tarama, kuyruğa alma, üretilen işler, sıkıştırma ve paylaşım. */
export function clipRoutes({ workspaces, store, publishing }: AppContext) {
  const r = express.Router();

  r.get('/clips/browse', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const channel = slugOrThrow(req.query.channel || req.user!.channelSlug);
    const time = oneOf(req.query.time, ['all', 'month', 'week', 'day'] as const, 'all');
    const sort = oneOf(req.query.sort, ['view', 'date'] as const, 'view');
    const source = req.query.source === 'kickbot' ? 'kickbot' : 'kick';
    const cursor = String(req.query.cursor || '0').slice(0, 300);
    const page = await engine(
      () =>
        source === 'kickbot'
          ? ws.clipEditor.browseKickbotChannelClips(channel, { offset: Number.parseInt(cursor, 10) || 0, sort, time })
          : ws.clipEditor.browseChannelClips(channel, { cursor, time, sort }),
      502,
    );
    res.json({ channel, source, ...page });
  });

  r.post('/clips/process', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const channel = slugOrThrow(req.body?.channel);
    const clips = req.body?.clips;
    if (!Array.isArray(clips) || clips.length === 0 || clips.length > 20) throw badRequest('1-20 arası klip seçin');
    const options = clipOptionsFrom(req.body);
    const jobs = [];
    const errors: string[] = [];
    for (const item of clips) {
      const id = String(item?.id || '');
      const type = item?.type === 'kickbot' ? 'kickbot' : 'kick';
      if (!(type === 'kickbot' ? KICKBOT_CLIP_ID : KICK_CLIP_ID).test(id)) continue;
      const opts = { title: String(item?.title || '').slice(0, 200), channelSlug: channel, source: 'popular', group: 'gezgin', options };
      try {
        jobs.push(type === 'kickbot' ? await ws.clipEditor.enqueueKickbotClip(id, opts) : await ws.clipEditor.enqueueKickClip(id, opts));
      } catch (err) {
        errors.push(`${id}: ${(err as Error).message}`);
      }
    }
    if (!jobs.length) throw badRequest(errors.join('; ') || 'Hiçbir klip kuyruğa eklenemedi');
    res.json({ jobs, errors });
  });

  r.post('/clips/from-url', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const link = parseClipLink(String(req.body?.url || '').trim().slice(0, 500));
    if (!link) throw badRequest('Geçersiz klip bağlantısı — kick.com ya da kickbot.com klip adresi yapıştırın');
    const opts = { channelSlug: req.user!.channelSlug || '', source: 'link', group: 'gezgin', options: clipOptionsFrom(req.body) };
    const job = await engine(
      () => (link.type === 'kickbot' ? ws.clipEditor.enqueueKickbotClip(link.id, opts) : ws.clipEditor.enqueueKickClip(link.id, opts)),
      502,
    );
    res.json({ job });
  });

  r.post('/clips/popular', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const channel = slugOrThrow(req.body?.channel || req.user!.channelSlug);
    const limit = Math.min(10, Math.max(1, Number(req.body?.limit) || 5));
    const time = oneOf(req.body?.time, ['all', 'month', 'week', 'day'] as const, 'week');
    const result = await engine(() => ws.clipEditor.enqueuePopularClips(channel, { limit, time, options: clipOptionsFrom(req.body) }), 502);
    res.json(result);
  });

  /* ── Üretilen işler ──────────────────────────────────────────────────── */

  r.get('/jobs', async (req, res) => {
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 120));
    res.json({ jobs: await store.getEditedClips(req.user!.id, limit), queue: ClipEditorManager.getQueueStatus() });
  });

  r.get('/jobs/:id', async (req, res) => {
    const job = await store.getEditedClipById(intParam(req.params.id), req.user!.id);
    if (!job) throw notFound('Klip bulunamadı');
    res.json({ job });
  });

  r.post('/jobs/:id/retry', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    res.json({ job: await engine(() => ws.clipEditor.retry(intParam(req.params.id))) });
  });

  r.post('/jobs/:id/recrop', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const { cropLeft, cropRight } = req.body || {};
    res.json({ job: await engine(() => ws.clipEditor.recropClip(intParam(req.params.id), { cropLeft: Number(cropLeft), cropRight: Number(cropRight) })) });
  });

  r.delete('/jobs/:id', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    if (!(await ws.clipEditor.remove(intParam(req.params.id)))) throw notFound('Klip bulunamadı');
    res.json({ ok: true });
  });

  r.post('/jobs/bulk-delete', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const ids: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 200) : [];
    let removed = 0;
    for (const id of ids) if (await ws.clipEditor.remove(intParam(id)).catch(() => false)) removed++;
    res.json({ removed });
  });

  /* ── Sıkıştırarak indirme ────────────────────────────────────────────── */

  r.post('/jobs/:id/compress', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const job = await store.getEditedClipById(intParam(req.params.id), req.user!.id);
    if (!job || job.status !== 'ready') throw notFound('Hazır klip bulunamadı');
    const profile = String(req.body?.profile || '');
    if (!ClipCompressor.gecerliProfil(profile)) throw badRequest('Geçersiz sıkıştırma profili');
    const source = `${ws.clipEditor.outputDir}/${job.id}.mp4`;
    const result = await engine(() => ws.compressor.sikistir(job.id, profile, source));
    res.json({ ...result, downloadUrl: `/api/jobs/${job.id}/compress/download?profile=${profile}` });
  });

  r.get('/jobs/:id/compress/download', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const job = await store.getEditedClipById(intParam(req.params.id), req.user!.id);
    const profile = String(req.query.profile || '');
    if (!job || !ClipCompressor.gecerliProfil(profile)) throw notFound();
    const file = ws.compressor.ciktiYolu(job.id, profile);
    if (!fs.existsSync(file)) throw notFound('Sıkıştırılmış dosya bulunamadı — tekrar deneyin');
    res.download(file, downloadName(job.gen_title || job.title, `klip-${job.id}`, `-${profile}.mp4`));
  });

  r.get('/jobs/:id/download', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const job = await store.getEditedClipById(intParam(req.params.id), req.user!.id);
    const file = job && `${ws.clipEditor.outputDir}/${job.id}.mp4`;
    if (!file || !fs.existsSync(file)) throw notFound('Klip dosyası bulunamadı');
    res.download(file, downloadName(job!.gen_title || job!.title, `klip-${job!.id}`));
  });

  /* ── Paylaşım ────────────────────────────────────────────────────────── */

  r.post('/jobs/:id/publish', async (req, res) => {
    res.json(await publishing.publishClip(req.user!.id, intParam(req.params.id), req.body, accountsFrom(req.body?.accounts)));
  });

  r.get('/jobs/:id/publish-status', async (req, res) => {
    res.json(await publishing.refreshStatus(req.user!.id, intParam(req.params.id)));
  });

  r.get('/schedule', async (req, res) => {
    res.json({ entries: await publishing.schedule(req.user!.id) });
  });

  return r;
}
