import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const bundle = await build({ entryPoints: ['src/chapter/log.ts'], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
const { sanitizeChapterEvent, chapterLogError, updateChapterLogPage, chapterLogSummary, formatChapterLog } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('chapter events whitelist metadata and drop credentials, URLs, replies and images', () => {
    const event = sanitizeChapterEvent({ kind: 'cloud-sent', stage: 'cloudWait', pages: [1, 1, 2, -1, Infinity], at: 1000,
        w: 1700, h: 2480, status: 200, bytes: 20000, engine: 'cloud', textSource: 'page',
        apiKey: 'PRIVATE_KEY', endpoint: 'https://reader.test/private', image: 'PRIVATE_IMAGE', raw: 'PRIVATE_REPLY',
        message: 'PRIVATE_SOURCE', request: 'https://reader.test/private' });
    assert.deepEqual(event.pages, [1, 2]);
    assert.equal(event.request, undefined);
    assert.equal(event.w, 1700);
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_|reader\.test/);
    assert.equal(sanitizeChapterEvent({ kind: 'PRIVATE_EVENT' }), undefined);
    assert.equal(sanitizeChapterEvent({ kind: 'stage', stage: 'toString' }).stage, undefined);
    assert.equal(sanitizeChapterEvent({ kind: 'stage', w: Infinity, ms: -1 }).w, undefined);
});

test('chapter errors retain a fixed reason and HTTP status, never the provider body', () => {
    assert.deepEqual(chapterLogError({ name: 'BackgroundTimeoutError', message: 'PRIVATE_TOKEN https://reader.test/key' }), { reason: 'background-timeout' });
    assert.deepEqual(chapterLogError({ kind: 'cloud', message: 'Cloud detect failed: cloud HTTP 503: PRIVATE_SOURCE' }), { reason: 'cloud', status: 503 });
    assert.doesNotMatch(JSON.stringify(chapterLogError({ kind: 'PRIVATE_KIND', message: 'PRIVATE_REPLY' })), /PRIVATE_/);
});

test('unfinished chapter requests show current wait and distinguish missing receipt from server wait', () => {
    let page = updateChapterLogPage(undefined, 4, { kind: 'cloud-sent', stage: 'cloudWait', request: 'abc', at: 1000 });
    const head = { id: 'run', build: 'test-build', phase: 'running', done: 0, total: 172, updatedAt: 1000, startedAt: 0 };
    const report = (capturedAt = 109000) => ({ schema: 1, capturedAt, head, pages: [page], events: [] });
    assert.match(chapterLogSummary(report()), /Page 4: Waiting for Cloud reply · 108\.0s/);
    assert.match(chapterLogSummary(report()), /No background receipt recorded/);
    page = updateChapterLogPage(page, 4, { kind: 'cloud-sent', stage: 'cloudWait', request: 'abc', deadlineMs: 160_000, at: 1000 });
    assert.match(chapterLogSummary(report()), /Client wait limit 2m 40s/);
    page = updateChapterLogPage(page, 4, { kind: 'cloud-received', request: 'abc', at: 1100 });
    assert.match(chapterLogSummary(report()), /Background received the request/);
    page = updateChapterLogPage(page, 4, { kind: 'cloud-http-start', request: 'abc', deadlineMs: 90_000, at: 1200 });
    assert.match(chapterLogSummary(report()), /Background sent the request; no reply/);
    assert.match(chapterLogSummary(report(300_000)), /Past the 2m 40s client wait limit/);
    assert.match(chapterLogSummary(report(300_000)), /Server request cap 1m 30s/);
    assert.equal(page.cloud.clientDeadlineMs, 160_000);
    assert.equal(page.cloud.serverDeadlineMs, 90_000);
    page = updateChapterLogPage(page, 4, { kind: 'cloud-http-reply', request: 'abc', status: 200, at: 1300 });
    assert.match(chapterLogSummary(report()), /Server replied \(HTTP 200\); background result not yet recorded/);
    page = updateChapterLogPage(page, 4, { kind: 'cloud-response', request: 'abc', at: 1400 });
    assert.match(chapterLogSummary(report()), /Background returned a result/);
    assert.match(formatChapterLog(report()), /^Arn Manga chapter translation log/);
});

test('late cloud replies cannot replace a newer request and completed durations stay stable', () => {
    let page = updateChapterLogPage(undefined, 1, { kind: 'stage', stage: 'image', at: 1000 });
    page = updateChapterLogPage(page, 1, { kind: 'cloud-sent', stage: 'cloudWait', request: 'abc', at: 1200 });
    page = updateChapterLogPage(page, 1, { kind: 'cloud-sent', stage: 'cloudWait', request: 'def', at: 1300 });
    page = updateChapterLogPage(page, 1, { kind: 'cloud-http-reply', request: 'abc', status: 500, at: 1400 });
    assert.equal(page.cloud.request, 'def');
    assert.equal(page.cloud.status, undefined);
    page = updateChapterLogPage(page, 1, { kind: 'page-ready', at: 1500 });
    assert.equal(page.state, 'ready');
    assert.equal(page.ms.image, 200);
    assert.equal(page.ms.cloudWait, 300);
    const before = structuredClone(page);
    page = updateChapterLogPage(page, 1, { kind: 'cloud-response', request: 'abc', at: 9000 });
    assert.equal(page.endedAt, 1500);
    assert.deepEqual(page.ms, before.ms);
});
