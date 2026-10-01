import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

await build({ entryPoints: ['src/cache-generation.ts'], bundle: true, format: 'esm', outfile: '.test-build/cache-generation.mjs' });
const { cacheReady, cacheGeneration, cacheCurrent, assertCacheCurrent, acceptCacheGeneration, onCacheReset, CACHE_GENERATION_KEY } = await import('../.test-build/cache-generation.mjs');

test('persistent generation is loaded before new producers start', async () => {
    globalThis.chrome = { storage: { local: { get: async () => ({ [CACHE_GENERATION_KEY]: 'saved-generation' }) }, onChanged: { addListener() {} } } };
    assert.equal(await cacheReady(), 'saved-generation');
    assert.equal(cacheGeneration(), 'saved-generation');
});
test('reset invalidates late work immediately and awaits reader cleanup', async () => {
    const old = cacheGeneration();
    let release;
    const cleanup = new Promise(r => { release = r; });
    const remove = onCacheReset(() => cleanup);
    const reset = acceptCacheGeneration('new-generation');
    assert.equal(cacheCurrent(old), false);
    assert.throws(() => assertCacheCurrent(old), { name: 'AbortError' });
    let complete = false; reset.then(() => { complete = true; });
    await Promise.resolve(); assert.equal(complete, false);
    release(); await reset; assert.equal(complete, true);
    remove();
});
test('duplicate reset notifications join the same cleanup rather than restoring twice', async () => {
    let called = 0;
    const remove = onCacheReset(() => { called++; });
    await Promise.all([acceptCacheGeneration('once'), acceptCacheGeneration('once')]);
    assert.equal(called, 1);
    assert.equal(await cacheReady(), 'once');
    remove();
});
