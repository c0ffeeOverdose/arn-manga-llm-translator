// Chapter enumeration must work on readers that ship no stable image selector, no
// rel=next and a DOM full of non-page images. Every case here was a silent stop on a
// real reader: the selector gate, an ad image entering the manifest, an anchor that
// matched nothing, and a paginated reader that only swaps content in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

// Bundled so the module's page-cache import resolves; the bundler is the same one the
// extension build uses, so the test exercises the shipped code path.
const out = '/tmp/opencode/chapter-discovery-bundle.mjs';
mkdirSync('/tmp/opencode', { recursive: true });
await build({ entryPoints: ['src/chapter/discovery.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' });
await build({ entryPoints: ['src/chapter/model.ts'], bundle: true, format: 'esm', outfile: '/tmp/opencode/chapter-model.mjs', logLevel: 'silent' });
const discovery = await import(out);

test('chapterImages takes page art and drops attributes-sized icons', () => {
    const doc = { querySelectorAll: () => [
        { tagName: 'IMG', getAttribute: (k) => ({ src: 'https://cdn.example.org/page1.webp', width: '800', height: '1200' }[k] ?? null) },
        { tagName: 'IMG', getAttribute: (k) => ({ src: 'https://ads.example.org/pixel.gif', width: '1', height: '1' }[k] ?? null) },
        { tagName: 'IMG', getAttribute: (k) => ({ src: 'https://cdn.example.org/page2.webp', width: '80', height: '80' }[k] ?? null) },
    ] };
    assert.deepEqual(discovery.chapterImages(doc, 'https://reader.test/ch/1', { minW: 400, minH: 300 }),
        ['https://cdn.example.org/page1.webp']);
});

test('chapterImages prefers lazy attributes and dedupes host-rotated twins', () => {
    const doc = { querySelectorAll: () => [
        { tagName: 'IMG', getAttribute: (k) => ({ 'data-src': '/cdn/page1.webp' }[k] ?? null) },
        { tagName: 'IMG', getAttribute: (k) => ({ src: 'https://rot.example.org/cdn/page1.webp' }[k] ?? null) },
    ] };
    // Same path on another host is the same page, not a second page.
    assert.deepEqual(discovery.chapterImages(doc, 'https://reader.test/ch/1'),
        ['https://reader.test/cdn/page1.webp']);
});

test('guessNextDocument walks ?page=N, a trailing segment and a hash route', () => {
    assert.equal(discovery.guessNextDocument('https://r.test/ch/1?page=3', 'https://r.test/ch/1'),
        'https://r.test/ch/1?page=4');
    assert.equal(discovery.guessNextDocument('https://r.test/g/9/2/', 'https://r.test/g/9'),
        'https://r.test/g/9/3');
    assert.equal(discovery.guessNextDocument('https://r.test/ch/1#2', 'https://r.test/ch/1'),
        'https://r.test/ch/1#3');
});

test('guessNextDocument never steps outside the chapter', () => {
    // A bare trailing segment with no page marker is a chapter id, not a page turn: the
    // guess would land on a different chapter and must be refused.
    assert.equal(discovery.guessNextDocument('https://r.test/title/9', 'https://r.test/title/9'), undefined);
    // A shallow /1 may be the story id — the depth guard refuses it too.
    assert.equal(discovery.guessNextDocument('https://r.test/g/1', 'https://r.test/g/'), undefined);
    assert.equal(discovery.guessNextDocument('https://r.test/other', 'https://r.test/ch'), undefined);
    // A digit-less path with a numeric hash is using the hash AS the story id: refusing
    // the step is the fail-safe (a wrong chapter merge contaminates the book).
    assert.equal(discovery.guessNextDocument('https://r.test/ch#2', 'https://r.test/ch'), undefined);
});

test('no selector gate remains in the runner discovery path', () => {
    const src = readFileSync(new URL('../src/chapter/page.ts', import.meta.url), 'utf8');
    assert.ok(!/imageSelector/.test(src), 'a missing selector must never stop discovery');
    assert.match(src, /chapterImages\(/, 'discovery must read page images from the fetched document');
    assert.match(src, /guessNextDocument\(/, 'a reader without rel=next must still be walkable');
});

test('the sweep anchors on the nearest known page instead of giving up', () => {
    const src = readFileSync(new URL('../src/content/sweep.ts', import.meta.url), 'utf8');
    // The manifest branch must delegate to the multi-signal anchor, not truncate.
    assert.match(src, /const anchor = anchorInList\(/, 'a list/live mismatch must anchor, not truncate');
    // All three signals exist, in strength order, ending in the positional fallback for
    // readers whose page URLs are unreadable (blob:).
    assert.match(src, /const direct = matchAnchor\(/, 'the visible page URL is tried first');
    assert.match(src, /const byUrl = nearestAnchor\(/, 'then any loaded page the list knows');
    assert.match(src, /return ordinalAnchor\(/, 'then the DOM ordinal for blob:/regenerated URLs');
    // The DOM branch must fall back to the highest loaded page.
    assert.match(src, /if \(anchor < 0\) anchor = highestKnown\(/, 'the DOM branch must anchor too');
    // `visible()` must not return null merely because nothing overlaps the viewport.
    const vis = src.slice(src.indexOf('function visible'), src.indexOf('function owned'));
    assert.ok(!/filter\(r => viewportOverlap\(r\) > 0\)/.test(vis),
        'a zero-overlap viewport must not null the anchor');
});

test('sweepCount names why there is nothing ahead', async () => {
    const { sweepCount, sweepCountMessage } = await import('/tmp/opencode/chapter-model.mjs');
    assert.deepEqual(sweepCount(8, 2), { count: 6, reason: 'known' });
    assert.deepEqual(sweepCount(0, 0), { count: 0, reason: 'no-pages' });
    assert.deepEqual(sweepCount(8, -1), { count: 0, reason: 'no-anchor' });
    assert.deepEqual(sweepCount(8, 8), { count: 0, reason: 'last-page' });
    // The user-facing lines must not leak internal words.
    for (const reason of ['no-pages', 'no-anchor', 'last-page']) {
        assert.ok(sweepCountMessage(reason).length > 0);
        assert.ok(!/\banchor\b|\bsweep\b|\bfold\b/i.test(sweepCountMessage(reason)), reason);
    }
});
