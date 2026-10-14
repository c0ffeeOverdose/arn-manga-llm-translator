import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileBoundary, boundary, evaluate, elements, tick, deferred } from './helpers/ux-fixture.mjs';

const stateCode = await compileBoundary('src/content/state.ts', { real: ['../llm/pipeline-settings'] });
const popupCode = await compileBoundary('src/popup/popup.ts', { extra: 'export { refreshStatus };' });
const sweepCode = await compileBoundary('src/content/sweep.ts', { extra: 'export { refresh };', real: ['../chapter/model', './attach-policy'] });

function stateFixture(url = 'https://reader.test/chapter/123456') {
    const location = new URL(url), tuning = {}, fonts = [], requests = [];
    let stored = {}, get = async () => ({ mtPipeline: stored });
    let font = async id => ({ ok: true, name: 'TestFont-' + id, b64: 'AA==' });
    const fixture = boundary({ EMPTY_CONTEXT: { pairs: [], characters: [] },
        fontStackFor: lang => 'default-' + lang, setRenderTuning: value => Object.assign(tuning, value),
        normalizeChapterKey: () => location.origin + location.pathname, pickSeriesLink: () => null, pickStoryScope: () => null,
        sessGet: async () => ({}), cacheGeneration: () => '', cacheCurrent: () => true,
        sendToBackground: msg => font(msg.id),
    });
    const state = evaluate(stateCode, fixture, { location, atob,
        document: { fonts: { add: face => fonts.push(face.family) }, querySelectorAll: () => [] },
        FontFace: class { constructor(family) { this.family = family; } async load() { return this; } },
        chrome: { storage: { local: { get: (...args) => get(...args), set: async () => {} } } },
        fetch: async url => { const response = deferred(); requests.push({ url, response }); return { json: () => response.promise }; },
    });
    return { state, tuning, fonts, location, requests,
        settings: partial => ({ ...structuredClone(state.pipeline), ...partial }),
        store(value) { stored = value; }, reader(fn) { get = fn; }, font(fn) { font = fn; } };
}

test('a selected font survives repeated pipeline loads without fetching it again', async () => {
    const f = stateFixture(); let fetches = 0;
    f.font(async () => { fetches++; return { ok: true, name: 'Selected Font', b64: 'AA==' }; });
    f.store(f.settings({ renderFont: 'selected', targetLang: 'English' }));
    await f.state.loadPipeline();
    assert.equal(f.tuning.font, '"Selected Font", default-English');
    await f.state.loadPipeline();
    assert.equal(f.tuning.font, '"Selected Font", default-English');
    assert.equal(fetches, 1);
});

test('configuring the chapter host retains its asynchronously loaded font', async () => {
    const f = stateFixture(), settings = f.settings({ renderFont: 'selected', targetLang: 'English' });
    await f.state.loadPipeline(settings);
    f.state.configureChapterHost('chapter', 'book', settings, { pairs: [], characters: [] });
    assert.equal(f.tuning.font, '"TestFont-selected", default-English');
});

test('a late font reply cannot overwrite newer language and font settings', async () => {
    const f = stateFixture(), oldFont = deferred();
    f.font(() => oldFont.promise);
    const old = f.state.loadPipeline(f.settings({ renderFont: 'old', targetLang: 'English' }));
    await tick();
    await f.state.loadPipeline(f.settings({ renderFont: 'default', targetLang: 'Japanese' }));
    oldFont.resolve({ ok: true, name: 'Old Font', b64: 'AA==' }); await old;
    assert.equal(f.state.pipeline.targetLang, 'Japanese');
    assert.equal(f.state.pipeline.renderFont, 'default');
    assert.equal(f.tuning.font, 'default-Japanese');
});

test('an older settings read cannot roll back a newer pipeline load', async () => {
    const f = stateFixture(), oldRead = deferred();
    const oldSettings = f.settings({ targetLang: 'English' }), next = f.settings({ targetLang: 'Japanese' });
    f.reader(() => oldRead.promise);
    const old = f.state.loadPipeline(); await tick();
    f.reader(async () => ({ mtPipeline: next })); await f.state.loadPipeline();
    oldRead.resolve({ mtPipeline: oldSettings }); await old;
    assert.equal(f.state.pipeline.targetLang, 'Japanese');
    assert.equal(f.tuning.font, 'default-Japanese');
});

test('concurrent pipeline loads share font setup and apply the newest language', async () => {
    const f = stateFixture(), font = deferred(); let fetches = 0;
    f.font(() => { fetches++; return font.promise; });
    const first = f.state.loadPipeline(f.settings({ renderFont: 'selected', targetLang: 'English' }));
    const second = f.state.loadPipeline(f.settings({ renderFont: 'selected', targetLang: 'Japanese' }));
    font.resolve({ ok: true, name: 'Selected Font', b64: 'AA==' }); await Promise.all([first, second]);
    assert.equal(fetches, 1);
    assert.equal(f.tuning.font, '"Selected Font", default-Japanese');
});

test('failed font setup can be retried without discarding the selected font', async () => {
    const f = stateFixture();
    f.store(f.settings({ renderFont: 'selected', targetLang: 'English' }));
    f.font(async () => ({ ok: false, error: 'fixture missing font' }));
    await f.state.loadPipeline(); assert.equal(f.tuning.font, 'default-English');
    f.font(async () => ({ ok: true, name: 'Selected Font', b64: 'AA==' }));
    await f.state.loadPipeline(); assert.equal(f.tuning.font, '"Selected Font", default-English');
});

test('concurrent story resolution waits for one shared request before choosing a book', async () => {
    const f = stateFixture('https://mangadex.org/chapter/fixture-one');
    const first = f.state.resolveMangaId();
    let settled = false;
    const second = f.state.resolveMangaId().then(value => { settled = true; return value; });
    await tick();
    const early = settled;
    f.requests[0].response.resolve({ data: { relationships: [{ type: 'manga', id: 'fixture-story-one' }] } });
    assert.deepEqual(await Promise.all([first, second]), ['fixture-story-one', 'fixture-story-one']);
    assert.equal(early, false);
    assert.equal(f.requests.length, 1);
});

test('a previous chapter response cannot replace the new story book after navigation', async () => {
    const f = stateFixture('https://mangadex.org/chapter/fixture-one');
    await f.state.loadPipeline(f.settings({ crossChapter: true }));
    const old = f.state.resolveMangaId(); await tick();
    f.location.pathname = '/chapter/fixture-two'; f.state.resetContextIfNewChapter(); await tick();
    assert.equal(f.requests.length, 2);
    f.requests[1].response.resolve({ data: { relationships: [{ type: 'manga', id: 'fixture-story-two' }] } }); await tick();
    assert.equal(f.state.bookKey(), 'mtBook:fixture-story-two');
    f.requests[0].response.resolve({ data: { relationships: [{ type: 'manga', id: 'fixture-story-one' }] } }); await old;
    assert.equal(f.state.bookKey(), 'mtBook:fixture-story-two');
});

function popupFixture() {
    const dom = elements(), calls = [];
    let status = { ok: true, busy: false, viewedActive: false, viewedTranslated: true, loaded: 3, translated: 1,
        sweep: { active: false, canResume: true, done: 1, total: 3, errors: 0 } };
    let statusReply = () => status, countReply = () => ({ ok: true, count: 3, reason: 'known' });
    const fixture = boundary({ initDebug: async () => {}, isDebug: () => false, sessGet: async () => ({}),
        autoSiteOf: () => 'https://reader.test', isAutoSite: () => false, loadPipelineSettings: () => ({ prefetchN: 3 }) });
    const popup = evaluate(popupCode, fixture, { document: dom.document, window: { addEventListener() {} }, navigator: {},
        setInterval: () => 1, clearInterval() {}, chrome: {
            tabs: { query: async () => [{ id: 1, url: 'https://reader.test/chapter/123456' }],
                sendMessage: async (_tab, msg) => {
                    calls.push(msg.type);
                    if (msg.type === 'mt:status') return statusReply();
                    if (msg.type === 'mt:sweep-count') return countReply();
                    if (msg.type === 'mt:cache-count') return { ok: true, count: 1, mine: 1 };
                    return { ok: true };
                } },
            storage: { local: { get: async () => ({}), set: async () => {} } },
        } });
    return { popup, dom, calls, status: value => { status = value; }, reply: fn => { statusReply = fn; }, count: fn => { countReply = fn; },
        running: () => ({ ...status, busy: true, viewedActive: true, sweep: { ...status.sweep, active: true, phase: 'running' } }) };
}

test('an older popup status reply cannot replace the latest Stop controls', async () => {
    const f = popupFixture(); await tick();
    const stale = deferred(); f.reply(() => stale.promise);
    const old = f.popup.refreshStatus(); await tick();
    f.status(f.running()); f.reply(() => f.running()); await f.popup.refreshStatus();
    assert.match(f.dom.$('sweep').textContent, /^Stop chapter/);
    stale.resolve({ ok: true, busy: false, viewedActive: false, loaded: 3, translated: 1, sweep: null }); await old;
    assert.match(f.dom.$('sweep').textContent, /^Stop chapter/);
    assert.equal(f.dom.$('translate').textContent, 'Stop this page');
    f.calls.length = 0;
    await f.dom.$('sweep').onclick(); assert.ok(f.calls.includes('mt:sweep-cancel'));
});

test('a delayed chapter count cannot replace newer popup chapter progress', async () => {
    const f = popupFixture(); await tick();
    const count = deferred(); f.count(() => count.promise);
    const old = f.popup.refreshStatus(); await tick();
    f.status(f.running()); await f.popup.refreshStatus();
    count.resolve({ ok: true, count: 3, reason: 'known' }); await old;
    assert.match(f.dom.$('sweep').textContent, /^Stop chapter/);
});

test('slow overlapping popup polls still display the newest completed reply', async () => {
    const f = popupFixture(); await tick();
    const first = deferred(), second = deferred();
    f.reply(() => first.promise); const p1 = f.popup.refreshStatus(); await tick();
    f.reply(() => second.promise); const p2 = f.popup.refreshStatus(); await tick();
    first.resolve(f.running()); await p1;
    const intermediate = f.dom.$('translate').textContent;
    second.resolve({ ok: true, busy: false, viewedActive: false, loaded: 3, translated: 1, sweep: null }); await p2;
    assert.equal(intermediate, 'Stop this page');
    assert.equal(f.dom.$('translate').textContent, 'Translate this page');
});

function sweepFixture() {
    const chapter = 'https://reader.test/chapter/123456';
    let listener, reply = async () => ({ status: null }), command = async () => ({ ok: true });
    const controls = [];
    const fixture = boundary({ chapterKey: () => chapter, cacheReady: async () => '', cacheCurrent: () => true,
        getPages: () => [], isDebug: () => false,
        sendToBackground: msg => {
            if (msg.type === 'mt:chapter-status') return reply();
            if (msg.type === 'mt:chapter-control') { controls.push(msg.command); return command(msg); }
            return Promise.resolve({ ok: true });
        },
    });
    const sweep = evaluate(sweepCode, fixture, { location: new URL(chapter), queueMicrotask,
        setInterval: () => 1, clearInterval() {}, document: { addEventListener() {} }, window: { addEventListener() {} },
        chrome: { runtime: { id: 'extension', onMessage: { addListener: fn => { listener = fn; } } } },
    });
    sweep.initSweep();
    const progress = (phase, done = 0, sequence = 1) => ({ id: 'run', chapter, phase, done, sequence, total: 3, inflight: 0,
        errors: 0, completeManifest: true, pages: Array.from({ length: 3 }, (_, i) => ({ id: 'p' + i, url: 'https://reader.test/' + i + '.png', phase: i < done ? 'ready' : 'queued' })) });
    return { sweep, progress, controls, reply: fn => { reply = fn; }, command: fn => { command = fn; },
        push: status => listener({ type: 'mt:chapter-update', status }, { id: 'extension' }, () => {}) };
}

test('an older chapter poll cannot revive a stopped run after a newer push', async () => {
    const f = sweepFixture(); await tick();
    const oldStatus = deferred(), nextStatus = deferred(); f.reply(() => oldStatus.promise);
    const old = f.sweep.refresh(); await tick();
    f.push(f.progress('stopped', 1, 3));
    f.reply(() => nextStatus.promise);
    oldStatus.resolve({ status: f.progress('running', 0, 2) }); await old; await tick();
    const active = f.sweep.sweepActive();
    nextStatus.resolve({ status: f.progress('stopped', 1, 3) }); await tick();
    assert.equal(active, false);
});

test('a stale chapter push cannot roll back completed page counts', async () => {
    const f = sweepFixture(); await tick();
    f.push(f.progress('stopped', 2, 5)); await tick();
    f.push(f.progress('stopped', 1, 4)); await tick();
    assert.equal(f.sweep.sweepStatus().done, 2);
});

test('Stop remains stopping while an older chapter poll is still in flight', async () => {
    const f = sweepFixture(); await tick();
    f.push(f.progress('running')); await tick();
    const oldStatus = deferred(); f.reply(() => oldStatus.promise);
    const old = f.sweep.refresh(); await tick();
    f.sweep.cancelSweep(); assert.equal(f.sweep.sweepStatus().stopping, true);
    oldStatus.resolve({ status: f.progress('running') }); await old;
    assert.equal(f.sweep.sweepStatus().stopping, true);
});

test('a pending Resume is stoppable and its late acknowledgement cannot restart the run', async () => {
    const f = sweepFixture(); await tick();
    f.push(f.progress('stopped', 1, 5)); await tick();
    const resume = deferred(); f.command(msg => msg.command === 'resume' ? resume.promise : Promise.resolve({ ok: true }));
    const pending = f.sweep.resumeSweep(); await tick();
    const activeWhilePending = f.sweep.sweepActive();
    f.sweep.cancelSweep();
    f.push(f.progress('stopped', 1, 6));
    resume.resolve({ ok: true }); await pending; await tick();
    assert.equal(activeWhilePending, true);
    assert.ok(f.controls.includes('stop'));
    assert.equal(f.sweep.sweepActive(), false);
});

test('a rejected Resume restores the previous paused state', async () => {
    const f = sweepFixture(); await tick();
    f.push(f.progress('stopped', 1, 5)); await tick();
    f.command(async () => ({ ok: false, error: 'fixture rejection' }));
    assert.equal((await f.sweep.resumeSweep()).ok, false);
    assert.equal(f.sweep.sweepActive(), false);
    assert.equal(f.sweep.sweepStatus().canResume, true);
});

test('a completed publication during Resume survives its delayed acknowledgement', async () => {
    const f = sweepFixture(); await tick();
    f.push(f.progress('stopped', 1, 5)); await tick();
    const resume = deferred(); f.command(() => resume.promise);
    const pending = f.sweep.resumeSweep(); await tick();
    f.push(f.progress('complete', 3, 6));
    resume.resolve({ ok: true }); await pending; await tick();
    assert.equal(f.sweep.sweepActive(), false);
    assert.equal(f.sweep.sweepStatus().done, 3);
});

test('a failed Stop leaves the running chapter stoppable instead of latched in stopping', async () => {
    const f = sweepFixture(); await tick();
    f.push(f.progress('running', 1, 5)); await tick();
    f.command(async () => ({ ok: false, error: 'fixture rejection' }));
    f.sweep.cancelSweep(); await tick();
    assert.equal(f.sweep.sweepStatus().stopping, false);
    assert.equal(f.sweep.sweepActive(), true);
});

test('a newer retranslation publication can legitimately reset a completed page', async () => {
    const f = sweepFixture(); await tick();
    f.push(f.progress('stopped', 2, 5)); await tick();
    f.push(f.progress('running', 1, 6)); await tick();
    assert.equal(f.sweep.sweepStatus().done, 1);
    assert.equal(f.sweep.sweepActive(), true);
});

test('an authoritative missing chapter session clears stale active ownership', async () => {
    const f = sweepFixture(); await tick();
    f.push(f.progress('running')); await tick();
    f.reply(async () => ({ ok: true, status: null })); await f.sweep.refresh();
    assert.equal(f.sweep.sweepStatus(), null);
});
