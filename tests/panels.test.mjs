// Unit tests for panel output parsing + panel-guided ordering (pure logic).
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/content/detection.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/panel-detection.mjs', sourcemap: 'inline',
});

const { parsePanelOutput, orderByPanels, sortReadingOrder, splitDeferred, panelsUsable, splitTiles, mergeTileBoxes, PANEL_CONF_THR } =
  await import(new URL('../.test-build/panel-detection.mjs', import.meta.url).href);

const box = (x1, y1, x2, y2, conf = 0.9) => ({ x1, y1, x2, y2, conf });

// ---- parse: [x1,y1,x2,y2] 0-640 space, conf, class ----

test('parse splits panels, thresholds, scales and clamps (text class skipped)', () => {
  const data = [
    0, 0, 640, 640, 0.98, 0,      // full-page panel
    64, 64, 128, 128, 0.80, 1,    // text → ignored entirely (CTD owns text)
    0, 0, 64, 64, 0.10, 0,        // below threshold → dropped (near-miss)
    0, 0, 64, 64, 0.10, 1,        // below-threshold text → nowhere
    0, 0, 64, 64, 0.03, 0,        // below noise floor → nowhere
    -32, -32, 700, 700, 0.50, 0,  // clamped to page
    100, 100, 100, 200, 0.90, 0,  // degenerate, dropped
  ];
  const { panels, dropped } = parsePanelOutput(data, 1000, 2000);
  assert.equal(PANEL_CONF_THR, 0.20);
  assert.equal(panels.length, 2);
  assert.deepEqual([panels[0].x1, panels[0].y1, panels[0].x2, panels[0].y2], [0, 0, 1000, 2000]);
  assert.deepEqual([panels[1].x1, panels[1].y1, panels[1].x2, panels[1].y2], [0, 0, 1000, 2000]);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].conf, 0.10);
});

// ---- order: panels group boxes, bands fall back ----

const P = (x1, y1, x2, y2) => box(x1, y1, x2, y2, 1);

test('empty panels fall back to banding', () => {
  const a = box(800, 50, 890, 140);
  const b = box(50, 400, 140, 490);
  assert.deepEqual(orderByPanels([b, a], [], 'rtl'), [a, b]);
  assert.deepEqual(orderByPanels([b, a], [], 'rtl'), sortReadingOrder([b, a], 'rtl'));
});

test('user screenshot replica: row-major across three panel rows', () => {
  const panels = [P(0, 0, 1000, 300), P(0, 300, 1000, 600), P(0, 600, 1000, 1000)];
  const r1 = [800, 650, 500, 350, 200, 50].map(x => box(x, 50, x + 90, 140));
  const r2 = [800, 500, 200].map(x => box(x, 350, x + 90, 440));
  const r3 = [800, 600, 400, 200].map(x => box(x, 650, x + 90, 740));
  const scrambled = [r1[3], r3[0], r2[1], r1[0], r3[2], r2[0], r1[5], r2[2], r1[1], r3[3], r1[4], r3[1], r1[2]];
  assert.deepEqual(orderByPanels(scrambled, panels, 'rtl'), [...r1, ...r2, ...r3]);
});

test('inset panel wins over host (smallest containing)', () => {
  const host = P(0, 0, 1000, 1000);
  const inset = P(400, 100, 600, 300);
  const inside = box(450, 150, 550, 250);
  const outside = box(100, 500, 200, 600);
  // inset orders before host (banding on panel tops: 100 < 0? no — host top 0 first,
  // but host group has [outside], inset group has [inside] → host panel first)
  const out = orderByPanels([inside, outside], [host, inset], 'rtl');
  assert.deepEqual(out, [outside, inside]);
  assert.ok(out.includes(inside) && out.includes(outside));
});

test('box outside every panel joins the nearest one', () => {
  const left = P(0, 0, 400, 1000);
  const right = P(600, 0, 1000, 1000);
  const stray = box(450, 100, 500, 200); // center 475: nearer to left (75px) than right (125px)
  const inRight = box(700, 100, 800, 200);
  const out = orderByPanels([stray, inRight], [left, right], 'rtl');
  assert.deepEqual(out, [inRight, stray]);
});

test('live page replica: dump boxes + probed panels order 1..16', () => {
  // badges 1..16 in dump order; panels probed at thr 0.25 (P5 absent)
  const boxes = [{"x1":1526,"y1":197,"x2":1581,"y2":311,"conf":0.89},{"x1":1053,"y1":798,"x2":1143,"y2":871,"conf":0.47},{"x1":1328,"y1":890,"x2":1355,"y2":954,"conf":0.77},{"x1":818,"y1":227,"x2":974,"y2":416,"conf":0.87},{"x1":293,"y1":178,"x2":445,"y2":370,"conf":0.94},{"x1":648,"y1":335,"x2":750,"y2":516,"conf":0.72},{"x1":651,"y1":606,"x2":810,"y2":676,"conf":0.78},{"x1":566,"y1":703,"x2":655,"y2":769,"conf":0.73},{"x1":249,"y1":603,"x2":444,"y2":898,"conf":0.9},{"x1":582,"y1":1218,"x2":819,"y2":1461,"conf":0.9},{"x1":1242,"y1":1422,"x2":1657,"y2":1555,"conf":0.63},{"x1":908,"y1":1378,"x2":1062,"y2":1651,"conf":0.87},{"x1":246,"y1":1791,"x2":802,"y2":1894,"conf":0.5},{"x1":1342,"y1":1924,"x2":1515,"y2":2123,"conf":0.88},{"x1":904,"y1":2024,"x2":1058,"y2":2186,"conf":0.77},{"x1":394,"y1":1947,"x2":744,"y2":2314,"conf":0.45}];
  const panels = [P(1021, 1, 1698, 997), P(861, 1023, 1698, 1761), P(857, 1791, 1700, 2399), P(149, 8, 1013, 994)];
  const out = orderByPanels(boxes, panels, 'rtl');
  assert.deepEqual(out.map(b => boxes.indexOf(b) + 1), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

test('live page with P5: user-expected order (dialogue before labels, THEREFORE sinks)', () => {
  const boxes = [{"x1":1526,"y1":197,"x2":1581,"y2":311,"conf":0.89},{"x1":1053,"y1":798,"x2":1143,"y2":871,"conf":0.47},{"x1":1328,"y1":890,"x2":1355,"y2":954,"conf":0.77},{"x1":818,"y1":227,"x2":974,"y2":416,"conf":0.87},{"x1":293,"y1":178,"x2":445,"y2":370,"conf":0.94},{"x1":648,"y1":335,"x2":750,"y2":516,"conf":0.72},{"x1":651,"y1":606,"x2":810,"y2":676,"conf":0.78},{"x1":566,"y1":703,"x2":655,"y2":769,"conf":0.73},{"x1":249,"y1":603,"x2":444,"y2":898,"conf":0.9},{"x1":582,"y1":1218,"x2":819,"y2":1461,"conf":0.9},{"x1":1242,"y1":1422,"x2":1657,"y2":1555,"conf":0.63},{"x1":908,"y1":1378,"x2":1062,"y2":1651,"conf":0.87},{"x1":246,"y1":1791,"x2":802,"y2":1894,"conf":0.5},{"x1":1342,"y1":1924,"x2":1515,"y2":2123,"conf":0.88},{"x1":904,"y1":2024,"x2":1058,"y2":2186,"conf":0.77},{"x1":394,"y1":1947,"x2":744,"y2":2314,"conf":0.45}];
  const panels = [P(1021, 1, 1698, 997), P(861, 1023, 1698, 1761), P(857, 1791, 1700, 2399), P(149, 8, 1013, 994), P(143, 1018, 848, 2391)];
  const out = orderByPanels(boxes, panels, 'rtl', { w: 1700, h: 2400 });
  assert.deepEqual(out.map(b => boxes.indexOf(b) + 1), [1, 2, 3, 4, 5, 9, 6, 7, 8, 11, 12, 14, 15, 10, 13, 16]);
});

test('splitDeferred: small clustered labels sink, isolated small boxes stay', () => {
  const big1 = box(800, 50, 950, 240);    // dialogue
  const big2 = box(250, 600, 450, 900);   // dialogue
  const lab1 = box(650, 330, 750, 500);   // small labels, clustered
  const lab2 = box(655, 600, 810, 670);
  const lab3 = box(570, 700, 660, 770);
  const tiny = box(1500, 200, 1560, 310); // small but isolated (short reply)
  const { main, deferred } = splitDeferred([big1, big2, lab1, lab2, lab3, tiny], 1700, 2400);
  assert.deepEqual(main, [big1, big2, tiny]);
  assert.deepEqual(deferred, [lab1, lab2, lab3]);
});

test('defer=false restores pure geometry order', () => {
  const panel = P(0, 0, 1000, 1000);
  const dlg = box(250, 600, 450, 900);   // big dialogue, low
  const lab = box(650, 330, 750, 500);   // small label clustered with lab2
  const lab2 = box(655, 600, 810, 670);
  const page = { w: 1700, h: 2400 };
  const on = orderByPanels([lab, dlg, lab2], [panel], 'rtl', page, true);
  assert.deepEqual(outIdx(on, [lab, dlg, lab2]), [2, 1, 3]); // dlg, lab, lab2
  const off = orderByPanels([lab, dlg, lab2], [panel], 'rtl', page, false);
  assert.deepEqual(outIdx(off, [lab, dlg, lab2]), [1, 3, 2]); // geometry: lab, lab2, dlg
});

function outIdx(out, boxes) {
  return out.map(b => boxes.indexOf(b) + 1);
}

test('panelsUsable: normal page passes, sliver soup and panel floods fail', () => {
  // 6 sane panels on a manga page
  const sane = [box(0, 0, 800, 1200), box(800, 0, 1600, 1200), box(0, 1200, 800, 2400),
    box(800, 1200, 1600, 2400), box(100, 100, 700, 1100), box(900, 1300, 1500, 2300)];
  assert.equal(panelsUsable(sane, 1600, 2400), true);
  // empty → banding (old behavior preserved)
  assert.equal(panelsUsable([], 1600, 2400), false);
  // sliver soup: biggest covers <40% of the page
  const slivers = Array.from({ length: 8 }, (_, i) => box(0, i * 1700, 800, i * 1700 + 200));
  assert.equal(panelsUsable(slivers, 800, 13650), false);
  // panel flood: more than any real page has
  const flood = Array.from({ length: 26 }, (_, i) => box(0, i * 500, 800, i * 500 + 490));
  assert.equal(panelsUsable(flood, 800, 13650), false);
});

test('orderByPanels: unusable panels fall back to banding', () => {
  const slivers = Array.from({ length: 8 }, (_, i) => box(0, i * 1700, 800, i * 1700 + 200));
  const top = box(100, 100, 700, 400);
  const bottom = box(100, 13000, 700, 13300);
  const page = { w: 800, h: 13650 };
  const out = orderByPanels([bottom, top], slivers, 'rtl', page);
  assert.deepEqual(out, [top, bottom]); // banding, slivers ignored
});

test('splitTiles: normal pages stay single-pass, strips tile with overlap', () => {
  assert.deepEqual(splitTiles(1600, 2400), []); // manga page, aspect 1.5
  assert.deepEqual(splitTiles(2400, 1600), []); // landscape, aspect 1.5
  const tiles = splitTiles(800, 13650); // a long-strip page
  assert.ok(tiles.length >= 10, `got ${tiles.length} tiles`);
  assert.equal(tiles[0].y0, 0);
  const last = tiles[tiles.length - 1];
  assert.equal(last.y0 + last.h, 13650); // ends exactly at the edge, no sliver
  for (let i = 1; i < tiles.length; i++) {
    const ov = tiles[i - 1].y0 + tiles[i - 1].h - tiles[i].y0;
    assert.ok(ov >= 150 && ov <= 220, `overlap ${ov} between tile ${i - 1}/${i}`);
  }
  const wide = splitTiles(13650, 800); // horizontal strip mirrors the logic
  assert.ok(wide.length >= 10 && wide[0].x0 === 0);
  assert.equal(wide[wide.length - 1].x0 + wide[wide.length - 1].w, 13650);
});

test('mergeTileBoxes: seam-cut text unions once, the rest is untouched', () => {
  const A = { x0: 0, y0: 0, w: 800, h: 1200 };
  const B = { x0: 0, y0: 1020, w: 800, h: 1200 }; // seam at y=1200/1020, overlap 180
  // dialogue cut by the seam: top half in A touching its bottom edge,
  // bottom half in B touching its top edge, same x-span
  const top = { x1: 100, y1: 1100, x2: 700, y2: 1198, conf: 0.9 };
  const bot = { x1: 105, y1: 5, x2: 695, y2: 120, conf: 0.8 };
  // unrelated boxes far from the seam, one per tile
  const aFar = { x1: 50, y1: 50, x2: 300, y2: 200, conf: 0.9 };
  const bFar = { x1: 50, y1: 900, x2: 300, y2: 1050, conf: 0.9 };
  const out = mergeTileBoxes([
    { tile: A, boxes: [top, aFar] },
    { tile: B, boxes: [bot, bFar] },
  ]);
  assert.equal(out.length, 3); // pair unions, far boxes untouched
  const union = out.find(b => b.y1 === 1025); // bot half starts higher in page coords
  assert.deepEqual([union.x1, union.y1, union.x2, union.y2], [100, 1025, 700, 1198]);
  assert.equal(union.conf, 0.9); // max conf rides along
  // same-tile overlaps are NOT merged here (worker-side NMS owns those)
  const dup = mergeTileBoxes([{ tile: A, boxes: [aFar, { ...aFar, conf: 0.5 }] }]);
  assert.equal(dup.length, 2);
});
