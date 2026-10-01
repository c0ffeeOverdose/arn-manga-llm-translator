// A module-scope await that throws kills the whole module from that line on. The inference
// worker registers its auth token at the END of its module, after a top-level `await
// initDebug()`, so anything that throws in between leaves the worker alive but unauthenticated
// — every RPC is then silently dropped and the run fails with "worker auth token missing".
// A Chromium offscreen document has no chrome.storage at all, which is exactly the case that
// broke chapter translation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

await build({ entryPoints: ['src/debug.ts'], bundle: true, format: 'esm', outfile: '.test-build/worker-debug.mjs' });
const loadDebug = name => import(new URL(`../.test-build/worker-debug.mjs?${name}`, import.meta.url).href);

test('initDebug never throws when the context has no chrome.storage or runtime', async () => {
    globalThis.chrome = {};
    const debug = await loadDebug('no-storage');
    await debug.initDebug();
    assert.equal(debug.isDebug(), false);
});
test('a debug change during the initial read cannot be overwritten by a stale stored flag', async () => {
    let changed, resolveRead;
    globalThis.chrome = { storage: { local: { get: () => new Promise(r => { resolveRead = r; }) },
        onChanged: { addListener: fn => { changed = fn; } } } };
    const debug = await loadDebug('read-race');
    const flips = [];
    const ready = debug.initDebug(v => flips.push(v));
    changed({ mtDebug: { newValue: true } }, 'local');
    resolveRead({ mtDebug: false });
    await ready;
    assert.equal(debug.isDebug(), true);
    assert.deepEqual(flips, [true]);
});
test('offscreen debug follows authenticated runtime updates without storage events', async () => {
    let message;
    globalThis.chrome = { runtime: { id: 'test-extension', onMessage: { addListener: fn => { message = fn; } } } };
    const debug = await loadDebug('runtime');
    const flips = [];
    await debug.initDebug(v => flips.push(v));
    message({ type: 'mt:debug-state', on: true }, { id: 'foreign-extension' });
    assert.equal(debug.isDebug(), false);
    message({ type: 'mt:debug-state', on: true }, { id: 'test-extension' });
    assert.equal(debug.isDebug(), true);
    message({ type: 'mt:debug-state', on: false }, { id: 'test-extension' });
    assert.equal(debug.isDebug(), false);
    assert.deepEqual(flips, [true, false]);
});

test('the worker registers its token after every top-level await', () => {
    const worker = readFileSync(new URL('../src/iframe/worker.ts', import.meta.url), 'utf8');
    const register = worker.indexOf('mt:worker-token');
    assert.ok(register > 0, 'the worker must register a handshake token');
    // Every top-level await must either precede the registration or be wrapped so it
    // cannot abort the module.
    for (const m of worker.matchAll(/^await ([a-zA-Z_$][\w$]*)\(\);/gm)) {
        assert.ok(m.index < register,
            `top-level await ${m[1]}() sits after the token registration`);
    }
});
