// Unit tests for the persistent translation cache (pure logic only —
// IndexedDB wrappers are best-effort by design and stay untested).
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/content/page-cache.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/page-cache.mjs', sourcemap: 'inline',
});

const { hashPixels, cacheKey, settingsFingerprint, CACHE_MAX, packMask, unpackMask, cropPixels, overlapOfRect, normalizeChapterKey, autoBudget, galleryAheadUrls, galleryLookaheadUrls, episodeManifest, manifestAheadUrls, puzzleTileMap, hotlinkRule, HOTLINK_RULE_ID, seamLinked, seamInkLinked, seamTruncated, boxIoU, bandSpan, seamRowsMatch, srcAssignBlocked, cooldownMark, cooldownClear, cooldownParked, COOLDOWN_MAX, uniformPixels, pickActivity, fetchImageBlocked } =
  await import(new URL('../.test-build/page-cache.mjs', import.meta.url).href);

const FP = {
  targetLang: 'Thai', textSource: 'page', ocrEngine: 'tesseract',
  readingDir: 'rtl', detConf: 0.35, panelConf: 0.2, deferLabels: true,
  transcribeSrc: false,
};

test('CACHE_MAX is the agreed 200 pages', () => {
  assert.equal(CACHE_MAX, 200);
});

test('hashPixels: deterministic hex, 1-byte change flips', () => {
  const a = new Uint8Array(2304).fill(200);
  const b = new Uint8Array(2304).fill(200); b[1000] = 201;
  const h1 = hashPixels(a), h2 = hashPixels(a), h3 = hashPixels(b);
  assert.match(h1, /^[0-9a-f]+$/);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.notEqual(hashPixels(new Uint8Array(0)), h1);
});

test('cacheKey scopes by chapter', () => {
  assert.equal(cacheKey('/chapter/abc', 'ff00'), '/chapter/abc#ff00');
  assert.notEqual(cacheKey('/chapter/abc', 'ff00'), cacheKey('/chapter/def', 'ff00'));
});

test('settingsFingerprint: stable, every field flips it', () => {
  const base = settingsFingerprint(FP);
  assert.equal(settingsFingerprint({ ...FP }), base);
  const variants = [
    { ...FP, targetLang: 'English' },
    { ...FP, textSource: 'ocr' },
    { ...FP, ocrEngine: 'baberu' },
    { ...FP, readingDir: 'ltr' },
    { ...FP, detConf: 0.5 },
    { ...FP, panelConf: 0.3 },
    { ...FP, deferLabels: false },
    { ...FP, transcribeSrc: true },
  ];
  for (const v of variants) assert.notEqual(settingsFingerprint(v), base, JSON.stringify(v));
});

test('packMask: downscales to ≤maxSide, block-max keeps text pixels', () => {
  // 900x600 full-text mask → step 3 → 300x200
  const W = 900, H = 600;
  const data = new Uint8Array(W * H).fill(255);
  const packed = packMask({ width: W, height: H, data: data.buffer });
  assert.equal(packed.w, 300);
  assert.equal(packed.h, 200);
  assert.ok(packed.data.byteLength < W * H / 8); // ~60KB vs 540KB
  assert.ok(new Uint8Array(packed.data).every(v => v === 255));
  // single text pixel in an empty block survives (block-max, not sample)
  const sparse = new Uint8Array(W * H);
  sparse[5 * W + 5] = 200;
  const ps = packMask({ width: W, height: H, data: sparse.buffer });
  assert.equal(new Uint8Array(ps.data)[1 * ps.w + 1], 255);
  // sub-threshold noise does not
  const noise = new Uint8Array(W * H);
  noise[5 * W + 5] = 100;
  const pn = packMask({ width: W, height: H, data: noise.buffer });
  assert.ok(new Uint8Array(pn.data).every(v => v === 0));
});

test('unpackMask: roundtrip preserves text rows for inpaint', () => {
  // text band rows 100-119 of a 640x480 page
  const W = 640, H = 480;
  const data = new Uint8Array(W * H);
  for (let y = 100; y < 120; y++) for (let x = 50; x < 590; x++) data[y * W + x] = 255;
  const packed = packMask({ width: W, height: H, data: data.buffer });
  const back = new Uint8Array(unpackMask(packed, W, H));
  assert.equal(back.length, W * H);
  // every original text row still has coverage after the roundtrip
  for (let y = 100; y < 120; y++) {
    let n = 0;
    for (let x = 50; x < 590; x++) if (back[y * W + x]) n++;
    assert.ok(n > 540 * 0.9, `row ${y} kept ${n}/540`);
  }
  // empty areas stay empty
  assert.equal(back[10 * W + 10], 0);
  assert.equal(back[400 * W + 600], 0);
});

test('cropPixels: CSS rect to device pixels with clamping', () => {
  // plain 1x: rect passes through
  assert.deepEqual(cropPixels({ x: 10, y: 20, w: 100, h: 200 }, 1, 800, 600),
    { sx: 10, sy: 20, sw: 100, sh: 200 });
  // dpr scaling
  assert.deepEqual(cropPixels({ x: 10, y: 20, w: 100, h: 200 }, 2, 1600, 1200),
    { sx: 20, sy: 40, sw: 200, sh: 400 });
  // element bleeds past the screenshot edge → clamped, not negative/overrun
  const c = cropPixels({ x: 700, y: 500, w: 200, h: 200 }, 1, 800, 600);
  assert.equal(c.sx, 700);
  assert.equal(c.sw, 100);
  assert.equal(c.sh, 100);
});

test('normalizeChapterKey: page-turns share a key, story changes do not', () => {
  const K = (u) => {
    const { origin, pathname, search, hash } = new URL(u);
    return normalizeChapterKey(origin, pathname, search, hash);
  };
  // MangaDex: pushState page numbers fold into the chapter
  assert.equal(K('https://mangadex.org/chapter/abc/3'), K('https://mangadex.org/chapter/abc/7'));
  assert.notEqual(K('https://mangadex.org/chapter/abc'), K('https://mangadex.org/chapter/def'));
  // /chapter/{id} anywhere names the chapter, never the page (a title-page reader
  // page turns don't touch the URL — chapters must NOT share a key)
  assert.notEqual(K('https://title.example.org/en/title/4/chapter/1945'), K('https://title.example.org/en/title/4/chapter/1946'));
  assert.equal(K('https://title.example.org/en/title/4/chapter/1945'), K('https://title.example.org/en/title/4/chapter/1945/'));
  assert.equal(K('https://site.com/manga/x/chapter/12/3'), K('https://site.com/manga/x/chapter/12/9'));
  // long-strip readers /manga/{slug}/chapter-N: the chapter-N tail is non-numeric, so
  // it is never stripped — chapters stay split, reloads stay stable
  assert.notEqual(K('https://strip.example/manga/some-slug/chapter-1'), K('https://strip.example/manga/some-slug/chapter-2'));
  assert.equal(K('https://strip.example/manga/some-slug/chapter-1'), K('https://strip.example/manga/some-slug/chapter-1'));
  // generic paged readers: trailing /N under a nested path is a page turn…
  assert.equal(K('https://site.com/manga/x/1'), K('https://site.com/manga/x/3'));
  assert.notEqual(K('https://site.com/manga/x/1'), K('https://site.com/manga/y/1'));
  // …but a shallow /manga/1 may BE the story id — never merge those
  assert.notEqual(K('https://site.com/manga/1'), K('https://site.com/manga/2'));
  // ?page= is a turn; other params name the story
  assert.equal(K('https://site.com/r?page=1'), K('https://site.com/r?page=9'));
  assert.notEqual(K('https://site.com/r?chapter=5'), K('https://site.com/r?chapter=6'));
  assert.equal(K('https://site.com/r?page=1'), K('https://site.com/r')); // ?page=1 == default view
  // SPA hash routes name the story
  assert.notEqual(K('https://site.com/#/reader/123'), K('https://site.com/#/reader/456'));
  // purely-numeric hash is a page turn when the path carries an id
  // (reader /reader/4165188.html#2 → #3), spread form included
  assert.equal(K('https://reader.example/reader/4165188.html#2'), K('https://reader.example/reader/4165188.html#3'));
  assert.equal(K('https://reader.example/reader/4165188.html#2-3'), K('https://reader.example/reader/4165188.html#2'));
  assert.notEqual(K('https://reader.example/reader/4165188.html#2'), K('https://reader.example/reader/999.html#2'));
  assert.notEqual(K('https://reader.example/reader/4165188.html#gallery'), K('https://reader.example/reader/4165188.html#2'));
  // …but a digit-less path may use the numeric hash AS the story id — never merge
  assert.notEqual(K('https://site.com/viewer#123'), K('https://site.com/viewer#456'));
  // gallery /g/{id}/{n}/: numeric tail under a nested path is a page turn —
  // the whole gallery shares one key (queue + book survive page flips)
  assert.equal(K('https://gallery.example.org/g/679368/6/'), K('https://gallery.example.org/g/679368/7/'));
  assert.notEqual(K('https://gallery.example.org/g/679368/6/'), K('https://gallery.example.org/g/679369/6/'));
  // origins and trailing slashes
  assert.notEqual(K('https://a.com/manga/x'), K('https://b.com/manga/x'));
  assert.equal(K('https://site.com/manga/x/'), K('https://site.com/manga/x'));
});

test('autoBudget: refill only up to ahead auto jobs waiting', () => {
  assert.equal(autoBudget(0, 3), 3);
  assert.equal(autoBudget(2, 3), 1);
  assert.equal(autoBudget(3, 3), 0);
  assert.equal(autoBudget(32, 3), 0); // full-DOM strip must not pile up
  assert.equal(autoBudget(0, 1), 1);
});

test('seamLinked: cut bubble across stacked slices links, everything else does not', () => {
  // taming-my-master-mage ch1 p8 (940x378, bubble cut at bottom edge) →
  // p9 (940x1500, its continuation at top edge)
  const upper = [{ x1: 120, y1: 60, x2: 820, y2: 376 }];
  const lower = [{ x1: 130, y1: 0, x2: 810, y2: 190 }];
  assert.equal(seamLinked(upper, 378, lower, 1500), true);
  // live CTD wobble: p8's real box ended 23px short of the edge (y2=355) —
  // still links; 78px short does not
  assert.equal(seamLinked([{ x1: 230, y1: 199, x2: 730, y2: 355 }], 378, [{ x1: 362, y1: 0, x2: 577, y2: 28 }], 1500), true);
  // no edge touch → independent scenes
  assert.equal(seamLinked([{ x1: 120, y1: 60, x2: 820, y2: 300 }], 378, lower, 1500), false);
  assert.equal(seamLinked(upper, 378, [{ x1: 130, y1: 200, x2: 810, y2: 400 }], 1500), false);
  // edge touch but mostly disjoint → different bubbles (40px overlap < 40% of 120px narrow)
  assert.equal(seamLinked(upper, 378, [{ x1: 780, y1: 0, x2: 900, y2: 190 }], 1500), false);
  // narrow sliver touching the edge → detector noise, not a cut
  assert.equal(seamLinked([{ x1: 120, y1: 60, x2: 820, y2: 376 }], 378, [{ x1: 400, y1: 0, x2: 430, y2: 190 }], 1500), false);
  // empty sides never link
  assert.equal(seamLinked([], 378, lower, 1500), false);
  assert.equal(seamLinked(upper, 378, [], 1500), false);
});

test('seamTruncated: unboxed glyph ink running into the cut links single-sided', () => {
  const W = 200, H = 100;
  const mask = (inkRows) => {
    const d = new Uint8Array(W * H);
    for (const [y0, y1, x0, x1] of inkRows)
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d[y * W + x] = 255;
    return { width: W, height: H, data: d.buffer };
  };
  // p8 live case: box ends y2=90 (H=100), glyph ink 90..99 in the box columns
  const box = [{ x1: 40, y1: 30, x2: 160, y2: 90 }];
  assert.equal(seamTruncated(box, mask([[90, 100, 60, 140]]), H, 'bottom'), true);
  // ink stops before the edge → complete text, no link
  assert.equal(seamTruncated(box, mask([[90, 95, 60, 140]]), H, 'bottom'), false);
  // thin curve (3 rows) → not glyphs, no link
  assert.equal(seamTruncated(box, mask([[97, 100, 0, 200]]), H, 'bottom'), false);
  // box far from the edge → no link even with edge ink (someone else's text)
  assert.equal(seamTruncated([{ x1: 40, y1: 10, x2: 160, y2: 40 }], mask([[90, 100, 60, 140]]), H, 'bottom'), false);
  // mirrored top side
  assert.equal(seamTruncated([{ x1: 40, y1: 5, x2: 160, y2: 40 }], mask([[0, 12, 60, 140]]), H, 'top'), true);
  assert.equal(seamTruncated([{ x1: 40, y1: 5, x2: 160, y2: 40 }], mask([[8, 30, 60, 140]]), H, 'top'), false);
  // missing/bad mask never links
  assert.equal(seamTruncated(box, null, H, 'bottom'), false);
  assert.equal(seamTruncated(box, { width: W, height: H, data: new ArrayBuffer(10) }, H, 'bottom'), false);
});

test('srcAssignBlocked: only a dead-blob orig onto a foreign src is blocked', () => {
  const dead = 'blob:https://mm/aaa', live = 'blob:https://mm/bbb', ours = 'blob:chrome-ext/ttt';
  // show-original onto an element showing something else → blocked (blanks the page)
  assert.equal(srcAssignBlocked(live, dead, dead), true);
  assert.equal(srcAssignBlocked(ours, dead, dead), true);
  // already showing it → the caller's src-guard skips anyway, not blocked here
  assert.equal(srcAssignBlocked(dead, dead, dead), false);
  // translated blob always assigns (even over a dead orig)
  assert.equal(srcAssignBlocked(dead, ours, dead), false);
  assert.equal(srcAssignBlocked(live, ours, dead), false);
  // https origs are never dead — assign freely
  assert.equal(srcAssignBlocked(live, 'https://cdn/p.jpg', 'https://cdn/p.jpg'), false);
});

test('seamRowsMatch: identical rows pass, webp-ringing passes, scenes fail', () => {
  const W = 100;
  const row = (fn) => {
    const d = new Uint8ClampedArray(W * 4);
    for (let x = 0; x < W; x++) { const [r, g, b] = fn(x); d[x * 4] = r; d[x * 4 + 1] = g; d[x * 4 + 2] = b; d[x * 4 + 3] = 255; }
    return d;
  };
  const black = row(() => [0, 0, 0]);
  assert.equal(seamRowsMatch(black, row(() => [0, 0, 0]), W), true);
  // live 8/9: 4.3% pixels off by >100 (independent webp ringing) → still link
  assert.equal(seamRowsMatch(black, row((x) => x < 5 ? [150, 0, 0] : [0, 0, 0]), W), true);
  // unrelated scenes: massive diffs → reject
  assert.equal(seamRowsMatch(black, row(() => [200, 200, 200]), W), false);
  assert.equal(seamRowsMatch(black, row((x) => x < 20 ? [0, 0, 0] : [180, 10, 10]), W), false);
  // short buffers → fail closed
  assert.equal(seamRowsMatch(new Uint8ClampedArray(10), black, W), false);
});

test('bandSpan: only a box crossing the band seam confirms the cut', () => {
  const SEAM = 200;
  assert.equal(bandSpan([{ x1: 100, y1: 120, x2: 400, y2: 260 }], SEAM), true);
  assert.equal(bandSpan([{ x1: 100, y1: 120, x2: 400, y2: 195 }], SEAM), false); // ends above
  assert.equal(bandSpan([{ x1: 100, y1: 205, x2: 400, y2: 260 }], SEAM), false); // starts below
  assert.equal(bandSpan([{ x1: 100, y1: 194, x2: 400, y2: 206 }], SEAM), false); // straddles within margin
  assert.equal(bandSpan([], SEAM), false);
});

test('boxIoU: identity 1, disjoint 0, half-overlap in between', () => {
  const b = { x1: 0, y1: 0, x2: 100, y2: 100 };
  assert.equal(boxIoU(b, { ...b }), 1);
  assert.equal(boxIoU(b, { x1: 200, y1: 200, x2: 300, y2: 300 }), 0);
  const half = boxIoU(b, { x1: 50, y1: 0, x2: 150, y2: 100 });
  assert.ok(half > 0.3 && half < 0.4);
  // the seam safety-net case: solo fragment vs merged whole ≈ 1 (suppressed),
  // edge line vs merged whole ≈ 0.05 (kept)
  const merged = { x1: 232, y1: 195, x2: 717, y2: 404 };
  assert.ok(boxIoU(merged, { x1: 230, y1: 199, x2: 730, y2: 355 }) > 0.7);
  assert.ok(boxIoU(merged, { x1: 362, y1: 378, x2: 577, y2: 406 }) < 0.3);
});

test('seamInkLinked: cut text ink at the seam links even with zero boxes', () => {
  const W = 200;
  const mask = (H, rows) => {
    const d = new Uint8Array(W * H);
    for (const [y0, y1, x0, x1] of rows)
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d[y * W + x] = 255;
    return { width: W, height: H, data: d.buffer };
  };
  // text cut at the bottom edge continues at the top edge, columns overlap
  const upper = mask(100, [[90, 100, 40, 160]]);
  const lower = mask(120, [[0, 10, 50, 170]]);
  assert.equal(seamInkLinked(upper, lower), true);
  // ink far from the seam → independent scenes
  assert.equal(seamInkLinked(mask(100, [[10, 30, 40, 160]]), lower), false);
  assert.equal(seamInkLinked(upper, mask(120, [[60, 90, 50, 170]])), false);
  // same edge ink, disjoint columns → different bubbles
  assert.equal(seamInkLinked(upper, mask(120, [[0, 10, 160, 195]])), false);
  // speck (1 ink row) → detector noise, not a cut
  assert.equal(seamInkLinked(mask(100, [[99, 100, 40, 160]]), lower), false);
  // no ink at all / width mismatch → never
  assert.equal(seamInkLinked(mask(100, []), lower), false);
  assert.equal(seamInkLinked({ width: 201, height: 100, data: new Uint8Array(201 * 100).buffer }, lower), false);
});

test('hotlinkRule: session rule stamping the page origin as Referer on guard CDNs', () => {
  const rule = hotlinkRule('https://strip.example');
  assert.equal(rule.id, HOTLINK_RULE_ID);
  assert.equal(rule.action.type, 'modifyHeaders');
  assert.deepEqual(rule.action.requestHeaders,
    [{ header: 'Referer', operation: 'set', value: 'https://strip.example/' }]);
  const re = new RegExp(rule.condition.regexFilter);
  assert.match('https://img-r2.2xstorage.com/slug/1/0.webp', re);
  assert.match('https://img-r1.2xstorage.com/slug/1/0.webp', re);
  assert.match('https://storage.waitst.com/x/1.webp', re);
  assert.doesNotMatch('https://strip.example/images/logo.webp', re);
  assert.doesNotMatch('https://imgsrv5.com/x/1.jpg', re);
  assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest']); // SW fetch only, <img> needs no help
});

test('failure cooldown: park during cooldown, cap attempts, clear on force', () => {  const marks = new Map();
  assert.equal(cooldownParked(marks, 'a', 0), false);
  cooldownMark(marks, 'a', 0);
  assert.equal(cooldownParked(marks, 'a', 59999), true);
  assert.equal(cooldownParked(marks, 'a', 60000), false);
  cooldownMark(marks, 'a', 60000);
  cooldownMark(marks, 'a', 120000);
  assert.equal(cooldownParked(marks, 'a', 1e15), true); // COOLDOWN_MAX hit: parked forever
  cooldownClear(marks, 'a');
  assert.equal(cooldownParked(marks, 'a', 1e15), false);
  assert.equal(COOLDOWN_MAX, 3);
});

test('overlapOfRect: visible overlap for queue priority, negative offscreen', () => {
  assert.equal(overlapOfRect(0, 800, 800), 800);
  assert.equal(overlapOfRect(600, 1000, 800), 200);
  assert.equal(overlapOfRect(-200, -50, 800), -50);
  assert.equal(overlapOfRect(900, 1200, 800), -100);
});

test('galleryAheadUrls: forward sibling URLs from the embedded manifest, nothing else', () => {
  const inner = { media_id: '4167692', num_pages: 4, pages: [1, 2, 3, 4].map(n => ({ path: `galleries/4167692/${n}.webp` })) };
  const M = JSON.stringify({ body: JSON.stringify(inner) });
  const H = 'https://img.gallery.example.org', C = 'galleries/4167692/2.webp';
  // forward-only, capped by max, host+path join
  assert.deepEqual(galleryAheadUrls(M, H, C, 3), [
    'https://img.gallery.example.org/galleries/4167692/3.webp',
    'https://img.gallery.example.org/galleries/4167692/4.webp',
  ]);
  assert.deepEqual(galleryAheadUrls(M, H, C, 1), ['https://img.gallery.example.org/galleries/4167692/3.webp']);
  // last page: nothing ahead (never wraps, never goes back)
  assert.deepEqual(galleryAheadUrls(M, H, 'galleries/4167692/4.webp', 3), []);
  // bail-outs: no script, bad json, no pages array, unknown current path
  assert.deepEqual(galleryAheadUrls(null, H, C, 3), []);
  assert.deepEqual(galleryAheadUrls('not json', H, C, 3), []);
  assert.deepEqual(galleryAheadUrls(JSON.stringify({ body: '{}' }), H, C, 3), []);
  assert.deepEqual(galleryAheadUrls(M, H, 'galleries/999/1.webp', 3), []);
  assert.deepEqual(galleryAheadUrls(M, '', C, 3), []);
  assert.deepEqual(galleryAheadUrls(M, H, C, 0), []);
});

test('galleryLookaheadUrls: siblings derive from the stored original, never the live src', () => {
  const inner = { media_id: '4167692', num_pages: 4, pages: [1, 2, 3, 4].map(n => ({ path: `galleries/4167692/${n}.webp` })) };
  const M = JSON.stringify({ body: JSON.stringify(inner) });
  // https original → forward siblings (the caller passes PageState.orig)
  assert.deepEqual(
    galleryLookaheadUrls(M, 'https://img.gallery.example.org/galleries/4167692/2.webp', 3),
    ['https://img.gallery.example.org/galleries/4167692/3.webp', 'https://img.gallery.example.org/galleries/4167692/4.webp'],
  );
  // REGRESSION (shipped once): after translation the live el.src is our own
  // blob — deriving from it silently yields [] every tick, so lookahead never
  // fires and the user sees "no work at all". Blob/garbage must yield [] HERE
  // (visibly, under test) instead of dying quietly inside the caller.
  assert.deepEqual(galleryLookaheadUrls(M, 'blob:https://gallery.example.org/uuid-here', 3), []);
  assert.deepEqual(galleryLookaheadUrls(M, '', 3), []);
  assert.deepEqual(galleryLookaheadUrls(M, 'not a url', 3), []);
  assert.deepEqual(galleryLookaheadUrls(null, 'https://img.gallery.example.org/galleries/4167692/2.webp', 3), []);
});

test('episodeManifest: area-index-aligned srcs, nulls for non-main, dir passthrough', () => {
  const pages = [
    { type: 'other' },
    { type: 'link', linkPosition: 'front' },
    { type: 'main', src: 'https://cdn.example.org/public/page/2/AAA' },
    { type: 'main', src: 'https://cdn.example.org/public/page/2/BBB' },
    { type: 'main' }, // no src — unusable, null like non-main
    { type: 'link', linkPosition: 'back' },
    { type: 'backMatter' },
  ];
  const M = JSON.stringify({ readableProduct: { pageStructure: { readingDirection: 'rtl', pages } } });
  assert.deepEqual(episodeManifest(M), {
    dir: 'rtl',
    srcs: [null, null, 'https://cdn.example.org/public/page/2/AAA', 'https://cdn.example.org/public/page/2/BBB', null, null, null],
  });
  // ltr passes through; unknown direction -> null (caller falls back to settings)
  const L = JSON.stringify({ readableProduct: { pageStructure: { readingDirection: 'ltr', pages: [] } } });
  assert.equal(episodeManifest(L).dir, 'ltr');
  // bail-outs: absent script, bad json, missing structure, non-array pages
  assert.equal(episodeManifest(null), null);
  assert.equal(episodeManifest('not json'), null);
  assert.equal(episodeManifest('{}'), null);
  assert.equal(episodeManifest(JSON.stringify({ readableProduct: { pageStructure: { pages: {} } } })), null);
});

test('manifestAheadUrls: forward mains after the anchor, nulls skipped', () => {
  const S = [null, 'A', null, 'B', 'C', 'D'];
  assert.deepEqual(manifestAheadUrls(S, 'A', 10), ['B', 'C', 'D']);
  assert.deepEqual(manifestAheadUrls(S, 'A', 2), ['B', 'C']);
  assert.deepEqual(manifestAheadUrls(S, 'D', 3), []);
  assert.deepEqual(manifestAheadUrls(S, 'ZZZ', 3), []);
  assert.deepEqual(manifestAheadUrls(S, '', 3), []);
  assert.deepEqual(manifestAheadUrls(S, 'A', 0), []);
  assert.deepEqual(manifestAheadUrls([], 'A', 3), []);
});

test('puzzleTileMap: viewer-exact 4x4 transpose geometry, involution', () => {
  // 800x1137 (the real pages): tw=200, th=280, 4x4=800x1120 + 17px remainder
  const { tw, th, tiles } = puzzleTileMap(800, 1137);
  assert.equal(tw, 200);
  assert.equal(th, 280);
  assert.equal(tiles.length, 16);
  // transpose spots: dest tile 1 (x=200,y=0) reads src tile 4 (x=0,y=280)
  assert.deepEqual(tiles[1], { sx: 0, sy: 280, dx: 200, dy: 0 });
  assert.deepEqual(tiles[4], { sx: 200, sy: 0, dx: 0, dy: 280 });
  assert.deepEqual(tiles[0], { sx: 0, sy: 0, dx: 0, dy: 0 });
  assert.deepEqual(tiles[15], { sx: 600, sy: 840, dx: 600, dy: 840 });
  // involution: transpose is its own inverse — tile a's entry must read
  // from tile b's position (solving a puzzle == unscrambling it, same map)
  for (let b = 0; b < 16; b++) {
    const t = tiles[b];
    const a = Math.floor(t.sy / th) * 4 + Math.floor(t.sx / tw);
    assert.deepEqual([tiles[a].sx, tiles[a].sy], [t.dx, t.dy]);
  }
  // small sizes floor to multiples of 8, never zero for real pages
  assert.deepEqual([puzzleTileMap(64, 64).tw, puzzleTileMap(64, 64).th], [16, 16]);
});

test('uniformPixels: placeholder canvases are uniform, real pages are not', () => {
  // blank canvas readback: all zero (transparent black)
  assert.equal(uniformPixels(new Uint8ClampedArray(16 * 16 * 4)), true);
  // white placeholder
  assert.equal(uniformPixels(new Uint8ClampedArray(16 * 16 * 4).fill(255)), true);
  // near-uniform (downscale ringing ±2) still blank
  const ring = new Uint8ClampedArray(16 * 16 * 4).fill(255);
  ring[100] = 254; ring[101] = 253;
  assert.equal(uniformPixels(ring), true);
  // one dark pixel = real content (a page with any art/text downscales to contrast)
  const page = new Uint8ClampedArray(16 * 16 * 4).fill(255);
  page[40] = 0;
  assert.equal(uniformPixels(page), false);
  // tiny payload (1px) is trivially uniform
  assert.equal(uniformPixels(new Uint8ClampedArray([10, 20, 30, 255])), true);
});

test('pickActivity: force > most-visible > lookahead, empty → null', () => {
  const a = (key, kind, overlap = 0) => ({ key, kind, overlap });
  // empty
  assert.equal(pickActivity([]), null);
  // visibility beats FIFO: bigger overlap wins among view jobs
  assert.equal(pickActivity([a('p1', 'view', 100), a('p2', 'view', 900)]).key, 'p2');
  // force (user intent) beats visibility
  assert.equal(pickActivity([a('p1', 'view', 900), a('p2', 'force', 1)]).key, 'p2');
  // lookahead loses to everything
  assert.equal(pickActivity([a('lk', 'lookahead'), a('p1', 'view', 1)]).key, 'p1');
  // lookahead alone still shows
  assert.equal(pickActivity([a('lk', 'lookahead')]).key, 'lk');
  // tie on overlap → stable (first wins)
  assert.equal(pickActivity([a('p1', 'view', 500), a('p2', 'view', 500)]).key, 'p1');
});

test('fetchImageBlocked: public https free, local network only for same-host pages', () => {
  // public image CDN from any page — the extension's whole purpose
  assert.equal(fetchImageBlocked('https://imgsrv5.com/p/1.webp', 'https://reader.example/ch/1'), null);
  // same-host local reader (self-hosted) still works, localhost ≡ 127.0.0.1
  assert.equal(fetchImageBlocked('http://localhost:8080/p/1.jpg', 'http://localhost:8080/reader'), null);
  assert.equal(fetchImageBlocked('http://127.0.0.1:3000/p/1.jpg', 'http://localhost:3000/reader'), null);
  // planted localhost img on a remote page — the readback vector, blocked
  assert.equal(fetchImageBlocked('http://127.0.0.1:8080/admin', 'https://evil.example/'), 'local network');
  assert.equal(fetchImageBlocked('http://192.168.1.10:9000/cfg', 'https://evil.example/'), 'local network');
  assert.equal(fetchImageBlocked('http://[::1]:8080/x', 'https://evil.example/'), 'local network');
  // non-http(s) schemes have no business riding the proxy
  assert.equal(fetchImageBlocked('file:///etc/passwd', 'https://evil.example/'), 'scheme');
  assert.equal(fetchImageBlocked('chrome-extension://abc/x.html', 'https://evil.example/'), 'scheme');
  // garbage
  assert.equal(fetchImageBlocked('not a url', 'https://x/'), 'invalid url');
});

test('fetchImageBlocked: redirect-era bypass vectors all blocked', () => {
  // IPv4-mapped IPv6, both spellings
  assert.equal(fetchImageBlocked('http://[::ffff:127.0.0.1]/x', 'https://evil.example/'), 'local network');
  assert.equal(fetchImageBlocked('http://[::ffff:7f00:1]/x', 'https://evil.example/'), 'local network');
  // trailing-dot localhost resolves to loopback
  assert.equal(fetchImageBlocked('http://localhost./x', 'https://evil.example/'), 'local network');
  // IPv6 link-local + ULA
  assert.equal(fetchImageBlocked('http://[fe80::1]/x', 'https://evil.example/'), 'local network');
  assert.equal(fetchImageBlocked('http://[fd12::1]/x', 'https://evil.example/'), 'local network');
  // decimal/octal/hex IPv4 — WHATWG URL normalizes to 127.0.0.1 before we see it
  assert.equal(fetchImageBlocked('http://2130706433/x', 'https://evil.example/'), 'local network');
  assert.equal(fetchImageBlocked('http://0x7f.1/x', 'https://evil.example/'), 'local network');
  // 0.0.0.0 is loopback on Linux
  assert.equal(fetchImageBlocked('http://0.0.0.0/x', 'https://evil.example/'), 'local network');
  // same-host over IPv6 still allowed (self-hosted reader)
  assert.equal(fetchImageBlocked('http://[fd12::1]:8080/p.jpg', 'http://[fd12::1]:8080/reader'), null);
  // mapped-loopback page fetching mapped-loopback img
  assert.equal(fetchImageBlocked('http://[::ffff:127.0.0.1]/x', 'http://[::ffff:127.0.0.1]/reader'), null);
});
