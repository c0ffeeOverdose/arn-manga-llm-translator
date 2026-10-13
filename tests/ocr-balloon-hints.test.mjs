import ts from 'typescript';
import { build, transform } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const output = await build({ stdin: { contents: "export * from './src/content/render'; export * from './src/content/page-cache';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', write: false });
const helpers = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
const source = ts.createSourceFile('ocr.ts', readFileSync('src/content/ocr.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'translateRegions');
const compiled = await transform(fn.getText(source).replace(/^export\s+/, ''), { loader: 'ts' });

function page() {
    const width = 400, height = 200, data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const radius = Math.hypot(x - 100, y - 100);
        const text = ((x >= 90 && x < 120) || (x >= 290 && x < 320)) && ((y >= 92 && y < 96) || (y >= 102 && y < 106));
        if ((radius <= 45 && radius >= 41) || text) {
            const i = (y * width + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }
    return { width, height, data };
}

async function fixture({ chunkSize = null, disconnect = false, cloud = true, starve = false, split = false } = {}) {
    const image = page(), requests = [], timers = new Set();
    const boxes = [0, 200].map(dx => ({ x1: 85 + dx, y1: 88, x2: 125 + dx, y2: 112, conf: 0.9 }));
    const det = { boxes, mask: { width: image.width, height: image.height, data: new ArrayBuffer(image.width * image.height) },
        ...(cloud ? { cloudTexts: ['OH!', 'RUSTLE'] } : {}) };
    const response = payload => starve && requests.length === 1 ? { ok: false, kind: 'parse', error: 'empty' }
        : { ok: true, outputs: payload.regions.map(region => ({ index: region.index, translation: region.source })), extras: [], mentions: [] };
    const scope = {
        ...helpers, performance, Date, crypto,
        PageTimer: class { meta = {}; setStage() {} add() {} measureAsync(_key, run) { return run(); } },
        pipeline: { textSource: split ? 'crops' : 'ocr', ocrEngine: 'baberu', useOcrModel: split },
        context: {}, shareContext: false, EMPTY_CONTEXT: {}, llmChunkSize: chunkSize,
        cacheReady: async () => 'epoch', assertCacheCurrent() {}, loadContext: async () => {},
        pageImageData: async () => image,
        baberuInstalled: async () => true, baberuOcrAll: async () => ({ texts: ['OH!', 'RUSTLE'], lockWaitMs: 0 }),
        cropRegion: async () => 'crop', pageIsGrayscale: () => false,
        resolveMangaId: async () => 'story', bookKey: () => 'book', sourceExtras: extras => extras, recordChapterLog() {},
        liveRpcs: new Set(), isDebug: () => false, console: { warn() {}, log() {} },
        setInterval(fn) { timers.add(fn); return fn; }, clearInterval(id) { timers.delete(id); },
        setTimeout(fn, ms) { if (ms < 100000) { fn(); return null; } timers.add(fn); return fn; }, clearTimeout(id) { timers.delete(id); },
        sendToBackground: async payload => { requests.push(structuredClone(payload)); return response(payload); },
        chrome: { runtime: { connect() {
            let reply, dropped;
            return { onMessage: { addListener(fn) { reply = fn; } }, onDisconnect: { addListener(fn) { dropped = fn; } }, disconnect() {},
                postMessage(payload) {
                    requests.push(structuredClone(payload));
                    if (disconnect) {
                        if (split) reply({ type: 'mt:ocr-texts', texts: ['OH!', 'RUSTLE'] });
                        dropped();
                    } else reply(response(payload));
                } };
        } } },
    };
    runInNewContext(compiled.code, scope);
    const result = await scope.translateRegions({ width: image.width, height: image.height }, det, () => {}, { fold: false, checkpoint: false });
    assert.equal(result.usedLLM, true, result.error);
    assert.equal(timers.size, 0);
    assert.equal(scope.liveRpcs.size, 0);
    return { result: JSON.parse(JSON.stringify(result)), requests };
}

for (const cloud of [true, false]) test(`${cloud ? 'Cloud' : 'local'} OCR attaches each original region's own evidence without extra images or calls`, async () => {
    const { requests } = await fixture({ cloud });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].regions.map(region => region.balloonHint), ['detected', 'unknown']);
    assert.equal(requests[0].imagesB64, undefined);
    assert.equal(requests[0].vision, false);
    assert.equal(requests[0].ocr, true);
});

test('chunk renumbering keeps balloon evidence attached to its own text and restores output indices', async () => {
    const { requests, result } = await fixture({ chunkSize: 1 });
    assert.deepEqual(requests.map(request => request.regions.map(region => [region.index, region.source, region.balloonHint])),
        [[[1, 'OH!', 'detected']], [[1, 'RUSTLE', 'unknown']]]);
    assert.deepEqual(result.outputs.map(output => output.index), [1, 2]);
});

test('a disconnected background re-send preserves the same per-region evidence', async () => {
    const { requests } = await fixture({ disconnect: true });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].regions, requests[0].regions);
    assert.deepEqual(requests[1].regions.map(region => region.balloonHint), ['detected', 'unknown']);
});

test('starvation splits retain each region hint while retrying with local indices', async () => {
    const { requests, result } = await fixture({ starve: true });
    assert.deepEqual(requests.map(request => request.regions.map(region => region.balloonHint)),
        [['detected', 'unknown'], ['detected'], ['unknown']]);
    assert.deepEqual(result.outputs.map(output => output.index), [1, 2]);
});

test('paid split transcripts can re-send as text-only without losing balloon evidence', async () => {
    const { requests } = await fixture({ split: true, cloud: false, disconnect: true });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].vision, true);
    assert.deepEqual(requests[1].regions.map(region => [region.source, region.balloonHint]), [['OH!', 'detected'], ['RUSTLE', 'unknown']]);
    assert.equal(requests[1].imagesB64, undefined);
    assert.equal(requests[1].vision, false);
    assert.equal(requests[1].ocr, true);
});

test('split transcription replaces source text without losing region evidence or mapping', async () => {
    const source = ts.createSourceFile('background.ts', readFileSync('src/background/background.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    let assignment;
    const visit = node => {
        if (ts.isBinaryExpression(node) && node.left.getText(source) === 'regions2' && node.right.getText(source).startsWith('msg.regions.map')) assignment = node;
        ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(assignment, 'actual split transcription assignment exists');
    const compiled = await transform('let regions2; ' + assignment.getText(source) + '; globalThis.actual = regions2;', { loader: 'ts' });
    const regions = [{ index: 1, source: '', balloonHint: 'detected', page: 2, marker: 7 }, { index: 2, source: '', balloonHint: 'unknown' }];
    const scope = { msg: { regions }, t: { sources: new Map([[1, 'OH!'], [2, 'RUSTLE']]) } };
    runInNewContext(compiled.code, scope);
    assert.deepEqual(JSON.parse(JSON.stringify(scope.actual)), regions.map((region, i) => ({ ...region, source: i ? 'RUSTLE' : 'OH!' })));
});
