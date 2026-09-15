// Unit tests for bubbleArea flood-fill bounds (pure pixel logic — the
// ImageData arg is structural, so a plain object suffices, no canvas needed).
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/content/render.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/render.mjs', sourcemap: 'inline',
});

const {
  bubbleArea, firstColX, clampToBorders, inkStats, layoutArea, isLight, layoutText, horizontalFits,
  widthProfile, runInterval, sourcePitch, sizeCapFrom, layoutTextFit, boxIsVertical, setRenderTuning, renderTuning, ENCLOSED_MIN,
} = await import(new URL('../.test-build/render.mjs', import.meta.url).href);

// white W×H page, optional dark vertical borders (bubble edges)
function page(W, H, borders = []) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (const bx of borders) {
    for (let y = 0; y < H; y++) {
      const i = (y * W + bx) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  return { width: W, height: H, data };
}

test('vertical text column walks to the bubble borders (wide grow)', () => {
  // 15px text column inside a 60px bubble; borders must lie INSIDE the
  // ±100% leash ([25,70]) to be found — trust comes from the border itself,
  // a leash-stopped edge with white beyond it is capped (see below).
  const img = page(100, 320, [26, 64]);
  const box = { x1: 40, y1: 20, x2: 55, y2: 300, conf: 0.9 };
  const a = bubbleArea(img, box);
  assert.ok(a.w >= 28, `walks past the 15px box toward borders, got w=${a.w}`);
  assert.ok(a.x >= 26 && a.x + a.w <= 65, 'stopped by the dark borders');
});

test('vertical fill stays capped when no border exists', () => {
  const img = page(200, 320); // all white, no borders
  const box = { x1: 40, y1: 20, x2: 55, y2: 300, conf: 0.9 };
  const a = bubbleArea(img, box);
  assert.ok(a.w <= 15 * 3 + 1, `capped at box±100%, got w=${a.w}`);
  assert.ok(a.w > 15, 'wider than the box itself');
});

test('horizontal boxes keep the tight 30% cap (face-walk guard)', () => {
  const img = page(400, 200); // all white
  const box = { x1: 100, y1: 80, x2: 180, y2: 120, conf: 0.9 }; // 80x40, not vertical
  const a = bubbleArea(img, box);
  assert.ok(a.w <= 80 * 1.6 + 1 && a.h <= 40 * 1.6 + 1, `stays box+30%, got ${a.w}x${a.h}`);
});

test('bubbleArea: center-on-ink does not collapse the fill (interior seed)', () => {
  // live case: tight box whose center pixel lands on a glyph stroke. The old
  // center-pixel seed flooded the glyph only, fell under the 25% minFill and
  // returned the padded box — translation wrapped too narrow and clipped.
  const W = 400, H = 300;
  const img = page(W, H, [76, 204]); // real bubble borders at the grow bounds
  for (const y0 of [88, 98, 108]) {
    for (let y = y0; y < y0 + 3; y++) {
      for (let x = 110; x < 170; x++) {
        const i = (y * W + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
      }
    }
  }
  const box = { x1: 100, y1: 80, x2: 180, y2: 120, conf: 0.9 }; // center (140,100) on the middle bar
  assert.equal(img.data[(100 * W + 140) * 4], 0, 'premise: box center is on ink');
  const a = bubbleArea(img, box);
  assert.ok(a.w > 100, `fill reaches the bubble borders, got w=${a.w}`);
  assert.ok(a.x >= 76 && a.x + a.w <= 205, `stays inside the real borders, got x=${a.x} w=${a.w}`);
});

test('bubbleArea: ink-heavy box keeps the center-seed fill when the vote flips', () => {
  // center pixel is interior (white) but ~70% of the box is ink, so the modal
  // vote picks ink — only the center-seed fallback keeps the real area.
  const W = 400, H = 300;
  const img = page(W, H, [76, 204]);
  for (let y0 = 80; y0 < 122; y0 += 8) {
    for (let y = y0; y < Math.min(y0 + 5, 122); y++) {
      for (let x = 100; x < 180; x++) {
        const i = (y * W + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
      }
    }
  }
  const box = { x1: 100, y1: 80, x2: 180, y2: 122, conf: 0.9 }; // center (140,101) on a white gap
  assert.ok(img.data[(101 * W + 140) * 4] > 60, 'premise: box center is interior');
  const a = bubbleArea(img, box);
  assert.ok(a.w > 100, `fallback keeps the white fill, got w=${a.w}`);
});

test('bubbleArea: pocket-trapped fill floors at the detection box', () => {
  // fill enclosed by glyph strokes: bbox 56x20 inside an 80x40 box — the old
  // code returned the pocket minus margin, i.e. an area SMALLER than the text
  // box (live: 85x57 inside 112x74 → f:13 overflow clip).
  const W = 300, H = 220;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const img = { width: W, height: H, data };
  const ink = (x1, y1, x2, y2) => {
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
      const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
    }
  };
  ink(100, 88, 180, 90);   // top bar
  ink(100, 110, 180, 112); // bottom bar
  ink(110, 88, 112, 112);  // left bar
  ink(168, 88, 170, 112);  // right bar
  const box = { x1: 100, y1: 80, x2: 180, y2: 120, conf: 0.9 };
  const a = bubbleArea(img, box);
  assert.ok(a.w >= 80 && a.h >= 40, `never below the box, got ${a.w}x${a.h}`);
});

test('firstColX: fitting block centers, overflow right-aligns', () => {
  // live case (a narrow box): area 48 wide, 2 cols x 21.6 = 43.2 total.
  // Old code started the first column at the block-left (356.4) and the
  // 2nd column landed almost fully outside — clipped, "no new line".
  assert.equal(firstColX(354, 48, 43.2, 21.6, false), 378);
  // the drawn block [first - (total - colW), first + colW] is area-centered…
  const first = firstColX(354, 48, 43.2, 21.6, false);
  const blockL = first - (43.2 - 21.6), blockR = first + 21.6;
  assert.equal((blockL + blockR) / 2, 354 + 48 / 2);
  assert.ok(blockL >= 354 && blockR <= 354 + 48); // …and fully inside
  // single column: the column itself centers
  assert.equal(firstColX(0, 60, 20, 20, false), 20);
  // overflow: first column right-aligns inside, rest run left into the clip
  assert.equal(firstColX(0, 50, 100, 10, true), 40);
});

test('clampToBorders: fill leaked past a thin border clamps back to it', () => {
  // live case (region 3): text box x=157..255, fill walked left to x=83
  // through the bubble border at x=100 into the neighbor bubble.
  const W = 400, H = 300;
  const img = page(W, H, [100]); // full-height dark border at x=100
  const box = { x1: 157, y1: 39, x2: 255, y2: 260, conf: 0.77 };
  const leaked = { minX: 83, minY: 26, maxX: 331, maxY: 301 };
  const c = clampToBorders(img.data, W, H, [255, 255, 255], box, leaked);
  assert.equal(c.minX, 101, `left overshoot clamps at the border, got ${c.minX}`);
  assert.equal(c.maxX, 331, 'right side untouched (no divider there)');
  assert.equal(c.minY, 26, 'top untouched');
});

test('clampToBorders: genuinely wide bubble keeps its width', () => {
  const W = 200, H = 320;
  const img = page(W, H); // no borders at all
  const box = { x1: 40, y1: 20, x2: 55, y2: 300, conf: 0.9 };
  const fill = { minX: 25, minY: 10, maxX: 70, maxY: 310 };
  assert.deepEqual(clampToBorders(img.data, W, H, [255, 255, 255], box, fill), fill);
});

test('bubbleArea no longer leaks into the neighbor bubble', () => {
  // end-to-end of the live case: narrow text box left of a thin border,
  // white neighbor bubble beyond it — area must stay on its own side.
  const W = 400, H = 300;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < H; y++) { const i = (y * W + 100) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
  const img = { width: W, height: H, data };
  const box = { x1: 157, y1: 39, x2: 255, y2: 260, conf: 0.77 };
  const a = bubbleArea(img, box);
  assert.ok(a.x >= 100, `stays right of the border, got x=${a.x}`);
});

test('inkStats: sparse ink reports low frac + tight bbox; uniform reports zero', () => {
  const W = 222, H = 268;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 200; y < 230; y++) for (let x = 30; x < 70; x++) {
    const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
  }
  const sparse = { width: W, height: H, data };
  const box = { x1: 0, y1: 0, x2: 222, y2: 268, conf: 0.5 };
  const s = inkStats(sparse, box);
  assert.ok(s.frac < 0.03, `sparse ink, got frac=${s.frac}`);
  assert.ok(s.x1 >= 25 && s.x2 <= 75 && s.y1 >= 195 && s.y2 <= 235, `bbox hugs the ink, got ${JSON.stringify(s)}`);
  const u = inkStats(page(W, H), box);
  assert.equal(u.frac, 0, 'uniform box has no ink');
  assert.ok(u.x2 <= u.x1, 'uniform box bbox is invalid (skip signal)');
});

test('layoutArea: near-empty box shrinks to ink; dense box keeps the fill', () => {
  const W = 222, H = 268;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 200; y < 230; y++) for (let x = 30; x < 70; x++) {
    const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
  }
  const box = { x1: 0, y1: 0, x2: 222, y2: 268, conf: 0.5 };
  const shrunk = layoutArea({ width: W, height: H, data }, box);
  assert.ok(shrunk && shrunk.w < 80 && shrunk.h < 60, `shrinks to ink bbox, got ${JSON.stringify(shrunk)}`);
  assert.equal(layoutArea(page(W, H), box), null, 'uniform box skipped');
  // dense text block: ink everywhere, fill area kept
  const dense = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4; dense[i] = dense[i + 1] = dense[i + 2] = 0;
  }
  const kept = layoutArea({ width: W, height: H, data: dense }, box);
  assert.ok(kept && kept.w > 150, `dense box keeps fill area, got ${JSON.stringify(kept)}`);
});

test('bubbleArea: untrusted wide fill caps at 1.5x box centered on it', () => {
  // live region 3 geometry: partial-height neighbor border (y 170-270 only,
  // leak went around its ends) — no full-span divider, fill stays wide.
  const W = 400, H = 300;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 170; y <= 270; y++) { const i = (y * W + 100) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
  const img = { width: W, height: H, data };
  const box = { x1: 157, y1: 39, x2: 255, y2: 260, conf: 0.77 }; // 98 wide, center 206
  const a = bubbleArea(img, box);
  assert.ok(a.w <= 98 * 1.5 + 1, `capped, got w=${a.w}`);
  assert.ok(Math.abs((a.x + a.w / 2) - 206) < 12, `centered on the box, got cx=${a.x + a.w / 2}`);
});

test('bubbleArea: trusted spanning borders keep full width (no cap)', () => {
  // same box, but the border spans the whole height — genuinely wide bubble
  const W = 400, H = 300;
  const img = page(W, H, [100, 331]); // full-height borders both sides
  const box = { x1: 157, y1: 39, x2: 255, y2: 260, conf: 0.77 };
  const a = bubbleArea(img, box);
  assert.ok(a.w > 98 * 1.5, `trusted fill keeps its width, got w=${a.w}`);
  assert.ok(a.x >= 100 && a.x + a.w <= 332, 'still inside the real borders');
});

test('isLight: 6-digit, 3-digit, mid-gray boundary', () => {
  assert.equal(isLight('#ffffff'), true);
  assert.equal(isLight('#fff'), true);
  assert.equal(isLight('#111111'), false);
  assert.equal(isLight('#111'), false);
  assert.equal(isLight('#ff0000'), false); // pure red is dark by luminance
  assert.equal(isLight('#ffff00'), true);
});

// ---- layoutText fit logic (fake ctx: fixed advance ratio, no canvas) ----

function fakeCtx(pxPerChar = 0.6) {
  let size = 12;
  return {
    set font(v) { const m = /([\d.]+)px/.exec(v); if (m) size = +m[1]; },
    get font() { return `${size}px fake`; },
    measureText(s) { return { width: [...s].length * size * pxPerChar }; },
  };
}

test('layoutText: fitting text takes the cap (unchanged behavior)', () => {
  const r = layoutText(fakeCtx(), 'ab cd', 1000, 1000, 40);
  assert.equal(r.fontSize, 40);
  assert.deepEqual(r.lines, ['ab cd']);
});

test('layoutText: unavoidable overflow keeps SMALLEST wrappable, not largest', () => {
  // one line at every size, but maxH fits nothing (minFont 14 default)
  const words = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
  const r = layoutText(fakeCtx(), words, 10000, 20, 40);
  assert.equal(r.fontSize, 14);
});

test('layoutText: spaceless 12-char Thai run splits instead of collapsing the font', () => {
  // live case: 'สุดยอดไปเลย~' stayed one unit and forced f:15 in a
  // 119px column; segmented it wraps and the font recovers
  const r = layoutText(fakeCtx(), 'สุดยอดไปเลย~', 100, 10000, 60);
  assert.ok(r.fontSize >= 30, `segmented Thai should recover the font, got f=${r.fontSize}`);
  assert.ok(r.lines.join('').replace(/ /g, '') === 'สุดยอดไปเลย~', 'rejoin is lossless');
});

test('layoutText: English short words do not gain mid-word breaks', () => {
  const r = layoutText(fakeCtx(), 'hello world', 1000, 10000, 40);
  assert.deepEqual(r.lines, ['hello world']);
});

test('horizontalFits: short text in a tall strip fits; long text does not', () => {
  const strip = { x: 0, y: 0, w: 90, h: 300 };
  assert.equal(horizontalFits(fakeCtx(), 'short line here', strip), true);
  const novel = 'word '.repeat(60).trim();
  assert.equal(horizontalFits(fakeCtx(), novel, strip), false);
});

// ---- width profile / source pitch (enclosed-bubble measurement) ----

// white page with a dark ring of radius r (a bubble outline, interior stays
// white — the real B&W case where the fill must be stopped by the outline)
function ringPage(W, H, cx, cy, r, ring = 4) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= r && d >= r - ring) {
      const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  return { width: W, height: H, data };
}

// horizontal ink bars inside a box (stand-in for the source glyph lines)
function barsInto(img, W, xs, xLen, ys, yLen) {
  for (const y0 of ys) for (let y = y0; y < y0 + yLen; y++) {
    for (let x = xs; x < xs + xLen; x++) {
      const i = (y * W + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
    }
  }
  return img;
}

test('widthProfile: round bubble runs follow the outline, enclosure is high', () => {
  const W = 200, H = 200;
  const img = ringPage(W, H, 100, 100, 70);
  const box = { x1: 70, y1: 85, x2: 130, y2: 115, conf: 0.9 };
  const prof = widthProfile(img, box, false, [255, 255, 255], { x1: 34, y1: 34, x2: 166, y2: 166 }, { loX: 10, loY: 10, hiX: 190, hiY: 190 });
  assert.ok(prof, 'profile measured');
  // rows where the ring runs nearly parallel to the scan line (top/bottom of
  // the circle) cross it too steeply to read as a thin line — they drag the
  // score down, so the bar is the real decision threshold
  assert.ok(prof.enclosed >= ENCLOSED_MIN + 0.2, `outline encloses the rows, got ${prof.enclosed}`);
  const mid = runInterval(prof, 96, 106), top = runInterval(prof, 40, 50);
  assert.ok(mid && top, 'both bands have a run');
  assert.ok(mid[1] - mid[0] > top[1] - top[0] + 20, `middle wider than the top band (${mid[1] - mid[0]} vs ${top[1] - top[0]})`);
  assert.ok(mid[0] >= 34 && mid[1] <= 166, 'runs stay inside the outline');
});

test('widthProfile: open white page has no boundary evidence (no-frame path)', () => {
  const img = page(200, 200);
  const box = { x1: 80, y1: 90, x2: 120, y2: 110, conf: 0.9 };
  const prof = widthProfile(img, box, false, [255, 255, 255], { x1: 40, y1: 40, x2: 160, y2: 160 }, { loX: 40, loY: 40, hiX: 160, hiY: 160 });
  assert.ok(prof, 'rows measured');
  assert.equal(prof.enclosed, 0, 'nothing stops the fill — not a bubble');
});

test('widthProfile: vertical profile measures columns (transposed axes)', () => {
  const W = 220, H = 200;
  const img = ringPage(W, H, 110, 100, 80);
  const box = { x1: 104, y1: 60, x2: 116, y2: 140, conf: 0.9 }; // tall+narrow JA column
  assert.equal(boxIsVertical(box), true, 'premise: vertical box');
  const prof = widthProfile(img, box, true, [255, 255, 255], { x1: 24, y1: 24, x2: 196, y2: 176 }, { loX: 0, loY: 0, hiX: 219, hiY: 199 });
  assert.ok(prof && prof.vertical, 'vertical profile');
  assert.ok(prof.enclosed >= ENCLOSED_MIN, `outline encloses the columns, got ${prof.enclosed}`);
  // middle column runs further along y than the box's own column at the edge
  const mid = runInterval(prof, 104, 116), edge = runInterval(prof, 44, 56);
  assert.ok(mid && edge && mid[1] - mid[0] > edge[1] - edge[0], 'middle column taller than the edge column');
});

test('runInterval: min-over-band narrows to the tightest row; a hole nulls it', () => {
  const mk = (i1, i2) => ({ vertical: false, p0: 0, p1: i1.length - 1, i1: Int32Array.from(i1), i2: Int32Array.from(i2), enclosed: 1 });
  const prof = mk([10, 10, 10, 10, 10, 10, 10, 10], [90, 90, 50, 90, 90, 90, 90, 90]);
  assert.deepEqual(runInterval(prof, 0, 4), [10, 50], 'narrow row 2 wins the band');
  assert.deepEqual(runInterval(prof, 5, 8), [10, 90], 'wide rows keep their width');
  const hole = mk([10, 10, 10], [90, 0, 90]);
  assert.equal(runInterval(hole, 0, 3), null, 'a row with no run rejects the whole band');
  assert.deepEqual(runInterval(hole, 0, 1), [10, 90], 'band without the hole is fine');
});

test('sourcePitch: two glyph lines give the line pitch; noisy boxes bail', () => {
  const W = 200, H = 200;
  const two = barsInto(page(W, H), W, 60, 30, [60, 120], 20); // lines at y 60-80 / 120-140
  const p2 = sourcePitch(two, { x1: 60, y1: 60, x2: 140, y2: 140, conf: 0.9 }, false);
  assert.ok(p2 && Math.abs(p2.pitch - 40) < 1, `pitch = span/lines, got ${p2 && p2.pitch}`);
  assert.ok(p2 && Math.abs(p2.glyph - 20) < 1, `glyph = median band height, got ${p2 && p2.glyph}`);
  const one = barsInto(page(W, H), W, 60, 30, [80], 30);
  const p1 = sourcePitch(one, { x1: 60, y1: 80, x2: 140, y2: 110, conf: 0.9 }, false);
  assert.ok(p1 && Math.abs(p1.pitch - 30) < 1, `single line pitch = band height, got ${p1 && p1.pitch}`);
  assert.equal(p1.glyph, 30, 'single band: glyph = pitch');
  // 10 stripes = texture, not text: implausible band count → no measurement
  const tex = page(W, H);
  for (const y of [40, 44, 48, 52, 56, 60, 64, 68, 72, 76]) barsInto(tex, W, 60, 30, [y], 1);
  assert.equal(sourcePitch(tex, { x1: 60, y1: 40, x2: 140, y2: 80, conf: 0.9 }, false), null);
});

test('sizeCapFrom: font ceiling matches the source pitch (textScale scales it)', () => {
  const W = 200, H = 200;
  const img = barsInto(page(W, H), W, 60, 30, [60, 120], 20);
  const box = { x1: 60, y1: 60, x2: 140, y2: 140, conf: 0.9 };
  // tight source (glyph 20, pitch 40): the pitch bound (22.2) leaves a little
  // room, the glyph height is the floor of the reference — live: matching the
  // pitch alone rendered Thai visibly smaller than 26px source caps
  assert.equal(sizeCapFrom(img, box, false), Math.round(Math.max(20, 40 / 1.8)), 'glyph + pitch reference');
  setRenderTuning({ textScale: 1.5 });
  assert.equal(sizeCapFrom(img, box, false), Math.round(Math.max(20, 40 / 1.8) * 1.5), 'slider scales the ceiling');
  setRenderTuning({ textScale: 1 });
  // a loose caption (10px glyphs, 40px pitch) is bounded by the pitch, not
  // by the tiny glyphs — the spare height is allowed to grow the font
  const loose = barsInto(page(W, H), W, 60, 30, [60, 130], 10);
  assert.equal(sizeCapFrom(loose, { x1: 60, y1: 60, x2: 140, y2: 140, conf: 0.9 }, false), Math.round(40 / (1 + 0.55 + 0.25)), 'spare height allowed'); // same fp order as render.ts
});

test('layoutArea: enclosed bubble keeps the measured profile (wider than the 1.5x cap)', () => {
  const W = 200, H = 200;
  // 40px-wide text box in an 82px-wide bubble: the fill's 0.6 window still
  // reaches the outline (a bubble hugging its text), and the profile beats
  // the legacy 1.5x-box cap. Roomy bubbles beyond the window fall back to the
  // capped rect instead — see the window-edge rule in widthProfile.
  const img = barsInto(ringPage(W, H, 100, 100, 45), W, 90, 30, [92, 102], 4);
  const box = { x1: 85, y1: 88, x2: 125, y2: 112, conf: 0.9 };
  const a = layoutArea(img, box);
  assert.ok(a && a.runs, 'profile path taken');
  assert.ok(a.runs.enclosed >= ENCLOSED_MIN, `enclosed score ${a.runs.enclosed}`);
  assert.ok(a.w > 40 * 1.5 + 1, `wider than the legacy 1.5x-box cap (got ${a.w})`);
  assert.ok(a.x >= 55 && a.x + a.w <= 145, 'still inside the outline');
});

test('layoutArea: no-frame box (white page) stays on the legacy rectangle', () => {
  const W = 200, H = 200;
  const img = barsInto(page(W, H), W, 80, 40, [90, 104], 4);
  const box = { x1: 80, y1: 90, x2: 120, y2: 112, conf: 0.9 };
  const a = layoutArea(img, box);
  assert.ok(a, 'area exists');
  assert.ok(!a.runs, 'no profile for an open background');
  assert.ok(a.w <= 40 * 1.6 + 1, `legacy box+30%/1.5x behavior, got w=${a.w}`);
});

// ---- layoutTextFit: per-line bands (fake ctx) ----

function bandProfile(rows, widthAt, x1 = 0) {
  const i1 = new Int32Array(rows), i2 = new Int32Array(rows);
  for (let p = 0; p < rows; p++) {
    const w = widthAt(p);
    i1[p] = x1; i2[p] = x1 + w - 1;
  }
  return { vertical: false, p0: 0, p1: rows - 1, i1, i2, enclosed: 1 };
}

test('layoutTextFit: lines use their own band width (narrow top, wide middle)', () => {
  const rows = 100;
  const prof = bandProfile(rows, (p) => (p < 20 ? 60 : p < 80 ? 200 : 60));
  const area = { x: 0, y: 0, w: 200, h: rows, runs: prof };
  const text = 'word '.repeat(8).trim();
  const fit = layoutTextFit(fakeCtx(), text, area, 20);
  assert.ok(fit && fit.lines.length >= 3, `several lines, got ${fit && fit.lines.length}`);
  // every line fits the interval measured at its own band
  fit.lines.forEach((line, j) => {
    const b0 = fit.top + j * fit.lineHeight;
    const iv = runInterval(prof, b0, b0 + fit.lineHeight);
    assert.ok(iv, `band ${j} has a run`);
    assert.ok(fakeCtxMeasure(line, fit.fontSize) <= iv[1] - iv[0] + 0.51, `line ${j} fits its band`);
    assert.ok(fit.centers[j] > iv[0] && fit.centers[j] < iv[1], `line ${j} centers on its run`);
  });
  const widths = fit.lines.map(l => l.length);
  assert.ok(Math.max(...widths) > Math.min(...widths) + 3, `band widths shape the text (${widths.join(',')})`);
});

function fakeCtxMeasure(s, size, pxPerChar = 0.6) {
  return [...s].length * size * pxPerChar;
}

test('widthProfile: text over thick artwork (hair) is not an enclosed bubble', () => {
  // live case: box on a face, fill = the light skin region; its edges are the
  // jaw line (thin) on one side and hair (thick) on the other, plus shading
  // (non-ink) elsewhere. The thin-dark-line test must keep this OFF the
  // profile path — it scored 1.0 on the non-seed test and blew the text over
  // the drawing.
  const W = 220, H = 220;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const ink = (x1, y1, x2, y2) => {
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
      const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
    }
  };
  ink(60, 0, 100, H);   // thick dark hair band down the middle
  ink(100, 40, 220, 120); // thick dark art block right of it
  const img = { width: W, height: H, data };
  const box = { x1: 100, y1: 60, x2: 160, y2: 100, conf: 0.9 }; // on the light area
  const prof = widthProfile(img, box, false, [255, 255, 255], { x1: 40, y1: 40, x2: 180, y2: 120 }, { loX: 0, loY: 0, hiX: 219, hiY: 219 });
  assert.ok(prof, 'rows measured');
  assert.ok(prof.enclosed < ENCLOSED_MIN, `art is not a bubble outline, got ${prof.enclosed}`);
});

test('widthProfile/fitArea: leaked rows trim out of the placement area', () => {
  // caption box with a thin dark outline; above it, the same white page margin
  // connects through a gap in the outline (leak). Those rows get runs but no
  // outline evidence, so they must NOT stretch the area — live bug: a caption's
  // area doubled its height into the page margin and the text drifted.
  const W = 160, H = 200;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const img = { width: W, height: H, data };
  const rect = (x1, y1, x2, y2, gap) => {
    for (let x = x1; x <= x2; x++) {
      if (gap && x >= gap[0] && x <= gap[1]) continue;
      for (const y of [y1, y2]) { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
    }
    for (let y = y1; y <= y2; y++) for (const x of [x1, x2]) {
      const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
    }
  };
  rect(40, 100, 120, 160, [70, 90]); // caption outline, gap at the top = the leak
  barsInto(img, W, 55, 50, [115, 135], 5); // two source text lines inside the box
  const box = { x1: 45, y1: 105, x2: 115, y2: 155, conf: 0.9 }; // 70x50
  const a = layoutArea(img, box);
  assert.ok(a && a.runs, 'profile path taken');
  assert.ok(a.runs.enclosed < 1, `leak drags the score below 1, got ${a.runs.enclosed}`);
  assert.ok(a.runs.e0 >= 99, `enclosed range starts at the outline, got e0=${a.runs.e0}`);
  assert.ok(a.h <= 70, `area stays the caption, not the leaked page margin (h=${a.h})`);
  assert.ok(a.y >= 99, `area top follows the evidence (y=${a.y})`);
});

// The flood must not start on a glyph: expansion only crosses seed-like pixels,
// so a center buried in a thick glyph traps a white seed and the ink blob wins
// the "largest flood" vote — the placement area then collapses to the source
// column (live: a Japanese column box, font 34 → 13, text wrapped one glyph per
// line). The outside/corner probes give the bubble's own surface a candidate.
test('layoutArea: a center buried in a thick glyph still reaches the bubble', () => {
  // a narrow column box filled mostly with one thick glyph block: the modal and
  // center seeds are the ink, so the bubble surface has to win via the corner /
  // outside probes, and the sideways widen has to find the bubble's sides
  const W = 260, H = 260;
  const img = ringPage(W, H, 130, 130, 100, 5);
  for (let y = 140; y < 220; y++) for (let x = 135; x < 165; x++) {
    const i = (y * W + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
  }
  const box = { x1: 135, y1: 105, x2: 165, y2: 225, conf: 0.9 };
  const a = layoutArea(img, box, true);
  assert.ok(a, 'area measured');
  assert.ok(a.w >= 150, `area spans the bubble, not the glyph (w=${a.w})`);
});

test('layoutArea: a vertical glyph column keeps the bubble width', () => {
  const W = 300, H = 300;
  const img = ringPage(W, H, 150, 150, 120, 5);
  for (const y0 of [70, 130, 190]) for (let y = y0; y < y0 + 40; y++) for (let x = 131; x < 169; x++) {
    const i = (y * W + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
  }
  const box = { x1: 131, y1: 60, x2: 169, y2: 240, conf: 0.9 };
  const a = layoutArea(img, box, true);
  assert.ok(a, 'area measured');
  assert.ok(a.w >= 150, `vertical area spans the bubble, not the column (w=${a.w})`);
});

// live regression (short vertical column in a big round bubble): the box is
// 127x214 (aspect 1.68 < verticalThreshold 2.2) so the layout is horizontal —
// and the box's run axis is x, where the bubble is ~3x wider. The old window
// (+-60% per side) stopped the fill short of the outline, and a window-clipped
// run end counts as NO evidence, so `enclosed` read 0, the rect path took over
// and capped the area at 1.5x the box: Thai wrapped into a skinny strip inside
// a big empty bubble.
test('layoutArea: a short column in a big round bubble keeps the bubble area', () => {
  const W = 500, H = 600;
  const img = ringPage(W, H, 250, 300, 200);
  for (let y = 203; y <= 397; y++) for (let x = 235; x <= 265; x++) {
    const i = (y * W + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
  }
  const box = { x1: 187, y1: 193, x2: 313, y2: 407, conf: 0.9 };
  assert.equal(boxIsVertical(box), false, 'premise: 127x214 stays below the vertical threshold');
  const a = layoutArea(img, box);
  assert.ok(a && a.runs, 'profile path taken');
  assert.ok(a.runs.enclosed >= ENCLOSED_MIN, `outline encloses the rows, got ${a.runs.enclosed}`);
  assert.ok(a.w >= 300, `area spans the bubble, not the 1.5x box cap (w=${a.w})`);
});

// live regression (region 9 of a color-art page): a white bubble on a GRAY
// page. The outline walk used to demand the bubble's own interior color right
// behind the line, and a gray margin never resumed it, so every row scored 0
// and the same shape that passes on a white page fell to the rect path here —
// Thai wrapped into a skinny strip inside a big round bubble.
test('layoutArea: a bubble outlined on a gray page still counts as enclosed', () => {
  const W = 500, H = 500;
  const data = new Uint8ClampedArray(W * H * 4).fill(200); // gray art page
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - 250, y - 250);
    const i = (y * W + x) * 4;
    if (d <= 180 && d >= 176) { data[i] = data[i + 1] = data[i + 2] = 0; }   // 4px outline
    else if (d < 176) { data[i] = data[i + 1] = data[i + 2] = 255; }         // white interior
  }
  for (let y = 117; y <= 383; y++) for (let x = 238; x <= 262; x++) {        // glyph column
    const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
  }
  const img = { width: W, height: H, data };
  const box = { x1: 227, y1: 107, x2: 273, y2: 393, conf: 0.92 }; // live region: 46x286
  assert.equal(boxIsVertical(box), true, 'premise: a vertical column');
  const a = layoutArea(img, box);
  assert.ok(a && a.runs, 'profile path taken');
  assert.ok(a.runs.enclosed >= ENCLOSED_MIN, `gray page behind the line still counts, got ${a.runs.enclosed}`);
  assert.ok(a.w >= 220, `area spans the bubble, not the 1.5x box cap (w=${a.w})`);
});

// live regression (badge 5): the bubble's lower outline runs over thick ink
// (hair/art), the thin-line walk rejects it, and the evidenced rows stop ~37px
// above the box's bottom. The area used to end there, so the block (which fit)
// was centered in the truncated area — the text parked in the bubble's upper
// half (live: area h254 vs box h309; text top 24px above the box top and 88px
// above its bottom). The placement extent must cover the detection box.
test('layoutArea: evidence that stops early still covers the detection box', () => {
  const W = 500, H = 600;
  const img = ringPage(W, H, 250, 300, 200);
  for (let y = 371; y < H; y++) for (let x = 0; x < W; x++) {
    if (Math.abs(Math.hypot(x - 250, y - 300) - 200) < 10) { // 20px thick lower arc
      const i = (y * W + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
    }
  }
  for (let y = 203; y <= 397; y++) for (let x = 235; x <= 265; x++) {
    const i = (y * W + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
  }
  const box = { x1: 187, y1: 193, x2: 313, y2: 407, conf: 0.9 };
  const a = layoutArea(img, box);
  assert.ok(a && a.runs, 'profile path taken');
  assert.ok(a.runs.enclosed < 1 && a.runs.enclosed >= ENCLOSED_MIN, `partial evidence, got ${a.runs.enclosed}`);
  assert.ok(a.runs.e1 < box.y2, `premise: evidence stops above the box bottom (e1=${a.runs.e1}, box ${box.y2})`);
  assert.ok(a.y <= box.y1 + 2, `area top covers the box (y=${a.y} vs ${box.y1})`);
  assert.ok(a.y + a.h >= box.y2 - 2, `area bottom covers the box (${a.y + a.h} vs ${box.y2})`);
});

// A block's first wrap pass starts at the area's reading-order edge, where a
// round bubble is narrowest. A short line that fits the centered band must not
// be skipped because it cannot fit that edge band — the size loop used to drop
// the whole size, shrinking text far below a source the area could hold.
test('layoutTextFit: a line too wide for the edge band still fits centered', () => {
  const prof = {
    vertical: false, p0: 0, p1: 99,
    i1: Int32Array.from({ length: 100 }, (_, i) => (i < 20 || i >= 80 ? 30 : 0)),
    i2: Int32Array.from({ length: 100 }, (_, i) => (i < 20 || i >= 80 ? 70 : 100)),
    enclosed: 1, e0: 0, e1: 99,
  };
  const area = { x: 0, y: 0, w: 100, h: 100, runs: prof };
  const laid = layoutTextFit(fakeCtx(), 'a word', area, 20, 67);
  assert.ok(laid, 'layout exists');
  assert.ok(laid.fontSize >= 18, `kept a usable size (got ${laid.fontSize})`);
  assert.ok(laid.lines.length * laid.lineHeight <= 67.5, `block stays inside maxStack (${laid.lines.length}x${laid.lineHeight})`);
});

// live regression (round bubble, first line wide): the pass at the top edge
// fails, so the centered probe supplies the wrap. Painting the block from that
// probe band hung all 4 Thai lines below the bubble's middle and clipped the
// last one — the block must land centered on the area like any other fit.
test('layoutTextFit: a block that only wraps from the middle band is centered', () => {
  const rows = 300;
  const prof = bandProfile(rows, (p) => (p < 100 ? 70 : 220));
  const area = { x: 0, y: 0, w: 220, h: rows, runs: prof };
  const fit = layoutTextFit(fakeCtx(), 'alphaword / betaword', area, 20, 260);
  assert.ok(fit && fit.lines.length === 2, `two segments, got ${fit && fit.lines.length}`);
  const span = fit.lines.length * fit.lineHeight;
  const center = fit.top + span / 2;
  assert.ok(Math.abs(center - (area.y + area.h / 2)) <= 1, `block centered (top=${fit.top}, span=${span}, center=${center})`);
  assert.ok(fit.centers[0] > 100, `line 0 centered on the wide band (got ${fit.centers[0]})`);
});

// live regression (badge 6, page 8): the round bubble's narrow top band wraps
// the text into MORE lines than the wide middle band does. The centered anchor
// used to come from the edge pass's longer span, so the shorter final block sat
// half a line above center (dump: ly 679, correct centered top 695, n=1 with a
// 2-line span; badge 9 likewise 1014 vs 1051 at n=2/span 3).
test('layoutTextFit: the centered anchor uses the block actually placed', () => {
  const rows = 300;
  const prof = bandProfile(rows, (p) => (p < 100 ? 70 : 220));
  const area = { x: 0, y: 0, w: 220, h: rows, runs: prof };
  // edge pass: band 0 (70px) fits one word → 2 lines; middle band (220px) fits
  // both words on one line → the final block is one line tall
  const fit = layoutTextFit(fakeCtx(), 'alpha beta', area, 20, 260);
  assert.ok(fit && fit.lines.length === 1, `one line in the middle band, got ${fit && fit.lines.length}`);
  const center = fit.top + fit.lineHeight / 2;
  assert.ok(Math.abs(center - (area.y + area.h / 2)) <= 1, `block centered (top=${fit.top}, center=${center}, areaCenter=${area.h / 2})`);
});
