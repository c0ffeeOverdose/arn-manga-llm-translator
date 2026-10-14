import { build } from 'esbuild';
import { IDBFactory } from 'fake-indexeddb';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const result = await build({ entryPoints: ['src/llm/layout-models.ts'], bundle: true, format: 'esm', write: false });
const { importKoharuFile, loadKoharuFile, koharuDownload, koharuInstalled, validateKoharuFile } =
    await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
const old = { indexedDB: globalThis.indexedDB, chrome: globalThis.chrome, fetch: globalThis.fetch,
    crypto: Object.getOwnPropertyDescriptor(globalThis, 'crypto') };
after(() => {
    globalThis.indexedDB = old.indexedDB;
    globalThis.chrome = old.chrome;
    globalThis.fetch = old.fetch;
    if (old.crypto) Object.defineProperty(globalThis, 'crypto', old.crypto);
});

const bundleUrl = 'https://extension.test/models/koharu-fp32-chunked.onnx';
const mirrorUrl = 'https://huggingface.co/c0ffeeOverdose/arn-manga-models/resolve/main/koharu-fp32-chunked.onnx?download=true';
const digest = '35d89289e92a6dba75b9ccd4ebd447a55aad69c993d0a8e439c57509d598dfd6';
const modelBytes = new ArrayBuffer(149799163);

function setup() {
    globalThis.indexedDB = new IDBFactory();
    globalThis.chrome = { runtime: { getURL: file => `https://extension.test/${file}` } };
    globalThis.fetch = async () => { throw Error('No network source'); };
    mockHash(digest);
}

function mockHash(hash) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: {
        digest: async (algorithm, bytes) => {
            assert.equal(algorithm, 'SHA-256');
            const value = typeof hash === 'function' ? hash(bytes) : hash;
            return Uint8Array.from(value.match(/../g), v => parseInt(v, 16)).buffer;
        },
    } } });
}

async function seedStored(bytes) {
    const db = await new Promise((resolve, reject) => {
        const q = indexedDB.open('mt-models', 1);
        q.onupgradeneeded = () => q.result.createObjectStore('m');
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
    });
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction('m', 'readwrite');
            tx.objectStore('m').put(bytes, 'koharu-fp32-q256-35d89289e92a6dba');
            tx.oncomplete = resolve;
            tx.onerror = tx.onabort = () => reject(tx.error);
        });
    } finally { db.close(); }
}

test('availability and noDownload never contact the public mirror', async () => {
    setup();
    const urls = [];
    globalThis.fetch = async url => { urls.push(url); return { ok: false }; };
    assert.equal(await koharuInstalled(), 'missing');
    await assert.rejects(loadKoharuFile({ noDownload: true }), /Options → Model → Download/);
    assert.deepEqual(urls, [bundleUrl, bundleUrl]);
});

test('wrong-size imports leave the model store empty', async () => {
    setup();
    await assert.rejects(importKoharuFile(new ArrayBuffer(4)), /149.8 MB/);
    assert.equal(await koharuInstalled(), 'missing');
});

test('bundled availability does not depend on optional extension-resource headers', async () => {
    setup();
    globalThis.fetch = async () => ({ ok: true, headers: new Headers() });
    assert.equal(await koharuInstalled(), 'bundled');
});

test('checksum validation precedes persistence; imported models load offline', async () => {
    setup();
    mockHash('0'.repeat(64));
    await assert.rejects(importKoharuFile(modelBytes), /different Koharu/);
    assert.equal(await koharuInstalled(), 'missing');
    mockHash(digest);
    await validateKoharuFile(modelBytes);
    await importKoharuFile(modelBytes);
    globalThis.fetch = () => { assert.fail('Cached models must not fetch'); };
    assert.equal(await koharuInstalled(), 'cached');
    assert.equal((await loadKoharuFile({ noDownload: true })).byteLength, modelBytes.byteLength);
    await koharuDownload();
});

test('a development bundle is verified and cached before any mirror download', async () => {
    setup();
    const urls = [];
    globalThis.fetch = async url => {
        urls.push(url);
        return { ok: true, arrayBuffer: async () => modelBytes };
    };
    await koharuDownload();
    assert.deepEqual(urls, [bundleUrl]);
    assert.equal(await koharuInstalled(), 'cached');
});

test('first use downloads the supported mirror artifact with progress and reuses it offline', async () => {
    setup();
    const urls = [], progress = [];
    globalThis.fetch = async url => {
        urls.push(url);
        if (url === bundleUrl) return { ok: false };
        assert.equal(url, mirrorUrl);
        return new Response(new Uint8Array(modelBytes));
    };
    const bytes = await loadKoharuFile({ onProgress: (loaded, total) => progress.push([loaded, total]) });
    assert.equal(bytes.byteLength, modelBytes.byteLength);
    assert.deepEqual(urls, [bundleUrl, mirrorUrl]);
    assert.deepEqual(progress[0], [0, modelBytes.byteLength]);
    assert.deepEqual(progress.at(-1), [modelBytes.byteLength, modelBytes.byteLength]);
    globalThis.fetch = () => { assert.fail('Downloaded models must work offline'); };
    assert.equal(await koharuInstalled(), 'cached');
    await koharuDownload();
    assert.equal((await loadKoharuFile()).byteLength, modelBytes.byteLength);
});

test('wrong-size and wrong-checksum downloads are rejected without installing', async () => {
    setup();
    let downloaded = new ArrayBuffer(4);
    globalThis.fetch = async url => url === bundleUrl ? { ok: false } : new Response(new Uint8Array(downloaded));
    await assert.rejects(koharuDownload(), /149.8 MB/);
    assert.equal(await koharuInstalled(), 'missing');
    downloaded = modelBytes;
    mockHash('0'.repeat(64));
    await assert.rejects(koharuDownload(), /different Koharu/);
    assert.equal(await koharuInstalled(), 'missing');
});

test('corrupt cached bytes are repaired once from the mirror; noDownload never fetches remotely', async () => {
    setup();
    await seedStored(new ArrayBuffer(4));
    const urls = [];
    globalThis.fetch = async (url, options) => {
        urls.push(url);
        if (url === bundleUrl) return { ok: false };
        assert.equal(url, mirrorUrl);
        assert.equal(options.cache, 'reload');
        return new Response(new Uint8Array(modelBytes));
    };
    await assert.rejects(loadKoharuFile({ noDownload: true }), /149.8 MB/);
    assert.deepEqual(urls, [bundleUrl]);
    urls.length = 0;
    assert.equal((await loadKoharuFile()).byteLength, modelBytes.byteLength);
    assert.deepEqual(urls, [bundleUrl, mirrorUrl]);
    globalThis.fetch = () => { assert.fail('Repaired models must work offline'); };
    assert.equal((await loadKoharuFile({ noDownload: true })).byteLength, modelBytes.byteLength);
});

test('same-size checksum corruption is repaired before the model is returned', async () => {
    setup();
    const corrupt = modelBytes.slice(0);
    new Uint8Array(corrupt)[0] = 1;
    await seedStored(corrupt);
    mockHash(bytes => new Uint8Array(bytes)[0] ? '0'.repeat(64) : digest);
    let downloads = 0;
    globalThis.fetch = async url => {
        if (url === bundleUrl) return { ok: false };
        assert.equal(url, mirrorUrl);
        downloads++;
        return new Response(new Uint8Array(modelBytes));
    };
    const repaired = await loadKoharuFile();
    assert.equal(new Uint8Array(repaired)[0], 0);
    assert.equal(downloads, 1);
    globalThis.fetch = () => { assert.fail('Repair must replace the damaged cache'); };
    await loadKoharuFile();
});

test('explicit model refresh bypasses installed and bundled files and reloads the HTTP resource', async () => {
    setup();
    await importKoharuFile(modelBytes);
    const urls = [];
    globalThis.fetch = async (url, options) => {
        urls.push(url);
        assert.equal(options.cache, 'reload');
        return new Response(new Uint8Array(modelBytes));
    };
    await koharuDownload(undefined, true);
    assert.deepEqual(urls, [mirrorUrl]);
});

test('failed replacement keeps the previously verified model usable offline', async () => {
    setup();
    await importKoharuFile(modelBytes);
    let downloads = 0;
    globalThis.fetch = async () => { downloads++; return new Response(new Uint8Array(4)); };
    await assert.rejects(koharuDownload(undefined, true), /149.8 MB/);
    assert.equal(downloads, 1);
    globalThis.fetch = () => { assert.fail('A failed replacement must preserve the previous model'); };
    assert.equal((await loadKoharuFile({ noDownload: true })).byteLength, modelBytes.byteLength);
});

test('a damaged replacement fails without an automatic repair loop', async () => {
    setup();
    await seedStored(new ArrayBuffer(4));
    let downloads = 0;
    globalThis.fetch = async url => {
        if (url === bundleUrl) return { ok: false };
        downloads++;
        return new Response(new Uint8Array(4));
    };
    await assert.rejects(loadKoharuFile(), /149.8 MB/);
    assert.equal(downloads, 1);
});

test('an invalid development bundle falls through to the verified mirror artifact', async () => {
    setup();
    const urls = [];
    globalThis.fetch = async url => {
        urls.push(url);
        return new Response(new Uint8Array(url === bundleUrl ? new ArrayBuffer(4) : modelBytes));
    };
    assert.equal((await loadKoharuFile()).byteLength, modelBytes.byteLength);
    assert.deepEqual(urls, [bundleUrl, mirrorUrl]);
});

test('cryptography errors do not misclassify the installed model as corrupt or start a download', async () => {
    setup();
    await importKoharuFile(modelBytes);
    globalThis.crypto.subtle.digest = async () => { throw new Error('Crypto unavailable'); };
    globalThis.fetch = () => { assert.fail('Environment errors must not trigger model replacement'); };
    await assert.rejects(loadKoharuFile(), /Crypto unavailable/);
});
