// Unit tests for the original/translated toggle source choice and the
// blob-origin restore-copy gate (pure — no canvas).
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  stdin: {
    contents: [
      `export { shownSrc, ownCopyNeeded, OWN_COPY_MAX_PIXELS, readPage } from './src/content/page-io.ts';`
      + `\nexport { setOverlayOn, setDebugOn } from './src/content/state.ts';`,
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, format: 'esm', outfile: '.test-build/page-io.mjs', sourcemap: 'inline',
});

// state.ts computes contextChapter at import time (needs location)
globalThis.location = { origin: 'https://test.local', pathname: '/chapter/1', search: '', hash: '' };

const { shownSrc, ownCopyNeeded, OWN_COPY_MAX_PIXELS, readPage, setOverlayOn, setDebugOn } =
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
