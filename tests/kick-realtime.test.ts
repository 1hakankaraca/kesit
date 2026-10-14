import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseEnvelope } = require('../server/engine/KickRealtime.js') as { parseEnvelope: (pub: unknown) => { event: string; data: unknown } | null };

test('KickRealtime.parseEnvelope: JSON metni olarak gelen veriyi çözer', () => {
  const env = parseEnvelope({ data: { event: 'App\\Events\\ChatMessageEvent', data: '{"content":"https://kick.com/mithrain/clips/clip_01ABC","sender":{"username":"ayse"}}' } });
  assert.ok(env);
  assert.equal(env!.event, 'App\\Events\\ChatMessageEvent');
  assert.equal((env!.data as { sender: { username: string } }).sender.username, 'ayse');
});

test('KickRealtime.parseEnvelope: nesne veriyi olduğu gibi bırakır, bozuk zarfı eler', () => {
  const env = parseEnvelope({ data: { event: 'X', data: { a: 1 } } });
  assert.deepEqual(env, { event: 'X', data: { a: 1 } });
  assert.equal(parseEnvelope({ data: 'düz' }), null);
  assert.equal(parseEnvelope(null), null);
  assert.equal((parseEnvelope({ data: { event: 'Y', data: 'metin' } })!.data as string), 'metin', 'JSON olmayan metin korunur');
});
