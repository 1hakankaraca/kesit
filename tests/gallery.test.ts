import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/db/Store.ts';
import { GalleryFolders } from '../server/services/GalleryFolders.ts';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-galeri-'));
  const store = new Store(path.join(dir, 'test.db'));
  return { store, gallery: new GalleryFolders(store), user: store.createGuestUser('Test'), other: store.createGuestUser('Diğer') };
}

test('galeri klasörleri: oluştur, aynı ad çakışmaz, iç içe, yeniden adlandır', () => {
  const { gallery, user } = fresh();
  const a = gallery.create(user.id, { name: 'Komik anlar' });
  const b = gallery.create(user.id, { name: 'komik anlar' });
  assert.equal(b.name, 'komik anlar (2)');
  const child = gallery.create(user.id, { name: 'Ekim', parentId: a.id });
  assert.equal(child.parentId, a.id);
  const renamed = gallery.update(user.id, child.id, { name: '  Kasım  ' });
  assert.equal(renamed.name, 'Kasım');
  assert.throws(() => gallery.create(user.id, { name: '   ' }), /boş/);
});

test('galeri klasörleri: öğe taşı, klasör silinince içindekiler üst klasöre geçer', () => {
  const { gallery, user } = fresh();
  const top = gallery.create(user.id, { name: 'Üst' });
  const sub = gallery.create(user.id, { name: 'Alt', parentId: top.id });
  const subsub = gallery.create(user.id, { name: 'En alt', parentId: sub.id });
  gallery.move(user.id, ['v1', 'k2', 'p3', 'kötü', 'x9'], sub.id);
  assert.deepEqual(gallery.list(user.id).placements, { v1: sub.id, k2: sub.id, p3: sub.id });
  gallery.move(user.id, ['v1'], null);
  assert.equal(gallery.list(user.id).placements.v1, undefined);

  gallery.remove(user.id, sub.id);
  const after = gallery.list(user.id);
  assert.equal(after.placements.k2, top.id, 'öğe bir üst klasöre geçmeli');
  assert.equal(after.folders.find((f) => f.id === subsub.id)!.parentId, top.id, 'alt klasör bir üste geçmeli');
  gallery.remove(user.id, top.id);
  const root = gallery.list(user.id);
  assert.equal(root.placements.k2, undefined, 'kökteki klasör silinince öğe köke döner');
  assert.equal(root.folders.length, 1);
  assert.equal(root.folders[0].parentId, null);
});

test('galeri klasörleri: kendi içine taşınamaz, başkasının klasörüne dokunulamaz', () => {
  const { gallery, user, other } = fresh();
  const a = gallery.create(user.id, { name: 'A' });
  const b = gallery.create(user.id, { name: 'B', parentId: a.id });
  assert.throws(() => gallery.update(user.id, a.id, { parentId: b.id }), /kendi içine/);
  assert.throws(() => gallery.update(user.id, a.id, { parentId: a.id }), /kendi içine/);
  assert.throws(() => gallery.move(other.id, ['v1'], a.id), /bulunamadı/);
  assert.throws(() => gallery.remove(other.id, a.id), /bulunamadı/);
  const moved = gallery.update(user.id, b.id, { parentId: null });
  assert.equal(moved.parentId, null);
});
