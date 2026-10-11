import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

await build({ stdin: { contents: "export * from './src/cache/store'; export * from './src/cache-generation';",
    resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', outfile: '.test-build/cache-store-test.mjs' });
globalThis.chrome = { storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } } };

function open(version) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('mt-cache', version);
        request.onupgradeneeded = () => {
            if (version === 1) {
                const store = request.result.createObjectStore('pages', { keyPath: 'key' });
                store.createIndex('byAtime', 'atime');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
function complete(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = tx.onerror = () => reject(tx.error);
    });
}
const chapter = 'https://reader.test/chapter/123456';
function entry(key, extra = {}) {
    return { key, fp: 'recipe', w: 600, h: 800, boxes: [{ x1: 10, y1: 20, x2: 40, y2: 50, conf: 1 }],
        panels: [], outputs: [{ index: 1, source: 'source', translation: 'saved answer', spk: null }], extras: [],
        mask: { w: 1, h: 1, data: new Uint8Array([255]).buffer }, ...extra };
}
function aliases(order) {
    return [entry(`${chapter}@p${order}`, { order, keyGen: 1 }), entry(`${chapter}#hash${order}`, { order, keyGen: 1 })];
}

const legacy = await open(1);
const seed = legacy.transaction('pages', 'readwrite');
seed.objectStore('pages').put(entry(`${chapter}#legacy`, { atime: 1 }));
seed.objectStore('pages').put(entry(`${chapter}#pending`, { atime: 1, partial: true, outputs: [] }));
await complete(seed);
legacy.close();
const { cacheGet, cachePut, cachePutMany, cacheCount, cacheCountChapter, cacheClear, cacheDelete,
    cacheReady, cacheGeneration, acceptCacheGeneration, CACHE_MAX_BYTES } = await import('../.test-build/cache-store-test.mjs');
await cacheReady();
async function reset() { await cacheClear(); }

test('version-one pages survive the metadata upgrade; checkpoints are not counted as translated pages', async () => {
    assert.equal(await cacheCount(), 1);
    assert.equal(await cacheCountChapter(chapter), 1);
    assert.equal((await cacheGet(`${chapter}#legacy`)).outputs[0].translation, 'saved answer');
    assert.equal((await cacheGet(`${chapter}#pending`)).partial, true);
});

test('a cache read updates only metadata and cannot overwrite a concurrent fresh answer', async t => {
    await reset();
    const key = `${chapter}#read-write`;
    await cachePut(entry(key));
    const puts = [], original = IDBObjectStore.prototype.put;
    t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
        puts.push(this.name);
        return original.apply(this, args);
    });
    await cacheGet(key);
    assert.deepEqual(puts, ['metadata']);
    await Promise.all([cacheGet(key), cachePut(entry(key, { outputs: [{ index: 1, source: 'source', translation: 'new answer', spk: null }] }))]);
    assert.equal((await cacheGet(key)).outputs[0].translation, 'new answer');
});

test('late detect checkpoints cannot erase completed translations or richer OCR checkpoints', async () => {
    await reset();
    const full = entry(`${chapter}#full`);
    await cachePut(full);
    await cachePut({ ...full, partial: true, outputs: [], texts: ['late'] });
    assert.equal((await cacheGet(full.key)).partial, undefined);
    const pending = entry(`${chapter}#ocr`, { partial: true, outputs: [], texts: ['already read'] });
    await cachePut(pending);
    await cachePut({ ...pending, texts: [] });
    assert.deepEqual((await cacheGet(pending.key)).texts, ['already read']);
});

test('writing a matching translation preserves cleanup crops; changed erase plans drop them', async () => {
    await reset();
    const full = entry(`${chapter}#crops`), patches = [{ x1: 1, y1: 2, x2: 3, y2: 4, png: new ArrayBuffer(1) }];
    await cachePut({ ...full, patches, patchesGen: 4 });
    await cachePut(full);
    assert.equal((await cacheGet(full.key)).patches.length, 1);
    await cachePut({ ...full, outputs: [{ index: 1, source: 'source', translation: '', spk: null }] });
    assert.equal((await cacheGet(full.key)).patches, undefined);
    await cachePut({ ...full, patches, patchesGen: 4 });
    await cachePut({ ...full, mask: { w: 1, h: 1, data: new Uint8Array([0]).buffer } });
    assert.equal((await cacheGet(full.key)).patches, undefined);
});

test('the page cap counts aliases once and evicts a whole least-recently-used page', async t => {
    await reset();
    let time = 0;
    t.mock.method(Date, 'now', () => ++time);
    await cachePutMany(aliases(0), 2);
    await cachePutMany(aliases(1), 2);
    assert.equal(await cacheCount(), 2);
    await cacheGet(`${chapter}#hash0`);
    await cachePutMany(aliases(2), 2);
    assert.equal(await cacheCountChapter(chapter), 2);
    assert.ok(await cacheGet(`${chapter}@p0`));
    assert.equal(await cacheGet(`${chapter}@p1`), undefined);
    assert.equal(await cacheGet(`${chapter}#hash1`), undefined);
});

test('checkpoints have a separate bounded allowance and do not evict completed pages', async () => {
    await reset();
    await cachePutMany(aliases(0), 1);
    await cachePutMany(Array.from({ length: 201 }, (_, i) => entry(`${chapter}#pending${i}`, { partial: true, outputs: [] })), 1);
    assert.equal(await cacheCount(), 1);
    assert.ok(await cacheGet(`${chapter}@p0`));
    const d = await open(2), tx = d.transaction('metadata'), request = tx.objectStore('metadata').getAll();
    await complete(tx);
    assert.equal(request.result.filter(row => row.partial).length, 200);
    d.close();
});

test('counting and eviction never enumerate image payloads', async t => {
    await reset();
    const original = IDBObjectStore.prototype.getAll;
    t.mock.method(IDBObjectStore.prototype, 'getAll', function (...args) {
        assert.equal(this.name, 'metadata');
        return original.apply(this, args);
    });
    await cachePutMany(aliases(0));
    assert.equal(await cacheCount(), 1);
});

test('the byte allowance also bounds old persisted image payloads', async () => {
    await reset();
    await cachePutMany(aliases(0));
    const d = await open(2), tx = d.transaction('metadata', 'readwrite'), store = tx.objectStore('metadata');
    const request = store.get(`${chapter}#hash0`);
    request.onsuccess = () => store.put({ ...request.result, bytes: CACHE_MAX_BYTES });
    await complete(tx);
    d.close();
    await cachePutMany(aliases(1));
    assert.equal(await cacheCount(), 1);
    assert.equal(await cacheGet(`${chapter}#hash0`), undefined);
    assert.equal(await cacheGet(`${chapter}@p0`), undefined);
});

test('an abort after request success rolls back every alias and its metadata', async t => {
    await reset();
    const original = IDBObjectStore.prototype.put;
    t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
        const request = original.apply(this, args);
        if (this.name === 'metadata') request.addEventListener('success', () => this.transaction.abort(), { once: true });
        return request;
    });
    await cachePutMany(aliases(0));
    assert.equal(await cacheCount(), 0);
    assert.equal(await cacheGet(`${chapter}@p0`), undefined);
    assert.equal(await cacheGet(`${chapter}#hash0`), undefined);
});

test('a reset rejects delayed results and old generations across reopened readers', async () => {
    await reset();
    const old = cacheGeneration();
    await cachePut(entry(`${chapter}#old`), 200, old);
    await acceptCacheGeneration('after-clear');
    assert.equal(await cacheGet(`${chapter}#old`), undefined);
    await cachePut(entry(`${chapter}#delayed`), 200, old);
    await cachePutMany(aliases(0), 200, cacheGeneration());
    assert.equal(await cacheCount(), 1);
    assert.equal(await cacheGet(`${chapter}#delayed`), undefined);
    await cacheDelete(`${chapter}@p0`, old);
    assert.ok(await cacheGet(`${chapter}@p0`));
});

test('a blocked upgrade keeps one pending open and recovers after the older document closes', async t => {
    const previousFactory = globalThis.indexedDB;
    globalThis.indexedDB = new IDBFactory();
    t.after(() => { globalThis.indexedDB = previousFactory; });
    const older = await open(1);
    const originalOpen = indexedDB.open;
    let attempts = 0;
    t.mock.method(indexedDB, 'open', function (...args) { attempts++; return originalOpen.apply(this, args); });
    const blockedStore = await import('../.test-build/cache-store-test.mjs?blocked');
    assert.equal(await blockedStore.cacheCount(), 0);
    assert.equal(await blockedStore.cacheCount(), 0);
    assert.equal(attempts, 1);
    older.close();
    const upgraded = await open(2);
    upgraded.close();
    await blockedStore.cachePut(entry(`${chapter}#unblocked`));
    assert.ok(await blockedStore.cacheGet(`${chapter}#unblocked`));
});
