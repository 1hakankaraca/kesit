import express from 'express';
import type { AppContext } from '../context.ts';
import { intParam } from '../http.ts';

/** null/'' kök demektir; aksi hâlde geçerli bir klasör kimliği. */
const folderParam = (v: unknown) => (v === null || v === undefined || v === '' || v === 'root' ? null : intParam(v, 'Klasör'));

/** Galeri klasörleri: listele, oluştur, yeniden adlandır/taşı, sil, öğe taşı. */
export function galleryRoutes({ gallery }: AppContext) {
  const r = express.Router();

  r.get('/gallery/folders', (req, res) => {
    res.json(gallery.list(req.user!.id));
  });

  r.post('/gallery/folders', (req, res) => {
    res.json({ folder: gallery.create(req.user!.id, { name: req.body?.name, parentId: folderParam(req.body?.parentId), color: req.body?.color }) });
  });

  r.patch('/gallery/folders/:id', (req, res) => {
    const body = req.body || {};
    res.json({
      folder: gallery.update(req.user!.id, intParam(req.params.id), {
        name: body.name,
        parentId: 'parentId' in body ? folderParam(body.parentId) : undefined,
        color: body.color,
      }),
    });
  });

  r.delete('/gallery/folders/:id', (req, res) => {
    res.json(gallery.remove(req.user!.id, intParam(req.params.id)));
  });

  r.post('/gallery/move', (req, res) => {
    res.json(gallery.move(req.user!.id, req.body?.keys, folderParam(req.body?.folderId)));
  });

  return r;
}
