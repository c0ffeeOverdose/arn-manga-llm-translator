// Unit tests for the original/translated toggle source choice and the
// blob-origin restore-copy gate (pure — no canvas).
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';
import { bitmap, grayPage, installCanvas } from './helpers/image-fixture.mjs';

mkdirSync('.test-build', { recursive: true });
await build({
  stdin: {
    contents: [
      `export { shownSrc, ownCopyNeeded, OWN_COPY_MAX_PIXELS, readPage, writePage, healImgBinding } from './src/content/page-io.ts';`
      + `\nexport { setOverlayOn, setDebugOn } from './src/content/state.ts';`
      + `\nexport { identifyBitmap } from './src/image-identity.ts';`,
      `export { regPage, pages, retireBlob } from './src/content/state.ts';`,
      `export { cacheGeneration, acceptCacheGeneration } from './src/cache-generation.ts';`,
      `export { readView } from './src/content/page-identity.ts';`,
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, format: 'esm', outfile: '.test-build/page-io.mjs', sourcemap: 'inline',
});

// state.ts computes contextChapter at import time (needs location)
globalThis.location = { origin: 'https://test.local', pathname: '/chapter/1', search: '', hash: '' };

const { shownSrc, ownCopyNeeded, OWN_COPY_MAX_PIXELS, readPage, writePage, healImgBinding, identifyBitmap, setOverlayOn, setDebugOn,
  regPage, pages, retireBlob, readView, cacheGeneration, acceptCacheGeneration } =
  await import(new URL('../.test-build/page-io.mjs', import.meta.url).href);

function fakeState(extra = {}) {
  return {
    orig: 'blob:https://mangadex.org/dead-orig',
    translated: 'blob:https://ext/translated',
    ...extra,
  };
}

test('shownSrc: "Show original" prefers the extension-owned copy over the reader blob', () => {
  setDebugOn(false);
  setOverlayOn(false);
  assert.equal(shownSrc(fakeState({ origOwn: 'blob:https://ext/orig-copy' })), 'blob:https://ext/orig-copy');
  assert.equal(shownSrc(fakeState()), 'blob:https://mangadex.org/dead-orig', 'no copy → reader URL (old behavior)');
});

test('shownSrc: translated side and debug frames unchanged', () => {
  setDebugOn(false);
  setOverlayOn(true);
  assert.equal(shownSrc(fakeState({ origOwn: 'blob:https://ext/orig-copy' })), 'blob:https://ext/translated');
  setDebugOn(true);
  assert.equal(shownSrc(fakeState({ origOwn: 'blob:https://ext/orig-copy', debug: 'blob:https://ext/dbg' })), 'blob:https://ext/dbg');
  setOverlayOn(false);
  assert.equal(
    shownSrc(fakeState({ origOwn: 'blob:https://ext/orig-copy', debugOrig: 'blob:https://ext/dbgO' })),
    'blob:https://ext/dbgO', 'debug still wins on the original side');
  setDebugOn(false);
});

test('ownCopyNeeded: only blob origins under the strip cap', () => {
  assert.equal(ownCopyNeeded('blob:https://mangadex.org/x', 800, 1138), true);
  assert.equal(ownCopyNeeded('https://cdn/p.jpg', 800, 1138), false, 'https restores by re-assigning the URL');
  assert.equal(ownCopyNeeded('blob:https://x/strip', 800, 13650), false, `giant strips skip the copy (cap ${OWN_COPY_MAX_PIXELS})`);
  assert.equal(ownCopyNeeded('blob:https://x/edge', 2000, 2000), true, 'exactly at the cap is allowed');
  assert.equal(ownCopyNeeded('blob:https://x/edge2', 2001, 2000), false);
});

// re-translate used to decode the live <img>, which after a render shows our
// translated blob — the pipeline then re-detected and re-OCR'd its own drawing
// (live: VLM read nothing, all regions kept, page reported Done unchanged).
function imgEl(src, currentSrc = src) { return { src, currentSrc }; }

test('readPage: blob shown by the element still decodes locally (revoked-blob path)', async () => {
  const seen = [];
  globalThis.createImageBitmap = async (arg) => { seen.push(arg); return { width: 1, height: 1, close() {} }; };
  globalThis.fetch = async (url) => { seen.push('fetch:' + url); throw new Error('network down'); };
  const src = 'blob:https://mangadex.org/page';
  const el = imgEl(src);
  const r = await readPage({ kind: 'img', el }, src);
  assert.equal(r.bitmap.width, 1, 'element decode is the only path for revoked blobs');
  assert.deepEqual(seen, [el], 'no fetch attempt when the element shows the requested url');
});

test('readPage: element showing our render is not the source — fetch the stashed url', async () => {
  const seen = [];
  globalThis.createImageBitmap = async (arg) => { seen.push(arg); return { width: 7, height: 7, close() {} }; };
  globalThis.fetch = async (url) => {
    seen.push('fetch:' + url);
    return { ok: true, blob: async () => ({ arrayBuffer: async () => new Uint8Array([9]).buffer }) };
  };
  const orig = 'blob:https://mangadex.org/orig';
  const el = imgEl('blob:https://ext/translated');
  const r = await readPage({ kind: 'img', el }, orig);
  assert.equal(r.bytes.byteLength, 1);
  assert.equal(seen[0], 'fetch:' + orig, 'the original url is fetched');
  assert.ok(!seen.includes(el), 'the element (holding our translation) is never decoded');
});

test('readPage: dead stashed blob fails loud instead of screenshotting our own render', async () => {
  const msgs = [];
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  globalThis.fetch = async () => { throw new Error('Failed to fetch'); };
  globalThis.chrome = { runtime: { sendMessage: async (m) => { msgs.push(m?.type); return { ok: false, error: 'image fetch blocked' }; } } };
  const el = imgEl('blob:https://ext/translated');
  await assert.rejects(
    () => readPage({ kind: 'img', el }, 'blob:https://mangadex.org/dead'),
    /no longer available/,
  );
  assert.ok(!msgs.includes('mt:screenshot'), 'a screenshot here would photograph our translation');
});

test('canvas paint refuses a same-size redraw while its decode is pending', async () => {
    installCanvas(); setOverlayOn(true); setDebugOn(false);
    const original = bitmap(grayPage(1)), translated = bitmap(grayPage(2));
    let draws = 0;
    const el = { width: 600, height: 800, gray: original.gray, region: original.region,
        getContext: () => ({ drawImage() { draws++; } }) };
    const state = { orig: 'canvas:one', translatedBmp: translated,
        image: identifyBitmap(original), paintedImage: identifyBitmap(translated) };
    writePage({ kind: 'canvas', el, key: 'canvas:one' }, state);
    el.gray = grayPage(4);
    await new Promise(setImmediate);
    assert.equal(draws, 0, 'the queued callback must not overwrite new pixels');
});
test('canvas paint accepts verified original and translated pixels', async () => {
    installCanvas(); setOverlayOn(true); setDebugOn(false);
    const original = bitmap(grayPage(1)), translated = bitmap(grayPage(2));
    let draws = 0;
    const el = { width: 600, height: 800, gray: original.gray, region: original.region,
        getContext: () => ({ drawImage(bmp) { draws++; el.gray = bmp.gray; el.region = bmp.region; } }) };
    const state = { orig: 'canvas:one', translatedBmp: translated, origBmp: original,
        image: identifyBitmap(original), paintedImage: identifyBitmap(translated) };
    writePage({ kind: 'canvas', el, key: 'canvas:one' }, state);
    await new Promise(setImmediate);
    assert.equal(draws, 1);
    setOverlayOn(false);
    writePage({ kind: 'canvas', el, key: 'canvas:one' }, state);
    await new Promise(setImmediate);
    assert.equal(draws, 2);
    assert.deepEqual(el.gray, original.gray);
});

test('a source-only state after Clear remains readable without the revoked reader blob', async () => {
    const state = { orig: 'blob:revoked-source', origOwn: 'blob:owned-source', translated: 'blob:owned-source' };
    regPage(state);
    const seen = [];
    globalThis.fetch = async url => { seen.push(url); return { blob: async () => new Blob([new Uint8Array([7])]) }; };
    globalThis.createImageBitmap = async () => ({ width: 23, height: 31, close() {} });
    const result = await readPage({ kind: 'img', el: imgEl(state.origOwn) }, state.orig);
    assert.equal(result.bitmap.width, 23);
    assert.deepEqual(seen, [state.origOwn]);
    pages.clear();
});
test('a redrawn canvas cannot reuse original bytes from its old source-only state', async () => {
    installCanvas();
    const original = bitmap(grayPage(1));
    const state = { orig: 'canvas:recycled', translated: 'canvas:recycled',
        image: identifyBitmap(original), paintedImage: identifyBitmap(original) };
    regPage(state);
    const el = { width: 600, height: 800, gray: grayPage(4), region: original.region,
        toDataURL: () => 'data:image/png;base64,Bw==' };
    const seen = [];
    globalThis.createImageBitmap = async blob => { seen.push([...new Uint8Array(await blob.arrayBuffer())]); return bitmap(grayPage(4)); };
    await readPage({ kind: 'canvas', el, key: state.orig }, state.orig, new Uint8Array([9]).buffer);
    assert.deepEqual(seen, [[7]], 'read the new canvas, not the old stash');
    pages.clear();
});
test('turning off canvas debug recognizes our debug frame and restores the translation', async () => {
    installCanvas(); setOverlayOn(true); setDebugOn(true);
    const original = bitmap(grayPage(1)), translated = bitmap(grayPage(2)), debug = bitmap(grayPage(3));
    const el = { width: 600, height: 800, gray: original.gray, region: original.region,
        getContext: () => ({ drawImage(bmp) { el.gray = bmp.gray; el.region = bmp.region; } }) };
    const state = { orig: 'canvas:debug', translatedBmp: translated, debug: 'blob:debug', debugBmp: debug,
        image: identifyBitmap(original), paintedImage: identifyBitmap(translated) };
    await writePage({ kind: 'canvas', el, key: state.orig }, state);
    assert.deepEqual(el.gray, debug.gray);
    setDebugOn(false);
    await writePage({ kind: 'canvas', el, key: state.orig }, state);
    assert.deepEqual(el.gray, translated.gray);
});
test('a cache reset invalidates a canvas callback already waiting for its paint source', async () => {
    installCanvas(); setOverlayOn(true); setDebugOn(false);
    const token = cacheGeneration(), original = bitmap(grayPage(1)), translated = bitmap(grayPage(2));
    let draws = 0;
    const el = { width: 600, height: 800, gray: original.gray, region: original.region,
        getContext: () => ({ drawImage() { draws++; } }) };
    const state = { cacheEpoch: token, orig: 'canvas:late', translatedBmp: translated,
        image: identifyBitmap(original), paintedImage: identifyBitmap(translated) };
    const paint = writePage({ kind: 'canvas', el, key: state.orig }, state);
    await acceptCacheGeneration('reset');
    await paint;
    assert.equal(draws, 0);
    await acceptCacheGeneration(token);
});
test('a retired translated view cannot be decoded as an original after Clear', async () => {
    installCanvas();
    const state = { orig: 'blob:missing-original', translated: 'blob:missing-original' };
    regPage(state); retireBlob('blob:retired-render', state.orig);
    const pixels = bitmap(grayPage(2));
    const el = { src: 'blob:retired-render', currentSrc: 'blob:retired-render', complete: true, isConnected: true,
        naturalWidth: pixels.width, naturalHeight: pixels.height, pixels };
    await assert.rejects(() => readView({ kind: 'img', el }), /Original image is no longer available/);
    pages.clear();
});

test('healImgBinding rebinds the same page across a rendition/encoder change', async () => {
    installCanvas();
    pages.clear();
    // The page was translated from one rendition; the reader now mints another blob of the
    // SAME page at a different size (proportional) — it must rebind, not drop the binding.
    const source = bitmap(grayPage(4));
    const state = { orig: 'blob:dead-source', translated: 'blob:ext-translated',
        image: identifyBitmap(source), hash: 'h4' };
    regPage(state);
    const decoded = bitmap(grayPage(4), { width: 300, height: 400 }); // proportional, smaller
    const el = { src: 'blob:fresh-rendition', currentSrc: 'blob:fresh-rendition', complete: true, isConnected: true,
        naturalWidth: 300, naturalHeight: 400, pixels: decoded };
    globalThis.createImageBitmap = async () => decoded;
    await healImgBinding(el, state);
    assert.equal(pages.get('blob:fresh-rendition'), state, 'the fresh rendition must alias the state');
    pages.clear();
});

test('healImgBinding still drops a binding showing a DIFFERENT page', async () => {
    installCanvas();
    pages.clear();
    const state = { orig: 'blob:dead-source', translated: 'blob:ext-translated',
        image: identifyBitmap(bitmap(grayPage(4))), hash: 'h4' };
    regPage(state);
    const decoded = bitmap(grayPage(5), { width: 600, height: 800 }); // different art
    const el = { src: 'blob:recycled', currentSrc: 'blob:recycled', complete: true, isConnected: true,
        naturalWidth: 600, naturalHeight: 800, pixels: decoded };
    globalThis.createImageBitmap = async () => decoded;
    await healImgBinding(el, state);
    assert.equal(pages.get('blob:recycled'), undefined, 'a different page must never be bound');
    pages.clear();
});
