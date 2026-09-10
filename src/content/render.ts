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
export const renderTuning = { minFont: MIN_FONT, letterSpacing: TRACKING, verticalThreshold: 2.2, preferHorizontal: true, font: `${FONT}, sans-serif`, textColor: 'auto', strokeColor: 'auto', textStroke: 0.1 };

// Render-logic generation, stamped into the [mt] page result dump — bump on
// ANY render.ts layout change so a stale-extension vs weak-fix question is
// answered by the dump instead of guesswork.
export const RENDER_GEN = 5;

export function setRenderTuning(t: { minFont?: number; letterSpacing?: number; verticalThreshold?: number; preferHorizontal?: boolean; font?: string; textColor?: string; strokeColor?: string; textStroke?: number }): void {
    if (t.minFont) renderTuning.minFont = t.minFont;
    if (t.letterSpacing != null) renderTuning.letterSpacing = t.letterSpacing;
    if (t.verticalThreshold) renderTuning.verticalThreshold = t.verticalThreshold;
    if (t.preferHorizontal != null) renderTuning.preferHorizontal = t.preferHorizontal;
    if (t.font) renderTuning.font = t.font;
    if (t.textColor) renderTuning.textColor = t.textColor;
    if (t.strokeColor) renderTuning.strokeColor = t.strokeColor;
    if (t.textStroke != null) renderTuning.textStroke = t.textStroke;
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
        const lines: string[] = [];
        let ok = true;
        for (const seg of segments) {
            const units = wrapUnits(seg);
            let cur: Unit[] = [];
            for (const u of units) {
                const cand = joinUnits([...cur, u]);
                if (ctx.measureText(cand).width <= maxW) {
                    cur.push(u);
                } else {
                    if (!cur.length) { ok = false; break; } // single unit wider than the area
                    lines.push(joinUnits(cur));
                    cur = [u];
                    if (ctx.measureText(u.t).width > maxW) { ok = false; break; }
                }
            }
            if (!ok) break;
            if (cur.length) lines.push(joinUnits(cur));
        }
        if (!ok) continue;
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

// Text placement area: flood-fill the bubble interior from the detection box
// center, hard-limited to box+30% in every direction — in B&W manga the fill
// used to walk through faces (same white as bubble interiors) and claim the
// portrait as text area. Falls back to a slightly padded box when the fill is
// degenerate; runaway fills are impossible by construction now.
export function bubbleArea(img: ImageData, box: DetBox): { x: number; y: number; w: number; h: number } {
    const { width: W, height: H, data } = img;
    const cx = Math.floor((box.x1 + box.x2) / 2);
    const cy = Math.floor((box.y1 + box.y2) / 2);
    const si = (cy * W + cx) * 4;
    const [r0, g0, b0] = [data[si], data[si + 1], data[si + 2]];

    // Vertical text columns are narrow by nature (CTD hugs the glyphs, not the
    // bubble) while the bubble is wide — the uniform 30% cap below starves the
    // column layout of width and cascades the font to the floor. Let vertical
    // boxes grow 1.0× sideways (dark bubble borders still stop the fill; the
    // face-walk guard that motivated the 0.3 cap was horizontal B&W pages).
    const boxW = box.x2 - box.x1, boxH = box.y2 - box.y1;
    const vertical = boxH > boxW * renderTuning.verticalThreshold;
    const growX = vertical ? 1.0 : 0.3;
    const grow = 0.3; // allowed growth beyond the detection box
    const loX = Math.max(0, Math.floor(box.x1 - boxW * growX));
    const hiX = Math.min(W - 1, Math.ceil(box.x2 + boxW * growX));
    const loY = Math.max(0, Math.floor(box.y1 - (box.y2 - box.y1) * grow));
    const hiY = Math.min(H - 1, Math.ceil(box.y2 + (box.y2 - box.y1) * grow));

    const visited = new Uint8Array(W * H);
    const queue = [cy * W + cx];
    visited[cy * W + cx] = 1;
    let minX = cx, maxX = cx, minY = cy, maxY = cy, count = 0;
    const minFill = (box.x2 - box.x1) * (box.y2 - box.y1) * 0.25;

    while (queue.length) {
        const p = queue.pop()!;
        const x = p % W, y = (p / W) | 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        count++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx, ny = y + dy;
            if (nx < loX || ny < loY || nx > hiX || ny > hiY) continue;
            const np = ny * W + nx;
            if (visited[np]) continue;
            const i = np * 4;
            const dist = Math.abs(data[i] - r0) + Math.abs(data[i + 1] - g0) + Math.abs(data[i + 2] - b0);
            if (dist < 60) {
                visited[np] = 1;
                queue.push(np);
            }
        }
    }

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
    if (area < minFill) {
        // degenerate fill (text/lines block the seed): padded box
        const px = (box.x2 - box.x1) * 0.08, py = (box.y2 - box.y1) * 0.08;
        return {
            x: box.x1 - px, y: box.y1 - py,
            w: box.x2 - box.x1 + 2 * px, h: box.y2 - box.y1 + 2 * py,
        };
    }
    // 8% inner margin so text doesn't touch bubble edges
    const mx = (maxX - minX) * 0.08, my = (maxY - minY) * 0.08;
    return { x: minX + mx, y: minY + my, w: maxX - minX - 2 * mx, h: maxY - minY - 2 * my };
}

// Layout area the renderer actually uses: the bubble fill, except a big
// box with almost no ink (small SFX in empty space, texture
// false-positive) lays out on the ink bbox instead — otherwise the font
// scales to the box and billboards over its neighbors. (Live: "อ๊ะ♡" in
// a 222×268 box rendered at 124px.) Null = zero ink, nothing to place on.
export function layoutArea(img: ImageData, box: DetBox): { x: number; y: number; w: number; h: number } | null {
    const ink = inkStats(img, box);
    if (ink.x2 <= ink.x1 || ink.y2 <= ink.y1) return null;
    if (ink.frac < 0.03) {
        const pad = 6;
        return {
            x: Math.max(0, ink.x1 - pad), y: Math.max(0, ink.y1 - pad),
            w: ink.x2 - ink.x1 + 2 * pad, h: ink.y2 - ink.y1 + 2 * pad,
        };
    }
    return bubbleArea(img, box);
}

// Pick text color by contrast against the placement area background.
function textColorFor(img: ImageData, area: { x: number; y: number; w: number; h: number }): string {
    const { width: W, data } = img;
    let lum = 0, n = 0;
    const stepX = Math.max(1, Math.floor(area.w / 12));
    const stepY = Math.max(1, Math.floor(area.h / 12));
    for (let y = Math.floor(area.y); y < area.y + area.h; y += stepY) {
        for (let x = Math.floor(area.x); x < area.x + area.w; x += stepX) {
            const i = (y * W + x) * 4;
            lum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            n++;
        }
    }
    return n && lum / n > 128 ? '#111' : '#fff';
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
    // vertical Japanese columns are tall+narrow → render rotated 90° so Thai
    // reads top-to-bottom along the column instead of overflowing sideways.
    // preferHorizontal crams horizontal first and rotates only on overflow —
    // short text fits (the common case), long strips keep the rotated path.
    const boxW = box.x2 - box.x1, boxH = box.y2 - box.y1;
    const vertical = boxH > boxW * renderTuning.verticalThreshold;
    if (vertical && renderTuning.preferHorizontal) {
        const probe = pageArea(ctx, img, box);
        if (probe && horizontalFits(ctx, text, probe)) return renderHorizontal(ctx, img, box, text);
    }
    if (vertical) return renderVertical(ctx, img, box, text);
    return renderHorizontal(ctx, img, box, text);
}

export interface Placed { fontSize: number; lines: string[]; overflow?: boolean }

interface Area { x: number; y: number; w: number; h: number }

// Shared placement-area resolution (layoutArea + canvas clamp + 20px floor).
// Both orientations and the horizontal-fit probe use it, so the probe can
// never disagree with the real render about the area.
function pageArea(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    img: ImageData,
    box: DetBox,
): Area | null {
    // clamp to canvas bounds (boxes at page edges can otherwise hang over)
    const CW = ctx.canvas.width, CH = ctx.canvas.height;
    const found = layoutArea(img, box);
    if (!found) return null;
    const area = {
        x: Math.max(0, found.x), y: Math.max(0, found.y),
        w: Math.min(found.w, CW - Math.max(0, found.x)), h: Math.min(found.h, CH - Math.max(0, found.y)),
    };
    return area.w < 20 || area.h < 20 ? null : area;
}

// Horizontal font cap: one line needs ≈ 1.8x font size (glyph + headroom);
// never wider than w/2.
function hCap(area: Area): number {
    return Math.max(renderTuning.minFont, Math.min(MAX_FONT, Math.floor(area.h / 1.8), Math.floor(area.w / 2)));
}

// Would this text fit horizontally in the area? Probe for preferHorizontal:
// measure-only (no paint), same cap the real render uses.
export function horizontalFits(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    text: string,
    area: Area,
): boolean {
    const laid = layoutText(ctx, text, area.w, area.h, hCap(area));
    return laid.lines.length > 0 && laid.lines.length * laid.lineHeight <= area.h + 0.5;
}

function renderHorizontal(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    img: ImageData,
    box: DetBox,
    text: string,
): Placed | null {
    if (!text.trim()) return null;
    const area = pageArea(ctx, img, box);
    if (!area) return null;
    const { color, stroke } = resolveColors(img, area);

    const cap = hCap(area);
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
    return { fontSize: laid.fontSize, lines: laid.lines, overflow: overflow || undefined };
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
    const area = pageArea(ctx, img, box);
    if (!area) return null;
    const { color, stroke } = resolveColors(img, area);

    // rotated layout: line length ≤ area height, columns stack within area width.
    // Shrink the font cap until the wrapped column count fits the width —
    // this was the pre-layoutVertical behavior that rendered cleanly, plus an
    // explicit fit loop instead of a horizontal fallback (narrow region = unreadable).
    let laid: LaidOut | null = null;
    for (let capGuess = Math.max(renderTuning.minFont, Math.min(MAX_FONT, Math.floor(area.w / 1.8), Math.floor(area.h / 2.4)));
            capGuess >= renderTuning.minFont; capGuess -= 4) {
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

    const colW = laid.lineHeight; // each "line" becomes a vertical column
    const totalW = laid.lines.length * colW;

    // Overflow policy: clip to the region; on overflow keep columns from the
    // RIGHT (JA reading order) — the tail is clipped, the start stays readable.
    const overflow = totalW > area.w + 0.5;

    // Each line is pre-rotated inside its own canvas (text runs down, glyph
    // tops point left — standard for horizontal script in a vertical column).
    // Paste them directly: no composite rotation needed, so nothing can skew.
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
    let colX = firstColX(area.x, area.w, totalW, colW, overflow);
    for (const line of laid.lines) {
        const lineCanvas = new OffscreenCanvas(Math.ceil(colW), Math.ceil(area.h));
        const lctx = lineCanvas.getContext('2d')!;
        setFont(lctx, laid.fontSize);
        lctx.textAlign = 'center';
        lctx.textBaseline = 'middle';
        lctx.fillStyle = color;
        if (renderTuning.textStroke > 0) {
            lctx.strokeStyle = stroke;
            lctx.lineWidth = Math.max(1, laid.fontSize * renderTuning.textStroke);
            lctx.lineJoin = 'round';
        }
        lctx.translate(colW / 2, area.h / 2 + halfTrack() * laid.fontSize); // trailing-spacing compensation along the text run
        lctx.rotate(Math.PI / 2); // text run along +y (downward), length ≤ area.h
        if (renderTuning.textStroke > 0) lctx.strokeText(line, 0, 0);
        lctx.fillText(line, 0, 0);
        ctx.drawImage(lineCanvas, Math.round(colX), Math.round(area.y));
        colX -= colW;
        if (colX < area.x - colW) break; // past the left clip edge — done
    }
    ctx.restore();
    return { fontSize: laid.fontSize, lines: laid.lines, overflow: overflow || undefined };
}
