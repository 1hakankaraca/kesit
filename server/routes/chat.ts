import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { CHAT_SOURCE_MAX, mergeRanges, neededChatRanges, normalizeChatPlan, type ChatRange } from '../../shared/chat.ts';
import type { AppContext } from '../context.ts';
import { badRequest, intParam, notFound, receiveFile } from '../http.ts';
import { effectiveChatLayers } from '../../shared/frame.ts';
import { chatPageFile } from '../services/ChatOverlay.ts';

const ID = /^[a-z0-9_-]{1,40}$/i;
const PAGE_MAX_BYTES = 48 * 1024 * 1024;

/**
 * Editördeki sohbet katmanı: bağlı videonun sohbet geçmişi (çekme/okuma),
 * emote ve rozet görselleri, dışa aktarma için satır sayfaları ve plan.
 */
export function chatRoutes({ projects, chatHistory }: AppContext) {
  const r = express.Router();
  const idParam = (v: unknown, label: string) => {
    const s = String(v || '');
    if (!ID.test(s)) throw badRequest(`${label} geçersiz`);
    return s;
  };
  const videoAsset = (userId: number, projectId: number, assetId: string) => {
    const project = projects.get(userId, projectId);
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) throw notFound('Varlık bulunamadı');
    if (asset.kind !== 'video') throw badRequest('Sohbet yalnız videoya eklenebilir');
    return { project, asset };
  };
  const sendImage = (res: express.Response, img: { file: string; type: string }) => {
    res.set({ 'Content-Type': img.type, 'Cache-Control': 'private, max-age=604800, immutable' });
    res.sendFile(path.resolve(img.file));
  };

  /* ── Sohbet verisi ─────────────────────────────────────────────────────── */

  r.get('/projects/:id/assets/:aid/chat', (req, res) => {
    const userId = req.user!.id;
    const projectId = intParam(req.params.id);
    const { asset } = videoAsset(userId, projectId, idParam(req.params.aid, 'Varlık kimliği'));
    const raw = chatHistory.readRaw(userId, projectId, asset.id);
    // Büyük dosya çözülüp yeniden yazılmadan geçirilir.
    res.type('application/json').send(`{"chat":${raw ?? 'null'}}`);
  });

  /**
   * Sohbeti çeker. `ranges` (kaynak saniyesi) verilmezse projede bu videodan
   * kullanılan bölümler (öncesi payıyla) alınır; daha önce çekilmiş bölümler
   * yeniden istenmez.
   */
  r.post('/projects/:id/assets/:aid/chat', async (req, res) => {
    const userId = req.user!.id;
    const projectId = intParam(req.params.id);
    const { project, asset } = videoAsset(userId, projectId, idParam(req.params.aid, 'Varlık kimliği'));
    const asked: ChatRange[] = Array.isArray(req.body?.ranges)
      ? req.body.ranges.slice(0, 200).map((x: any) => ({ start: Math.max(0, Number(x?.start)), end: Math.min(CHAT_SOURCE_MAX, Number(x?.end)) }))
      : neededChatRanges(project, asset.id);
    let ranges = mergeRanges(asked);
    if (!ranges.length) ranges = [{ start: 0, end: Math.max(1, asset.duration) }];
    const chat = await chatHistory.ensure(userId, projectId, asset, ranges);
    res.json({ chat });
  });

  /* ── Görseller ─────────────────────────────────────────────────────────── */

  r.get('/chat/emote/:eid', async (req, res) => {
    sendImage(res, await chatHistory.emote(String(req.params.eid)));
  });

  r.get('/chat/img', async (req, res) => {
    sendImage(res, await chatHistory.image(String(req.query.u || '')));
  });

  /* ── Dışa aktarma hazırlığı ────────────────────────────────────────────── */

  const renderTarget = (req: express.Request) => {
    const userId = req.user!.id;
    const projectId = intParam(req.params.id);
    const chatId = idParam(req.params.cid, 'Sohbet kimliği');
    const project = projects.get(userId, projectId);
    // Çerçeve aralığı için türetilen sanal katmanlar (`<sohbet>_<çerçeve>`) da kendi planını yükler.
    if (!effectiveChatLayers(project).some((e) => e.layer.id === chatId)) throw notFound('Sohbet katmanı bulunamadı');
    return { dir: chatHistory.renderDir(userId, projectId, chatId), chatId };
  };

  /** Satır sayfası (PNG, ham gövde). Ad: sayfa numarası ya da arka plan için `bg`. */
  r.post('/projects/:id/chat-render/:cid/page/:name', async (req, res) => {
    const { dir } = renderTarget(req);
    const raw = String(req.params.name);
    if (raw !== 'bg' && !/^\d{1,4}$/.test(raw)) throw badRequest('Sayfa adı geçersiz');
    if (!/^image\/png\b/.test(String(req.headers['content-type'] || ''))) throw badRequest('Sayfa PNG olmalı');
    await receiveFile(req, chatPageFile(dir, raw === 'bg' ? 'bg' : Number(raw)), PAGE_MAX_BYTES);
    res.json({ ok: true });
  });

  /** Plan: sayfalar yüklendikten sonra gönderilir; fazlalık eski sayfalar silinir. */
  r.put('/projects/:id/chat-render/:cid', (req, res) => {
    const { dir, chatId } = renderTarget(req);
    const plan = normalizeChatPlan({ ...(req.body?.plan || {}), chatId });
    if (!plan) throw badRequest('Sohbet planı geçersiz');
    for (let n = 0; n < plan.pages; n++) if (!fs.existsSync(chatPageFile(dir, n))) throw badRequest(`Sohbet sayfası ${n} eksik`);
    if (plan.hasBackground && !fs.existsSync(chatPageFile(dir, 'bg'))) throw badRequest('Sohbet arka planı eksik');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^page-(\d+)\.png$/);
      if ((m && Number(m[1]) >= plan.pages) || (name === 'bg.png' && !plan.hasBackground)) fs.rmSync(path.join(dir, name), { force: true });
    }
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
    res.json({ ok: true, rows: plan.rows.length });
  });

  return r;
}
