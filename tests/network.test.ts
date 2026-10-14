import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-lan-'));

const { isAllowedHost, isLoopback, isPrivateIp } = await import('../server/lib/network.ts');
const { Store } = await import('../server/db/Store.ts');
const { LanAccess } = await import('../server/services/LanAccess.ts');

test('host izin listesi: yerel adresler evet, yabancı alan adı hayır', () => {
  for (const h of ['localhost:5174', '127.0.0.1:3002', '[::1]:3002', '192.168.1.5:3002', '10.0.0.2']) assert.equal(isAllowedHost(h), true, h);
  for (const h of ['evil.example:3002', 'kesit.app', '8.8.8.8', undefined]) assert.equal(isAllowedHost(h), false, String(h));
});

test('istemci sınıflandırma', () => {
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.5'), false);
  assert.equal(isPrivateIp('::ffff:192.168.1.5'), true);
  assert.equal(isPrivateIp('172.32.0.1'), false);
});

test('eşleme: kapalıyken reddedilir, kod tek kullanımlık, kapatınca cihazlar düşer', () => {
  const lan = new LanAccess(new Store(path.join(process.env.DATA_DIR!, 'k.db')));
  assert.throws(() => lan.pair('123456', 'x'), /kapalı/);
  lan.setEnabled(true);
  const { code } = lan.newCode();
  assert.throws(() => lan.pair('000000' === code ? '111111' : '000000', 'x'), /hatalı/);
  const token = lan.pair(code, 'Telefon');
  assert.equal(lan.isPaired(token), true);
  assert.throws(() => lan.pair(code, 'x'), /süresi doldu|yok/, 'kod ikinci kez kullanılamaz');
  lan.setEnabled(false);
  assert.equal(lan.isPaired(token), false);
});

test('eşleme: deneme sınırı aşılınca kod iptal olur', () => {
  const lan = new LanAccess(new Store(path.join(process.env.DATA_DIR!, 'k2.db')));
  lan.setEnabled(true);
  const { code } = lan.newCode();
  const wrong = code === '999999' ? '888888' : '999999';
  for (let i = 0; i < 8; i++) assert.throws(() => lan.pair(wrong, 'x'));
  assert.throws(() => lan.pair(code, 'x'), /Çok fazla/);
});
