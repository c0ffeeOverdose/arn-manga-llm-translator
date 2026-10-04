import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const built = await build({
    entryPoints: ['src/content/render.ts'], bundle: true, format: 'cjs',
    write: false, treeShaking: true,
});
let allocated = [];
const watch = (Ctor) => new Proxy(Ctor, {
    construct(target, args) {
        const array = new target(...args);
        if (typeof args[0] === 'number') allocated.push(array.byteLength);
        return array;
    },
});
const module = { exports: {} };
new Function('module', 'exports', 'Uint8Array', 'Int16Array', built.outputFiles[0].text)(
    module, module.exports, watch(Uint8Array), watch(Int16Array),
);
const { expandCropToInk, bubbleArea } = module.exports;

function page(width, height) {
    return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}
function ink(img, x1, y1, x2, y2) {
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
        const i = (y * img.width + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
    }
}

test('crop connectivity scratch stays local on a large page with identical region pixels', () => {
    const box = { x1: 108, y1: 30, x2: 211, y2: 151, conf: 0.9 };
    const rect = { x: 96, y: 18, w: 127, h: 145 };
    const results = [];
    for (const [w, h] of [[400, 300], [2000, 3000]]) {
        const img = page(w, h);
        ink(img, 100, 60, 140, 120);
        ink(img, 195, 20, 235, 48);
        allocated = [];
        results.push(expandCropToInk(img, box, rect));
        assert.ok(allocated.length >= 2, 'fixture exercises the connectivity walk');
        assert.ok(Math.max(...allocated) < 150000, 'scratch follows the crop window, not page dimensions');
    }
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[1], { x: 96, y: 18, w: 143, h: 145 });
});

test('layout flood scratch stays local and preserves its region on a large page', () => {
    const box = { x1: 100, y1: 80, x2: 180, y2: 120, conf: 0.9 };
    const results = [];
    for (const [w, h] of [[400, 300], [2000, 3000]]) {
        const img = page(w, h);
        allocated = [];
        results.push(bubbleArea(img, box));
        assert.ok(allocated.length, 'fixture exercises the interior flood');
        assert.ok(Math.max(...allocated) < 20000, 'visited storage follows the flood window');
    }
    assert.deepEqual(results[0], results[1]);
});

test('a clipped flood retains a seed outside its window without page-sized storage', () => {
    const img = page(2000, 3000);
    const box = { x1: 100, y1: 80, x2: 180, y2: 120, conf: 0.9,
        clip: { x1: 150, y1: 60, x2: 200, y2: 150 }, cutAxis: 'x' };
    allocated = [];
    const area = bubbleArea(img, box);
    const small = { ...img, width: 400, height: 300, data: page(400, 300).data };
    assert.deepEqual(area, bubbleArea(small, box));
    assert.ok(Math.max(...allocated) < 20000);
});
