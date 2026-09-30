// A module-scope await that throws kills the whole module from that line on. The inference
// worker registers its auth token at the END of its module, after a top-level `await
// initDebug()`, so anything that throws in between leaves the worker alive but unauthenticated
// — every RPC is then silently dropped and the run fails with "worker auth token missing".
// A Chromium offscreen document has no chrome.storage at all, which is exactly the case that
// broke chapter translation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const debug = readFileSync(new URL('../src/debug.ts', import.meta.url), 'utf8');

test('initDebug never throws when the context has no chrome.storage', () => {
    const fn = debug.slice(debug.indexOf('export async function initDebug'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    // Both storage touches must be guarded: the read AND the change listener.
    const read = body.indexOf('chrome.storage.local.get');
    const listener = body.indexOf('onChanged');
    assert.ok(read >= 0 && listener > read, 'initDebug reads the flag then subscribes');
    // The subscription must be optional-chained AND inside a try — a context without
    // chrome.storage throws on property access, not on the call.
    assert.match(body.slice(listener - 30, listener + 20), /chrome\.storage\?\.onChanged\?\./,
        'the change listener must tolerate a missing storage area');
    const guarden = body.slice(body.indexOf('onChanged') - 200, body.indexOf('onChanged'));
    assert.match(guarden, /try\s*\{/, 'the listener registration must sit inside a try');
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
