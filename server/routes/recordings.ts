import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.ts';
import { ClipCompressor } from '../engine.ts';
import { HttpError, badRequest, camFullFrom, clipOptionsFrom, downloadName, engine, intParam, notFound } from '../http.ts';

const exists = (p: string | null | undefined) => !!p && fs.existsSync(p);
const compressKey = (id: number) => `rec-${id}`;

/**
 * Alınan yayın kayıtları: listeleme, oynatma, yayına hazır çıktı
 * (intro/outro/logo/bit hızı), kırpma, kesit çıkarma, sıkıştırarak indirme
 * ve YouTube'a (Zernio) taslak → gönder akışı.
 */
export function recordingRoutes({ store, workspaces, publishing }: AppContext) {
  const r = express.Router();

  const own = async (req: express.Request) => {
    const rec = await store.getStreamRecordingById(intParam(req.params.id), req.user!.id);
    if (!rec) throw notFound('Kayıt bulunamadı');
    return rec;
  };

  r.get('/recordings', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const rows = await store.getStreamRecordings(req.user!.id, 60);
    const recordings = rows.map(({ file_path, final_path, ...rec }) => ({
      ...rec,
      available: rec.status === 'ready' && exists(file_path),
      final_available: rec.final_status === 'ready' && exists(final_path),
      final_percent: ws.finalizer.yuzde(rec.id) ?? null,
    }));
    res.json({ recordings, recorder: ws.recorder.getStatus() });
  });

  r.get('/recordings/:id/stream', async (req, res) => {
    const rec = await own(req);
    const file = req.query.final === '1' ? rec.final_path : rec.file_path;
    if (!exists(file)) throw notFound('Kayıt dosyası bulunamadı');
    res.sendFile(path.resolve(file));
  });

  r.get('/recordings/:id/download', async (req, res) => {
    const rec = await own(req);
    const final = req.query.final === '1';
    const file = final ? rec.final_path : rec.file_path;
    if (!exists(file)) throw notFound('Kayıt dosyası bulunamadı');
    res.download(file, downloadName(rec.title, `kayit-${rec.id}`, final ? '-hazir.mp4' : '.mp4'));
  });

  r.post('/recordings/:id/final', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    res.json({ recording: await engine(() => ws.finalizer.baslat(intParam(req.params.id))) });
  });

  r.post('/recordings/:id/final/cancel', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    res.json({ cancelled: !!ws.finalizer.iptal(intParam(req.params.id)) });
  });

  r.post('/recordings/:id/edit', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const { trimStart, trimEnd, cuts, replace } = req.body || {};
    if (cuts !== undefined && (!Array.isArray(cuts) || cuts.length > 200)) throw badRequest('Geçersiz kesme listesi');
    const recording = await engine(() =>
      ws.editor.edit(intParam(req.params.id), {
        trimStart: Number(trimStart),
        trimEnd: Number(trimEnd),
        cuts: (cuts || []).map((c: any) => ({ start: Number(c?.start), end: Number(c?.end) })),
        replace: replace === true,
      }),
    );
    res.json({ recording });
  });

  r.post('/recordings/:id/segments', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const segments = Array.isArray(req.body?.segments)
      ? req.body.segments.slice(0, 50).map((k: any) => ({
          start: Number(k?.start),
          end: Number(k?.end),
          camFull: camFullFrom(k?.camFull, Number(k?.start), Number(k?.end)),
        }))
      : [];
    if (!segments.length) throw badRequest('En az bir kesit seçin');
    const result = await engine(() =>
      ws.editor.exportSegments(intParam(req.params.id), {
        segments,
        outputFormat: req.body?.outputFormat === 'vertical' ? 'vertical' : 'horizontal',
        options: clipOptionsFrom(req.body),
      }),
    );
    res.json(result);
  });

  /* ── Sıkıştırarak indirme (arka planda; ilerleme socket ile gelir) ───── */

  r.post('/recordings/:id/compress', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const rec = await own(req);
    const profile = String(req.body?.profile || '');
    if (!ClipCompressor.gecerliProfil(profile)) throw badRequest('Geçersiz sıkıştırma profili');
    const source = exists(rec.final_path) ? rec.final_path : rec.file_path;
    if (!exists(source)) throw notFound('Kayıt dosyası bulunamadı');
    ws.compressor.sikistir(compressKey(rec.id), profile, source).catch(() => {});
    res.json({ started: true });
  });

  r.get('/recordings/:id/compress/download', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const rec = await own(req);
    const profile = String(req.query.profile || '');
    if (!ClipCompressor.gecerliProfil(profile)) throw badRequest('Geçersiz sıkıştırma profili');
    const file = ws.compressor.ciktiYolu(compressKey(rec.id), profile);
    if (!exists(file)) throw notFound('Sıkıştırılmış dosya bulunamadı — tekrar deneyin');
    res.download(file, downloadName(rec.title, `kayit-${rec.id}`, `-${profile}.mp4`));
  });

  r.post('/recordings/:id/compress/cancel', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    res.json({ cancelled: !!ws.compressor.iptal(compressKey(intParam(req.params.id)), String(req.body?.profile || '')) });
  });

  /* ── YouTube (Zernio): taslak yükle → gönder ─────────────────────────── */

  r.post('/recordings/:id/youtube/draft', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const publisher = await publishing.requirePublisher(req.user!.id);
    res.json({ recording: await engine(() => ws.publisher.taslakYukle(intParam(req.params.id), publisher, req.body || {}), 502) });
  });

  r.post('/recordings/:id/youtube/send', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const publisher = await publishing.requirePublisher(req.user!.id);
    res.json({ recording: await engine(() => ws.publisher.gonder(intParam(req.params.id), publisher, req.body || {}), 502) });
  });

  r.get('/recordings/:id/youtube/status', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const publisher = await publishing.requirePublisher(req.user!.id);
    res.json({ recording: await engine(() => ws.publisher.durumYenile(intParam(req.params.id), publisher), 502) });
  });

  r.delete('/recordings/:id/youtube/draft', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const publisher = await publishing.requirePublisher(req.user!.id);
    res.json({ recording: await engine(() => ws.publisher.taslakSil(intParam(req.params.id), publisher), 502) });
  });

  r.delete('/recordings/:id', async (req, res) => {
    const ws = await workspaces.get(req.user!.id);
    const rec = await own(req);
    if (ws.recorder.getStatus()?.id === rec.id) throw badRequest('Süren kayıt silinemez — önce durdurun');
    if (rec.status === 'processing') throw badRequest('Düzenlenmekte olan kayıt silinemez');
    if (ws.editor._aktarimda?.has(rec.id)) throw badRequest('Bu kayıttan kesitler alınıyor — bitince silebilirsin');
    if (ws.finalizer.yuzde(rec.id) != null) throw badRequest('Çıktısı üretilmekte olan kayıt silinemez');
    if (['uploading', 'publishing'].includes(rec.publish_status)) throw new HttpError(409, 'YouTube\'a yüklenmekte olan kayıt silinemez');
    for (const file of [rec.file_path, rec.final_path]) if (file) fs.rmSync(file, { force: true });
    if (rec.publish_status === 'draft' && rec.publish_post_id) {
      const conn = await publishing.connection(req.user!.id);
      await conn.publisher?.deletePost(rec.publish_post_id).catch(() => {});
    }
    await store.deleteStreamRecording(rec.id, req.user!.id);
    res.json({ ok: true });
  });

  return r;
}
