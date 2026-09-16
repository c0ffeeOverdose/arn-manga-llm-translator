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
const { eraseBox } = await import(new URL('../.test-build/inpaint.mjs', import.meta.url).href);

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
