// The handshake token read happens right after the worker signals ready; a service worker
// caught mid-wake can miss it once, and a null token used to fail every inference call in the
// document until a reload. The asker is injected so the retry contract is testable.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

mkdirSync('.test-build', { recursive: true });
await build({ entryPoints: ['src/content/worker-token.ts'], bundle: true, format: 'esm',
    outfile: '.test-build/worker-token.mjs', logLevel: 'silent' });
const { fetchWorkerToken } = await import('../.test-build/worker-token.mjs');

test('fetchWorkerToken: a transient miss is retried until the token arrives', async () => {
    let calls = 0;
    const ask = async () => (++calls < 3 ? { token: null } : { token: 'abc' });
    assert.equal(await fetchWorkerToken('n1', 3, 1, ask), 'abc');
    assert.equal(calls, 3);
});

test('fetchWorkerToken: a throwing asker is retried, not fatal', async () => {
    let calls = 0;
    const ask = async () => { if (++calls < 2) throw new Error('sw asleep'); return { token: 'xyz' }; };
    assert.equal(await fetchWorkerToken('n1', 3, 1, ask), 'xyz');
    assert.equal(calls, 2);
});

test('fetchWorkerToken: still-null after the tries returns null', async () => {
    let calls = 0;
    const ask = async () => { calls++; return undefined; };
    assert.equal(await fetchWorkerToken('n1', 3, 1, ask), null);
    assert.equal(calls, 3);
});

test('fetchWorkerToken: a bad nonce never asks', async () => {
    let calls = 0;
    assert.equal(await fetchWorkerToken(undefined, 3, 1, async () => { calls++; return { token: 'x' }; }), null);
    assert.equal(calls, 0);
});
