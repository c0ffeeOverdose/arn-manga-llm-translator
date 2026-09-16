// Inpaint: erase original text using CTD's text mask.
// Fill = per-box median background color sampled from a ring just outside the box.
// The raw mask is conservative (anti-aliased glyph edges survive) — dilate it
// a few px instead of color-distance heuristics (those eat bubble outlines).
import type { DetectResult } from './detection';

const DILATE_PASSES = 3; // 3 x 3x3 box dilation ≈ 6-7px — kills anti-aliased glyph edges

function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
    let cur = mask;
    for (let p = 0; p < DILATE_PASSES; p++) {
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

    // per-box background color from a ring just outside the box
    for (const b of det.boxes) {
        const ex = eraseBox(m, W, H, b, Math.max(8, Math.round((b.x2 - b.x1) * 0.08), Math.round((b.y2 - b.y1) * 0.08)));
        const x1 = Math.floor(Math.max(0, b.x1)), y1 = Math.floor(Math.max(0, b.y1));
        const x2 = Math.ceil(Math.min(W - 1, b.x2)), y2 = Math.ceil(Math.min(H - 1, b.y2));
        const ring: number[] = [];
        const step = Math.max(2, Math.floor((x2 - x1) / 16));
        for (let x = x1 - 6; x <= x2 + 6; x += step) {
            for (const y of [y1 - 6, y2 + 6]) {
                if (x >= 0 && x < W && y >= 0 && y < H) {
                    const i = (y * W + x) * 4;
                    ring.push(d[i], d[i + 1], d[i + 2]);
                }
            }
        }
        for (let y = y1 - 6; y <= y2 + 6; y += step) {
            for (const x of [x1 - 6, x2 + 6]) {
                if (x >= 0 && x < W && y >= 0 && y < H) {
                    const i = (y * W + x) * 4;
                    ring.push(d[i], d[i + 1], d[i + 2]);
                }
            }
        }
        // background estimate: blend ring median with the dominant color INSIDE
        // the box (post-mask) — dark scan bands under disclaimer lines otherwise
        // poison the ring sample
        const inside: number[] = [];
        const innerStep = Math.max(2, Math.floor((x2 - x1) / 20));
        for (let y = y1; y <= y2; y += Math.max(2, innerStep)) {
            for (let x = x1; x <= x2; x += innerStep) {
                const p = y * W + x;
                if (!md[p]) { // not text
                    const i = p * 4;
                    inside.push(d[i], d[i + 1], d[i + 2]);
                }
            }
        }
        const bg = [0, 0, 0].map((_, c) => {
            const ringCh = ring.filter((_, i) => i % 3 === c).sort((a, b) => a - b);
            const inCh = inside.filter((_, i) => i % 3 === c).sort((a, b) => a - b);
            const ringMed = ringCh.length ? ringCh[Math.floor(ringCh.length / 2)] : null;
            const inMed = inCh.length ? inCh[Math.floor(inCh.length / 2)] : null;
            if (ringMed != null && inMed != null) return Math.round((ringMed + inMed) / 2);
            return inMed ?? ringMed ?? 255;
        });

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
