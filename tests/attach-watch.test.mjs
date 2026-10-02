// The broker must not hand the reader a session whose runner never attached; the watch is how
// long it waits and when it gives up instead. Timers are real but tiny.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

mkdirSync('.test-build', { recursive: true });
await build({ entryPoints: ['src/chapter/attach-watch.ts'], bundle: true, format: 'esm',
    outfile: '.test-build/attach-watch.mjs', logLevel: 'silent' });
const { AttachWatch } = await import('../.test-build/attach-watch.mjs');

test('AttachWatch: a hit before the wait resolves immediately', async () => {
    const w = new AttachWatch();
    w.hit('a');
    assert.equal(await w.wait('a', 1000), true);
});

test('AttachWatch: a wait resolves when the runner attaches', async () => {
    const w = new AttachWatch();
    const p = w.wait('b', 1000);
    w.hit('b');
    assert.equal(await p, true);
});

test('AttachWatch: two waits for one session both see the attach', async () => {
    const w = new AttachWatch();
    const a = w.wait('e', 1000), b = w.wait('e', 1000);
    w.hit('e');
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
});

test('AttachWatch: silence resolves false after the deadline', async () => {
    const w = new AttachWatch();
    const t0 = Date.now();
    assert.equal(await w.wait('c', 30), false);
    assert.ok(Date.now() - t0 >= 25);
});

test('AttachWatch: an attach after a timeout is not forgotten', async () => {
    const w = new AttachWatch();
    assert.equal(await w.wait('d', 10), false);
    w.hit('d');
    assert.equal(await w.wait('d', 10), true);
});
