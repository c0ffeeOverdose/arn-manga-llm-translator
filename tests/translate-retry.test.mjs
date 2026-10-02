// Static guard for the translate retry ladder in background.ts.
//
// Incident: only the first translate call passed `retryEmpty=true`. When the
// provider answered 200 with empty content on the missing-region or full-page
// retry, that leg returned '' immediately, parsed to zero regions, and the whole
// page failed with "No usable text regions parsed" — the retry existed but could
// never fire on the legs that needed it most.
//
// Background cannot be unit-tested (chrome.runtime ports + a real SW), so this
// reads the source and pins the contract instead of silently regressing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const BG = readFileSync(new URL('../src/background/background.ts', import.meta.url), 'utf8')
  .split('\n');

// every `callWithRetry(` invocation that fetches a TRANSLATE completion must opt
// into retryEmpty; OCR/transcribe calls deliberately must not (they have their
// own per-region fallback + zero-text gate).
const callSites = BG.map((line, i) => ({ line, n: i + 1 }))
  .filter(x => /callWithRetry\s*\(/.test(x.line) || /await callWithRetry/.test(x.line));

test('translate retry ladder: every callWithRetry call site opts into retryEmpty', () => {
  // multi-line calls: join each call site with its following line to see the args
  const joined = [];
  for (let i = 0; i < BG.length; i++) {
    if (/callWithRetry\s*\(/.test(BG[i])) joined.push({ n: i + 1, text: BG[i] + ' ' + (BG[i + 1] ?? '') });
  }
  assert.ok(joined.length >= 3, `expected the r1/r2/r3 ladder, found ${joined.length} call sites`);
  for (const c of joined) {
    assert.match(c.text, /,\s*undefined\s*,\s*true\s*\)/,
      `background.ts:${c.n} callWithRetry lacks the retryEmpty flag: ${c.text.trim().slice(0, 120)}`);
  }
});

test('retryEmpty is threaded through callWithRetry, not hardcoded', () => {
  // the retry must be conditional (the flag), so OCR can stay opted out
  assert.match(BG.join('\n'), /retryEmpty\s*=\s*false/, 'callWithRetry signature must default retryEmpty=false');
  assert.match(BG.join('\n'), /if\s*\(\s*retryEmpty\s*&&\s*!emptyRetried/, 'the empty-retry guard must exist');
});

test('an empty completion names the model, finish reason and usage', () => {
  // 2026-09-30: an empty 200 was blamed on starvation without recording which model it was.
  // The log must identify model/finish/reasoning tokens so the next occurrence is diagnosable.
  const src = BG.join('\n');
  assert.match(src, /EMPTY response \(200, no content\) model=/, 'empty log carries the model');
  assert.match(src, /finish=\$\{r\.finishReason/, 'empty log carries the finish reason');
  assert.match(src, /reasonTok=\$\{r\.usage\?\.reasonTok/, 'empty log carries the reasoning token count');
});
