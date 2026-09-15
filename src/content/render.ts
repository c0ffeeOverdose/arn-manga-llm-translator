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
export const RENDER_GEN = 15;

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

// Bounded flood fill of the bubble interior from the detection box center.
// Seed = the box's most common color (a center landing on a glyph would flood
// the glyph only), with the center pixel as an alternate — whichever floods
// more pixels wins. Bounded to box ± grow (growX sideways) so a white page
// cannot be claimed as layout area.
function interiorFill(img: ImageData, box: DetBox, growX: number, grow: number, widen = false): InteriorFill {
    const { width: W, height: H, data } = img;
    const cx = Math.floor((box.x1 + box.x2) / 2);
    const cy = Math.floor((box.y1 + box.y2) / 2);
    const si = (cy * W + cx) * 4;
    const center: [number, number, number] = [data[si], data[si + 1], data[si + 2]];
    const modal = interiorSeed(data, W, H, box);

    const boxW = box.x2 - box.x1, boxH = box.y2 - box.y1;
    const window4 = (gx: number, gy: number) => ({
        loX: Math.max(0, Math.floor(box.x1 - boxW * gx)),
        loY: Math.max(0, Math.floor(box.y1 - boxH * gy)),
        hiX: Math.min(W - 1, Math.ceil(box.x2 + boxW * gx)),
        hiY: Math.min(H - 1, Math.ceil(box.y2 + boxH * gy)),
    });

    // Start pixel for a seed = the sampled pixel nearest the box center that
    // matches it. Flooding from the center itself is wrong when the center sits
    // on a thick glyph: the flood may only cross seed-like pixels, so with a
    // white seed it never leaves the glyph, and the ink blob wins the "largest
    // flood" vote instead (live: a Japanese column box's placement area
    // collapsed to the glyphs' width, font 34 → 13).
    const grid: number[] = [];
    const probes: number[] = []; // extra sample points, kept out of the nearest-to-center vote
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
            if (x >= 0 && y >= 0 && x < W && y < H) probes.push(y * W + x);
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
    type Win = ReturnType<typeof window4>;
    const fillFrom = (seed: [number, number, number], win: Win) => {
        visited.fill(0);
        const start = startFor(seed);
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
                if (seedLike(data, np * 4, seed)) {
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
    const seeds: [number, number, number][] = [modal, center];
    for (const p of probes) seeds.push([data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]);
    const bestFor = (win: Win) => {
        let best = fillFrom(seeds[0], win);
        const seen = new Set<number>([key(seeds[0])]);
        for (const seed of seeds.slice(1)) {
            if (seen.has(key(seed))) continue;
            seen.add(key(seed));
            const alt = fillFrom(seed, win);
            if (alt.count > best.count) best = alt;
        }
        return { fill: best, win };
    };
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
        const wide = bestFor(boxH > boxW ? window4(4, grow) : window4(growX, 4));
        const g = wide.fill;
        const longStable = boxH > boxW
            ? (g.maxY - g.minY) <= (f.maxY - f.minY) + 2
            : (g.maxX - g.minX) <= (f.maxX - f.minX) + 2;
        if (g.count > f.count && longStable) pick = wide;
    }
    return { ...pick.fill, ...pick.win };
}

// Rectangle placement area — the NO-FRAME path: narration and SFX over art,
// open backgrounds. Flood-fill the box interior, hard-limited to box+30% (1.0×
// sideways for vertical column boxes) and verified against real spanning
// borders (see below), then capped at 1.5× the box. Live-tuned behavior; the
// profile path (fitArea) takes over when a bubble border encloses the box.
export function bubbleArea(img: ImageData, box: DetBox): { x: number; y: number; w: number; h: number } {
    const { width: W, height: H, data } = img;
    const boxW = box.x2 - box.x1, boxH = box.y2 - box.y1;
    // Vertical text columns are narrow by nature (CTD hugs the glyphs, not the
    // bubble) while the bubble is wide — the uniform 30% cap below starves the
    // column layout of width and cascades the font to the floor. Let vertical
    // boxes grow 1.0× sideways (dark bubble borders still stop the fill; the
    // face-walk guard that motivated the 0.3 cap was horizontal B&W pages).
    const vertical = boxH > boxW * renderTuning.verticalThreshold;
    const growX = vertical ? 1.0 : 0.3;
    const fill = interiorFill(img, box, growX, 0.3);
    let { minX, minY, maxX, maxY } = fill;
    const [r0, g0, b0] = fill.seed;

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
    if ((minX <= 0 ? 0 : edgeColFrac(minX - 1)) < 0.7 || (maxX >= W - 1 ? 0 : edgeColFrac(maxX + 1)) < 0.7) {
        const w = Math.min(maxX - minX, (box.x2 - box.x1) * 1.5);
        const cxb = (box.x1 + box.x2) / 2;
        minX = Math.round(cxb - w / 2); maxX = Math.round(cxb + w / 2);
    }
    if ((minY <= 0 ? 0 : edgeRowFrac(minY - 1)) < 0.7 || (maxY >= H - 1 ? 0 : edgeRowFrac(maxY + 1)) < 0.7) {
        const h = Math.min(maxY - minY, (box.y2 - box.y1) * 1.5);
        const cyb = (box.y1 + box.y2) / 2;
        minY = Math.round(cyb - h / 2); maxY = Math.round(cyb + h / 2);
    }

    const area = (maxX - minX) * (maxY - minY);
    if (area < boxW * boxH * 0.25) {
        // degenerate fill (text/lines block the seed): padded box
        const px = boxW * 0.08, py = boxH * 0.08;
        return {
            x: box.x1 - px, y: box.y1 - py,
            w: boxW + 2 * px, h: boxH + 2 * py,
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
    return { x: fx1, y: fy1, w: fx2 - fx1, h: fy2 - fy1 };
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
}

// How much of the run rows must show a bubble outline right outside the run
// for the profile to be trusted. Live calibration (2 pages, [mt] probe dump):
// real bubbles landed 0.5-0.92, while text over artwork (a face close-up, a
// hair region, a memo leaking into the drawing) landed below 0.5 or lost the
// profile entirely once the outline walk required a thin dark line. Below the
// bar the tuned no-frame rectangle (bubbleArea) takes over.
export const ENCLOSED_MIN = 0.5;

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
    const pass = (p: number, q: number) => inBox(p, q) || seedAt(p, q);
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
    for (let p = p0; p <= p1; p++) {
        if (!pass(p, center)) continue; // no interior at the box center line
        let a = center, b = center;
        while (a - 1 >= winLo && pass(p, a - 1)) a--;
        while (b + 1 <= winHi && pass(p, b + 1)) b++;
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
    return { vertical, p0, p1, i1, i2, enclosed: enclosedRows / rows, e0, e1 };
}

// Usable interval for a band of the stacking axis: the intersection of every
// row's run across the band (min-over-band — a single leaked or noisy row
// cannot widen a line). Null = the band is not fully inside the interior.
export function runInterval(prof: RunProfile, p0: number, p1: number): [number, number] | null {
    const a = Math.max(prof.p0, Math.ceil(p0 - 0.5));
    const b = Math.min(prof.p1, Math.floor(p1 - 0.5));
    if (b < a) return null;
    let x1 = -1, x2 = -1;
    for (let p = a; p <= b; p++) {
        const k = p - prof.p0;
        if (prof.i1[k] > prof.i2[k]) return null;
        if (x1 < 0 || prof.i1[k] > x1) x1 = prof.i1[k];
        if (x2 < 0 || prof.i2[k] < x2) x2 = prof.i2[k];
    }
    return x2 > x1 ? [x1, x2] : null;
}

// Enclosed-bubble path: profile measurement, or the legacy rectangle when the
// evidence says there is no bubble around this box.
function fitArea(img: ImageData, box: DetBox, vertical: boolean): LayoutRect {
    const rect = (why: string): LayoutRect => ({ ...bubbleArea(img, box), why });
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
    const fill = interiorFill(img, box, vertical ? 0.6 : 1.2, vertical ? 1.2 : 0.6, true);
    const [r0, g0, b0] = fill.seed;
    let { minX, minY, maxX, maxY } = fill;
    ({ minX, maxX, minY, maxY } = clampToBorders(img.data, img.width, img.height, [r0, g0, b0], box, { minX, minY, maxX, maxY }));
    const boxW = box.x2 - box.x1, boxH = box.y2 - box.y1;
    if ((maxX - minX) * (maxY - minY) >= boxW * boxH * 0.25) {
        const prof = widthProfile(img, box, vertical, fill.seed, { x1: minX, y1: minY, x2: maxX, y2: maxY }, fill);
        if (!prof) return rect('norows');
        if (prof.enclosed < ENCLOSED_MIN) return rect(`enclose ${prof.enclosed.toFixed(2)}`);
        if (prof.e1 <= prof.e0) return rect('no-evidence-rows');
        {
            const ks = Math.max(0, prof.e0 - prof.p0), ke = Math.min(prof.i1.length - 1, prof.e1 - prof.p0);
            let q1 = -1, q2 = -1;
            for (let k = ks; k <= ke; k++) {
                if (prof.i1[k] > prof.i2[k]) continue;
                if (q1 < 0 || prof.i1[k] < q1) q1 = prof.i1[k];
                if (q2 < 0 || prof.i2[k] > q2) q2 = prof.i2[k];
            }
            if (q2 > q1) {
                const s0 = prof.e0, s1 = prof.e1; // rows with outline evidence on both sides
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

// Layout area the renderer actually uses: enclosed bubbles get the measured
// per-line profile; a big box with almost no ink (small SFX in empty space,
// texture false-positive) lays out on the ink bbox instead — otherwise the
// font scales to the box and billboards over its neighbors. (Live: "อ๊ะ♡" in
// a 222×268 box rendered at 124px.) Null = zero ink, nothing to place on.
export function layoutArea(img: ImageData, box: DetBox, vertical: boolean = boxIsVertical(box)): LayoutRect | null {
    const ink = inkStats(img, box);
    if (ink.x2 <= ink.x1 || ink.y2 <= ink.y1) return null;
    if (ink.frac < 0.03) {
        const pad = 6;
        return {
            x: Math.max(0, ink.x1 - pad), y: Math.max(0, ink.y1 - pad),
            w: ink.x2 - ink.x1 + 2 * pad, h: ink.y2 - ink.y1 + 2 * pad,
            why: 'ink-bbox',
        };
    }
    return fitArea(img, box, vertical);
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
): Placed | null {
    if (!text.trim()) return null;
    if (chosenOrientation(ctx, img, box, text)) return renderVertical(ctx, img, box, text);
    return renderHorizontal(ctx, img, box, text);
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
    img: ImageData, box: DetBox, text: string,
): boolean {
    if (!boxIsVertical(box)) return false;
    if (renderTuning.preferHorizontal) {
        const probe = pageArea(ctx, img, box, true);
        if (probe && horizontalFits(ctx, text, probe)) return false;
    }
    return true;
}

export interface Placed { fontSize: number; lines: string[]; overflow?: boolean; color?: string; block?: [number, number] }

interface Area { x: number; y: number; w: number; h: number }

// Placement rect, optionally carrying the measured per-line profile (see
// widthProfile) for enclosed bubbles.
export interface LayoutRect extends Area { runs?: RunProfile; why?: string }

// Shared placement-area resolution (layoutArea + canvas clamp + 20px floor).
// Both orientations and the horizontal-fit probe use it, so the probe can
// never disagree with the real render about the area. Exported for the debug
// overlay (renderDebugView draws the rect and profile the layout actually got).
export function pageArea(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    img: ImageData,
    box: DetBox,
    vertical: boolean,
): LayoutRect | null {
    // clamp to canvas bounds (boxes at page edges can otherwise hang over)
    const CW = ctx.canvas.width, CH = ctx.canvas.height;
    const found = layoutArea(img, box, vertical);
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
        let a = wrapUnitsIntoLines(ctx, segments, widthFor(anchorA, lh));
        let edgeFailed = a.failed;
        if (a.failed) {
            // The first pass starts at the area's reading-order edge, where a
            // round bubble is narrowest. A unit that cannot fit there can still
            // fit the centered band — a short line lives in the middle. Skipping
            // the size outright made a round profile shrink short text far below
            // the source size (live: a two-word line, font 32 → 15 in a 67px
            // box; the same skip capped a JP column at 19 against a 34px source).
            const centered = prof.vertical ? stack0 + (stackLen + lh) / 2 : stack0 + (stackLen - lh) / 2;
            const c = wrapUnitsIntoLines(ctx, segments, widthFor(centered, lh));
            if (c.failed) continue;
            a = c;
        }
        const fitsA = a.lines.length * lh <= stackFit + 0.5;
        // Recenter the block and re-wrap with the shifted bands. A block that
        // wrapped at the edge keeps the legacy overflow policy (start at the
        // edge, clipped tail) rather than centering a block that cannot fit.
        const spanA = a.lines.length * lh;
        const anchorB = prof.vertical ? stack0 + (stackLen + spanA) / 2 : stack0 + (stackLen - spanA) / 2;
        const b = fitsA ? wrapUnitsIntoLines(ctx, segments, widthFor(anchorB, lh)) : { lines: a.lines, failed: false };
        const overflowUse = b.failed || b.lines.length * lh > stackFit + 0.5;
        const lines = overflowUse ? a.lines : b.lines;
        // The centered anchor comes from the block actually placed. The centered
        // re-wrap can need FEWER lines than the edge pass (a round bubble's
        // narrow top band wraps what the wide middle band fits on one line), and
        // an anchor built from the edge pass's longer span parks the shorter
        // block half a line above center (live: badge 6 ly 679 vs centered 695,
        // n=1 with a 2-line span; badge 9 likewise 1014 vs 1051 at n=2/span 3).
        const span = lines.length * lh;
        const top = !overflowUse || edgeFailed
            ? (prof.vertical ? stack0 + (stackLen + span) / 2 : stack0 + (stackLen - span) / 2)
            : anchorA;
        const use = { lines, top };
        const centers = use.lines.map((_, j) => {
            const b0 = prof.vertical ? use.top - (j + 1) * lh : use.top + j * lh;
            const iv = runInterval(prof, b0, b0 + lh);
            return iv ? (iv[0] + iv[1]) / 2 : midCross;
        });
        const out: LaidOutFit = { lines: use.lines, fontSize: size, lineHeight: lh, top: use.top, centers };
        if (fitsA) return out;
        fallback = out;
    }
    if (fallback) return fallback;
    // nothing wrapped at any size (holes under every band): last-resort rect
    // layout, top/right-aligned and clipped — the legacy overflow policy
    const laid = layoutText(ctx, text, area.w, area.h, cap);
    if (!laid.lines.length) return null;
    return {
        lines: laid.lines, fontSize: laid.fontSize, lineHeight: laid.lineHeight,
        top: prof.vertical ? stack0 + stackLen : stack0,
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
): Placed | null {
    if (!text.trim()) return null;
    const area = pageArea(ctx, img, box, false);
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
): Placed | null {
    const area = pageArea(ctx, img, box, true);
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
