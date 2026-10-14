import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileBoundary, boundary, evaluate, tick, deferred } from './helpers/ux-fixture.mjs';

const code = await compileBoundary('src/background/chapter-broker.ts');

function fixture() {
    const records = new Map(), session = {}, ensures = [], stops = [], pushes = [];
    let listener, removed, current = '', firstWait, neverReady = false;
    const data = tab => ({ chapter: 'https://reader.test/chapter/fixture-' + tab,
        readerUrl: 'https://reader.test/chapter/fixture-' + tab, bookKey: 'book-' + tab,
        pipeline: { inferEngine: 'local', layoutModel: 'koharu', parallelLlm: 1, mergePages: 1 },
        context: { pairs: [], characters: [] }, shareContext: true, completeManifest: true,
        pages: [{ id: 'page-' + tab, url: 'https://reader.test/page-' + tab + '.png', order: 0 }] });
    const runner = { kind: 'offscreen',
        async ensure(id) {
            ensures.push(id);
            if (current) return;
            current = id;
            const cfg = records.get('host:' + id);
            records.set('status:' + id, { id, chapter: cfg.chapter, sequence: 1, phase: 'running',
                done: 0, total: 1, errors: 0, inflight: 0, completeManifest: true,
                pages: [{ id: cfg.pages[0].id, url: cfg.pages[0].url, phase: 'queued' }] });
        },
        async stop(id) { stops.push(id); current = ''; },
        async live() { return !!current; },
    };
    const values = boundary({
        sessGet: async keys => keys == null ? structuredClone(session)
            : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(session[key])])),
        sessSet: async values => Object.assign(session, structuredClone(values)),
        sessRemove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete session[key]; },
        readRecord: async key => structuredClone(records.get(key)), writeRecord: async (key, value) => { records.set(key, structuredClone(value)); },
        clearRecords: async () => records.clear(), cacheClear: async () => {},
        cacheReady: async () => '', assertCacheCurrent() {}, cacheGeneration: () => '',
        createRunner: () => runner, runnerKind: () => 'offscreen', runnerUrl: () => 'chrome-extension://test/chapter/page.html',
        createChapterLog: async () => '', readerStartAllowed: () => true,
        chapterSettingsChanged: () => false,
        AttachWatch: class {
            hit() {}
            async wait(id) {
                if (neverReady) return false;
                if (firstWait) { const gate = firstWait; firstWait = undefined; return gate.promise; }
                return current === id;
            }
        },
    });
    const chrome = {
        runtime: { id: 'extension', onMessage: { addListener: fn => { listener = fn; } }, getContexts: async () => [],
            sendMessage: async () => ({ ok: true }) },
        storage: { session: {}, onChanged: { addListener() {} }, local: { set: async () => {} } },
        tabs: { onRemoved: { addListener: fn => { removed = fn; } }, get: async tab => ({ id: tab, url: data(tab).readerUrl }),
            query: async () => [], sendMessage: async (tab, msg) => {
                if (msg.type === 'mt:reader-identity') return { url: data(tab).readerUrl };
                pushes.push({ tab, message: structuredClone(msg) }); return { ok: true };
            } },
    };
    evaluate(code, values, { chrome, crypto: globalThis.crypto, navigator: { userAgent: 'fixture' }, __BUILD_ID__: 'fixture' });
    const sender = tab => ({ id: 'extension', frameId: 0, tab: { id: tab }, url: data(tab).readerUrl, origin: 'https://reader.test' });
    const send = (msg, from) => new Promise(resolve => listener(msg, from, resolve));
    return { records, session, ensures, stops, pushes, data, current: () => current,
        start: tab => send({ type: 'mt:chapter-start', data: data(tab) }, sender(tab)),
        status: tab => send({ type: 'mt:chapter-status', chapter: data(tab).chapter }, sender(tab)),
        close: async tab => { removed(tab); await tick(); },
        holdStart: () => { firstWait = deferred(); return firstWait; },
        failSetup: value => { neverReady = value; },
        publish: (id, status) => send({ type: 'mt:chapter-publish', id, status }, { id: 'extension', url: 'chrome-extension://test/chapter/page.html' }),
    };
}

test('a new tab takes ownership with one runner creation and pauses the previous tab', async () => {
    const f = fixture(), a = await f.start(1), b = await f.start(2);
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    assert.equal(f.current(), b.id);
    assert.equal(f.ensures.filter(id => id === b.id).length, 1);
    const old = (await f.status(1)).status;
    assert.equal(old.phase, 'stopped'); assert.equal(old.runnerLost, true); assert.equal(old.inflight, 0);
});

test('closing a previous reader cannot stop the current reader runner', async () => {
    const f = fixture(); await f.start(1); const b = await f.start(2);
    await f.close(1);
    assert.equal(f.current(), b.id);
    assert.equal(f.session['mtChapterTab:1'], undefined);
});

test('a superseded runner cannot publish over its stopped status or send stale reader updates', async () => {
    const f = fixture(), a = await f.start(1); await f.start(2);
    const before = structuredClone(f.records.get('status:' + a.id)), sent = f.pushes.length;
    const late = { ...before, phase: 'running', sequence: 100 };
    const response = await f.publish(a.id, late);
    assert.equal(response.ok, false);
    assert.deepEqual(f.records.get('status:' + a.id), before);
    assert.equal(f.pushes.length, sent);
});

test('different-tab starts serialize ownership while the first runner is attaching', async () => {
    const f = fixture(), ready = f.holdStart();
    const a = f.start(1); await tick();
    const b = f.start(2); await tick();
    const duringSetup = f.ensures.length;
    ready.resolve(true); const [first, last] = await Promise.all([a, b]);
    assert.equal(duringSetup, 1);
    assert.equal(first.ok, true); assert.equal(last.ok, true);
    assert.equal(f.current(), last.id);
});

test('duplicate starts from the same reader share its existing session', async () => {
    const f = fixture();
    const [a, duplicate] = await Promise.all([f.start(1), f.start(1)]);
    assert.equal(a.id, duplicate.id);
    const again = await f.start(1);
    assert.equal(again.id, a.id);
    assert.equal(f.ensures.length, 1);
});

test('an older publication from the current runner cannot roll back its saved progress', async () => {
    const f = fixture(), a = await f.start(1);
    const latest = { ...f.records.get('status:' + a.id), sequence: 3, phase: 'stopped' };
    assert.equal((await f.publish(a.id, latest)).ok, true);
    assert.equal((await f.publish(a.id, { ...latest, sequence: 2, phase: 'running' })).ok, true);
    assert.equal((await f.status(1)).status.phase, 'stopped');
});

test('failed attachment releases ownership and allows a fresh start', async () => {
    const f = fixture(); f.failSetup(true);
    assert.equal((await f.start(1)).ok, false);
    assert.equal(f.current(), '');
    assert.equal((await f.status(1)).status.runnerLost, true);
    f.failSetup(false);
    const retried = await f.start(1);
    assert.equal(retried.ok, true); assert.equal(f.current(), retried.id);
});
