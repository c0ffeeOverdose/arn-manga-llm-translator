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

const { bubbleArea, firstColX, clampToBorders, inkStats, layoutArea, isLight, layoutText, horizontalFits } = await import(new URL('../.test-build/render.mjs', import.meta.url).href);

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
