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
      `export { shownSrc, ownCopyNeeded, OWN_COPY_MAX_PIXELS } from './src/content/page-io.ts';`,
      `export { setOverlayOn, setDebugOn } from './src/content/state.ts';`,
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, format: 'esm', outfile: '.test-build/page-io.mjs', sourcemap: 'inline',
});

// state.ts computes contextChapter at import time (needs location)
globalThis.location = { origin: 'https://test.local', pathname: '/chapter/1', search: '', hash: '' };

const { shownSrc, ownCopyNeeded, OWN_COPY_MAX_PIXELS, setOverlayOn, setDebugOn } =
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
