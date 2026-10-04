// Unit tests for region reading-order sort (pure logic). Run: npm test
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/content/detection.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/detection.mjs', sourcemap: 'inline',
});

const { sortReadingOrder } =
  await import(new URL('../.test-build/detection.mjs', import.meta.url).href);

const box = (x1, y1, x2, y2) => ({ x1, y1, x2, y2, conf: 0.9 });

test('rtl: rows top-to-bottom, right-to-left within each row', () => {
  const leftTop = box(10, 10, 100, 100);
  const leftBottom = box(10, 120, 100, 200);
  const rightTop = box(200, 10, 290, 100);
  const rightBottom = box(200, 120, 290, 200);
  const out = sortReadingOrder([leftTop, rightBottom, rightTop, leftBottom], 'rtl');
  assert.deepEqual(out, [rightTop, leftTop, rightBottom, leftBottom]);
});

test('ltr mirrors rtl', () => {
  const leftTop = box(10, 10, 100, 100);
  const leftBottom = box(10, 120, 100, 200);
  const rightTop = box(200, 10, 290, 100);
  const rightBottom = box(200, 120, 290, 200);
  const out = sortReadingOrder([leftTop, rightBottom, rightTop, leftBottom], 'ltr');
  assert.deepEqual(out, [leftTop, rightTop, leftBottom, rightBottom]);
});

test('stacked boxes stay top-down; full-width box joins the first column', () => {
  const a = box(10, 0, 100, 50);
  const b = box(10, 60, 100, 110);
  const wide = box(0, 120, 300, 170);
  assert.deepEqual(sortReadingOrder([b, wide, a], 'rtl'), [a, b, wide]);
  assert.deepEqual(sortReadingOrder([b, wide, a], 'ltr'), [a, b, wide]);
});

test('same row breaks toward the reading-start side', () => {
  const left = box(10, 10, 100, 60);
  const right = box(200, 10, 290, 60);
  assert.deepEqual(sortReadingOrder([left, right], 'rtl')[0], right);
  assert.deepEqual(sortReadingOrder([left, right], 'ltr')[0], left);
});

test('empty and single-box inputs pass through', () => {
  assert.deepEqual(sortReadingOrder([], 'rtl'), []);
  const one = box(1, 2, 3, 4);
  assert.deepEqual(sortReadingOrder([one], 'ltr'), [one]);
});

test('three rows stay in row-major order (giant x-columns must not merge rows)', () => {
  // replica of the reported screenshot: 6 boxes top row, 3 middle, 4 bottom
  const row = (y, xs) => xs.map(x => box(x, y, x + 90, y + 90));
  const r1 = row(50, [800, 650, 500, 350, 200, 50]);
  const r2 = row(400, [800, 500, 200]);
  const r3 = row(700, [800, 600, 400, 200]);
  // scrambled detector (confidence) order
  const scrambled = [r1[3], r3[0], r2[1], r1[0], r3[2], r2[0], r1[5], r2[2], r1[1], r3[3], r1[4], r3[1], r1[2]];
  const out = sortReadingOrder(scrambled, 'rtl');
  assert.deepEqual(out, [...r1, ...r2, ...r3]);
  const outLtr = sortReadingOrder(scrambled, 'ltr');
  assert.deepEqual(outLtr, [...r1].reverse().concat([...r2].reverse(), [...r3].reverse()));
});

test('same-row jitter does not split the row', () => {
  const left = box(10, 10, 100, 110);
  const right = box(200, 18, 290, 118); // center 8px lower, still same row
  assert.deepEqual(sortReadingOrder([left, right], 'rtl'), [right, left]);
});

test('tall spanner gets its own band, neighbors stay ordered', () => {
  const tall = box(10, 0, 100, 1000);
  const top = box(200, 50, 290, 150);
  const bottom = box(200, 850, 290, 950);
  assert.deepEqual(sortReadingOrder([bottom, tall, top], 'rtl'), [top, tall, bottom]);
});

test('a landscape spread reads page by page, not band by band', () => {
  const R1 = box(1500, 100, 1800, 300);
  const R2 = box(1500, 400, 1800, 600);
  const L1 = box(500, 100, 800, 300);
  const L2 = box(500, 400, 800, 600);
  const page = { w: 2000, h: 1000 };
  assert.deepEqual(sortReadingOrder([L1, R2, R1, L2], 'rtl', page), [R1, R2, L1, L2]);
  assert.deepEqual(sortReadingOrder([L1, R2, R1, L2], 'ltr', page), [L1, L2, R1, R2]);
});

test('two tall vertical-text columns read column by column', () => {
  const R1 = box(600, 50, 660, 210);
  const R2 = box(600, 240, 660, 400);
  const L1 = box(200, 50, 260, 210);
  const L2 = box(200, 240, 260, 400);
  assert.deepEqual(sortReadingOrder([L1, R2, R1, L2], 'rtl', { w: 800, h: 500 }), [R1, R2, L1, L2]);
});

test('a tall box far above the other group does not form a column', () => {
  const top = box(1765, 240, 1869, 458);
  const a = box(794, 207, 958, 568);
  const b = box(890, 830, 1009, 1055);
  const c = box(715, 879, 889, 1208);
  const low = box(1625, 1644, 1794, 1910);
  // `low` shares no row with the left group, so the corridor split must not fire
  assert.deepEqual(sortReadingOrder([low, c, b, top, a], 'rtl', { w: 2030, h: 2880 }), [top, a, b, c, low]);
});
