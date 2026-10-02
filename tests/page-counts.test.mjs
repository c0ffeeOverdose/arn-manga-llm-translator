// The pill/popup counts must mean the same thing as the chapter run's own progress while a run
// is active. A windowed reader (paged MangaDex) keeps ~5 images mounted, so DOM counting
// reported "1/5 pages" forever — a window size read as chapter progress. These tests pin the
// contract on the real pageCounts implementation with a stubbed reader surface.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const stubs = {
    // a page is "translated" when its element has a state — the stub stands in for that map
    state: `export const ui = null; export const pipeline = {}; export const mtPal = {}; export const mtDot = () => '';
        export const setDebugOn = () => {}; export const stateFor = ref => globalThis.fixture.states.get(ref);
        export const mtState = null;`,
    'page-io': `export const getPages = () => globalThis.fixture.pages;`,
    queue: `export const queue = []; export const failMarks = new Map(); export const activeKeyGet = () => null;
        export const activeRefGet = () => null; export const pageKeyOf = r => r.key; export const viewportOverlap = () => 0;
        export const paintFind = () => undefined; export const paintHas = () => false; export const paintQueued = () => 0;
        export const autoHalted = () => null;`,
    page_cache: `export const pickActivity = () => null; export const cooldownParked = () => false;`,
    debug: `export const initDebug = async () => {}; export const isDebug = () => false;`,
    ocr: `export const ensureDebugViews = async () => {};`,
    overlays: `export const applyOverlays = () => {};`,
    auto: `export const lookaheadActive = () => false;`,
    sweep: `export const sweepActive = () => globalThis.fixture.sweepActive;
        export const sweepStatus = () => globalThis.fixture.sweepStatus;`,
};
await build({ entryPoints: ['src/content/status-ui.ts'], bundle: true, format: 'esm', outfile: '.test-build/page-counts.mjs',
    plugins: [{ name: 'status-fixture', setup(build) {
        build.onResolve({ filter: /./ }, args => {
            const name = args.path.split('/').at(-1).replace(/\.ts$/, '');
            if (name === 'page-cache') return { path: 'page_cache', namespace: 'fixture' };
            if (name in stubs) return { path: name, namespace: 'fixture' };
        });
        build.onLoad({ filter: /./, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }] });
const { pageCounts } = await import('../.test-build/page-counts.mjs');

beforeEach(() => {
    globalThis.fixture = {
        pages: [], states: new Map(),
        sweepActive: false,
        sweepStatus: { active: true, phase: 'running', stopping: false, done: 0, total: 0, errors: 0, skipped: 0, inflight: 0 },
    };
});

test('a windowed reader reports chapter progress while a run is active', () => {
    // five mounted pages, one with a state — the old count would read 1/5
    fixture.pages = Array.from({ length: 5 }, (_, i) => ({ kind: 'img', el: {}, key: `k${i}` }));
    fixture.states.set(fixture.pages[0], { det: {} });
    fixture.sweepActive = true;
    fixture.sweepStatus = { ...fixture.sweepStatus, done: 9, total: 24 };
    assert.deepEqual(pageCounts(), { loaded: 24, translated: 9, queued: 0 });
});

test('without a run the DOM counts still work for solo translation', () => {
    fixture.pages = Array.from({ length: 3 }, (_, i) => ({ kind: 'img', el: {}, key: `k${i}` }));
    fixture.states.set(fixture.pages[0], { det: {} });
    fixture.states.set(fixture.pages[1], { det: {} });
    assert.deepEqual(pageCounts(), { loaded: 3, translated: 2, queued: 0 });
});

test('an active but empty run never blanks the pill with a zero total', () => {
    fixture.pages = [{ kind: 'img', el: {}, key: 'k0' }];
    fixture.states.set(fixture.pages[0], { det: {} });
    fixture.sweepActive = true;
    fixture.sweepStatus = { ...fixture.sweepStatus, done: 0, total: 0 };
    assert.deepEqual(pageCounts(), { loaded: 1, translated: 1, queued: 0 });
});
