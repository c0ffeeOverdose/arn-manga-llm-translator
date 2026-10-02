// Unit tests for the halt → pill message mapping. Regression: clearing the translation cache
// sets haltAuto('cache'), and the old catch-all printed "Auth/quota error — fix the key" —
// telling the user to fix a perfectly good key after pressing Clear.
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/content/halt-message.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/halt-message.mjs', sourcemap: 'inline',
});
const { haltMessage } = await import(new URL('../.test-build/halt-message.mjs', import.meta.url).href);

test('every halt kind gets its own human message — cache never borrows auth', () => {
  const cache = haltMessage({ kind: 'cache', until: 0 });
  assert.match(cache, /Cache cleared/);
  assert.match(cache, /press Translate/);
  assert.doesNotMatch(cache, /Auth|quota|key/i, 'a cache clear must never read as an auth problem');

  assert.match(haltMessage({ kind: 'chapter', until: 0 }), /Chapter translation paused/);
  assert.match(haltMessage({ kind: 'auth', until: 0 }), /Auth\/quota error/);
});

test('rate limit shows the remaining time only while the window is open', () => {
  assert.equal(haltMessage({ kind: 'ratelimit', until: 0 }), 'Rate limited — stopped; press Translate to resume');
  const live = haltMessage({ kind: 'ratelimit', until: 12_000 }, 0);
  assert.equal(live, 'Rate limited (12s) — stopped; press Translate to resume');
});

test('an unknown kind keeps the actionable auth hint', () => {
  assert.match(haltMessage({ kind: 'who-knows', until: 0 }), /Auth\/quota error/);
});
