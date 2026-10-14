import ts from 'typescript';
import { build, transform } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = ts.createSourceFile('page.ts', readFileSync('src/chapter/page.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const functions = source.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['runGroup', 'combinePages', 'commitPage', 'warmPrepared'].includes(node.name?.text));
assert.equal(functions.length, 4);
const compiled = await transform(functions.map(node => node.getText(source)).join('\n'), { loader: 'ts' });
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const attemptBuild = await build({ entryPoints: ['src/chapter/lifecycle.ts'], bundle: true, format: 'esm', write: false });
const { Attempt } = await import('data:text/javascript;base64,' + Buffer.from(attemptBuild.outputFiles[0].text).toString('base64'));

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

function fixture(cached = [], opts = {}) {
    const pages = Array.from({ length: 4 }, (_, order) => ({ id: `p${order}`, order }));
    const pending = pages.map(() => deferred());
    const reply = deferred(), closed = [];
    const requests = [], warms = [], renders = [], cachedCommits = [], failures = [];
    const prepared = pages.map(page => ({ page, item: { id: page.id }, force: false,
        bitmap: { width: 600, height: 800, order: page.order, close() {} },
        det: { boxes: [0, 1].map(i => ({ x1: 10, y1: 20 + i * 40, x2: 100, y2: 50 + i * 40,
            source: `PAGE ${page.order} LINE ${i}` })) },
        identity: {}, hash: `hash-${page.order}`, bytesKey: `bytes-${page.order}`, identityKey: `identity-${page.order}`,
        ...(cached.includes(page.order) ? { out: { outputs: [], extras: [], mentions: [] } } : null) }));
    const scope = { epoch: 1, status: { phase: 'running', pages: prepared.map(p => p.item) },
        config: { pipeline: { textSource: 'ocr', cacheEnabled: false }, cacheEpoch: '', force: undefined },
        cacheCurrent: () => true, cacheReady: async () => '',
        PAGE_LEASE_MS: 300_000, attempts: new Set(),
        pageEpochs: new Map(), contextSharing: new WeakMap(), attemptPages: new WeakMap(),
        releasePrepared: p => p.bitmap.close(),
        Attempt,
        preparePage: page => pending[page.order].promise,
        withPageLease: (_page, _item, valid, run) => run(valid),
        settlePrepared: async (p) => { assert.ok(p.out, 'this fixture must not enter a per-page fallback'); cachedCommits.push({ order: p.page.order, cached: true }); },
        markFailed: async (page, _item, error) => { if (!opts.failure) throw error; failures.push({ order: page.order, kind: error.kind }); },
        step() {}, note() {}, trace: () => undefined, pageStatus: () => () => {}, starveNotice() {},
        recordChapterLog() {}, shiftDetectionBoxY: (box, y) => ({ ...box, y1: box.y1 + y, y2: box.y2 + y }),
        stage: () => {}, publish: async () => {}, contextFor: async () => ({}),
        OffscreenCanvas: class { pages = []; getContext() { return { drawImage: bitmap => this.pages.push(bitmap.order) }; } },
        createImageBitmap: async canvas => ({ pages: canvas.pages, close() { closed.push('combined'); } }),
        translateRegions: async (bitmap, det, _onStatus, translateOpts) => {
            requests.push({ pages: bitmap.pages, sources: det.boxes.map(box => box.source) });
            if (opts.failure) return { error: 'Graphics processing stopped responding', errorKind: 'inference' };
            // The real call fires afterOcr exactly here: OCR done, LLM request about to start.
            translateOpts?.afterOcr?.();
            if (opts.holdReply) await reply.promise;
            return { outputs: det.boxes.map((box, i) => ({ index: i + 1, source: box.source, translation: box.source })),
                extras: [], mentions: [] };
        },
        computeAiPatches: (bitmap, _det, erase, keep) => {
            warms.push({ order: bitmap.order, erase: erase.length, keep: keep.length });
            return Promise.resolve(null);
        },
        inpaintMode: () => opts.inpaint ?? 'local',
        renderPage: async (_ref, prep, _onStatus, _force, renderOpts) => {
            renders.push({ order: prep.bitmap.order, warm: !!renderOpts?.warm,
                paintOnly: renderOpts?.paintOnly === true, detached: renderOpts?.detached === true,
                outputs: prep.cached?.outputs });
            return { translated: `blob:${prep.bitmap.order}` };
        },
        document: { createElement: () => ({}) },
        fetch: async () => ({ blob: async () => ({}) }),
        URL: { revokeObjectURL() {} },
        settingsFingerprint: () => 'fp', packMask: x => x, signatureOf: x => x,
        artifactKey: (a, b) => `${a}:${b}`, signature: () => 'sig',
        writeRecord: async () => {}, cachePutMany: async () => {}, cacheDelete: async () => {},
        PAGE_KEY_GEN: 3, INPAINT_PATCH_GEN: 5, id: 'run',
    };
    runInNewContext(compiled.code, scope);
    const done = scope.runGroup(pages, { pairs: [], characters: [] }, 1, 'epoch');
    return { requests, warms, renders, cachedCommits, failures, done, closed,
        releaseReply: () => reply.resolve(),
        cancelPage(order) {
            scope.pageEpochs.set(pages[order].id, 1);
            prepared[order].item.phase = 'paused';
            for (const attempt of scope.attempts) attempt.cancel();
        },
        pause() { scope.status.phase = 'error'; },
        async finish(order) { pending[order].resolve(prepared[order]); await tick(); } };
}

test('merged OCR requests preserve chapter order when page preparation completes backwards', async () => {
    const f = fixture();
    for (const order of [3, 2, 1, 0]) await f.finish(order);
    await f.done;
    assert.deepEqual(Array.from(f.requests[0].pages), [0, 1, 2, 3]);
    assert.deepEqual(Array.from(f.requests[0].sources), [0, 1, 2, 3].flatMap(page =>
        [0, 1].map(line => `PAGE ${page} LINE ${line}`)));
    assert.deepEqual(f.renders.map(render => render.order), [0, 1, 2, 3]);
    for (const render of f.renders) {
        assert.deepEqual(Array.from(render.outputs, output => output.index), [1, 2]);
        assert.deepEqual(Array.from(render.outputs, output => output.source), [0, 1].map(line => `PAGE ${render.order} LINE ${line}`));
    }
});

test('every merged page starts its cleanup warm before the reply returns', async () => {
    const f = fixture();
    for (const order of [3, 2, 1, 0]) await f.finish(order);
    await f.done;
    assert.deepEqual(f.warms.map(warm => warm.order), [0, 1, 2, 3],
        'the chapter path must overlap AI cleanup with the LLM wait, like a single-page translate');
    assert.ok(f.warms.every(warm => warm.keep === 0 && warm.erase === 2), 'warm covers all boxes; keep filtering happens at commit');
    assert.ok(f.renders.every(render => render.warm && render.paintOnly && render.detached),
        'commit reuses the precomputed cleanup warm');
});

test('cached OCR pages publish immediately while the remaining merged pages retain chapter order', async () => {
    const f = fixture([1]);
    await f.finish(1);
    assert.deepEqual(f.cachedCommits, [{ order: 1, cached: true }]);
    assert.equal(f.requests.length, 0, 'cached page must not wait for the pending pages');
    for (const order of [3, 2, 0]) await f.finish(order);
    await f.done;
    assert.deepEqual(Array.from(f.requests[0].pages), [0, 2, 3]);
    assert.deepEqual(f.warms.map(warm => warm.order), [0, 2, 3], 'only pages that need the LLM warm their cleanup');
    assert.deepEqual(f.renders.map(render => render.order), [0, 2, 3]);
});

test('built-in fill skips the cleanup warm entirely', async () => {
    const f = fixture([], { inpaint: 'fill' });
    for (const order of [3, 2, 1, 0]) await f.finish(order);
    await f.done;
    assert.deepEqual(f.warms, [], 'fill mode must not run the cleanup model');
    assert.ok(f.renders.every(render => render.warm === false));
});

test('a shared GPU failure never retries the merged pages individually', async () => {
    const f = fixture([], { failure: true });
    for (const order of [3, 2, 1, 0]) await f.finish(order);
    await f.done;
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.failures, [0, 1, 2, 3].map(order => ({ order, kind: 'inference' })));
    assert.deepEqual(f.renders, []);
    assert.deepEqual(f.cachedCommits, []);
});

test('a slot finishing preparation after another slot paused the run cannot start an LLM request', async () => {
    const f = fixture(); f.pause();
    for (const order of [3, 2, 1, 0]) await f.finish(order);
    await f.done;
    assert.deepEqual(f.requests, []); assert.deepEqual(f.renders, []); assert.deepEqual(f.warms, []);
});

test('cancelling a merged page does not retry it and retains combined pixels until the late call settles', async () => {
    const f = fixture([], { holdReply: true });
    try {
        for (const order of [3, 2, 1, 0]) await f.finish(order);
        assert.equal(f.requests.length, 1);
        f.cancelPage(1); await f.done;
        assert.deepEqual(f.renders, []); assert.deepEqual(f.closed, []);
        f.releaseReply(); await tick();
        assert.deepEqual(f.closed, ['combined']); assert.equal(f.requests.length, 1);
    } finally { f.releaseReply(); }
});
