import 'fake-indexeddb/auto';
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

async function compile(broker) {
    return (await build({ stdin: { contents: `${broker ? "import './src/background/cache-broker';" : ''}
        export * from './src/cache/store'; export * from './src/cache-generation'; export * from './src/cache/wire';`,
        resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'iife', globalName: 'cacheApi', write: false })).outputFiles[0].text;
}
const backgroundCode = await compile(true), readerCode = await compile(false);
const generationKey = 'mtCacheGeneration';
const shared = { [generationKey]: '' }, handlers = [];
const runtimeId = 'cache-fixture';
const storage = { local: { get: async () => shared }, onChanged: { addListener() {} } };
function context(code, url, runtime) {
    const scope = { location: new URL(url), chrome: { runtime: { id: runtimeId, ...runtime }, storage },
        indexedDB, ArrayBuffer, Uint8Array, Uint8ClampedArray, DOMException, URL, URLSearchParams,
        setTimeout, clearTimeout, queueMicrotask, btoa, atob, console };
    runInNewContext(code, scope);
    return { api: scope.cacheApi, runtime: scope.chrome.runtime };
}
const background = context(backgroundCode, `chrome-extension://${runtimeId}/background.js`, {
    onMessage: { addListener(handler) { handlers.push(handler); } },
});
function reader(url) {
    return context(readerCode, url, { sendMessage: message => new Promise((resolve, reject) => {
        const sender = { id: runtimeId, tab: { id: 1, url }, url, frameId: 0 };
        const respond = response => resolve(JSON.parse(JSON.stringify(response)));
        const claimed = handlers.some(handler => handler(JSON.parse(JSON.stringify(message)), sender, respond) === true);
        if (!claimed) reject(new Error('Cache handler missing'));
    }) });
}
const chapter = 'https://reader.test/chapter/123456';
const client = reader(`${chapter}/1`);
const row = { key: `${chapter}#pixels`, fp: 'recipe', w: 4, h: 4,
    boxes: [{ x1: 0, y1: 0, x2: 3, y2: 3, conf: 1 }], panels: [], extras: [],
    outputs: [{ index: 1, source: 'source', translation: 'saved translation', spk: null }],
    mask: { w: 2, h: 2, data: Uint8Array.of(0, 255, 255, 0).buffer },
    patches: [{ x1: 0, y1: 0, x2: 3, y2: 3, png: Uint8Array.of(1, 2, 3, 4).buffer }], patchesGen: 4 };

test('reader and chapter contexts reuse one extension-origin result through JSON-safe messages', async () => {
    await background.api.cacheClear();
    await client.api.cacheReady();
    await client.api.cachePut(row);
    const runnerHit = await background.api.cacheGet(row.key);
    assert.equal(runnerHit.outputs[0].translation, 'saved translation');
    assert.deepEqual([...new Uint8Array(runnerHit.mask.data)], [0, 255, 255, 0]);
    const reopened = reader(`${chapter}/2`);
    const hit = await reopened.api.cacheGet(row.key);
    assert.deepEqual([...new Uint8Array(hit.patches[0].png)], [1, 2, 3, 4]);
    assert.equal(await reopened.api.cacheCountChapter(chapter), 1);
    await reopened.api.cacheClear();
    assert.equal(await background.api.cacheCount(), 1, 'view cleanup cannot clear the shared store');
});

test('reader messages cannot read or write another chapter', async () => {
    const other = reader('https://other.test/chapter/999001/1');
    await assert.rejects(other.api.cacheGet(row.key), /does not belong/);
    const reply = await other.runtime.sendMessage({ type: 'mt:translation-cache', op: 'put', cacheEpoch: '',
        entries: [background.api.encodeCache(row)] });
    assert.equal(reply.ok, false);
});

test('an unavailable cache transport is an error rather than permission to buy another translation', async () => {
    const silent = reader(`${chapter}/3`);
    silent.runtime.sendMessage = async () => { throw new Error('Saved translation channel unavailable'); };
    await assert.rejects(silent.api.cacheGet(row.key), /channel unavailable/);
});

test('wire roundtrips preserve binary cloud checkpoints as well as full cleanup crops', () => {
    const checkpoint = { ...row, partial: true, outputs: [], texts: ['OCR text'],
        cpatches: [{ ...row.patches[0], i: 0 }] };
    const restored = background.api.decodeCache(JSON.parse(JSON.stringify(background.api.encodeCache(checkpoint))));
    assert.equal(restored.cpatches[0].i, 0);
    assert.deepEqual([...new Uint8Array(restored.cpatches[0].png)], [1, 2, 3, 4]);
    assert.equal(restored.texts[0], 'OCR text');
});
