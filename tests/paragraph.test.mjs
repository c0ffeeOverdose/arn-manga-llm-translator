import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const compiled = await build({ entryPoints: ['src/content/render.ts'], bundle: true, format: 'esm', write: false });
const { mergeParagraphLines } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].contents).toString('base64'));

function fixture({ separate = false, open = false, tone = 255 } = {}) {
    const width = 220, height = 260;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const pixel = (x, y, value) => {
        const at = (y * width + x) * 4;
        data[at] = data[at + 1] = data[at + 2] = value;
    };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixel(x, y, tone);
    if (!open) {
        for (let y = 30; y <= 230; y++) for (const x of [40, 180]) pixel(x, y, 255 - tone);
        for (let x = 40; x <= 180; x++) for (const y of [30, 230, ...(separate ? [110, 170] : [])]) pixel(x, y, 255 - tone);
    }
    const mask = { width, height, data: new Uint8Array(width * height).buffer };
    const boxes = [70, 125, 180].map((y, i) => ({ x1: 70, y1: y, x2: 140 + i * 2, y2: y + 40, conf: 0.9,
        sib: 4, cutAxis: 'y', clip: { x1: 65, y1: i === 0 ? 65 : y - 15, x2: 150, y2: i === 2 ? 225 : y + 45 } }));
    return { frame: { width, height, data }, mask, boxes };
}

test('three paragraph lines reunite before OCR and lose their internal split clips', () => {
    for (const tone of [255, 0]) {
        const { frame, mask, boxes } = fixture({ tone });
        let reads = 0;
        const out = mergeParagraphLines(boxes, () => { reads++; return frame; }, mask);
        assert.deepEqual(out, [{ x1: 65, y1: 65, x2: 150, y2: 225, conf: 0.9 }]);
        assert.equal(reads, 1);
        assert.ok(boxes.every(b => b.clip && b.sib === 4));
    }
});

test('similarly aligned lines in separate balloons keep their boundaries', () => {
    const { frame, mask, boxes } = fixture({ separate: true });
    assert.strictEqual(mergeParagraphLines(boxes, () => frame, mask), boxes);
});

test('open background cannot provide balloon evidence', () => {
    const { frame, mask, boxes } = fixture({ open: true });
    assert.strictEqual(mergeParagraphLines(boxes, () => frame, mask), boxes);
});

test('missing pixels or wrong-sized mask keeps the original split', () => {
    const { frame, mask, boxes } = fixture();
    assert.strictEqual(mergeParagraphLines(boxes, () => { throw Error('unavailable'); }, mask), boxes);
    assert.strictEqual(mergeParagraphLines(boxes, () => frame, { ...mask, width: frame.width - 1 }), boxes);
    assert.strictEqual(mergeParagraphLines(boxes, () => frame), boxes);
});

test('unrelated boxes, pairs, vertical columns, distinct parent clips and offset lobes do not read pixels', () => {
    const { mask, boxes } = fixture();
    const skip = () => assert.fail('no paragraph candidate');
    for (const input of [boxes.slice(0, 2), boxes.map(b => ({ ...b, sib: undefined })), boxes.map(b => ({ ...b, cutAxis: 'x' })),
        boxes.map((b, i) => ({ ...b, clip: { ...b.clip, x1: b.clip.x1 + i } })),
        boxes.map((b, i) => ({ ...b, x1: b.x1 + i * 30, x2: b.x2 + i * 30 }))]) {
        assert.strictEqual(mergeParagraphLines(input, skip, mask), input);
    }
});
