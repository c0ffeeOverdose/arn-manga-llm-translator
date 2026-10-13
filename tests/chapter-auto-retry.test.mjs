// A timeout-failed page earns exactly ONE automatic retry: re-queueing a stalled page is
// exactly what a manual retry does, but a page must never loop. The picker is pure so the
// bounded contract runs in Node instead of only inside the runner document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('/tmp/opencode', { recursive: true });
await build({ entryPoints: ['src/chapter/model.ts'], bundle: true, format: 'esm',
    outfile: '/tmp/opencode/chapter-model.mjs', logLevel: 'silent' });
const { pickRetryPages } = await import('/tmp/opencode/chapter-model.mjs');

const page = (id, phase, order) => ({ id, phase, order });

test('only failed, retryable, not-yet-retried pages are re-queued', () => {
    const pages = [page('a', 'failed'), page('b', 'ready'), page('c', 'waiting'), page('d', 'failed'), page('e', 'failed')];
    const retryable = new Set(['a', 'b', 'd', 'e']);
    const retried = new Set(['e']);
    assert.deepEqual(pickRetryPages(pages, retryable, retried).map(p => p.id), ['a', 'd'],
        'ready/waiting pages are never touched and a spent retry never re-enters');
});

test('a page that fails again after its retry stays failed', () => {
    const pages = [page('a', 'failed'), page('b', 'failed')];
    const retryable = new Set(['a', 'b']);
    const retried = new Set(['a']);
    assert.deepEqual(pickRetryPages(pages, retryable, retried).map(p => p.id), ['b']);
    retried.add('b'); // b just spent its retry and failed again
    assert.deepEqual(pickRetryPages(pages, retryable, retried), [], 'the second failure must stick');
});

test('pages failed for reasons outside the timeout class are never auto-retried', () => {
    const pages = [page('a', 'failed'), page('b', 'failed')];
    const retryable = new Set(['a']);
    assert.deepEqual(pickRetryPages(pages, retryable, new Set()).map(p => p.id), ['a']);
});
