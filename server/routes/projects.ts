import express from 'express';
import path from 'node:path';
import type { AppContext } from '../context.ts';
import { badRequest, intParam, notFound } from '../http.ts';
import { addClipFor, originFrom } from '../services/Projects.ts';

const ASSET_ID = /^[a-z0-9_-]{1,40}$/i;

/** Editör projeleri: kayıt, varlıklar, döküm, yüz kamerası ve dışa aktarma. */
export function projectRoutes({ projects }: AppContext) {
  const r = express.Router();
  const assetId = (v: unknown) => {
    const s = String(v || '');
    if (!ASSET_ID.test(s)) throw badRequest('Varlık kimliği geçersiz');
    return s;
  };

  r.get('/projects', (req, res) => {
    res.json({ projects: projects.list(req.user!.id), renders: projects.renderStatus(req.user!.id) });
  });

  r.post('/projects', async (req, res) => {
    res.json({ project: await projects.create(req.user!.id, req.body || {}) });
  });

  r.get('/projects/:id', (req, res) => {
    res.json({ project: projects.get(req.user!.id, intParam(req.params.id)), render: projects.renderStatus(req.user!.id).find((s) => s.projectId === Number(req.params.id)) ?? null });
  });

  r.put('/projects/:id', (req, res) => {
    const id = intParam(req.params.id);
    res.json({ project: projects.save(req.user!.id, { ...(req.body?.project || {}), id }) });
  });

  r.delete('/projects/:id', (req, res) => {
    projects.remove(req.user!.id, intParam(req.params.id));
    res.json({ ok: true });
  });

  r.get('/projects/:id/thumb', (req, res) => {
    const file = projects.thumbPath(req.user!.id, intParam(req.params.id));
    if (!file) throw notFound();
    res.sendFile(path.resolve(file));
  });

  /* ── Varlıklar ─────────────────────────────────────────────────────────── */

  /** Galeri'deki bir kaynağı projeye bağlar; istenirse zaman çizelgesine klip olarak da koyar. */
  r.post('/projects/:id/assets/link', async (req, res) => {
    const userId = req.user!.id;
    const project = projects.get(userId, intParam(req.params.id));
    const origin = originFrom(req.body?.from);
    if (!origin) throw badRequest('Geçersiz kaynak');
    const asset = await projects.link(userId, project, origin);
    let next = project;
    if (req.body?.place === true) next = projects.save(userId, addClipFor(project, asset, typeof req.body?.at === 'number' ? Math.max(0, req.body.at) : undefined));
    res.json({ asset, project: next });
  });

  /** Bilgisayardan dosya (ham gövde). Ad `x-kesit-name` başlığında (URL kodlu). */
  r.post('/projects/:id/assets/upload', async (req, res) => {
    const userId = req.user!.id;
    const project = projects.get(userId, intParam(req.params.id));
    const name = decodeURIComponent(String(req.headers['x-kesit-name'] || 'dosya')).slice(0, 160);
    const kind = req.headers['x-kesit-kind'] === 'render' ? 'render' : 'upload';
    const asset = await projects.upload(userId, project, req, { name, kind });
    res.json({ asset });
  });

  r.delete('/projects/:id/assets/:aid', (req, res) => {
    const userId = req.user!.id;
    const project = projects.get(userId, intParam(req.params.id));
    res.json({ project: projects.removeAsset(userId, project, assetId(req.params.aid)) });
  });

  r.get('/projects/:id/assets/:aid/stream', (req, res) => {
    const { file } = projects.assetFile(req.user!.id, intParam(req.params.id), assetId(req.params.aid));
    res.sendFile(path.resolve(file));
  });

  r.get('/projects/:id/assets/:aid/thumb', (req, res) => {
    const file = projects.assetThumb(req.user!.id, intParam(req.params.id), assetId(req.params.aid));
    if (!file) throw notFound();
    res.sendFile(path.resolve(file));
  });

  r.post('/projects/:id/assets/:aid/transcribe', async (req, res) => {
    const from = Number(req.body?.from) || 0;
    const to = Number(req.body?.to) || 0;
    const language = req.body?.language === 'en' ? 'en' : req.body?.language === 'tr' ? 'tr' : null;
    res.json({ captions: await projects.transcribe(req.user!.id, intParam(req.params.id), assetId(req.params.aid), { from, to, language }) });
  });

  r.post('/projects/:id/assets/:aid/facecam', async (req, res) => {
    res.json({ rect: await projects.facecam(req.user!.id, intParam(req.params.id), assetId(req.params.aid)) });
  });

  /* ── Dışa aktarma ──────────────────────────────────────────────────────── */

  r.post('/projects/:id/render', async (req, res) => {
    const id = intParam(req.params.id);
    res.json({ render: await projects.startRender(req.user!.id, { ...(req.body?.project || {}), id }) });
  });

  r.post('/projects/:id/render/cancel', (req, res) => {
    res.json({ cancelled: projects.cancelRender(req.user!.id, intParam(req.params.id)) });
  });

  return r;
}
