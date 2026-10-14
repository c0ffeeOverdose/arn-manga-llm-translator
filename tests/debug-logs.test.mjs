import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { compileBoundary, boundary, evaluate, elements, tick, deferred } from './helpers/ux-fixture.mjs';

const logCode = await compileBoundary('src/chapter/log-store.ts', {
    real: ['./log', '../debug'], extra: `export { setDebug } from '../debug';`,
});
const popupCode = await compileBoundary('src/popup/popup.ts', {
    real: ['../debug'], extra: `export { refreshStatus, refreshChapterLog }; export { setDebug } from '../debug';`,
});
const chromeDebug = () => ({ runtime: { id: 'fixture-extension', onMessage: { addListener() {} } },
    storage: { local: { get: async () => ({ mtDebug: false }), set: async () => {} }, onChanged: { addListener() {} } } });

test('Debug off neither opens the chapter log database nor records or reads history', async () => {
    const indexedDB = new IDBFactory();
    const log = evaluate(logCode, {}, { chrome: chromeDebug(), indexedDB, IDBKeyRange, crypto: webcrypto, TextEncoder });
    assert.equal(await log.createChapterLog(1, 'https://reader.test/chapter/123456', 'fixture', 'browser'), '');
    await log.appendChapterLog('run', { kind: 'stage', stage: 'image' });
    log.recordChapterLog({ logId: 'run' }, { kind: 'stage', stage: 'render' });
    await log.recordChapterWorkerWake();
    assert.equal(await log.latestChapterLogHead(), undefined);
    assert.equal(await log.readChapterLog('run'), undefined);
    assert.equal(await log.chapterLogOwned('run', 1, 'https://reader.test/chapter/123456'), false);
    assert.deepEqual(await indexedDB.databases(), []);
});

test('chapter logging follows live Debug changes and ignores late writes after disabling', async () => {
    const log = evaluate(logCode, {}, { chrome: chromeDebug(), indexedDB: new IDBFactory(), IDBKeyRange, crypto: webcrypto, TextEncoder });
    await log.latestChapterLogHead();
    log.setDebug(true);
    const id = await log.createChapterLog(1, 'https://reader.test/chapter/123456', 'fixture', 'browser');
    assert.ok(id);
    await log.appendChapterLog(id, { kind: 'stage', stage: 'image' });
    const pending = log.appendChapterLog(id, { kind: 'stage', stage: 'render' });
    log.setDebug(false);
    await pending;
    await log.appendChapterLog(id, { kind: 'stage', stage: 'llmWait' });
    await log.recordChapterWorkerWake();
    assert.equal(await log.readChapterLog(id), undefined);
    log.setDebug(true);
    const report = await log.readChapterLog(id);
    assert.equal(report.events.length, 1);
    assert.equal(report.events[0].stage, 'image');
});

function popupFixture() {
    const dom = elements(), copies = [], reads = { head: 0, report: 0 };
    let pendingReport;
    const fixture = boundary({
        sessGet: async () => ({ mtErrLog: [{ t: 1, msg: 'Translation paused' }] }),
        latestChapterLogHead: async () => { reads.head++; return { id: 'run' }; },
        readChapterLog: async () => { reads.report++; return pendingReport ? pendingReport.promise : {}; },
        autoSiteOf: () => 'https://reader.test', isAutoSite: () => false, loadPipelineSettings: () => ({ prefetchN: 3 }),
        TIMING_LABELS: {}, timingSeconds: ms => `${ms}ms`, formatPageTiming: () => 'Timing report',
        chapterLogSummary: () => 'Technical details', formatChapterLog: () => 'Chapter log',
    });
    const chrome = chromeDebug();
    chrome.tabs = { query: async () => [{ id: 1, url: 'https://reader.test/chapter/123456' }], sendMessage: async (_, message) =>
        message.type === 'mt:status' ? { ok: true, busy: true, viewedActive: true, queued: 0,
            loaded: 1, translated: 0, status: 'Translation paused', autoPaused: false,
            pageTiming: { state: 'done', elapsedMs: 20, meta: {}, ms: {}, build: 'fixture' },
            sweep: { active: false, errors: 1, done: 0, total: 1, message: 'Translation paused', diagnostics: 'Technical breadcrumb' } }
            : { ok: true, count: 1 } };
    const popup = evaluate(popupCode, fixture, { document: dom.document, chrome,
        window: { addEventListener() {} }, navigator: { clipboard: { writeText: async text => { copies.push(text); } } },
        setInterval: () => 1, clearInterval() {} });
    return { dom, popup, copies, reads, holdReport() { pendingReport = deferred(); return pendingReport; } };
}

test('normal popup hides logs and status while preserving Stop; Debug reveals diagnostic tools', async () => {
    const f = popupFixture(); await tick(); await f.popup.refreshStatus();
    assert.equal(f.reads.head, 0);
    assert.equal(f.dom.$('statusSection').style.display, 'none');
    assert.equal(f.dom.$('timingWrap').style.display, 'none');
    assert.equal(f.dom.$('chapterLogWrap').hidden, true);
    assert.equal(f.dom.$('errors').textContent, '');
    assert.equal(f.dom.$('cancelAll').style.display, '');
    assert.equal(f.dom.$('translate').textContent, 'Stop this page');
    await f.dom.$('timingCopy').onclick(); await f.dom.$('chapterLogCopy').onclick();
    assert.deepEqual(f.copies, []);
    f.popup.setDebug(true); await tick(); await f.popup.refreshStatus(); await f.popup.refreshChapterLog();
    assert.equal(f.dom.$('statusSection').style.display, '');
    assert.equal(f.dom.$('timingWrap').style.display, '');
    assert.equal(f.dom.$('chapterLogWrap').hidden, false);
    assert.match(f.dom.$('errors').textContent, /Recent errors/);
    assert.match(f.dom.$('sweepDetails').textContent, /Technical breadcrumb/);
    await f.dom.$('chapterLogCopy').onclick();
    assert.deepEqual(f.copies, ['Chapter log']);
});

test('disabling Debug hides open logs immediately and rejects an in-flight report result', async () => {
    const f = popupFixture(); await tick();
    f.popup.setDebug(true); await tick(); await f.popup.refreshChapterLog();
    f.dom.$('chapterLogWrap').open = true;
    const report = f.holdReport();
    const pending = f.popup.refreshChapterLog(); await tick();
    assert.equal(f.reads.report, 1);
    f.popup.setDebug(false);
    assert.equal(f.dom.$('chapterLogWrap').hidden, true);
    assert.equal(f.dom.$('chapterLogWrap').open, false);
    assert.equal(f.dom.$('statusSection').style.display, 'none');
    report.resolve({}); await pending; await tick();
    assert.equal(f.dom.$('chapterLogBody').textContent, '');
    assert.equal(f.dom.$('timingWrap').style.display, 'none');
    assert.equal(f.dom.$('errors').textContent, '');
    await f.dom.$('chapterLogCopy').onclick(); assert.deepEqual(f.copies, []);
});
