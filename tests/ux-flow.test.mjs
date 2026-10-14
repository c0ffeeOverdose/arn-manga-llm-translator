import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { compileBoundary, boundary, evaluate, elements, tick, deferred } from './helpers/ux-fixture.mjs';

const autoCode = await compileBoundary('src/content/auto.ts', { extra: 'export { autoTick };', real: ['./auto-window', './cancellation'] });
const commandCode = await compileBoundary('src/content/commands.ts');
const popupCode = await compileBoundary('src/popup/popup.ts', { extra: 'export { refreshStatus };' });
const queueCode = await compileBoundary('src/content/queue.ts', { real: ['./prepared-job', './cancellation'] });

class Image {
    isConnected = true; complete = true; naturalWidth = 800;
    constructor(id, y) { this.id = id; this.y = y; }
    getBoundingClientRect() { return { left: 0, right: 800, top: this.y, bottom: this.y + 1000 }; }
}
function reader() {
    const pages = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, kind: 'img', el: new Image(`p${i}`, i * 1000) }));
    const queue = [], translated = new Set(), calls = [], events = new Map();
    let halted = null, listener;
    const fixture = boundary({ pipeline: { prefetchN: 3 }, queue, failMarks: new Map(),
        autoBudget: (queued, ahead) => Math.max(0, ahead - queued), getPages: () => [...pages],
        viewportOverlap: ref => { const r = ref.el.getBoundingClientRect(); return Math.max(0, Math.min(r.bottom, 1000) - Math.max(r.top, 0)) * 800; },
        stateFor: ref => translated.has(ref.id) ? { orig: `https://reader.test/${ref.id}.png`, det: { boxes: [{}] } } : undefined,
        paintHas: () => false, cooldownParked: () => false, sweepActive: () => false, sweepHas: () => false,
        autoHalted: () => halted, haltAuto: kind => { halted = { kind }; }, resumeAuto: () => { halted = null; },
        enqueue: (ref, force, auto) => { calls.push(ref.id); queue.push({ ref, key: ref.id, auto }); return 'queued'; },
        dropAutoQueued: allowed => { for (let i = queue.length - 1; i >= 0; i--) if (queue[i].auto && !allowed?.has(queue[i].key)) queue.splice(i, 1); },
        pageKeyOf: ref => ref.id, refKey: ref => ref.id, activeRefGet: () => null,
        galleryManifestJson: async () => null, galleryLookaheadUrls: () => [], sweepStatus: () => null, paintQueued: () => 0,
        stopAllJobs: () => { queue.length = 0; }, chapterOwnsRequest: () => false, resolveChapterRef: async () => undefined,
        isDebug: () => false, logError: async () => {},
    });
    const auto = evaluate(autoCode, fixture, { setInterval: () => 1, clearInterval() {}, document: { documentElement: { dataset: {} } } });
    fixture.cancelLookahead = auto.cancelLookahead; fixture.lookaheadActive = auto.lookaheadActive; fixture.pauseAuto = auto.pauseAuto;
    fixture.setAutoTranslate = auto.setAutoTranslate;
    const commands = evaluate(commandCode, fixture, { HTMLImageElement: Image, window: { innerWidth: 800, innerHeight: 1000 },
        document: { addEventListener: (name, fn) => events.set(name, fn), querySelector: () => null },
        chrome: { runtime: { onMessage: { addListener: fn => { listener = fn; } } } } });
    commands.installMessageListener();
    return { auto, fixture, pages, queue, translated, calls, events,
        send: msg => new Promise(resolve => listener(msg, {}, resolve)) };
}

test('Pages ahead stays within the visible page plus N, then advances only with the reader', async () => {
    const f = reader();
    await f.auto.setAutoTranslate(true);
    for (let i = 0; i < 10; i++) {
        for (const job of f.queue) f.translated.add(job.ref.id);
        f.queue.length = 0;
        await f.auto.autoTick(); await tick();
    }
    assert.deepEqual([...f.translated], ['p0', 'p1', 'p2', 'p3']);
    f.pages.forEach((p, i) => { p.el.y = (i - 4) * 1000; });
    await f.auto.autoTick();
    assert.ok(f.queue.length > 0);
    assert.ok(f.queue.every(job => ['p4', 'p5', 'p6', 'p7'].includes(job.ref.id)));
});

test('Stop all holds Auto paused across ticks until explicit Resume', async () => {
    const f = reader(); await f.auto.setAutoTranslate(true);
    assert.equal(f.queue.length, 3);
    await f.send({ type: 'mt:cancel-all' });
    assert.equal(f.queue.length, 0);
    for (let i = 0; i < 5; i++) await f.auto.autoTick();
    assert.equal(f.queue.length, 0); assert.equal(f.auto.autoOn(), false);
    await f.send({ type: 'mt:auto-resume' });
    assert.equal(f.queue.length, 3); assert.equal(f.auto.autoOn(), true);
});

test('Auto translates retained originals after cache clear and implicit startup preserves a user pause', async () => {
    const f = reader();
    f.fixture.stateFor = ref => ({ orig: `https://reader.test/${ref.id}.png` });
    const code = evaluate(autoCode, f.fixture, { setInterval: () => 1, clearInterval() {}, document: { documentElement: { dataset: {} } } });
    code.pauseAuto(); await code.setAutoTranslate(true, false); await code.autoTick();
    assert.equal(f.queue.length, 0);
    await code.setAutoTranslate(true);
    assert.equal(f.queue.length, 3);
});

test('off-DOM lookahead never buys the same pages already mounted in the Auto window', async () => {
    const f = reader(); let headless = 0;
    for (const id of ['p0', 'p1', 'p2', 'p3']) f.translated.add(id);
    Object.assign(f.fixture, { galleryManifestJson: async () => 'fixture',
        galleryLookaheadUrls: () => ['p1', 'p2', 'p3'].map(id => `https://reader.test/${id}.png`),
        fetchBitmap: async () => ({ bitmap: { width: 600, height: 800, close() {} } }),
        cacheReady: async () => '', loadPipeline: async () => {}, pageHashFromBitmap: () => 'hash',
        cacheKey: () => 'cache', settingsFingerprint: () => 'fp', readWarming: () => null,
        resolveHeadlessDet: async () => { headless++; return { det: null }; },
    });
    const auto = evaluate(autoCode, f.fixture, { setInterval: () => 1, clearInterval() {}, document: { documentElement: { dataset: {} } } });
    await auto.setAutoTranslate(true); await tick();
    assert.equal(headless, 0); assert.equal(f.queue.length, 0);
});

test('popup Translate ignores an unused right-click; the context menu still targets its image', async () => {
    const f = reader();
    f.events.get('contextmenu')({ target: f.pages[5].el, clientX: 10, clientY: 10 });
    await f.send({ type: 'mt:translate-image' });
    assert.deepEqual(f.calls, ['p0']);
    f.calls.length = 0; f.queue.length = 0;
    f.events.get('contextmenu')({ target: f.pages[5].el, clientX: 10, clientY: 10 });
    await f.send({ type: 'mt:translate-image', fromMenu: true });
    assert.deepEqual(f.calls, ['p5']);
});

test('popup offers Stop for a sole active page, Resume for a paused chapter and a separate Auto resume', async () => {
    const dom = elements(), calls = [];
    let status = { ok: true, busy: true, viewedActive: true, viewedTranslated: false, queued: 0,
        loaded: 1, translated: 0, status: 'Translating…', sweep: null, autoPaused: false };
    const fixture = boundary({ sessGet: async () => ({}), latestChapterLogHead: async () => undefined,
        autoSiteOf: () => 'https://reader.test', isAutoSite: () => true, loadPipelineSettings: () => ({ prefetchN: 3 }) });
    const popup = evaluate(popupCode, fixture, { document: dom.document, window: { addEventListener() {} },
        navigator: {}, setInterval: () => 1, clearInterval() {}, chrome: {
            tabs: { query: async () => [{ id: 1, url: 'https://reader.test/chapter/123456' }], sendMessage: async (_, msg) => {
                calls.push(msg.type);
                return msg.type === 'mt:status' ? status : { ok: true, stopped: true, count: 1, mine: 1, reason: 'known' };
            } }, storage: { local: { get: async () => ({}), set: async () => {} } },
        } });
    await tick(); await popup.refreshStatus();
    assert.equal(dom.$('translate').textContent, 'Stop this page'); assert.equal(dom.$('translate').disabled, false);
    assert.equal(dom.$('cancelAll').style.display, '');
    await dom.$('translate').onclick(); assert.ok(calls.includes('mt:stop-page'));
    status = { ...status, busy: false, viewedActive: false, autoPaused: true,
        sweep: { active: false, canResume: true, done: 1, total: 3, errors: 0 } };
    await popup.refreshStatus();
    assert.match(dom.$('sweep').textContent, /^Translate to chapter end/);
    assert.match(dom.$('sweepResume').textContent, /^Resume chapter translation/);
    assert.equal(dom.$('sweepResume').hidden, false); assert.equal(dom.$('autoPaused').hidden, false);
    calls.length = 0;
    await dom.$('sweep').onclick();
    assert.ok(calls.includes('mt:sweep-start')); assert.equal(calls.includes('mt:sweep-resume'), false);
    calls.length = 0;
    await dom.$('sweepResume').onclick();
    assert.ok(calls.includes('mt:sweep-resume')); assert.equal(calls.includes('mt:sweep-start'), false);
    await dom.$('resumeAuto').onclick(); assert.ok(calls.includes('mt:auto-resume'));
    status = { ...status, sweep: { ...status.sweep, active: true } };
    await popup.refreshStatus();
    assert.match(dom.$('sweep').textContent, /^Stop chapter/); assert.equal(dom.$('sweepResume').hidden, true);
    status = { ...status, sweep: { ...status.sweep, active: false, canResume: false } };
    await popup.refreshStatus();
    assert.match(dom.$('sweep').textContent, /^Translate to chapter end/); assert.equal(dom.$('sweepResume').hidden, true);
});

function queueFixture(stage) {
    const prepared = deferred(), rendered = deferred();
    const ref = { id: 'p0', kind: 'img', el: new Image('p0', 0) };
    let closed = 0, renderCalls = 0, commits = 0;
    const bitmap = { close() { closed++; } };
    const fixture = boundary({ pipeline: { parallelLlm: 1 }, context: { pairs: [], characters: [] }, shareContext: true,
        chapterKey: () => 'chapter', contextChapter: 'chapter', refKey: ref => ref.id, getPages: () => [ref],
        chapterOwnsRequest: () => false, isDebug: () => false, bookHas: () => false,
        trySeam: async () => null,
        preparePage: async (_ref, _force, _status, _sweep, _wait, signal) => {
            if (stage === 'prepare') await prepared.promise;
            return { bitmap, signal, hash: 'hash', det: { boxes: [{}], ep: 'test', inferMs: 0 } };
        },
        renderPage: async (_ref, prep) => {
            renderCalls++; await rendered.promise; prep.signal.throwIfAborted(); commits++;
            return { det: prep.det, outputs: [] };
        }, logError: async () => {},
    });
    const queue = evaluate(queueCode, fixture, { navigator: {}, window: { innerWidth: 800, innerHeight: 1000 },
        chrome: { runtime: { connect: () => ({ postMessage() {}, disconnect() {} }) } } });
    return { queue, ref, prepared, rendered, get closed() { return closed; }, get renderCalls() { return renderCalls; }, get commits() { return commits; } };
}

test('Stop during page preparation releases the queue and prevents late provider work', async () => {
    const f = queueFixture('prepare');
    try {
        f.queue.enqueue(f.ref); await tick(); assert.equal(f.queue.pageActive(f.ref), true);
        assert.equal(f.queue.cancelPage(f.ref), true); await tick();
        assert.equal(f.queue.isBusy(), false); assert.equal(f.closed, 0);
        f.prepared.resolve(); await tick();
        assert.equal(f.renderCalls, 0); assert.equal(f.closed, 1);
    } finally { f.queue.stopAllJobs(); f.prepared.resolve(); f.rendered.resolve(); }
});

test('Stop during a page request keeps its image alive until settlement and rejects late commits', async () => {
    const f = queueFixture('render');
    try {
        f.queue.enqueue(f.ref); await tick(); assert.equal(f.renderCalls, 1);
        f.queue.cancelPage(f.ref); await tick();
        assert.equal(f.queue.isBusy(), false); assert.equal(f.closed, 0);
        f.rendered.resolve(); await tick();
        assert.equal(f.commits, 0); assert.equal(f.closed, 1);
    } finally { f.queue.stopAllJobs(); f.rendered.resolve(); }
});

const settingsCode = (await build({ entryPoints: ['src/chapter/settings.ts'], bundle: true, format: 'iife', globalName: 'Subject', write: false })).outputFiles[0].text;
const { chapterSettingsChanged } = evaluate(settingsCode, {});
test('the chapter settings policy ignores Pages ahead and presentation settings but pauses for translation changes', () => {
    for (const changed of [{ prefetchN: 9 }, { cacheMax: 500 }, { showToasts: false }]) {
        assert.equal(chapterSettingsChanged({ mtPipeline: { oldValue: {}, newValue: changed } }), false);
    }
    assert.equal(chapterSettingsChanged({ mtPipeline: { oldValue: {}, newValue: { targetLang: 'English' } } }), true);
    assert.equal(chapterSettingsChanged({ mtSettings: { oldValue: { model: 'one' }, newValue: { model: 'two' } } }), true);
    assert.equal(chapterSettingsChanged({ mtTheme: { newValue: 'dark' } }), false);
});

test('deleting the selected font preserves unsaved language and fresh stored settings independently', async () => {
    const dom = elements(), installed = new Set(['sarabun']);
    let stored = { targetLang: 'English', renderFont: 'sarabun', prefetchN: 7 }, writes = 0;
    const chrome = { tabs: { query: async () => [] }, storage: { local: {
        get: async () => ({ mtPipeline: structuredClone(stored) }), set: async value => { stored = structuredClone(value.mtPipeline); writes++; },
    } } };
    const section = evaluate(await compileBoundary('src/options/pipeline-section.ts', { real: ['../llm/pipeline-settings'] }),
        boundary({ $: dom.$ }), { chrome, document: dom.document });
    section.loadStoredPipeline(stored); section.pipeline.targetLang = 'Japanese';
    const fonts = evaluate(await compileBoundary('src/options/panels.ts'), boundary({ $: dom.$, pipeline: section.pipeline,
        forgetSelectedFont: section.forgetSelectedFont, FONT_PRESETS: [{ id: 'sarabun', label: 'Sarabun' }],
        fontList: async () => [...installed], fontName: async id => id, fontDelete: async id => { installed.delete(id); },
    }), { chrome, document: dom.document });
    await tick(); await fonts.renderFontManager();
    assert.equal(writes, 0);
    const remove = dom.$('fontPresetList').children[0].children.at(-1);
    assert.equal(remove.textContent, 'Delete'); await remove.onclick();
    assert.equal(stored.targetLang, 'English'); assert.equal(stored.prefetchN, 7); assert.equal(stored.renderFont, 'default');
    assert.equal(section.pipeline.targetLang, 'Japanese'); assert.equal(writes, 1);
});
