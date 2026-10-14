import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/db/Store.ts';
import { ArchiveLedger } from '../server/services/ArchiveLedger.ts';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-test-'));
  const store = new Store(path.join(dir, 'test.db'));
  const archive = new ArchiveLedger(store);
  store.setArchiveHooks(archive);
  return { store, archive, user: store.createGuestUser('Test') };
}

test('ayarlar: Zernio anahtarı şifreli saklanır, açık olarak okunur', async () => {
  const { store, user } = fresh();
  store.setZernioConnection(user.id, { apiKey: 'sk_gizli_anahtar_123', profileId: 'prof_1', profileName: 'Ana' });
  const raw = store.get('SELECT zernio_api_key_enc FROM user_settings WHERE user_id = ?', [user.id]);
  assert.ok(!String(raw!.zernio_api_key_enc).includes('gizli'));
  const s = await store.getSettings(user.id);
  assert.equal(s.zernio_api_key, 'sk_gizli_anahtar_123');
  assert.equal('zernio_api_key_enc' in s, false);
});

test('düzenlenmiş klip: beyaz liste dışı kolon yazılmaz, tipler motorun beklediği gibi döner', async () => {
  const { store, user } = fresh();
  const job = await store.addEditedClip(user.id, { source: 'popular', sourceClipId: 'clip_A', title: 'deneme' });
  await store.updateEditedClip(job!.id, user.id, { status: 'processing', user_id: 999, published_at: new Date('2026-01-01') });
  const row = await store.getEditedClipById(job!.id, user.id);
  assert.equal(row!.status, 'processing');
  assert.equal(row!.user_id, user.id);
  assert.equal(row!.subtitles, true);
  assert.ok(row!.published_at instanceof Date);
});

test('paylaşım claim: tek kazanan', async () => {
  const { store, user } = fresh();
  const job = await store.addEditedClip(user.id, { title: 'x' });
  await store.updateEditedClip(job!.id, user.id, { status: 'ready' });
  assert.ok(await store.claimEditedClipForPublish(job!.id, user.id));
  assert.equal(await store.claimEditedClipForPublish(job!.id, user.id), null);
});

test('arşiv: hazır klip deftere yazılır, silinince geçmişte kalır', async () => {
  const { store, archive, user } = fresh();
  const job = await store.addEditedClip(user.id, { title: 'Klip', options: { outputFormat: 'horizontal' } });
  assert.equal(archive.list(user.id).length, 0, 'hazır olmayan iş deftere girmez');
  await store.updateEditedClip(job!.id, user.id, { status: 'ready', duration: 42 });
  const [entry] = archive.list(user.id);
  assert.equal(entry.title, 'Klip');
  assert.equal(entry.format, 'horizontal');
  await store.deleteEditedClip(job!.id, user.id);
  const [after] = archive.list(user.id);
  assert.ok(after.deletedAt);
  assert.equal(after.fileAvailable, false);
  assert.equal(archive.dailyCounts(user.id)[0].deleted, 1);
});

test('oturum: süresi dolan oturum kullanıcı döndürmez', () => {
  const { store, user } = fresh();
  store.createSession('a', user.id, new Date(Date.now() + 60_000));
  store.createSession('b', user.id, new Date(Date.now() - 60_000));
  assert.equal(store.getSessionUser('a')!.id, user.id);
  assert.equal(store.getSessionUser('b'), null);
});
