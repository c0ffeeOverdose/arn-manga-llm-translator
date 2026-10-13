import ts from 'typescript';
import { transform } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = ts.createSourceFile('ocr.ts', readFileSync('src/content/ocr.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = new Set(['confPill', 'renderDebugView', 'ensurePageDebugViews']);
const compiled = await transform(source.statements.filter(n => ts.isFunctionDeclaration(n) && names.has(n.name?.text))
    .map(n => n.getText(source).replace(/^export\s+/, '')).join('\n'), { loader: 'ts' });

function fixture() {
    const measurements = [], canvases = [], decoded = [];
    const bitmap = tone => ({ width:100, height:120, tone, closes:0, close() { this.closes++; } });
    const original = bitmap(7), translated = bitmap(230);
    const scope = {
        OffscreenCanvas: class {
            constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
            getContext() {
                const canvas = this;
                return { drawImage(image) { canvas.tone = image.tone; },
                    getImageData() { return { width:canvas.width, height:canvas.height, tone:canvas.tone }; },
                    measureText() { return { width:10 }; },
                    strokeRect() { canvas.tone = 99; }, fillRect() {}, fillText() {},
                    save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {} };
            }
            async convertToBlob() { return {}; }
        },
        effBoxesForAreas(_ctx, frame, boxes, textFor) {
            assert.equal(textFor(1), 'Translated');
            measurements.push({ phase:'effective', tone:frame.tone });
            return boxes.map(b => ({ ...b, clip:{x1:20,y1:20,x2:70,y2:90} }));
        },
        chosenOrientation: () => false,
        pageArea(_ctx, frame, box) {
            assert.equal(box.clip.x1, 20, 'debug applies the same divider clips as paint');
            measurements.push({ phase:'area', tone:frame.tone });
            return { x:22,y:24,w:25,h:30 };
        },
        drawBadge() {}, debugWork:new WeakMap(),
        cacheGeneration: () => 'epoch', cacheCurrent: () => true, restoreDetection: d => d, panelRanks: () => [],
        pages:new Map(), isDebug: () => false, console:{warn() {}},
        URL:{ createObjectURL: () => `blob:fixture-${scope.urls++}`, revokeObjectURL() {} }, urls:0,
        async savedOriginal() { scope.loads++; const image = bitmap(7); decoded.push(image); return image; }, loads:0,
        async fetchBitmap() { const image = bitmap(230); decoded.push(image); return { bitmap:image }; },
    };
    runInNewContext(compiled.code, scope);
    const boxes = [{ x1:30,y1:30,x2:50,y2:60,conf:.9 }];
    const outputs = [{ index:1, translation:'Translated' }];
    const state = () => ({ orig:'https://reader.test/original.png', translated:'blob:fixture-paint',
        det:{ boxes,panels:[],mask:{width:100,height:120,data:new ArrayBuffer(12000)} }, outputs });
    return { scope, bitmap, original, translated, boxes, outputs, state, measurements, canvases, decoded };
}

test('both debug backgrounds measure original pixels before overlays and apply placement divider clips', async () => {
    const f = fixture();
    await f.scope.renderDebugView(f.original, f.boxes, f.boxes, [], f.boxes, [], f.outputs);
    await f.scope.renderDebugView(f.translated, f.boxes, f.boxes, [], f.boxes, [], f.outputs, undefined, f.original);
    assert.equal(f.measurements.length, 4);
    assert.ok(f.measurements.every(m => m.tone === 7));
    assert.ok(f.canvases.every(c => c.width === 0 && c.height === 0));
    assert.equal(f.original.closes, 0); assert.equal(f.translated.closes, 0);
});

test('debug generation borrows supplied images and decodes an owned original only once for both views', async () => {
    const borrowed = fixture(), state = borrowed.state();
    await borrowed.scope.ensurePageDebugViews(state, borrowed.original, borrowed.translated);
    assert.ok(state.debug && state.debugOrig);
    assert.equal(borrowed.scope.loads, 0);
    assert.equal(borrowed.original.closes, 0); assert.equal(borrowed.translated.closes, 0);
    const owned = fixture(), cached = owned.state();
    await owned.scope.ensurePageDebugViews(cached);
    assert.ok(cached.debug && cached.debugOrig);
    assert.equal(owned.scope.loads, 1);
    assert.equal(owned.decoded.length, 2);
    assert.ok(owned.decoded.every(image => image.closes === 1));
    assert.ok(owned.measurements.every(m => m.tone === 7));
});

test('an unavailable debug original does not fail the translated page', async () => {
    const f = fixture(), state = f.state();
    f.scope.savedOriginal = async () => { throw Error('Original unavailable'); };
    await f.scope.ensurePageDebugViews(state);
    assert.equal(state.debug, undefined); assert.equal(state.debugOrig, undefined);
    assert.equal(f.scope.debugWork.has(state), false);
});
