import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyProject, type Asset, type Clip } from '../shared/project.ts';
import { addAssetClip, applyLayout, closeGaps, freeSlot, moveClip, pasteClip, removeClips, rippleRemove, setSpeed, splitAt, splitCameraAndScreen, trimEnd, trimStart, trimToPlayhead } from '../src/editor/model.ts';

const video: Asset = { id: 'a1', kind: 'video', name: 'v', duration: 20, width: 1920, height: 1080, hasAudio: true, origin: { type: 'upload', file: 'v.mp4' }, thumb: null };

function base() {
  const p = emptyProject(1, 't', 'vertical');
  p.assets = [video];
  return p;
}

test('addAssetClip (serbest): dolu yere eklenen parça ilk boşluğa kayar', () => {
  let { project } = addAssetClip(base(), video, 0, undefined, false);
  ({ project } = addAssetClip(project, video, 5, undefined, false));
  const [a, b] = project.clips;
  assert.equal(a.start, 0);
  assert.equal(b.start, 20, 'çakışınca ilk parçanın sonuna gider');
  assert.equal(freeSlot(project, a, 'v1', 25), 40, 'ikinci parçayla çakışınca onun sonuna');
});

test('splitAt: parça ikiye bölünür, kaynak girişi korunur', () => {
  const { project } = addAssetClip(base(), video, 0);
  const r = splitAt(project, 7);
  assert.equal(r.created.length, 1);
  const [left, right] = r.project.clips;
  assert.equal(left.duration, 7);
  assert.equal(right.start, 7);
  assert.equal(right.in, 7);
  assert.equal(right.duration, 13);
  assert.equal(splitAt(project, 0.05).created.length, 0, 'kenara çok yakınsa bölmez');
});

test('rippleRemove ve closeGaps boşlukları kapatır', () => {
  let { project } = addAssetClip(base(), video, 0, undefined, false);
  project = splitAt(project, 5).project;
  project = splitAt(project, 10).project;
  const middle = project.clips.find((c) => c.start === 5)!;
  const rippled = rippleRemove(project, middle.id);
  assert.deepEqual(rippled.clips.map((c) => c.start).sort((a, b) => a - b), [0, 5]);
  const gapped = { ...project, clips: project.clips.filter((c) => c.id !== middle.id) };
  assert.deepEqual(closeGaps(gapped, 'v1').clips.map((c) => c.start).sort((a, b) => a - b), [0, 5]);
});

test('trim (serbest): kaynak süresini ve komşuları aşamaz', () => {
  let { project } = addAssetClip(base(), video, 0, undefined, false);
  project = splitAt(project, 10).project;
  const [left, right] = project.clips;
  const t1 = trimEnd(project, left.id, 15, false);
  assert.equal(t1.clips[0].duration, 10, 'sağdaki parçaya giremez');
  const t2 = trimStart(project, right.id, 2, false);
  assert.equal(t2.clips[1].start, 10, 'soldaki parçaya giremez');
  const t3 = trimEnd(project, right.id, 40, false);
  assert.equal(t3.clips[1].duration, 10, 'kaynak 20 sn; 10+10');
});

test('mıknatıs: ana yolda silme boşluk bırakmaz, kısaltma sonrakini çeker, ekleme araya girer', () => {
  let { project } = addAssetClip(base(), video, 0);
  ({ project } = addAssetClip(project, video, 999));
  assert.deepEqual(project.clips.map((c) => c.start), [0, 20]);
  project = splitAt(project, 5).project;
  const first = project.clips.find((c) => c.start === 0)!;
  const shorter = trimEnd(project, first.id, 3);
  assert.deepEqual(shorter.clips.map((c) => c.start).sort((a, b) => a - b), [0, 3, 18]);
  const gone = removeClips(shorter, [first.id]);
  assert.deepEqual(gone.clips.map((c) => c.start).sort((a, b) => a - b), [0, 15]);
  // Oynatma çizgisi 10. saniyedeyken yapıştırılan parça oradaki parçanın ardına girer.
  const pasted = pasteClip(gone, first, 10);
  assert.deepEqual(pasted.project.clips.map((c) => c.start).sort((a, b) => a - b), [0, 15, 20], 'kopya 5 sn (bölünmüş hâli) araya girer');
  const trimmed = trimToPlayhead(gone, gone.clips.find((c) => c.start === 0)!.id, 4, 'left');
  assert.deepEqual(trimmed.clips.map((c) => c.start).sort((a, b) => a - b), [0, 11]);
});

test('hız: süre kaynağa göre bölünür, kaynak girişi korunur', () => {
  const { project, clip } = addAssetClip(base(), video, 0);
  const fast = setSpeed(project, clip.id, 2);
  assert.equal(fast.clips[0].duration, 10);
  const r = splitAt(fast, 4);
  assert.equal(r.project.clips[1].in, 8, 'bölme noktası kaynakta hız×zaman');
  const slow = setSpeed(fast, clip.id, 0.5);
  assert.equal(slow.clips[0].duration, 40);
});

test('moveClip: ses parçası görüntü yoluna taşınamaz; mıknatısta sürükleme sıra değiştirir', () => {
  const audio: Asset = { ...video, id: 'a2', kind: 'audio' };
  let project = { ...base(), assets: [video, audio] };
  ({ project } = addAssetClip(project, video, 0));
  ({ project } = addAssetClip(project, audio, 0));
  const a = project.clips.find((c) => c.kind === 'audio')!;
  const moved = moveClip(project, a.id, 3, 'v1');
  assert.equal(moved.clips.find((c) => c.id === a.id)!.trackId, 'a1');
  const v = project.clips.find((c) => c.kind === 'video')!;
  const { project: p2 } = addAssetClip(project, video, 20);
  const m2 = moveClip(p2, v.id, 25);
  assert.equal(m2.clips.find((c) => c.id === v.id)!.start, 20, 'ikinci parçanın yerine geçer, o öne gelir');
  const m3 = moveClip(p2, v.id, 25, undefined, false);
  assert.equal(m3.clips.find((c) => c.id === v.id)!.start, 40, 'serbest modda çakışan parçanın sonuna');
});

test('splitCameraAndScreen: kamera üst boş yola, ekran altta kalan alana', () => {
  const { project, clip } = addAssetClip(base(), video, 0);
  // Kaynak 16:9; kamera kutusu da 16:9 → en/boy oranları eşit.
  const r = splitCameraAndScreen(project, clip.id, { x: 0.7, y: 0.05, w: 0.25, h: 0.25 });
  const cam = r.clips.find((c) => c.id !== clip.id)!;
  const screen = r.clips.find((c) => c.id === clip.id)!;
  assert.equal(cam.trackId, 'v2');
  assert.equal(cam.frame.y, 0);
  assert.ok(Math.abs(cam.frame.h - 0.3164) < 0.001, 'kamera 16:9 ise üstte %31,6');
  assert.ok(Math.abs(screen.frame.y - cam.frame.h) < 1e-9);
  assert.ok(screen.crop.w < 1 && screen.crop.h === 1, 'ekran orta kısımdan kırpılır');
  const corner = applyLayout(project, clip.id, 'kamera-kose', { x: 0.7, y: 0.05, w: 0.25, h: 0.25 });
  const camC = corner.clips.find((c) => c.id !== clip.id)!;
  assert.ok(camC.frame.w < 0.5 && camC.frame.x + camC.frame.w < 1, 'köşe kamerası küçük ve içeride');
});

export type { Clip };
