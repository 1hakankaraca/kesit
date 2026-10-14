import express from 'express';
import fs from 'node:fs';
import type { AppContext } from '../context.ts';
import { badRequest, notFound, oneOf } from '../http.ts';

/** Hesap, Zernio bağlantısı ve arşiv uçları. */
export function accountRoutes({ publishing, archive }: AppContext) {
  const r = express.Router();

  /* ── Zernio ──────────────────────────────────────────────────────────── */

  r.get('/zernio', async (req, res) => {
    res.json(await publishing.summary(req.user!.id));
  });

  /** Anahtarı doğrular ve erişilebilen profilleri döner (henüz kaydetmez). */
  r.post('/zernio/profiles', async (req, res) => {
    res.json({ profiles: await publishing.listProfiles(String(req.body?.apiKey || '')) });
  });

  r.put('/zernio', async (req, res) => {
    const { apiKey, profileId } = req.body || {};
    if (typeof apiKey !== 'string' || typeof profileId !== 'string') throw badRequest('Anahtar ve profil gerekli');
    res.json(await publishing.connect(req.user!.id, apiKey, profileId));
  });

  r.delete('/zernio', (req, res) => {
    publishing.disconnect(req.user!.id);
    res.json({ ok: true });
  });

  r.get('/zernio/tiktok/:accountId', async (req, res) => {
    res.json(await publishing.tiktokCreatorInfo(req.user!.id, String(req.params.accountId)));
  });

  /* ── Arşiv ───────────────────────────────────────────────────────────── */

  r.get('/archive', (req, res) => {
    // Sınırlar istemcinin yerel gün başlangıcına göre ISO zaman damgası olarak gelir.
    const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
    const from = iso(req.query.from);
    const to = iso(req.query.to);
    const kind = req.query.kind ? oneOf(req.query.kind, ['clip', 'recording', 'vod'] as const, 'clip') : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) || undefined : undefined;
    res.json({
      entries: archive.list(req.user!.id, { from, to, kind, q }),
      days: archive.dailyCounts(req.user!.id),
    });
  });

  r.get('/archive/:id/thumb', (req, res) => {
    const file = archive.thumbFile(req.user!.id, Number(req.params.id));
    if (!file || !fs.existsSync(file)) throw notFound();
    res.set('Cache-Control', 'private, max-age=86400').sendFile(file);
  });

  return r;
}
