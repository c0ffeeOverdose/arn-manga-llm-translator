// Unit tests for the inpaint erase-region expansion (pure mask logic).
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/content/inpaint.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/inpaint.mjs', sourcemap: 'inline',
});
const { eraseBox, erasePlan, aiCleanupMask, aiCleanupDilate, windowIndex } = await import(new URL('../.test-build/inpaint.mjs', import.meta.url).href);

function mask(W, H, fill = []) {
  const m = new Uint8Array(W * H);
  for (const [x, y] of fill) m[y * W + x] = 255;
  return m;
}

const box = { x1: 10, y1: 10, x2: 30, y2: 30 };

test('eraseBox: keeps the box when nothing touches it', () => {
  const m = mask(60, 60, [[50, 50]]);
  assert.deepEqual(eraseBox(m, 60, 60, box, 20), { x1: 10, y1: 10, x2: 30, y2: 30 });
});

test('eraseBox: expands over mask ink touching a side (the clipped last line)', () => {
  // live: the box bottom crossed a narration line at y2077 while its ink ran
  // to y2102 — the translation painted over the top half, "SAO…" showed below
  const m = mask(60, 60, [[15, 31], [20, 34], [25, 36]]);
  const e = eraseBox(m, 60, 60, box, 20);
  assert.equal(e.y2, 36, 'bottom follows the ink');
  assert.equal(e.y1, 10);
  assert.equal(e.x1, 10);
  assert.equal(e.x2, 30);
});

test('eraseBox: a gap wider than a glyph gap stops the walk', () => {
  const m = mask(80, 80, [[20, 32], [20, 40]]); // ink at 32, gap 33-39 (7 rows), ink at 40
  const e = eraseBox(m, 80, 80, box, 40);
  assert.equal(e.y2, 32, 'stops at the first cluster, does not bridge 7 empty rows');
});

test('eraseBox: sideways ink outside the span is ignored (no wander to a neighbour)', () => {
  const m = mask(80, 80, [[45, 20]]); // right of the box, same rows
  const e = eraseBox(m, 80, 80, box, 40);
  assert.deepEqual(e, { x1: 10, y1: 10, x2: 30, y2: 30 });
});

test('eraseBox: expansion is capped by pad', () => {
  const m = mask(200, 200, Array.from({ length: 80 }, (_, i) => [20, 31 + i]));
  const e = eraseBox(m, 200, 200, box, 12);
  assert.equal(e.y2, 42, 'pad bounds the walk');
});

test('erasePlan: translated boxes erase, keep + contained dups stay, missing -> missed', () => {
  const boxes = [
    { x1: 0, y1: 0, x2: 100, y2: 100, conf: 0.9 },
    { x1: 5, y1: 5, x2: 95, y2: 95, conf: 0.5 }, // contained in #1, lower conf
    { x1: 200, y1: 0, x2: 300, y2: 100, conf: 0.8 }, // LLM said keep
    { x1: 400, y1: 0, x2: 500, y2: 100, conf: 0.7 }, // no output -> missed
  ];
  const det = { boxes, mask: { width: 1, height: 1, data: new ArrayBuffer(1) } };
  const outputs = [
    { index: 1, translation: 'A' },
    { index: 2, translation: 'B' },
    { index: 3, translation: 'keep' },
  ];
  const p = erasePlan(det, outputs);
  assert.deepEqual(p.boxesToErase.map(b => b.conf), [0.9]);
  assert.deepEqual(p.keepBoxes.map(b => b.conf), [0.5, 0.8]);
  assert.deepEqual([...p.dupIdx], [2]);
  assert.deepEqual([...p.keepIdx], [3]);
  assert.deepEqual(p.missedIdx, [4]);
});

// ---- aiCleanupMask: what the manga-LaMa windows actually see ---------------

function detOf(W, H, fill = []) {
  return { boxes: [], mask: { width: W, height: H, data: mask(W, H, fill).buffer } };
}
const at = (r, W, x, y) => r.data[y * W + x];

test('aiCleanupMask: ink outside the erase boxes never reaches the model', () => {
  const det = detOf(40, 40, [[12, 15], [30, 15]]);
  const r = aiCleanupMask(det, [{ x1: 10, y1: 10, x2: 20, y2: 20 }], []);
  assert.ok(at(r, 40, 12, 15) > 127, 'inside kept');
  assert.equal(at(r, 40, 30, 15), 0, 'outside dropped');
  assert.equal(r.width, 40);
  assert.equal(r.height, 40);
});

test('aiCleanupMask: dilates by the page-scaled radius (strokes must merge at 512)', () => {
  const det = detOf(40, 40, [[12, 15]]); // tiny det -> radius clamps to 4
  const r = aiCleanupMask(det, [{ x1: 10, y1: 10, x2: 20, y2: 20 }], []);
  assert.ok(at(r, 40, 8, 15) > 127, '4px left is grown');
  assert.equal(at(r, 40, 7, 15), 0, '5px left is not');
  assert.ok(at(r, 40, 12, 11) > 127, '4px up is grown');
  assert.ok(at(r, 40, 16, 19) > 127, '4px down-right is grown');
});

test('aiCleanupDilate: 4px at a 1600px page, grows with the scan, clamped', () => {
  assert.equal(aiCleanupDilate(1126, 1600), 4);
  assert.equal(aiCleanupDilate(800, 1200), 4, 'small pages keep the floor');
  assert.equal(aiCleanupDilate(1600, 2400), 6);
  assert.equal(aiCleanupDilate(3000, 4000), 10, 'capped');
});

test('aiCleanupMask: keep boxes are cleared after dilation (SFX glyphs stay)', () => {
  const det = detOf(40, 40, [[12, 15]]);
  const r = aiCleanupMask(det, [{ x1: 10, y1: 10, x2: 20, y2: 20 }], [{ x1: 12, y1: 15, x2: 12, y2: 15 }]);
  assert.equal(at(r, 40, 12, 15), 0, 'ink inside the keep box is cleared');
  assert.equal(at(r, 40, 10, 15), 0, 'the keep box clears with a 2px pad');
  assert.ok(at(r, 40, 16, 15) > 127, 'dilation past the padded keep box stays');
});

test('aiCleanupMask: no boxes -> empty mask', () => {
  const det = detOf(20, 20, [[5, 5]]);
  const r = aiCleanupMask(det, [], []);
  assert.ok(r.data.every(v => v === 0));
});

// ---- windowIndex: page pixel -> index inside the side-sized cleanup window --

test('windowIndex: page coords map to window pixels at page scale', () => {
  assert.equal(windowIndex(100, 50, 200), 50, 'half-pixel center floor');
  assert.equal(windowIndex(0, -30, 200), 30, 'negative origin (window past the page edge)');
  assert.equal(windowIndex(349.7, 0, 200), 200 - 1, 'clamped to the last index');
  assert.equal(windowIndex(-5, 0, 200), 0, 'clamped at the start');
});

test('windowIndex: regression — side > 512 windows must not sample 512-space', () => {
  // v2 composite divided by side/512, so a window pixel at 599 landed on 511
  // (art from above the box) — live: foliage smeared over the erased text
  assert.equal(windowIndex(599, 0, 600), 599);
  assert.equal(windowIndex(300, 0, 600), 300);
  assert.equal(windowIndex(599, -20, 600), 600 - 1, 'origin past the page edge still clamps');
});

