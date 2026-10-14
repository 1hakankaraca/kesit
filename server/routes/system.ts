import express from 'express';
import type { AppContext } from '../context.ts';
import { intParam, requireLocal } from '../http.ts';

/** Sistem görev yöneticisi: işlemci, bellek, disk ve Kesit'in süreçleri. */
export function systemRoutes({ system }: AppContext) {
  const r = express.Router();

  r.get('/system/monitor', async (_req, res) => {
    res.json(await system.report());
  });

  r.post('/system/kill', requireLocal, async (req, res) => {
    await system.kill(intParam(req.body?.pid, 'Süreç'));
    res.json({ ok: true });
  });

  return r;
}
