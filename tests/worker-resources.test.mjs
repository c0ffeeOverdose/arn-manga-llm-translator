import ts from 'typescript';
import { transform } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = ts.createSourceFile('worker.ts', readFileSync('src/iframe/worker.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['runDetect', 'runPanels', 'runBaberu', 'runInpaint', 'nms', 'nearMisses', 'baberuLastLogits'];
const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(functions.length, names.length);
const compiled = await transform(functions.map(fn => fn.getText(source)).join('\n'), { loader: 'ts' });

function fixture({ tiles = [], inferFails = false, drawFails = false, canvasFails = false } = {}) {
    const bitmaps = [], canvases = [], fullFrame = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
    let imageDataCopies = 0;
    class OffscreenCanvas {
        constructor(width, height) {
            if (canvasFails) throw Error('canvas allocation failed');
            this.width = width; this.height = height; canvases.push(this);
        }
        getContext() {
            return {
                drawImage(bitmap) {
                    if (drawFails) throw Error('draw failed');
                    if (bitmap.closed) throw Error('closed image used');
                },
                getImageData: (x, y, width, height) => width === 8 && height === 8
                    ? fullFrame : { width, height, data: new Uint8ClampedArray(width * height * 4) },
            };
        }
    }
    const infer = async () => { if (inferFails) throw Error('inference failed'); };
    const scope = { Blob, performance, OffscreenCanvas,
        ImageData: class { constructor() { imageDataCopies++; } },
        async createImageBitmap(source) {
            const bitmap = { width: source.width ?? 8, height: source.height ?? 8, closed: 0, close() { this.closed++; } };
            bitmaps.push(bitmap); return bitmap;
        },
        ensureSession: async () => {}, ensurePanelSession: async () => true, ensureBaberu: async () => {}, ensureInpaintSession: async () => {},
        withInferLock: fn => fn(),
        async inferOnce(bitmap) {
            await infer();
            return { boxes: [], confs: [], lowBoxes: [], lowConfs: [], prob: new Float32Array(bitmap.width * bitmap.height), inferMs: 1 };
        },
        splitTiles: () => tiles, mergeTileBoxes: () => [], groupMaskComponents: () => [], splitMergedBoxes: boxes => boxes,
        MASK_THR: 0.3, NMS_THR: 0.35, sessionInitMs: 0, sessionEp: 'test',
        PANEL_INPUT: 640, panelSession: { async run() { await infer(); return { output0: { data: new Float32Array() } }; } },
        parsePanelOutput: () => ({ panels: [], dropped: [] }),
        ort: { Tensor: class { constructor(type, data, dims) { this.data = data; this.dims = dims; } } },
        BABERU_MEAN: [0.485, 0.456, 0.406], BABERU_STD: [0.229, 0.224, 0.225], BABERU_PRESENT_OUT: [], BABERU_PAST_IN: [],
        baberuVocab: { bos: 0, eos: 1 }, baberuMs: 0,
        baberuSessions: {
            vis: { async run() { await infer(); return { vision_embeds: { cpuData: new Float32Array([1]), dims: [1, 1, 1] } }; } },
            pre: { async run() { return { logits: { data: new Float32Array([0, 1]), dims: [1, 1, 2] } }; } },
            stp: { async run() { throw Error('unexpected decoder step'); } },
        },
        INPAINT_SIZE: 512,
    };
    runInNewContext(compiled.code, scope);
    return { ...scope, bitmaps, canvases, get imageDataCopies() { return imageDataCopies; } };
}
const png = new ArrayBuffer(1);

for (const inferFails of [false, true]) test(`detect closes its decoded source on ${inferFails ? 'inference failure' : 'success'}`, async () => {
    const f = fixture({ inferFails });
    const result = f.runDetect(png, 0.2, 1);
    if (inferFails) await assert.rejects(result, /inference failed/);
    else assert.equal((await result).mask.data.byteLength, 64);
    assert.equal(f.bitmaps.length, 1); assert.equal(f.bitmaps[0].closed, 1);
});

for (const inferFails of [false, true]) test(`tiled detect closes every owned bitmap on ${inferFails ? 'failure' : 'success'}`, async () => {
    const f = fixture({ inferFails, tiles: [{ x0: 0, y0: 0, w: 8, h: 4 }, { x0: 0, y0: 4, w: 8, h: 4 }] });
    const result = f.runDetect(png, 0.2, 1);
    if (inferFails) await assert.rejects(result, /inference failed/);
    else await result;
    assert.equal(f.bitmaps.length, inferFails ? 2 : 3);
    assert.ok(f.bitmaps.every(bitmap => bitmap.closed === 1));
});

for (const name of ['runPanels', 'runBaberu']) {
    for (const inferFails of [false, true]) test(`${name} releases input before ${inferFails ? 'failed' : 'successful'} inference`, async () => {
        const f = fixture({ inferFails });
        const result = f[name](png, 0.2);
        if (inferFails) await assert.rejects(result, /inference failed/);
        else await result;
        assert.equal(f.bitmaps[0].closed, 1);
    });
    test(`${name} releases input if canvas drawing throws`, async () => {
        const f = fixture({ drawFails: true });
        await assert.rejects(f[name](png, 0.2), /draw failed/);
        assert.equal(f.bitmaps[0].closed, 1);
    });
}

test('inpaint uses the existing page readback instead of another full-page RGBA allocation', async () => {
    const f = fixture();
    const result = await f.runInpaint(png, new Uint8Array(64), [], 0.1);
    assert.equal(result.patches.length, 0); assert.equal(result.windows, 0);
    assert.equal(f.imageDataCopies, 0); assert.equal(f.bitmaps[0].closed, 1);
});

test('inpaint closes input if canvas drawing throws', async () => {
    const f = fixture({ drawFails: true });
    await assert.rejects(f.runInpaint(png, new Uint8Array(64), [], 0.1), /draw failed/);
    assert.equal(f.bitmaps[0].closed, 1);
});

for (const name of ['runDetect', 'runPanels', 'runBaberu', 'runInpaint']) test(`${name} closes input if canvas allocation fails`, async () => {
    const f = fixture({ canvasFails: true, tiles: [{ x0: 0, y0: 0, w: 8, h: 4 }] });
    const result = name === 'runInpaint' ? f[name](png, new Uint8Array(64), [], 0.1) : f[name](png, 0.2, 1);
    await assert.rejects(result, /canvas allocation failed/);
    assert.equal(f.bitmaps[0].closed, 1);
});
