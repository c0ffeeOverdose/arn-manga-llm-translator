import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

const compiled = await build({ entryPoints: ['src/content/detection.ts'], bundle: true, format: 'iife', globalName: 'api', write: false,
    plugins: [{ name: 'host-boundaries', setup(builder) {
        const stubs = {
            './page-cache': 'export const unpackMask = () => {};',
            '../debug': 'export const isDebug = () => false;',
            './worker-token': 'export const fetchWorkerToken = nonce => fixture.token(nonce);',
            './encode': 'export const canvasJpegB64 = () => {}; export const canvasPngBlob = async () => fixture.encode();',
            '../bg-rpc': 'export const sendToBackground = () => {};',
            '../chapter/log-store': 'export const recordChapterLog = () => {};',
            '../chapter/log': 'export const chapterLogError = () => ({});',
        };
        builder.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'fixture' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }], logLevel: 'silent' });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function host() {
    let now = 0, seq = 0, listener, token = async () => 'secret', encode = async () => new Blob(['png']);
    const timers = new Map(), frames = [], requests = [];
    const scope = {
        fixture: { token: nonce => token(nonce), encode: () => encode() }, Blob, structuredClone, console, performance,
        chrome: { runtime: { getURL: path => 'chrome-extension://fixture/' + path.replace(/^\//, '') } },
        window: { addEventListener(type, fn) { assert.equal(type, 'message'); listener = fn; } },
        document: { createElement() {
            const frame = { style: {}, isConnected: false, contentWindow: { postMessage(message) { requests.push({ frame, message }); } },
                remove() { this.isConnected = false; } };
            frames.push(frame); return frame;
        }, documentElement: { append(frame) { frame.isConnected = true; } } },
        OffscreenCanvas: class {
            getContext() { return { drawImage() {} }; }
            convertToBlob() { return encode(); }
        },
        setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    runInNewContext(compiled.outputFiles[0].text, scope);
    return { api: scope.api, frames, requests, timers,
        setToken(fn) { token = fn; }, setEncode(fn) { encode = fn; },
        setGpu(requestAdapter) { scope.navigator = { gpu: { requestAdapter } }; },
        async advance(ms) {
            now += ms;
            for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn();
            await tick();
        },
        async ready(frame = frames.at(-1)) { await listener({ source: frame.contentWindow, origin: 'chrome-extension://fixture', data: { type: 'mt:ready', nonce: 'nonce' } }); await tick(); },
        async reply(request = requests.at(-1), ok = true) {
            await listener({ source: request.frame.contentWindow, origin: 'chrome-extension://fixture',
                data: { type: 'mt:rpc-result', id: request.message.id, ok, installed: true, error: 'fixture failure' } });
            await tick();
        },
    };
}

test('simultaneous first requests share startup; idle unload clears timers and recreates on demand', async () => {
    const f = host(), a = f.api.baberuInstalled(), b = f.api.baberuInstalled();
    assert.equal(f.frames.length, 1);
    await f.ready(); assert.equal(f.requests.length, 2);
    await f.reply(f.requests[0]); await f.reply(f.requests[1]);
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
    assert.equal(f.timers.size, 1, 'only the idle timer may remain after replies');
    await f.advance(59_999); assert.equal(f.frames[0].isConnected, true);
    await f.advance(1); assert.equal(f.frames[0].isConnected, false);
    assert.equal(f.timers.size, 0);
    const c = f.api.baberuInstalled(); await f.ready(); await f.reply();
    assert.equal(await c, true); assert.equal(f.frames.length, 2);
    f.api.releaseIdleDetector(); assert.equal(f.frames[1].isConnected, false);
});

test('concurrent cold detections share an unauthenticated startup instead of rebuilding it', async () => {
    const f = host();
    const jobs = Array.from({ length: 4 }, () => f.api.detect({ width: 600, height: 800 }));
    const results = Promise.allSettled(jobs);
    assert.equal(f.frames.length, 1, 'all pages must wait for the same starting worker');
    await f.ready();
    for (let i = 0; i < 4 && f.requests.length < 4; i++) await tick();
    assert.equal(f.requests.length, 4);
    assert.ok(f.requests.every(request => request.message.token === 'secret'));
    for (const request of f.requests) await f.reply(request);
    assert.ok((await results).every(result => result.status === 'fulfilled'));
    f.api.releaseIdleDetector();
    assert.equal(f.timers.size, 0);
});

test('detection waits for token lookup already in progress for an OCR request', async () => {
    const f = host(), token = deferred(); f.setToken(() => token.promise);
    const ocr = f.api.baberuInstalled();
    const outcomes = Promise.allSettled([ocr]);
    const ready = f.ready(); await tick();
    const detection = f.api.detect({ width: 600, height: 800 });
    const detected = Promise.allSettled([detection]);
    assert.equal(f.frames.length, 1, 'a connected but not-ready worker is still starting');
    assert.equal(f.requests.length, 0, 'neither request may bypass authentication');
    token.resolve('shared-secret'); await ready; await tick();
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every(request => request.message.token === 'shared-secret'));
    for (const request of f.requests) await f.reply(request);
    assert.ok((await outcomes).every(result => result.status === 'fulfilled'));
    assert.ok((await detected).every(result => result.status === 'fulfilled'));
    f.api.releaseIdleDetector();
});

test('a completed but missing-token handshake still triggers one shared authenticated rebuild', async () => {
    const f = host(); f.setToken(async () => null);
    const jobs = [f.api.detect({ width: 600, height: 800 }), f.api.detect({ width: 600, height: 800 })];
    const results = Promise.allSettled(jobs);
    await f.ready();
    assert.equal(f.frames.length, 2, 'failed authentication still needs one replacement');
    assert.equal(f.requests.length, 0, 'no inference may run with a missing token');
    f.setToken(async () => 'healed-secret'); await f.ready(); await tick();
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every(request => request.message.token === 'healed-secret'));
    for (const request of f.requests) await f.reply(request);
    assert.ok((await results).every(result => result.status === 'fulfilled'));
    f.api.releaseIdleDetector();
});

test('explicit release waits for work and a new request cancels a pending idle timer', async () => {
    const f = host(), first = f.api.baberuInstalled(); await f.ready();
    f.api.releaseIdleDetector(); await f.advance(60_000);
    assert.equal(f.frames[0].isConnected, true, 'an active RPC must retain its host');
    await f.reply(); await first;
    assert.equal(f.frames[0].isConnected, false, 'last reply satisfies explicit release');
    const second = f.api.baberuInstalled(); await f.ready(); await f.reply(); await second;
    await f.advance(59_000);
    const third = f.api.baberuInstalled(); await tick();
    await f.advance(2_000); assert.equal(f.frames[1].isConnected, true);
    await f.reply(); await third; f.api.releaseIdleDetector();
});

test('a run hold keeps the inference host alive across idle waits and drops with the run', async () => {
    const f = host();
    const releaseHold = f.api.holdInferenceHost();
    const job = f.api.baberuInstalled(); await f.ready(); await f.reply(); await job;
    await f.advance(120_000);
    assert.equal(f.frames[0].isConnected, true, 'a held host must not pay a cold reload for the next page');
    f.api.releaseIdleDetector();
    assert.equal(f.frames[0].isConnected, true, 'an explicit release must respect the active run');
    releaseHold();
    assert.equal(f.frames[0].isConnected, false, 'dropping the last user after an explicit release disposes now');

    const next = f.api.baberuInstalled(); await f.ready(); await f.reply(); await next;
    const releaseHold2 = f.api.holdInferenceHost();
    await f.advance(70_000);
    assert.equal(f.frames[1].isConnected, true, 'the hold also cancels a pending idle timer');
    releaseHold2();
    await f.advance(59_000); assert.equal(f.frames[1].isConnected, true, 'the normal idle delay applies again');
    await f.advance(2_000); assert.equal(f.frames[1].isConnected, false);
});

test('the inference host remains retained during image encoding before the RPC starts', async () => {
    const f = host(), encoding = deferred(); f.setEncode(() => encoding.promise);
    const job = f.api.detect({ width: 600, height: 800 }); await f.ready();
    f.api.releaseIdleDetector(); await f.advance(60_000);
    assert.equal(f.frames[0].isConnected, true); assert.equal(f.requests.length, 0);
    encoding.resolve(new Blob(['png'])); await tick(); await f.reply(); await job;
    assert.equal(f.frames[0].isConnected, false);
});

test('stale readiness cannot authenticate a replacement frame', async () => {
    const f = host(), staleToken = deferred(); f.setToken(() => staleToken.promise);
    const first = f.api.ensureDetector(), failure = assert.rejects(first, /timeout/);
    const staleReady = f.ready(); await f.advance(30_000); await failure;
    f.setToken(async () => 'new-secret');
    const second = f.api.baberuInstalled(); await f.ready();
    staleToken.resolve('old-secret'); await staleReady;
    assert.equal(f.requests.at(-1).message.token, 'new-secret');
    await f.reply(); assert.equal(await second, true); f.api.releaseIdleDetector();
});

test('RPC timeout tears down the computing host and rejects every outstanding call', async () => {
    const f = host(), a = f.api.baberuInstalled(), b = f.api.baberuInstalled();
    const failures = Promise.all([assert.rejects(a, /rpc timeout/), assert.rejects(b, /rpc timeout/)]);
    await f.ready(); await f.advance(180_000); await failures;
    assert.equal(f.frames[0].isConnected, false);
    const retry = f.api.baberuInstalled(); await f.ready(); await f.reply();
    assert.equal(await retry, true); f.api.releaseIdleDetector(); assert.equal(f.timers.size, 0);
});

test('a browser-wide GPU stall is diagnosed once after the computing host is destroyed', async () => {
    const f = host(); let probes = 0;
    f.setGpu(() => { probes++; return new Promise(() => {}); });
    const a = f.api.baberuInstalled(), b = f.api.baberuInstalled();
    const outcomes = Promise.all([a.catch(e => e), b.catch(e => e)]);
    await f.ready(); await f.advance(180_000);
    assert.equal(f.frames[0].isConnected, false, 'the expired worker must not keep computing during diagnosis');
    assert.equal(probes, 1, 'concurrent failed RPCs share a single bounded GPU probe');
    await f.advance(10_000);
    const errors = await outcomes;
    assert.ok(errors.every(e => e.kind === 'inference'), 'an unresponsive browser GPU is a shared failure, not a bad page');
    assert.ok(errors.every(e => /restart.*browser/i.test(e.message)));
    f.api.releaseIdleDetector(); assert.equal(f.timers.size, 0);
});

test('a responsive GPU leaves an ordinary RPC timeout recoverable and clears the probe deadline', async () => {
    const f = host(); let probes = 0;
    f.setGpu(async () => { probes++; return {}; });
    const job = f.api.baberuInstalled(), error = job.catch(e => e);
    await f.ready(); await f.advance(180_000);
    const failed = await error;
    assert.match(failed.message, /iframe rpc timeout/);
    assert.notEqual(failed.kind, 'inference', 'a page/worker timeout alone must not halt the chapter');
    assert.equal(probes, 1);
    const retry = f.api.baberuInstalled(); await f.ready(); await f.reply();
    assert.equal(await retry, true);
    f.api.releaseIdleDetector(); assert.equal(f.timers.size, 0);
});

test('failed replies clear deadlines and release the idle host', async () => {
    const f = host(), job = f.api.baberuInstalled(), failure = assert.rejects(job, /fixture failure/);
    await f.ready(); await f.reply(undefined, false); await failure;
    assert.equal(f.timers.size, 1); f.api.releaseIdleDetector(); assert.equal(f.timers.size, 0);
});

test('null or rejected adapter replies do not misclassify a local worker timeout as a GPU-wide stall', async () => {
    for (const requestAdapter of [async () => null, async () => { throw Error('adapter unavailable'); }]) {
        const f = host(); f.setGpu(requestAdapter);
        const job = f.api.baberuInstalled(), error = job.catch(e => e);
        await f.ready(); await f.advance(180_000);
        const failed = await error;
        assert.match(failed.message, /iframe rpc timeout/);
        assert.notEqual(failed.kind, 'inference');
        f.api.releaseIdleDetector(); assert.equal(f.timers.size, 0);
    }
});
