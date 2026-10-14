import ts from 'typescript';
import { transform } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = ts.createSourceFile('ocr.ts', readFileSync('src/content/ocr.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'translateRegions');
const compiled = await transform(fn.getText(source).replace(/^export\s+/, ''), { loader: 'ts' });

async function fixture(cancelAt, options = {}) {
    let valid = true, requests = 0, warms = 0;
    const payloads = [];
    const timers = new Set();
    const scope = {
        PageTimer: class { meta = {}; setStage() {} add() {} measureAsync(_key, run) { return run(); } },
        pipeline: { textSource: 'ocr', useOcrModel: false, useContext: true, useCharacters: true }, context: {}, shareContext: false, EMPTY_CONTEXT: {}, llmChunkSize: null,
        cacheReady: async () => 'epoch', assertCacheCurrent() {},
        loadContext: async () => { if (cancelAt === 'ocr') valid = false; },
        pageImageData: async () => ({}),
        balloonHint: () => 'unknown',
        resolveMangaId: async () => { if (cancelAt === 'payload') valid = false; return 'story'; }, bookKey: () => 'book',
        regionChunks: regions => [regions], sourceExtras: extras => extras, recordChapterLog() {},
        liveRpcs: new Set(), isDebug: () => false, performance, Date,
        checkCancelled: signal => signal?.throwIfAborted(), DOMException,
        setInterval(fn) { timers.add(fn); return fn; }, clearInterval(id) { timers.delete(id); },
        setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(id) { timers.delete(id); },
        console: { warn() {}, log() {} },
        chrome: { runtime: { connect() {
            let reply;
            return { onMessage: { addListener(fn) { reply = fn; } }, onDisconnect: { addListener() {} }, disconnect() {},
                postMessage(payload) { payloads.push(payload); requests++; reply({ ok: true, outputs: [{ index: 1, translation: 'translated' }], extras: [], mentions: [] }); } };
        } } },
    };
    runInNewContext(compiled.code, scope);
    const result = await scope.translateRegions({ width: 600, height: 800 }, { boxes: [{}], cloudTexts: ['SOURCE'] }, () => {},
        { fold: false, valid: () => valid, afterOcr: () => { warms++; }, ...options });
    return { result, requests, warms, payloads, timers: timers.size, liveRpcs: scope.liveRpcs.size };
}

test('a chapter paused during OCR cannot start cleanup or a paid translation request', async () => {
    const f = await fixture('ocr');
    assert.equal(f.requests, 0); assert.equal(f.warms, 0); assert.equal(f.result.errorKind, 'abort');
    assert.equal(f.timers, 0); assert.equal(f.liveRpcs, 0);
});

test('a chapter paused during async request setup cannot dispatch the prepared payload', async () => {
    const f = await fixture('payload');
    assert.equal(f.requests, 0); assert.equal(f.warms, 1); assert.equal(f.result.errorKind, 'abort');
    assert.equal(f.timers, 0); assert.equal(f.liveRpcs, 0);
});

test('valid work still reaches the provider and clears its timers and RPC handle', async () => {
    const f = await fixture();
    assert.equal(f.requests, 1); assert.equal(f.warms, 1); assert.equal(f.result.usedLLM, true);
    assert.equal(f.timers, 0); assert.equal(f.liveRpcs, 0);
});

test('a chapter request retains its captured context policy when the reader toggle changes', async () => {
    const context = { pairs: [{ source: 'before', translation: 'translated' }], characters: [] };
    const sharing = await fixture(undefined, { shareContext: true, context });
    assert.deepEqual(sharing.payloads[0].context, context);
    const standalone = await fixture(undefined, { shareContext: false, context });
    assert.deepEqual(Object.keys(standalone.payloads[0].context), []);
});
