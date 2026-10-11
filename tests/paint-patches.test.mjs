import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

const built = await build({ entryPoints: ['src/content/paint-patches.ts'], bundle: true, format: 'cjs', write: false });
const tick = () => new Promise(resolve => setImmediate(resolve));
const patch = n => ({ x1: n, y1: 0, x2: n + 1, y2: 1, png: new ArrayBuffer(1) });
function fixture(decode, fallback) {
    const urls = new Set(), images = [], timers = new Set(), module = { exports: {} };
    let closed = 0, nextUrl = 0;
    class Image {
        src = '';
        constructor() { images.push(this); }
        decode() { return decode(images.indexOf(this)); }
        removeAttribute() { this.src = ''; }
    }
    runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, Image, Blob,
        URL: { createObjectURL() { const url = String(nextUrl++); urls.add(url); return url; }, revokeObjectURL: url => urls.delete(url) },
        async createImageBitmap() { await fallback?.(); return { close() { closed++; } }; },
        setTimeout(fn) { const timer = { fn }; timers.add(timer); return timer; }, clearTimeout: timer => timers.delete(timer),
    });
    return { ...module.exports, urls, images, timers, get closed() { return closed; } };
}

test('decoded patches preserve order and release URLs and image decoders after painting', async () => {
    const f = fixture(async () => {});
    const patches = await f.decodePaintPatches([patch(2), patch(1)]);
    assert.deepEqual(Array.from(patches, p => p.x1), [2, 1]);
    assert.equal(f.urls.size, 2); assert.equal(f.timers.size, 0);
    for (const p of patches) { p.dispose(); p.dispose(); }
    assert.equal(f.urls.size, 0); assert.ok(f.images.every(image => image.src === ''));
});

test('bitmap fallback is closed after painting', async () => {
    const f = fixture(async () => { throw Error('image blocked'); });
    const patches = await f.decodePaintPatches([patch(1)]);
    assert.equal(f.closed, 0); patches[0].dispose(); patches[0].dispose();
    assert.equal(f.closed, 1); assert.equal(f.urls.size, 0);
});

test('stalled image decode falls back and releases its decoder and timeout', async () => {
    const f = fixture(() => new Promise(() => {}));
    const pending = f.decodePaintPatches([patch(1)]);
    assert.equal(f.timers.size, 1); for (const t of f.timers) t.fn();
    const patches = await pending;
    assert.equal(f.images[0].src, ''); assert.equal(f.timers.size, 0);
    patches[0].dispose(); assert.equal(f.closed, 1); assert.equal(f.urls.size, 0);
});

test('failed batch releases both already-decoded patches and late successes', async () => {
    let finishLate;
    const f = fixture(n => n === 0 ? Promise.resolve() : n === 1 ? Promise.reject(Error('decode failed'))
        : new Promise(resolve => { finishLate = resolve; }), async () => { throw Error('bitmap failed'); });
    await assert.rejects(f.decodePaintPatches([patch(0), patch(1), patch(2)]), /bitmap failed/);
    assert.equal(f.urls.size, 1, 'only the still-pending decode may retain its URL');
    finishLate(); await tick();
    assert.equal(f.urls.size, 0); assert.equal(f.timers.size, 0);
    assert.ok(f.images.every(image => image.src === ''));
});
