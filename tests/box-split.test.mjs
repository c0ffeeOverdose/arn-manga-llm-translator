// Unit tests for splitMergedBoxes — a CTD box covering two balloons gets cut
// into one region per balloon (pure geometry). Run: node --test
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/content/detection.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/box-split-detection.mjs', sourcemap: 'inline',
});

const { splitMergedBoxes } = await import(new URL('../.test-build/box-split-detection.mjs', import.meta.url).href);

const box = (x1, y1, x2, y2, conf = 0.9) => ({ x1, y1, x2, y2, conf });
const GAP = 28;

// Live case (MangaDex page 2, mask comps verbatim): one box over two diagonal
// balloons — "EM NÀY!" (upper right) and a 4-line block (lower left). Cluster
// gap 66px against a 33px max in-block gap; x-ranges disjoint by 25px.
test('live two-balloon box splits at the cluster gap, children clamped to parent', () => {
  const parent = box(1061, 362, 1413, 825, 0.92);
  const comps = [
    box(1329, 376, 1392, 416), box(1312, 453, 1393, 502), box(1390, 460, 1408, 502),
    box(1145, 568, 1196, 610), box(1207, 568, 1279, 612), box(1063, 576, 1135, 612),
    box(1235, 640, 1287, 682), box(1129, 648, 1224, 682), box(1062, 650, 1116, 683),
    box(1084, 710, 1150, 755), box(1164, 713, 1258, 756),
    box(1074, 777, 1148, 826), box(1161, 783, 1266, 827),
  ];
  assert.deepEqual(splitMergedBoxes([parent], comps, GAP), [
    { x1: 1279, y1: 362, x2: 1413, y2: 535, conf: 0.92 },  // 1312-33 .. 502+33
    { x1: 1061, y1: 535, x2: 1320, y2: 825, conf: 0.92 },  // 1062-33 .. 826+33
  ]);
});

test('in-block line spacing (gap below the floor) never splits', () => {
  const parent = box(1061, 362, 1413, 825, 0.92);
  const comps = [
    box(1305, 369, 1413, 415), box(1305, 448, 1413, 504),
    box(1062, 534, 1287, 575), box(1062, 600, 1287, 640),
  ];
  assert.deepEqual(splitMergedBoxes([parent], comps, GAP), [parent]);
});

// Live case (MangaDex page 3): a big-font last line sits 72px under its own
// paragraph — same x span, so it is that paragraph's final line, not a second
// balloon (splitting it produced a stray "หา!?" while the block stayed).
test('stacked runs sharing the cross axis never split', () => {
  const parent = box(0, 0, 300, 700, 0.4);
  const comps = [
    box(20, 0, 280, 80), box(20, 100, 280, 180), box(20, 200, 280, 280), box(20, 300, 280, 380),
    box(40, 500, 150, 570), box(160, 500, 270, 570),
  ];
  assert.deepEqual(splitMergedBoxes([parent], comps, GAP), [parent]);
});

test('words on one line (large x gaps, same y) do not split', () => {
  const b = box(0, 0, 100, 150);
  const comps = [
    box(0, 0, 40, 50), box(60, 0, 100, 50),
    box(0, 80, 40, 130), box(60, 80, 100, 130),
  ];
  assert.deepEqual(splitMergedBoxes([b], comps, GAP), [b]);
});

test('median cluster extent raises the cut threshold on large scales', () => {
  const b = box(0, 0, 200, 400);
  const near = [box(0, 0, 100, 100), box(140, 170, 200, 270)]; // gap 70 < 0.8×100 (median)
  assert.equal(splitMergedBoxes([b], near, GAP).length, 1);
  const far = [box(0, 0, 100, 100), box(140, 240, 200, 340)];  // gap 140 ≥ 80
  assert.deepEqual(splitMergedBoxes([b], far, GAP), [
    { x1: 0, y1: 0, x2: 140, y2: 140, conf: 0.9 },   // pad 70→cap 40
    { x1: 100, y1: 200, x2: 200, y2: 380, conf: 0.9 },
  ]);
});

test('vertical text columns split along x when the y scan finds no gap', () => {
  const b = box(0, 0, 200, 300);
  const comps = [box(20, 20, 60, 140), box(140, 180, 180, 300)];
  assert.deepEqual(splitMergedBoxes([b], comps, GAP), [
    { x1: 0, y1: 0, x2: 100, y2: 180, conf: 0.9 },
    { x1: 100, y1: 140, x2: 200, y2: 300, conf: 0.9 },
  ]);
});

test('three diagonal clusters cut twice', () => {
  const b = box(0, 0, 270, 240);
  const comps = [box(10, 0, 90, 40), box(100, 100, 180, 140), box(190, 200, 270, 240)];
  assert.deepEqual(splitMergedBoxes([b], comps, GAP), [
    { x1: 0, y1: 0, x2: 120, y2: 70, conf: 0.9 },
    { x1: 70, y1: 70, x2: 210, y2: 170, conf: 0.9 },
    { x1: 160, y1: 170, x2: 270, y2: 240, conf: 0.9 },
  ]);
});

test('comps outside the box are ignored; too few comps leave the box alone', () => {
  const b = box(0, 0, 100, 100);
  const outside = box(300, 300, 400, 400);
  assert.deepEqual(splitMergedBoxes([b], [outside], GAP), [b]);
  assert.deepEqual(splitMergedBoxes([b], [box(10, 10, 90, 90), outside], GAP), [b]);
  assert.deepEqual(splitMergedBoxes([b], [], GAP), [b]);
});
