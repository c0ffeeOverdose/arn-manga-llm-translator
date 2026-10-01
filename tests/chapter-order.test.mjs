import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bitmap, grayPage, imageRef, installCanvas } from './helpers/image-fixture.mjs';

const stubs = {
    state: `export const pipeline = {}; export const context = {}; export const shareContext = false;
        export const pages = new Map(); export const elStates = new WeakMap(); export const retiredBlobs = new Map(); export const overlayChoice = 'auto';
        export const chapterKey = () => 'chapter:test'; export const stateFor = () => undefined;
        export const bookKey = () => 'book'; export const loadContext = async () => {}; export const loadPipeline = async () => {};
        export const regPage = state => globalThis.fixture.paints.push(state);
        export const unregPage = () => {}; export const setOverlayChoice = () => {}; export const setOverlayOn = () => {};
        export const acceptChapterContext = () => {};`,
    'page-io': `export const getPages = () => globalThis.fixture.live;
        export const refKey = ref => ref.el.currentSrc || ref.el.src || ref.key;
        export const fetchBitmap = async () => { throw new Error('No network'); };
        export const unscrambleTiles = async () => null; export const ownOriginalUrl = async () => undefined;
        export const episodeManifestSrcs = () => null; export const fetchPagedUrls = async () => [];
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
    discovery: `export const nextDocument = () => undefined; export const guessNextDocument = () => undefined;`,
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
const { testProgress, resolveChapterRef, elementMap, testAttach } = await import('../.test-build/chapter-order.mjs');

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
