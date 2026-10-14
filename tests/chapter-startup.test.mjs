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
        export const cacheGet = async () => undefined, cachePut = async () => {}, cachePutMany = async () => {}, cacheDelete = async () => {};
        export const cacheKey = () => 'bytes', pageKey = () => 'page', pageEntryDecision = () => ({ usable: false }), selectCachedPage = () => null;
        export const PAGE_KEY_GEN = 1, INPAINT_PATCH_GEN = 4, settingsFingerprint = () => 'fp', pageHashFromBitmap = () => 'hash';
        export const packMask = x => x, isResumable = () => false, detFromPartial = () => null, detFromCacheEntry = () => null;
        export const cloudSplitFresh = () => true, cacheEntryFresh = () => false, cacheMissReason = () => 'absent';
        export const hashReaderRouting = () => null, hashReaderRoutingUrl = () => undefined, hashReaderUrls = () => null;
    `,
    '../content/queue': `export const keepaliveOpen = () => () => {};`,
    '../debug': `export const initDebug = async () => {}, isDebug = () => fixture.debug === true;`,
    './store': `export const readRecord = key => fixture.read(key); export const writeRecord = (key, value) => fixture.write(key, value);`,
    './protocol': `export const artifactKey = (id, page) => id + page, chapterSignature = () => 'signature';`,
    '../cache/identity': `export const verifyCachedIdentity = () => false;`,
    '../image-identity': `export const identifyBitmap = () => ({}), signatureOf = x => x, verifyGrayIdentity = () => false;`,
    '../content/detection': `export const shiftDetectionBoxY = x => x; export const releaseIdleDetector = () => {}; export const holdInferenceHost = () => () => {};`,
    '../content/inpaint': `export const computeAiPatches = () => null;`,
    './discovery': `export const nextDocument = () => null, chapterImages = () => [], guessNextDocument = () => null, sameChapterDocument = () => false, discoverEnded = () => true;`,
    '../cache-generation': `export const cacheReady = async () => '', cacheCurrent = () => true, assertCacheCurrent = () => {};`,
};
const compiled = await build({ entryPoints: ['src/chapter/page.ts'], bundle: true, format: 'iife', write: false,
    plugins: [{ name: 'runner-boundaries', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'fixture' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }], logLevel: 'silent' });

function deferred() {
    let resolve, reject;
    const promise = new Promise((r, j) => { resolve = r; reject = j; });
    return { promise, resolve, reject };
}
async function until(fn) {
    for (let i = 0; i < 100; i++) {
        if (fn()) return;
        await new Promise(r => setTimeout(r, 1));
    }
    assert.fail('runner did not reach the expected state');
}
function runnerFixture(checkpoint) {
    const load = deferred(), det = deferred(), records = new Map(), publishes = [], contextRequests = [];
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
            if (msg.type === 'mt:chapter-context') { contextRequests.push(msg); return { ok: true, context: { pairs: [], characters: [] } }; }
            throw new Error(`unexpected RPC ${msg.type}`);
        } }, storage: { onChanged: { addListener() {} } } };
    const environment = { fixture, chrome, console, structuredClone, DOMException,
        setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, AbortSignal, AbortController, ArrayBuffer };
    runInNewContext(compiled.outputFiles[0].text, environment);
    return { load, det, config, records, publishes, contextRequests,
        get detects() { return detects; }, get earlyDetects() { return earlyDetects; }, get ready() { return ready; },
        get loadedSettings() { return loadedSettings; },
        get diagnostics() { return environment.__mtLog; },
        enableDebug() { fixture.debug = true; },
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

test('progress publication order continues after restoring a checkpoint', async () => {
    const pages = [{ id: 'p0', order: 0, url: 'https://reader.test/page.png', descramble: false }];
    const progress = { id: 'run', chapter: 'https://reader.test/chapter/123456', sequence: 50, phase: 'stopped',
        done: 0, total: 1, errors: 0, inflight: 0, completeManifest: true, pages: pages.map(p => ({ ...p, phase: 'queued' })) };
    const f = runnerFixture({ config: { pages }, progress });
    try {
        f.load.resolve(); await until(() => f.ready === 1);
        f.command('resume'); f.det.resolve();
        await until(() => f.publishes.at(-1)?.phase === 'complete');
        assert.ok(f.publishes[0].sequence > 50);
        assert.ok(f.publishes.every((p, i) => i === 0 || p.sequence > f.publishes[i - 1].sequence));
    } finally { f.command('stop'); f.det.resolve(); }
});

test('retranslate after Stop processes only the requested page; Resume continues the remaining chapter', async () => {
    const pages = Array.from({ length: 3 }, (_, order) => ({ id: `p${order}`, order, url: `https://reader.test/page-${order}.png`, descramble: false }));
    const progress = { id: 'run', chapter: 'https://reader.test/chapter/123456', phase: 'stopped', done: 1, total: 3,
        errors: 0, inflight: 0, completeManifest: true, pages: pages.map((p, i) => ({ ...p, phase: i === 0 ? 'ready' : 'queued' })) };
    const f = runnerFixture({ config: { pages }, progress });
    try {
        f.load.resolve(); await until(() => f.ready === 1);
        assert.equal(f.detects, 0);
        assert.equal(f.command('retry', { page: 'p0' }).ok, true);
        f.det.resolve();
        await until(() => f.publishes.at(-1)?.phase === 'stopped' && f.detects === 1);
        assert.deepEqual(f.publishes.at(-1).pages.map(p => p.phase), ['ready', 'queued', 'queued']);
        assert.equal(f.records.get('checkpoint:run').config.requestedPages[0], 'p0');
        f.command('resume');
        await until(() => f.publishes.at(-1)?.phase === 'complete');
        assert.equal(f.detects, 3);
        assert.equal(f.publishes.at(-1).done, 3);
    } finally { f.command('stop'); f.load.resolve(); f.det.resolve(); }
});

test('stopping one active page leaves it paused while the other chapter pages finish', async () => {
    const pages = Array.from({ length: 3 }, (_, order) => ({ id: `p${order}`, order, url: `https://reader.test/page-${order}.png`, descramble: false }));
    const progress = { id: 'run', chapter: 'https://reader.test/chapter/123456', phase: 'running', done: 0, total: 3,
        errors: 0, inflight: 0, completeManifest: true, pages: pages.map(p => ({ ...p, phase: 'queued' })) };
    const f = runnerFixture({ config: { pages }, progress });
    try {
        f.load.resolve(); await until(() => f.detects === 1);
        f.command('stop-page', { page: 'p0' });
        await until(() => f.detects === 2);
        f.det.resolve();
        await until(() => f.publishes.at(-1)?.phase === 'stopped');
        assert.deepEqual(f.publishes.at(-1).pages.map(p => p.phase), ['paused', 'ready', 'ready']);
        f.command('resume');
        await until(() => f.publishes.at(-1)?.phase === 'complete');
        assert.equal(f.publishes.at(-1).done, 3);
    } finally { f.command('stop'); f.det.resolve(); }
});

test('a settings change relayed by the broker pauses work and rejects a stale Resume', async () => {
    const f = runnerFixture();
    try {
        f.load.resolve(); await until(() => f.detects === 1);
        f.command('settings-changed');
        await until(() => f.publishes.at(-1)?.phase === 'error');
        assert.equal(f.command('resume').ok, false);
        assert.equal(f.command('retry', { page: 'p0' }).ok, false);
        assert.equal(f.publishes.at(-1).settingsStale, true);
    } finally { f.command('stop'); f.det.resolve(); }
});

test('a late cancellation error after Stop does not report a page failure', async () => {
    const f = runnerFixture();
    try {
        f.load.resolve(); await until(() => f.detects === 1);
        f.enableDebug();
        f.command('stop');
        await until(() => f.publishes.at(-1)?.phase === 'stopped');
        f.det.reject(new DOMException('Translation stopped', 'AbortError'));
        await new Promise(r => setTimeout(r, 10));
        assert.equal(f.publishes.at(-1).errors, 0);
        assert.doesNotMatch(f.diagnostics.join(' | '), /FAIL|AbortError/);
    } finally { f.command('stop'); f.det.resolve(); }
});

test('Context toggles reach the runner and apply to the next work set', async () => {
    const pages = Array.from({ length: 2 }, (_, order) => ({ id: `p${order}`, order, url: `https://reader.test/page-${order}.png`, descramble: false }));
    const progress = { id: 'run', chapter: 'https://reader.test/chapter/123456', phase: 'stopped', done: 0, total: 2,
        errors: 0, inflight: 0, completeManifest: true, pages: pages.map(p => ({ ...p, phase: 'queued' })) };
    const f = runnerFixture({ config: { pages }, progress });
    try {
        f.load.resolve(); await until(() => f.ready === 1);
        f.command('context', { shareContext: true });
        f.command('resume'); await until(() => f.detects === 1);
        assert.equal(f.contextRequests.length, 1);
        f.command('context', { shareContext: false });
        f.det.resolve(); await until(() => f.publishes.at(-1)?.phase === 'complete');
        assert.equal(f.detects, 2); assert.equal(f.contextRequests.length, 1);
        assert.equal(f.records.get('checkpoint:run').config.shareContext, false);
    } finally { f.command('stop'); f.det.resolve(); }
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
    const sourceRouting = { url: 'https://static.img.gallery.example.org/gg.js', sample: 'https://w2.img.gallery.example.org/source.webp',
        refreshed: true, routing: { build: '7654322', shards: '1'.repeat(4096) } };
    const checkpoint = { config: { id: 'run', sourceRouting }, progress: { id: 'run', chapter: 'https://reader.test/chapter/123456',
        phase: 'running', done: 1, total: 1, errors: 0, inflight: 0, completeManifest: true,
        pages: [{ id: 'p0', url: 'https://reader.test/page.png', order: 0, phase: 'ready' }] } };
    const f = runnerFixture(checkpoint);
    try {
        f.load.resolve();
        await until(() => f.publishes.at(-1)?.phase === 'complete');
        assert.equal(f.publishes[0].done, 1, 'initial publication must not erase the checkpoint');
        assert.equal(f.publishes.at(-1).done, 1);
        assert.equal(f.detects, 0, 'a recovered ready page must not repay inference');
        assert.deepEqual(f.records.get('checkpoint:run').config.sourceRouting, sourceRouting, 'startup preserves the spent routing budget and table');
    } finally { f.command('stop'); f.det.resolve(); }
});
