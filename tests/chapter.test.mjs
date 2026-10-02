import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

await build({ entryPoints: ['src/chapter/context.ts'], bundle: true, format: 'esm', outfile: '.test-build/chapter-context.mjs' });
await build({ entryPoints: ['src/chapter/model.ts'], bundle: true, format: 'esm', outfile: '.test-build/chapter-model.mjs' });
await build({ entryPoints: ['src/chapter/discovery.ts'], bundle: true, format: 'esm', outfile: '.test-build/chapter-discovery.mjs' });
await build({ entryPoints: ['src/chapter/plan.ts'], bundle: true, format: 'esm', outfile: '.test-build/chapter-plan.mjs' });
const { replayLedger, replaceContribution, recordEdits } = await import('../.test-build/chapter-context.mjs');
const { remainingPages, chapterMessage, fetchSourceWithAlternate } = await import('../.test-build/chapter-model.mjs');
const { sameChapterDocument } = await import('../.test-build/chapter-discovery.mjs');
const { nextBatch, pagePhase } = await import('../.test-build/chapter-plan.mjs');
const empty = () => ({ base: { pairs: [], characters: [] }, entries: [], edits: [] });
const contribution = (order, translation = `page ${order}`) => ({ id: `page:${order}`, order, hash: `hash${order}`,
    outputs: [{ index: 1, source: `source ${order}`, translation }], mentions: [] });

test('chapter starts at the current page, never wraps to earlier pages', () => {
    assert.deepEqual(remainingPages([1, 2, 3, 4], 2), [3, 4]);
    assert.deepEqual(remainingPages([1, 2], -1), []);
    assert.deepEqual(remainingPages([1, 2], 2), []);
});
test('out-of-order completions and repaired gaps produce reading-order context', () => {
    const ledger = empty();
    replaceContribution(ledger, contribution(3));
    replaceContribution(ledger, contribution(1));
    assert.deepEqual(replayLedger(ledger, true, 40).pairs.map(p => p[1]), ['page 1', 'page 3']);
    replaceContribution(ledger, contribution(2));
    assert.deepEqual(replayLedger(ledger, true, 40).pairs.map(p => p[1]), ['page 1', 'page 2', 'page 3']);
});
test('cache replay is idempotent; retranslation replaces its page without deleting later pages', () => {
    const ledger = empty();
    for (const n of [1, 2, 3, 2, 1]) replaceContribution(ledger, contribution(n));
    replaceContribution(ledger, contribution(2, 'corrected'));
    assert.deepEqual(replayLedger(ledger, true, 40).pairs.map(p => p[1]), ['page 1', 'corrected', 'page 3']);
    assert.deepEqual(replayLedger(ledger, true, 40, 2).pairs.map(p => p[1]), ['page 1']);
});
test('parallel character guesses resolve by reading order, not completion order', () => {
    const ledger = empty();
    const one = contribution(1), two = contribution(2);
    one.mentions = [{ name: 'Aki', gender: 'M', desc: 'Student' }];
    two.mentions = [{ name: 'Aki', gender: 'F', desc: 'Student' }];
    replaceContribution(ledger, two);
    replaceContribution(ledger, one);
    assert.equal(replayLedger(ledger, true, 40).characters[0].gender, 'M');
});
test('user edits and deletions survive a late page and a retranslation', () => {
    const ledger = empty();
    const one = contribution(1);
    one.mentions = [{ name: 'Aki', gender: 'M', desc: 'Student' }];
    replaceContribution(ledger, one);
    const before = replayLedger(ledger, true, 40);
    const edited = structuredClone(before);
    edited.characters[0] = { ...edited.characters[0], gender: 'F', source: 'user' };
    recordEdits(ledger, before, edited);
    replaceContribution(ledger, one);
    replaceContribution(ledger, contribution(2));
    assert.equal(replayLedger(ledger, true, 40).characters[0].gender, 'F');
    recordEdits(ledger, edited, { pairs: [], characters: [] });
    replaceContribution(ledger, one);
    assert.deepEqual(replayLedger(ledger, true, 40).characters, []);
});
test('status distinguishes ready pages, failures and incomplete discovery', () => {
    const s = { done: 2, total: 4, errors: 1, inflight: 1, phase: 'running' };
    assert.equal(chapterMessage(s), '2 of 4 pages ready to read · Working on 1 page');
    assert.match(chapterMessage({ ...s, phase: 'waiting' }), /Waiting for more page images/);
    assert.doesNotMatch(chapterMessage({ ...s, phase: 'complete' }), /complete/);
});
test('a 404 on the preferred encoding retries the sibling of the SAME page', async () => {
    const tried = [];
    const load = url => {
        tried.push(url);
        return url === 'saver-6' ? Promise.resolve('pixels') : Promise.reject(new Error('HTTP 404'));
    };
    const retries = [];
    assert.equal(await fetchSourceWithAlternate('data-6', 'saver-6', load, m => retries.push(m)), 'pixels');
    assert.deepEqual(tried, ['data-6', 'saver-6']);
    assert.deepEqual(retries, ['HTTP 404']);
});
test('a 404 with no sibling still fails the page (never a silent blank)', async () => {
    const tried = [];
    const load = url => { tried.push(url); return Promise.reject(new Error('HTTP 404')); };
    await assert.rejects(() => fetchSourceWithAlternate('data-6', undefined, load), /HTTP 404/);
    assert.deepEqual(tried, ['data-6'], 'no alternate means exactly one attempt');
});
test('a healthy preferred encoding never touches the sibling', async () => {
    const tried = [];
    const load = url => { tried.push(url); return Promise.resolve('pixels'); };
    assert.equal(await fetchSourceWithAlternate('data-6', 'saver-6', load), 'pixels');
    assert.deepEqual(tried, ['data-6']);
});
test('document pagination cannot leave the current chapter or origin', () => {
    const reader = 'https://reader.test/chapter/one/2';
    const chapter = 'https://reader.test/chapter/one';
    assert.equal(sameChapterDocument('/chapter/one/3', reader, chapter), true);
    assert.equal(sameChapterDocument('/chapter/two/1', reader, chapter), false);
    assert.equal(sameChapterDocument('https://other.test/chapter/one/3', reader, chapter), false);
    assert.equal(sameChapterDocument('javascript:alert(1)', reader, chapter), false);
});
const pages = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, order: i }));
test('every queued page is eventually planned — the drain must not stop after one batch', () => {
    const seen = [];
    const phases = pages(7).map(() => 'queued');
    let batch;
    while ((batch = nextBatch(phases, pages(7), { perBatch: 3, priority: '' })).length) {
        for (const b of batch) { seen.push(b.order); phases[b.order] = 'ready'; }
    }
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6]);
});
test('a page that finished on its own is never planned twice', () => {
    const phases = ['ready', 'queued', 'failed', 'queued', 'ready'];
    assert.deepEqual(nextBatch(phases, pages(4), { perBatch: 3, priority: '' }).map(b => b.order), [1, 3]);
});
test('the page the reader is on is planned first, and the batch stays bounded', () => {
    const phases = pages(6).map(() => 'queued');
    assert.deepEqual(nextBatch(phases, pages(6), { perBatch: 3, priority: 'p3' }).map(b => b.order), [3, 0, 1]);
});
test('a waiting page is skipped, never allowed to stall the queue', () => {
    // Holding every page behind a pixel-waiting one left a chapter stuck part-way
    // (observed as "18 of 27 ready" with a page still "waiting"). The waiting page
    // keeps its phase; the rest of the chapter proceeds.
    assert.deepEqual(nextBatch(['waiting', 'queued'], pages(2), { perBatch: 3, priority: '' }).map(b => b.order), [1]);
    assert.deepEqual(nextBatch(['waiting', 'queued', 'queued'], pages(3), { perBatch: 3, priority: '' }).map(b => b.order), [1, 2]);
    // Only waiting pages left → nothing to plan, and the caller stops cleanly.
    assert.deepEqual(nextBatch(['waiting', 'waiting'], pages(2), { perBatch: 3, priority: '' }), []);
    assert.equal(pagePhase('waiting'), 'waiting');
    assert.equal(pagePhase('rendering'), 'rendering');
    assert.equal(pagePhase('ready'), 'ready');
});
