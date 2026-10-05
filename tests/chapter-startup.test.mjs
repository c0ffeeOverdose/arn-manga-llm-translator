import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

const stubs = {
    '../content/state': `
        export const loadPipeline = settings => fixture.load(settings);
        export const configureChapterHost = (...args) => fixture.configure(...args);
        export const setShareContext = () => {};
    `,
    '../content/page-io': `export const fetchBitmap = () => fixture.source(); export const unscrambleTiles = () => null;`,
    '../content/pipeline': `export const resolveHeadlessDet = () => fixture.detect();`,
    '../content/ocr': `export const translateRegions = () => { throw Error('unexpected LLM'); }; export const abortLiveRpcs = () => {};`,
    '../content/render-page': `export const renderPage = () => { throw Error('unexpected render'); };`,
    '../content/page-cache': `
        export const cacheGet = async () => undefined, cachePut = async () => {}, cacheDelete = async () => {};
        export const cacheKey = () => 'bytes', pageKey = () => 'page', pageEntryDecision = () => ({ usable: false });
        export const PAGE_KEY_GEN = 1, settingsFingerprint = () => 'fp', pageHashFromBitmap = () => 'hash';
        export const packMask = x => x, isResumable = () => false, detFromPartial = () => null, detFromCacheEntry = () => null;
        export const cloudSplitFresh = () => true;
    `,
    '../content/queue': `export const keepaliveOpen = () => () => {};`,
    '../debug': `export const initDebug = async () => {}, isDebug = () => false;`,
    './store': `export const readRecord = key => fixture.read(key); export const writeRecord = (key, value) => fixture.write(key, value);`,
    './protocol': `export const artifactKey = (id, page) => id + page, chapterSignature = () => 'signature';`,
    '../image-identity': `export const identifyBitmap = () => ({}), signatureOf = x => x;`,
    '../content/detection': `export const shiftDetectionBoxY = x => x;`,
    './discovery': `export const nextDocument = () => null, chapterImages = () => [], guessNextDocument = () => null, sameChapterDocument = () => false, discoverEnded = () => true;`,
    '../cache-generation': `export const cacheReady = async () => '', cacheCurrent = () => true, assertCacheCurrent = () => {};`,
};
const compiled = await build({ entryPoints: ['src/chapter/page.ts'], bundle: true, format: 'iife', write: false,
    plugins: [{ name: 'runner-boundaries', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'fixture' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }], logLevel: 'silent' });

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}
async function until(fn) {
    for (let i = 0; i < 100; i++) {
        if (fn()) return;
        await new Promise(r => setTimeout(r, 1));
    }
    assert.fail('runner did not reach the expected state');
}
function runnerFixture(checkpoint) {
    const load = deferred(), det = deferred(), records = new Map(), publishes = [];
    if (checkpoint) records.set('checkpoint:run', checkpoint);
    let listener, configured = false, detects = 0, earlyDetects = 0, ready = 0, loadedSettings;
    const config = { id: 'run', chapter: 'https://reader.test/chapter/123456', readerTab: 1, bookKey: 'book', cacheEpoch: '',
        shareContext: false, completeManifest: true, context: { pairs: [], characters: [] },
        pipeline: { inferEngine: 'cloud', parallelLlm: 1, mergePages: 1, cacheEnabled: false },
        pages: [{ id: 'p0', url: 'https://reader.test/page.png', order: 0, descramble: false }] };
    const fixture = {
        async load(settings) { loadedSettings = settings; await load.promise; },
        configure() { configured = true; },
        source: async () => ({ bitmap: { width: 600, height: 800, close() {} } }),
        async detect() {
            detects++; if (!configured) earlyDetects++;
            await det.promise;
            return { det: { boxes: [], mask: { width: 600, height: 800, data: new ArrayBuffer(0) } } };
        },
        read: async key => records.get(key),
        write: async (key, value) => { records.set(key, structuredClone(value)); },
    };
    const chrome = { runtime: { id: 'extension', onMessage: { addListener: fn => { listener = fn; } },
        async sendMessage(msg) {
            if (msg.type === 'mt:chapter-runner-boot') return { id: 'run' };
            if (msg.type === 'mt:chapter-host-init') return { ok: true, config: structuredClone(config) };
            if (msg.type === 'mt:chapter-runner-ready') { ready++; return { ok: true }; }
            if (msg.type === 'mt:chapter-publish') { publishes.push(structuredClone(msg.status)); return { ok: true }; }
            throw new Error(`unexpected RPC ${msg.type}`);
        } }, storage: { onChanged: { addListener() {} } } };
    runInNewContext(compiled.outputFiles[0].text, { fixture, chrome, console, structuredClone, DOMException,
        setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, AbortSignal, ArrayBuffer });
    return { load, det, config, records, publishes,
        get detects() { return detects; }, get earlyDetects() { return earlyDetects; }, get ready() { return ready; },
        get loadedSettings() { return loadedSettings; },
        command(command, extra = {}) {
            let response;
            listener({ type: 'mt:chapter-command', id: 'run', command, ...extra }, { id: 'extension' }, r => { response = r; });
            return response;
        },
    };
}

test('priority during slow setup cannot start inference or echo unchanged progress', async () => {
    const f = runnerFixture();
    try {
        await until(() => f.publishes.length > 0);
        const before = f.publishes.length;
        for (let i = 0; i < 20; i++) assert.equal(f.command('prioritize', { page: 'p0' }).ok, true);
        await new Promise(r => setTimeout(r, 10));
        assert.equal(f.detects, 0, 'setup must finish before any page starts');
        assert.equal(f.publishes.length, before, 'priority is a scheduling hint, not a progress change');
        assert.equal(f.ready, 0, 'obtaining config is not readiness');
        f.load.resolve();
        await until(() => f.detects === 1);
        assert.equal(f.earlyDetects, 0);
        assert.equal(f.ready, 1);
        assert.equal(f.loadedSettings.inferEngine, 'cloud', 'use the captured run settings, not defaults or a second storage read');
        const runningPublishes = f.publishes.length;
        for (let i = 0; i < 20; i++) f.command('prioritize', { page: 'p0' });
        await new Promise(r => setTimeout(r, 10));
        assert.equal(f.publishes.length, runningPublishes, 'an active page must not feed a publish/priority loop');
        f.det.resolve();
        await until(() => f.publishes.at(-1)?.phase === 'complete');
        assert.equal(f.publishes.at(-1).done, 1);
    } finally { f.command('stop'); f.load.resolve(); f.det.resolve(); }
});

test('Stop during setup prevents page work when setup later completes', async () => {
    const f = runnerFixture();
    try {
        await until(() => f.publishes.length > 0);
        f.command('stop');
        f.load.resolve();
        await until(() => f.ready === 1);
        assert.equal(f.detects, 0);
        assert.equal(f.publishes.at(-1).phase, 'stopped');
    } finally { f.command('stop'); f.load.resolve(); f.det.resolve(); }
});

test('startup reads the existing checkpoint before publishing and preserves ready pages', async () => {
    const checkpoint = { config: { id: 'run' }, progress: { id: 'run', chapter: 'https://reader.test/chapter/123456',
        phase: 'running', done: 1, total: 1, errors: 0, inflight: 0, completeManifest: true,
        pages: [{ id: 'p0', url: 'https://reader.test/page.png', order: 0, phase: 'ready' }] } };
    const f = runnerFixture(checkpoint);
    try {
        f.load.resolve();
        await until(() => f.publishes.at(-1)?.phase === 'complete');
        assert.equal(f.publishes[0].done, 1, 'initial publication must not erase the checkpoint');
        assert.equal(f.publishes.at(-1).done, 1);
        assert.equal(f.detects, 0, 'a recovered ready page must not repay inference');
    } finally { f.command('stop'); f.det.resolve(); }
});
