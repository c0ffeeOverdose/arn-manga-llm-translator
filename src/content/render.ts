// Thai text rendering into bubble regions on canvas.
// LLM spaces are phrase boundaries, " / " pre-broken lines, ICU splits Thai runs.

import type { DetBox } from './detection';

const FONT = 'Sriracha';           // Thai handwriting font (bundled)
const TRACKING = 0.1;      // letter spacing as fraction of font size
const LINE_SPACING = 0.25; // extra line gap as fraction
const HEADROOM = 0.55;     // vertical room for Thai vowel/tone marks
const MIN_FONT = 14;
const MAX_FONT = 200;

// Tunable via pipeline settings (set before rendering a page).
// Font is a CSS stack: Thai uses bundled Sriracha, others fall back to system fonts.
export const renderTuning = { minFont: MIN_FONT, letterSpacing: TRACKING, verticalThreshold: 2.2, font: `${FONT}, sans-serif`, textColor: 'auto', strokeColor: 'auto', textStroke: 0.1, textScale: 1 };

// Render-logic generation, stamped into the [mt] page result dump.
// Bump on ANY render.ts layout change.
export const RENDER_GEN = 28;

// Absolute floor for last-resort shrink below minFont before the overflow path clips.
// Primary loop still honors minFont; only overflowing text goes below it.
export const HARD_MIN_FONT = 8;

export function setRenderTuning(t: { minFont?: number; letterSpacing?: number; verticalThreshold?: number; font?: string; textColor?: string; strokeColor?: string; textStroke?: number; textScale?: number }): void {
    if (t.minFont) renderTuning.minFont = t.minFont;
    if (t.letterSpacing != null) renderTuning.letterSpacing = t.letterSpacing;
    if (t.verticalThreshold) renderTuning.verticalThreshold = t.verticalThreshold;
    if (t.font) renderTuning.font = t.font;
    if (t.textColor) renderTuning.textColor = t.textColor;
    if (t.strokeColor) renderTuning.strokeColor = t.strokeColor;
    if (t.textStroke != null) renderTuning.textStroke = t.textStroke;
    if (t.textScale) renderTuning.textScale = t.textScale;
}

// Font stack per target language: Thai gets the handwriting font, others use system fonts.
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

// ICU Thai word breaking.
let segmenter: Intl.Segmenter | null = null;
function thaiWords(text: string): string[] {
    if (!segmenter) segmenter = new Intl.Segmenter('th', { granularity: 'word' });
    return [...segmenter.segment(text)].map(s => s.segment).filter(w => w.trim());
}

// Wrap units: Thai words join WITHOUT spaces; explicit LLM spaces are phrase boundaries.
interface Unit { t: string; spaceBefore: boolean }

// Spaceless Thai runs segment at ANY length, or one long run forces the whole font down.
// Other scripts keep single-unit behavior (no mid-word breaks).
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

// Greedy wrap asking `widthFor(lineIdx)` for each line's room.
// `failed` = a single unit wider than its line (callers shrink the font).
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

// letterSpacing applies AFTER every glyph incl. the last, so measureText overstates width by one track.
// Shift the anchor right by half a track to compensate (per orientation).
function halfTrack(): number {
    return renderTuning.letterSpacing * 0.5; // × fontSize at the call site
}

// Fit text into (maxW, maxH), trying sizes from `cap` down to MIN_FONT; " / " splits hard line groups.
// Returns largest fitting size; on overflow the SMALLEST wrappable layout, down to HARD_MIN_FONT.
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
    // `floor` bounds how far overflowing text may shrink (minFont, HARD_MIN_FONT as last resort).
    const runSizes = (from: number, floor: number): LaidOut | null => {
        for (let size = from; size >= floor; size -= 2) {
            setFont(ctx, size);
            const lineHeight = size * (1 + HEADROOM + LINE_SPACING);
            const { lines, failed } = wrapUnitsIntoLines(ctx, segments, () => maxW);
            if (failed) continue;
            if (lines.length * lineHeight <= maxH) return { lines, fontSize: size, lineHeight };
            fallback = { lines, fontSize: size, lineHeight }; // keep smallest, not first
        }
        return null;
    };
    return runSizes(cap, renderTuning.minFont)
        ?? runSizes(renderTuning.minFont - 2, HARD_MIN_FONT)
        ?? fallback
        ?? (() => {
            setFont(ctx, renderTuning.minFont);
            return { lines: segments, fontSize: renderTuning.minFont, lineHeight: renderTuning.minFont * (1 + HEADROOM + LINE_SPACING) };
        })();
}

// Border ink: dark AND far (>=60) from the seed color; anti-aliased interiors and screentone don't qualify.
function isBorderInk(data: Uint8ClampedArray, i: number, r0: number, g0: number, b0: number): boolean {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return lum < 100 && Math.abs(data[i] - r0) + Math.abs(data[i + 1] - g0) + Math.abs(data[i + 2] - b0) >= 60;
}

// Border-cross clamp (exported pure for tests): scan the overshoot outside the box only,
// clamp to the first column/row with >=70% border ink. No divider = unchanged.
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

// Ink coverage inside the box vs the box-center seed; works dark-on-light and light-on-dark.
// Tight box on a glyph reports high frac (no-op); near-empty box reports ~0 with invalid bbox.
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

// Flood seed = the box's most common color, NOT the center pixel (center may land on a glyph).
// Colors quantized to 4 bits/channel and averaged so anti-aliased noise doesn't split the vote.
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

// Interior test (the flood fill's own tolerance): pixels this close to the seed are the same surface.
function seedLike(data: Uint8ClampedArray, i: number, seed: [number, number, number]): boolean {
    return Math.abs(data[i] - seed[0]) + Math.abs(data[i + 1] - seed[1]) + Math.abs(data[i + 2] - seed[2]) < 60;
}

export interface InteriorFill {
    seed: [number, number, number];
    minX: number; minY: number; maxX: number; maxY: number;
    count: number;
    // Hard window the fill could not leave: a run reaching it was clipped by the window, not ink.
    loX: number; loY: number; hiX: number; hiY: number;
}

// CTD text mask (full-res, 255 = text): text pixels are passable in every fill/profile walk.
// Wrong-size masks (different page/scale) are ignored.
export interface TextMask { width: number; height: number; data: ArrayBuffer }

function maskView(mask: TextMask | undefined, W: number, H: number): Uint8Array | null {
    if (!mask || mask.width !== W || mask.height !== H) return null;
    return new Uint8Array(mask.data);
}

// Bounded flood fill of the bubble interior; seed = modal color with center pixel as alternate, largest wins.
// Bounded to box ± grow (growX sideways) so a white page cannot be claimed.
function interiorFill(img: ImageData, box: DetBox, growX: number, grow: number, widen = false, mask?: TextMask): InteriorFill {
    const { width: W, height: H, data } = img;
    const cx = Math.floor((box.x1 + box.x2) / 2);
    const cy = Math.floor((box.y1 + box.y2) / 2);
    const si = (cy * W + cx) * 4;
    const center: [number, number, number] = [data[si], data[si + 1], data[si + 2]];
    const modal = interiorSeed(data, W, H, box);

    const boxW = box.x2 - box.x1, boxH = box.y2 - box.y1;
    // Split children carry a clip (their side of the cut): the flood must not cross into the sibling region.
    const clip = box.clip;
    const window4 = (gx: number, gy: number) => {
        let loX = Math.max(0, Math.floor(box.x1 - boxW * gx));
        let loY = Math.max(0, Math.floor(box.y1 - boxH * gy));
        let hiX = Math.min(W - 1, Math.ceil(box.x2 + boxW * gx));
        let hiY = Math.min(H - 1, Math.ceil(box.y2 + boxH * gy));
        if (clip) {
            // Clamp the CUT axis only; clamping the cross axis traps the flood inside the parent's box.
            // Unknown axis keeps the old clamp.
            if (box.cutAxis !== 'y') {
                loX = Math.max(loX, Math.ceil(clip.x1));
                hiX = Math.min(hiX, Math.floor(clip.x2));
            }
            if (box.cutAxis !== 'x') {
                loY = Math.max(loY, Math.ceil(clip.y1));
                hiY = Math.min(hiY, Math.floor(clip.y2));
            }
            loX = Math.min(loX, hiX); // degenerate clip: keep a valid window
            loY = Math.min(loY, hiY);
        }
        return { loX, loY, hiX, hiY };
    };

    // Start pixel for a seed = sampled pixel nearest the box center matching it.
    // Flooding from the center itself is wrong when the center sits on a thick glyph.
    const grid: number[] = [];
    const probes: number[] = []; // corner sample points, kept out of the nearest-to-center vote
    // Just-outside-the-box samples must START on the sample itself (see fillFrom).
    // Grid pixels may sit in glyph pockets with no interior of their own.
    const outside: number[] = [];
    {
        const gx1 = Math.max(0, Math.floor(box.x1)), gy1 = Math.max(0, Math.floor(box.y1));
        const gx2 = Math.min(W - 1, Math.ceil(box.x2)), gy2 = Math.min(H - 1, Math.ceil(box.y2));
        const stepX = Math.max(1, Math.floor((gx2 - gx1) / 24)), stepY = Math.max(1, Math.floor((gy2 - gy1) / 24));
        for (let y = gy1; y <= gy2; y += stepY) for (let x = gx1; x <= gx2; x += stepX) grid.push(y * W + x);
        for (const [x, y] of [[gx1, gy1], [gx2, gy1], [gx1, gy2], [gx2, gy2]] as const) probes.push(y * W + x);
        // A box hugging its glyphs has no interior pixel; the surface starts a few px out.
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
        // A seed sampled just outside the box starts there: re-homing it lands the flood in a glyph-gap pocket.
        // The pocket loses the largest-flood vote, collapsing the fill to the glyph column.
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
    // Candidates: modal interior color, center pixel, corner/outside probe colors (4-bit dedup).
    // Whichever surface floods largest is the one the box sits on.
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
            // Color-only seeds dedup by colour, outside samples by pixel (see fillFrom).
            // Deduping the sample away would lose the only flood reaching the bubble.
            if (seed.at != null) {
                if (seenAt.has(seed.at)) continue;
                seenAt.add(seed.at);
            } else {
                if (seenColor.has(key(seed.c))) continue;
                seenColor.add(key(seed.c));
            }
            let alt = fillFrom(seed.c, win);
            // Rescue for a trapped sample: re-flood from the sample itself when the grid flood cannot fill the box.
            // Only then — box-containment of the winner keeps an outside sample's page flood safe.
            if (seed.at != null && alt.count < boxW * boxH) {
                const rescued = fillFrom(seed.c, win, seed.at);
                if (rescued.count > alt.count) alt = rescued;
            }
            if (skipLeaks && windowFilled(alt, win)) continue;
            if (alt.count > best.count) best = alt;
        }
        return { fill: best, win };
    };
    // A candidate filling its whole window on every side is a leak, not a surface the box sits on.
    // The plain first vote keeps its legacy behaviour.
    const windowFilled = (fl: { minX: number; minY: number; maxX: number; maxY: number }, win: Win) =>
        fl.minX <= win.loX + 1 && fl.minY <= win.loY + 1 && fl.maxX >= win.hiX - 1 && fl.maxY >= win.hiY - 1;
    let pick = bestFor(window4(growX, grow));
    const { fill: f } = pick;
    const touches = f.minX <= pick.win.loX + 1 || f.maxX >= pick.win.hiX - 1 || f.minY <= pick.win.loY + 1 || f.maxY >= pick.win.hiY - 1;
    const shortSide = Math.min(boxW, boxH), longSide = Math.max(boxW, boxH);
    if (widen && touches && shortSide <= longSide * 0.35) {
        // Widen SIDEWAYS only for narrow column boxes clipped by the grow window; reject if the long axis grew.
        // Growth along the long axis is how a fill leaks into the page margin and fabricates outline evidence.
        const wide = bestFor(boxH > boxW ? window4(4, grow) : window4(growX, 4), true);
        const g = wide.fill;
        const longStable = boxH > boxW
            ? (g.maxY - g.minY) <= (f.maxY - f.minY) + 2
            : (g.maxX - g.minX) <= (f.maxX - f.minX) + 2;
        if (g.count > f.count && longStable) pick = wide;
    }
    return { ...pick.fill, ...pick.win };
}

// Sideways trim for the no-frame rect (see bubbleArea): per-row runs through the box center with the RUN_JUMP rule.
// Horizontal trim only; vertical bounds keep the clamp/trust/cap chain.
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

// Rectangle placement area — the NO-FRAME path: narration/SFX over art, open backgrounds.
// Flood-fill hard-limited to box+30% (1.0x sideways for vertical columns), verified vs spanning borders, capped at 1.5x.
export function bubbleArea(img: ImageData, box: DetBox, mask?: TextMask): { x: number; y: number; w: number; h: number; leakL?: number; leakR?: number } {
    const { width: W, height: H, data } = img;
    const boxW = box.x2 - box.x1, boxH = box.y2 - box.y1;
    // Vertical columns are narrow (CTD hugs glyphs, not the bubble); let them grow 1.0x sideways.
    // Dark bubble borders still stop the fill.
    const vertical = boxH > boxW * renderTuning.verticalThreshold;
    const growX = vertical ? 1.0 : 0.3;
    // Widen: a bubble on dark art can never pass the profile's outline evidence, so this rect is the whole fallback.
    // Same sideways-only grow + long-axis-stable guard as the profile path.
    const fill = interiorFill(img, box, growX, 0.3, true, mask);
    // Supported sideways bounds first: trust tests must judge the bubble's edge, not leaked art.
    const trim = trimFillX(img, box, fill, mask);
    let { minX, minY, maxX, maxY } = fill;
    minX = trim.minX; maxX = trim.maxX;
    const [r0, g0, b0] = fill.seed;
    const fillL = minX, fillR = maxX, fillT = minY, fillB = maxY; // pre-clamp bounds

    // Border-cross clamp: the fill may slip through a thin/anti-aliased border (tolerance 60); pull back to the real border.
    ({ minX, maxX, minY, maxY } = clampToBorders(data, W, H, [r0, g0, b0], box, { minX, minY, maxX, maxY }));

    // Trust-but-verify span: an edge stopped AT a spanning border is trustworthy; at grow bounds or spotty ink it is not.
    // Check the column/row just OUTSIDE the edge; untrusted span caps at 1.5x the box, centered on it.
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
    // A side the border-cross clamp moved sat on a spanning border — trust it without re-measuring.
    // TRUST_MIN 0.4, not 0.7: a curved edge only cuts the stroke over part of the span; leaks read ~0.0-0.2.
    const TRUST_MIN = 0.4;
    // A bound on the clip is our own sibling guard, not art: trust it.
    // NaN comparisons are false, so an absent clip keeps the old behaviour.
    const clipL = box.clip ? Math.ceil(box.clip.x1) : NaN, clipR = box.clip ? Math.floor(box.clip.x2) : NaN;
    const clipT = box.clip ? Math.ceil(box.clip.y1) : NaN, clipB = box.clip ? Math.floor(box.clip.y2) : NaN;
    const trustL = minX !== fillL || Math.abs(minX - clipL) <= 1, trustR = maxX !== fillR || Math.abs(maxX - clipR) <= 1;
    const trustT = minY !== fillT || Math.abs(minY - clipT) <= 1, trustB = maxY !== fillB || Math.abs(maxY - clipB) <= 1;
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
    // Dark interiors (black balloons on black art): the fill merges with artwork, so cap at box + 20%.
    // The detection box is the source text's footprint inside the balloon by construction.
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
    // Split child: grow the area to the clip on the CUT axis only; the cross axis keeps the child's own box.
    // layoutArea still clamps the final area to the clip.
    if (box.clip && box.cutAxis) {
        // CUT axis only: the cross axis is NOT reliable (the parent box carries the sibling's span).
        if (box.cutAxis === 'x') {
            // Divider clips leave far sides unbounded (±Infinity): only adopt finite bounds.
            if (Number.isFinite(box.clip.x1)) minX = Math.min(minX, Math.ceil(box.clip.x1));
            if (Number.isFinite(box.clip.x2)) maxX = Math.max(maxX, Math.floor(box.clip.x2));
        } else {
            if (Number.isFinite(box.clip.y1)) minY = Math.min(minY, Math.ceil(box.clip.y1));
            if (Number.isFinite(box.clip.y2)) maxY = Math.max(maxY, Math.floor(box.clip.y2));
        }
    }

    // 8% inner margin so text doesn't touch bubble edges, floored at the detection box.
    // The box is text by construction, so the area never goes below it.
    const mx = (maxX - minX) * 0.08, my = (maxY - minY) * 0.08;
    const fx1 = Math.min(minX + mx, box.x1), fy1 = Math.min(minY + my, box.y1);
    const fx2 = Math.max(maxX - mx, box.x2), fy2 = Math.max(maxY - my, box.y2);
    return { x: fx1, y: fy1, w: fx2 - fx1, h: fy2 - fy1, leakL: trim.leakL, leakR: trim.leakR };
}

// Dark-caption growth (rect path only): when the box sits on uniform darkness, grow along the stacking axis.
// Grow while new rows stay uniformly seed-dark, up to 2x box height. Null when not on darkness or nothing grew.
export function growDarkArea(img: ImageData, box: DetBox, area: Area): Area | null {
    const { width: W, height: H, data } = img;
    const seed = interiorSeed(data, W, H, box);
    if (0.299 * seed[0] + 0.587 * seed[1] + 0.114 * seed[2] >= 110) return null;
    const x1 = Math.max(0, Math.floor(area.x)), x2 = Math.min(W - 1, Math.ceil(area.x + area.w));
    const rowClean = (y: number): boolean => {
        if (y < 0 || y >= H) return false;
        if (box.clip && (y < Math.ceil(box.clip.y1) || y > Math.floor(box.clip.y2))) return false;
        const step = Math.max(1, Math.floor((x2 - x1) / 24));
        for (let x = x1; x <= x2; x += step) {
            if (!seedLike(data, (y * W + x) * 4, seed)) return false;
        }
        return true;
    };
    let y1 = Math.round(area.y), y2 = Math.round(area.y + area.h);
    const cap = Math.round((box.y2 - box.y1) * 2);
    let grown = 0;
    // down first: captions usually have the title above and margin below
    while (grown < cap && rowClean(y2)) { y2++; grown++; }
    while (grown < cap && rowClean(y1 - 1)) { y1--; grown++; }
    if (!grown) return null;
    return { x: area.x, y: y1, w: area.w, h: y2 - y1 };
}

// Placement profile (enclosed bubbles): usable width changes row by row.
// Measure the interior run containing the box per stacking position; each line fits its own band.
export interface RunProfile {
    vertical: boolean;
    p0: number; p1: number; // stacking-axis range (page coords, inclusive)
    i1: Int32Array; i2: Int32Array; // run-axis interval per stacking position; i1 > i2 = no run
    enclosed: number; // fraction of run rows with boundary evidence on both sides
    // First/last row with outline evidence on BOTH sides: the placement area is built from this range only.
    // Rows reached without a border keep shape but must not stretch the area.
    e0: number; e1: number;
    // Rows whose run end was clamped by RUN_JUMP: the fill escaped the bubble. Dump-only.
    leakL: number; leakR: number;
}

// Fraction of run rows needing outline evidence on both sides to trust the profile.
// Below the bar the no-frame rectangle (bubbleArea) takes over.
export const ENCLOSED_MIN = 0.5;

// A run narrower than RUN_MIN is an artifact sliver, not a text line: it must not extend the stacking range.
// Trimming it keeps a touching band from reading zero.
const RUN_MIN = 16;

// A run end must move continuously: an end jumping sideways by more than RUN_JUMP is not the boundary.
// The fill escaped through a gap and follows art; the end sticks at the last supported position (leaked).
export const RUN_JUMP = 36;
// Pure (unit tested): clamped end + whether the row jumped outward. dir 1 = min side, -1 = max side.
export function clampRunEnd(prev: number | null, raw: number, dir: 1 | -1): { value: number; leaked: boolean } {
    if (prev != null && dir * (prev - raw) > RUN_JUMP) return { value: prev, leaked: true };
    return { value: raw, leaked: false };
}

// Measure the profile inside the fill's (clamped) extents.
// Passable = interior-colored or inside the detection box; margin 8% per run, floored at the box.
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
    // The run scan must stay inside the AREA (the clamped fill bbox), or the paint truncates the wrapped line.
    // Window bounds still decide "clipped by window, not ink" in the outline check.
    const scanLo = Math.max(winLo, Math.round(vertical ? range.y1 : range.x1));
    const scanHi = Math.min(winHi, Math.round(vertical ? range.y2 : range.x2));
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
    // Boundary evidence = a THIN DARK LINE just outside the run (a bubble outline), not merely non-interior.
    // Walk while pixels ARE ink; 2px lead absorbs the fringe, thick ink (hair) walks 16px and fails.
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
        while (a - 1 >= scanLo && pass(p, a - 1)) a--;
        while (b + 1 <= scanHi && pass(p, b + 1)) b++;
        // Leak guard (see RUN_JUMP): a jumped row is clamped to the last supported end.
        // Its run cannot widen a band; the outline check runs at the supported line.
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

// Usable interval for a band: intersection of every row's run (a leaked row cannot widen a line).
// Edge hole rows are trimmed as profile artifacts; a hole INSIDE the span still nulls the band.
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

// Enclosed-bubble path: profile measurement, or the legacy rectangle when no bubble encloses the box.
function fitArea(img: ImageData, box: DetBox, vertical: boolean, mask?: TextMask): LayoutRect {
    const rect = (why: string, prof?: RunProfile): LayoutRect => ({
        ...bubbleArea(img, box, mask), why,
        // The profile's leak counts survive the fallback for diagnosis.
        ...(prof ? { leakL: prof.leakL, leakR: prof.leakR } : null),
    });
    // Per-axis leash: stacking axis 0.6/side (≤2.2x), run axis 1.2/side (≤3.4x).
    // A window-clipped end is not outline evidence, so clipped ends keep the rect fallback.
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
            // First/last EVIDENCED row holding a usable run (≥16px); isolated slivers are not text rows.
            // Rows inside the box always have runs (passable by construction), so this never trims source text.
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
                // Stacking extent: evidenced rows UNIONED with the detection box (clamped to the profile range).
                // The box is source text by construction, so it cannot inflate a leak.
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

// Original typesetting from ink bands in the box: pitch = span/bands, glyph = median band height.
// Null = ambiguous (no bands, or implausible line count).
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

// Font ceiling from measured source: reference = max(glyph height, pitch / line-height factor).
// Floored at minFont; null = no measurement.
export function sizeCapFrom(img: ImageData, box: DetBox, vertical: boolean): number | null {
    const src = sourcePitch(img, box, vertical);
    if (!src) return null;
    const ref = Math.max(src.glyph, src.pitch / (1 + HEADROOM + LINE_SPACING));
    return Math.max(renderTuning.minFont, Math.round(ref * renderTuning.textScale));
}

export function boxIsVertical(box: DetBox): boolean {
    return (box.y2 - box.y1) > (box.x2 - box.x1) * renderTuning.verticalThreshold;
}

// Split children: never let the area cross the cut. Pure — unit tested.
export function clipArea(a: Area, clip?: { x1: number; y1: number; x2: number; y2: number }): Area {
    if (!clip) return a;
    const x1 = Math.max(a.x, clip.x1), y1 = Math.max(a.y, clip.y1);
    const x2 = Math.min(a.x + a.w, clip.x2), y2 = Math.min(a.y + a.h, clip.y2);
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

// OCR-crop expansion (exported pure for tests): a box can clip its own glyphs, so grow an ink-touching edge.
// Grow to the last ink + margin, capped at half the box's smaller side; split children stay in their clip.
export interface CropRect { x: number; y: number; w: number; h: number }
// Per-side expansion budget for OCR crops (see expandCropToInk).
export function cropExpandCap(box: DetBox): number {
    return Math.max(16, Math.round(Math.min(box.x2 - box.x1, box.y2 - box.y1) * 0.5));
}
export function expandCropToInk(img: ImageData, box: DetBox, rect: CropRect): CropRect {
    const { width: W, height: H, data } = img;
    const seed = interiorSeed(data, W, H, box);
    const seedLum = 0.299 * seed[0] + 0.587 * seed[1] + 0.114 * seed[2];
    const cap = cropExpandCap(box);
    const clip = box.clip;
    let x1 = Math.max(0, Math.floor(rect.x)), y1 = Math.max(0, Math.floor(rect.y));
    let x2 = Math.min(W - 1, Math.ceil(rect.x + rect.w)), y2 = Math.min(H - 1, Math.ceil(rect.y + rect.h));
    const inkAt = (x: number, y: number): boolean =>
        x >= 0 && y >= 0 && x < W && y < H && cropInk(data, (y * W + x) * 4, seedLum);
    // ink pixels on an edge line (every px — 2px strokes must not be missed)
    const edgeInk = (vertical: boolean, at: number, lo: number, hi: number): number[] => {
        const out: number[] = [];
        for (let q = lo; q <= hi; q++) {
            if (vertical ? inkAt(at, q) : inkAt(q, at)) out.push(q);
        }
        return out;
    };
    // The touch ink must reach the box's own text: BFS over ink bounded by the growth window.
    // Path length capped at the expansion budget; returns the connected mass's bbox (null when unreached).
    const connectedMass = (vertical: boolean, pts: number[], at: number): { x1: number; y1: number; x2: number; y2: number } | null => {
        const loX = Math.max(0, x1 - cap), hiX = Math.min(W - 1, x2 + cap);
        const loY = Math.max(0, y1 - cap), hiY = Math.min(H - 1, y2 + cap);
        const ix1 = Math.ceil(box.x1) + 2, iy1 = Math.ceil(box.y1) + 2;
        const ix2 = Math.floor(box.x2) - 2, iy2 = Math.floor(box.y2) - 2;
        const seen = new Uint8Array(W * H);
        const dist = new Int16Array(W * H).fill(-1);
        // FIFO queue (index pointer, no shift): distances must be SHORTEST-path.
        // A LIFO stack inflates first-visit distances and strangles the flood.
        const queue: number[] = [];
        for (const q of pts) {
            const x = vertical ? at : q, y = vertical ? q : at;
            if (x < loX || x > hiX || y < loY || y > hiY || seen[y * W + x]) continue;
            seen[y * W + x] = 1;
            dist[y * W + x] = 0;
            queue.push(x + y * W);
        }
        let reached = false;
        let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
        for (let head = 0; head < queue.length; head++) {
            const p = queue[head];
            const x = p % W, y = (p / W) | 0;
            if (!inkAt(x, y)) continue;
            const d = dist[p];
            if (x < bx1) bx1 = x;
            if (y < by1) by1 = y;
            if (x > bx2) bx2 = x;
            if (y > by2) by2 = y;
            if (x >= ix1 && x <= ix2 && y >= iy1 && y <= iy2) reached = true;
            if (d + 1 > cap) continue;
            if (x - 1 >= loX && !seen[p - 1]) { seen[p - 1] = 1; dist[p - 1] = d + 1; queue.push(p - 1); }
            if (x + 1 <= hiX && !seen[p + 1]) { seen[p + 1] = 1; dist[p + 1] = d + 1; queue.push(p + 1); }
            if (y - 1 >= loY && !seen[p - W]) { seen[p - W] = 1; dist[p - W] = d + 1; queue.push(p - W); }
            if (y + 1 <= hiY && !seen[p + W]) { seen[p + W] = 1; dist[p + W] = d + 1; queue.push(p + W); }
        }
        return reached && bx2 >= bx1 ? { x1: bx1, y1: by1, x2: bx2, y2: by2 } : null;
    };
    // Grow one side to the last ink plus margin. Stops after 3 clean lines past the last ink, at cap/canvas/clip.
    const grow = (side: 'l' | 'r' | 't' | 'b'): void => {
        const vertical = side === 'l' || side === 'r';
        const dir = side === 'l' || side === 't' ? -1 : 1;
        const edge = side === 'l' ? x1 : side === 'r' ? x2 : side === 't' ? y1 : y2;
        const lo = vertical ? y1 : x1, hi = vertical ? y2 : x2;
        const bound = side === 'l'
            ? Math.max(0, Math.ceil(box.x1) - cap, clip ? Math.ceil(clip.x1) : 0)
            : side === 'r'
                ? Math.min(W - 1, Math.floor(box.x2) + cap, clip ? Math.floor(clip.x2) : W - 1)
                : side === 't'
                    ? Math.max(0, Math.ceil(box.y1) - cap, clip ? Math.ceil(clip.y1) : 0)
                    : Math.min(H - 1, Math.floor(box.y2) + cap, clip ? Math.floor(clip.y2) : H - 1);
        const touch = edgeInk(vertical, edge, lo, hi);
        // A spanning rule/border is not a cut glyph; a clean edge with daylight beyond never moves.
        if (!touch.length || touch.length >= (hi - lo + 1) * 0.6) return;
        const mass = connectedMass(vertical, touch, edge);
        if (!mass) return;
        // Absorb the mass's outward end plus margin — never blind-scan past it.
        const grown = side === 'l' ? mass.x1 - 4 : side === 'r' ? mass.x2 + 4 : side === 't' ? mass.y1 - 4 : mass.y2 + 4;
        const limited = dir < 0 ? Math.max(grown, edge - cap) : Math.min(grown, edge + cap);
        if (side === 'l') x1 = Math.min(edge, Math.max(limited, bound));
        else if (side === 'r') x2 = Math.max(edge, Math.min(limited, bound));
        else if (side === 't') y1 = Math.min(edge, Math.max(limited, bound));
        else y2 = Math.max(edge, Math.min(limited, bound));
    };
    grow('l'); grow('r'); grow('t'); grow('b');
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
// Glyph ink for crop expansion: far from the seed tone in EITHER direction.
// Gray screentone/shading sits between and must NOT count.
function cropInk(data: Uint8ClampedArray, i: number, seedLum: number): boolean {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return Math.abs(lum - seedLum) >= 90;
}
// Divider clips between overlapping areas (exported pure for tests): clip each box to its side of the box-gap midline.
// The midline always clears both boxes, so a box's own text is never cut; boxes sharing ink are skipped.
export interface Divider {
    index: number;
    clip: { x1: number; y1: number; x2: number; y2: number };
    cutAxis: 'x' | 'y';
}
export function dividerClips(boxes: DetBox[], areas: (LayoutRect | null)[]): Divider[] {
    const byIdx = new Map<number, Divider>();
    const put = (index: number, clip: Divider['clip'], cutAxis: 'x' | 'y') => {
        const prev = byIdx.get(index);
        const base = prev?.clip ?? boxes[index].clip ?? { x1: -Infinity, y1: -Infinity, x2: Infinity, y2: Infinity };
        byIdx.set(index, {
            index,
            clip: {
                x1: Math.max(base.x1, clip.x1), y1: Math.max(base.y1, clip.y1),
                x2: Math.min(base.x2, clip.x2), y2: Math.min(base.y2, clip.y2),
            },
            cutAxis: boxes[index].cutAxis ?? prev?.cutAxis ?? cutAxis,
        });
    };
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const ai = areas[i], aj = areas[j];
            if (!ai || !aj) continue;
            const bi = boxes[i], bj = boxes[j];
            if (bi.x1 < bj.x2 && bj.x1 < bi.x2 && bi.y1 < bj.y2 && bj.y1 < bi.y2) continue;
            const ix1 = Math.max(ai.x, aj.x), iy1 = Math.max(ai.y, aj.y);
            const ix2 = Math.min(ai.x + ai.w, aj.x + aj.w), iy2 = Math.min(ai.y + ai.h, aj.y + aj.h);
            if (ix2 <= ix1 || iy2 <= iy1) continue;
            if (!((ix2 - ix1) * (iy2 - iy1) > Math.min(ai.w * ai.h, aj.w * aj.h) * 0.05)) continue;
            if (bi.x2 <= bj.x1 || bj.x2 <= bi.x1) {
                const mid = bi.x2 <= bj.x1 ? (bi.x2 + bj.x1) / 2 : (bj.x2 + bi.x1) / 2;
                const [l, r] = (bi.x1 + bi.x2) / 2 <= (bj.x1 + bj.x2) / 2 ? [i, j] : [j, i];
                put(l, { x1: -Infinity, y1: -Infinity, x2: mid, y2: Infinity }, 'x');
                put(r, { x1: mid, y1: -Infinity, x2: Infinity, y2: Infinity }, 'x');
            } else if (bi.y2 <= bj.y1 || bj.y2 <= bi.y1) {
                const mid = bi.y2 <= bj.y1 ? (bi.y2 + bj.y1) / 2 : (bj.y2 + bi.y1) / 2;
                const [t, b] = (bi.y1 + bi.y2) / 2 <= (bj.y1 + bj.y2) / 2 ? [i, j] : [j, i];
                put(t, { x1: -Infinity, y1: -Infinity, x2: Infinity, y2: mid }, 'y');
                put(b, { x1: -Infinity, y1: mid, x2: Infinity, y2: Infinity }, 'y');
            }
        }
    }
    return [...byIdx.values()];
}

// Layout area the renderer uses: enclosed bubbles get the per-line profile.
// A big box with almost no ink lays out on the ink bbox instead; null = zero ink.
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
    const clamped = clipArea(found, box.clip);
    // The clip shrinks the AREA but the profile still describes runs past the cut.
    // Wrap width, line centres, and paint clip must agree with the returned area, so trim the runs.
    if (found.runs && (clamped.x !== found.x || clamped.y !== found.y || clamped.w !== found.w || clamped.h !== found.h)) {
        const prof = found.runs;
        const lo = Math.ceil(prof.vertical ? clamped.y : clamped.x);
        const hi = Math.floor(prof.vertical ? clamped.y + clamped.h : clamped.x + clamped.w);
        for (let k = 0; k < prof.i1.length; k++) {
            if (prof.i2[k] < prof.i1[k]) continue;
            prof.i1[k] = Math.max(prof.i1[k], lo);
            prof.i2[k] = Math.min(prof.i2[k], hi);
        }
    }
    return { ...clamped, runs: found.runs, why: found.why, leakL: found.leakL, leakR: found.leakR };
}

// Pick text color by contrast vs the placement background. Modal tone, not mean.
// Leaked rows/interior art drag a mean across the boundary; the largest bucket is the text's surface.
function textColorFor(img: ImageData, area: { x: number; y: number; w: number; h: number }, mask?: TextMask): string {
    const { width: W, data } = img;
    const mk = maskView(mask, W, img.height);
    const stepX = Math.max(1, Math.floor(area.w / 24));
    const stepY = Math.max(1, Math.floor(area.h / 24));
    const buckets = new Map<number, { n: number; lum: number }>();
    let best: { n: number; lum: number } | null = null;
    for (let y = Math.floor(area.y); y < area.y + area.h; y += stepY) {
        // Source glyph ink is not background: skip mask pixels so text-heavy boxes don't test ink colour.
        for (let x = Math.floor(area.x); x < area.x + area.w; x += stepX) {
            if (mk && mk[y * W + x] > 127) continue;
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

// Resolved paint colors: user-fixed colors win; 'auto' = contrast text with opposite stroke.
function resolveColors(img: ImageData, area: { x: number; y: number; w: number; h: number }, box?: DetBox, mask?: TextMask): { color: string; stroke: string } {
    // A split child's rect fallback can span the parent block and be dominated by untouched artwork.
    // When the area is much larger than the box, resolve contrast from the box instead.
    const big = box != null && (area.w > (box.x2 - box.x1) * 1.5 || area.h > (box.y2 - box.y1) * 1.5);
    const color = renderTuning.textColor === 'auto'
        ? textColorFor(img, big ? { x: box!.x1, y: box!.y1, w: box!.x2 - box!.x1, h: box!.y2 - box!.y1 } : area, big ? mask : undefined)
        : renderTuning.textColor;
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

// This region always lays out horizontal: every target here reads left-to-right, never rotate.
// Vertical machinery stays for a future vertical-script target; nothing selects it.
export function chosenOrientation(
    _ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    _img: ImageData, _box: DetBox, _text: string, _mask?: TextMask,
): boolean {
    return false;
}

export interface Placed { fontSize: number; lines: string[]; overflow?: boolean; color?: string; block?: [number, number]; grown?: 1 }

interface Area { x: number; y: number; w: number; h: number }

// Placement rect, optionally carrying the per-line profile for enclosed bubbles.
export interface LayoutRect extends Area { runs?: RunProfile; why?: string; leakL?: number; leakR?: number }

// Shared placement-area resolution (layoutArea + canvas clamp + 20px floor).
// Exported for the debug overlay (draws the rect/profile the layout got).
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

// Effective layout boxes: copies carrying divider clips where clip-less areas overlap.
// Erase keeps ORIGINAL boxes; only placement uses these.
export function effBoxesForAreas(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    img: ImageData,
    boxes: DetBox[],
    textFor: (index: number) => string,
    mask?: TextMask,
): DetBox[] {
    const areas = boxes.map((b, i) =>
        pageArea(ctx, img, b, chosenOrientation(ctx, img, b, textFor(i + 1), mask), mask));
    const divs = dividerClips(boxes, areas);
    if (!divs.length) return boxes;
    const byIdx = new Map(divs.map(d => [d.index, d]));
    return boxes.map((b, i) => {
        const d = byIdx.get(i);
        return d ? { ...b, clip: d.clip, cutAxis: d.cutAxis } : b;
    });
}

// Horizontal font cap: one line needs ≈1.8x font size (glyph + headroom); never wider than w/2.
function hCap(area: Area): number {
    return Math.max(renderTuning.minFont, Math.min(MAX_FONT, Math.floor(area.h / 1.8), Math.floor(area.w / 2)));
}

// Profile-aware layout: each line measured against the run at its own band, following the bubble shape.
// `top` is the block start on the stacking axis; `centers` the run-axis center per line.
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
    // Source-box center on the stacking axis: a fitting block parks on the source, not the area middle.
    // The move only stands when every line still fits its band; absent = area-centered (legacy).
    boxC?: number,
): LaidOutFit | null {
    const prof = area.runs!;
    const segments = text.split(' / ').map(s => s.trim()).filter(Boolean);
    if (!segments.length) return null;
    const stack0 = prof.vertical ? area.x : area.y;
    const stackLen = prof.vertical ? area.w : area.h;
    // The block may exceed the source box by a hair (1.8 pitch vs ~1.3), not by the whole measured area.
    // textScale above 1 is an explicit ask for more room.
    const stackFit = Math.min(stackLen, maxStack ?? stackLen);
    const midCross = prof.vertical ? area.y + area.h / 2 : area.x + area.w / 2;
    // Horizontal blocks start at the area top; vertical blocks stack LEFT (JA order) from the RIGHT edge.
    // Width for a line = interior at the line's CENTRE row, where the glyph body sits.
    const midIv = (p0: number, p1: number) => {
        const mid = Math.round((p0 + p1) / 2);
        return runInterval(prof, mid, mid + 1) ?? runInterval(prof, p0, p1);
    };
    const widthFor = (anchor: number, lh: number) => (j: number) => {
        const b0 = prof.vertical ? anchor - (j + 1) * lh : anchor + j * lh;
        const iv = midIv(b0, b0 + lh);
        if (iv) return iv[1] - iv[0];
        // Band past the measured range: reuse the nearest interval so long text lays out (clipped) instead of vanishing.
        // A hole INSIDE the range stays zero width (text must not cross it).
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
        // Centered block by free-boundary search: walk candidate spans ascending; first self-consistent wrap wins.
        // A failed candidate only means that window's bands were too narrow; shorter wraps are fallback only.
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
        // A centered re-wrap can need FEWER lines than the edge pass (narrow top band vs wide middle).
        const bFits = !!b && b.lines.length * lh <= stackFit + 0.5;
        const lines = bFits ? b!.lines : (edge.lines.length ? edge.lines : (b?.lines ?? []));
        if (!lines.length) continue;
        const span = lines.length * lh;
        // Keep wrap and placement consistent: centered blocks take the centered anchor, edge-wrapped stay at the edge.
        // Placing edge-wrapped lines centered would move them onto narrower bands than wrapped for.
        const useCentered = bFits || edge.failed;
        const areaTop = useCentered
            ? (prof.vertical ? stack0 + (stackLen + span) / 2 : stack0 + (stackLen - span) / 2)
            : anchorA;
        // Box-anchored candidate first (see boxC): same wrap parked on the source, guarded by the per-line fits check.
        // Offered whenever the span fits the AREA; the cap already bounds the font against blowup.
        const tops = [areaTop];
        if (boxC != null && span <= stackLen + 0.5) {
            const boxTop = Math.min(Math.max(boxC - span / 2, stack0), Math.max(stack0, stack0 + stackLen - span));
            if (Math.abs(boxTop - areaTop) > 0.5) tops.unshift(boxTop);
        }
        const slack = size * (renderTuning.letterSpacing * 0.5 + renderTuning.textStroke) + 1;
        const fitsAt = (top: number) => lines.every((line, j) => {
            const b0 = prof.vertical ? top - (j + 1) * lh : top + j * lh;
            const iv = midIv(b0, b0 + lh);
            return !iv || ctx.measureText(line).width <= iv[1] - iv[0] + slack;
        });
        let out: LaidOutFit | null = null;
        let wonBoxC = false;
        for (const top of tops) {
            if (!fitsAt(top)) continue;
            const centers = lines.map((_, j) => {
                const b0 = prof.vertical ? top - (j + 1) * lh : top + j * lh;
                const iv = midIv(b0, b0 + lh);
                return iv ? (iv[0] + iv[1]) / 2 : midCross;
            });
            out = { lines, fontSize: size, lineHeight: lh, top, centers };
            wonBoxC = tops.length > 1 && top === tops[0];
            break;
        }
        // A fitting CENTERED block wins outright; edge-anchored is fallback for smaller sizes.
        // A line overflowing its wrapped interval must never reach the paint — reject the size instead.
        if (!out) continue;
        // A box-parked fit wins outright too: it fits the measured bands AND sits on the source.
        if (bFits || wonBoxC) return out;
        fallback ??= out;
    }
    if (fallback) return fallback;
    // Nothing wrapped at any size: last-resort rect layout. CENTER a fitting block; edge anchor only for genuine overflow.
    const laid = layoutText(ctx, text, area.w, area.h, cap);
    if (!laid.lines.length) return null;
    const total = laid.lines.length * laid.lineHeight;
    const fits = total <= stackLen + 0.5;
    // A fitting block parks on the source (see boxC); overflow keeps the edge.
    const centerTop = (base: number) => boxC != null && fits
        ? Math.min(Math.max(boxC - total / 2, stack0), stack0 + stackLen - total)
        : base;
    return {
        lines: laid.lines, fontSize: laid.fontSize, lineHeight: laid.lineHeight,
        top: prof.vertical
            ? (fits ? centerTop(stack0 + (stackLen + total) / 2) : stack0 + stackLen)
            : (fits ? centerTop(stack0 + (stackLen - total) / 2) : stack0),
        centers: laid.lines.map(() => midCross),
    };
}

// Would this text fit horizontally? Measure-only probe with the same cap/layout as the real render.
// A degenerate single-line overflow (unwrappable unit at min font) is NOT a fit.
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
    const { color, stroke } = resolveColors(img, area, box, mask);
    const cap = Math.min(hCap(area), sizeCapFrom(img, box, false) ?? MAX_FONT);

    // Enclosed bubble: each line fitted to its own measured band, centered on its own run.
    if (area.runs) {
        const boxC = (box.y1 + box.y2) / 2;
        const laid = layoutTextFit(ctx, text, area, cap, Math.round((box.y2 - box.y1) * Math.max(1.15, renderTuning.textScale)), boxC);
        if (!laid || !laid.lines.length) return null;
        // The paint must use the size the wrap MEASURED: the loop leaves ctx font at the last size tried.
        setFont(ctx, laid.fontSize);
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

    let laid = layoutText(ctx, text, area.w, area.h, cap);
    if (!laid.lines.length) return null;

    // Dark caption on black art: grow into uniform darkness first (see growDarkArea), then lay out again.
    let grown: Area | null = null;
    let paintArea: LayoutRect = area;
    if (laid.lines.length * laid.lineHeight > area.h + 0.5) {
        grown = growDarkArea(img, box, area);
        if (grown && grown.h > area.h + 0.5) {
            paintArea = { ...area, ...grown };
            laid = layoutText(ctx, text, paintArea.w, paintArea.h, cap);
            if (!laid.lines.length) return null;
        } else {
            grown = null;
        }
    }

    setFont(ctx, laid.fontSize);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;

    // Overflow policy: text NEVER leaves the region (clipped); on overflow top-align so the start stays readable.
    const totalH = laid.lines.length * laid.lineHeight;
    const overflow = totalH > paintArea.h + 0.5;
    // A fitting block parks on the source box, not the area middle (same boxC rule as the profile path).
    const boxC = (box.y1 + box.y2) / 2;
    let y = overflow
        ? paintArea.y + laid.lineHeight / 2
        : Math.min(Math.max(boxC, paintArea.y + totalH / 2), paintArea.y + paintArea.h - totalH / 2)
        - totalH / 2 + laid.lineHeight / 2;

    const y0 = y; // first line's center — the block runs [y0 - lh/2, y0 - lh/2 + totalH]
    ctx.save();
    ctx.beginPath();
    ctx.rect(paintArea.x, paintArea.y, paintArea.w, paintArea.h);
    ctx.clip();
    const cx = paintArea.x + paintArea.w / 2 + halfTrack() * laid.fontSize; // trailing-spacing compensation
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
    return { fontSize: laid.fontSize, lines: laid.lines, overflow: overflow || undefined, color, block: [y0 - laid.lineHeight / 2, y0 - laid.lineHeight / 2 + totalH], ...(grown ? { grown: 1 as const } : null) };
}

// Left edge of the first (rightmost) column; columns extend LEFTWARD.
// Overflow right-aligns, but a fitting block must CENTER (centering block-left clipped the last column).
export function firstColX(ax: number, aw: number, totalW: number, colW: number, overflow: boolean): number {
    return overflow ? ax + aw - colW : ax + (aw + totalW) / 2 - colW;
}
// Tall narrow region (vertical JA column): lines run top-to-bottom, reading right-to-left like the original.
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

    // Enclosed bubble: each column fitted to its own measured run (transposed profile).
    const fit = area.runs ? layoutTextFit(ctx, text, area, cap, Math.round((box.x2 - box.x1) * Math.max(1.15, renderTuning.textScale)), (box.x1 + box.x2) / 2) : null;
    let laid: LaidOut | null = null;
    if (area.runs) {
        if (!fit || !fit.lines.length) return null;
    } else {
        // Rotated layout: line length ≤ area height, columns stack within width; shrink cap until columns fit.
        // An overflowing strip keeps the narrowest fit (most columns small, not one giant clipped column).
        for (let capGuess = cap; capGuess >= renderTuning.minFont; capGuess -= 4) {
            const cand = layoutText(ctx, text, area.h, area.w, capGuess); // swapped: length ≤ h, stack ≤ w
            const totalW = cand.lines.length * cand.lineHeight;
            if (totalW <= area.w) {
                laid = cand;
                break;
            }
            // Keep the narrowest anyway: an overflowing strip shows the most columns small, not one giant clipped column.
            if (!laid || totalW < laid.lines.length * laid.lineHeight) laid = cand;
        }
        if (!laid || !laid.lines.length) return null;
    }

    const lines = fit ? fit.lines : laid!.lines;
    const fontSize = fit ? fit.fontSize : laid!.fontSize;
    const lineHeight = fit ? fit.lineHeight : laid!.lineHeight;
    const colW = lineHeight; // each "line" becomes a vertical column
    const totalW = lines.length * colW;

    // Overflow: clip to the region; keep columns from the RIGHT (JA reading order).
    const overflow = totalW > area.w + 0.5;
    // First column's left edge: profile fit's block right edge minus one column; legacy centers/right-aligns otherwise.
    let colX = fit ? fit.top - colW : firstColX(area.x, area.w, totalW, colW, overflow);

    // Each line is pre-rotated in its own canvas (text runs down, glyph tops point left).
    // Pasted directly: no composite rotation, so nothing can skew.
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
