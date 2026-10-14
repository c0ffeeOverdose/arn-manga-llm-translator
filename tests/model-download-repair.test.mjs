import { build } from 'esbuild';
import { IDBFactory } from 'fake-indexeddb';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const result = await build({ entryPoints: ['src/llm/ocr-models.ts'], bundle: true, format: 'esm', write: false });
const { detDownload, detDelete, inpaintDownload, inpaintDelete, fetchWithProgress } =
    await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
const layoutResult = await build({ entryPoints: ['src/llm/layout-models.ts'], bundle: true, format: 'esm', write: false });
const { koharuDelete } =
    await import('data:text/javascript;base64,' + Buffer.from(layoutResult.outputFiles[0].contents).toString('base64'));
const old = { indexedDB: globalThis.indexedDB, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
after(() => { globalThis.indexedDB = old.indexedDB; globalThis.fetch = old.fetch; });

async function setup(entries) {
    globalThis.indexedDB = new IDBFactory();
    const db = await new Promise((resolve, reject) => {
        const q = indexedDB.open('mt-models', 1);
        q.onupgradeneeded = () => q.result.createObjectStore('m');
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
    });
    await new Promise((resolve, reject) => {
        const tx = db.transaction('m', 'readwrite');
        for (const [key, value] of entries) tx.objectStore('m').put(Uint8Array.of(value).buffer, key);
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error);
    });
    return {
        async value(key) {
            const bytes = await new Promise((resolve, reject) => {
                const q = db.transaction('m').objectStore('m').get(key);
                q.onsuccess = () => resolve(q.result);
                q.onerror = () => reject(q.error);
            });
            return new Uint8Array(bytes)[0];
        },
        close: () => db.close(),
    };
}

function fastRetries(t) {
    t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) =>
        old.setTimeout(fn, ms === 2000 || ms === 4000 ? 0 : ms, ...args));
}

test('automatic detection downloads reuse installed models; manual replacement fetches both files', async () => {
    const store = await setup([['ctd', 1], ['panel', 2]]);
    try {
        globalThis.fetch = () => { assert.fail('Existing models must not download automatically'); };
        await detDownload();
        const urls = [];
        globalThis.fetch = async (url, options) => {
            urls.push(url);
            assert.equal(options.cache, 'reload');
            return new Response(Uint8Array.of(url.includes('ctd-') ? 3 : 4));
        };
        await detDownload(undefined, true);
        assert.equal(urls.length, 2);
        assert.ok(urls[0].endsWith('/ctd-int8.onnx?download=true'));
        assert.ok(urls[1].endsWith('/panel-yolo26n.onnx?download=true'));
        assert.equal(await store.value('ctd'), 3);
        assert.equal(await store.value('panel'), 4);
    } finally { store.close(); }
});

test('failed detection replacement keeps the saved model and bounds retries', async t => {
    fastRetries(t);
    const store = await setup([['ctd', 1], ['panel', 2]]);
    try {
        let downloads = 0;
        globalThis.fetch = async () => { downloads++; throw new Error('Network unavailable'); };
        await assert.rejects(detDownload(undefined, true), /Network unavailable/);
        assert.equal(downloads, 3);
        assert.equal(await store.value('ctd'), 1);
        assert.equal(await store.value('panel'), 2);
    } finally { store.close(); }
});

test('text cleanup supports manual replacement while normal loads reuse the installed model', async () => {
    const store = await setup([['inpaint:manga512', 1]]);
    try {
        globalThis.fetch = () => { assert.fail('Existing cleanup model must not download automatically'); };
        await inpaintDownload();
        let downloads = 0;
        globalThis.fetch = async (url, options) => {
            downloads++;
            assert.ok(url.endsWith('/lama-manga-512-fp16w.onnx?download=true'));
            assert.equal(options.cache, 'reload');
            return new Response(Uint8Array.of(2));
        };
        await inpaintDownload(undefined, true);
        assert.equal(downloads, 1);
        assert.equal(await store.value('inpaint:manga512'), 2);
    } finally { store.close(); }
});

test('failed cleanup replacement preserves the previously saved file', async t => {
    fastRetries(t);
    const store = await setup([['inpaint:manga512', 1]]);
    try {
        globalThis.fetch = async () => { throw new Error('Network unavailable'); };
        await assert.rejects(inpaintDownload(undefined, true), /Network unavailable/);
        assert.equal(await store.value('inpaint:manga512'), 1);
    } finally { store.close(); }
});

for (const status of [401, 403, 429]) test(`HTTP ${status} stops immediately until a new download request`, async () => {
    let downloads = 0;
    globalThis.fetch = async () => { downloads++; return new Response('Unavailable', { status }); };
    await assert.rejects(fetchWithProgress('https://model.example.test/weights'), new RegExp(`HTTP ${status}`));
    assert.equal(downloads, 1);
});

const koharuKey = 'koharu-fp32-q256-35d89289e92a6dba';
const allModels = [['ctd', 1], ['panel', 2], ['inpaint:manga512', 3],
    [koharuKey, 4], ['baberu:vision4', 5], ['tess:jpn', 6]];

test('deleting CTD/Panel removes only that model group and performs no download', async () => {
    const store = await setup(allModels);
    try {
        globalThis.fetch = () => { assert.fail('Deleting models must not fetch'); };
        await detDelete();
        await detDelete();
        assert.equal(await store.value('ctd'), undefined);
        assert.equal(await store.value('panel'), undefined);
        for (const [key, value] of allModels.slice(2)) assert.equal(await store.value(key), value);
    } finally { store.close(); }
});

test('deleting cleanup removes only its saved file and leaves detection/OCR installed', async () => {
    const store = await setup(allModels);
    try {
        globalThis.fetch = () => { assert.fail('Deleting models must not fetch'); };
        await inpaintDelete();
        await inpaintDelete();
        assert.equal(await store.value('inpaint:manga512'), undefined);
        for (const [key, value] of allModels.filter(([key]) => key !== 'inpaint:manga512')) {
            assert.equal(await store.value(key), value);
        }
    } finally { store.close(); }
});

test('deleting Koharu also removes corrupt cached bytes without touching other models', async () => {
    const store = await setup(allModels);
    try {
        globalThis.fetch = () => { assert.fail('Deleting models must not fetch'); };
        await koharuDelete();
        await koharuDelete();
        assert.equal(await store.value(koharuKey), undefined);
        for (const [key, value] of allModels.filter(([key]) => key !== koharuKey)) {
            assert.equal(await store.value(key), value);
        }
    } finally { store.close(); }
});
