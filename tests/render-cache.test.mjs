// Regression: after a cache hit regenerates AI-cleanup crops (warm or fresh), the crops
// must be persisted, or every later visit re-runs the inpaint model.
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const render = readFileSync(new URL('../src/content/render-page.ts', import.meta.url), 'utf8');

test('a warm-generated crop set is persisted, not only a freshly computed one', () => {
    // The write-back branch must accept BOTH sources: the model run inside renderPage
    // (aiGenerated) and the warm run that rode the LLM wait (aiWarmUsed). Persisting only
    // aiGenerated made every later visit re-run the model for the same page.
    const branch = render.slice(render.indexOf('} else if ((aiGenerated || aiWarmUsed)'));
    assert.ok(branch.length > 0, 'the cache-hit write-back branch must accept aiWarmUsed');
    const end = branch.indexOf('}\n');
    const body = branch.slice(0, end);
    assert.match(body, /patches: aiPatches, patchesGen: INPAINT_PATCH_GEN/,
        'the branch must write the crops it just produced');
});

test('the full-hit gate is the shared predicate, never a weaker guard with a forced det', () => {
    // A splitGen-stale entry passed the old raw guard, detFromCacheEntry returned null, and
    // the `!` handed that null to the renderer ("Cannot read properties of null (reading
    // 'boxes')"). The gate must be the predicate itself; a stale entry falls through to
    // re-detect.
    const pipe = readFileSync(new URL('../src/content/pipeline.ts', import.meta.url), 'utf8');
    assert.ok(!/detFromCacheEntry\([^)]*\)!/.test(pipe),
        'a forced non-null cached det can crash the renderer on a stale entry');
    assert.match(pipe, /detFromCacheEntry\(hit, fp, bitmap\.width, bitmap\.height, pipeline\.inferEngine === 'cloud'\)/,
        'the bytes entry must be gated by the shared predicate');
});

test('the diagnostic distinguishes "reused from cache" from "produced in warm"', () => {
    // cached:true must mean the crops came from the stored entry — if a warm-produced set
    // also reports cached:true, a real miss looks like a hit in the dump.
    assert.match(render, /cached: !!aiPatches && !aiGenerated && !aiWarmUsed/,
        'warm-produced crops are not "cached"');
});
