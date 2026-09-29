// Cancellation leases fence off late results without waiting for a hung stage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { build } from 'esbuild';

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
await build({ entryPoints: ['src/chapter/lifecycle.ts'], bundle: true, format: 'esm', outfile: '.test-build/chapter-lifecycle.mjs' });
const { Attempt } = await import('../.test-build/chapter-lifecycle.mjs');
const ocr = read('content/ocr.ts');
const detection = read('content/detection.ts');

test('Stop releases a hung stage immediately', async () => {
    const attempt = new Attempt(60000);
    const waiting = Promise.race([new Promise(() => {}), attempt.cancelled.then(() => 'stopped')]);
    attempt.cancel();
    assert.equal(await waiting, 'stopped');
    assert.equal(attempt.valid(), false);
});

test('translate RPC registers an abort handle and honours it', () => {
  assert.match(ocr, /const liveRpcs = new Set<LiveRpc>\(\)/);
  assert.match(ocr, /export function abortLiveRpcs\(\)/);
  assert.match(ocr, /stop\.abort = \(\) =>/, 'the port must expose an abort that disconnects + rejects');
  assert.match(ocr, /aborted/, 'a user abort must not be reported as a generic disconnect');
});

test('late results from a cancelled attempt cannot acquire a new attempt lease', async () => {
    const old = new Attempt(60000);
    let resolve;
    const page = new Promise(r => { resolve = r; });
    const committed = [];
    const late = page.then(value => { if (old.valid()) committed.push(value); });
    old.cancel();
    const next = new Attempt(60000);
    resolve('old result');
    await late;
    assert.deepEqual(committed, []);
    assert.equal(next.valid(), true);
    next.finish();
});

test('a deadline revokes the lease before reporting timeout, exactly once', async () => {
    let calls = 0;
    const attempt = new Attempt(5, () => { assert.equal(attempt.valid(), false); calls++; });
    await attempt.cancelled;
    attempt.cancel();
    assert.equal(calls, 1);
});

test('a timed-out detector iframe is torn down so the next call can rebuild', () => {
  const fn = detection.slice(detection.indexOf('function ensureIframe'));
  const timeout = fn.slice(fn.indexOf('setTimeout('));
  assert.match(timeout, /iframe\.remove\(\)/, 'the dead iframe must be removed');
  assert.match(timeout, /iframe = null/, 'the module must forget the dead element');
  assert.match(timeout, /ready = false/, 'readiness must be cleared so ensureIframe rebuilds');
});
