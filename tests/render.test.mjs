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
  clampRunEnd, RUN_JUMP,
  clipArea,
  dividerClips, growDarkArea, expandCropToInk,
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

// live regression (badge 12): the bubble sits on black art, so the profile's
// outline evidence can never pass (stroke and black beyond are both ink) and
// this rect is the whole fallback. The 1.0 sideways leash stopped the fill
// ~35px out for a 35px column, trust-but-verify saw white beyond the leash and
// the 1.5x cap left a 43px strip inside a ~150px bubble (font 13). The widen
// path reaches the real border.
test('bubbleArea: a bubble on black art still grows to its border', () => {
  const W = 400, H = 400;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data[i * 4 + 3] = 255; // black page
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (Math.hypot(x - 200, y - 200) <= 120) { // white bubble, no stroke of its own
      const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 255;
    }
  }
  // the glyph column fills the box edge to edge (the real JA case) with a few
  // ENCLOSED white pockets — every white seed re-homed to a grid pixel lands in
  // one of those, loses the largest-flood vote to the ink blob and collapses
  // the fill to the column
  for (let y = 105; y <= 295; y++) for (let x = 185; x <= 215; x++) {
    const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
  }
  for (const hy of [150, 200, 250]) for (let y = hy; y < hy + 6; y++) for (let x = 197; x < 203; x++) {
    const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 255;
  }
  const img = { width: W, height: H, data };
  const box = { x1: 185, y1: 105, x2: 215, y2: 295, conf: 0.95 }; // 30x190 column
  const a = bubbleArea(img, box);
  assert.ok(a.w >= 150, `area reaches the bubble border, not the 1.5x cap (w=${a.w})`);
  assert.ok(a.x < 110 && a.x + a.w > 290, `spans the bubble (x=${a.x}, w=${a.w})`);
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

test('layoutText: overflow shrinks below minFont to fit (absolute floor)', () => {
  // one line at every size; maxH 20 fits nothing at minFont 14 (lh 25.2) but
  // fits at f:10 (lh 18) — complete small beats clipped big
  const words = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
  const r = layoutText(fakeCtx(), words, 10000, 20, 40);
  assert.equal(r.fontSize, 10);
  assert.ok(r.lines.length * r.lineHeight <= 20);
});

test('layoutText: nothing fits even at the absolute floor keeps smallest', () => {
  const words = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
  const r = layoutText(fakeCtx(), words, 10000, 10, 40);
  assert.equal(r.fontSize, 8, 'smallest wrappable at the absolute floor, still overflowing');
  assert.ok(r.lines.length * r.lineHeight > 10);
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
  // 60 words need ~288px even at the absolute floor — a 200px strip cannot
  // hold them (the probe shares layoutText's floor, so this stays honest)
  assert.equal(horizontalFits(fakeCtx(), 'word '.repeat(60).trim(), { x: 0, y: 0, w: 90, h: 200 }), false);
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

test('clampRunEnd: an outward jump clamps to the last supported end', () => {
  assert.deepEqual(clampRunEnd(null, 100, 1), { value: 100, leaked: false }, 'first row seeds the support');
  assert.deepEqual(clampRunEnd(100, 96, 1), { value: 96, leaked: false }, 'min side: small moves are a curve');
  assert.deepEqual(clampRunEnd(100, 60, 1), { value: 100, leaked: true }, 'min side: 40px jump outward is a leak');
  assert.deepEqual(clampRunEnd(100, 130, -1), { value: 130, leaked: false }, 'max side: 30px move is a curve');
  assert.deepEqual(clampRunEnd(100, 160, -1), { value: 100, leaked: true }, 'max side: 60px jump outward is a leak');
  assert.deepEqual(clampRunEnd(100, 80, -1), { value: 80, leaked: false }, 'max side: inward moves always pass');
});

// Live page 5 (scaled): a bubble whose outline is open below a screen-tone
// patch, sitting on a page-white field that runs to a far dark line. The fill
// escapes the bubble, follows the field, and the far line passes the
// thin-line test — pre-guard the layout area started 66px left of the box.
// The run-continuity rule clamps the leaked rows at the bubble's last
// supported edge, so the area stays on the box's side of the field.
test('layoutArea: open-field leak below a tone patch stays on the bubble edge', () => {
  const W = 240, H = 200;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const dark = (x, y) => { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; };
  for (let y = 40; y <= 95; y++) { dark(95, y); dark(96, y); }   // bubble's left edge (thin), open below
  for (let y = 96; y <= 190; y++) { dark(41, y); dark(42, y); }  // far art line across the open field
  for (const gx of [115, 130, 145, 160]) for (let y = 90; y < 130; y++) dark(gx, y); // glyphs
  const img = { width: W, height: H, data };
  const box = { x1: 110, y1: 80, x2: 180, y2: 140, conf: 0.9 };
  const a = layoutArea(img, box);
  assert.ok(a, 'area');
  assert.ok(a.x > 90, `area does not follow the leaked field to the far line (x=${a.x})`);
  assert.ok(a.x + a.w >= 180, `and still holds the box width (x2=${a.x + a.w})`);
});

// The rect path gets the same trim: a fill whose right bound jumped past the
// bubble's edge (a thin line that only spans the top rows) must not measure
// the field beyond it — the guard clamps the leaked rows first.
test('bubbleArea: a jumped right bound is trimmed to the supported edge', () => {
  const W = 440, H = 160;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const dark = (x, y) => { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; };
  for (let y = 40; y <= 70; y++) { dark(330, y); dark(331, y); } // bubble edge, top rows only
  for (const gx of [130, 180, 230, 280]) for (let y = 70; y < 100; y++) dark(gx, y);
  const img = { width: W, height: H, data };
  const box = { x1: 100, y1: 60, x2: 320, y2: 110, conf: 0.9 };
  const a = bubbleArea(img, box);
  assert.ok(a.leakR > 0, `right-side rows were clamped (leakR=${a.leakR})`);
  assert.ok(a.x + a.w <= 340, `area stops near the supported edge, not the window (x2=${a.x + a.w})`);
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
  assert.ok(fit && fit.lines.length >= 2, `several lines, got ${fit && fit.lines.length}`);
  // the block is places inside the wide middle band it was wrapped for, not
  // against the narrow reading-order edge
  assert.ok(fit.top >= 19.5 && fit.top + fit.lines.length * fit.lineHeight <= 80.5, `centered in the wide band, top=${fit.top}`);
  // every line fits the interval measured at its own band
  fit.lines.forEach((line, j) => {
    const b0 = fit.top + j * fit.lineHeight;
    const iv = runInterval(prof, b0, b0 + fit.lineHeight);
    assert.ok(iv, `band ${j} has a run`);
    assert.ok(fakeCtxMeasure(line, fit.fontSize) <= iv[1] - iv[0] + 0.51, `line ${j} fits its band`);
    assert.ok(fit.centers[j] > iv[0] && fit.centers[j] < iv[1], `line ${j} centers on its run`);
  });
});

test('runInterval: edge sliver/hole rows are trimmed, an interior hole still nulls', () => {
  const rows = 20;
  const prof = bandProfile(rows, () => 100, 10);
  prof.i1[0] = 1; prof.i2[0] = 0;       // hole at the top edge
  prof.i1[19] = 50; prof.i2[19] = 53;   // 4px sliver at the bottom edge
  assert.deepEqual(runInterval(prof, 0, 20), [10, 109]);
  prof.i1[10] = 1; prof.i2[10] = 0;     // interior gap: a line must not cross it
  assert.equal(runInterval(prof, 0, 20), null);
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
  // The centered-fit preference (see the badge-1 regression below) can trade
  // one size step for a centered block: f16 on one centered line instead of
  // f18 wrapped at the edge band. The floor guards the collapse this test was
  // written for (a bad skip took a live two-word line from 32 to 15).
  assert.ok(laid.fontSize >= 16, `kept a usable size (got ${laid.fontSize})`);
  assert.ok(laid.lines.length * laid.lineHeight <= 67.5, `block stays inside maxStack (${laid.lines.length}x${laid.lineHeight})`);
  const center = laid.top + laid.lines.length * laid.lineHeight / 2;
  assert.ok(Math.abs(center - (area.y + area.h / 2)) <= 1, `centered (top=${laid.top}, center=${center})`);
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

// live regression (badge 1): every profile band was narrower than the caption
// unit even at min font, so the size loop failed outright and the last-resort
// rect layout kicked in — and used to park the block at the area's edge, 39px
// above its own box and over the panel's top border. A fitting block must
// center like the no-profile rect path; only a genuine overflow keeps the
// legacy edge anchor.
test('layoutTextFit: last-resort rect layout centers a fitting block', () => {
  const prof = bandProfile(300, () => 40); // every band narrower than the unit
  const area = { x: 0, y: 0, w: 200, h: 300, runs: prof };
  const fit = layoutTextFit(fakeCtx(), 'abcdefgh', area, 30);
  assert.ok(fit && fit.lines.length === 1, `one line, got ${fit && fit.lines.length}`);
  const center = fit.top + fit.lineHeight / 2;
  assert.ok(Math.abs(center - (area.y + area.h / 2)) <= 1, `centered (top=${fit.top}, center=${center}, areaCenter=${area.h / 2})`);
  // a block that fits only below minFont still centers (no overflow clip)
  const snug = { x: 0, y: 0, w: 200, h: 20, runs: bandProfile(20, () => 40) };
  const small = layoutTextFit(fakeCtx(), 'abcdefgh', snug, 30);
  assert.ok(small && small.lines.length === 1, 'lays out below minFont instead of clipping');
  assert.equal(small.fontSize, 10, 'largest size fitting 20px at any floor');
  assert.ok(Math.abs(small.top + small.lineHeight / 2 - 10) <= 1, `centered (top=${small.top})`);
  // a block that truly cannot fit the area keeps the legacy edge anchor
  const tight = { x: 0, y: 0, w: 200, h: 10, runs: bandProfile(10, () => 40) };
  const over = layoutTextFit(fakeCtx(), 'abcdefgh', tight, 30);
  assert.ok(over && over.lines.length === 1, 'overflow still lays out');
  assert.equal(over.top, 0, `unavoidable overflow stays edge-anchored (top=${over.top})`);
});

// live regression (badge 1, page 11): the panel's TOP band is wide while the
// band at the box's own rows is narrower (a leading glyph outside the box eats
// into the run), so the centered re-wrap failed where the edge pass fit. The
// block FITS the area, yet the old anchor rule sent it to the edge: the
// caption sat 39px above its box, over the panel's top border. A failed
// centered re-wrap is not an overflow — center the block.
test('layoutTextFit: a failed centered re-wrap still centers a fitting block', () => {
  const prof = bandProfile(200, (p) => (p < 60 ? 60 : 30)); // top band wide, box band narrow
  const area = { x: 0, y: 0, w: 60, h: 200, runs: prof };
  const fit = layoutTextFit(fakeCtx(), 'abcdefgh', area, 16);
  assert.ok(fit && fit.lines.length === 1, `one line, got ${fit && fit.lines.length}`);
  const center = fit.top + fit.lineHeight / 2;
  assert.ok(Math.abs(center - (area.y + area.h / 2)) <= 1, `block centered (top=${fit.top}, center=${center}, areaCenter=${area.h / 2})`);
});

// ---- split-child clip: the fill must not cross into the sibling region ------
// Live: a balloon pair's areas merged 145px past the split cut (the interiors
// connect through the touching outlines) and the translation laid out across
// both bubbles and the panel border. Split children carry their side of the
// cut; the flood window and the final area clamp to it.

test('clipArea: intersects, and a missing clip is a no-op', () => {
  const a = { x: 10, y: 20, w: 100, h: 50 };
  assert.deepEqual(clipArea(a, undefined), a);
  assert.deepEqual(clipArea(a, { x1: 0, y1: 0, x2: 60, y2: 100 }), { x: 10, y: 20, w: 50, h: 50 });
  assert.deepEqual(clipArea(a, { x1: 50, y1: 0, x2: 60, y2: 30 }), { x: 50, y: 20, w: 10, h: 10 });
  assert.deepEqual(clipArea(a, { x1: 200, y1: 200, x2: 300, y2: 300 }), { x: 200, y: 200, w: 0, h: 0 });
});

// Two white fields split by a wide gap in a dark divider inside one outlined
// "bubble" (the balloon-tangent shape): the fill escapes through the hole into
// the right field's white. The run-continuity guard (RUN_JUMP) clamps the
// leaked runs at the divider, so enclosure drops below the bar and the rect
// fallback caps at 1.5x the box; the child's clip remains the hard stop.
test('layoutArea: divider-hole leak — the guard holds, the clip clamps harder', () => {
  const W = 300, H = 160;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const dark = (x, y) => { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; };
  for (let x = 40; x <= 230; x++) { dark(x, 50); dark(x, 110); }        // outlined bubble, top/bottom
  for (let y = 50; y <= 110; y++) { dark(40, y); dark(230, y); }        // left/right
  for (let y = 50; y <= 110; y++) for (let x = 140; x <= 144; x++) if (y < 70 || y > 100) dark(x, y); // divider with a hole
  for (const gx of [70, 85, 100, 115, 130]) for (let y = 65; y < 95; y++) dark(gx, y); // glyphs (layoutArea needs ink in the box)
  const img = { width: W, height: H, data };
  const box = { x1: 60, y1: 60, x2: 139, y2: 100, conf: 0.9 };
  const leak = layoutArea(img, box);
  assert.ok(leak && leak.x + leak.w > 141, `guard still spills past the cut (1.5x cap, got x2=${leak && leak.x + leak.w})`);
  assert.ok(leak && leak.x + leak.w <= 165, `…but stays on the capped box, got x2=${leak && leak.x + leak.w}`);
  const held = layoutArea(img, { ...box, clip: { x1: 0, y1: 0, x2: 141, y2: H } });
  assert.ok(held && held.x + held.w <= 141, `clip holds the area on its side (got x2=${held && held.x + held.w})`);
  assert.ok(held.w >= 60, `and keeps the box width (got w=${held.w})`);
});

// The area is clamped to the child's clip, but widthProfile's window can be
// wider: a run measured past the area handed the wrapper a line the paint then
// truncated (live: "อยากตอบ" painted as "อยากตอ"). The run axis stops at the
// area, whatever the window allows.
test('widthProfile: the run axis stops at the area, not the fill window', () => {
  const W = 200, H = 120;
  const img = page(W, H, [10, 189]);            // bubble sides, window can reach them
  barsInto(img, W, [60], 40, [40], 40);          // ink inside the box
  const box = { x1: 55, y1: 30, x2: 105, y2: 95, conf: 0.9 };
  const win = { loX: 0, loY: 0, hiX: 199, hiY: 119 };
  const full = widthProfile(img, box, false, [255, 255, 255], { x1: 12, y1: 12, x2: 187, y2: 110 }, win);
  assert.ok(full, 'profile measured');
  assert.ok(Math.max(...Array.from(full.i2)) > 130, 'runs reach the bubble without a clamp');
  const held = widthProfile(img, box, false, [255, 255, 255], { x1: 12, y1: 12, x2: 120, y2: 110 }, win);
  assert.ok(held, 'profile measured with the narrower area');
  for (let k = 0; k < held.i1.length; k++) {
    if (held.i2[k] < held.i1[k]) continue;
    assert.ok(held.i2[k] <= 120, `run ${k} ends at ${held.i2[k]}, past the area edge 120`);
  }
});

test('layoutArea: the clip also bounds the ink-bbox fallback', () => {
  const W = 120, H = 80;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  // a 3x3 speck: ink.frac ≈ 0.014 < 0.03 -> ink-bbox path (pad 6 around it)
  for (let y = 30; y < 33; y++) for (let x = 50; x < 53; x++) { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
  const img = { width: W, height: H, data };
  const box = { x1: 20, y1: 25, x2: 60, y2: 40, conf: 0.9 };
  const unclipped = layoutArea(img, box);
  assert.equal(unclipped.why, 'ink-bbox', `ink-bbox path (got ${unclipped.why})`);
  assert.ok(unclipped.x + unclipped.w > 53, `bbox pad crosses the clip line without it (got x2=${unclipped.x + unclipped.w})`);
  const a = layoutArea(img, { ...box, clip: { x1: 0, y1: 0, x2: 53, y2: H } });
  assert.ok(a && a.x + a.w <= 53, `area clamped to the clip (got x2=${a.x + a.w})`);
});

// ---- divider clips (kissing bubbles) ----

test('dividerClips: overlapping areas of disjoint boxes split at the box-gap midline', () => {
  // live 6/7 geometry: boxes kiss at x541/547, areas overlap 537..553
  const boxes = [
    { x1: 547, y1: 467, x2: 634, y2: 607, conf: 0.84 },
    { x1: 447, y1: 505, x2: 541, y2: 621, conf: 0.89 },
  ];
  const areas = [
    { x: 537, y: 456, w: 107, h: 163 },
    { x: 435, y: 490, w: 118, h: 146 },
  ];
  const divs = dividerClips(boxes, areas);
  assert.equal(divs.length, 2);
  const byIdx = new Map(divs.map(d => [d.index, d]));
  assert.equal(byIdx.get(0).clip.x1, 544, 'right box keeps x>=544');
  assert.equal(byIdx.get(1).clip.x2, 544, 'left box keeps x<=544');
  assert.equal(byIdx.get(0).cutAxis, 'x');
  // the midline clears both boxes: no box loses its own text
  assert.ok(544 >= 541 && 544 <= 547);
});

test('dividerClips: disjoint areas, shared ink, and stacked pairs', () => {
  const boxes = [
    { x1: 0, y1: 0, x2: 40, y2: 40, conf: 1 },
    { x1: 100, y1: 0, x2: 140, y2: 40, conf: 1 },
  ];
  assert.deepEqual(dividerClips(boxes, [
    { x: 0, y: 0, w: 40, h: 40 },
    { x: 100, y: 0, w: 40, h: 40 },
  ]), [], 'disjoint areas: no divider');
  // boxes sharing ink are one text mass (double detection), never divided
  assert.deepEqual(dividerClips(
    [{ x1: 0, y1: 0, x2: 60, y2: 60, conf: 1 }, { x1: 40, y1: 40, x2: 100, y2: 100, conf: 1 }],
    [{ x: 0, y: 0, w: 70, h: 70 }, { x: 30, y: 30, w: 80, h: 80 }],
  ), [], 'overlapping boxes: no divider');
  // stacked pair divides along y
  const v = dividerClips(
    [{ x1: 0, y1: 0, x2: 60, y2: 40, conf: 1 }, { x1: 0, y1: 50, x2: 60, y2: 90, conf: 1 }],
    [{ x: 0, y: 0, w: 60, h: 60 }, { x: 0, y: 30, w: 60, h: 60 }],
  );
  assert.equal(v.length, 2);
  assert.equal(v.find(d => d.index === 0).clip.y2, 45);
  assert.equal(v.find(d => d.index === 1).clip.y1, 45);
  assert.equal(v[0].cutAxis, 'y');
});

test('dividerClips: intersects an existing split clip instead of widening it', () => {
  const boxes = [
    { x1: 547, y1: 467, x2: 634, y2: 607, conf: 1, clip: { x1: 500, y1: 400, x2: 700, y2: 700 }, cutAxis: 'x' },
    { x1: 447, y1: 505, x2: 541, y2: 621, conf: 1 },
  ];
  const areas = [
    { x: 537, y: 456, w: 107, h: 163 },
    { x: 435, y: 490, w: 118, h: 146 },
  ];
  const byIdx = new Map(dividerClips(boxes, areas).map(d => [d.index, d]));
  assert.equal(byIdx.get(0).clip.x1, 544);
  assert.equal(byIdx.get(0).clip.x2, 700, 'existing bound kept');
  assert.equal(byIdx.get(0).cutAxis, 'x', 'existing axis kept');
});

// ---- box-anchored placement (fragment boxes must not float) ----

test('layoutTextFit: boxC parks the block on the source, not the area middle', () => {
  // live #10 shape: 109px area, 1-line text, source box at the bottom
  const rows = 109;
  const prof = bandProfile(rows, () => 67);
  const area = { x: 258, y: 736, w: 67, h: rows, runs: prof };
  const text = 'ได้โปรด';
  const plain = layoutTextFit(fakeCtx(), text, area, 12);
  assert.ok(plain, 'fits');
  assert.ok(Math.abs(plain.top - 736 - (109 - plain.lines.length * plain.lineHeight) / 2) < 1,
    `area-centered without boxC, top=${plain.top}`);
  const anchored = layoutTextFit(fakeCtx(), text, area, 12, undefined, 787);
  assert.ok(anchored, 'fits');
  assert.ok(Math.abs(anchored.top + anchored.lines.length * anchored.lineHeight / 2 - 787) < 2,
    `block centered on the box (787), top=${anchored.top}`);
  assert.ok(anchored.top >= 736 && anchored.top + anchored.lines.length * anchored.lineHeight <= 736 + 109 + 0.5,
    'stays inside the area');
});

test('layoutTextFit: boxC that cannot fit there falls back to area-centered', () => {
  // narrow bands at the box end: the move is rejected, the old top wins
  const rows = 109;
  const prof = bandProfile(rows, (p) => (p < 60 ? 67 : 10));
  const area = { x: 0, y: 0, w: 67, h: rows, runs: prof };
  const fit = layoutTextFit(fakeCtx(), 'ได้โปรด ได้โปรด ได้โปรด', area, 20, undefined, 100);
  assert.ok(fit, 'fits somewhere');
  assert.ok(fit.top + fit.lines.length * fit.lineHeight / 2 < 80,
    `not parked on the narrow end, top=${fit.top}`);
});

// ---- dark-caption growth ----

function darkPage(W, H, bg, grayFrom = Infinity, gray = 150) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = y >= grayFrom ? gray : bg;
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}

test('growDarkArea: caption strip grows into clean black, stops at art', () => {
  // live #5 shape: 35px box on black, gray art 21px below
  const img = darkPage(200, 200, 8, 120);
  const box = { x1: 45, y1: 64, x2: 230, y2: 99, conf: 0.76 }; // 185x35
  const area = { x: 45, y: 64, w: 185, h: 35 };
  const g = growDarkArea(img, box, area);
  assert.ok(g, 'grows');
  assert.equal(g.y + g.h, 120, `grows down to the gray, got y2=${g.y + g.h}`);
  assert.equal(g.y, 15, `remaining cap grows up, got y=${g.y}`);
  assert.ok(g.y + g.h - g.y <= 35 + 70, 'capped at 2x box height');
});

test('growDarkArea: light interiors grow nothing; growth never crosses art', () => {
  const white = darkPage(100, 100, 250);
  assert.equal(growDarkArea(white, { x1: 10, y1: 10, x2: 60, y2: 40, conf: 1 }, { x: 10, y: 10, w: 50, h: 30 }), null);
  // seed dark with gray art directly below: grows up into clean black, never
  // past the gray
  const img = darkPage(100, 100, 8, 41, 150);
  const box = { x1: 10, y1: 10, x2: 60, y2: 40, conf: 1 };
  const g = growDarkArea(img, box, { x: 10, y: 10, w: 50, h: 30 });
  assert.ok(g, 'grows where black');
  assert.ok(g.y + g.h <= 41, `never crosses art (y2=${g.y + g.h})`);
});

test('bubbleArea: divider-style unbounded clip sides never widen the area', () => {
  // live: a kiss-divider clip {x1:544, x2:Infinity} maxed the area to the page
  // edge through the cut-axis expansion and the text vanished into a strip
  const img = page(800, 200, [500, 600]);
  // the box sits right of the divider (a real midline always clears both boxes)
  const box = { x1: 550, y1: 20, x2: 590, y2: 180, conf: 1, clip: { x1: 544, y1: -Infinity, x2: Infinity, y2: Infinity }, cutAxis: 'x' };
  const a = bubbleArea(img, box);
  assert.ok(Number.isFinite(a.x + a.w), 'finite');
  assert.ok(a.x >= 544, `keeps the divider (x=${a.x})`);
  assert.ok(a.x + a.w <= 601, `stopped by the border, not infinity (x2=${a.x + a.w})`);
});

test('layoutTextFit: boxC wins outright even over the source budget', () => {
  // live #10: 16px fragment, maxStack budget 18px — the cap-size fit parked on
  // the source must return, not shrink to the budget nor float at the edge
  const rows = 109;
  const prof = bandProfile(rows, () => 67);
  const area = { x: 258, y: 736, w: 67, h: rows, runs: prof };
  const fit = layoutTextFit(fakeCtx(), 'ได้โปรด', area, 12, 18, 787);
  assert.ok(fit, 'fits');
  assert.equal(fit.fontSize, 12, 'cap size kept (no budget shrink)');
  assert.ok(Math.abs(fit.top + fit.lineHeight / 2 - 787) < 2, `parked on the box (top=${fit.top})`);
});

// ---- OCR-crop expansion (edge-cut glyphs re-enter the read window) ----

function inkRect(img, W, x1, y1, x2, y2, v = 0) {
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
    const i = (y * W + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
  }
  return img;
}

test('expandCropToInk: edge-cut glyph grows the window to include it', () => {
  // live #8 shape: 103x121 box, padded rect cuts a glyph 24px past x2
  const img = page(400, 300);
  inkRect(img, 400, 100, 60, 140, 120); // main text mass inside
  inkRect(img, 400, 195, 20, 235, 48);  // lobe glyph sticking past the rect
  const box = { x1: 108, y1: 30, x2: 211, y2: 151, conf: 0.9 };
  const rect = { x: 96, y: 18, w: 127, h: 145 }; // padded: x2=223 cuts the glyph
  const e = expandCropToInk(img, box, rect);
  assert.ok(e.x + e.w >= 235 && e.x + e.w <= 235 + 8, `covers the glyph + margin, got x2=${e.x + e.w}`);
  assert.equal(e.x, 96, 'clean left edge stays');
  assert.ok(e.y <= 20 && e.y + e.h >= 48 + 2, 'top/bottom reach the glyph rows');
});

test('expandCropToInk: clean edges never move; daylight gaps stop growth', () => {
  const img = page(400, 300);
  inkRect(img, 400, 100, 60, 140, 120);
  const box = { x1: 108, y1: 30, x2: 211, y2: 151, conf: 0.9 };
  const rect = { x: 96, y: 18, w: 127, h: 145 };
  assert.deepEqual(expandCropToInk(img, box, rect), rect, 'no ink near edges: identical');
  // a neighbor 5px past the edge (clean gap >= margin): untouched
  const img2 = page(400, 300);
  inkRect(img2, 400, 100, 60, 140, 120);
  inkRect(img2, 400, 228, 60, 260, 120);
  assert.deepEqual(expandCropToInk(img2, box, rect), rect, 'daylight gap: identical');
});

test('expandCropToInk: contiguous ink stops at the cap; clip clamps', () => {
  // a wide glyph mass cut by the edge (41% touch) runs far past the cap and
  // continues into the box text: growth absorbs it but stops at the cap
  const img = page(800, 200);
  inkRect(img, 800, 100, 60, 400, 120); // one wide glyph mass, same text
  const box = { x1: 108, y1: 30, x2: 211, y2: 151, conf: 0.9 }; // min dim 103 -> cap 52
  const rect = { x: 96, y: 18, w: 127, h: 145 }; // x2 = 223
  const e = expandCropToInk(img, box, rect);
  assert.equal(e.x + e.w, 211 + 52, `capped at box+cap (x2=${e.x + e.w})`);
  // split child: the cut side never crosses into the sibling
  const boxC = { ...box, clip: { x1: 0, y1: 0, x2: 230, y2: 200 }, cutAxis: 'x' };
  const ec = expandCropToInk(img, boxC, rect);
  assert.ok(ec.x + ec.w <= 230, `clip clamps (x2=${ec.x + ec.w})`);
});

test('expandCropToInk: white glyph on dark caption expands symmetrically', () => {
  const img = darkPage(300, 200, 8);
  inkRect(img, 300, 100, 60, 140, 120, 245); // light glyph mass
  inkRect(img, 300, 45, 64, 85, 116, 245);  // cut off at the left edge, continues in
  const box = { x1: 80, y1: 50, x2: 200, y2: 130, conf: 0.9 };
  const e = expandCropToInk(img, box, { x: 70, y: 40, w: 140, h: 100 });
  assert.ok(e.x <= 45, `covers the cut glyph (x=${e.x})`);
});

test('expandCropToInk: spanning rule is not a cut glyph (fraction guard)', () => {
  // caption strip with white rules top/bottom: full-width touches must not grow
  const img = darkPage(300, 200, 8);
  inkRect(img, 300, 40, 90, 240, 110, 245); // caption glyphs
  inkRect(img, 300, 0, 84, 299, 86, 245);   // top rule spans everything
  inkRect(img, 300, 0, 114, 299, 116, 245); // bottom rule spans everything
  const box = { x1: 60, y1: 88, x2: 220, y2: 112, conf: 0.9 };
  const rect = { x: 56, y: 84, w: 168, h: 32 };
  assert.deepEqual(expandCropToInk(img, box, rect), rect, 'rules ignored');
});

test('expandCropToInk: neighbor fragment in daylight is not ours (connectivity)', () => {
  // white page: box glyphs + a disconnected sliver fully past the pad edge
  const img = page(400, 300);
  inkRect(img, 400, 100, 60, 140, 120); // box text (ends x140)
  inkRect(img, 400, 162, 70, 170, 110); // neighbor sliver, daylight on both sides
  const box = { x1: 90, y1: 50, x2: 145, y2: 130, conf: 0.9 };
  const rect = { x: 80, y: 40, w: 77, h: 100 }; // x2 = 157, sliver starts at 160
  assert.deepEqual(expandCropToInk(img, box, rect), rect, 'untouched');
});
