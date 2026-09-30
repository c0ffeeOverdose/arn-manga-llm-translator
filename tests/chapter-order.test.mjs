// A windowed reader keeps only the pages near the viewport in the DOM, so an element's
// ordinal among them is NOT its chapter index. Mapping ordinal→index painted page 9 with
// page 3's translation. Position must be derived from the window's offset from a measured
// anchor, and any positional match must be verified before it paints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/content/sweep.ts', import.meta.url), 'utf8');

test('a positional page match is derived from the anchor, not from the raw ordinal', () => {
    const fn = src.slice(src.indexOf('function ownedRef'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    // The mapping must be anchor-relative. Using the element's own index as the chapter
    // order is exactly the bug: a slid window makes ordinal 0 map to page 9.
    assert.match(body, /anchorOrder \+ \(index - anchorElementIndex\)/,
        'position must be the window delta from the measured anchor');
    assert.ok(!/ordered\[index\]/.test(body),
        'the raw ordinal must never be used as the chapter index');
});

test('a reader that states the page in its URL is believed directly', () => {
    // /chapter/<uuid>/4 means page 4 — no inference needed, and it is the anchor of last
    // resort when no element URL matches the chapter list.
    const fn = src.slice(src.indexOf('function urlPageNumber'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /location\.pathname\.match\(PAGE_IN_URL\)/, 'the page number comes from the path');
    // The visible page is not "the first image": a single-page viewer preloads neighbours.
    const disp = src.slice(src.indexOf('function displayRef'));
    assert.match(disp.slice(0, disp.indexOf('\n}')), /viewportOverlap/,
        'the displayed page is the one covering the viewport');
});

test('the anchor is measured once, from a page whose slot is knowable', () => {
    const fn = src.slice(src.indexOf('function rememberAnchor'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /if \(anchorOrder !== null\) return/, 'the anchor is measured once');
    // Signal 1: a URL the chapter list recognises.
    assert.match(body, /samePagePath\(q\.url, src\)/, 'a URL-matched element anchors directly');
    // Signal 2: the URL's own page number, applied to the visible page.
    assert.match(body, /urlPageNumber\(\)/, 'the URL page number is the fallback anchor');
    // With neither, there is no anchor and no positional matching — refusing beats guessing.
    assert.match(fn.slice(0, fn.indexOf('\n}')), /anchorOrder = null|anchorOrder = n - 1/);
});

test('a positionally matched page is verified before it paints', () => {
    const fn = src.slice(src.indexOf('async function attach'));
    const body = fn.slice(0, fn.indexOf('\n} catch (e) { console.debug'));
    // An inferred mapping that cannot be checked must refuse: painting page 9 with page 3's
    // text is far worse than leaving it untranslated.
    assert.match(body, /page\.matchedBy !== 'url'/, 'url matches are trusted, others are checked');
    assert.match(body, /probe\.width !== entry\.w/, 'the check compares rendered dims');
    assert.match(body, /unverifiable-position/, 'an unreadable element with an inferred match refuses');
});

test('the anchor is forgotten when the chapter changes', () => {
    assert.match(src, /forgetAnchor\(\)/, 'a stale anchor describes the old chapter window');
    const fn = src.slice(src.indexOf('function forgetAnchor'));
    assert.match(fn.slice(0, fn.indexOf('\n}')), /anchorOrder = null/);
});
