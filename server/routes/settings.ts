import express from 'express';
import os from 'node:os';
import { config } from '../config.ts';
import type { AppContext } from '../context.ts';
import { badRequest, engine } from '../http.ts';
import { normalizeSlug, searchChannels } from '../lib/kick.ts';

const MAX_TABS = 12;

function parseTabs(raw: unknown): string[] {
  try {
    const list = typeof raw === 'string' ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.map(normalizeSlug).filter((s): s is string => !!s).slice(0, MAX_TABS) : [];
  } catch {
    return [];
  }
}

/** Bu bilgisayarın yerel ağ adresleri — aynı Wi-Fi'daki telefondan açmak için. */
function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n): n is os.NetworkInterfaceInfo => !!n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

/** Kick kanal araması: giriş ekranı da kullandığı için oturum istemez. */
export function publicKickRoutes() {
  const r = express.Router();
  r.get('/kick/search', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 40);
    if (q.length < 2) {
      res.json({ channels: [] });
      return;
    }
    res.json({ channels: await engine(() => searchChannels(q), 502) });
  });
  return r;
}

/** Kanal sekmeleri, sistem bilgisi ve altyazı motoru ayarları. */
export function settingsRoutes({ store, captions }: AppContext) {
  const r = express.Router();

  r.get('/me/channels', async (req, res) => {
    const s = await store.getSettings(req.user!.id);
    const tabs = parseTabs(s.channel_tabs);
    const active = req.user!.channelSlug;
    if (active && !tabs.includes(active)) tabs.unshift(active);
    res.json({ tabs, active });
  });

  /** Sekmeleri ve etkin kanalı kaydeder. Etkin kanal tarama/kayıt/nöbetin varsayılanıdır. */
  r.put('/me/channels', async (req, res) => {
    const tabs = parseTabs(JSON.stringify(req.body?.tabs ?? []));
    const active = req.body?.active ? normalizeSlug(req.body.active) : null;
    if (req.body?.active && !active) throw badRequest('Geçersiz kanal adı');
    if (active && !tabs.includes(active)) tabs.push(active);
    await store.updateSettings(req.user!.id, { channel_tabs: JSON.stringify([...new Set(tabs)].slice(0, MAX_TABS)) });
    store.setUserChannel(req.user!.id, active);
    res.json({ tabs, active, user: { ...req.user, channelSlug: active } });
  });

  r.get('/system', (_req, res) => {
    res.json({ lan: lanAddresses(), dataDir: config.dataDir, hostname: os.hostname(), platform: process.platform });
  });

  r.get('/captions', (_req, res) => {
    res.json(captions.status());
  });

  r.put('/captions/elevenlabs', async (req, res) => {
    res.json(await captions.setElevenLabsKey(String(req.body?.apiKey || '')));
  });

  r.delete('/captions/elevenlabs', async (_req, res) => {
    res.json(await captions.setElevenLabsKey(null));
  });

  r.post('/captions/models/:id/download', (req, res) => {
    res.json(captions.startDownload(String(req.params.id)));
  });

  r.post('/captions/models/cancel', (_req, res) => {
    captions.cancelDownload();
    res.json({ ok: true });
  });

  r.put('/captions/models/:id', (req, res) => {
    res.json(captions.useModel(String(req.params.id)));
  });

  r.delete('/captions/models/:id', (req, res) => {
    res.json(captions.remove(String(req.params.id)));
  });

  return r;
}
