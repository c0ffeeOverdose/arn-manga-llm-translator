// Static guard for the adaptive region chunking in the content script.
//
// The work loop runs under chrome.runtime ports inside the page, so it cannot be
// unit-tested directly; these assertions pin the contract in the source instead.
// Context: requests were once capped at 6 regions because a big request could come
// back 200 with no content. The cap is gone — the whole page is tried first, and a
// starved reply halves the size for the rest of the script instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const OCR = readFileSync(new URL('../src/content/ocr.ts', import.meta.url), 'utf8');
const CACHE = readFileSync(new URL('../src/content/page-cache.ts', import.meta.url), 'utf8');
const STATUS = readFileSync(new URL('../src/content/status-ui.ts', import.meta.url), 'utf8');
const MODEL = readFileSync(new URL('../src/chapter/model.ts', import.meta.url), 'utf8');

test('adaptive chunk: no fixed per-request region cap, the whole page is tried first', () => {
  assert.doesNotMatch(CACHE, /LLM_REGIONS_PER_REQUEST/, 'the hardcoded 6 cap is gone');
  assert.match(OCR, /llmChunkSize \?\? Math\.max\(1, regions\.length\)/, 'first request carries the whole page');
  assert.match(OCR, /let llmChunkSize: number \| null = null/, 'the size is remembered per script instance');
});

test('adaptive chunk: a starved (parse) reply halves the size and retries the same regions', () => {
  assert.match(OCR, /kind === 'parse' && chunk\.length > 1/, 'only a parse-starved multi-region chunk splits');
  assert.match(OCR, /llmChunkSize = nextChunkSize\(chunk\.length\)/, 'the halved size is remembered');
  assert.match(OCR, /work\.unshift\(\.\.\.regionChunks\(chunk, llmChunkSize\)\)/, 'the same regions retry smaller');
});

test('adaptive chunk: a fresh user intent re-probes the whole page', () => {
  assert.match(OCR, /if \(opts\?\.fresh\) llmChunkSize = null/, 'Re-translate resets the remembered size');
});

test('adaptive chunk: the first split tells the reader, in human language', () => {
  // the split means wasted replies — surface it once per context (pill + popup log), no jargon
  assert.match(OCR, /opts\?\.onStarve\?\.\(\)/, 'the split reports itself to the caller');
  assert.match(STATUS, /export function starveNotice\(\)/, 'content contexts own the notice');
  assert.match(STATUS, /if \(starveNotified\) return;/, 'once per document');
  const noticeText = (STATUS.match(/const text = '([^']+)'/) ?? [])[1] ?? '';
  assert.ok(noticeText.length > 0, 'the notice text exists');
  assert.doesNotMatch(noticeText, /starve|chunk|sweep|fold/i, 'no internal jargon in the user-facing text');
  // the chapter runner routes the notice through its published progress instead
  assert.match(MODEL, /notice\?: string;/, 'progress carries a transient notice');
  assert.match(MODEL, /s\.notice \? `\$\{working\} · \$\{s\.notice\}` : working/, 'running message shows it');
});
