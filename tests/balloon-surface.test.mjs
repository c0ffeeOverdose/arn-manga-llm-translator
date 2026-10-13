import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const compiled = await build({ entryPoints: ['src/content/balloon-surface.ts'], bundle: true, format: 'esm', write: false });
const { balloonSurface, splitBalloonSurfaces, splitConnectedClusters, surfaceContains, mergeBalloonLines } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].contents).toString('base64'));
const previous = await build({ entryPoints: ['src/content/detection.ts'], bundle: true, format: 'esm', write: false });
const { splitMergedBoxes } = await import('data:text/javascript;base64,' + Buffer.from(previous.outputFiles[0].contents).toString('base64'));
const client = await build({ entryPoints: ['src/content/render.ts'], bundle: true, format: 'esm', write: false });
const { mergeParagraphLines } = await import('data:text/javascript;base64,' + Buffer.from(client.outputFiles[0].contents).toString('base64'));

function fixture({ together = false, open = false, tone = 255, scale = 1, outside = tone, close = false } = {}) {
    const W = 200 * scale, H = 120 * scale;
    const data = new Uint8ClampedArray(W * H * 4).fill(outside), ink = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) data[p * 4 + 3] = 255;
    const rect = (x1, y1, x2, y2, value, text = false) => {
        for (let y = Math.floor(y1 * scale); y < Math.ceil(y2 * scale); y++) for (let x = Math.floor(x1 * scale); x < Math.ceil(x2 * scale); x++) {
            const p = y * W + x;
            data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = value;
            if (text) ink[p] = 255;
        }
    };
    const outline = (x1, x2) => {
        rect(x1, 20, x2, 82, tone);
        rect(x1, 20, x2, 22, 255 - tone); rect(x1, 80, x2, 82, 255 - tone);
        rect(x1, 20, x1 + 2, 82, 255 - tone); rect(x2 - 2, 20, x2, 82, 255 - tone);
    };
    if (!open) { if (together) outline(20, 158); else if (close) { outline(20, 55); outline(55, 100); } else { outline(20, 87); outline(90, 158); } }
    for (const x of close ? [25, 40, 58, 73] : [45, 60, 105, 120]) rect(x, 40, x + 10, 58, 255 - tone, true);
    const box = { x1: (close ? 23 : 43) * scale, y1: 38 * scale, x2: (close ? 85 : 132) * scale, y2: 60 * scale, conf: 0.9 };
    return { img: { width: W, height: H, data }, mask: { width: W, height: H, data: ink.buffer }, box };
}

test('separate enclosed surfaces split one text proposal without losing either text', () => {
    for (const scale of [0.5, 1, 2]) for (const tone of [255, 0]) {
        const { img, mask, box } = fixture({ scale, tone });
        const before = structuredClone(box), pixels = img.data.slice();
        const out = splitBalloonSurfaces(img, [box], mask);
        assert.equal(out.length, 2);
        assert.ok(out[0].x2 < out[1].x1);
        assert.ok(out[0].x1 <= 45 * scale && out[0].x2 >= 70 * scale);
        assert.ok(out[1].x1 <= 105 * scale && out[1].x2 >= 130 * scale);
        assert.ok(out[0].clip.x2 < out[1].clip.x1);
        assert.deepEqual(box, before);
        assert.deepEqual(img.data, pixels);
    }
});

test('a physical divider separates twins whose text gap is below the geometric cut floor', () => {
    const { img, mask, box } = fixture({ close: true });
    const comps = [25, 40, 58, 73].map(x => ({ x1: x, y1: 40, x2: x + 10, y2: 58 }));
    assert.equal(splitMergedBoxes([box], comps, 28).length, 1, 'geometry alone cannot establish the boundary');
    const out = splitBalloonSurfaces(img, [box], mask);
    assert.equal(out.length, 2);
    assert.ok(out[0].x2 <= 53 && out[1].x1 >= 57);
    assert.equal(mergeParagraphLines([box], () => img, mask).length, 2, 'the client pre-OCR path actually adopts the split');
});

test('a gray exterior ends the outline walk instead of reading as thick ink', () => {
    const { img, mask, box } = fixture({ outside: 180 });
    assert.equal(splitBalloonSurfaces(img, [box], mask).length, 2);
});

test('shared surfaces and open backgrounds do not invent a text split', () => {
    for (const options of [{ together: true }, { open: true }]) {
        const { img, mask, box } = fixture(options), boxes = [box];
        assert.strictEqual(splitBalloonSurfaces(img, boxes, mask), boxes);
    }
});

test('physical surface measurement can look beyond an ownership cut without changing it', () => {
    const { img, mask } = fixture({ together: true });
    const box = { x1: 43, y1: 38, x2: 72, y2: 60, conf: 0.9, cutAxis: 'x', clip: { x1: 43, y1: 38, x2: 80, y2: 60 } };
    const before = structuredClone(box);
    const surface = balloonSurface(img, box, mask, { ...box, x2: 132 });
    assert.ok(surface);
    assert.equal(surface.x1, 22);
    assert.equal(surface.x2, 156);
    assert.ok(surfaceContains(surface, box));
    assert.deepEqual(box, before);
});

test('unassigned ink and incompatible masks preserve the whole proposal', () => {
    const { img, mask, box } = fixture();
    for (let y = 40; y < 58; y++) for (let x = 86; x < 92; x++) new Uint8Array(mask.data)[y * img.width + x] = 255;
    const boxes = [box];
    assert.strictEqual(splitBalloonSurfaces(img, boxes, mask), boxes);
    assert.strictEqual(splitBalloonSurfaces(img, boxes, { ...mask, width: 1 }), boxes);
});

test('two aligned lines reunite independently of CTD parent ids, but paragraphs and columns stay separate', () => {
    const { img, mask } = fixture({ together: true });
    const boxes = [30, 55].map(y => ({ x1: 45, y1: y, x2: 100, y2: y + 18, conf: 0.9 }));
    const out = mergeBalloonLines(img, boxes, mask);
    assert.deepEqual(out, [{ x1: 45, y1: 30, x2: 100, y2: 73, conf: 0.9 }]);
    assert.strictEqual(mergeBalloonLines(img, boxes, { ...mask, width: 1 }), boxes);
    assert.equal(boxes.length, 2);
    const paragraphs = [boxes[0], { ...boxes[1], y1: 65, y2: 83 }];
    assert.strictEqual(mergeBalloonLines(img, paragraphs, mask), paragraphs);
    const columns = boxes.map(b => ({ ...b, x2: b.x1 + 8 }));
    assert.strictEqual(mergeBalloonLines(img, columns, mask), columns);
    const emptyLine = [25, 39].map(y => ({ x1: 45, y1: y, x2: 100, y2: y + 10, conf: 0.9 }));
    assert.strictEqual(mergeBalloonLines(img, emptyLine, mask), emptyLine, 'a blank proposal cannot borrow its neighbour evidence');
    const separate = fixture();
    const separateLines = [{ ...boxes[0], x2: 70 }, { ...boxes[1], x1: 105, x2: 140 }];
    assert.strictEqual(mergeBalloonLines(separate.img, separateLines, separate.mask), separateLines);
    const owned = [{ ...boxes[0], clip: { x1: 0, y1: 0, x2: 50, y2: 80 }, sib: 0 }, { ...boxes[1], x1: 105, x2: 140 }];
    assert.strictEqual(mergeBalloonLines(img, owned, mask), owned, 'frame-owned children never re-merge');
});

// ---- connected multi-lobe balloons (one shared interior, several text blocks) ----

// Union of two overlapping circles: the outline is the union boundary only, so the interior
// stays connected through the neck while the silhouette shows two lobes.
function cloverFixture({ textRects = [] } = {}) {
    const W = 260, H = 200;
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    for (let p = 0; p < W * H; p++) data[p * 4 + 3] = 255;
    const c1 = [80, 100, 52], c2 = [180, 100, 52];
    const inside = (x, y) => Math.hypot(x - c1[0], y - c1[1]) <= c1[2] || Math.hypot(x - c2[0], y - c2[1]) <= c2[2];
    const box = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x, y)) box[y * W + x] = 1;
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!box[y * W + x]) continue;
        const edge = (x === 0 || y === 0 || x === W - 1 || y === H - 1
            || !box[(y - 1) * W + x] || !box[(y + 1) * W + x] || !box[y * W + x - 1] || !box[y * W + x + 1]);
        if (edge) { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
    }
    for (const [x1, y1, x2, y2] of textRects) for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
        const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
        mask[y * W + x] = 255;
    }
    return { img: { width: W, height: H, data }, mask: { width: W, height: H, data: mask.buffer },
        box: { x1: 40, y1: 60, x2: 228, y2: 146, conf: 0.9 } };
}

const reachOf = clip => ({ x1: clip.x1, y1: clip.y1, x2: clip.x2 - 1, y2: clip.y2 - 1 });
const insideReach = (c, reach) => Math.min(c.x2 - 1, reach.x2) >= Math.max(c.x1, reach.x1)
    && Math.min(c.y2 - 1, reach.y2) >= Math.max(c.y1, reach.y1);

test('a connected multi-lobe balloon splits at its text-block seams with frame clips', () => {
    const { img, mask, box } = cloverFixture({ textRects: [
        [45, 70, 95, 90], [99, 70, 120, 90], [45, 96, 115, 116],
        [150, 70, 215, 90], [150, 96, 215, 116], [150, 122, 200, 142],
    ] });
    const before = structuredClone(box);
    const out = splitBalloonSurfaces(img, [box], mask);
    assert.equal(out.length, 2, 'one shared interior, two text blocks -> two regions');
    assert.ok(out[0].x1 <= 45 && out[0].x2 >= 120 && out[0].y2 >= 116);
    assert.ok(out[1].x1 <= 150 && out[1].x2 >= 215 && out[1].y2 >= 142);
    assert.equal(out[0].sib, out[1].sib);
    assert.ok(out[0].clip && out[1].clip, 'children carry frame clips');
    for (const [i, other] of [[0, 1], [1, 0]]) {
        const reach = reachOf(out[i].clip);
        assert.ok(reach.x1 <= out[i].x1 && reach.x2 >= out[i].x2 - 1 && reach.y1 <= out[i].y1 && reach.y2 >= out[i].y2 - 1,
            'the frame still covers the child’s own text');
        for (const comp of [[45, 70, 95, 90], [99, 70, 120, 90], [45, 96, 115, 116], [150, 70, 215, 90], [150, 96, 215, 116], [150, 122, 200, 142]]) {
            const c = { x1: comp[0], y1: comp[1], x2: comp[2], y2: comp[3] };
            const mine = i === 0 ? c.x1 < 130 : c.x1 >= 130;
            if (!mine) assert.ok(!insideReach(c, reach), `sibling ink stays outside child ${i}'s erase reach`);
        }
    }
    assert.deepEqual(box, before, 'the parent proposal is untouched');
    const chained = mergeParagraphLines([{ ...box }], () => img, mask);
    assert.equal(chained.length, 2, 'the pre-OCR chain adopts the split');
});

test('word spacing and single-line fragments never split a balloon', () => {
    const wide = cloverFixture({ textRects: [[50, 90, 100, 110], [124, 90, 174, 110]] });
    assert.ok(!splitBalloonSurfaces(wide.img, [wide.box], wide.mask).some(b => b.clip),
        'two wide-spaced words are still one line, not two regions');
    const thin = cloverFixture({ textRects: [[50, 90, 110, 110], [150, 90, 210, 110]] });
    assert.ok(!splitBalloonSurfaces(thin.img, [thin.box], thin.mask).some(b => b.clip),
        'one-line fragments are not their own text blocks');
});

test('frame math: a sibling touching the frame edge stays safe; an interleaved pair refuses to split', () => {
    const W = 220, H = 180;
    const comps = [
        { x1: 20, y1: 40, x2: 90, y2: 60, conf: 0.9 }, { x1: 20, y1: 66, x2: 90, y2: 86, conf: 0.9 },
        { x1: 90, y1: 84, x2: 150, y2: 104, conf: 0.9 }, { x1: 90, y1: 110, x2: 150, y2: 130, conf: 0.9 },
    ];
    const parent = { x1: 20, y1: 40, x2: 150, y2: 130, conf: 0.9 };
    const pieces = splitConnectedClusters(comps, parent, W, H, 3);
    assert.ok(pieces && pieces.length === 2, 'touching bboxes still split');
    assert.equal(pieces[0].clip.x2, 90, 'left frame stops at its own ink edge');
    assert.equal(pieces[1].clip.x1, 90, 'right frame stops at its own ink edge');
    assert.equal(pieces[0].sib, 3);
    assert.ok(!insideReach({ x1: 90, y1: 84, x2: 150, y2: 104 }, reachOf(pieces[0].clip)));
    const overlapping = comps.map((c, i) => i >= 2 ? { ...c, x1: c.x1 - 1, x2: c.x2 - 1 } : c);
    const repaired = splitConnectedClusters(overlapping, parent, W, H, 3);
    assert.ok(repaired && repaired.length === 2, 'a 1px sibling intrusion is repaired, not vetoed');
    assert.equal(repaired[0].clip.x2, 89, 'the frame side shrinks exactly onto the intrusion edge');
    assert.equal(repaired[1].clip.x1, 90, 'the other child keeps its own edge');
    assert.ok(!insideReach({ x1: 89, y1: 84, x2: 149, y2: 104 }, reachOf(repaired[0].clip)));
    const deep = comps.map((c, i) => i >= 2 ? { ...c, x1: c.x1 - 30, x2: c.x2 - 30 } : c);
    assert.equal(splitConnectedClusters(deep, parent, W, H, 3), null,
        'sibling ink well inside the child bbox cannot be repaired (fail-safe keeps the whole box)');
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
        const jittered = comps.map((c, i) => i >= 2
            ? { ...c, x1: c.x1 + dx, y1: c.y1 + dy, x2: c.x2 + dx, y2: c.y2 + dy } : c);
        assert.ok(splitConnectedClusters(jittered, parent, W, H, 3), `a ±1px detection jitter (${dx},${dy}) must not resurrect the merge`);
    }
    assert.equal(splitConnectedClusters(comps.map(c => ({ ...c, y2: c.y1 + 6, })), parent, W, H, 3), null,
        'single-line fragments never become regions');
    const softClip = { ...parent, clip: { x1: 15.5, y1: 30.2, x2: 155.8, y2: 130.7 } };
    assert.ok(splitConnectedClusters(comps, softClip, W, H, 3), 'a float parent clip trims frames without failing');
    const tightClip = { ...parent, clip: { x1: 35, y1: 30, x2: 155, y2: 130 } };
    assert.equal(splitConnectedClusters(comps, tightClip, W, H, 3), null,
        'a parent clip tighter than the child ink refuses the split');
});
