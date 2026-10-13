import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const compiled = await build({ entryPoints: ['src/content/inpaint.ts'], bundle: true, format: 'esm', write: false,
    plugins: [{ name: 'clean-backend', setup(builder) {
        builder.onLoad({ filter: /\/src\/content\/detection\.ts$/ }, () => ({ loader: 'ts', contents:
            'export const SPLIT_CLIP_SLACK = 12; export const inpaintPage = (...args) => globalThis.__geometryCleanup(...args);' }));
    } }] });
const { computeAiPatches } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

test('single-flight cleanup shares one source/mask/ownership plan but never another page or clip', async () => {
    const calls = [];
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    globalThis.__geometryCleanup = async (bitmap, boxes, mask) => {
        calls.push({ bitmap, boxes, mask });
        await barrier;
        return { patches: [{ i: 0, png: new ArrayBuffer(1) }], windows: 1, ms: 1, lockWaitMs: 0, encodeMs: 0 };
    };
    const bitmap = { width: 40, height: 40 }, other = { ...bitmap };
    const box = { x1: 10, y1: 10, x2: 20, y2: 20, conf: 0.9 };
    const mask = new Uint8Array(1600); mask[15 * 40 + 15] = 255;
    const det = { boxes: [box], mask: { width: 40, height: 40, data: mask.buffer } };
    try {
        const one = computeAiPatches(bitmap, det, [box], []), same = computeAiPatches(bitmap, det, [box], []);
        assert.equal(calls.length, 1);
        const another = computeAiPatches(other, det, [box], []);
        assert.equal(calls.length, 2);
        const clipped = computeAiPatches(bitmap, det, [{ ...box, clip: { x1: 0, y1: 0, x2: 18, y2: 40 }, cutAxis: 'x' }], []);
        assert.equal(calls.length, 3);
        const changedMask = computeAiPatches(bitmap, { ...det, mask: { ...det.mask, data: mask.slice().buffer } }, [box], []);
        assert.equal(calls.length, 4);
        release();
        await Promise.all([one, same, another, clipped, changedMask]);
    } finally { release(); delete globalThis.__geometryCleanup; }
});
