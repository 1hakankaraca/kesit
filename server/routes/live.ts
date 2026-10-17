import axios from 'axios';
import express from 'express';
import type { AppContext } from '../context.ts';
import { BROWSER_HEADERS } from '../engine.ts';
import { accountsFrom, badRequest, engine, intParam, slugOrThrow } from '../http.ts';
import { fetchChannel } from '../lib/kick.ts';

const encode = (u: string) => Buffer.from(u, 'utf8').toString('base64url');
const decode = (k: unknown) => {
  try {
    return Buffer.from(String(k), 'base64url').toString('utf8');
  } catch {
    return '';
  }
};

/** Vekil yalnız kaydın kendi CDN alan adına gider (açık vekil olmasın diye). */
function sameHost(candidate: string, source: string) {
  try {
    const a = new URL(candidate);
    const s = new URL(source);
    if (a.protocol !== 'https:') return false;
    const root = s.hostname.split('.').slice(-2).join('.');
    return a.hostname === s.hostname || a.hostname.endsWith(`.${root}`);
  } catch {
    return false;
  }
}

/**
 * Canlı: chat klip yakalama, yayın kaydı, canlı önizleme vekili ve
 * Nöbetçi (bilgisayar başında değilken otomatik kayıt/klip).
 */
export function liveRoutes({ workspaces, autopilot, publishing, kickChat, harvester, snippets }: AppContext) {
  const r = express.Router();

  r.get('/live', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    res.json({
      watcher: ws.clipWatcher.getStatus(),
      recorder: ws.recorder.getStatus(),
      autopilot: await autopilot.status(req.user!.id),
      chatAccess: kickChat.connected(req.user!.id),
    });
  });

  /**
   * Anlık klip: yayının son N saniyesini Kick'in süren yayın kaydından kesit
   * olarak alır, ham saklar ve dikey videoya çevirir. Sohbete komut yazılmaz.
   * (Sohbete "!clip" yazmak isteyenler için eski uç: /live/chat-clip.)
   */
  r.post('/live/quick-clip', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const channel = slugOrThrow(req.body?.channel || ws.clipWatcher.channelSlug || req.user!.channelSlug);
    res.json(await snippets.capture(req.user!.id, channel, Number(req.body?.seconds), { autoEdit: req.body?.autoEdit !== false }));
  });

  r.post('/live/chat-clip', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const channel = slugOrThrow(req.body?.channel || ws.clipWatcher.channelSlug || req.user!.channelSlug);
    res.json(await kickChat.sendClipCommand(req.user!.id, channel, Number(req.body?.seconds)));
  });

  /* ── Kesitler ─────────────────────────────────────────────────────────── */

  r.get('/snippets', (req, res) => {
    res.json({ snippets: snippets.list(req.user!.id) });
  });

  r.post('/snippets/capture', async (req, res) => {
    const channel = slugOrThrow(req.body?.channel || req.user!.channelSlug);
    res.json(await snippets.capture(req.user!.id, channel, Number(req.body?.seconds), { autoEdit: req.body?.autoEdit !== false }));
  });

  r.post('/snippets/:id/edit', async (req, res) => {
    res.json({ job: await engine(() => snippets.edit(req.user!.id, intParam(req.params.id)), 502) });
  });

  r.post('/snippets/:id/cancel', (req, res) => {
    res.json({ cancelled: snippets.cancel(req.user!.id, intParam(req.params.id)) });
  });

  r.delete('/snippets/:id', async (req, res) => {
    res.json({ ok: await snippets.remove(req.user!.id, intParam(req.params.id)) });
  });

  /* ── Kanal klip takibi (Kick'e eklenen yeni klipleri indirir) ─────── */

  r.get('/harvest', async (req, res) => {
    res.json(await harvester.state(req.user!.id));
  });

  r.put('/harvest', async (req, res) => {
    const body = req.body || {};
    res.json(await harvester.update(req.user!.id, { ...body, channel: body.channel ? slugOrThrow(body.channel) : null }));
  });

  r.delete('/harvest/:id', async (req, res) => {
    res.json({ ok: await harvester.remove(req.user!.id, intParam(req.params.id)) });
  });

  r.post('/harvest/:id/edit', async (req, res) => {
    res.json({ job: await engine(() => harvester.edit(req.user!.id, intParam(req.params.id)), 502) });
  });

  r.get('/live/channel', async (req, res) => {
    const channel = slugOrThrow(req.query.channel || req.user!.channelSlug);
    res.json(await engine(() => fetchChannel(channel), 502));
  });

  r.post('/live/watch', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const channel = slugOrThrow(req.body?.channel);
    const autoPublish = req.body?.autoPublish === true;
    const accounts = accountsFrom(req.body?.publishAccounts);
    if (autoPublish) await publishing.assertAutoPublishAccounts(req.user!.id, accounts);
    const status = await engine(
      () =>
        ws.clipWatcher.watch(channel, {
          autoEdit: req.body?.autoEdit === true,
          autoPublish,
          publishAccounts: accounts,
          subtitles: req.body?.subtitles !== false,
        }),
      502,
    );
    // Dinleme, sohbete düşen bağlantılarla birlikte kanala Kick'te eklenen yeni klipleri de kapsar.
    await harvester.follow(req.user!.id, channel, req.body?.autoEdit === true);
    res.json({ status });
  });

  r.post('/live/unwatch', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    ws.clipWatcher.unwatch();
    await harvester.unfollow(req.user!.id);
    res.json({ status: ws.clipWatcher.getStatus() });
  });

  r.post('/live/record/start', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const channel = slugOrThrow(req.body?.channel);
    const backfillMinutes = Number(req.body?.backfillMinutes) || 0;
    if (backfillMinutes < 0 || backfillMinutes > 240) throw badRequest('Geçmiş süresi 0-240 dakika olmalı');
    const recording = await engine(() =>
      ws.recorder.start(channel, { backfillSec: Math.round(backfillMinutes * 60), follow: req.body?.follow !== false }),
    );
    res.json({ recording, status: ws.recorder.getStatus() });
  });

  r.post('/live/record/stop', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    if (!ws.recorder.isRecording) throw badRequest('Süren bir kayıt yok');
    const recording = await engine(() => ws.recorder.stop(), 500);
    res.json(recording?.finishing ? { finishing: true, recording: null } : { recording });
  });

  /* ── Canlı önizleme (HLS vekili) ─────────────────────────────────────── */
  // Kick'in oynatma belirteci CORS iznini yalnız kick.com'a veriyor; panel
  // playlist'i ve parçaları kendi sunucusu üzerinden alır.

  r.get('/live/preview/playlist.m3u8', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const source = ws.recorder.getLiveSource();
    if (!source) {
      res.status(404).type('text/plain').send('Süren kayıt yok');
      return;
    }
    const upstream = await axios
      .get(source.playlistUrl, { headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] }, timeout: 10_000, responseType: 'text' })
      .catch(() => null);
    if (!upstream) {
      res.status(502).type('text/plain').send('Playlist alınamadı');
      return;
    }
    const lines = String(upstream.data)
      .split('\n')
      .map((line) => {
        const t = line.trim();
        if (!t) return line;
        const tag = /^(#EXT-X-(?:MAP|KEY|PART|PRELOAD-HINT)[^\n]*?URI=")([^"]+)(")/.exec(t);
        if (tag) return t.replace(tag[0], `${tag[1]}seg?u=${encode(new URL(tag[2], source.playlistUrl).toString())}${tag[3]}`);
        if (t.startsWith('#')) return line;
        const abs = new URL(t, source.playlistUrl).toString();
        return sameHost(abs, source.playlistUrl) ? `seg?u=${encode(abs)}` : '';
      });
    res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }).send(lines.join('\n'));
  });

  r.get('/live/preview/seg', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const source = ws.recorder.getLiveSource();
    const target = decode(req.query.u);
    if (!source || !target || !sameHost(target, source.playlistUrl)) {
      res.status(404).end();
      return;
    }
    const upstream = await axios
      .get(target, { headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] }, timeout: 20_000, responseType: 'stream' })
      .catch(() => null);
    if (!upstream) {
      res.status(502).end();
      return;
    }
    res.set({ 'Content-Type': upstream.headers['content-type'] || 'video/mp2t', 'Cache-Control': 'no-store' });
    upstream.data.on('error', () => res.end());
    req.on('close', () => upstream.data.destroy());
    upstream.data.pipe(res);
  });

  /* ── Nöbetçi ─────────────────────────────────────────────────────────── */

  r.get('/autopilot', async (req, res) => {
    res.json(await autopilot.status(req.user!.id));
  });

  r.put('/autopilot', async (req, res) => {
    const body = req.body || {};
    const channel = body.channel ? slugOrThrow(body.channel) : null;
    const accounts = accountsFrom(body.publishAccounts);
    if (body.enabled && body.autoPublish) await publishing.assertAutoPublishAccounts(req.user!.id, accounts);
    res.json(await engine(() => autopilot.update(req.user!.id, { ...body, channel, publishAccounts: accounts })));
  });

  return r;
}
