import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const compiled = await build({ entryPoints: ['src/content/vlm-annotations.ts'], bundle: true,
    format: 'esm', write: false });
const { planAnnotations, sourceExtras } = await import('data:text/javascript;base64,'
    + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w
    && a.y < b.y + b.h && b.y < a.y + a.h;

function check(plan) {
    const labels = plan.marks.map(({ label }) => ({ x: label.x - label.r - 1,
        y: label.y - label.r - 1, w: (label.r + 1) * 2, h: (label.r + 1) * 2 }));
    for (const label of labels) {
        assert.ok(label.x >= 0 && label.y >= 0 && label.x + label.w <= plan.width
            && label.y + label.h <= plan.height, 'complete label stays inside the image');
        for (const mark of plan.marks) assert.ok(!overlaps(label, mark.text), 'label never covers another text area');
    }
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
        assert.ok(!overlaps(labels[i], labels[j]), 'labels never cover each other');
    }
}

test('VLM annotation frames expand outside text and edge labels never clamp onto it', () => {
    const boxes = [
        { x1: 0, y1: 0, x2: 30, y2: 25, marker: 1 },
        { x1: 170, y1: 270, x2: 200, y2: 300, marker: 12 },
        { x1: 50, y1: 90, x2: 120, y2: 190, marker: 150 },
    ];
    const plan = planAnnotations(boxes, 200, 300, 16);
    check(plan);
    assert.deepEqual(plan.marks.map(mark => mark.marker), [1, 12, 150]);
    for (const { frame, text } of plan.marks) {
        assert.ok(frame.x < text.x && frame.y < text.y);
        assert.ok(frame.x + frame.w > text.x + text.w && frame.y + frame.h > text.y + text.h);
    }
    assert.ok(plan.marks[2].label.r * 2 > 16 * 3 * .6, 'multi-digit label has room for every digit');
});

test('dense annotations get non-overlapping separate-margin labels instead of covering text', () => {
    const boxes = Array.from({ length: 40 }, (_, i) => ({ x1: 0, y1: 0, x2: 80, y2: 80, marker: i + 1 }));
    const plan = planAnnotations(boxes, 80, 80, 16);
    check(plan);
    assert.ok(plan.marks.some(mark => mark.margin));
    for (const mark of plan.marks.filter(mark => mark.margin)) {
        assert.ok(mark.label.x - mark.label.r > plan.content.x + plan.content.w);
    }
});

test('VLM label exclusion holds across deterministic tight and overlapping layouts', () => {
    let seed = 98765;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let sample = 0; sample < 100; sample++) {
        const w = 60 + Math.floor(random() * 700), h = 80 + Math.floor(random() * 900);
        const boxes = Array.from({ length: 1 + Math.floor(random() * 60) }, (_, i) => {
            const x1 = Math.floor(random() * w), y1 = Math.floor(random() * h);
            return { x1, y1, x2: Math.min(w, x1 + 5 + random() * 150),
                y2: Math.min(h, y1 + 5 + random() * 150), marker: i + 101 };
        });
        check(planAnnotations(boxes, w, h, 16));
    }
});

test('extras undo annotation padding and scale, reject margin labels and invalid coordinates', () => {
    const content = { x: 20, y: 30, w: 500, h: 800 };
    const extra = { x1: 70, y1: 110, x2: 170, y2: 270, translation: 'test' };
    assert.deepEqual(sourceExtras([extra], content, 1000, 1600),
        [{ x1: 100, y1: 160, x2: 300, y2: 480, translation: 'test' }]);
    assert.deepEqual(sourceExtras([extra], { x: 0, y: 0, w: 1000, h: 1600 }, 1000, 1600), [extra]);
    assert.deepEqual(sourceExtras([extra], { ...content, w: 0 }, 1000, 1600), []);
    assert.deepEqual(sourceExtras([extra], { ...content, h: NaN }, 1000, 1600), []);
    for (const bad of [{ ...extra, x1: 0 }, { ...extra, y1: 0 }, { ...extra, x2: 600 },
        { ...extra, y2: 850 }, { ...extra, x1: NaN }, { ...extra, x2: 1 }]) {
        assert.deepEqual(sourceExtras([bad], content, 1000, 1600), []);
    }
});
