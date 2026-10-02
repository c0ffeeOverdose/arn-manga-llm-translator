import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bitmap, grayPage, imageRef, installCanvas } from './helpers/image-fixture.mjs';

const stubs = {
    state: `export const pipeline = {}; export const context = {}; export const shareContext = false;
        export const pages = new Map(); export const elStates = new WeakMap(); export const retiredBlobs = new Map(); export const overlayChoice = 'auto';
        export const chapterKey = () => globalThis.fixture.chapter ?? 'chapter:test'; export const stateFor = () => undefined;
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
        export const bitmapBlank = async () => false; export const writePage = () => {};`,
    queue: `export const viewportOverlap = () => 1; export const dropAutoQueued = () => {};
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
            readFileSync(args.path, 'utf8') + '\nexport const testProgress = p => { progress = p; evidence.clear(); imageAliases.clear(); };\nexport { attach as testAttach };' }));
    } }] });
await build({ entryPoints: ['src/image-identity.ts'], bundle: true, format: 'esm', outfile: '.test-build/chapter-order-image.mjs' });
const { identifyBitmap, signatureOf } = await import('../.test-build/chapter-order-image.mjs');
const { testProgress, resolveChapterRef, elementMap, testAttach, idlePageOrder } = await import('../.test-build/chapter-order.mjs');

beforeEach(() => {
    installCanvas();
    globalThis.fixture = { live: [], artifacts: new Map(), paints: [], onResult: undefined };
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
test('a different aspect ratio never matches one page of a composite', async () => {
    const ref = imageRef('blob:spread', bitmap(grayPage(2), { width: 1200, height: 800 }));
    assert.equal(await resolveChapterRef(ref), undefined);
});
