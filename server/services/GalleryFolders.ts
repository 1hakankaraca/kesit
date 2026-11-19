import type { Store } from '../db/Store.ts';
import { badRequest, notFound } from '../http.ts';

export interface GalleryFolder {
  id: number;
  parentId: number | null;
  name: string;
  color: string | null;
  createdAt: string;
}

/** Galeri öğesi anahtarı: v<iş>, k<kayıt>, p<proje>. */
const ITEM_KEY = /^[vkp]\d{1,12}$/;
const MAX_FOLDERS = 500;
const MAX_DEPTH = 8;
const COLOR = /^#[0-9a-f]{6}$/i;

const cleanName = (raw: unknown) => {
  const name = String(raw ?? '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) throw badRequest('Klasör adı boş olamaz');
  return name;
};

/**
 * Galeri'nin dosya yöneticisi katmanı: kullanıcının klasörleri ve öğelerin
 * hangi klasörde durduğu. Video/kayıt/proje tablolarına dokunmaz; öğe
 * silinirse yerleşim kaydı zararsızca boşta kalır (listelenirken süzülür).
 */
export class GalleryFolders {
  constructor(private store: Store) {}

  list(userId: number): { folders: GalleryFolder[]; placements: Record<string, number> } {
    const folders = this.store
      .all('SELECT id, parent_id, name, color, created_at FROM gallery_folders WHERE user_id = ? ORDER BY name COLLATE NOCASE, id', [userId])
      .map((r) => ({
        id: Number(r.id),
        parentId: r.parent_id == null ? null : Number(r.parent_id),
        name: String(r.name),
        color: r.color ? String(r.color) : null,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      }));
    const placements: Record<string, number> = {};
    for (const r of this.store.all('SELECT item_key, folder_id FROM gallery_placements WHERE user_id = ?', [userId])) placements[String(r.item_key)] = Number(r.folder_id);
    return { folders, placements };
  }

  private own(userId: number, id: number) {
    const row = this.store.get('SELECT id, parent_id FROM gallery_folders WHERE id = ? AND user_id = ?', [id, userId]);
    if (!row) throw notFound('Klasör bulunamadı');
    return { id: Number(row.id), parentId: row.parent_id == null ? null : Number(row.parent_id) };
  }

  /** Klasörün kökten derinliği (1 = kökte). */
  private depth(userId: number, id: number | null) {
    let d = 0;
    let cur = id;
    while (cur != null && d <= MAX_DEPTH + 1) {
      d++;
      cur = this.own(userId, cur).parentId;
    }
    return d;
  }

  /** Aynı yerde aynı adlı klasör varsa "Ad (2)" gibi boş bir ad bulur. */
  private uniqueName(userId: number, parentId: number | null, name: string, exceptId?: number) {
    const taken = new Set(
      this.store
        .all('SELECT id, name FROM gallery_folders WHERE user_id = ? AND parent_id IS ?', [userId, parentId])
        .filter((r) => Number(r.id) !== exceptId)
        .map((r) => String(r.name).toLocaleLowerCase('tr')),
    );
    if (!taken.has(name.toLocaleLowerCase('tr'))) return name;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${name} (${i})`;
      if (!taken.has(candidate.toLocaleLowerCase('tr'))) return candidate;
    }
    return `${name} ${Date.now()}`;
  }

  create(userId: number, { name, parentId = null, color = null }: { name?: unknown; parentId?: number | null; color?: unknown }) {
    const count = Number(this.store.get('SELECT COUNT(*) AS n FROM gallery_folders WHERE user_id = ?', [userId])?.n ?? 0);
    if (count >= MAX_FOLDERS) throw badRequest(`En fazla ${MAX_FOLDERS} klasör olabilir`);
    if (parentId != null) this.own(userId, parentId);
    if (this.depth(userId, parentId) >= MAX_DEPTH) throw badRequest('Klasörler en fazla 8 kat iç içe olabilir');
    const finalName = this.uniqueName(userId, parentId, cleanName(name ?? 'Yeni klasör'));
    const res = this.store.run('INSERT INTO gallery_folders (user_id, parent_id, name, color) VALUES (?, ?, ?, ?)', [
      userId,
      parentId,
      finalName,
      typeof color === 'string' && COLOR.test(color) ? color : null,
    ]);
    return this.list(userId).folders.find((f) => f.id === Number(res.lastInsertRowid))!;
  }

  update(userId: number, id: number, patch: { name?: unknown; parentId?: number | null; color?: unknown }) {
    const folder = this.own(userId, id);
    if (patch.parentId !== undefined && patch.parentId !== folder.parentId) {
      const target = patch.parentId;
      if (target != null) {
        // Kendi içine ya da alt klasörlerinden birine taşınamaz.
        let cur: number | null = target;
        while (cur != null) {
          if (cur === id) throw badRequest('Klasör kendi içine taşınamaz');
          cur = this.own(userId, cur).parentId;
        }
        if (this.depth(userId, target) + this.subtreeHeight(userId, id) > MAX_DEPTH) throw badRequest('Klasörler en fazla 8 kat iç içe olabilir');
      }
      const name = String(this.store.get('SELECT name FROM gallery_folders WHERE id = ?', [id])?.name ?? 'Klasör');
      this.store.run('UPDATE gallery_folders SET parent_id = ?, name = ? WHERE id = ?', [target, this.uniqueName(userId, target, name, id), id]);
      folder.parentId = target;
    }
    if (patch.name !== undefined) {
      this.store.run('UPDATE gallery_folders SET name = ? WHERE id = ?', [this.uniqueName(userId, folder.parentId, cleanName(patch.name), id), id]);
    }
    if (patch.color !== undefined) {
      this.store.run('UPDATE gallery_folders SET color = ? WHERE id = ?', [typeof patch.color === 'string' && COLOR.test(patch.color) ? patch.color : null, id]);
    }
    return this.list(userId).folders.find((f) => f.id === id)!;
  }

  private subtreeHeight(userId: number, id: number): number {
    const kids = this.store.all('SELECT id FROM gallery_folders WHERE user_id = ? AND parent_id = ?', [userId, id]);
    return 1 + (kids.length ? Math.max(...kids.map((k) => this.subtreeHeight(userId, Number(k.id)))) : 0);
  }

  /** Klasörü siler; içindeki klasörler ve öğeler bir üst klasöre (ya da köke) taşınır. */
  remove(userId: number, id: number) {
    const folder = this.own(userId, id);
    this.store.run('BEGIN');
    try {
      const kids = this.store.all('SELECT id, name FROM gallery_folders WHERE user_id = ? AND parent_id = ?', [userId, id]);
      for (const k of kids) {
        this.store.run('UPDATE gallery_folders SET parent_id = ?, name = ? WHERE id = ?', [folder.parentId, this.uniqueName(userId, folder.parentId, String(k.name), Number(k.id)), k.id]);
      }
      if (folder.parentId == null) this.store.run('DELETE FROM gallery_placements WHERE user_id = ? AND folder_id = ?', [userId, id]);
      else this.store.run('UPDATE gallery_placements SET folder_id = ? WHERE user_id = ? AND folder_id = ?', [folder.parentId, userId, id]);
      this.store.run('DELETE FROM gallery_folders WHERE id = ? AND user_id = ?', [id, userId]);
      this.store.run('COMMIT');
    } catch (err) {
      this.store.run('ROLLBACK');
      throw err;
    }
    return { movedTo: folder.parentId };
  }

  /** Öğeleri bir klasöre (null = kök) taşır. */
  move(userId: number, rawKeys: unknown, folderId: number | null) {
    const keys = (Array.isArray(rawKeys) ? rawKeys : []).map(String).filter((k) => ITEM_KEY.test(k)).slice(0, 2000);
    if (!keys.length) throw badRequest('Taşınacak öğe yok');
    if (folderId != null) this.own(userId, folderId);
    this.store.run('BEGIN');
    try {
      for (const key of keys) {
        if (folderId == null) this.store.run('DELETE FROM gallery_placements WHERE user_id = ? AND item_key = ?', [userId, key]);
        else
          this.store.run('INSERT INTO gallery_placements (user_id, item_key, folder_id) VALUES (?, ?, ?) ON CONFLICT (user_id, item_key) DO UPDATE SET folder_id = excluded.folder_id', [
            userId,
            key,
            folderId,
          ]);
      }
      this.store.run('COMMIT');
    } catch (err) {
      this.store.run('ROLLBACK');
      throw err;
    }
    return { moved: keys.length };
  }
}
