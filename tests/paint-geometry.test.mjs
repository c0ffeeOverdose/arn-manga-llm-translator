import { build, transform } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const built = await build({ stdin: { contents: "export * from './src/content/render.ts'; export * from './src/content/inpaint.ts';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'esm', write: false, define: { __BUILD_ID__: '"geometry-test"' } });
const helpers = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const source = ts.createSourceFile('pipeline.ts', readFileSync('src/content/pipeline.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'paintRegions');
const compiled = await transform(fn.getText(source).replace(/^export\s+/, ''), { loader: 'ts' });
const scope = { ...helpers, isDebug: () => false, console };
runInNewContext(compiled.code, scope);
const { paintRegions } = scope;
const { prepareRegion } = helpers;

function fixture() {
    const W = 100, H = 80, pixels = new Uint8ClampedArray(W * H * 4).fill(255), raw = new Uint8Array(W * H);
    for (const [x1, x2] of [[25, 30], [45, 50]]) for (let y = 25; y < 40; y++) for (let x = x1; x < x2; x++) {
        raw[y * W + x] = 255;
        for (let c = 0; c < 3; c++) pixels[(y * W + x) * 4 + c] = 0;
    }
    const canvas = { width: W, height: H }, fills = [];
    const ctx = { canvas, font: '', save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, strokeText() {},
        measureText(text) {
            const size = parseFloat(this.font), width = [...text].length * size * 0.6;
            return { width, actualBoundingBoxLeft: 1, actualBoundingBoxRight: width - 1,
                actualBoundingBoxAscent: size * 0.9, actualBoundingBoxDescent: size * 0.3 };
        },
        fillText(text, x, y) { fills.push({ text, x, y, font: this.font }); },
        getImageData() { return { width: W, height: H, data: pixels.slice() }; },
        putImageData(image) { pixels.set(image.data); },
        drawImage(_image, x0, y0, w, h) {
            for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
                for (let c = 0; c < 3; c++) pixels[(y * W + x) * 4 + c] = 123;
            }
        },
    };
    canvas.getContext = () => ctx;
    const boxes = [{ x1: 15, y1: 20, x2: 40, y2: 45, conf: 0.9 }, { x1: 40, y1: 20, x2: 65, y2: 45, conf: 0.9 }];
    const det = { boxes, mask: { width: W, height: H, data: raw.buffer }, inferMs: 0, ep: 'test' };
    return { canvas, ctx, frame: ctx.getImageData(), det, pixels, fills, at: (x, y) => pixels[(y * W + x) * 4] };
}

test('planning does not touch pixels and an unplaceable translation never erases its source', t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture(), before = f.pixels.slice(), outputs = [{ index: 1, translation: 'unbreakable'.repeat(100) }];
    assert.equal(prepareRegion(f.ctx, f.frame, f.det.boxes[0], outputs[0].translation, f.det.mask), null);
    assert.deepEqual(f.pixels, before);
    assert.deepEqual(Array.from(paintRegions(f.canvas, f.frame, f.det, outputs)), []);
    assert.deepEqual(f.pixels, before);
    assert.equal(f.fills.length, 0);
});

test('broad warm or scaled patches cannot erase a missing-output neighbour or change surrounding artwork', t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture();
    const layouts = paintRegions(f.canvas, f.frame, f.det, [{ index: 1, translation: 'OK' }],
        [{ x1: 10, y1: 10, x2: 60, y2: 60, bmp: {} }]);
    assert.equal(layouts.length, 1);
    assert.equal(f.at(27, 30), 123, 'accepted source receives cleanup');
    assert.equal(f.at(47, 30), 0, 'unanswered source stays original');
    assert.equal(f.at(12, 12), 255, 'patch rectangle alone does not authorize a change');
    assert.deepEqual(f.fills.map(f => f.text), ['OK']);
});

test('even an available AI patch cannot erase text rejected by layout preflight', t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture(), before = f.pixels.slice();
    paintRegions(f.canvas, f.frame, f.det, [{ index: 1, translation: 'unbreakable'.repeat(100) }],
        [{ x1: 10, y1: 10, x2: 60, y2: 60, bmp: {} }]);
    assert.deepEqual(f.pixels, before);
});
