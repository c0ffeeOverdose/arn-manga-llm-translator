// Thai text rendering into bubble regions on canvas.
// Layout logic ported from our fork work (text_render_eng.py): LLM spaces are
// phrase boundaries (preserved), Thai words run together without spaces, ICU
// (Intl.Segmenter) splits long Thai runs, " / " marks pre-broken lines,
// shrink-to-fit font sizing, headroom for Thai mark stacks.

import type { DetBox } from './detection';

const FONT = 'Sriracha';           // Thai handwriting font (bundled)
const TRACKING = 0.1;      // letter spacing as fraction of font size
const LINE_SPACING = 0.25; // extra line gap as fraction
const HEADROOM = 0.55;     // vertical room for Thai vowel/tone marks
const MIN_FONT = 14;
const MAX_FONT = 200;

// tunable via pipeline settings (set before rendering a page).
// font is a CSS stack: Thai uses the bundled Sriracha, other languages
// fall back to system fonts (Noto Sans CJK covers zh/ja/ko on Linux/ChromeOS).
export const renderTuning = { minFont: MIN_FONT, letterSpacing: TRACKING, verticalThreshold: 2.2, preferHorizontal: true, font: `${FONT}, sans-serif`, textColor: 'auto', strokeColor: 'auto', textStroke: 0.1, textScale: 1 };

// Render-logic generation, stamped into the [mt] page result dump — bump on
// ANY render.ts layout change so a stale-extension vs weak-fix question is
// answered by the dump instead of guesswork.
export const RENDER_GEN = 25;

export function setRenderTuning(t: { minFont?: number; letterSpacing?: number; verticalThreshold?: number; preferHorizontal?: boolean; font?: string; textColor?: string; strokeColor?: string; textStroke?: number; textScale?: number }): void {
    if (t.minFont) renderTuning.minFont = t.minFont;
    if (t.letterSpacing != null) renderTuning.letterSpacing = t.letterSpacing;
    if (t.verticalThreshold) renderTuning.verticalThreshold = t.verticalThreshold;
    if (t.preferHorizontal != null) renderTuning.preferHorizontal = t.preferHorizontal;
    if (t.font) renderTuning.font = t.font;
    if (t.textColor) renderTuning.textColor = t.textColor;
    if (t.strokeColor) renderTuning.strokeColor = t.strokeColor;
    if (t.textStroke != null) renderTuning.textStroke = t.textStroke;
    if (t.textScale) renderTuning.textScale = t.textScale;
}

// Font stack per target language: Thai gets the handwriting font, everything
// else renders with system fonts (canvas falls back per-glyph through the stack).
export function fontStackFor(lang: string): string {
    return /^thai$/i.test(lang.trim()) ? `${FONT}, sans-serif` : 'sans-serif';
}

let fontReady: Promise<void> | null = null;

export function ensureFont(): Promise<void> {
    if (!fontReady) {
        fontReady = (async () => {
            // stack starts with a custom font → Sriracha is only the fallback;
            // load it too so the fallback actually works for missing glyphs
            const customFirst = /^[^,]+\s*,/.test(renderTuning.font) && !renderTuning.font.startsWith(FONT);
            const loadSriracha = renderTuning.font.includes(FONT);
            if (customFirst && !loadSriracha) return; // non-Thai stack + custom: nothing bundled to load
            if (!loadSriracha && !customFirst) return; // non-Thai: system fonts, nothing to load
            const face = new FontFace(FONT, `url(${chrome.runtime.getURL('fonts/Sriracha-Regular.ttf')})`);
            await face.load();
            document.fonts.add(face);
        })();
    }
    return fontReady;
}

// ICU Thai word breaking (browser equivalent of pythainlp in the fork)
let segmenter: Intl.Segmenter | null = null;
function thaiWords(text: string): string[] {
    if (!segmenter) segmenter = new Intl.Segmenter('th', { granularity: 'word' });
    return [...segmenter.segment(text)].map(s => s.segment).filter(w => w.trim());
}

// Wrap units: Thai words join WITHOUT spaces (standard Thai typography);
// explicit LLM spaces are phrase boundaries and are kept.
interface Unit { t: string; spaceBefore: boolean }

// A spaceless Thai run must segment at ANY length: a 12-char run in a
// narrow box would otherwise force the whole font down to fit it whole
// (live: f:15 on an AVIF-first reader). Other scripts keep single-unit behavior — an
// English word must not gain mid-word break opportunities.
function hasThai(s: string): boolean {
    for (const ch of s) {
        const c = ch.codePointAt(0) ?? 0;
        if (c >= 0x0e00 && c <= 0x0e7f) return true;
    }
    return false;
}
function wrapUnits(line: string): Unit[] {
    const units: Unit[] = [];
    line.split(' ').forEach((part, idx) => {
        if (!part) return;
        const spaceBefore = idx > 0; // preceded by an explicit LLM space
        if (hasThai(part)) {
            let first = true;
            for (const w of thaiWords(part)) {
                units.push({ t: w, spaceBefore: spaceBefore && first });
                first = false;
            }
        } else {
            units.push({ t: part, spaceBefore });
        }
    });
    return units;
}

function joinUnits(units: Unit[]): string {
    let out = '';
    for (const u of units) {
        if (!out) out = u.t;
        else out += (u.spaceBefore ? ' ' : '') + u.t;
    }
    return out;
}

export interface LaidOut {
    lines: string[];
    fontSize: number;
    lineHeight: number;
}

function setFont(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, size: number) {
    ctx.font = `${size}px ${renderTuning.font}`;
    (ctx as any).letterSpacing = `${renderTuning.letterSpacing * size}px`;
}

// Greedy wrap of the segmented text into lines, asking `widthFor(lineIdx)` how
// much room the line being filled has. The legacy path answers with the area
// width for every line; the profile path answers with the run measured at that
// line's own band (see layoutTextFit). `failed` = a single unit wider than its
// line (used by the callers to shrink the font).
function wrapUnitsIntoLines(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    segments: string[],
    widthFor: (lineIdx: number) => number,
): { lines: string[]; failed: boolean } {
    const lines: string[] = [];
    for (const seg of segments) {
        const units = wrapUnits(seg);
        let cur: Unit[] = [];
        for (const u of units) {
            const cand = joinUnits([...cur, u]);
            if (ctx.measureText(cand).width <= widthFor(lines.length)) {
                cur.push(u);
            } else {
                if (!cur.length) return { lines: [], failed: true }; // single unit wider than the area
                lines.push(joinUnits(cur));
                cur = [u];
                if (ctx.measureText(u.t).width > widthFor(lines.length)) return { lines: [], failed: true };
            }
        }
        if (cur.length) lines.push(joinUnits(cur));
    }
    return { lines, failed: false };
}

// letterSpacing is appended AFTER every glyph INCLUDING the last one, so
// measureText() width overstates the inked width by one track — centered
// text lands half a track LEFT of true center. Shift the anchor right by
// half a track to compensate (per orientation).
function halfTrack(): number {
    return renderTuning.letterSpacing * 0.5; // × fontSize at the call site
}

// Fit text into (maxW, maxH), trying font sizes from `cap` down to MIN_FONT.
// " / " segments are hard line groups. Returns the largest size whose wrapped
// lines fit; on overflow, the SMALLEST wrappable layout — showing the most
// text small beats one giant clipped line (live: vertical strip kept f:49
// and showed a single column).
export function layoutText(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    text: string,
    maxW: number,
    maxH: number,
    cap: number = MAX_FONT,
): LaidOut {
    const segments = text.split(' / ').map(s => s.trim()).filter(Boolean);
    if (!segments.length) return { lines: [], fontSize: renderTuning.minFont, lineHeight: renderTuning.minFont };

    let fallback: LaidOut | null = null;
    for (let size = cap; size >= renderTuning.minFont; size -= 2) {
        setFont(ctx, size);
        const lineHeight = size * (1 + HEADROOM + LINE_SPACING);
        const { lines, failed } = wrapUnitsIntoLines(ctx, segments, () => maxW);
        if (failed) continue;
        if (lines.length * lineHeight <= maxH) {
            return { lines, fontSize: size, lineHeight };
        }
        fallback = { lines, fontSize: size, lineHeight }; // keep smallest, not first
    }
    if (fallback) return fallback;
    setFont(ctx, renderTuning.minFont);
    return { lines: segments, fontSize: renderTuning.minFont, lineHeight: renderTuning.minFont * (1 + HEADROOM + LINE_SPACING) };
}

// Border ink for the clamp below: dark AND far from the seed color (the
// same >=60 distance that stops the fill — anti-aliased bubble interiors
// and screentone don't qualify, real borders do).
function isBorderInk(data: Uint8ClampedArray, i: number, r0: number, g0: number, b0: number): boolean {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return lum < 100 && Math.abs(data[i] - r0) + Math.abs(data[i + 1] - g0) + Math.abs(data[i + 2] - b0) >= 60;
}

// Border-cross clamp (exported pure for tests): the fill walks on
// seed-similar pixels and can slip through a thin/anti-aliased bubble
// border into a neighbor bubble's white, claiming it as layout area. A
// real border is a dark line spanning the fill — scan the overshoot on
// each side (outside the box only, walking out from the box edge) and
// clamp to the first column/row that's >=70% border ink. No divider =
// unchanged (a genuinely wide bubble keeps its width).
export function clampToBorders(
    data: Uint8ClampedArray, W: number, H: number,
    seed: [number, number, number],
    box: DetBox,
    fill: { minX: number; minY: number; maxX: number; maxY: number },
): { minX: number; minY: number; maxX: number; maxY: number } {
    const [r0, g0, b0] = seed;
    const ink = (x: number, y: number) => isBorderInk(data, (y * W + x) * 4, r0, g0, b0);
    const colFrac = (x: number, y1: number, y2: number) => {
        let d = 0, n = 0;
        for (let y = y1; y <= y2; y++) { n++; if (ink(x, y)) d++; }
        return n ? d / n : 0;
    };
    const rowFrac = (y: number, x1: number, x2: number) => {
        let d = 0, n = 0;
        for (let x = x1; x <= x2; x++) { n++; if (ink(x, y)) d++; }
        return n ? d / n : 0;
    };
    let { minX, minY, maxX, maxY } = fill;
    const y1 = Math.max(0, minY), y2 = Math.min(H - 1, maxY);
    for (let x = Math.floor(box.x1) - 1; x >= minX; x--) {
        if (colFrac(x, y1, y2) >= 0.7) { minX = x + 1; break; }
    }
    for (let x = Math.ceil(box.x2) + 1; x <= maxX; x++) {
        if (colFrac(x, y1, y2) >= 0.7) { maxX = x - 1; break; }
    }
    const x1 = Math.max(0, minX), x2 = Math.min(W - 1, maxX);
    for (let y = Math.floor(box.y1) - 1; y >= minY; y--) {
        if (rowFrac(y, x1, x2) >= 0.7) { minY = y + 1; break; }
    }
    for (let y = Math.ceil(box.y2) + 1; y <= maxY; y++) {
        if (rowFrac(y, x1, x2) >= 0.7) { maxY = y - 1; break; }
    }
    return { minX, minY, maxX, maxY };
}

// Ink coverage inside the detection box (exported pure for tests): pixels
// differing from the box-center seed count as ink — works dark-on-light
// and light-on-dark. A tight box seeded on a glyph just reports high frac
// (safe no-op); a near-empty box reports ~0 with an invalid bbox.
export function inkStats(img: ImageData, box: DetBox): { frac: number; x1: number; y1: number; x2: number; y2: number } {
    const { width: W, height: H, data } = img;
    const cx = Math.max(0, Math.min(W - 1, Math.floor((box.x1 + box.x2) / 2)));
    const cy = Math.max(0, Math.min(H - 1, Math.floor((box.y1 + box.y2) / 2)));
    const si = (cy * W + cx) * 4;
    const r0 = data[si], g0 = data[si + 1], b0 = data[si + 2];
    const x1 = Math.max(0, Math.floor(box.x1)), y1 = Math.max(0, Math.floor(box.y1));
    const x2 = Math.min(W - 1, Math.ceil(box.x2)), y2 = Math.min(H - 1, Math.ceil(box.y2));
    let n = 0, ink = 0, ix1 = x2, iy1 = y2, ix2 = x1, iy2 = y1;
    const stepX = Math.max(1, Math.floor((x2 - x1) / 48));
    const stepY = Math.max(1, Math.floor((y2 - y1) / 48));
    for (let y = y1; y <= y2; y += stepY) {
        for (let x = x1; x <= x2; x += stepX) {
            const i = (y * W + x) * 4;
            n++;
            if (Math.abs(data[i] - r0) + Math.abs(data[i + 1] - g0) + Math.abs(data[i + 2] - b0) >= 60) {
                ink++;
                if (x < ix1) ix1 = x; if (x > ix2) ix2 = x;
                if (y < iy1) iy1 = y; if (y > iy2) iy2 = y;
            }
        }
    }
    return { frac: n ? ink / n : 0, x1: ix1, y1: iy1, x2: ix2, y2: iy2 };
}

// Flood seed = the box's most common color (bubble interior), NOT the center
// pixel: a center landing on a glyph seeds a fill of the glyph only, which
// collapses the area to the padded-box fallback and wraps the translation
// too narrow (clip bait). Sampled colors are quantized to 4 bits/channel and
// averaged so anti-aliased noise doesn't split the interior vote; when the
// center is already interior (the common case) this picks the same color.
function interiorSeed(data: Uint8ClampedArray, W: number, H: number, box: DetBox): [number, number, number] {
    const x1 = Math.max(0, Math.floor(box.x1)), y1 = Math.max(0, Math.floor(box.y1));
    const x2 = Math.min(W - 1, Math.ceil(box.x2)), y2 = Math.min(H - 1, Math.ceil(box.y2));
    const stepX = Math.max(1, Math.floor((x2 - x1) / 24));
    const stepY = Math.max(1, Math.floor((y2 - y1) / 24));
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    let best: { n: number; r: number; g: number; b: number } | null = null;
    for (let y = y1; y <= y2; y += stepY) {
        for (let x = x1; x <= x2; x += stepX) {
            const i = (y * W + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
            let bkt = buckets.get(key);
            if (!bkt) { bkt = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, bkt); }
            bkt.n++; bkt.r += r; bkt.g += g; bkt.b += b;
            if (!best || bkt.n > best.n) best = bkt;
        }
    }
    const cx = Math.max(0, Math.min(W - 1, Math.floor((box.x1 + box.x2) / 2)));
    const cy = Math.max(0, Math.min(H - 1, Math.floor((box.y1 + box.y2) / 2)));
    if (!best) {
        const i = (cy * W + cx) * 4;
        return [data[i], data[i + 1], data[i + 2]];
    }
    return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
}

// Interior test used by every measurement below (the flood fill's own
// tolerance): pixels this close to the seed are the same surface.
function seedLike(data: Uint8ClampedArray, i: number, seed: [number, number, number]): boolean {
    return Math.abs(data[i] - seed[0]) + Math.abs(data[i + 1] - seed[1]) + Math.abs(data[i + 2] - seed[2]) < 60;
}

export interface InteriorFill {
    seed: [number, number, number];
    minX: number; minY: number; maxX: number; maxY: number;
    count: number;
    // Hard window the fill could not leave (the grow bounds): a run that reaches
    // it was clipped by the window, not stopped by ink.
    loX: number; loY: number; hiX: number; hiY: number;
}

// CTD text mask (full-res, 255 = text). Text pixels are passable in every
// fill/profile walk: glyphs are eraser territory, not bubble edges. Without
// this a dense glyph run cuts its own measured run at the first stroke — live:
// a spiky white bubble measured 95px of its ~118px interior, font 17 against a
// ~22px source. Wrong-size masks (a different page/scale) are ignored.
export interface TextMask { width: number; height: number; data: ArrayBuffer }

function maskView(mask: TextMask | undefined, W: number, H: number): Uint8Array | null {
    if (!mask || mask.width !== W || mask.height !== H) return null;
    return new Uint8Array(mask.data);
}

// Bounded flood fill of the bubble interior from the detection box center.
// Seed = the box's most common color (a center landing on a glyph would flood
// the glyph only), with the center pixel as an alternate — whichever floods
// more pixels wins. Bounded to box ± grow (growX sideways) so a white page
// cannot be claimed as layout area.
function interiorFill(img: ImageData, box: DetBox, growX: number, grow: number, widen = false, mask?: TextMask): InteriorFill {
    const { width: W, height: H, data } = img;
    const cx = Math.floor((box.x1 + box.x2) / 2);
    const cy = Math.floor((box.y1 + box.y2) / 2);
    const si = (cy * W + cx) * 4;
    const center: [number, number, number] = [data[si], data[si + 1], data[si + 2]];
    const modal = interiorSeed(data, W, H, box);

    const boxW = box.x2 - box.x1, boxH = box.y2 - box.y1;
    // Split children carry a clip (their side of the cut): the flood must not
    // cross into the sibling region even when the outlines have a hole — a
    // leaked fill claims the sibling's white and the area bbox spans both.
    const clip = box.clip;
    const window4 = (gx: number, gy: number) => {
        let loX = Math.max(0, Math.floor(box.x1 - boxW * gx));
        let loY = Math.max(0, Math.floor(box.y1 - boxH * gy));
        let hiX = Math.min(W - 1, Math.ceil(box.x2 + boxW * gx));
        let hiY = Math.min(H - 1, Math.ceil(box.y2 + boxH * gy));
        if (clip) {
            loX = Math.max(loX, Math.ceil(clip.x1));
            loY = Math.max(loY, Math.ceil(clip.y1));
            hiX = Math.min(hiX, Math.floor(clip.x2));
            hiY = Math.min(hiY, Math.floor(clip.y2));
            loX = Math.min(loX, hiX); // degenerate clip: keep a valid window
            loY = Math.min(loY, hiY);
        }
        return { loX, loY, hiX, hiY };
    };

    // Start pixel for a seed = the sampled pixel nearest the box center that
    // matches it. Flooding from the center itself is wrong when the center sits
    // on a thick glyph: the flood may only cross seed-like pixels, so with a
    // white seed it never leaves the glyph, and the ink blob wins the "largest
    // flood" vote instead (live: a Japanese column box's placement area
    // collapsed to the glyphs' width, font 34 → 13).
    const grid: number[] = [];
    const probes: number[] = []; // corner sample points, kept out of the nearest-to-center vote
    // Just-outside-the-box samples: their flood must START on the sample itself
    // (see fillFrom) — these are the pixels standing on the surface the text
    // sits on, while every grid pixel is inside a box that may hold nothing but
    // glyph pockets.
    const outside: number[] = [];
    {
        const gx1 = Math.max(0, Math.floor(box.x1)), gy1 = Math.max(0, Math.floor(box.y1));
        const gx2 = Math.min(W - 1, Math.ceil(box.x2)), gy2 = Math.min(H - 1, Math.ceil(box.y2));
        const stepX = Math.max(1, Math.floor((gx2 - gx1) / 24)), stepY = Math.max(1, Math.floor((gy2 - gy1) / 24));
        for (let y = gy1; y <= gy2; y += stepY) for (let x = gx1; x <= gx2; x += stepX) grid.push(y * W + x);
        for (const [x, y] of [[gx1, gy1], [gx2, gy1], [gx1, gy2], [gx2, gy2]] as const) probes.push(y * W + x);
        // …and just outside each edge: a box hugging its glyphs has no interior
        // pixel of its own, and the surface the text sits on starts a few px out
        for (const [x, y] of [
            [Math.round(box.x1) - 3, cy], [Math.round(box.x2) + 3, cy],
            [cx, Math.round(box.y1) - 3], [cx, Math.round(box.y2) + 3],
        ] as const) {
            if (x >= 0 && y >= 0 && x < W && y < H) outside.push(y * W + x);
        }
    }
    const startFor = (seed: [number, number, number]): number => {
        let best = cy * W + cx, bestD = Infinity;
        for (const p of grid) {
            if (!seedLike(data, p * 4, seed)) continue;
            const d = Math.abs((p % W) - cx) + Math.abs(((p / W) | 0) - cy);
            if (d < bestD) { bestD = d; best = p; }
        }
        return best;
    };
    const visited = new Uint8Array(W * H);
    const mk = maskView(mask, W, H);
    type Win = ReturnType<typeof window4>;
    const fillFrom = (seed: [number, number, number], win: Win, at?: number) => {
        visited.fill(0);
        // A seed sampled just outside the box starts there: re-homing it to the
        // nearest grid pixel lands the flood in a pocket between glyphs (a box
        // hugging a vertical JA column has no interior pixel of its own), the
        // pocket loses the largest-flood vote to the ink blob, and the fill
        // collapses to the glyph column (live: badge 12, area 43x205 in a
        // ~150px bubble, font 13).
        const start = at != null && seedLike(data, at * 4, seed) ? at : startFor(seed);
        const sx = start % W, sy = (start / W) | 0;
        const queue = [start];
        visited[start] = 1;
        let minX = sx, maxX = sx, minY = sy, maxY = sy, count = 0;
        while (queue.length) {
            const p = queue.pop()!;
            const x = p % W, y = (p / W) | 0;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            count++;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
                const nx = x + dx, ny = y + dy;
                if (nx < win.loX || ny < win.loY || nx > win.hiX || ny > win.hiY) continue;
                const np = ny * W + nx;
                if (visited[np]) continue;
                if (seedLike(data, np * 4, seed) || (mk != null && mk[np] > 127)) {
                    visited[np] = 1;
                    queue.push(np);
                }
            }
        }
        return { minX, minY, maxX, maxY, count, seed };
    };
    // Candidates: the modal interior color, the center pixel, and the colors
    // of the corner/outside probes (4-bit dedup) — whichever surface floods
    // largest is the one the box actually sits on.
    const key = (c: [number, number, number]) => (c[0] >> 4 << 8) | (c[1] >> 4 << 4) | (c[2] >> 4);
    const seeds: { c: [number, number, number]; at?: number }[] = [{ c: modal }, { c: center }];
    for (const p of probes) seeds.push({ c: [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]] });
    for (const p of outside) seeds.push({ c: [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]], at: p });
    const bestFor = (win: Win, skipLeaks = false) => {
        let best = fillFrom(seeds[0].c, win, seeds[0].at);
        if (skipLeaks && windowFilled(best, win)) best = { ...best, count: -1 };
        const seenColor = new Set<number>([key(seeds[0].c)]);
        const seenAt = new Set<number>();
        for (const seed of seeds.slice(1)) {
            // color-only seeds dedup by colour, outside samples by pixel: a
            // pocket and the bubble surface are the same colour, so deduping
            // the sample away would lose the only flood that reaches the
            // bubble (see fillFrom).
            if (seed.at != null) {
                if (seenAt.has(seed.at)) continue;
                seenAt.add(seed.at);
            } else {
                if (seenColor.has(key(seed.c))) continue;
                seenColor.add(key(seed.c));
            }
            let alt = fillFrom(seed.c, win);
            // Rescue for a trapped sample: a box hugging a vertical JA column
            // has no interior pixel of its own, so a white seed's nearest grid
            // pixel sits in a glyph-gap pocket — a flood that loses the
            // largest-surface vote to the ink blob (live: badge 12: the pocket
            // cluster covered ~40% of the box, the fill came out as the column,
            // area 43x205 inside a ~150px bubble, font 13). Re-flood from the
            // sample itself when the grid flood cannot even fill the box. Only
            // then: an outside sample may stand on the page beyond the outline,
            // and its own flood would beat the bubble's fill (the page is
            // bigger) — the box-containment of the winner is what makes the
            // rescue safe.
            if (seed.at != null && alt.count < boxW * boxH) {
                const rescued = fillFrom(seed.c, win, seed.at);
                if (rescued.count > alt.count) alt = rescued;
            }
            if (skipLeaks && windowFilled(alt, win)) continue;
            if (alt.count > best.count) best = alt;
        }
        return { fill: best, win };
    };
    // A candidate that fills its whole window on every side is a leak, not a
    // surface the box sits on: an outside sample standing on the page beyond
    // the outline floods the page, which is bigger than the bubble's fill and
    // would win the grow vote (and trip longStable), leaving the widen dead
    // (live: badge 12, the widen never fired although the bubble was 4.6x the
    // box). The plain first vote keeps its legacy behaviour.
    const windowFilled = (fl: { minX: number; minY: number; maxX: number; maxY: number }, win: Win) =>
        fl.minX <= win.loX + 1 && fl.minY <= win.loY + 1 && fl.maxX >= win.hiX - 1 && fl.maxY >= win.hiY - 1;
    let pick = bestFor(window4(growX, grow));
    const { fill: f } = pick;
    const touches = f.minX <= pick.win.loX + 1 || f.maxX >= pick.win.hiX - 1 || f.minY <= pick.win.loY + 1 || f.maxY >= pick.win.hiY - 1;
    const shortSide = Math.min(boxW, boxH), longSide = Math.max(boxW, boxH);
    if (widen && touches && shortSide <= longSide * 0.35) {
        // The flood was clipped by the grow window, not stopped by ink — and
        // this is a narrow column box (a vertical JA line), which sits several
        // boxes of empty space away from its bubble's outline. Widen SIDEWAYS
        // only and reject the result if the long axis grew: growth along the
        // long axis is exactly how a fill leaks into the page margin and
        // fabricates outline evidence from art (live: widening both axes turned
        // a 190x217 caption into a 311x851 "profile" and halved a neighbouring
        // font). The tight window used to fuse the column case into "the bubble
        // is the column" (live: 38px box, area 67, font 34 → 13).
        const wide = bestFor(boxH > boxW ? window4(4, grow) : window4(growX, 4), true);
        const g = wide.fill;
        const longStable = boxH > boxW
            ? (g.maxY - g.minY) <= (f.maxY - f.minY) + 2
            : (g.maxX - g.minX) <= (f.maxX - f.minX) + 2;
        if (g.count > f.count && longStable) pick = wide;
    }
    return { ...pick.fill, ...pick.win };
}

// Sideways trim for the no-frame rect (see bubbleArea): per-row runs through
// the box center, clamped with the same continuity rule widthProfile applies
// along its stacking axis. The flood can escape the bubble where its outline
// is open onto a same-coloured field (page white merging with the bubble
// interior below a screen-tone patch): the fill then measures the field, not
// the bubble, and the trust test downstream can even find art (a trunk, a tone
// edge) "verifying" the leaked bound. Live page 5: fill minX 810 for a box at
// 940, the area started 105px left of the box and the Thai text ran over the
// hatch. Horizontal trim only: that is the proven leak geometry, vertical
// bounds keep the clamp/trust/cap chain.
function trimFillX(img: ImageData, box: DetBox, fill: InteriorFill, mask?: TextMask): { minX: number; maxX: number; leakL: number; leakR: number } {
    const { width: W, height: H, data } = img;
    const cx = Math.floor((box.x1 + box.x2) / 2);
    const mk = maskView(mask, W, H);
    const loX = Math.max(0, Math.floor(fill.minX)), hiX = Math.min(W - 1, Math.ceil(fill.maxX));
    const y0 = Math.max(0, Math.floor(fill.minY)), y1 = Math.min(H - 1, Math.ceil(fill.maxY));
    const pass = (x: number, y: number) =>
        (x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2)
        || seedLike(data, (y * W + x) * 4, fill.seed)
        || (mk != null && mk[y * W + x] > 127);
    let supL: number | null = null, supR: number | null = null, leakL = 0, leakR = 0;
    let minX = loX, maxX = hiX, seen = false;
    for (let y = y0; y <= y1; y++) {
        if (!pass(cx, y)) continue;
        let a = cx, b = cx;
        while (a - 1 >= loX && pass(a - 1, y)) a--;
        while (b + 1 <= hiX && pass(b + 1, y)) b++;
        const cl = clampRunEnd(supL, a, 1), cr = clampRunEnd(supR, b, -1);
        if (cl.leaked) leakL++; else supL = cl.value;
        if (cr.leaked) leakR++; else supR = cr.value;
        if (!seen) { minX = cl.value; maxX = cr.value; seen = true; }
        else { if (cl.value < minX) minX = cl.value; if (cr.value > maxX) maxX = cr.value; }
    }
    return seen ? { minX, maxX, leakL, leakR } : { minX: loX, maxX: hiX, leakL: 0, leakR: 0 };
}

// Rectangle placement area — the NO-FRAME path: narration and SFX over art,
// open backgrounds. Flood-fill the box interior, hard-limited to box+30% (1.0×
// sideways for vertical column boxes) and verified against real spanning
// borders (see below), then capped at 1.5× the box. Live-tuned behavior; the
// profile path (fitArea) takes over when a bubble border encloses the box.
export function bubbleArea(img: ImageData, box: DetBox, mask?: TextMask): { x: number; y: number; w: number; h: number; leakL?: number; leakR?: number } {
    const { width: W, height: H, data } = img;
    const boxW = box.x2 - box.x1, boxH = box.y2 - box.y1;
    // Vertical text columns are narrow by nature (CTD hugs the glyphs, not the
    // bubble) while the bubble is wide — the uniform 30% cap below starves the
    // column layout of width and cascades the font to the floor. Let vertical
    // boxes grow 1.0× sideways (dark bubble borders still stop the fill; the
    // face-walk guard that motivated the 0.3 cap was horizontal B&W pages).
    const vertical = boxH > boxW * renderTuning.verticalThreshold;
    const growX = vertical ? 1.0 : 0.3;
    // widen: a bubble on dark art/black can never pass the profile's outline
    // evidence (the stroke and the black beyond are both ink — the walk reads a
    // 16px-plus line and rejects it), so its bubble shape is unreachable and
    // this rect is the whole fallback. The 1.0 sideways leash alone then stops
    // the fill ~35px out for a 35px column, trust-but-verify sees white beyond
    // the leash, and the 1.5x cap leaves the text a 43px strip in a ~150px
    // bubble (live: badge 12, font 13). The widen path reaches the real border
    // through the same sideways-only grow + long-axis-stable guard the profile
    // path uses.
    const fill = interiorFill(img, box, growX, 0.3, true, mask);
    // Supported sideways bounds first (see trimFillX): the trust tests below
    // must judge the bubble's edge, not art the leaked field ran into.
    const trim = trimFillX(img, box, fill, mask);
    let { minX, minY, maxX, maxY } = fill;
    minX = trim.minX; maxX = trim.maxX;
    const [r0, g0, b0] = fill.seed;
    const fillL = minX, fillR = maxX, fillT = minY, fillB = maxY; // pre-clamp bounds

    // Border-cross clamp: the fill above may have slipped through a
    // thin/anti-aliased bubble border into a neighbor bubble's white
    // (tolerance 60) — pull the overshoot back to the real border.
    // (Live: vertical column fill leaked 150px left, font 38px sprawled
    // over the neighbor bubble.)
    ({ minX, maxX, minY, maxY } = clampToBorders(data, W, H, [r0, g0, b0], box, { minX, minY, maxX, maxY }));

    // Trust-but-verify span: a fill edge that stopped AT a spanning border is
    // trustworthy (genuinely wide bubble — keep it); an edge that stopped at
    // the grow bounds or at spotty ink (neighbor text, partial border the
    // fill walked around) is not. Check the column/row just OUTSIDE the edge
    // (the edge itself is fill-white by construction — the border, if any,
    // is one step beyond it). Untrusted span → cap at 1.5x the box,
    // centered on it: slight overflow is fine (CTD boxes aren't exact) but
    // billboard blowups are not. (Live: region 3 fill [83,331] for a 98px
    // box — partial-height neighbor border, leak went around its ends —
    // capped to 147 wide, font 34 → ~19.)
    const edgeColFrac = (x: number) => {
        let d = 0, n = 0;
        for (let y = Math.max(0, minY); y <= Math.min(H - 1, maxY); y++) {
            n++;
            if (isBorderInk(data, (y * W + x) * 4, r0, g0, b0)) d++;
        }
        return n ? d / n : 0;
    };
    const edgeRowFrac = (y: number) => {
        let d = 0, n = 0;
        for (let x = Math.max(0, minX); x <= Math.min(W - 1, maxX); x++) {
            n++;
            if (isBorderInk(data, (y * W + x) * 4, r0, g0, b0)) d++;
        }
        return n ? d / n : 0;
    };
    // A side the border-cross clamp moved sat on a spanning border — that IS
    // the border ink the frac test below looks for, and re-measuring a
    // hair outside the clamped bound only re-introduces threshold noise (the
    // clamp's and the test's row ranges differ by the clamp itself: a
    // black-page bubble missed 0.70 by a hair and got capped to 1.5x).
    // TRUST_MIN 0.4, not 0.7: a bubble edge is curved, so the column just
    // outside the fill's extreme bound cuts the stroke over only part of the
    // fill's span — live: badge 12's oval gave 0.44/0.72/0.47/0.69 and the
    // 0.7 bar capped a correct 184px-wide fill down to a 52px strip. A leak
    // (window edge, white margin, spotty ink) measures ~0.0-0.2, so the leak
    // protection is untouched.
    const TRUST_MIN = 0.4;
    const trustL = minX !== fillL, trustR = maxX !== fillR;
    const trustT = minY !== fillT, trustB = maxY !== fillB;
    if ((!trustL && (minX <= 0 ? 0 : edgeColFrac(minX - 1)) < TRUST_MIN) || (!trustR && (maxX >= W - 1 ? 0 : edgeColFrac(maxX + 1)) < TRUST_MIN)) {
        const w = Math.min(maxX - minX, (box.x2 - box.x1) * 1.5);
        const cxb = (box.x1 + box.x2) / 2;
        minX = Math.round(cxb - w / 2); maxX = Math.round(cxb + w / 2);
    }
    if ((!trustT && (minY <= 0 ? 0 : edgeRowFrac(minY - 1)) < TRUST_MIN) || (!trustB && (maxY >= H - 1 ? 0 : edgeRowFrac(maxY + 1)) < TRUST_MIN)) {
        const h = Math.min(maxY - minY, (box.y2 - box.y1) * 1.5);
        const cyb = (box.y1 + box.y2) / 2;
        minY = Math.round(cyb - h / 2); maxY = Math.round(cyb + h / 2);
    }
    // Dark interiors (black speech balloons with white text, sitting on black
    // hair/garments): the fill merges with the artwork around the balloon and
    // the border test reads art edges as trusted, so the measured span is not
    // the balloon (live: a 217px box on a black balloon grew to a 274px area
    // and the white text spilled onto the page). The bubble's own outline is
    // not measurable down there — the detection box is the source text's
    // footprint, inside the balloon by construction — so cap at box + 20%
    // instead of the 1.5x trust cap.
    if (0.299 * r0 + 0.587 * g0 + 0.114 * b0 < 110) {
        const w = Math.min(maxX - minX, boxW * 1.2), h = Math.min(maxY - minY, boxH * 1.2);
        const cxb = (box.x1 + box.x2) / 2, cyb = (box.y1 + box.y2) / 2;
        minX = Math.round(cxb - w / 2); maxX = Math.round(cxb + w / 2);
        minY = Math.round(cyb - h / 2); maxY = Math.round(cyb + h / 2);
    }

    const area = (maxX - minX) * (maxY - minY);
    if (area < boxW * boxH * 0.25) {
        // degenerate fill (text/lines block the seed): padded box
        const px = boxW * 0.08, py = boxH * 0.08;
        return {
            x: box.x1 - px, y: box.y1 - py,
            w: boxW + 2 * px, h: boxH + 2 * py,
            leakL: trim.leakL, leakR: trim.leakR,
        };
    }
    // 8% inner margin so text doesn't touch bubble edges. Floored at the
    // detection box: a fill trapped in a pocket between glyph strokes comes
    // out narrower/shorter than the box it must hold (live: 85x57 area in a
    // 112x74 box → f:13 overflow clip; 55x38 in 65x45) — the box is text by
    // construction, so the placement area never goes below it.
    const mx = (maxX - minX) * 0.08, my = (maxY - minY) * 0.08;
    const fx1 = Math.min(minX + mx, box.x1), fy1 = Math.min(minY + my, box.y1);
    const fx2 = Math.max(maxX - mx, box.x2), fy2 = Math.max(maxY - my, box.y2);
    return { x: fx1, y: fy1, w: fx2 - fx1, h: fy2 - fy1, leakL: trim.leakL, leakR: trim.leakR };
}

// ── Placement profile (enclosed bubbles) ─────────────────────────────────
// A bubble is not a rectangle: its usable width changes row by row. The
// profile measures, for every position along the stacking axis (rows for
// horizontal text, columns for vertical), the run of interior pixels that
// contains the detection box. Layout fits each text line to its own band, so
// text follows the bubble shape instead of poking out of a rectangle's
// corners (a round bubble's inscribed rect wastes ~half the interior).
export interface RunProfile {
    vertical: boolean;
    p0: number; p1: number; // stacking-axis range (page coords, inclusive)
    i1: Int32Array; i2: Int32Array; // run-axis interval per stacking position; i1 > i2 = no run
    enclosed: number; // fraction of run rows with boundary evidence on both sides
    // first/last row with outline evidence on BOTH sides — the placement area
    // is built from this range only: a row the fill reached without a border
    // (leak through a panel bleed, a bubble tail slipping into same-colored
    // art) still has a run so bands keep their shape, but it must not stretch
    // the area away from where the source text actually sits (live: a caption
    // box's area doubled its height into the page margin and the text drifted).
    e0: number; e1: number;
    // Rows whose run end was clamped by the continuity rule (see RUN_JUMP):
    // the fill had escaped the bubble and was following art. Dump-only.
    leakL: number; leakR: number;
}

// How much of the run rows must show a bubble outline right outside the run
// for the profile to be trusted. Live calibration (2 pages, [mt] probe dump):
// real bubbles landed 0.5-0.92, while text over artwork (a face close-up, a
// hair region, a memo leaking into the drawing) landed below 0.5 or lost the
// profile entirely once the outline walk required a thin dark line. Below the
// bar the tuned no-frame rectangle (bubbleArea) takes over.
export const ENCLOSED_MIN = 0.5;

// A run narrower than this is an artifact sliver (leak edge, taper tip, the
// row past the last glyph), not a text line: it must not extend the placement
// area's stacking range, and trimming it keeps a band that merely touches such
// a row from reading zero.
const RUN_MIN = 16;

// A run end must move continuously along the stacking axis: a bubble boundary
// is a curve, so an end that jumps sideways by more than RUN_JUMP from the last
// supported position is not that boundary — the fill escaped through a gap in
// the outline and is now following art far away. The end sticks at the last
// supported position and the row counts as leaked: it produces no outline
// evidence, and the run cannot widen the band or the area. Live: a bubble whose
// outline is open below a screen-tone patch, the fill ran 130px left along the
// page white, the hatch edge and a tree trunk passed the thin-line test,
// enclosure 0.53 admitted the profile and the Thai text was typeset over the
// hatch and the neighbouring region.
export const RUN_JUMP = 36;
// Pure (unit tested): the clamped end + whether this row jumped outward.
// dir 1 = min side (left end for horizontal text), -1 = max side (right end).
export function clampRunEnd(prev: number | null, raw: number, dir: 1 | -1): { value: number; leaked: boolean } {
    if (prev != null && dir * (prev - raw) > RUN_JUMP) return { value: prev, leaked: true };
    return { value: raw, leaked: false };
}

// Measure the profile inside the fill's (clamped) extents. A pixel is passable
// if it is interior-colored, or inside the detection box (the original glyphs
// live there and will be painted over). Margin is baked in per run (8%, like
// the rectangle path) and floored at the detection box, so a line is never
// asked to hold less than the source text.
export function widthProfile(
    img: ImageData, box: DetBox, vertical: boolean,
    seed: [number, number, number],
    range: { x1: number; y1: number; x2: number; y2: number },
    win: { loX: number; loY: number; hiX: number; hiY: number },
    mask?: TextMask,
): RunProfile | null {
    const { width: W, height: H, data } = img;
    const cx = Math.floor((box.x1 + box.x2) / 2);
    const cy = Math.floor((box.y1 + box.y2) / 2);
    const p0 = Math.round(vertical ? range.x1 : range.y1);
    const p1 = Math.round(vertical ? range.x2 : range.y2);
    const len = p1 - p0 + 1;
    if (len <= 0) return null;
    const lim = vertical ? H : W; // run-axis page size
    const winLo = vertical ? win.loY : win.loX;
    const winHi = vertical ? win.hiY : win.hiX;
    const boxLo = vertical ? box.y1 : box.x1, boxHi = vertical ? box.y2 : box.x2;
    const boxP0 = vertical ? box.x1 : box.y1, boxP1 = vertical ? box.x2 : box.y2;
    const center = vertical ? cy : cx;

    const i1 = new Int32Array(len).fill(1), i2 = new Int32Array(len).fill(0);
    const pixel = (p: number, q: number): number | null => {
        const x = vertical ? p : q, y = vertical ? q : p;
        if (x < 0 || y < 0 || x >= W || y >= H) return null;
        return (y * W + x) * 4;
    };
    const seedAt = (p: number, q: number): boolean => {
        const i = pixel(p, q);
        return i != null && seedLike(data, i, seed);
    };
    const inBox = (p: number, q: number) => q >= boxLo && q <= boxHi && p >= boxP0 && p <= boxP1;
    const mk = maskView(mask, W, H);
    const maskAt = (p: number, q: number): boolean => {
        if (!mk) return false;
        const x = vertical ? p : q, y = vertical ? q : p;
        return mk[y * W + x] > 127;
    };
    const pass = (p: number, q: number) => inBox(p, q) || seedAt(p, q) || maskAt(p, q);
    // Boundary evidence = a THIN DARK LINE just outside the run: a bubble
    // outline. The pixel merely being non-interior is not enough — artwork
    // (hair, shading, screentone) is non-interior too, and text over art must
    // not be treated as an enclosed bubble (live: a face close-up scored 1.0
    // and blew the text over the drawing). The line itself is the evidence:
    // walk while the pixels ARE ink and treat the surface beyond the line as
    // unknown — a bubble outlined on colored art has gray page behind it, and
    // a `seedLike`-only break scored every row 0 on such pages (live: gray-bg
    // bubble fell to the rect path while the same shape on white passed). The
    // 2px lead allowance absorbs the anti-aliased fringe the run stopped at;
    // thick ink (hair) still walks the full 16px and fails.
    const OUTLINE_MAX = 16; // px of non-interior allowed for an outline
    const outline = (p: number, edge: number, dir: -1 | 1, winEdge: number): boolean => {
        const first = edge + dir;
        if (first < 0 || first >= lim) return false; // page edge: no evidence
        if (edge === winEdge) return false; // fill was clipped by its window, not stopped by ink
        let q = first, k = 0, dark = 0;
        while (k < OUTLINE_MAX && q >= 0 && q < lim) {
            const i = pixel(p, q);
            if (i == null) break;
            if (isBorderInk(data, i, seed[0], seed[1], seed[2])) dark++;
            else if (dark > 0 || k >= 2) break; // the line ended — or never started
            q += dir; k++;
        }
        return k > 0 && k < OUTLINE_MAX && dark >= 1;
    };
    let rows = 0, enclosedRows = 0, e0 = -1, e1 = -1;
    let supL: number | null = null, supR: number | null = null, leakL = 0, leakR = 0;
    for (let p = p0; p <= p1; p++) {
        if (!pass(p, center)) continue; // no interior at the box center line
        let a = center, b = center;
        while (a - 1 >= winLo && pass(p, a - 1)) a--;
        while (b + 1 <= winHi && pass(p, b + 1)) b++;
        // Leak guard (see RUN_JUMP): a row that jumped outward is clamped to
        // the last supported end, so its run cannot widen a band and its
        // outline check runs at the supported line instead of the art it
        // found outside.
        const cl = clampRunEnd(supL, a, 1), cr = clampRunEnd(supR, b, -1);
        a = cl.value; b = cr.value;
        if (cl.leaked) leakL++; else supL = a;
        if (cr.leaked) leakR++; else supR = b;
        const m = (b - a) * 0.08;
        let r1 = Math.round(a + m), r2 = Math.round(b - m);
        if (p >= boxP0 && p <= boxP1) { r1 = Math.min(r1, Math.floor(boxLo)); r2 = Math.max(r2, Math.ceil(boxHi)); }
        if (r2 > r1) { i1[p - p0] = r1; i2[p - p0] = r2; rows++; }
        if (outline(p, a, -1, winLo) && outline(p, b, 1, winHi)) {
            enclosedRows++;
            if (e0 < 0) e0 = p;
            e1 = p;
        }
    }
    if (!rows) return null;
    return { vertical, p0, p1, i1, i2, enclosed: enclosedRows / rows, e0, e1, leakL, leakR };
}

// Usable interval for a band of the stacking axis: the intersection of every
// row's run across the band (min-over-band — a single leaked or noisy row
// cannot widen a line). Null = the band is not fully inside the interior.
// Hole rows AT the band's edges are profile artifacts (the fill/evidence ended
// there — a leak tail, the row past the bubble's last glyph), not real gaps:
// they are trimmed before measuring, or a single end row zeroed every band
// touching it and the font collapsed (live: band 2 of a round bubble read 0
// and the size loop skipped from cap 149 down to 47; a spiky bubble's cap 23
// fell to 17). A hole INSIDE the remaining span still nulls the band — a line
// must not cross it.
export function runInterval(prof: RunProfile, p0: number, p1: number): [number, number] | null {
    const a = Math.max(prof.p0, Math.ceil(p0 - 0.5));
    const b = Math.min(prof.p1, Math.floor(p1 - 0.5));
    if (b < a) return null;
    const hole = (p: number) => { const k = p - prof.p0; return prof.i1[k] > prof.i2[k]; };
    const dead = (p: number) => { const k = p - prof.p0; return prof.i1[k] > prof.i2[k] || prof.i2[k] - prof.i1[k] < RUN_MIN; };
    let lo = a, hi = b;
    while (lo <= hi && dead(lo)) lo++;
    while (hi >= lo && dead(hi)) hi--;
    if (lo > hi) return null;
    let x1 = -1, x2 = -1;
    for (let p = lo; p <= hi; p++) {
        if (hole(p)) return null; // a real gap inside the span: text must not cross it
        const k = p - prof.p0;
        if (x1 < 0 || prof.i1[k] > x1) x1 = prof.i1[k];
        if (x2 < 0 || prof.i2[k] < x2) x2 = prof.i2[k];
    }
    return x2 > x1 ? [x1, x2] : null;
}

// Enclosed-bubble path: profile measurement, or the legacy rectangle when the
// evidence says there is no bubble around this box.
function fitArea(img: ImageData, box: DetBox, vertical: boolean, mask?: TextMask): LayoutRect {
    const rect = (why: string, prof?: RunProfile): LayoutRect => ({
        ...bubbleArea(img, box, mask), why,
        // the profile's leak counts survive the fallback: "fell to rect with
        // N clamped rows" is the diagnosis, not just the enclosure score
        ...(prof ? { leakL: prof.leakL, leakR: prof.leakR } : null),
    });
    // Per-axis leash. Stacking axis 0.6/side (≤2.2x): a bubble hugging its text
    // is well inside that, while a leaked fill (barely-enclosed white garment,
    // bubble tail slipping into a same-colored drawing) cannot run away.
    // Run axis 1.2/side (≤3.4x): that is the axis a SHORT source runs along, and
    // the bubble can sit far wider than the box there — a 5-glyph column in a
    // round bubble measured ~1.1x its box to the outline, so a 0.6 window
    // clipped the fill and a window-clipped end is not outline evidence
    // (enclosed read 0 → rect → 1.5x cap → Thai wrapped into a skinny strip).
    // 3.4x still clips the measured leak (a caption fill that ran 3.9x its box
    // into the page margin), whose clipped ends keep the rect fallback.
    const fill = interiorFill(img, box, vertical ? 0.6 : 1.2, vertical ? 1.2 : 0.6, true, mask);
    const [r0, g0, b0] = fill.seed;
    let { minX, minY, maxX, maxY } = fill;
    ({ minX, maxX, minY, maxY } = clampToBorders(img.data, img.width, img.height, [r0, g0, b0], box, { minX, minY, maxX, maxY }));
    const boxW = box.x2 - box.x1, boxH = box.y2 - box.y1;
    if ((maxX - minX) * (maxY - minY) >= boxW * boxH * 0.25) {
        const prof = widthProfile(img, box, vertical, fill.seed, { x1: minX, y1: minY, x2: maxX, y2: maxY }, fill, mask);
        if (!prof) return rect('norows');
        if (prof.enclosed < ENCLOSED_MIN) return rect(`enclose ${prof.enclosed.toFixed(2)}`, prof);
        if (prof.e1 <= prof.e0) return rect('no-evidence-rows', prof);
        {
            const ks = Math.max(0, prof.e0 - prof.p0), ke = Math.min(prof.i1.length - 1, prof.e1 - prof.p0);
            let q1 = -1, q2 = -1;
            // First/last EVIDENCED row that actually holds a usable run (≥16px;
            // isolated 1px slivers in a leak/taper region are not text rows).
            // The outline walk can mark rows the run measurement then rejects
            // (a sliver of interior at the center line with a border nearby),
            // and a band over such rows reads 0 (live: a round bubble's top ~80
            // rows were all slivers — the area included them, every centered
            // window ≥ a certain size failed on them and the font collapsed,
            // cap 149 → 47). Rows inside the box always have runs (the box is
            // passable by construction), so this never trims the source text.
            let r0 = -1, r1 = -1;
            for (let k = ks; k <= ke; k++) {
                if (prof.i1[k] > prof.i2[k] || prof.i2[k] - prof.i1[k] < RUN_MIN) continue;
                if (r0 < 0) r0 = k;
                r1 = k;
                if (q1 < 0 || prof.i1[k] < q1) q1 = prof.i1[k];
                if (q2 < 0 || prof.i2[k] > q2) q2 = prof.i2[k];
            }
            if (r0 < 0) return rect('no-run-rows', prof);
            if (q2 > q1) {
                // Extent on the stacking axis: rows with outline evidence on
                // both sides, UNIONED with the detection box (clamped to the
                // measured profile range). Evidence stops early where the
                // outline runs over thick ink (hair/art: the thin-line walk
                // rejects it — live: badge 5, evidence covered y621-875 while
                // the box ran to 959), and a block centered in the truncated
                // area parks in the bubble's upper half: text 24px above the
                // box top, 88px above its bottom. The box is the source text
                // by construction, so it cannot inflate a leak — and the
                // evidenced rows still bound the widths.
                const s0 = Math.max(prof.p0, Math.min(prof.p0 + r0, vertical ? Math.round(box.x1) : Math.round(box.y1)));
                const s1 = Math.min(prof.p1, Math.max(prof.p0 + r1, vertical ? Math.round(box.x2) : Math.round(box.y2)));
                return vertical
                    ? { x: s0, y: q1, w: s1 - s0 + 1, h: q2 - q1, runs: prof }
                    : { x: q1, y: s0, w: q2 - q1, h: s1 - s0 + 1, runs: prof };
            }
        }
    }
    return rect('fill<25%');
}

// Original typesetting, measured from the ink bands inside the detection box:
// pitch = (last band end − first band start) / band count, glyph = median band
// height. Both feed the font ceiling (see sizeCapFrom). Null = ambiguous (no
// bands, or a noisy/textured box reporting an implausible line count).
export interface SourceType { pitch: number; glyph: number }
export function sourcePitch(img: ImageData, box: DetBox, vertical: boolean): SourceType | null {
    const { width: W, height: H, data } = img;
    const seed = interiorSeed(data, W, H, box);
    const p0 = Math.max(0, Math.floor(vertical ? box.x1 : box.y1));
    const p1 = Math.min((vertical ? W : H) - 1, Math.ceil(vertical ? box.x2 : box.y2));
    const q0 = Math.max(0, Math.floor(vertical ? box.y1 : box.x1));
    const q1 = Math.min((vertical ? H : W) - 1, Math.ceil(vertical ? box.y2 : box.x2));
    const qLen = q1 - q0 + 1;
    if (qLen <= 2 || p1 <= p0) return null;
    const minInk = Math.max(2, Math.round(qLen * 0.02));
    const bands: [number, number][] = [];
    let runFirst = -1, runLast = -1;
    for (let p = p0; p <= p1; p++) {
        let ink = 0;
        for (let q = q0; q <= q1; q++) {
            const x = vertical ? p : q, y = vertical ? q : p;
            if (!seedLike(data, (y * W + x) * 4, seed)) ink++;
        }
        if (ink >= minInk) {
            if (runFirst < 0) { runFirst = p; runLast = p; }
            else if (p - runLast > 1) { bands.push([runFirst, runLast]); runFirst = p; runLast = p; }
            else runLast = p;
        }
    }
    if (runFirst >= 0) bands.push([runFirst, runLast]);
    if (!bands.length || bands.length > 8) return null;
    const heights = bands.map(([a, b]) => b - a + 1).sort((a, b) => a - b);
    return {
        pitch: (bands[bands.length - 1][1] - bands[0][0] + 1) / bands.length,
        glyph: heights[heights.length >> 1], // median band height
    };
}

// Font ceiling from the measured source: reference = the larger of the
// original glyph height and (pitch / our line-height factor). Glyph height is
// what the eye compares — matching the *pitch* alone renders Thai ~25% smaller
// than the source (the 1.8 line factor is mark headroom, live: 6 lines of 26px
// caps came out as 20px Thai in the same box). With a short translation the
// spare height goes to a bigger font; a full box is still shrunk to fit by the
// layout loop. Floored at minFont; null = no measurement.
export function sizeCapFrom(img: ImageData, box: DetBox, vertical: boolean): number | null {
    const src = sourcePitch(img, box, vertical);
    if (!src) return null;
    const ref = Math.max(src.glyph, src.pitch / (1 + HEADROOM + LINE_SPACING));
    return Math.max(renderTuning.minFont, Math.round(ref * renderTuning.textScale));
}

export function boxIsVertical(box: DetBox): boolean {
    return (box.y2 - box.y1) > (box.x2 - box.x1) * renderTuning.verticalThreshold;
}

// Split children: never let the area cross the cut (the fill window is
// clamped already, but the trust cap and ink-bbox paths can re-expand past
// it). Pure — unit tested.
export function clipArea(a: Area, clip?: { x1: number; y1: number; x2: number; y2: number }): Area {
    if (!clip) return a;
    const x1 = Math.max(a.x, clip.x1), y1 = Math.max(a.y, clip.y1);
    const x2 = Math.min(a.x + a.w, clip.x2), y2 = Math.min(a.y + a.h, clip.y2);
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

// Layout area the renderer actually uses: enclosed bubbles get the measured
// per-line profile; a big box with almost no ink (small SFX in empty space,
// texture false-positive) lays out on the ink bbox instead — otherwise the
// font scales to the box and billboards over its neighbors. (Live: "อ๊ะ♡" in
// a 222×268 box rendered at 124px.) Null = zero ink, nothing to place on.
export function layoutArea(img: ImageData, box: DetBox, vertical: boolean = boxIsVertical(box), mask?: TextMask): LayoutRect | null {
    const ink = inkStats(img, box);
    if (ink.x2 <= ink.x1 || ink.y2 <= ink.y1) return null;
    if (ink.frac < 0.03) {
        const pad = 6;
        return {
            ...clipArea({
                x: Math.max(0, ink.x1 - pad), y: Math.max(0, ink.y1 - pad),
                w: ink.x2 - ink.x1 + 2 * pad, h: ink.y2 - ink.y1 + 2 * pad,
            }, box.clip),
            why: 'ink-bbox',
        };
    }
    const found = fitArea(img, box, vertical, mask);
    return { ...found, ...clipArea(found, box.clip) };
}

// Pick text color by contrast against the placement area background. Modal
// tone, not mean: leaked rows (or interior art) drag a mean across the
// contrast boundary and print white-on-white, while the largest bucket is the
// surface the text mostly sits on.
function textColorFor(img: ImageData, area: { x: number; y: number; w: number; h: number }): string {
    const { width: W, data } = img;
    const stepX = Math.max(1, Math.floor(area.w / 24));
    const stepY = Math.max(1, Math.floor(area.h / 24));
    const buckets = new Map<number, { n: number; lum: number }>();
    let best: { n: number; lum: number } | null = null;
    for (let y = Math.floor(area.y); y < area.y + area.h; y += stepY) {
        for (let x = Math.floor(area.x); x < area.x + area.w; x += stepX) {
            const i = (y * W + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
            let bkt = buckets.get(key);
            if (!bkt) { bkt = { n: 0, lum: 0 }; buckets.set(key, bkt); }
            bkt.n++;
            bkt.lum += 0.299 * r + 0.587 * g + 0.114 * b;
            if (!best || bkt.n > best.n) best = bkt;
        }
    }
    return best && best.lum / best.n > 128 ? '#111' : '#fff';
}

// Luminance test for '#rrggbb' or '#rgb' (exported pure for tests).
export function isLight(hex: string): boolean {
    const h = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
    const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 128;
}

// Resolved paint colors: user-fixed colors win, 'auto' keeps the old
// behavior (contrast text, stroke opposite the resolved text).
function resolveColors(img: ImageData, area: { x: number; y: number; w: number; h: number }): { color: string; stroke: string } {
    const color = renderTuning.textColor === 'auto' ? textColorFor(img, area) : renderTuning.textColor;
    const stroke = renderTuning.strokeColor === 'auto'
        ? (isLight(color) ? '#111' : '#fff')
        : renderTuning.strokeColor;
    return { color, stroke };
}

export function renderRegion(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    img: ImageData,
    box: DetBox,
    text: string,
    mask?: TextMask,
): Placed | null {
    if (!text.trim()) return null;
    if (chosenOrientation(ctx, img, box, text, mask)) return renderVertical(ctx, img, box, text, mask);
    return renderHorizontal(ctx, img, box, text, mask);
}

// Which way this region will actually be laid out. Tall+narrow Japanese
// columns render rotated so Thai reads down the column; preferHorizontal crams
// horizontal first and rotates only on overflow (short text fits — the common
// case). Exported so the result dump and the debug overlay report the area the
// text really got: deriving it from the box aspect alone drew the vertical
// area under text that was laid out horizontally (live: a debug view showed a
// narrow area while the paint used a different one).
export function chosenOrientation(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    img: ImageData, box: DetBox, text: string, mask?: TextMask,
): boolean {
    if (!boxIsVertical(box)) return false;
    if (renderTuning.preferHorizontal) {
        const probe = pageArea(ctx, img, box, true, mask);
        // …but only while the bubble is not much wider than the text block: a
        // thin column inside a wide oval is a vertical source line (the JP
        // glyphs run down it), and laying the Thai horizontally across the
        // bubble reads wrong and sticks out of its own box (live: thin columns
        // 21-47px wide inside ~75-100px bubbles — 3/4 on the user's page).
        // Region 2-style blocks (wide caption/paragraph in a same-sized
        // bubble, ratio ~1.1) keep the horizontal preference.
        if (probe && probe.w <= (box.x2 - box.x1) * 1.5 && horizontalFits(ctx, text, probe)) return false;
    }
    return true;
}

export interface Placed { fontSize: number; lines: string[]; overflow?: boolean; color?: string; block?: [number, number] }

interface Area { x: number; y: number; w: number; h: number }

// Placement rect, optionally carrying the measured per-line profile (see
// widthProfile) for enclosed bubbles.
export interface LayoutRect extends Area { runs?: RunProfile; why?: string; leakL?: number; leakR?: number }

// Shared placement-area resolution (layoutArea + canvas clamp + 20px floor).
// Both orientations and the horizontal-fit probe use it, so the probe can
// never disagree with the real render about the area. Exported for the debug
// overlay (renderDebugView draws the rect and profile the layout actually got).
export function pageArea(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    img: ImageData,
    box: DetBox,
    vertical: boolean,
    mask?: TextMask,
): LayoutRect | null {
    // clamp to canvas bounds (boxes at page edges can otherwise hang over)
    const CW = ctx.canvas.width, CH = ctx.canvas.height;
    const found = layoutArea(img, box, vertical, mask);
    if (!found) return null;
    const area: LayoutRect = {
        x: Math.max(0, found.x), y: Math.max(0, found.y),
        w: Math.min(found.w, CW - Math.max(0, found.x)), h: Math.min(found.h, CH - Math.max(0, found.y)),
        runs: found.runs,
    };
    return area.w < 20 || area.h < 20 ? null : area;
}

// Horizontal font cap: one line needs ≈ 1.8x font size (glyph + headroom);
// never wider than w/2.
function hCap(area: Area): number {
    return Math.max(renderTuning.minFont, Math.min(MAX_FONT, Math.floor(area.h / 1.8), Math.floor(area.w / 2)));
}

// Profile-aware layout: every line is measured against the run at its own band,
// so text follows the bubble shape (short at the top of a round bubble, long in
// the middle) instead of an inscribed rectangle. Two passes: wrap top-down to
// learn the line count, recenter the block, re-wrap with the shifted bands —
// the profile is smooth, so one recenter is enough. `top` is the block start
// on the stacking axis (x for vertical, where columns stack right-to-left, so
// it is the block's RIGHT edge); `centers` is the run-axis center per line.
export interface LaidOutFit {
    lines: string[];
    fontSize: number;
    lineHeight: number;
    top: number;
    centers: number[];
}

export function layoutTextFit(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    text: string,
    area: LayoutRect,
    cap: number,
    maxStack?: number,
): LaidOutFit | null {
    const prof = area.runs!;
    const segments = text.split(' / ').map(s => s.trim()).filter(Boolean);
    if (!segments.length) return null;
    const stack0 = prof.vertical ? area.x : area.y;
    const stackLen = prof.vertical ? area.w : area.h;
    // the block may exceed the source's text box by a hair (glyph-matched text
    // is taller: our 1.8 line pitch vs the source's ~1.3), not by the whole
    // measured area — a leaked area must not blow the font up. textScale above
    // 1 is an explicit ask for more room.
    const stackFit = Math.min(stackLen, maxStack ?? stackLen);
    const midCross = prof.vertical ? area.y + area.h / 2 : area.x + area.w / 2;
    // line j's band along the stacking axis, walking away from `anchor`:
    // horizontal blocks start at the area top; vertical blocks stack to the
    // LEFT (JA reading order) so their anchor is the block's RIGHT edge.
    const widthFor = (anchor: number, lh: number) => (j: number) => {
        const b0 = prof.vertical ? anchor - (j + 1) * lh : anchor + j * lh;
        const iv = runInterval(prof, b0, b0 + lh);
        if (iv) return iv[1] - iv[0];
        // band past the measured range: reuse the nearest measured interval so
        // a long text still lays out (clipped) instead of vanishing — the
        // block-height check below still decides the font size. A band with a
        // hole INSIDE the range stays a zero width (text must not cross it).
        const cp = (p: number) => Math.min(prof.p1, Math.max(prof.p0, p));
        const near = cp(b0) === b0 && cp(b0 + lh - 1) === b0 + lh - 1 ? null : runInterval(prof, cp(b0), cp(b0 + lh - 1));
        return near ? near[1] - near[0] : 0;
    };

    let fallback: LaidOutFit | null = null;
    for (let size = cap; size >= renderTuning.minFont; size -= 2) {
        setFont(ctx, size);
        const lh = size * (1 + HEADROOM + LINE_SPACING);
        const anchorA = prof.vertical ? stack0 + stackLen : stack0;
        const edge = wrapUnitsIntoLines(ctx, segments, widthFor(anchorA, lh));
        // Centered block by free-boundary search: the anchor depends on the
        // block span, and the span is only known after wrapping. Walk candidate
        // spans (windows that fit the height budget) ascending; the first
        // self-consistent wrap — the block produced has exactly the span it was
        // anchored for — is the centered solution. A failed candidate only
        // means that window's bands were too narrow; the old two-pass code
        // treated that as "no centered fit at this size" and collapsed (live: a
        // round bubble's cap 149 fell to 47 because every size ≥49 failed at
        // the top edge band or at a tail band past the evidence rows; a spiky
        // bubble's cap 23 fell to 17). A wrap that comes out shorter than its
        // window is kept only when nothing is self-consistent. The edge band is
        // where a round bubble is narrowest, so a unit too wide for it can
        // still fit the middle.
        let b: { lines: string[]; failed: boolean } | null = null;
        {
            const maxLines = Math.max(1, Math.floor((stackFit + 0.5) / lh));
            let inexact: { lines: string[]; failed: boolean } | null = null;
            for (let n = 1; n <= maxLines; n++) {
                const anchor = prof.vertical ? stack0 + (stackLen + n * lh) / 2 : stack0 + (stackLen - n * lh) / 2;
                const w = wrapUnitsIntoLines(ctx, segments, widthFor(anchor, lh));
                if (w.failed) continue;
                if (w.lines.length === n) { b = w; break; }        // self-consistent: the best centered fit
                if (w.lines.length < n) { inexact ??= w; }         // fits a wider window than it needs
            }
            b ??= inexact;
        }
        if (!b) { if (edge.failed) continue; }
        // The centered anchor comes from the block actually placed. A centered
        // re-wrap can need FEWER lines than the edge pass (a round bubble's
        // narrow top band wraps what the wide middle band fits on one line).
        const bFits = !!b && b.lines.length * lh <= stackFit + 0.5;
        const lines = bFits ? b!.lines : (edge.lines.length ? edge.lines : (b?.lines ?? []));
        if (!lines.length) continue;
        const span = lines.length * lh;
        // Anchor: keep the wrap and the placement consistent. A centered block
        // takes the centered anchor; an edge-wrapped block (the centered wrap
        // could not match its bands) stays at the edge — placing it centered
        // would move its lines onto narrower bands than the ones they were
        // wrapped for. Edge anchor = the legacy overflow policy.
        const useCentered = bFits || edge.failed;
        const top = useCentered
            ? (prof.vertical ? stack0 + (stackLen + span) / 2 : stack0 + (stackLen - span) / 2)
            : anchorA;
        const use = { lines, top };
        const centers = use.lines.map((_, j) => {
            const b0 = prof.vertical ? use.top - (j + 1) * lh : use.top + j * lh;
            const iv = runInterval(prof, b0, b0 + lh);
            return iv ? (iv[0] + iv[1]) / 2 : midCross;
        });
        const out: LaidOutFit = { lines: use.lines, fontSize: size, lineHeight: lh, top: use.top, centers };
        // A fitting CENTERED block wins outright. An edge-anchored block is
        // kept as the fallback (largest size first) so a smaller size can still
        // deliver a centered fit (live: badge 1, "1 สัปดาห์ต่อมา" fit the top
        // band at f19 but the centered band only at f17 — returning the f19
        // edge solution parked the caption 39px above its box).
        if (bFits) return out;
        fallback ??= out;
    }
    if (fallback) return fallback;
    // Nothing wrapped at any size — every band is narrower than the text (a
    // panel caption with the per-run 8% insets, or holes under each band).
    // Last-resort rect layout, same policy as the no-profile rect path: CENTER
    // a block that fits the area, keep the legacy edge anchor (top/right, then
    // clipped) only for a genuine overflow. The old unconditional edge anchor
    // parked a fitting caption at the area's top edge — 39px above its own box
    // and over the panel's top border (live: badge 1, "1 สัปดาห์ต่อมา").
    const laid = layoutText(ctx, text, area.w, area.h, cap);
    if (!laid.lines.length) return null;
    const total = laid.lines.length * laid.lineHeight;
    const fits = total <= stackLen + 0.5;
    return {
        lines: laid.lines, fontSize: laid.fontSize, lineHeight: laid.lineHeight,
        top: prof.vertical
            ? (fits ? stack0 + (stackLen + total) / 2 : stack0 + stackLen)
            : (fits ? stack0 + (stackLen - total) / 2 : stack0),
        centers: laid.lines.map(() => midCross),
    };
}

// Would this text fit horizontally in the area? Probe for preferHorizontal:
// measure-only (no paint), same cap and layout the real render uses. A
// degenerate single-line overflow (one unwrappable unit wider than the area at
// min font — layoutText's last-resort fallback) is NOT a fit: it would paint
// one clipped line instead of rotating (live: 38px vertical strip probed
// true, rendered 4 glyphs in an empty-looking box).
export function horizontalFits(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    text: string,
    area: LayoutRect,
): boolean {
    if (area.runs) {
        const laid = layoutTextFit(ctx, text, area, hCap(area));
        return !!laid && laid.lines.length * laid.lineHeight <= area.h + 0.5;
    }
    const laid = layoutText(ctx, text, area.w, area.h, hCap(area));
    if (!laid.lines.length || laid.lines.length * laid.lineHeight > area.h + 0.5) return false;
    setFont(ctx, laid.fontSize);
    const slack = 0.5 + laid.fontSize * renderTuning.letterSpacing; // trailing-track overstatement
    return laid.lines.every(l => ctx.measureText(l).width <= area.w + slack);
}

function renderHorizontal(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    img: ImageData,
    box: DetBox,
    text: string,
    mask?: TextMask,
): Placed | null {
    if (!text.trim()) return null;
    const area = pageArea(ctx, img, box, false, mask);
    if (!area) return null;
    const { color, stroke } = resolveColors(img, area);
    const cap = Math.min(hCap(area), sizeCapFrom(img, box, false) ?? MAX_FONT);

    // Enclosed bubble: every line is fitted to its own measured band (widths
    // vary with the bubble shape), centered on its own run.
    if (area.runs) {
        const laid = layoutTextFit(ctx, text, area, cap, Math.round((box.y2 - box.y1) * Math.max(1.15, renderTuning.textScale)));
        if (!laid || !laid.lines.length) return null;
        const overflow = laid.top + laid.lines.length * laid.lineHeight > area.y + area.h + 0.5 || laid.top < area.y - 0.5;
        ctx.save();
        ctx.beginPath();
        ctx.rect(area.x, area.y, area.w, area.h);
        ctx.clip();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        laid.lines.forEach((line, j) => {
            const cx = laid.centers[j] + halfTrack() * laid.fontSize; // trailing-spacing compensation
            const y = laid.top + j * laid.lineHeight + laid.lineHeight / 2;
            if (renderTuning.textStroke > 0) {
                ctx.strokeStyle = stroke;
                ctx.lineWidth = Math.max(1, laid.fontSize * renderTuning.textStroke);
                ctx.lineJoin = 'round';
                ctx.strokeText(line, cx, y);
            }
            ctx.fillText(line, cx, y);
        });
        ctx.restore();
        const b0 = laid.top, b1 = laid.top + laid.lines.length * laid.lineHeight;
        return { fontSize: laid.fontSize, lines: laid.lines, overflow: overflow || undefined, color, block: [b0, b1] };
    }

    const laid = layoutText(ctx, text, area.w, area.h, cap);
    if (!laid.lines.length) return null;

    setFont(ctx, laid.fontSize);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;

    // Overflow policy: text NEVER leaves the region (clipped). If it can't fit,
    // top-align so the start of the text stays readable inside the clip.
    const totalH = laid.lines.length * laid.lineHeight;
    const overflow = totalH > area.h + 0.5;
    let y = overflow
        ? area.y + laid.lineHeight / 2
        : area.y + (area.h - totalH) / 2 + laid.lineHeight / 2;

    const y0 = y; // first line's center — the block runs [y0 - lh/2, y0 - lh/2 + totalH]
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
    const cx = area.x + area.w / 2 + halfTrack() * laid.fontSize; // trailing-spacing compensation
    for (const line of laid.lines) {
        if (renderTuning.textStroke > 0) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = Math.max(1, laid.fontSize * renderTuning.textStroke);
            ctx.lineJoin = 'round';
            ctx.strokeText(line, cx, y);
        }
        ctx.fillText(line, cx, y);
        y += laid.lineHeight;
    }
    ctx.restore();
    return { fontSize: laid.fontSize, lines: laid.lines, overflow: overflow || undefined, color, block: [y0 - laid.lineHeight / 2, y0 - laid.lineHeight / 2 + totalH] };
}

// Left edge of the first (rightmost) column in a vertical stack. Columns
// extend LEFTWARD from here — overflow right-aligns inside the area, but a
// fitting block must CENTER: block-left + (totalW - colW). (Centering the
// block-left itself shifted every column left and clipped the last one —
// live: a fitting 2-column region lost its 2nd column entirely.)
export function firstColX(ax: number, aw: number, totalW: number, colW: number, overflow: boolean): number {
    return overflow ? ax + aw - colW : ax + (aw + totalW) / 2 - colW;
}
// Tall narrow region (vertical JA column): lay out into a rotated canvas,
// then draw it back rotated 90° — lines run top-to-bottom, reading right-to-left
// (column order) like the original.
function renderVertical(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    img: ImageData,
    box: DetBox,
    text: string,
    mask?: TextMask,
): Placed | null {
    const area = pageArea(ctx, img, box, true, mask);
    if (!area) return null;
    const { color, stroke } = resolveColors(img, area);
    const cap = Math.min(
        Math.max(renderTuning.minFont, Math.min(MAX_FONT, Math.floor(area.w / 1.8), Math.floor(area.h / 2.4))),
        sizeCapFrom(img, box, true) ?? MAX_FONT,
    );

    // Enclosed bubble: each column is fitted to its own measured run (the
    // transposed profile), so columns follow the bubble height.
    const fit = area.runs ? layoutTextFit(ctx, text, area, cap, Math.round((box.x2 - box.x1) * Math.max(1.15, renderTuning.textScale))) : null;
    let laid: LaidOut | null = null;
    if (area.runs) {
        if (!fit || !fit.lines.length) return null;
    } else {
        // rotated layout: line length ≤ area height, columns stack within area width.
        // Shrink the font cap until the wrapped column count fits the width —
        // this was the pre-layoutVertical behavior that rendered cleanly, plus an
        // explicit fit loop instead of a horizontal fallback (narrow region = unreadable).
        for (let capGuess = cap; capGuess >= renderTuning.minFont; capGuess -= 4) {
            const cand = layoutText(ctx, text, area.h, area.w, capGuess); // swapped: length ≤ h, stack ≤ w
            const totalW = cand.lines.length * cand.lineHeight;
            if (totalW <= area.w) {
                laid = cand;
                break;
            }
            // keep the narrowest anyway — an overflowing strip shows the most
            // columns small, not one giant clipped column
            if (!laid || totalW < laid.lines.length * laid.lineHeight) laid = cand;
        }
        if (!laid || !laid.lines.length) return null;
    }

    const lines = fit ? fit.lines : laid!.lines;
    const fontSize = fit ? fit.fontSize : laid!.fontSize;
    const lineHeight = fit ? fit.lineHeight : laid!.lineHeight;
    const colW = lineHeight; // each "line" becomes a vertical column
    const totalW = lines.length * colW;

    // Overflow policy: clip to the region; on overflow keep columns from the
    // RIGHT (JA reading order) — the tail is clipped, the start stays readable.
    const overflow = totalW > area.w + 0.5;
    // first column's left edge: the profile fit's block right edge minus one
    // column; legacy centers/right-aligns as before.
    let colX = fit ? fit.top - colW : firstColX(area.x, area.w, totalW, colW, overflow);

    // Each line is pre-rotated inside its own canvas (text runs down, glyph
    // tops point left — standard for horizontal script in a vertical column).
    // Paste them directly: no composite rotation needed, so nothing can skew.
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
    for (let j = 0; j < lines.length; j++) {
        if (colX < area.x - colW) break; // past the left clip edge — done
        // profile fit: the column's own run along y (height + vertical center)
        let y0 = area.y, h = area.h;
        if (fit) {
            const iv = runInterval(area.runs!, fit.top - (j + 1) * lineHeight, fit.top - j * lineHeight);
            if (iv) { y0 = iv[0]; h = iv[1] - iv[0]; }
        }
        const lineCanvas = new OffscreenCanvas(Math.ceil(colW), Math.ceil(h));
        const lctx = lineCanvas.getContext('2d')!;
        setFont(lctx, fontSize);
        lctx.textAlign = 'center';
        lctx.textBaseline = 'middle';
        lctx.fillStyle = color;
        if (renderTuning.textStroke > 0) {
            lctx.strokeStyle = stroke;
            lctx.lineWidth = Math.max(1, fontSize * renderTuning.textStroke);
            lctx.lineJoin = 'round';
        }
        lctx.translate(colW / 2, h / 2 + halfTrack() * fontSize); // trailing-spacing compensation along the text run
        lctx.rotate(Math.PI / 2); // text run along +y (downward), length ≤ the column's run
        if (renderTuning.textStroke > 0) lctx.strokeText(lines[j], 0, 0);
        lctx.fillText(lines[j], 0, 0);
        ctx.drawImage(lineCanvas, Math.round(colX), Math.round(y0));
        colX -= colW;
    }
    ctx.restore();
    const b0 = fit ? fit.top - lines.length * lineHeight : colX + lineHeight;
    return { fontSize, lines, overflow: overflow || undefined, color, block: [b0, fit ? fit.top : colX + lineHeight + lines.length * lineHeight] };
}
