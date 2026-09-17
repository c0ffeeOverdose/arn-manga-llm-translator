// Inpaint: erase original text using CTD's text mask.
// Fill = per-box median background color sampled from a ring just outside the box.
// The raw mask is conservative (anti-aliased glyph edges survive) — dilate it
// a few px instead of color-distance heuristics (those eat bubble outlines).
import type { DetBox, DetectResult } from './detection';
import { inpaintPage, type InpaintPatch } from './detection';
import { dropContainedBoxes } from './page-cache';
import type { RegionOutput } from '../llm/core';

const DILATE_PASSES = 3; // 3 x 3x3 box dilation ≈ 6-7px — kills anti-aliased glyph edges

function dilate(mask: Uint8Array, w: number, h: number, passes = DILATE_PASSES): Uint8Array {
    let cur = mask;
    for (let p = 0; p < passes; p++) {
        const next = new Uint8Array(cur.length);
        for (let y = 0; y < h; y++) {
            const y0 = Math.max(0, y - 1) * w, y1 = y * w, y2 = Math.min(h - 1, y + 1) * w;
            for (let x = 0; x < w; x++) {
                const x0 = Math.max(0, x - 1), x1 = x, x2 = Math.min(w - 1, x + 1);
                if (cur[y0 + x0] || cur[y0 + x1] || cur[y0 + x2] ||
                        cur[y1 + x0] || cur[y1 + x1] || cur[y1 + x2] ||
                        cur[y2 + x0] || cur[y2 + x1] || cur[y2 + x2]) {
                    next[y1 + x1] = 255;
                }
            }
        }
        cur = next;
    }
    return cur;
}

// Erase box for one region: the CTD box plus mask ink that touches it from
// outside. CTD boxes can stop a few px short of the glyphs (live: a narration
// box cut the last line in half, leaving "SAO…" visible under the translation
// — the box bottom crossed the glyphs at y2077 while the ink ran to y2102).
// The mask says where text really is, so follow it out with a gap allowance
// (glyphs have inter-row gaps) up to `pad`. Sides perpendicular to the scan
// stay inside the side's span, so the walk cannot wander sideways into a
// neighbour's text. Pure-ish (mask reads only) — exported for tests.
export function eraseBox(m: Uint8Array, W: number, H: number, box: { x1: number; y1: number; x2: number; y2: number }, pad: number): { x1: number; y1: number; x2: number; y2: number } {
    const x1 = Math.max(0, Math.floor(box.x1)), y1 = Math.max(0, Math.floor(box.y1));
    const x2 = Math.min(W - 1, Math.ceil(box.x2)), y2 = Math.min(H - 1, Math.ceil(box.y2));
    const gapOK = 3; // consecutive empty rows/cols a glyph gap may span
    const rowInk = (y: number): boolean => { for (let x = x1; x <= x2; x++) if (m[y * W + x]) return true; return false; };
    const colInk = (x: number): boolean => { for (let y = y1; y <= y2; y++) if (m[y * W + x]) return true; return false; };
    const walk = (from: number, to: number, step: 1 | -1, ink: (i: number) => boolean): number => {
        let best = from, gap = 0;
        for (let i = from + step; step > 0 ? i <= to : i >= to; i += step) {
            if (ink(i)) { best = i; gap = 0; } else if (++gap > gapOK) break;
        }
        return best;
    };
    return {
        x1: walk(x1, Math.max(0, x1 - pad), -1, colInk),
        x2: walk(x2, Math.min(W - 1, x2 + pad), 1, colInk),
        y1: walk(y1, Math.max(0, y1 - pad), -1, rowInk),
        y2: walk(y2, Math.min(H - 1, y2 + pad), 1, rowInk),
    };
}

// Mask for the AI cleanup (manga-LaMa). The raw CTD mask is glyph-tight and
// anti-aliased, and cleanup windows sample it nearest-neighbour at 512px — with
// a tight mask the model still sees the leftover white glyphs between the
// strokes and fills the whole window with paper white instead of the art behind
// (live: a caption box on black speedlines came back as a white blob, and one
// extra pixel of dilation flipped it back — the strokes must merge into a solid
// region). Dilation radius therefore scales with the page (a bigger scan has
// bigger glyph gaps): 4px at 1600px, capped at 10. Restricting to the erase
// boxes keeps neighbours' glyphs untouched, and keep-box interiors are cleared
// after dilation (SFX stays visible for the model). Pure.
export function aiCleanupDilate(w: number, h: number): number {
    return Math.min(10, Math.max(4, Math.round(4 * Math.max(w, h) / 1600)));
}

export function aiCleanupMask(
    det: DetectResult,
    boxes: { x1: number; y1: number; x2: number; y2: number }[],
    keep: { x1: number; y1: number; x2: number; y2: number }[],
): { width: number; height: number; data: Uint8Array } {
    const W = det.mask.width, H = det.mask.height;
    const raw = new Uint8Array(det.mask.data);
    const out = new Uint8Array(W * H);
    const r = aiCleanupDilate(W, H);
    // Dilation only changes pixels within `r` px of box ink, so bound the
    // passes to the boxes' union bbox (grown by the radius): the full-page
    // walk was ~5 passes of 3MP x 9 neighbours of pure main-thread work per
    // page. A union covering most of the page keeps the full-page extent —
    // same output either way, just no savings.
    let ux1 = W, uy1 = H, ux2 = 0, uy2 = 0;
    for (const b of boxes) {
        ux1 = Math.min(ux1, Math.floor(b.x1)); uy1 = Math.min(uy1, Math.floor(b.y1));
        ux2 = Math.max(ux2, Math.ceil(b.x2)); uy2 = Math.max(uy2, Math.ceil(b.y2));
    }
    let x1 = 0, y1 = 0, x2 = W - 1, y2 = H - 1;
    if (boxes.length && (ux2 - ux1 + 1) * (uy2 - uy1 + 1) < W * H * 0.6) {
        x1 = Math.max(0, ux1 - r - 1); y1 = Math.max(0, uy1 - r - 1);
        x2 = Math.min(W - 1, ux2 + r + 1); y2 = Math.min(H - 1, uy2 + r + 1);
    }
    const bw = x2 - x1 + 1, bh = y2 - y1 + 1;
    const sub = new Uint8Array(bw * bh);
    for (const b of boxes) {
        const bx1 = Math.max(x1, Math.floor(b.x1)), by1 = Math.max(y1, Math.floor(b.y1));
        const bx2 = Math.min(x2, Math.ceil(b.x2)), by2 = Math.min(y2, Math.ceil(b.y2));
        for (let y = by1; y <= by2; y++) {
            const row = y * W;
            for (let x = bx1; x <= bx2; x++) if (raw[row + x] > 127) sub[(y - y1) * bw + (x - x1)] = 255;
        }
    }
    const gro = dilate(sub, bw, bh, r);
    for (let y = y1; y <= y2; y++) out.set(gro.subarray((y - y1) * bw, (y - y1) * bw + bw), y * W + x1);
    for (const k of keep) {
        const kx1 = Math.max(0, Math.floor(k.x1) - 2), ky1 = Math.max(0, Math.floor(k.y1) - 2);
        const kx2 = Math.min(W - 1, Math.ceil(k.x2) + 2), ky2 = Math.min(H - 1, Math.ceil(k.y2) + 2);
        for (let y = ky1; y <= ky2; y++) out.fill(0, y * W + kx1, y * W + kx2 + 1);
    }
    return { width: W, height: H, data: out };
}

// One AI-cleanup pass over the original page: erase boxes → mask → worker
// windows → patch PNGs. Shared by the render path and the warm paths
// (lookahead / chapter sweep precompute the patches into the cache entry, so
// arrival paints without paying the model). Patch `i` indexes the `erase`
// array, so a warm run over ALL boxes can be filtered to the erase set once
// the LLM has marked the 'keep' regions.
export interface AiPatches { patches: InpaintPatch[]; windows: number; ms: number; maskMs: number; lockWaitMs: number; encodeMs: number }
// Erase boxes (mask-led walk per region) + the dilated cleanup mask — the
// pixels the cleaner is allowed to touch. Shared by the local worker call and
// the cloud endpoint (both erase the same pixels by design).
export function eraseBoxesAndMask(
    bitmap: { width: number; height: number },
    det: DetectResult,
    erase: { x1: number; y1: number; x2: number; y2: number }[],
    keep: { x1: number; y1: number; x2: number; y2: number }[],
): { boxes: { x1: number; y1: number; x2: number; y2: number }[]; mask: { width: number; height: number; data: Uint8Array }; maskMs: number } {
    const t0 = performance.now();
    const rawMask = new Uint8Array(det.mask.data);
    const boxes = erase.map(b => eraseBox(rawMask, bitmap.width, bitmap.height, b,
        Math.max(8, Math.round((b.x2 - b.x1) * 0.08), Math.round((b.y2 - b.y1) * 0.08))));
    const mask = aiCleanupMask(det, boxes, keep);
    return { boxes, mask, maskMs: Math.round(performance.now() - t0) };
}

// Throws on model/worker failure — callers fall back to the built-in fill
// (render) or skip (warm). `noDownload`: availability comes from the model
// DB / dev bundle only — a background warm must not start a surprise 112MB
// download (the worker enforces it; a content-side IDB peek cannot see the
// extension-origin model DB).
export async function computeAiPatches(
    bitmap: ImageBitmap,
    det: DetectResult,
    erase: { x1: number; y1: number; x2: number; y2: number }[],
    keep: { x1: number; y1: number; x2: number; y2: number }[],
    opts?: { lo?: boolean; noDownload?: boolean },
): Promise<AiPatches | null> {
    if (!erase.length) return null;
    const { boxes, mask, maskMs } = eraseBoxesAndMask(bitmap, det, erase, keep);
    const r = await inpaintPage(bitmap, boxes, mask, 0.5, { lo: opts?.lo, noDownload: opts?.noDownload });
    if (!r.patches.length) return null;
    return { patches: r.patches, windows: r.windows, ms: r.ms, maskMs, lockWaitMs: r.lockWaitMs, encodeMs: r.encodeMs };
}

// Page pixel -> its index inside a cleanup window at page resolution.
// Callers composite through canvases sized `side` (the 512x512 model output
// upscaled back), so the index is the page-space offset from the window origin
// — NOT the 512-space offset (live bug: dividing by `side / 512` sampled art
// from above the box and smeared it over the masked text). Pure.
export function windowIndex(coord: number, origin: number, side: number): number {
    return Math.min(side - 1, Math.max(0, Math.floor(coord + 0.5 - origin)));
}

export function inpaint(canvas: OffscreenCanvas, det: DetectResult): void {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const { width: W, height: H } = canvas;
    const m = new Uint8Array(det.mask.data);
    const md = dilate(m, W, H);
    // regions that keep their source text (SFX, contained dups): the erase
    // walk must not eat their glyphs when a neighbouring box expands into them
    const skip = (det.keepBoxes ?? []).map(k => ({
        x1: Math.floor(Math.max(0, k.x1)) - 2, y1: Math.floor(Math.max(0, k.y1)) - 2,
        x2: Math.ceil(Math.min(W - 1, k.x2)) + 2, y2: Math.ceil(Math.min(H - 1, k.y2)) + 2,
    }));
    const inSkip = (x: number, y: number): boolean => skip.some(s => x >= s.x1 && x <= s.x2 && y >= s.y1 && y <= s.y2);

    // per-box background: the surface the box's glyphs sit on (see eraseBgColor)
    for (const b of det.boxes) {
        const ex = eraseBox(m, W, H, b, Math.max(8, Math.round((b.x2 - b.x1) * 0.08), Math.round((b.y2 - b.y1) * 0.08)));
        const bg = eraseBgColor(d, W, H, m, md, b);

        // fill strategy: masked pixels + connected faint text the mask missed.
        // Scan each row: rows with meaningful mask coverage are text rows —
        // fill the WHOLE row span across the erase region (long disclaimers
        // render tiny faint glyphs the network under-masks, leaving smears
        // otherwise). Runs over the EXPANDED region (see eraseBox) so glyphs
        // the CTD box clipped are erased too; keep-box interiors are skipped.
        for (let y = ex.y1; y <= ex.y2; y++) {
            const rowStart = y * W;
            let maskCount = 0;
            for (let x = ex.x1; x <= ex.x2; x++) if (md[rowStart + x]) maskCount++;
            const rowLen = ex.x2 - ex.x1 + 1;
            const rowIsText = maskCount > rowLen * 0.04 && maskCount >= 4;
            for (let x = ex.x1; x <= ex.x2; x++) {
                const p = rowStart + x;
                if (inSkip(x, y)) continue;
                if (md[p] || (rowIsText && isFaintText(d, p, bg))) {
                    const i = p * 4;
                    d[i] = bg[0]; d[i + 1] = bg[1]; d[i + 2] = bg[2]; d[i + 3] = 255;
                }
            }
        }
    }
    ctx.putImageData(img, 0, 0);
}

// Background color for the built-in erase: the surface the glyphs sit on.
// Priority is glyph-adjacent background (dilated-halo pixels that are not ink
// themselves), then the box interior (post-mask), then the outside ring — a
// side is PICKED, never averaged: averaging a black outside with a white
// inside paints gray on both (live /14: a white caption on the black banner
// erased to #808080). The ring exists only as a fallback for boxes with no
// background pixels of their own (dense text); the inside median covers the
// comment's old case too (dark scan bands poisoning the ring — the text still
// sits on paper). Pure — unit tested.
export function eraseBgColor(
    data: Uint8ClampedArray, W: number, H: number,
    maskRaw: Uint8Array, maskDilated: Uint8Array,
    box: { x1: number; y1: number; x2: number; y2: number },
): [number, number, number] {
    const x1 = Math.floor(Math.max(0, box.x1)), y1 = Math.floor(Math.max(0, box.y1));
    const x2 = Math.ceil(Math.min(W - 1, box.x2)), y2 = Math.ceil(Math.min(H - 1, box.y2));
    const ring: number[] = [];
    const step = Math.max(2, Math.floor((x2 - x1) / 16));
    for (let x = x1 - 6; x <= x2 + 6; x += step) {
        for (const y of [y1 - 6, y2 + 6]) {
            if (x >= 0 && x < W && y >= 0 && y < H) {
                const i = (y * W + x) * 4;
                ring.push(data[i], data[i + 1], data[i + 2]);
            }
        }
    }
    for (let y = y1 - 6; y <= y2 + 6; y += step) {
        for (const x of [x1 - 6, x2 + 6]) {
            if (x >= 0 && x < W && y >= 0 && y < H) {
                const i = (y * W + x) * 4;
                ring.push(data[i], data[i + 1], data[i + 2]);
            }
        }
    }
    const adj: number[] = [];
    const inside: number[] = [];
    const innerStep = Math.max(2, Math.floor((x2 - x1) / 20));
    for (let y = y1; y <= y2; y += Math.max(2, innerStep)) {
        for (let x = x1; x <= x2; x += innerStep) {
            const p = y * W + x;
            if (maskRaw[p]) continue; // ink itself
            const i = p * 4;
            (maskDilated[p] ? adj : inside).push(data[i], data[i + 1], data[i + 2]);
        }
    }
    const med = (s: number[]): [number, number, number] | null => {
        if (!s.length) return null;
        const ch = (c: number) => s.filter((_, i) => i % 3 === c).sort((a, b) => a - b);
        const r = ch(0), g = ch(1), b = ch(2);
        return [r[Math.floor(r.length / 2)], g[Math.floor(g.length / 2)], b[Math.floor(b.length / 2)]];
    };
    return med(adj) ?? med(inside) ?? med(ring) ?? [255, 255, 255];
}

// faint-text detector for text rows: dark-ish pixel against the box background
function isFaintText(d: Uint8ClampedArray, p: number, bg: number[]): boolean {
    const i = p * 4;
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const bgLum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    return Math.abs(lum - bgLum) > 40;
}

// Fill a VLM-reported extra region (no CTD mask available): estimate the box
// background from its border ring, then clear every pixel that differs from
// it. Bounded to the box — hand-written signs live on flat-ish areas.
// Returns the bounding box of actually-erased pixels (where the ink really
// was — VLM coords are approximate), or null when nothing qualifies. The
// caller renders the translation onto that box, so text lands on the ink.
export function inpaintBoxRegion(
    canvas: OffscreenCanvas,
    box: { x1: number; y1: number; x2: number; y2: number },
): { x1: number; y1: number; x2: number; y2: number } | null {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const { width: W, height: H } = canvas;
    const x1 = Math.floor(Math.max(0, box.x1)), y1 = Math.floor(Math.max(0, box.y1));
    const x2 = Math.ceil(Math.min(W - 1, box.x2)), y2 = Math.ceil(Math.min(H - 1, box.y2));

    // background from a ring just outside the box
    const ring: number[] = [];
    const step = Math.max(2, Math.floor((x2 - x1) / 12));
    for (let x = x1 - 4; x <= x2 + 4; x += step) {
        for (const y of [y1 - 4, y2 + 4]) {
            if (x >= 0 && x < W && y >= 0 && y < H) {
                const i = (y * W + x) * 4;
                ring.push(d[i], d[i + 1], d[i + 2]);
            }
        }
    }
    const bg = [0, 0, 0].map((_, c) => {
        const ch = ring.filter((_, i) => i % 3 === c).sort((a, b) => a - b);
        return ch.length ? ch[Math.floor(ch.length / 2)] : 255;
    });

    // gates: a real handwritten sign sits on LIGHT paper, has actual ink, and
    // isn't mostly-artwork. Wrong boxes (faces, screentone, bubbles) fail these
    // and get skipped instead of being erased into a dark rectangle.
    const bgLum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    if (bgLum < 140) return null;

    // pass 1: find ink pixels, collect the true bbox and density
    let inkX1 = Infinity, inkY1 = Infinity, inkX2 = -Infinity, inkY2 = -Infinity;
    let inkCount = 0, total = 0;
    const ink = (x: number, y: number): boolean => {
        const i = (y * W + x) * 4;
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        return Math.abs(lum - bgLum) > 40;
    };
    for (let y = y1; y <= y2; y++) {
        for (let x = x1; x <= x2; x++) {
            total++;
            if (ink(x, y)) {
                inkCount++;
                if (x < inkX1) inkX1 = x; if (x > inkX2) inkX2 = x;
                if (y < inkY1) inkY1 = y; if (y > inkY2) inkY2 = y;
            }
        }
    }
    // no ink found, too sparse to be writing, or the box is mostly "ink"
    // (= artwork, not a sign on paper) — all wrong-box signals, skip
    if (inkCount === 0 || inkCount / total < 0.03 || inkCount / total > 0.25) return null;

    // pass 2: erase the ink pixels
    for (let y = y1; y <= y2; y++) {
        for (let x = x1; x <= x2; x++) {
            if (ink(x, y)) {
                const i = (y * W + x) * 4;
                d[i] = bg[0]; d[i + 1] = bg[1]; d[i + 2] = bg[2]; d[i + 3] = 255;
            }
        }
    }
    ctx.putImageData(img, 0, 0);

    // pad the true ink bbox a little so the translation has breathing room
    const px = Math.max(6, (inkX2 - inkX1) * 0.1), py = Math.max(6, (inkY2 - inkY1) * 0.1);
    return {
        x1: Math.max(0, inkX1 - px), y1: Math.max(0, inkY1 - py),
        x2: Math.min(W - 1, inkX2 + px), y2: Math.min(H - 1, inkY2 + py),
    };
}

// Which boxes get erased vs kept — shared by the paint path and the AI
// cleanup call (both must agree on the set). Pure.
export function erasePlan(det: DetectResult, outputs: RegionOutput[]): {
    boxesToErase: DetBox[]; keepBoxes: DetBox[]; keepIdx: Set<number>; dupIdx: Set<number>; missedIdx: number[];
} {
    // inpaint only regions the LLM didn't mark 'keep' (SFX/signatures stay as-is)
    const keepIdx = new Set(
        outputs.filter(o => o.translation === 'keep').map(o => o.index),
    );
    // erase ONLY boxes with a real translation — a skipped region (no output
    // even after the retry) keeps its source text instead of ending up wiped
    // and untranslated while the page registers as Done.
    const translatedIdx = new Set(
        outputs.filter(o => o.translation && o.translation !== 'keep').map(o => o.index),
    );
    // contained-duplicate guard (heals old cache entries on revisit, and
    // confident dups the detection gate keeps): the lower-conf box is treated
    // as keep — its source text stays instead of a second colliding paint.
    const keptBoxes = new Set(dropContainedBoxes(det.boxes));
    const dupIdx = new Set(det.boxes.map((b, i) => keptBoxes.has(b) ? -1 : i + 1).filter(i => i > 0));
    const boxesToErase = det.boxes.filter((_, i) => translatedIdx.has(i + 1) && !dupIdx.has(i + 1));
    const keepBoxes = det.boxes.filter((_, i) => keepIdx.has(i + 1) || dupIdx.has(i + 1));
    const missedIdx = det.boxes.map((_, i) => i + 1).filter(i => !translatedIdx.has(i) && !keepIdx.has(i));
    return { boxesToErase, keepBoxes, keepIdx, dupIdx, missedIdx };
}

