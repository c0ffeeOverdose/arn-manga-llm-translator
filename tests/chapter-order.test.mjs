import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bitmap, grayPage, imageRef, installCanvas } from './helpers/image-fixture.mjs';

const stubs = {
    state: `export const pipeline = {}; export const context = {}; export const shareContext = false;
        export const pages = new Map(); export const elStates = new WeakMap(); export const retiredBlobs = new Map(); export const overlayChoice = 'auto';
        export const chapterKey = () => globalThis.fixture.chapter ?? 'chapter:test'; export const stateFor = ref => fixture.states.get(ref.el);
        export const bookKey = () => 'book'; export const loadContext = async () => {}; export const loadPipeline = async () => {};
        export const regPage = state => globalThis.fixture.paints.push(state);
        export const unregPage = () => {}; export const setOverlayChoice = () => {}; export const setOverlayOn = () => {};
        export const acceptChapterContext = () => {};`,
    'page-io': `export const getPages = () => globalThis.fixture.live;
        export const refKey = ref => ref.el.currentSrc || ref.el.src || ref.key;
        export const fetchBitmap = async () => { throw new Error('No network'); };
        export const unscrambleTiles = async () => null; export const ownOriginalUrl = async () => undefined;
        export const episodeManifestSrcs = () => null; export const fetchPagedUrls = async () => [];
        export const pagedTierAlternates = () => [];
        export const galleryManifestJson = async () => null; export const collectUnloadedUrls = () => [];
        export const hashReaderManifest = async () => null;
        export const bitmapBlank = async () => false;
        export const writePage = (ref, state) => { fixture.states.set(ref.el, state); };`,
    queue: `export const viewportOverlap = ref => fixture.hidden.has(ref.el) ? 0 : 1; export const dropAutoQueued = () => {};
        export const resumeAuto = () => {}; export const isBusy = () => false; export const paintBusy = () => false;
        export const haltAuto = () => {};`,
    auto: `export const lookaheadActive = () => false;`,
    'status-ui': `export const setActivity = () => {}; export const removeActivity = () => {};
        export const lastMsgSet = () => {}; export const renderStatus = () => {}; export const pillUnDismiss = () => {};
        export const logError = async () => {};`,
    protocol: `export const chapterSignature = () => 'test:signature';`,
    store: `export const blobDataUrl = async () => '';`,
    discovery: `export const nextDocument = () => undefined; export const guessNextDocument = () => undefined; export const hasNextPage = () => false;`,
    debug: `export const isDebug = () => false;`,
    ocr: `export const ensurePageDebugViews = async () => {};`,
};
await build({ entryPoints: ['src/content/sweep.ts'], bundle: true, format: 'esm', outfile: '.test-build/chapter-order.mjs',
    plugins: [{ name: 'reader-fixture', setup(build) {
        build.onResolve({ filter: /./ }, args => {
            const name = args.path.split('/').at(-1);
            if (name in stubs) return { path: name, namespace: 'fixture' };
        });
        build.onLoad({ filter: /./, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }));
        build.onLoad({ filter: /src\/content\/sweep\.ts$/ }, args => ({ loader: 'ts', contents:
            readFileSync(args.path, 'utf8') + '\nexport const testProgress = p => { progress = p; evidence.clear(); imageAliases.clear(); };\nexport { attach as testAttach, preloadNextPages as testPreload };\nexport { settingsFingerprint } from \'./page-cache\';' }));
    } }] });
await build({ entryPoints: ['src/image-identity.ts'], bundle: true, format: 'esm', outfile: '.test-build/chapter-order-image.mjs' });
const { identifyBitmap, signatureOf } = await import('../.test-build/chapter-order-image.mjs');
const { testProgress, resolveChapterRef, elementMap, testAttach, testPreload, idlePageOrder, settingsFingerprint } = await import('../.test-build/chapter-order.mjs');

beforeEach(() => {
    installCanvas();
    globalThis.fixture = { live: [], artifacts: new Map(), paints: [], states: new WeakMap(), hidden: new Set(), onResult: undefined };
    globalThis.document = { hidden: false, querySelectorAll: () => fixture.live.map(r => r.el) };
    globalThis.chrome = { runtime: { sendMessage: async msg => {
        if (fixture.onResult) await fixture.onResult(msg);
        return { result: fixture.artifacts.get(msg.page) };
    } } };
    const pages = [1, 2, 3, 4, 5, 6].map(order => {
        const identity = identifyBitmap(bitmap(grayPage(order)), [{ x1: 10, y1: 10, x2: 200, y2: 200 }]);
        fixture.artifacts.set(`p${order}`, { identity, signature: 'test:signature' });
        return { id: `p${order}`, url: `https://cdn.test/${order}.png`, order, phase: 'ready', revision: 1, image: signatureOf(identity) };
    });
    testProgress({ id: crypto.randomUUID(), chapter: 'chapter:test', phase: 'complete', pages });
});

function readyArtifact(n) {
    return { ...fixture.artifacts.get(`p${n}`), hash: `hash${n}`,
        image: 'data:image/png;base64,AA==',
        entry: { key: `k${n}`, fp: settingsFingerprint({}), w: 600, h: 800,
            boxes: [{ x1: 10, y1: 10, x2: 200, y2: 200 }], panels: [],
            outputs: [{ index: 1, translation: `page ${n}` }], extras: [] },
        mask: { w: 1, h: 1, data: 'data:application/octet-stream;base64,AA==' } };
}

test('preloaded opaque neighbours prepare only the next two verified chapter pages', async () => {
    fixture.live = [1, 2, 3, 4].map(n => imageRef(`blob:preload-${n}`, bitmap(grayPage(n))));
    fixture.hidden = new Set(fixture.live.slice(1).map(ref => ref.el));
    for (const n of [2, 3, 4]) fixture.artifacts.set(`p${n}`, readyArtifact(n));
    let requests = 0;
    fixture.onResult = () => { requests++; };
    await testPreload({ id: 'p1', order: 1 });
    assert.deepEqual(fixture.paints.map(s => s.outputs[0].translation), ['page 2', 'page 3']);
    assert.equal(fixture.states.has(fixture.live[0].el), false, 'the viewed page keeps its own attachment');
    assert.equal(fixture.states.has(fixture.live[3].el), false, 'pages beyond the lookahead stay untouched');
    const before = requests;
    await testPreload({ id: 'p1', order: 1 });
    assert.equal(requests, before, 'unchanged preloaded views must not fetch or paint again');
});

test('a hidden neighbour cannot borrow the viewed page number when pixels do not match', async () => {
    fixture.chapter = 'https://reader.test/chapter/uuid';
    globalThis.location = { origin: 'https://reader.test', pathname: '/chapter/uuid/2', search: '', hash: '' };
    const identity = identifyBitmap(bitmap(grayPage(2)), [{ x1: 10, y1: 10, x2: 200, y2: 200 }]);
    testProgress({ id: 'hidden', chapter: fixture.chapter, completeManifest: true,
        pages: [{ id: 'p2', url: 'https://cdn.test/2.png', order: 1, phase: 'ready', revision: 1, image: signatureOf(identity) }] });
    fixture.artifacts.set('p2', { ...readyArtifact(2), identity });
    fixture.live = [imageRef('blob:other-page', bitmap(grayPage(5)))];
    fixture.hidden.add(fixture.live[0].el);
    await testPreload({ id: 'p1', order: 0 });
    assert.deepEqual(fixture.paints, []);
});

test('a preloaded image recycled during verification cannot receive the late artifact', async () => {
    const ref = imageRef('blob:preload-before', bitmap(grayPage(2)));
    fixture.live = [ref]; fixture.hidden.add(ref.el);
    fixture.artifacts.set('p2', readyArtifact(2));
    fixture.onResult = () => {
        ref.el.src = ref.el.currentSrc = 'blob:preload-after';
        ref.el.pixels = bitmap(grayPage(5));
    };
    await testPreload({ id: 'p1', order: 1 });
    assert.deepEqual(fixture.paints, []);
    assert.equal(ref.el.src, 'blob:preload-after');
    fixture.onResult = undefined;
    fixture.artifacts.set('p3', readyArtifact(3));
    ref.el.pixels = bitmap(grayPage(3));
    await testPreload({ id: 'p1', order: 1 });
    assert.equal(fixture.paints[0]?.outputs[0].translation, 'page 3', 'the replacement image must still be eligible');
});

test('idlePageOrder names the page from the reader URL so a reopen can find its cache', () => {
    // No run, no binding — the reader's own /N is the only durable page identity.
    globalThis.location = { origin: 'https://reader.test', pathname: '/chapter/uuid/6', search: '', hash: '', href: 'https://reader.test/chapter/uuid/6' };
    assert.equal(idlePageOrder(), 5);
    globalThis.location = { origin: 'https://reader.test', pathname: '/read/uuid/1', search: '', hash: '', href: 'https://reader.test/read/uuid/1' };
    assert.equal(idlePageOrder(), 0);
    globalThis.location = { origin: 'https://reader.test', pathname: '/', search: '', hash: '', href: 'https://reader.test/' };
    assert.equal(idlePageOrder(), undefined, 'no page number → never guess a slot');
});

test('idlePageOrder reads a gallery page number (/g/<id>/<n>/) as the slot', () => {
    // gallery: /g/123456/4/ is page 4 of the gallery — slot 3, the key the chapter wrote.
    fixture.chapter = 'https://gallery.example.org/g/123456';
    globalThis.location = { origin: 'https://gallery.example.org', pathname: '/g/123456/4/', search: '', hash: '', href: 'https://gallery.example.org/g/123456/4/' };
    assert.equal(idlePageOrder(), 3);
    // the gallery cover carries no page: never guess a slot from /g/123456/
    globalThis.location = { origin: 'https://gallery.example.org', pathname: '/g/123456/', search: '', hash: '', href: 'https://gallery.example.org/g/123456/' };
    assert.equal(idlePageOrder(), undefined);
});

test('a not-yet-finished neighbour does not abort resolving the shown page', async () => {
    // The shown page (order 4) is ready; a pending neighbour has no artifact yet. The pending
    // candidate must be skipped, not abort the resolve — otherwise the finished page never
    // binds, never attaches, and its paid translation is stranded.
    const shown = identifyBitmap(bitmap(grayPage(4)), [{ x1: 10, y1: 10, x2: 200, y2: 200 }]);
    const pages = [
        { id: 'p4', url: 'https://cdn.test/4.png', order: 4, phase: 'ready', revision: 1, image: signatureOf(shown) },
        { id: 'p5', url: 'https://cdn.test/5.png', order: 5, phase: 'translating', revision: 0, image: undefined },
    ];
    fixture.artifacts.set('p4', { identity: shown, signature: 'test:signature' });
    fixture.artifacts.delete('p5');
    testProgress({ id: 'run', chapter: 'chapter:test', phase: 'running', pages });
    assert.equal((await resolveChapterRef(imageRef('blob:shown-4', bitmap(grayPage(4)))))?.order, 4);
});

test('opaque images resolve without a native page-number URL', async () => {
    const ref = imageRef('blob:opaque', bitmap(grayPage(4)));
    assert.equal((await resolveChapterRef(ref))?.order, 4);
});
test('sliding a window changes the mapping even when all pages have the same dimensions', async () => {
    fixture.live = [1, 2, 3].map(n => imageRef(`blob:${n}`, bitmap(grayPage(n))));
    assert.deepEqual((await elementMap()).map.map(p => p.order), [1, 2, 3]);
    fixture.live = [4, 5, 6].map(n => imageRef(`blob:${n}`, bitmap(grayPage(n))));
    assert.deepEqual((await elementMap()).map.map(p => p.order), [4, 5, 6]);
});
test('a recycled node is resolved from its new source rather than its old binding', async () => {
    const ref = imageRef('blob:first', bitmap(grayPage(2)));
    assert.equal((await resolveChapterRef(ref))?.order, 2);
    ref.el.src = ref.el.currentSrc = 'blob:next';
    ref.el.pixels = bitmap(grayPage(5));
    assert.equal((await resolveChapterRef(ref))?.order, 5);
});
test('duplicate images in different chapter slots are ambiguous, not last-write-wins', async () => {
    const identity = identifyBitmap(bitmap(grayPage(2)));
    fixture.artifacts.set('duplicate', { identity, signature: 'test:signature' });
    const pages = ['one', 'duplicate'].map((id, order) => ({ id, order, url: `https://cdn/${id}`, phase: 'ready', image: signatureOf(identity) }));
    fixture.artifacts.set('one', { identity, signature: 'test:signature' });
    testProgress({ id: 'duplicates', chapter: 'chapter:test', pages });
    assert.equal(await resolveChapterRef(imageRef('blob:duplicate', bitmap(grayPage(2)))), undefined);
});
test('a source change while evidence is in flight cannot bind the late result', async () => {
    const ref = imageRef('blob:first', bitmap(grayPage(2)));
    fixture.onResult = async () => {
        ref.el.src = ref.el.currentSrc = 'blob:next';
        ref.el.pixels = bitmap(grayPage(5));
    };
    assert.equal(await resolveChapterRef(ref), undefined);
});
test('a late attachment cannot overwrite a recycled image', async () => {
    const ref = imageRef('blob:first', bitmap(grayPage(2)));
    const page = await resolveChapterRef(ref);
    fixture.onResult = async () => { ref.el.src = ref.el.currentSrc = 'blob:next'; ref.el.pixels = bitmap(grayPage(5)); };
    await testAttach(ref, page);
    assert.deepEqual(fixture.paints, []);
    assert.equal(ref.el.src, 'blob:next');
});
test('a positional page paints from the artifact without reading cross-origin pixels', async () => {
    // The reader's page image is not origin-clean (a cross-origin CDN): decoding it for pixels
    // fails and fetchBitmap is stubbed to fail — the pre-fix attach refused the page here.
    // A page identified by the manifest + its own URL number must paint regardless; its pixel
    // identity is metadata that resolves after the paint.
    const shown = identifyBitmap(bitmap(grayPage(2)), [{ x1: 10, y1: 10, x2: 200, y2: 200 }]);
    testProgress({ id: 'pos', chapter: 'chapter:test', phase: 'running', completeManifest: true,
        pages: [{ id: 'p2', url: 'https://cdn.test/2.png', order: 2, phase: 'ready', revision: 1, image: signatureOf(shown) }] });
    fixture.artifacts.set('p2', {
        identity: shown, signature: 'test:signature', hash: 'deadbeef',
        image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        entry: { key: 'k', fp: settingsFingerprint({}), w: 600, h: 800,
            boxes: [{ x1: 10, y1: 10, x2: 200, y2: 200 }], panels: [], outputs: [], extras: [],
            mask: { w: 1, h: 1, data: Uint8Array.of(1).buffer }, order: 2, keyGen: 1 },
        mask: { w: 1, h: 1, data: 'data:application/octet-stream;base64,AA==' },
    });
    const pixels = bitmap(grayPage(2));
    pixels.clean = false; // origin-clean check fails, exactly like a cross-origin page image
    const ref = imageRef('https://cdn.test/2.png', pixels);
    const page = await resolveChapterRef(ref);
    assert.equal(page?.matchedBy, 'url');
    await testAttach(ref, page);
    assert.equal(fixture.paints.length, 1, 'the artifact must paint without the original pixels');
});

test('an attached positional artifact resolves without re-reading an unavailable original', async () => {
    fixture.chapter = 'https://reader.test/chapter/uuid';
    globalThis.location = { origin: 'https://reader.test', pathname: '/chapter/uuid/2', search: '', hash: '' };
    const artifact = readyArtifact(2);
    fixture.artifacts.set('p2', artifact);
    testProgress({ id: 'pos-painted', chapter: fixture.chapter, completeManifest: true,
        pages: [{ id: 'p2', url: 'https://cdn.test/2.png', order: 1, phase: 'ready', revision: 1, image: signatureOf(artifact.identity) }] });
    const ref = imageRef('blob:unreadable-original', bitmap(grayPage(2), { clean: false }));
    const page = await resolveChapterRef(ref);
    assert.equal(page?.matchedBy, 'url');
    await testAttach(ref, page);
    const state = fixture.states.get(ref.el);
    assert.ok(state);
    ref.el.src = ref.el.currentSrc = state.translated;
    const decode = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => { throw new Error('Original must not be re-read'); };
    try {
        assert.equal((await resolveChapterRef(ref))?.id, 'p2');
        location.pathname = '/chapter/uuid/3';
        assert.equal(await resolveChapterRef(ref), undefined, 'a changed page number invalidates the painted position');
    } finally { globalThis.createImageBitmap = decode; }
});
test('a different aspect ratio never matches one page of a composite', async () => {
    const ref = imageRef('blob:spread', bitmap(grayPage(2), { width: 1200, height: 800 }));
    assert.equal(await resolveChapterRef(ref), undefined);
});
// The owner's report: a chapter run translated page 2, but the reader's rendition of that page
// could not be decoded (the runner's own fetch of the same page failed too and used the sibling
// tier). The pixel probe threw and the old shared catch skipped the position fallback, so the
// page stayed unmatched and never painted though its slot was known from the manifest.
test('an unreadable rendition still resolves by the manifest page number, never by guesswork', async () => {
    globalThis.location = { origin: 'https://reader.test', pathname: '/chapter/uuid/6', search: '', hash: '', href: 'https://reader.test/chapter/uuid/6' };
    const pages = [1, 2, 3, 4, 5, 6].map(order => {
        const identity = identifyBitmap(bitmap(grayPage(order)), [{ x1: 10, y1: 10, x2: 200, y2: 200 }]);
        fixture.artifacts.set(`p${order}`, { identity, signature: 'test:signature' });
        return { id: `p${order}`, url: `https://cdn.test/${order}.png`, order, phase: 'ready', revision: 1, image: signatureOf(identity) };
    });
    const createImageBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => { throw new Error("The ImageBitmap could not be allocated."); };
    try {
        testProgress({ id: 'broken', chapter: 'chapter:test', phase: 'running', completeManifest: true, pages });
        const page = await resolveChapterRef(imageRef('blob:broken-page', bitmap(grayPage(6))));
        assert.equal(page?.matchedBy, 'url', 'position resolves when pixels are unreadable');
        assert.equal(page?.order, 5, 'the URL page number names the slot');
        // No manifest → the same unreadable page must resolve nothing: a guessed slot must never
        // authorize a lookup.
        testProgress({ id: 'broken2', chapter: 'chapter:test', phase: 'running', pages: pages.map(p => ({ ...p })) });
        assert.equal(await resolveChapterRef(imageRef('blob:broken-page', bitmap(grayPage(6)))), undefined);
    } finally { globalThis.createImageBitmap = createImageBitmap; }
});
test('a run that changes mid-probe must never position-guess from the stale one', async () => {
    globalThis.location = { origin: 'https://reader.test', pathname: '/chapter/uuid/6', search: '', hash: '', href: 'https://reader.test/chapter/uuid/6' };
    const pages = [1, 2, 3, 4, 5, 6].map(order => {
        const identity = identifyBitmap(bitmap(grayPage(order)), [{ x1: 10, y1: 10, x2: 200, y2: 200 }]);
        fixture.artifacts.set(`p${order}`, { identity, signature: 'test:signature' });
        return { id: `p${order}`, url: `https://cdn.test/${order}.png`, order, phase: 'ready', revision: 1, image: signatureOf(identity) };
    });
    testProgress({ id: 'run-A', chapter: 'chapter:test', phase: 'running', completeManifest: true, pages });
    // The broker roundtrip for evidence is where a new run can replace this one; the stale run's
    // page number must not authorize a paint afterwards (the readable pixels make the probe
    // reach that await).
    fixture.onResult = async () => {
        fixture.onResult = undefined;
        testProgress({ id: 'run-B', chapter: 'chapter:test', phase: 'running', completeManifest: true, pages: pages.map(p => ({ ...p })) });
    };
    assert.equal(await resolveChapterRef(imageRef('blob:stale', bitmap(grayPage(6)))), undefined);
});
