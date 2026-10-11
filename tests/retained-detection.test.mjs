import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const compiled = await build({ entryPoints: ['src/content/retained-detection.ts'], bundle: true, format: 'esm', write: false });
const { retainDetection, restoreDetection } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
function detection(w, h, data) {
    return { boxes: [{ x1: 1, y1: 1, x2: w, y2: h, conf: 1, clip: { x1: 1, y1: 1, x2: w, y2: h } }],
        mask: { width: w, height: h, data }, panels: [], inferMs: 1, ep: 'cloud', splitGen: 11, cloudTexts: ['source'] };
}

test('retained masks restore exact binary pixels across rows and partial bytes', () => {
    for (const [w, h] of [[1, 1], [3, 5], [256, 257]]) {
        const src = Uint8Array.from({ length: w * h }, (_, i) => i % 3 ? 0 : 255);
        const det = detection(w, h, src.buffer), stored = retainDetection(det);
        assert.equal(stored.mask.encoding, 'bits');
        assert.equal(stored.mask.bytes.byteLength, Math.ceil(w * h / 8));
        assert.equal('data' in stored.mask, false, 'retained state cannot accidentally retain a decoded mask');
        assert.deepEqual(restoreDetection(stored), det);
        const restored = new Uint8Array(restoreDetection(stored).mask.data); restored.fill(0);
        assert.deepEqual(restoreDetection(stored), det, 'a caller cannot mutate retained pixels');
        src.fill(0); assert.equal(new Uint8Array(restoreDetection(stored).mask.data)[0], 255);
    }
});

test('non-binary masks use an exact independent raw copy', () => {
    const src = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const det = detection(3, 2, src.buffer), stored = retainDetection(det);
    assert.equal(stored.mask.encoding, 'raw'); assert.deepEqual(restoreDetection(stored), det);
    src.fill(0); assert.deepEqual([...new Uint8Array(restoreDetection(stored).mask.data)], [0, 1, 127, 128, 254, 255]);
});

test('36 retained full-size binary masks occupy one eighth of their decoded storage', () => {
    const w = 2000, h = 3000, src = new Uint8Array(w * h); src.fill(255, 4000, 8000);
    const stored = Array.from({ length: 36 }, () => retainDetection(detection(w, h, src.buffer)));
    assert.equal(stored.reduce((sum, det) => sum + det.mask.bytes.byteLength, 0), 27_000_000);
    const last = new Uint8Array(restoreDetection(stored.at(-1)).mask.data);
    assert.deepEqual(last, src);
});
