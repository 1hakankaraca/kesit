import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Yapılandırma içe aktarılırken okunduğu için veri dizini önce ayarlanır.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-export-'));
process.env.DATA_DIR = dataDir;
delete process.env.CLIP_OUTPUT_DIR;

const { Store } = await import('../server/db/Store.ts');
const { ArchiveLedger } = await import('../server/services/ArchiveLedger.ts');
const { Exporter } = await import('../server/services/Exporter.ts');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('hazır klip seçilen klasöre biçimine göre bir kez kopyalanır', async () => {
  const store = new Store(path.join(dataDir, 'kesit.db'));
  const exporter = new Exporter(store);
  const exportDir = path.join(dataDir, 'indirilenler');
  exporter.update({ dir: exportDir });
  store.setArchiveHooks(new ArchiveLedger(store, exporter));
  const user = store.createGuestUser('Test');

  const job = await store.addEditedClip(user.id, { title: 'Harika an', options: { outputFormat: 'horizontal' } });
  const video = path.join(dataDir, 'clips', String(user.id), 'vertical', `${job!.id}.mp4`);
  fs.mkdirSync(path.dirname(video), { recursive: true });
  fs.writeFileSync(video, 'video');

  await store.updateEditedClip(job!.id, user.id, { status: 'ready' });
  await store.updateEditedClip(job!.id, user.id, { status: 'ready', title: 'Harika an' });
  await wait(100);

  const files = fs.readdirSync(path.join(exportDir, 'Yatay'));
  assert.equal(files.length, 1, 'ikinci güncelleme yeniden kopyalamaz');
  assert.match(files[0], /Harika an #\d+\.mp4$/);
  assert.equal(fs.existsSync(path.join(exportDir, 'Dikey')), false);
});

test('dışa aktarma kapalıyken kopyalanmaz; yazılamayan klasör reddedilir', async () => {
  const store = new Store(path.join(dataDir, 'kesit2.db'));
  const exporter = new Exporter(store);
  exporter.update({ enabled: false });
  assert.equal(exporter.copy(new URL(import.meta.url).pathname, 'vertical', 'x', 1), null);
  // Bir DOSYANIN altı hiçbir sistemde klasör olamaz (Windows'ta /dev/null geçerli bir yol olurdu).
  const file = path.join(dataDir, 'dosya.txt');
  fs.writeFileSync(file, 'x');
  assert.throws(() => exporter.update({ dir: path.join(file, 'olamaz') }), /yazılamıyor/);
});
