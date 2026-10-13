import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const compiled = await build({ stdin: { contents: `
    export { attachModelBalloons, modelBalloonSurface, balloonRow } from './src/content/model-balloon';
    export { layoutArea, setRenderTuning } from './src/content/render';
    export { partialEntry, detFromPartial, resizeCachedPage } from './src/cache/policy';
    export { encodeCache, decodeCache } from './src/cache/wire';
    export { retainDetection, restoreDetection } from './src/content/retained-detection';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', write: false });
const { attachModelBalloons, modelBalloonSurface, balloonRow, layoutArea,
    partialEntry, detFromPartial, resizeCachedPage, encodeCache, decodeCache, retainDetection, restoreDetection } = await import(
    'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].contents).toString('base64'));

function fixture(W = 200, H = 200) {
    return { image: { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) },
        mask: { width: W, height: H, data: new ArrayBuffer(W * H) } };
}
function text(f, box) {
    const mask = new Uint8Array(f.mask.data), { width: W, data } = f.image;
    for (let y = Math.ceil(box.y1) + 3; y < Math.floor(box.y2) - 2; y += 6) {
        for (let yy = y; yy < y + 3; yy++) for (let x = Math.ceil(box.x1) + 2; x < Math.floor(box.x2) - 2; x++) {
            mask[yy * W + x] = 255; data.fill(0, (yy * W + x) * 4, (yy * W + x) * 4 + 3);
        }
    }
}
function shape(W = 200, H = 200, x1 = 20, y1 = 20, x2 = 180, y2 = 180) {
    return { width: W, height: H, x1, y1, x2, y2, conf: .9, rows: Array.from({ length: y2 - y1 }, () => [x1, x2]) };
}

test('a model balloon expands a tiny source region without changing its crop or erase mask', () => {
    const f = fixture(), box = { x1: 85.2, y1: 80.4, x2: 115.8, y2: 110.6, conf: .9 };
    text(f, box); const before = new Uint8Array(f.mask.data).slice();
    const [attached] = attachModelBalloons([box], [shape()], f.mask);
    assert.equal(attached.balloon.conf, .9);
    assert.deepEqual([attached.x1,attached.y1,attached.x2,attached.y2], [box.x1,box.y1,box.x2,box.y2]);
    const area = layoutArea(f.image, attached, false, f.mask);
    assert.equal(area.why, 'model-balloon'); assert.ok(area.runs && area.w > 4 * (box.x2 - box.x1));
    assert.deepEqual(new Uint8Array(f.mask.data), before);
});

test('model geometry preserves holes and cannot cross a pixel divider outside the source text', () => {
    const f = fixture(), box = { x1: 35, y1: 75, x2: 65, y2: 105, conf: .9 };
    text(f, box);
    for (let y = 20; y < 180; y++) f.image.data.fill(0, (y * 200 + 100) * 4, (y * 200 + 100) * 4 + 3);
    const [attached] = attachModelBalloons([box], [shape()], f.mask);
    assert.ok(modelBalloonSurface(f.image, attached, f.mask).x2 <= 100);
    const split = shape(); split.rows = split.rows.map(() => [20,80,120,180]);
    const [left] = attachModelBalloons([box], [split], f.mask);
    assert.ok(modelBalloonSurface(f.image, left, f.mask).x2 <= 80);
});

test('sparse ink in a loose text box still uses its supported model balloon', () => {
    const f = fixture(), box = { x1:30, y1:30, x2:170, y2:170, conf:.9 };
    text(f, {x1:90,y1:90,x2:110,y2:110});
    const [attached] = attachModelBalloons([box], [shape()], f.mask);
    const area = layoutArea(f.image, attached, false, f.mask);
    assert.equal(area.why, 'model-balloon');
    assert.ok(area.runs && area.w >= 150 && area.h >= 150);
});

test('shared balloon instances partition placement without overlapping or cutting source ink', () => {
    const f = fixture(), boxes = [{ x1: 90, y1: 50, x2: 130, y2: 100.6, conf: .9 },
        { x1: 60, y1: 100.2, x2: 100, y2: 151, conf: .9 }];
    boxes.forEach(b => text(f, b));
    const attached = attachModelBalloons(boxes, [shape()], f.mask);
    assert.ok(attached.every(b => b.balloon));
    for (let y = 0; y < 200; y++) {
        const a = balloonRow(attached[0].balloon,y,200,200), b = balloonRow(attached[1].balloon,y,200,200);
        for (let x = 0; x < 200; x++) {
            const inside = spans => spans.some((lo,i) => i % 2 === 0 && x >= lo && x < spans[i + 1]);
            assert.ok(!(inside(a) && inside(b)));
        }
    }
});

test('unknown and empty model regions use the existing physical-image path', () => {
    const f = fixture(), box = { x1: 80, y1: 80, x2: 120, y2: 120, conf: .9 }; text(f,box);
    const missed = shape(200,200,150,150,180,180);
    const [same] = attachModelBalloons([box],[missed],f.mask);
    assert.equal(same,box); assert.equal(modelBalloonSurface(f.image,same,f.mask),null);
    assert.equal(modelBalloonSurface(f.image,{...box,balloon:shape()},undefined),null);
});

test('balloon placement survives JSON cache transport, partial resume and exact mask retention', () => {
    const f = fixture(), box = { x1: 80, y1: 80, x2: 120, y2: 120, conf: .9 }; text(f,box);
    const boxes = attachModelBalloons([box],[shape()],f.mask);
    const det = { boxes, panels:[], mask:f.mask, ep:'webgpu', inferMs:0 };
    const partial = partialEntry('chapter#hash','model-fp',det,200,200);
    const restored = detFromPartial(decodeCache(JSON.parse(JSON.stringify(encodeCache(partial)))),200,200);
    assert.deepEqual(restored.boxes[0].balloon,boxes[0].balloon);
    assert.deepEqual(restoreDetection(retainDetection(det)).boxes,boxes);
    const resized = resizeCachedPage({ ...partial, atime:0 },400,400);
    const larger = fixture(400,400); text(larger,resized.boxes[0]);
    const surface = modelBalloonSurface(larger.image,resized.boxes[0],larger.mask);
    assert.ok(surface && surface.x1 >= 40 && surface.x2 <= 360 && surface.y1 >= 40 && surface.y2 <= 360);
});
