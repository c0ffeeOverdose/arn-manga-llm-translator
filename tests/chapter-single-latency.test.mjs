import ts from 'typescript';
import { transform } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = ts.createSourceFile('page.ts', readFileSync('src/chapter/page.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['translateOrThrow', 'settlePrepared', 'workSingle', 'markFailed', 'warmPrepared'];
const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
const compiled = await transform(functions.map(node => node.getText(source)).join('\n'), { loader: 'ts' });
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function fixture(opts = {}) {
    let resolve, live = true;
    const reply = new Promise(r => { resolve = r; });
    const events = [], failures = [];
    // The runner's bounded auto-retry admission: only deadlined RPCs are page-retryable.
    class FixtureRpcTimeout extends Error {
        constructor() { super('iframe rpc timeout'); this.name = 'InferenceRpcTimeoutError'; }
    }
    const autoRetry = new Set();
    const page = { id: 'page:0', order: 0 }, item = { id: page.id, phase: 'queued' };
    const p = { page, item, bitmap: { close() { events.push('closed'); } }, det: { boxes: [{ x1: 1, y1: 1, x2: 10, y2: 10 }] },
        ...(opts.cached ? { out: { outputs: [], extras: [], mentions: [] } } : {}),
        ...(opts.warm ? { warm: Promise.resolve(null) } : {}) };
    const status = { phase: 'running', pages: [item, { id: 'page:1', phase: 'ready' }, { id: 'page:2', phase: 'queued' }] };
    const scope = {
        epoch: 1, config: { pipeline: {} }, status, cacheCurrent: () => true,
        preparePage: async () => { item.phase = 'translating'; if (opts.pauseAtPrepare) status.phase = 'error'; return p; },
        withPageLease: (_page, _item, _valid, run) => run(() => live),
        translateRegions: async (_bitmap, _det, _onStatus, options) => {
            events.push('ocr');
            if (opts.cancelAtOcr) live = false;
            options.afterOcr?.(); events.push('llm');
            await reply; events.push('reply');
            return { outputs: [], extras: [], mentions: [] };
        },
        computeAiPatches: async (_bitmap, _det, erase, keep) => {
            events.push('warm'); assert.equal(erase.length, 1); assert.equal(keep.length, 0);
            if (opts.warmFails) throw Error('cleanup unavailable');
            return null;
        },
        commitPage: async (prepared, _out, valid) => {
            assert.equal(valid(), true); events.push(prepared.warm ? 'render-warm' : 'render-cold');
            await prepared.warm;
        },
        inpaintMode: () => opts.fill ? 'fill' : 'local',
        step() {}, note() {}, pageStatus: () => () => {}, trace: () => undefined, starveNotice() {},
        InferenceRpcTimeoutError: FixtureRpcTimeout, autoRetry,
        recordChapterLog: (_trace, event) => failures.push(event), chapterLogError: e => ({ reason: e.kind ?? 'timeout' }),
        providerMessage: () => 'Provider paused', publish: async () => {}, console: { warn() {} },
    };
    runInNewContext(compiled.code, scope);
    return { p, status, events, failures, autoRetry, InferenceRpcTimeoutError: FixtureRpcTimeout, resolve: () => resolve(),
        run: () => scope.workSingle(page, {}, 1, 'epoch'),
        fail: (error, valid = () => true) => scope.markFailed(page, item, error, valid) };
}

test('one-page chapter slots start cleanup before the LLM reply and reuse it when rendering', async () => {
    const f = fixture(), done = f.run(); await tick();
    assert.deepEqual(f.events, ['ocr', 'warm', 'llm']);
    f.resolve(); await done;
    assert.deepEqual(f.events, ['ocr', 'warm', 'llm', 'reply', 'render-warm', 'closed']);
});

test('cancelled OCR must not launch cleanup or publish a page', async () => {
    const f = fixture({ cancelAtOcr: true }), done = f.run(); await tick();
    f.resolve(); await done;
    assert.deepEqual(f.events, ['ocr', 'llm', 'reply', 'closed']);
});

test('cached and built-in-fill pages do not launch an AI cleanup warm', async () => {
    const cached = fixture({ cached: true }); await cached.run();
    assert.deepEqual(cached.events, ['render-cold', 'closed']);
    const fill = fixture({ fill: true }), done = fill.run(); await tick(); fill.resolve(); await done;
    assert.deepEqual(fill.events, ['ocr', 'llm', 'reply', 'render-cold', 'closed']);
});

test('per-page fallback reuses an existing warm and a warm failure retains normal render fallback', async () => {
    for (const opts of [{ warm: true }, { warmFails: true }]) {
        const f = fixture(opts), done = f.run(); await tick(); f.resolve(); await done;
        assert.equal(f.events.filter(e => e === 'warm').length, opts.warm ? 0 : 1);
        assert.ok(f.events.includes('render-warm'));
        assert.equal(f.events.at(-1), 'closed');
    }
});

test('a confirmed GPU-wide failure pauses the chapter without discarding ready or queued pages', async () => {
    const f = fixture(); await f.fail(Object.assign(Error('Graphics processing stopped responding — restart your browser'), { kind: 'inference' }));
    assert.equal(f.status.phase, 'error');
    assert.match(f.status.message, /restart your browser/);
    assert.equal(f.status.pages[0].phase, 'failed');
    assert.equal(f.status.pages[1].phase, 'ready');
    assert.equal(f.status.pages[2].phase, 'queued');
});

test('ordinary page timeouts remain page-local and cancelled attempts cannot pause a newer run', async () => {
    const f = fixture(); await f.fail(new f.InferenceRpcTimeoutError());
    assert.equal(f.status.phase, 'running'); assert.equal(f.status.pages[0].phase, 'failed');
    assert.ok(f.autoRetry.has('page:0'), 'a deadlined RPC is admitted to the one bounded retry pass');
    const cancelled = fixture(); await cancelled.fail(Object.assign(Error('GPU stalled'), { kind: 'inference' }), () => false);
    assert.equal(cancelled.status.phase, 'running'); assert.equal(cancelled.status.pages[0].phase, 'queued');
});

test('a browser-wide GPU fault is never a retry candidate and unrelated errors stay out', async () => {
    const wide = fixture(); await wide.fail(Object.assign(Error('Graphics processing stopped responding — restart your browser'), { kind: 'inference' }));
    assert.ok(!wide.autoRetry.has('page:0'), 'a shared unavailable GPU cannot be repaired by re-queueing one page');
    const other = fixture(); await other.fail(Error('provider said no'));
    assert.ok(!other.autoRetry.has('page:0'), 'only deadline-class faults earn the automatic retry');
});

test('a one-page slot finishing preparation after a shared pause returns its page to the queue without buying an answer', async () => {
    const f = fixture({ pauseAtPrepare: true }); await f.run();
    assert.deepEqual(f.events, ['closed']); assert.equal(f.p.item.phase, 'queued');
});
