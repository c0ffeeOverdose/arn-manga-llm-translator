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
    { x1: 1312, y1: 376, x2: 1408, y2: 535, conf: 0.92, clip: { x1: 1061, y1: 362, x2: 1413, y2: 547 }, cutAxis: 'y' }, // x tight to the comps, y padded 33 toward the cut
    { x1: 1062, y1: 535, x2: 1287, y2: 825, conf: 0.92, clip: { x1: 1061, y1: 523, x2: 1413, y2: 825 }, cutAxis: 'y' },
  ]);
});

test('in-block line spacing (gap below the floor) never splits', () => {
  // same-span lines: lane 2 (tile4) merges through the overlap ratio; the
  // diagonal variant of this shape is two blocks and does split (see lane 2
  // tests below)
  const parent = box(1061, 362, 1413, 825, 0.92);
  const comps = [
    box(1062, 369, 1287, 415), box(1062, 448, 1287, 504),
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
  const near = [box(0, 0, 100, 100), box(10, 170, 110, 270)]; // gap 70 < 0.8×100 (median), x-overlap keeps lane 2 fused too
  assert.equal(splitMergedBoxes([b], near, GAP).length, 1);
  const far = [box(0, 0, 100, 100), box(140, 240, 200, 340)];  // gap 140 ≥ 80
  assert.deepEqual(splitMergedBoxes([b], far, GAP), [
    { x1: 0, y1: 0, x2: 100, y2: 140, conf: 0.9, clip: { x1: 0, y1: 0, x2: 200, y2: 182 }, cutAxis: 'y' },   // pad 70→cap 40 toward the cut only
    { x1: 140, y1: 200, x2: 200, y2: 340, conf: 0.9, clip: { x1: 0, y1: 158, x2: 200, y2: 400 }, cutAxis: 'y' },
  ]);
});

test('vertical text columns split along x when the y scan finds no gap', () => {
  const b = box(0, 0, 200, 300);
  const comps = [box(20, 20, 60, 140), box(140, 180, 180, 300)];
  assert.deepEqual(splitMergedBoxes([b], comps, GAP), [
    { x1: 20, y1: 20, x2: 100, y2: 140, conf: 0.9, clip: { x1: 0, y1: 0, x2: 112, y2: 300 }, cutAxis: 'x' },
    { x1: 100, y1: 180, x2: 180, y2: 300, conf: 0.9, clip: { x1: 88, y1: 0, x2: 200, y2: 300 }, cutAxis: 'x' },
  ]);
});

test('three diagonal clusters cut twice', () => {
  const b = box(0, 0, 270, 240);
  const comps = [box(10, 0, 90, 40), box(100, 100, 180, 140), box(190, 200, 270, 240)];
  assert.deepEqual(splitMergedBoxes([b], comps, GAP), [
    { x1: 10, y1: 0, x2: 90, y2: 70, conf: 0.9, clip: { x1: 0, y1: 0, x2: 270, y2: 82 }, cutAxis: 'y' },
    { x1: 100, y1: 70, x2: 180, y2: 170, conf: 0.9, clip: { x1: 0, y1: 58, x2: 270, y2: 182 }, cutAxis: 'y' },
    { x1: 190, y1: 170, x2: 270, y2: 240, conf: 0.9, clip: { x1: 0, y1: 158, x2: 270, y2: 240 }, cutAxis: 'y' },
  ]);
});

test('comps outside the box are ignored; too few comps leave the box alone', () => {
  const b = box(0, 0, 100, 100);
  const outside = box(300, 300, 400, 400);
  assert.deepEqual(splitMergedBoxes([b], [outside], GAP), [b]);
  assert.deepEqual(splitMergedBoxes([b], [box(10, 10, 90, 90), outside], GAP), [b]);
  assert.deepEqual(splitMergedBoxes([b], [], GAP), [b]);
});

// ---- lane 2 (tile4): tightly packed pairs, comps verbatim from a live page ----
// MangaDex 40f12ceb page 4. Lane 1 rejects all three: the cluster gaps are
// 15–37px (under its max(2×28, 0.8×median) floor) and the cross-axis spans
// overlap. The fill/render stage was getting one merged translation spread
// across two balloons (or two caption blocks) on every visit.

const box2Comps = [[770, 120, 872, 151], [770, 156, 873, 182], [759, 186, 838, 215], [849, 192, 884, 222],
  [592, 200, 643, 228], [655, 200, 732, 227], [601, 237, 680, 260], [675, 237, 728, 293],
  [599, 271, 664, 294], [657, 298, 732, 326], [597, 304, 656, 326], [618, 332, 706, 360]];

test('lane 2: side-by-side balloons split on a 27px gap with cross overlap', () => {
  const parent = box(594, 118, 887, 362, 0.95);
  const parts = splitMergedBoxes([parent], box2Comps.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 })), GAP);
  assert.deepEqual(parts.map(p => [p.x1, p.y1, p.x2, p.y2]), [
    [594, 200, 745, 360], // lower-left balloon ("You must never go near…") — tight, the 1px cut gap leaves no pad
    [746, 120, 884, 222], // upper-right balloon ("Hinata, Kaoru—")
  ]);
});

const box3Comps = [[93, 152, 116, 192], [122, 153, 158, 172], [217, 156, 290, 180], [222, 182, 284, 205],
  [112, 242, 196, 266], [90, 266, 144, 291], [154, 267, 216, 290], [143, 291, 181, 316],
  [100, 292, 136, 316], [185, 292, 206, 316], [98, 316, 208, 342], [106, 342, 196, 391]];

test('lane 2: stacked caption blocks split on a 37px gap (span widened by texture comps)', () => {
  const parent = box(90, 152, 296, 388, 0.84);
  const parts = splitMergedBoxes([parent], box3Comps.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 })), GAP);
  assert.deepEqual(parts.map(p => [p.x1, p.y1, p.x2, p.y2]), [
    [93, 152, 290, 223],  // "LONG AGO" (loose: includes the texture comps)
    [90, 224, 216, 388],  // "THERE WAS SAID TO BE A SETTLEMENT THERE."
  ]);
});

const box4Comps = [[1177, 851, 1248, 879], [1151, 884, 1232, 946], [1243, 884, 1269, 912], [1217, 917, 1274, 945],
  [1047, 946, 1136, 975], [972, 948, 1039, 980], [1163, 949, 1199, 978], [1208, 950, 1263, 978],
  [979, 980, 1039, 1008], [1175, 984, 1250, 1018], [1049, 985, 1130, 1008], [985, 1012, 1066, 1042],
  [1075, 1018, 1123, 1041], [979, 1046, 1003, 1074], [1003, 1046, 1082, 1074], [1093, 1046, 1130, 1074],
  [1029, 1080, 1094, 1108], [1011, 1086, 1028, 1106]];

test('lane 2: balloons 15px apart split (72px of cross overlap)', () => {
  const parent = box(968, 843, 1274, 1113, 0.88);
  const parts = splitMergedBoxes([parent], box4Comps.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 })), GAP);
  assert.deepEqual(parts.map(p => [p.x1, p.y1, p.x2, p.y2]), [
    [972, 946, 1143, 1108], // "Only those who serve them…"
    [1144, 851, 1274, 1018], // "That place is the land of the gods."
  ]);
});

test('lane 2: a same-span caption block stays whole', () => {
  const midComps = [[1199, 1447, 1325, 1498], [1163, 1448, 1189, 1471], [1167, 1471, 1205, 1496], [1175, 1498, 1312, 1546],
    [1247, 1547, 1303, 1571], [1184, 1548, 1241, 1572], [1156, 1572, 1304, 1597], [1311, 1573, 1329, 1596],
    [1181, 1598, 1308, 1622], [1149, 1624, 1333, 1648]];
  const parent = box(1149, 1439, 1334, 1653, 0.9);
  assert.deepEqual(splitMergedBoxes([parent], midComps.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 })), GAP), [parent]);
});

test('lane 2: nested single line under its block stays fused', () => {
  const parent = box(0, 0, 300, 700, 0.4);
  const comps = [
    box(20, 0, 280, 80), box(20, 100, 280, 180), box(20, 200, 280, 280), box(20, 300, 280, 380),
    box(120, 500, 250, 570),
  ];
  assert.deepEqual(splitMergedBoxes([parent], comps, GAP), [parent]);
});

test('lane 2: diagonal two-line groups are two blocks and split', () => {
  const parent = box(1061, 362, 1413, 825, 0.92);
  const comps = [
    box(1305, 369, 1413, 415), box(1305, 448, 1413, 504),
    box(1062, 534, 1287, 575), box(1062, 600, 1287, 640),
  ];
  assert.deepEqual(splitMergedBoxes([parent], comps, GAP), [
    { x1: 1305, y1: 369, x2: 1413, y2: 519, conf: 0.92, clip: { x1: 1061, y1: 362, x2: 1413, y2: 531 }, cutAxis: 'y' },
    { x1: 1062, y1: 519, x2: 1287, y2: 640, conf: 0.92, clip: { x1: 1061, y1: 507, x2: 1413, y2: 825 }, cutAxis: 'y' },
  ]);
});

test('split children carry a clip on their side of the cut', () => {
  const parent = box(594, 118, 887, 362, 0.95);
  const parts = splitMergedBoxes([parent], box2Comps.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 })), GAP);
  // cut midway in the 27px gap (745.5), slack capped at SPLIT_CLIP_SLACK=12
  assert.deepEqual(parts.map(p => p.clip), [
    { x1: 594, y1: 118, x2: 758, y2: 362 },
    { x1: 734, y1: 118, x2: 887, y2: 362 },
  ]);
  for (const p of parts) {
    assert.ok(p.clip.x1 <= p.x1 && p.clip.x2 >= p.x2 && p.clip.y1 <= p.y1 && p.clip.y2 >= p.y2, 'clip contains the child box');
    assert.ok(p.clip.x1 >= parent.x1 && p.clip.x2 <= parent.x2, 'clip stays inside the parent');
  }
});

// Strict box geometry: the cut evidence keeps the loose comps (a box-head
// corroborated texture patch may be legitimate support for a cut) but the
// child BOX is measured from the text-likelihood comps only. Live page 4:
// the two top-left comps are a screentone patch (mean mask prob 0.35/0.41 vs
// 0.8+ for the glyphs) — with them the “LONG AGO” child box grew 109px left
// over the hatch; the rest of the page's boxes are unaffected (strict == loose).
test('strict comps keep a texture patch out of the child box', () => {
  const parent = box(90, 152, 296, 388, 0.84);
  const loose = box3Comps.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 }));
  const strict = loose.filter(c => c.x1 > 200 || c.y1 > 210); // drop the two patch comps (x 93-158, y 152-192)
  const parts = splitMergedBoxes([parent], loose, GAP, strict);
  assert.deepEqual(parts.map(p => [p.x1, p.y1, p.x2, p.y2]), [
    [217, 156, 290, 223], // hugs the “LONG AGO” glyphs (was 93 with the patch comps in)
    [90, 224, 216, 388],
  ]);
  // same call without the strict set: the loose group (patch comps included) widens the box
  assert.deepEqual(splitMergedBoxes([parent], loose, GAP).map(p => [p.x1, p.y1, p.x2, p.y2]), [
    [93, 152, 290, 223],
    [90, 224, 216, 388],
  ]);
});

// Soft glyph edges fall below the strict probability and leave the strict-only
// child box — which then (and with it the layout area floored by it) drifts
// sideways off the balloon text. The child box is core-SEEDED: a loose cluster
// hugging the strict core still extends it.
test('strict core seeds the child box: an adjacent loose comp stays inside', () => {
  const parent = box(968, 843, 1274, 1113, 0.88);
  const loose = box4Comps.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 }));
  // strict set misses one edge line of the lower block ([972,948,1039,980])
  const strict = loose.filter(c => !(c.x1 === 972 && c.y1 === 948));
  const parts = splitMergedBoxes([parent], loose, GAP, strict);
  assert.deepEqual(parts.map(p => [p.x1, p.y1, p.x2, p.y2]), [
    [972, 946, 1143, 1108], // unchanged: the dropped comp sits inside the leash
    [1144, 851, 1274, 1018],
  ]);
  // a loose comp FAR from the core must not extend it (the page-4 patch rule)
  const far = [...loose, { x1: 700, y1: 950, x2: 760, y2: 990 }];
  const parts2 = splitMergedBoxes([parent], far, GAP, strict);
  assert.deepEqual(parts2.map(p => [p.x1, p.y1, p.x2, p.y2]), [
    [972, 946, 1143, 1108],
    [1144, 851, 1274, 1018],
  ]);
});

// Live nhentai case (g/681658 page 9, comps verbatim): one CTD box over two
// stacked balloons. The half-cut gap (61/2 = 30) must pad the cut axis only —
// padding the cross axis too stretched the upper child to 456..542 (text is
// 486..539) and the lower to 438..525 (text 441..495), frames looking shifted.
test('split pad faces the cut axis only (live stacked balloons)', () => {
  const parent = box(438, 918, 542, 1144, 0.94);
  const comps = [
    box(515, 916, 539, 940), box(486, 918, 509, 941), box(520, 946, 539, 961),
    box(441, 1022, 466, 1048), box(471, 1023, 495, 1047), box(473, 1050, 495, 1070),
    box(442, 1052, 465, 1069), box(442, 1073, 465, 1096), box(443, 1097, 466, 1121),
    box(445, 1123, 463, 1145),
  ];
  assert.deepEqual(splitMergedBoxes([parent], comps, GAP).map(p => [p.x1, p.y1, p.x2, p.y2]), [
    [486, 918, 539, 991], // text-hugging x, 30px leash toward the cut
    [441, 992, 495, 1144],
  ]);
});

// Live case (MangaDex page 2, worker comps verbatim): a 31x13 "YES" lobe
// fragment above its balloon's 3-line block. The fragment sits under the old
// ≥14 split-input floor (bh 13) so the box never split and the lobe painted
// blank — with the floor at 10, lane 2 cuts it (48px gap, disjoint spans).
test('live YES-lobe fragment splits off its balloon (10px split-input floor)', () => {
  const parent = box(108, 500, 211, 621, 0.9);
  const comps = [
    box(180, 504, 211, 517),
    box(114, 565, 168, 580), box(117, 584, 165, 599), box(112, 603, 170, 618),
  ];
  assert.deepEqual(splitMergedBoxes([parent], comps, GAP, comps), [
    { x1: 180, y1: 504, x2: 211, y2: 541, conf: 0.9, clip: { x1: 108, y1: 500, x2: 211, y2: 553 }, cutAxis: 'y' },
    { x1: 112, y1: 541, x2: 170, y2: 618, conf: 0.9, clip: { x1: 108, y1: 529, x2: 211, y2: 621 }, cutAxis: 'y' },
  ]);
});

// ---- twin-balloon cut (live md4: names lobe 8px from body, nested + under
// lane 2's floor — both lanes fuse; a straight ink-free avenue with wide
// multi-row text both sides still splits). Worker zone comps verbatim (raw
// pre-merge, center-in-box subset of the 20 logged).
test('live md4 twin balloons split at the 8px avenue despite nesting', () => {
  const parent = box(477, 76, 679, 239, 0.62);
  // [x1,y1,x2,y2]: BY, body words, Eli/Ella/Ildana; ornament + border excluded
  // (centres outside the box, like the worker filter)
  const comps = [
    box(609, 73, 629, 90), box(585, 95, 611, 111), box(614, 95, 653, 111),
    box(565, 117, 583, 132), box(587, 117, 612, 133), box(615, 117, 675, 133),
    box(498, 120, 533, 145), box(560, 138, 570, 153), box(572, 138, 613, 154),
    box(617, 138, 677, 154), box(490, 152, 539, 176), box(611, 159, 654, 176),
    box(584, 160, 609, 176), box(595, 181, 613, 197), box(618, 181, 642, 198),
    box(482, 182, 552, 207), box(590, 203, 645, 220), box(600, 224, 636, 241),
  ];
  const kids = splitMergedBoxes([parent], comps, GAP, comps);
  assert.equal(kids.length, 2);
  assert.deepEqual([kids[0].x1, kids[0].y1, kids[0].x2, kids[0].y2], [482, 120, 558, 207]);
  assert.deepEqual([kids[1].x1, kids[1].y1, kids[1].x2, kids[1].y2], [559, 76, 677, 239]);
  assert.equal(kids[0].cutAxis, 'x');
  assert.equal(kids[1].cutAxis, 'x');
  assert.deepEqual([kids[0].clip.x1, kids[0].clip.x2], [477, 565]);
  assert.deepEqual([kids[1].clip.x1, kids[1].clip.x2], [553, 679]);
});

// Vertical-text columns must never x-split: tall comps fail the wide test.
test('twin cut ignores vertical-text columns', () => {
  const parent = box(100, 100, 300, 400, 0.9);
  const comps = [
    box(110, 110, 140, 390), box(155, 110, 185, 390),
    box(200, 110, 230, 390), box(245, 110, 275, 390),
  ];
  assert.deepEqual(splitMergedBoxes([parent], comps, GAP, comps), [parent]);
});

// A word gap with a full-width line crossing it is no avenue: no cut.
test('twin cut ignores word gaps crossed by other lines', () => {
  const parent = box(400, 100, 700, 200, 0.9);
  const comps = [
    box(410, 105, 690, 130),
    box(410, 140, 480, 165), box(500, 140, 570, 165), box(590, 140, 660, 165),
  ];
  assert.deepEqual(splitMergedBoxes([parent], comps, GAP, comps), [parent]);
});

// ---- lane-2 short-first split (live p7: one-line WHOA! 69px above its block;
// nested, so the strong factor vetoes it like the dropped-line case — but a
// short FIRST group is its own balloon, not a paragraph first line). Worker
// comps verbatim (raw pre-merge).
test('live p7 WHOA! splits off its block (short first group, big gap)', () => {
  const parent = box(42, 782, 153, 1010, 0.78);
  const comps = [
    box(63, 793, 134, 814),
    box(66, 883, 125, 900), box(57, 905, 83, 922), box(83, 905, 98, 921),
    box(106, 905, 143, 921), box(48, 926, 96, 943), box(103, 926, 151, 942),
    box(70, 948, 129, 965), box(55, 969, 92, 986), box(93, 969, 144, 986),
    box(106, 990, 154, 1007), box(45, 991, 97, 1009),
  ];
  const kids = splitMergedBoxes([parent], comps, GAP, comps);
  assert.equal(kids.length, 2);
  assert.deepEqual([kids[0].x1, kids[0].y1, kids[0].x2, kids[0].y2], [63, 793, 134, 848]);
  assert.deepEqual([kids[1].x1, kids[1].y1, kids[1].x2, kids[1].y2], [45, 849, 153, 1009]);
  assert.equal(kids[0].cutAxis, 'y');
  assert.equal(kids[1].cutAxis, 'y');
});

// Guard: a short LAST group with a big gap is the dropped-line case — stays fused.
test('short last group with a big gap stays fused (dropped-line guard)', () => {
  const parent = box(42, 700, 153, 950, 0.8);
  const comps = [
    box(48, 710, 150, 730), box(48, 742, 150, 762), box(48, 774, 150, 794),
    box(80, 866, 120, 884),
  ];
  assert.deepEqual(splitMergedBoxes([parent], comps, GAP, comps), [parent]);
});

// Guard: a short first group with a line-size gap is a paragraph — stays fused.
test('short first group with a small gap stays fused (paragraph guard)', () => {
  const parent = box(42, 700, 153, 950, 0.8);
  const comps = [
    box(60, 710, 130, 728),
    box(48, 738, 150, 758), box(48, 770, 150, 790), box(48, 802, 150, 822),
  ];
  assert.deepEqual(splitMergedBoxes([parent], comps, GAP, comps), [parent]);
});

// ---- pass-3 rescue (live /14: the 28px merge chained the left はむ into a
// super-comp overlapping box 5, which the overlap gate then swallowed whole)
const { rescueSplitComp } = await import(new URL('../.test-build/box-split-detection.mjs', import.meta.url).href);
const dense = (mean = 0.85) => (x1, y1, x2, y2) => ({ count: (x2 - x1) * (y2 - y1) * 0.1, probSum: (x2 - x1) * (y2 - y1) * 0.1 * mean });
const overlapsBox5 = (r) => !(r.x2 <= 594.9 || r.x1 >= 650.8 || r.y2 <= 389.5 || r.y1 >= 553.3);
const MD14_TEXTY = [
  [467, 409, 508, 446], [471, 443, 514, 478], [543, 409, 586, 474],
  [613, 390, 644, 405], [608, 409, 648, 425], [610, 429, 645, 445],
  [617, 479, 630, 494], [596, 498, 648, 514], [591, 518, 652, 533], [597, 537, 639, 552],
].map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 }));

test('rescue: chained super-comp splits, outside piece survives', () => {
  const out = rescueSplitComp({ x1: 467, y1: 390, x2: 652, y2: 552 }, MD14_TEXTY, MD14_TEXTY, GAP, 752 * 1080, dense(), overlapsBox5, () => 0);
  assert.equal(out.length, 1);
  assert.ok(out[0].x2 <= 594.9, 'rescued piece stays outside box 5');
  assert.ok(out[0].x1 <= 470 && out[0].y1 <= 412, 'piece covers the left はむ cluster');
  assert.equal(out[0].conf, 0.5);
});

test('rescue: gapless comp stays dead (no phantom split)', () => {
  const texty = [{ x1: 600, y1: 400, x2: 640, y2: 540 }];
  const out = rescueSplitComp({ x1: 595, y1: 390, x2: 651, y2: 553 }, texty, texty, GAP, 752 * 1080, dense(), overlapsBox5, () => 0);
  assert.deepEqual(out, []);
});

test('rescue: sparse piece fails the fill re-gate', () => {
  const thin = () => ({ count: 1, probSum: 0.85 });
  const out = rescueSplitComp({ x1: 467, y1: 390, x2: 652, y2: 552 }, MD14_TEXTY, MD14_TEXTY, GAP, 752 * 1080, thin, () => false, () => 0);
  assert.deepEqual(out, []);
});
