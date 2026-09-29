// Unit tests for the Translate-chapter priority phase. The two rules that decide
// whether a swept page is skipped (already owned by an auto/DOM/paint job) or
// pre-translated first (the reader's window) are pure functions, so they are
// pinned here; the sweep/queue glue around them stays on the E2E path.
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
// unique outfile: node --test runs suites in parallel (never share a build target)
await build({
  stdin: {
    contents: `export { priorityIndices, usableAnchor, ownedByPath, matchAnchor, samePagePath } from './src/content/page-cache.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, format: 'esm', outfile: '.test-build/sweep-priority.mjs', sourcemap: 'inline',
});

const { priorityIndices, usableAnchor, ownedByPath, matchAnchor, samePagePath } =
  await import(new URL('../.test-build/sweep-priority.mjs', import.meta.url).href);

const P5 = 'https://cdn-a.example.org/galleries/1/5.webp';
const P5_OTHER_HOST = 'https://cdn-b.example.org/galleries/1/5.webp';
const P6 = 'https://cdn-a.example.org/galleries/1/6.webp';

// ---- priorityIndices: the reader's window, clamped, unknown anchor → head ----
test('priorityIndices: reader page + pages ahead, clamped, unknown anchor → head', () => {
  assert.deepEqual(priorityIndices(10, 3, 4), [3, 4, 5, 6]); // reader at 3, window 4
  assert.deepEqual(priorityIndices(5, 4, 3), [4]);           // clamps at chapter end
  assert.deepEqual(priorityIndices(5, 3, 3), [3, 4]);
  assert.deepEqual(priorityIndices(5, 0, 2), [0, 1]);        // never behind the reader
  assert.deepEqual(priorityIndices(5, -1, 2), [0, 1]);       // unknown anchor → head
  assert.deepEqual(priorityIndices(5, 9, 2), [0, 1]);        // out-of-range → head
  assert.deepEqual(priorityIndices(0, 3, 4), []);            // empty chapter
  assert.deepEqual(priorityIndices(5, 3, 0), []);            // zero window
});

// ---- usableAnchor: parked anchor walks back, else -1 (head) ----
test('usableAnchor: parked anchor walks back to the nearest usable page, else -1', () => {
  const from = [0, 2, 3, 5]; // usable pages came from source indices
  assert.equal(usableAnchor(from, 3), 2);
  assert.equal(usableAnchor(from, 4), 2);   // 4 filtered out → nearest usable before it
  assert.equal(usableAnchor(from, 2), 1);
  assert.equal(usableAnchor(from, 0), 0);
  assert.equal(usableAnchor(from, 9), 3);   // out-of-range → last usable at/before
  assert.equal(usableAnchor(from, -1), -1); // unknown page → head
  assert.equal(usableAnchor([2, 3, 5], 1), -1); // page 0 parked → head fallback
  assert.equal(usableAnchor([], 3), -1);
});

// ---- ownedByPath: the ref-less (manifest) sweep item must see an owned twin ----
test('ownedByPath: nothing owns an unclaimed path', () => {
  assert.equal(ownedByPath(P5, null, [], []), false);
});

test('ownedByPath: the active job owns its page (and only its page)', () => {
  assert.equal(ownedByPath(P5, P5, [], []), true);
  assert.equal(ownedByPath(P6, P5, [], []), false);
});

test('ownedByPath: queued and paint-lane jobs both count', () => {
  assert.equal(ownedByPath(P5, null, [P6, P5], []), true);   // queued match
  assert.equal(ownedByPath(P5, null, [P6], [P5]), true);     // paint-lane match
  assert.equal(ownedByPath(P5, null, [P6], []), false);
});

test('ownedByPath: host-rotated twin matches, a different page never does', () => {
  assert.equal(samePagePath(P5, P5_OTHER_HOST), true);
  assert.equal(ownedByPath(P5_OTHER_HOST, P5, [], []), true);       // active on other host
  assert.equal(ownedByPath(P5_OTHER_HOST, null, [P5], []), true);   // queued on other host
  assert.equal(ownedByPath(P6, null, [P5], [P5_OTHER_HOST]), false); // page number decides
});

// ---- matchAnchor: the reader's page must be found even when the element src is gone ----
// Sweep items come from an API/manifest; the visible <img> may show a blob or a foreign
// host. Candidate order = [origOf(ref), refKey(ref)], so either src can anchor the window.
const ITEM5 = 'https://uploads.mangadex.org/data/h/5.png';
const ITEMS = ['https://uploads.mangadex.org/data/h/3.png', 'https://uploads.mangadex.org/data/h/4.png', ITEM5, 'https://uploads.mangadex.org/data/h/6.png'];
const BLOB = 'blob:https://mangadex.org/dead-blob';

test('matchAnchor: original URL anchors exactly', () => {
  assert.equal(matchAnchor(ITEMS, [ITEM5, BLOB]), 2);
});

test('matchAnchor: post-translate blob src falls back to the stored original', () => {
  // the element shows our blob (refKey would miss); origOf(ref) supplies the real URL
  assert.equal(matchAnchor(ITEMS, [BLOB]), -1);                 // blob alone never matches
  assert.equal(matchAnchor(ITEMS, [ITEM5]), 2);                 // the original candidate does
});

test('matchAnchor: host-rotated twin matches by path, foreign page does not', () => {
  const rotated = 'https://uploads2.mangadex.org/data/h/4.png';
  assert.equal(matchAnchor(ITEMS, [rotated]), 1);               // path equality across hosts
  assert.equal(matchAnchor(ITEMS, ['https://cdn.org/data/h/9.png']), -1);
});

test('matchAnchor: no candidates → -1 (priority window degrades to the chapter head)', () => {
  assert.equal(matchAnchor(ITEMS, []), -1);
});
