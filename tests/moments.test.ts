import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/db/Store.ts';
import { MomentSignals } from '../server/engine.ts';
import { MomentScanner } from '../server/services/MomentScanner.ts';

/** Deterministik "rastgele": testler her koşuda aynı veriyle çalışsın. */
function rng(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

/** Olağan sohbet (2 sn'de bir mesaj) + istenen anlarda tepki seli. */
function syntheticChat(durationSec: number, bursts: { at: number; texts: string[]; n: number }[], extra: { t: number; u: string; x: string }[] = []) {
  const r = rng();
  const msgs: { t: number; u: string; x: string }[] = [];
  for (let t = 0; t < durationSec; t += 2) msgs.push({ t: t + r() * 2, u: `izleyici${Math.floor(r() * 150)}`, x: 'selam nasılsınız' });
  for (const b of bursts) {
    for (let i = 0; i < b.n; i++) msgs.push({ t: b.at + r() * 10, u: `tepki${Math.floor(r() * 400)}`, x: b.texts[i % b.texts.length] });
  }
  return [...msgs, ...extra].sort((a, b) => a.t - b.t);
}

test('an sinyali: sohbet patlamaları türüyle bulunur, pencere patlamadan önce başlar', () => {
  const chat = syntheticChat(3600, [
    { at: 900, texts: ['[emote:37226:KEKW]', 'ahahahaha', 'sdfsdfsdf', '😂😂'], n: 120 },
    { at: 2000, texts: ['OHAAA', '[emote:1:PogChamp]', 'KLİP', 'inanılmaz'], n: 90 },
    { at: 3000, texts: ['F', '😢', 'ağladım'], n: 70 },
  ]);
  const found = MomentSignals.chatCandidates(chat, 3600);
  const near = (t: number) => found.find((c: any) => c.start <= t && c.end >= t + 5);
  const komik = near(900);
  const heyecan = near(2000);
  const huzun = near(3000);
  assert.ok(komik && heyecan && huzun, 'üç patlama da aday olmalı');
  assert.ok(komik.start <= 900 - 20, 'sohbet gecikmesi için pencere önceden başlamalı');
  assert.ok(komik.end - komik.start <= 90);
  assert.equal(MomentSignals.heuristicLabel(komik).kind, 'komik');
  assert.equal(MomentSignals.heuristicLabel(huzun).kind, 'duygusal');
  assert.ok(komik.chat.top.some((e: string) => e.startsWith('KEKW')));
});

test('an sinyali: komut ve bot seli patlama sayılmaz', () => {
  const spam = Array.from({ length: 200 }, (_, i) => ({ t: 1200 + (i % 10), u: `k${i}`, x: '!gamble all' }));
  const bot = Array.from({ length: 100 }, (_, i) => ({ t: 1800 + (i % 10), u: 'BotRix', x: 'Çekiliş başladı!' }));
  const chat = syntheticChat(3600, [], [...spam, ...bot]);
  const found = MomentSignals.chatCandidates(chat, 3600);
  assert.equal(found.filter((c: any) => (c.start <= 1205 && c.end >= 1205) || (c.start <= 1805 && c.end >= 1805)).length, 0);
});

test('an sinyali: ses yükselmesi aday olur, sohbetle çakışınca puan artar', () => {
  const r = rng(3);
  const levels = Array.from({ length: 1800 }, () => -32 + r() * 4);
  for (let s = 600; s < 606; s++) levels[s] = -12;
  const audio = MomentSignals.audioCandidates(levels, 1800);
  assert.ok(audio.some((a: any) => a.start <= 600 && a.end >= 605));
  const chat = MomentSignals.chatCandidates(syntheticChat(1800, [{ at: 605, texts: ['OHA', 'W'], n: 80 }]), 1800);
  const merged = MomentSignals.mergeCandidates({ chat, audio }, 1800);
  const top = merged[0];
  assert.ok(top.start <= 600 && top.end >= 605);
  assert.deepEqual([...top.sources].sort(), ['audio', 'chat']);
});

function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version']).status === 0;
}

test('an taraması: yayın dosyası + sohbet → anlar kaydedilir (Claude yokken sinyal etiketi)', { skip: !hasFfmpeg() && 'ffmpeg yok' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-anlar-'));
  const vod = path.join(dir, 'vod.mp4');
  // 4 dakikalık yayın: 150. saniyede 6 sn'lik yüksek ses
  const gen = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5:duration=240',
    '-f', 'lavfi', '-i', "anoisesrc=d=240:a=0.02,volume='if(between(t,150,156),12,1)':eval=frame",
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', vod,
  ]);
  assert.equal(gen.status, 0, String(gen.stderr));

  const store = new Store(path.join(dir, 'test.db'));
  const user = store.createGuestUser('Test');
  const job = await store.createVodScanJob(user.id, { channelSlug: 'deneme', sourceVideoId: 'v1', title: 'Deneme', durationSec: 240 });
  store.run('UPDATE vod_scan_jobs SET vod_path = ?, status = ? WHERE id = ?', [vod, 'downloaded', job!.id]);
  await store.addVodHighlight(job!.id, { startSec: 1, endSec: 2, kind: 'eski', reason: 'eski tarama' });

  const events: any[] = [];
  const io = { to: () => ({ emit: (_e: string, p: any) => events.push(p) }) } as any;
  const chat = syntheticChat(240, [{ at: 60, texts: ['KEKW', 'ahahahah', '😂'], n: 80 }]);
  const chatHistory = { streamMessages: async () => chat } as any;

  const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY, g: process.env.GEMINI_API_KEY, w: process.env.WHISPER_MODEL, e: process.env.ELEVENLABS_API_KEY };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'WHISPER_MODEL', 'ELEVENLABS_API_KEY']) delete process.env[k];
  try {
    const scanner = new MomentScanner(store, io, chatHistory);
    const r = await scanner.start(user.id, job!.id, { max: 5 });
    assert.equal(r.started, true);
    assert.equal(scanner.isRunning(job!.id), true);
    for (let i = 0; i < 300 && scanner.isRunning(job!.id); i++) await new Promise((res) => setTimeout(res, 100));
    assert.equal(scanner.isRunning(job!.id), false);
  } finally {
    for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY: saved.a, OPENAI_API_KEY: saved.o, GEMINI_API_KEY: saved.g, WHISPER_MODEL: saved.w, ELEVENLABS_API_KEY: saved.e })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const done = events.find((e) => e.status === 'moments-done');
  assert.ok(done, `tarama bitmeli: ${JSON.stringify(events.at(-1))}`);
  const rows = await store.getVodHighlights(job!.id);
  assert.ok(!rows.some((h: any) => h.kind === 'eski'), 'önceki tarama silinmeli');
  const funny = rows.find((h: any) => h.start_sec <= 60 && h.end_sec >= 62);
  assert.ok(funny, `60. saniyedeki kahkaha bulunmalı: ${JSON.stringify(rows)}`);
  assert.equal(funny.kind, 'komik');
  assert.ok(rows.some((h: any) => h.start_sec <= 150 && h.end_sec >= 152), 'ses yükselmesi bulunmalı');
  assert.ok(fs.existsSync(path.join(dir, 'scan-loudness.json')), 'ses seviyesi önbelleğe yazılmalı');
});

test('an taraması: Claude seçimi ve kategorisi kayda geçer, geçersiz yanıt sinyal etiketine düşer', async () => {
  const { VisionLLM } = await import('../server/engine.ts');
  const scanner = new MomentScanner({} as any, {} as any, {} as any);
  const candidates = [
    { start: 10, end: 50, t: 40, score: 3, sources: ['chat'], chat: { rate: 50, baseline: 5, multiple: 8, users: 40, laugh: 30, hype: 2, sad: 0, repeat: 0.3, top: ['KEKW×20'], samples: ['KEKW'] }, audio: null, speechText: 'şaka' },
    { start: 100, end: 140, t: 130, score: 2, sources: ['audio'], chat: null, audio: { deltaDb: 14 }, speechText: '' },
  ];
  const orig = { gen: VisionLLM.generateJson, avail: VisionLLM.isAvailable };
  let prompt = '';
  let prefer = '';
  try {
    VisionLLM.isAvailable = () => true;
    VisionLLM.generateJson = async (p: any) => {
      prompt = p.prompt;
      prefer = p.prefer;
      return { moments: [{ index: 1, kind: 'aksiyon', title: 'Büyük patlama', reason: 'Ses birden yükseldi.' }, { index: 1, kind: 'komik' }, { index: 9 }] };
    };
    const out = await (scanner as any).label(candidates, 5, true);
    assert.equal(prefer, 'claude');
    assert.match(prompt, /KEKW×20/);
    assert.equal(out.length, 1, 'aynı aday iki kez, olmayan aday hiç alınmaz');
    assert.deepEqual({ kind: out[0].kind, title: out[0].title, start: out[0].start }, { kind: 'aksiyon', title: 'Büyük patlama', start: 100 });

    VisionLLM.generateJson = async () => {
      throw new Error('ağ yok');
    };
    const fb = await (scanner as any).label(candidates, 5, true);
    assert.equal(fb.length, 2);
    assert.equal(fb[0].kind, 'komik');
    assert.equal(fb[1].kind, 'aksiyon');
  } finally {
    VisionLLM.generateJson = orig.gen;
    VisionLLM.isAvailable = orig.avail;
  }
});

test('VisionLLM: Claude anahtarı varsa an taraması Claude ile, JSON dışı metin ayıklanır', async () => {
  // VisionLLM CommonJS: aynı axios örneğini require ile al
  const { createRequire } = await import('node:module');
  const axios = createRequire(path.resolve('server/engine/VisionLLM.js'))('axios');
  const { VisionLLM } = await import('../server/engine.ts');
  const origPost = axios.post;
  const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
  let call: any = null;
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.OPENAI_API_KEY = 'sk-openai';
    (axios as any).post = async (url: string, body: any, opts: any) => {
      call = { url, body, opts };
      return { data: { content: [{ type: 'text', text: 'İşte sonuç:\n{"moments":[{"index":0}]}' }] } };
    };
    const d = await VisionLLM.generateJson({ prompt: 'x', purpose: 'text', prefer: 'claude' });
    assert.deepEqual(d, { moments: [{ index: 0 }] });
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(call.opts.headers['x-api-key'], 'sk-ant-test');
    assert.ok(call.body.model);
  } finally {
    (axios as any).post = origPost;
    for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY: saved.a, OPENAI_API_KEY: saved.o })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
