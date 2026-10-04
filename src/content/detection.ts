// Detection client: spawns a hidden extension-origin iframe (which is allowed
// to compile wasm under OUR CSP — the host page's CSP blocks it) and talks to
// it via postMessage.
import { unpackMask } from './page-cache';
import { isDebug } from '../debug';
import { fetchWorkerToken } from './worker-token';
import { canvasJpegB64 } from './encode';
import type { PageTimer } from '../page-timing';
import { sendToBackground } from '../bg-rpc';
import { recordChapterLog } from '../chapter/log-store';
import { chapterLogError, type ChapterTrace } from '../chapter/log';

export interface DetBox {
    x1: number; y1: number; x2: number; y2: number;
    conf: number;
    // Split children only: the side of the cut this child owns. The render's flood-fill area
    // finder can cross into a sibling region through an outline hole — the area bbox then spans
    // both regions and the text lays out across them. The renderer clamps its fill
    // window/runs/area to this rect — on the CUT axis only (see cutAxis). Absent on unsplit boxes.
    clip?: { x1: number; y1: number; x2: number; y2: number };
    // Which axis the parent was cut along ('y' = siblings stacked vertically). The renderer
    // clamps the clip on this axis only; the cross axis stays free so the flood can still reach
    // the bubble's own walls — clamping both traps children inside the parent's box.
    cutAxis?: 'x' | 'y';
}

export interface DetectResult {
    boxes: DetBox[];
    // { width, height, data: ArrayBuffer } — 1 byte/pixel mask, 255 = text
    mask: { width: number; height: number; data: ArrayBuffer };
    inferMs: number;
    initMs?: number;    // one-time session cost (0/absent on reuse) — timing breakdown only
    ep: string;
    lockWaitMs?: number; // ms this page's detect runs waited on the shared ORT lock (0 = uncontended)
    cloudTexts?: string[]; // cloud path: OCR texts aligned 1:1 with boxes (raw — caller trims)
    // cloud path: server-side breakdown — detect/ocr are server inference, total is the
    // server wall clock; enc/net are client-side (JPEG encode, roundtrip minus server total)
    cloudMs?: { detect: number; ocr: number; inpaint?: number; enc?: number; net?: number; total?: number };
    // cloud path: cleanup patches computed server-side in the same /v1/page call (inpaint=1) —
    // one patch per box (full-res coords), filtered to the erase plan at render
    cloudPatches?: InpaintPatch[];
    // cloud path: the server's box-split generation (0/absent = pre-split server) — entries
    // below CLOUD_SPLIT_GEN re-detect instead of rendering fused boxes from cache
    splitGen?: number;
    panelMs?: number;   // YOLO panel infer ms (0/absent when skipped) — timing breakdown only
    panels?: DetBox[];      // YOLO panel boxes (empty when the model is missing)
    panelSkipped?: string;  // why panel ordering was skipped (strip aspect / gate) — page-result log only
    dropped?: DetBox[];     // CTD near-misses below threshold — debug overlay only
    panelDropped?: DetBox[]; // YOLO panels below threshold — debug overlay only
    // regions that keep their source text (SFX, contained dups) — inpaint must not erase
    // their glyphs while expanding a neighbour's erase region
    keepBoxes?: DetBox[];
}

// ---- strip tiling: CTD letterboxes the long side to 1024, so a long strip feeds the model
// ~3px-tall text (nothing detects that). Split extreme-aspect pages into overlapping
// near-natural-scale tiles, detect per tile, merge. Pure geometry — unit tested.

export const STRIP_ASPECT = 3;   // above this (either axis) a page is a strip
export const TILE_SIZE = 1200;   // tile long-side target at natural scale
export const TILE_OVERLAP = 180; // must exceed max dialogue line height (~80px)

export interface Tile { x0: number; y0: number; w: number; h: number }

// [] when the page isn't a strip — the caller runs the single-pass path.
export function splitTiles(w: number, h: number): Tile[] {
    const vertical = h >= w;
    const long = vertical ? h : w;
    const short = vertical ? w : h;
    if (long / short <= STRIP_ASPECT) return [];
    const step = TILE_SIZE - TILE_OVERLAP;
    const n = Math.max(2, Math.ceil((long - TILE_OVERLAP) / step));
    // distribute evenly so the last tile ends exactly at the edge (no sliver)
    const len = (long + (n - 1) * TILE_OVERLAP) / n;
    const out: Tile[] = [];
    for (let i = 0; i < n; i++) {
        const o = Math.round(i * (len - TILE_OVERLAP));
        out.push(vertical
            ? { x0: 0, y0: o, w, h: Math.round(len) }
            : { x0: o, y0: 0, w: Math.round(len), h });
    }
    return out;
}

// Merge per-tile boxes (tile coords) into page coords. Two rules, in order:
// 1. seam-union: boxes from DIFFERENT tiles that touch across a seam (gap ≤ 8px) with
//    x/y-overlap ≥50% of the smaller side union into one — a seam-cut text is fully visible
//    in the neighbor tile, so the pair is one text, never two. Fixpoint (giant SFX can span tiles).
// 2. same-tile overlaps are NOT touched — worker-side NMS owns those.
// Returns page-coord boxes; confidences ride along (max on union).
export function mergeTileBoxes(tiled: { tile: Tile; boxes: DetBox[] }[]): DetBox[] {
    type T = DetBox & { ti: number };
    const all: T[] = tiled.flatMap((t, ti) => t.boxes.map(b => ({
        x1: b.x1 + t.tile.x0, y1: b.y1 + t.tile.y0,
        x2: b.x2 + t.tile.x0, y2: b.y2 + t.tile.y0,
        conf: b.conf, ti,
    })));
    let changed = true;
    while (changed) {
        changed = false;
        outer: for (let i = 0; i < all.length; i++) {
            for (let j = i + 1; j < all.length; j++) {
                const a = all[i], b = all[j];
                if (a.ti === b.ti) continue;
                const gx = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
                const gy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
                const gapX = Math.max(a.x1 - b.x2, b.x1 - a.x2, 0);
                const gapY = Math.max(a.y1 - b.y2, b.y1 - a.y2, 0);
                const touch = (gx > 0 || gapX <= 8) && (gy > 0 || gapY <= 8);
                if (!touch) continue;
                const overlapSpan = Math.max(gx, gy);
                const minSide = Math.min(a.x2 - a.x1, a.y2 - a.y1, b.x2 - b.x1, b.y2 - b.y1);
                if (overlapSpan < 0.5 * minSide) continue;
                all[i] = {
                    x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
                    x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2),
                    conf: Math.max(a.conf, b.conf), ti: a.ti,
                };
                all.splice(j, 1);
                changed = true;
                break outer;
            }
        }
    }
    return all.map(({ x1, y1, x2, y2, conf }) => ({ x1, y1, x2, y2, conf }));
}

// CTD sometimes puts ONE box over two balloons whose text clusters sit close in its
// receptive field — the text mask still separates them: clusters divided by a gap the
// same-block merge (worker GAP) would never bridge are two regions. Split at each qualifying
// gap so every balloon gets its own crop, translation and render area. Two lanes: lane 1
// (diagonal balloons, wide gaps) needs BOTH a gap multiple and cross-axis disjointness; lane 2
// (tightly packed balloons and slash-separated caption blocks) cuts on cluster evidence with
// a glyph-scaled floor — see splitBoxLane2. Children of either lane are the cluster extents
// padded by half the adjacent gap and clamped to the parent. Pure geometry — unit tested.
export const SPLIT_GAP_FACTOR = 2;  // × same-block gap — a cut is never tighter
export const SPLIT_GAP_RATIO = 0.8; // × median cluster extent along the cut axis
                                    // (line gaps run ~0.5–0.6× glyph height; a balloon boundary ≥1×)
export const SPLIT_PAD_CAP = 40;    // px — max half-gap padding of a child box
export const SPLIT2_FLOOR_RATIO = 0.5; // × median cluster minor extent (glyph size)
export const SPLIT2_FLOOR_MIN = 8;     // px — absolute floor on small pages
export const SPLIT2_OVERLAP_MAX = 0.5; // cross-span overlap / smaller span
export const SPLIT2_STRONG_FACTOR = 1.5; // × floor — cuts despite cross overlap when neither span contains the other
// Stacked twin groups: a detached FIRST group is its own text, not a paragraph fragment —
// paragraphs never start with a detached top group. Direction matters — a detached LAST group
// is the dropped-line case and stays fused. y-axis only: columns are twinCut's territory.
// The size ratio keeps stragglers fused: a small bottom group under a big top block is a
// dropped line, while comparable stacked groups are twin balloons.
export const SPLIT2_FIRST_GAP_MULT = 3; // × floor — far beyond line spacing
export const SPLIT2_FIRST_MIN_RATIO = 0.5; // second group ≥ half the first

export interface SplitComp { x1: number; y1: number; x2: number; y2: number }

// Stacked-page crops use one coordinate space; a box's ownership clip moves
// with its text rectangle, while the original per-page detection stays unchanged.
export function shiftDetectionBoxY<T extends DetBox>(box: T, offset: number): T {
    return { ...box, y1: box.y1 + offset, y2: box.y2 + offset,
        ...(box.clip ? { clip: { ...box.clip, y1: box.clip.y1 + offset, y2: box.clip.y2 + offset } } : null) };
}

// Connect original mask components, not their expanding union rectangles; empty space
// inside a group's bbox cannot recruit unrelated neighbouring text.
export function groupMaskComponents(comps: SplitComp[], gap: number): number[][] {
    const parent = comps.map((_, i) => i);
    const find = (i: number): number => {
        while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
        return i;
    };
    for (let i = 0; i < comps.length; i++) {
        const a = comps[i];
        for (let j = i + 1; j < comps.length; j++) {
            const b = comps[j];
            const unit = Math.min(a.x2 - a.x1, a.y2 - a.y1, b.x2 - b.x1, b.y2 - b.y1);
            const localGap = Math.max(gap, Math.min(gap * 2, Math.round(unit * 0.6)));
            if (a.x1 - localGap > b.x2 || b.x1 - localGap > a.x2 || a.y1 - localGap > b.y2 || b.y1 - localGap > a.y2) continue;
            parent[find(j)] = find(i);
        }
    }
    const groups = new Map<number, number[]>();
    comps.forEach((_c, i) => {
        const key = find(i);
        const group = groups.get(key);
        if (group) group.push(i); else groups.set(key, [i]);
    });
    return [...groups.values()];
}

// Mask-only regions need text evidence and bounded geometry; dense lettering is
// allowed, while solid fills, dust and page-sized components are not.
export function maskComponentEligible(c: SplitComp & { count: number; probSum: number }, pageArea: number, boxConfidence: number): boolean {
    const bw = c.x2 - c.x1, bh = c.y2 - c.y1;
    const fill = c.count / (bw * bh);
    return bw >= 14 && bh >= 14 && fill >= 0.02 && fill <= 0.9 && bw * bh <= 0.2 * pageArea
        && (c.probSum / c.count >= 0.75 || boxConfidence >= 0.20);
}

// A corroborating head box may include faint leading/trailing glyphs missed by
// the mask. Only similarly sized, strongly overlapping candidates can extend it.
export function extendMaskBox(c: SplitComp, candidates: DetBox[], overlapsBox: (r: SplitComp) => boolean): SplitComp {
    const area = (c.x2 - c.x1) * (c.y2 - c.y1);
    let best: DetBox | undefined, score = 0;
    for (const b of candidates) {
        const bArea = (b.x2 - b.x1) * (b.y2 - b.y1);
        if (b.conf < 0.20 || !(bArea > 0) || bArea > area * 2.5) continue;
        const inter = Math.max(0, Math.min(c.x2, b.x2) - Math.max(c.x1, b.x1))
            * Math.max(0, Math.min(c.y2, b.y2) - Math.max(c.y1, b.y1));
        if (inter < area * 0.8) continue;
        if (bArea > score) { best = b; score = bArea; }
    }
    if (!best) return c;
    const pad = Math.min(4, Math.round(Math.min(c.x2 - c.x1, c.y2 - c.y1) * 0.15));
    const r = { x1: Math.min(c.x1, best.x1 - pad), y1: Math.min(c.y1, best.y1 - pad),
        x2: Math.max(c.x2, best.x2 + pad), y2: Math.max(c.y2, best.y2 + pad) };
    return overlapsBox(r) ? c : r;
}

// Split-input comps carry their mask mass; mask-only groups aggregate it.
export interface GroupComp extends SplitComp { count: number; probSum: number; ids: number[] }

// A merged mask group can chain an uncorroborated tail (SFX strokes, artwork marks) onto
// model-corroborated text. When every uncorroborated cluster fails eligibility on its own
// and the corroborated clusters pass, the corroborated clusters are the real text — emit them
// and drop the tail. Any other mixture keeps the whole group, so a genuine second text mass
// is never split away. A LONE corroborated component never strands the rest of its group:
// stripping a pair of sound effects down to one would delete a real translation (fail-safe:
// keep the group whole unless the corroborated core is itself a text mass of ≥2 components).
// Pure — unit tested.
export function corroboratedCore(
    members: GroupComp[],
    corr: boolean[],
    gap: number,
    eligible: (c: GroupComp) => boolean,
): GroupComp[] | null {
    const corrMembers = members.filter((_c, i) => corr[i]);
    const uncorrMembers = members.filter((_c, i) => !corr[i]);
    if (!corrMembers.length || !uncorrMembers.length) return null;
    const aggregate = (ss: GroupComp[]): GroupComp => ({
        x1: Math.min(...ss.map(c => c.x1)), y1: Math.min(...ss.map(c => c.y1)),
        x2: Math.max(...ss.map(c => c.x2)), y2: Math.max(...ss.map(c => c.y2)),
        count: ss.reduce((n, c) => n + c.count, 0), probSum: ss.reduce((n, c) => n + c.probSum, 0),
        ids: ss.flatMap(c => c.ids),
    });
    const clusters = (ss: GroupComp[]) =>
        groupMaskComponents(ss, gap).map(idx => aggregate(idx.map(i => ss[i])));
    if (clusters(uncorrMembers).some(eligible)) return null;
    const corrIdx = groupMaskComponents(corrMembers, gap);
    const core = corrIdx.filter(idx => eligible(aggregate(idx.map(i => corrMembers[i])))).map(idx => aggregate(idx.map(i => corrMembers[i])));
    if (!core.length) return null;
    if (corrIdx.reduce((n, idx) => n + idx.length, 0) < 2) return null;
    return core;
}

// A stray tall effect stroke drawn against a bubble merges its bbox into the group; the
// region then crops/erases/paints over the artwork and the translation overflows. When a
// group's members contain a text line (>=3 similarly sized comps whose stacking spans
// overlap) plus at least one much taller member, that line is the text. Pure — unit tested.
export const LINE_FAMILY_RATIO = 1.5;   // heights within this × are one line's glyphs
export const LINE_OUTLIER_FACTOR = 1.6; // outlier height ≥ this × the line's tallest glyph
export function lineOutlierSplit<T extends SplitComp>(members: T[]): { line: T[]; rest: T[] } | null {
    if (members.length < 4) return null;
    const h = (c: T) => c.y2 - c.y1 + 1;
    const idx = members.map((_, i) => i).sort((a, b) => h(members[a]) - h(members[b]));
    let best: number[] = [];
    for (let a = 0; a < idx.length; a++) {
        for (let b = a; b < idx.length; b++) {
            if (h(members[idx[b]]) > LINE_FAMILY_RATIO * h(members[idx[a]])) break;
            if (b - a + 1 > best.length) best = idx.slice(a, b + 1);
        }
    }
    if (best.length < 3) return null;
    const line = best.map(i => members[i]);
    const sorted = [...line].sort((a, b) => a.y1 - b.y1);
    let reach = sorted[0].y2;
    for (const c of sorted.slice(1)) {
        if (c.y1 > reach) return null; // stacked lines of similar size, not one line
        reach = Math.max(reach, c.y2);
    }
    const rest = members.filter((_c, i) => !best.includes(i));
    if (!rest.length) return null;
    const tallest = Math.max(...line.map(h));
    if (!rest.some(c => h(c) >= LINE_OUTLIER_FACTOR * tallest)) return null;
    return { line, rest };
}

export function splitMergedBoxes<T extends DetBox>(boxes: T[], comps: SplitComp[], sameBlockGap: number, boxComps: SplitComp[] = comps): T[] {
    if (comps.length < 2) return [...boxes];
    const out: T[] = [];
    for (const b of boxes) {
        const cs = comps.filter(c =>
            (c.x1 + c.x2) / 2 >= b.x1 && (c.x1 + c.x2) / 2 <= b.x2 &&
            (c.y1 + c.y2) / 2 >= b.y1 && (c.y1 + c.y2) / 2 <= b.y2);
        // Strict set (higher text likelihood): the cut evidence may include a texture false
        // positive (the box head corroborates it), but the child BOX must hug the text.
        const bs = boxComps === comps ? cs : boxComps.filter(c =>
            (c.x1 + c.x2) / 2 >= b.x1 && (c.x1 + c.x2) / 2 <= b.x2 &&
            (c.y1 + c.y2) / 2 >= b.y1 && (c.y1 + c.y2) / 2 <= b.y2);
        const parts = splitBox(b, cs, sameBlockGap, bs);
        out.push(...(parts ?? [b]));
    }
    return out;
}

type SplitGroup = { x1: number; y1: number; x2: number; y2: number };

// children = group extents padded by half the adjacent gap, clamped to the parent box
// (siblings then never overlap on the cut axis). Each child also gets a `clip` = its own side
// of the cut axis (slack on the cut side so the child's outline stays reachable): the render's
// fill flood may cross into a sibling region through an outline hole and lay the text out over
// both. Pure.
export const SPLIT_CLIP_SLACK = 12; // px — max leash past the cut toward the sibling
// How far a loose cluster may sit from the strict text core and still extend the child box
// (see emitSplit). Strict-only boxes drift sideways when soft glyph edges fall below the
// strict probability; 16px re-admits them while a distant texture patch stays out.
export const SPLIT_CORE_LEASH = 16; // px
function emitSplit<T extends DetBox>(box: T, groups: SplitGroup[], axis: 'x' | 'y', loose: SplitComp[], boxComps: SplitComp[]): T[] {
    const lo = (g: SplitGroup) => (axis === 'y' ? g.y1 : g.x1);
    const hi = (g: SplitGroup) => (axis === 'y' ? g.y2 : g.x2);
    const gapBefore = (i: number) => i <= 0 || i >= groups.length
        ? Infinity : lo(groups[i]) - hi(groups[i - 1]);
    const cuts = groups.slice(1).map((g, i) => {
        const gap = lo(g) - hi(groups[i]);
        return { at: (hi(groups[i]) + lo(g)) / 2, slack: Math.min(SPLIT_CLIP_SLACK, Math.max(4, Math.floor(gap / 2))) };
    });
    return groups.map((g, i) => {
        // Pad faces only the CUT (the sibling side): half the gap we split in, capped.
        // Padding the cross axis too dragged the box to the parent's edge — asymmetric on
        // whichever side the clamp bit.
        const padTo = (gap: number) => gap > 0 && Number.isFinite(gap) ? Math.min(SPLIT_PAD_CAP, Math.floor(gap / 2)) : 0;
        const padBefore = padTo(gapBefore(i));
        const padAfter = padTo(gapBefore(i + 1));
        // Child box = the group's text clusters, seeded by the strict comps so a corroborated
        // texture patch stays out, but not limited to them: soft glyph edges drop out of the
        // strict set and a strict-only box (plus the layout area it floors) drifts sideways off
        // the balloon's text block. Keep every loose comp within SPLIT_CORE_LEASH of the strict
        // core; cut positions, pads and clips still come from the loose groups. Fall back to the
        // whole group bbox when the strict set is empty here.
        const inGroup = (c: SplitComp) =>
            (c.x1 + c.x2) / 2 >= g.x1 && (c.x1 + c.x2) / 2 <= g.x2 &&
            (c.y1 + c.y2) / 2 >= g.y1 && (c.y1 + c.y2) / 2 <= g.y2;
        const own = boxComps.filter(inGroup);
        let ext = g;
        if (own.length) {
            const core = {
                x1: Math.min(...own.map(c => c.x1)), y1: Math.min(...own.map(c => c.y1)),
                x2: Math.max(...own.map(c => c.x2)), y2: Math.max(...own.map(c => c.y2)),
            };
            const near = loose.filter(c => inGroup(c) &&
                c.x1 <= core.x2 + SPLIT_CORE_LEASH && c.x2 >= core.x1 - SPLIT_CORE_LEASH &&
                c.y1 <= core.y2 + SPLIT_CORE_LEASH && c.y2 >= core.y1 - SPLIT_CORE_LEASH);
            if (near.length) {
                ext = {
                    x1: Math.min(...near.map(c => c.x1)), y1: Math.min(...near.map(c => c.y1)),
                    x2: Math.max(...near.map(c => c.x2)), y2: Math.max(...near.map(c => c.y2)),
                };
            }
        }
        const clip = { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 };
        const before = i > 0 ? cuts[i - 1] : null;
        const after = i < groups.length - 1 ? cuts[i] : null;
        if (axis === 'y') {
            if (before) clip.y1 = Math.round(before.at - before.slack);
            if (after) clip.y2 = Math.round(after.at + after.slack);
        } else {
            if (before) clip.x1 = Math.round(before.at - before.slack);
            if (after) clip.x2 = Math.round(after.at + after.slack);
        }
        // Siblings never cross the cut: pads face the cut but a strict-core recovery can pull an
        // edge past it, and overlapping siblings disable the dividerClips safety net (overlapping
        // boxes are read as one text mass and skipped) — a longer translation could then paint
        // into the shared strip. Clips (with their slack) still own the paint.
        const r = axis === 'y'
            ? { x1: Math.max(box.x1, ext.x1), y1: Math.max(box.y1, ext.y1 - padBefore), x2: Math.min(box.x2, ext.x2), y2: Math.min(box.y2, ext.y2 + padAfter) }
            : { x1: Math.max(box.x1, ext.x1 - padBefore), y1: Math.max(box.y1, ext.y1), x2: Math.min(box.x2, ext.x2 + padAfter), y2: Math.min(box.y2, ext.y2) };
        if (axis === 'y') {
            if (before) r.y1 = Math.max(r.y1, Math.round(before.at));
            if (after) r.y2 = Math.min(r.y2, Math.round(after.at));
        } else {
            if (before) r.x1 = Math.max(r.x1, Math.round(before.at));
            if (after) r.x2 = Math.min(r.x2, Math.round(after.at));
        }
        return { ...box, ...r, clip, cutAxis: axis };
    });
}

// null = no axis has a qualifying gap; otherwise that axis' children in order.
// y first (horizontal text), x second (vertical columns) — one axis per box,
// a child is never re-split.
function splitBox<T extends DetBox>(box: T, cs: SplitComp[], sameBlockGap: number, boxComps: SplitComp[]): T[] | null {
    if (cs.length < 2) return null;
    return splitBoxLane1(box, cs, sameBlockGap, boxComps) ?? splitBoxLane2(box, cs, boxComps, sameBlockGap) ?? splitTwinCut(box, cs, boxComps) ?? splitOverhangColumns(box, cs, boxComps);
}

// Twin-balloon cut: a straight ink-free avenue across the box with wide multi-row text on
// both sides splits, whatever the gap width. The avenue must be crossed by ZERO comps — a word
// gap always has another line's comps crossing it, and a headline spanning both columns unites
// the block. Sides need ≥2 WIDE comps — wider than tall and at least TWIN_WIDE_GLYPHS glyph
// units long, so per-glyph vertical text cannot pass — spanning at least two glyph heights.
// x-axis only: stacked blocks are lane 2's territory.
// Pure — unit tested.
export const TWIN_GUTTER_MIN = 4; // px — dust margin on the avenue
export const TWIN_SIDE_MIN = 2;   // wide comps per side
export const TWIN_SPAN_MIN = 16;  // px — noise floor for multi-row support
export const TWIN_SPAN_FACTOR = 2; // × median wide-component height
// A per-glyph text mask (large vertical type) yields ~square single-glyph comps; w>h alone
// then passes half of them by a pixel and fakes multi-row text. A real word/line run spans
// at least this many glyph units horizontally.
export const TWIN_WIDE_GLYPHS = 1.5;
// × glyph height — two comps whose row centers sit closer than this share a text
// line: a cut between them slices the line instead of separating columns/blocks.
export const OVERHANG_ROW_ALIGN = 0.1;
// Median minor extent = one glyph unit.
function medianMinor(rs: SplitComp[]): number {
    const d = rs.map(c => Math.min(c.x2 - c.x1, c.y2 - c.y1)).sort((a, b) => a - b);
    return d[Math.floor(d.length / 2)];
}
function splitTwinCut<T extends DetBox>(box: T, cs: SplitComp[], boxComps: SplitComp[]): T[] | null {
    const unit = medianMinor(cs);
    const wide = (ss: SplitComp[]) => ss.filter(c => c.x2 - c.x1 > c.y2 - c.y1 && c.x2 - c.x1 >= TWIN_WIDE_GLYPHS * unit);
    // clamp to the box, then sweep for avenues no comp crosses (closes sort before opens at
    // ties, so touching comps leave no avenue)
    const cl = cs.map(c => ({ ...c, x1: Math.max(c.x1, box.x1), x2: Math.min(c.x2, box.x2) }));
    const edges: { x: number; open: boolean }[] = [];
    for (const c of cl) {
        if (c.x2 <= c.x1) continue;
        edges.push({ x: c.x1, open: true }, { x: c.x2, open: false });
    }
    edges.sort((p, q) => p.x - q.x || (p.open ? 1 : -1));
    const ivs: { a: number; b: number }[] = [];
    let depth = 0, start = box.x1;
    for (const e of edges) {
        if (e.x < box.x1 || e.x > box.x2) continue;
        if (e.open) {
            if (depth === 0 && e.x - start >= TWIN_GUTTER_MIN) ivs.push({ a: start, b: e.x });
            depth++;
        } else {
            depth--;
            if (depth === 0) start = e.x;
        }
    }
    if (depth === 0 && box.x2 - start >= TWIN_GUTTER_MIN) ivs.push({ a: start, b: box.x2 });
    for (const iv of ivs) {
        const mid = (iv.a + iv.b) / 2;
        const left = cl.filter(c => c.x2 <= mid);
        const right = cl.filter(c => c.x1 >= mid);
        const L = wide(left), R = wide(right);
        if (L.length < TWIN_SIDE_MIN || R.length < TWIN_SIDE_MIN) continue;
        const span = (ss: SplitComp[]) => Math.max(...ss.map(c => c.y2)) - Math.min(...ss.map(c => c.y1));
        const heights = [...L, ...R].map(c => c.y2 - c.y1).sort((a, b) => a - b);
        const minSpan = Math.max(TWIN_SPAN_MIN, TWIN_SPAN_FACTOR * heights[Math.floor(heights.length / 2)]);
        if (span(L) < minSpan || span(R) < minSpan) continue;
        const boxOf = (ss: SplitComp[]) => ({
            x1: Math.min(...ss.map(c => c.x1)), y1: Math.min(...ss.map(c => c.y1)),
            x2: Math.max(...ss.map(c => c.x2)), y2: Math.max(...ss.map(c => c.y2)),
        });
        return emitSplit(box, [boxOf(left), boxOf(right)], 'x', cs, boxComps);
    }
    return null;
}

// Multi-row columns may overlap by a glyph fringe; a spanning line must still veto
// the cut. Each side owns its full component extents, including narrow punctuation.
// A cut is only a boundary when no text row crosses it: comps that share a row and
// sit within a glyph of each other are neighbouring words of one line.
function splitOverhangColumns<T extends DetBox>(box: T, cs: SplitComp[], boxComps: SplitComp[]): T[] | null {
    const glyph = medianMinor(cs);
    const wide = (ss: SplitComp[]) => ss.filter(c => c.x2 - c.x1 > c.y2 - c.y1 && c.x2 - c.x1 >= TWIN_WIDE_GLYPHS * glyph);
    const ws = wide(cs);
    if (ws.length < TWIN_SIDE_MIN * 2) return null;
    const dims = ws.map(c => Math.min(c.x2 - c.x1, c.y2 - c.y1)).sort((a, b) => a - b);
    const unit = dims[Math.floor(dims.length / 2)];
    const sorted = [...cs].sort((a, b) => a.x1 + a.x2 - b.x1 - b.x2);
    const bounds = (ss: SplitComp[]): SplitGroup => ({
        x1: Math.min(...ss.map(c => c.x1)), y1: Math.min(...ss.map(c => c.y1)),
        x2: Math.max(...ss.map(c => c.x2)), y2: Math.max(...ss.map(c => c.y2)),
    });
    const crossRow = (a: SplitComp, b: SplitComp) => {
        const minH = Math.min(a.y2 - a.y1, b.y2 - b.y1);
        return Math.abs((a.y1 + a.y2) / 2 - (b.y1 + b.y2) / 2) <= OVERHANG_ROW_ALIGN * minH
            && b.x1 - a.x2 <= glyph;
    };
    for (let i = 1; i < sorted.length; i++) {
        const left = sorted.slice(0, i), right = sorted.slice(i);
        if (wide(left).length < TWIN_SIDE_MIN || wide(right).length < TWIN_SIDE_MIN) continue;
        const l = bounds(left), r = bounds(right);
        const gap = r.x1 - l.x2;
        if (gap < -unit * 0.35 || gap >= TWIN_GUTTER_MIN) continue;
        if (left.some(a => right.some(b => crossRow(a, b)))) continue;
        const span = Math.max(TWIN_SPAN_MIN, unit * TWIN_SPAN_FACTOR);
        if (l.y2 - l.y1 < span || r.y2 - r.y1 < span) continue;
        return emitSplit(box, [l, r], 'x', cs, boxComps);
    }
    return null;
}

function splitBoxLane1<T extends DetBox>(box: T, cs: SplitComp[], sameBlockGap: number, boxComps: SplitComp[]): T[] | null {
    for (const axis of ['y', 'x'] as const) {
        const lo = (c: SplitComp) => (axis === 'y' ? c.y1 : c.x1);
        const hi = (c: SplitComp) => (axis === 'y' ? c.y2 : c.x2);
        const cLo = (c: SplitComp) => (axis === 'y' ? c.x1 : c.y1);
        const cHi = (c: SplitComp) => (axis === 'y' ? c.x2 : c.y2);
        const sorted = [...cs].sort((a, b) => lo(a) - lo(b));
        const exts = sorted.map(c => hi(c) - lo(c)).sort((a, b) => a - b);
        const thr = Math.max(SPLIT_GAP_FACTOR * sameBlockGap, SPLIT_GAP_RATIO * exts[Math.floor(exts.length / 2)]);
        // cluster runs: gap measured from the running max, so words on one line / columns of
        // vertical text (overlapping on the axis) never cut
        type Group = { x1: number; y1: number; x2: number; y2: number };
        const groups: Group[] = [];
        for (const c of sorted) {
            const g = groups[groups.length - 1];
            const gap = g ? lo(c) - (axis === 'y' ? g.y2 : g.x2) : 0;
            if (g && gap >= thr) groups.push({ x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 });
            else if (g) {
                g.x1 = Math.min(g.x1, c.x1); g.y1 = Math.min(g.y1, c.y1);
                g.x2 = Math.max(g.x2, c.x2); g.y2 = Math.max(g.y2, c.y2);
            } else {
                groups.push({ x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 });
            }
        }
        if (groups.length < 2) continue;
        // Two runs sharing cross-axis space are one text block: a paragraph's lines share a
        // span, and a partially-dropped mask invents fake gaps inside it. Only diagonal runs split.
        for (;;) {
            const k = groups.findIndex((g, i) => i + 1 < groups.length && Math.min(cHi(g), cHi(groups[i + 1])) > Math.max(cLo(g), cLo(groups[i + 1])));
            if (k < 0) break;
            const b = groups[k + 1];
            groups[k] = {
                x1: Math.min(groups[k].x1, b.x1), y1: Math.min(groups[k].y1, b.y1),
                x2: Math.max(groups[k].x2, b.x2), y2: Math.max(groups[k].y2, b.y2),
            };
            groups.splice(k + 1, 1);
        }
        if (groups.length < 2) continue;
        return emitSplit(box, groups, axis, cs, boxComps);
    }
    return null;
}

// Lane 2: same two-balloon problem on tightly packed pages — clusters sit ~15–40px apart
// (under lane 1's gap floor) and side-by-side balloons share cross-axis space, so lane 1's
// disjointness guard rejects them too. Cut on cluster evidence: the floor gap scales with the
// box's glyph size (median cluster minor extent) and a cut needs EITHER strongly disjoint cross
// spans OR 1.5 times the floor with the cross spans not nested in each other. The nested guard keeps
// a paragraph's separated last line fused while the caption-block case passes. Same-span lines
// of one block merge through the overlap ratio. Cross spans come from the strict text core plus
// its glyph leash, so a weak comp cannot fake the nesting. Pure — unit tested.
function splitBoxLane2<T extends DetBox>(box: T, cs: SplitComp[], boxComps: SplitComp[], strayGap: number): T[] | null {
    if (cs.length < 2) return null;
    const unit = medianMinor(cs);
    const floor = Math.max(SPLIT2_FLOOR_MIN, Math.round(SPLIT2_FLOOR_RATIO * unit));
    // Cross-axis evidence reads the strict text core plus loose comps within the
    // same glyph leash emitSplit gives child boxes: a weak comp (corroborated texture,
    // a hand-drawn mark) far from any text must not stretch a group across a sibling
    // block and veto the cut through nesting — see the live vertical-twin case.
    const isStrict = (c: SplitComp) => boxComps.some(k => k.x1 === c.x1 && k.y1 === c.y1 && k.x2 === c.x2 && k.y2 === c.y2);
    const crossSpan = (g: SplitGroup, axis: 'y' | 'x'): { lo: number; hi: number } => {
        const inBox = (c: SplitComp) =>
            (c.x1 + c.x2) / 2 >= g.x1 && (c.x1 + c.x2) / 2 <= g.x2 &&
            (c.y1 + c.y2) / 2 >= g.y1 && (c.y1 + c.y2) / 2 <= g.y2;
        let own = boxComps.filter(inBox);
        // A stray strict comp far from the group's text block (a murmur on the skin, a detached
        // label) must not stretch the cross span and veto a real cut through overlap. The span
        // reads the group's largest strict cluster at the same gap the mask grouping uses;
        // in-block line spacing sits far below that gap, so a block never fragments.
        if (own.length > 1) {
            const clusters = groupMaskComponents(own, Math.max(floor, strayGap));
            let best: SplitComp[] = own, bestArea = -1;
            for (const idx of clusters) {
                const part = idx.map(i => own[i]);
                const area = part.reduce((n, c) => n + (c.x2 - c.x1) * (c.y2 - c.y1), 0);
                if (area > bestArea) { bestArea = area; best = part; }
            }
            own = best;
        }
        let ss: SplitComp[] = own;
        if (own.length) {
            const core = {
                x1: Math.min(...own.map(c => c.x1)), y1: Math.min(...own.map(c => c.y1)),
                x2: Math.max(...own.map(c => c.x2)), y2: Math.max(...own.map(c => c.y2)),
            };
            ss = cs.filter(c => inBox(c) &&
                c.x1 <= core.x2 + SPLIT_CORE_LEASH && c.x2 >= core.x1 - SPLIT_CORE_LEASH &&
                c.y1 <= core.y2 + SPLIT_CORE_LEASH && c.y2 >= core.y1 - SPLIT_CORE_LEASH);
        }
        if (!ss.length) ss = [g];
        return axis === 'y'
            ? { lo: Math.min(...ss.map(c => c.x1)), hi: Math.max(...ss.map(c => c.x2)) }
            : { lo: Math.min(...ss.map(c => c.y1)), hi: Math.max(...ss.map(c => c.y2)) };
    };
    for (const axis of ['y', 'x'] as const) {
        const lo = (g: SplitGroup) => (axis === 'y' ? g.y1 : g.x1);
        const hi = (g: SplitGroup) => (axis === 'y' ? g.y2 : g.x2);
        const sorted = [...cs].sort((a, b) => lo(a) - lo(b));
        const groups: (SplitGroup & { strict: boolean })[] = [];
        for (const c of sorted) {
            const g = groups[groups.length - 1];
            const gap = g ? lo(c) - hi(g) : 0;
            const strict = isStrict(c);
            // A sub-floor gap between strict text masses that share no cross-axis space is
            // a balloon boundary (diagonal lobes, tight vertical-text clusters), not line
            // spacing; weak-only clusters stay fused with their neighbour.
            const apart = !!g && gap >= 0 && g.strict && strict
                && Math.min(axis === 'y' ? c.x2 : c.y2, axis === 'y' ? g.x2 : g.y2)
                - Math.max(axis === 'y' ? c.x1 : c.y1, axis === 'y' ? g.x1 : g.y1) <= 0;
            if (g && (gap >= floor || apart)) groups.push({ ...c, strict });
            else if (g) {
                g.x1 = Math.min(g.x1, c.x1); g.y1 = Math.min(g.y1, c.y1);
                g.x2 = Math.max(g.x2, c.x2); g.y2 = Math.max(g.y2, c.y2);
                g.strict = g.strict || strict;
            } else {
                groups.push({ ...c, strict });
            }
        }
        if (groups.length < 2) continue;
        const merged: SplitGroup[] = [groups[0]];
        for (let i = 1; i < groups.length; i++) {
            const prev = merged[merged.length - 1], g = groups[i];
            const gap = lo(g) - hi(prev);
            const sp = crossSpan(prev, axis), sg = crossSpan(g, axis);
            const ov = Math.min(sp.hi, sg.hi) - Math.max(sp.lo, sg.lo);
            const ratio = ov <= 0 ? 0 : ov / Math.min(sp.hi - sp.lo, sg.hi - sg.lo);
            const nested = (sp.lo >= sg.lo && sp.hi <= sg.hi)
                || (sg.lo >= sp.lo && sg.hi <= sp.hi);
            const firstPair = axis === 'y' && merged.length === 1 && i === 1
                && nested && gap >= SPLIT2_FIRST_GAP_MULT * floor
                && hi(g) - lo(g) >= (hi(prev) - lo(prev)) * SPLIT2_FIRST_MIN_RATIO;
            if ((gap >= floor && (ratio < SPLIT2_OVERLAP_MAX
                || (gap >= SPLIT2_STRONG_FACTOR * floor && !nested)
                || firstPair))
                || (gap < floor && ov <= 0)) {
                merged.push(g);
            } else {
                prev.x1 = Math.min(prev.x1, g.x1); prev.y1 = Math.min(prev.y1, g.y1);
                prev.x2 = Math.max(prev.x2, g.x2); prev.y2 = Math.max(prev.y2, g.y2);
            }
        }
        if (merged.length >= 2) return emitSplit(box, merged, axis, cs, boxComps);
    }
    return null;
}

// Pass-3 rescue for mask-component pipelines (see worker runDetect): a merged comp killed
// ONLY by the overlap gate may still hold a text group outside every kept box. Split it with
// the lane machinery on the raw texty comps and re-gate each piece: pieces outside all boxes
// survive as their own regions (clips stripped — fresh regions, adjacency is the divider's job).
// Pure.
export interface RescueCounts { count: number; probSum: number }
export function rescueSplitComp(
    c: SplitComp,
    texty: SplitComp[], strict: SplitComp[], sameBlockGap: number, pageArea: number,
    countIn: (x1: number, y1: number, x2: number, y2: number) => RescueCounts,
    overlapsBox: (r: SplitComp) => boolean,
    boxConf: (r: SplitComp) => number,
): { x1: number; y1: number; x2: number; y2: number; conf: number }[] {
    const pieces = splitMergedBoxes(
        [{ x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, conf: 0.5 }], texty, sameBlockGap, strict);
    if (pieces.length < 2) return [];
    const out: { x1: number; y1: number; x2: number; y2: number; conf: number }[] = [];
    for (const pc of pieces) {
        const bw = pc.x2 - pc.x1, bh = pc.y2 - pc.y1;
        if (bw < 14 || bh < 14 || bw * bh > 0.2 * pageArea) continue;
        const r = countIn(Math.floor(pc.x1), Math.floor(pc.y1), Math.ceil(pc.x2), Math.ceil(pc.y2));
        if (r.count / (bw * bh) < 0.02) continue;
        const m = { x1: pc.x1, y1: pc.y1, x2: pc.x2, y2: pc.y2 };
        if (overlapsBox(m)) continue;
        if (r.probSum / r.count < 0.75 && boxConf(m) < 0.20) continue;
        out.push({ x1: pc.x1, y1: pc.y1, x2: pc.x2, y2: pc.y2, conf: 0.5 });
    }
    return out;
}

// Region numbering order: the detector emits confidence order, so sort into reading order
// before anything numbers the boxes. Row bands by y-center gaps (top to bottom), x-columns
// within each band from the reading-start side. Pure geometry on the boxes — no pixels, so
// backgrounds can never fool it. Pure — unit tested.
// Flat bands, not XY-cut. Residual miss: vertically-overlapping staggered rows merge into one
// band and fall back to RTL.
export function sortReadingOrder(boxes: DetBox[], dir: 'rtl' | 'ltr', page?: { w: number; h: number }, defer = true): DetBox[] {
    return sortReadingOrderBy(boxes, b => b, dir, page, defer);
}

// Landscape content with a wide, central empty corridor reads as two side-by-side page/column groups
// (reading-start group first) — a stitched spread and side-by-side vertical text columns otherwise
// interleave rows. Two gates: page-like proportions (any box shape) or all-tall boxes (vertical text).
// No split when a box crosses the corridor, so spanning headlines and wide art keep banding. Pure.
function corridorSplit<T>(items: T[], rect: (t: T) => DetBox, dir: 'rtl' | 'ltr'): [T[], T[]] | null {
    if (items.length < 2) return null;
    const boxes = items.map(rect);
    const x1 = Math.min(...boxes.map(b => b.x1)), x2 = Math.max(...boxes.map(b => b.x2));
    const y1 = Math.min(...boxes.map(b => b.y1)), y2 = Math.max(...boxes.map(b => b.y2));
    const w = x2 - x1, h = y2 - y1;
    if (w <= 0 || h <= 0) return null;
    const widths = boxes.map(b => b.x2 - b.x1).sort((a, b) => a - b);
    const medW = widths[Math.floor(widths.length / 2)];
    const tall = boxes.every(b => b.y2 - b.y1 >= 1.2 * (b.x2 - b.x1));
    const pageLike = w >= 1.8 * h && w >= 3 * medW;
    const columns = tall && w >= 2.5 * medW;
    if (!pageLike && !columns) return null;
    const edges = [...new Set(boxes.flatMap(b => [b.x1, b.x2]))].sort((a, b) => a - b);
    let best: { L: T[]; R: T[] } | null = null, bestGap = 0;
    for (let i = 0; i + 1 < edges.length; i++) {
        const x = (edges[i] + edges[i + 1]) / 2;
        if (x < x1 + 0.3 * w || x > x1 + 0.7 * w) continue;
        const L = items.filter(t => rect(t).x2 <= x), R = items.filter(t => rect(t).x1 >= x);
        if (L.length < 2 || R.length < 2 || L.length + R.length !== items.length) continue;
        // each box must have a y-overlapping partner across the corridor: real side-by-side columns
        // share bands; a stray box far above/below the other group is not a column and must stay in flow
        const yOverlap = (a: T, b: T) => Math.min(rect(a).y2, rect(b).y2) > Math.max(rect(a).y1, rect(b).y1);
        if (!L.every(a => R.some(b => yOverlap(a, b))) || !R.every(a => L.some(b => yOverlap(a, b)))) continue;
        const gap = Math.min(x - Math.max(...L.map(t => rect(t).x2)), Math.min(...R.map(t => rect(t).x1)) - x);
        if (gap >= Math.max(0.5 * medW, 0.02 * w) && gap > bestGap) { bestGap = gap; best = { L, R }; }
    }
    if (!best) return null;
    return dir === 'rtl' ? [best.R, best.L] : [best.L, best.R]; // reading-start group first
}

// Generic core so panel rects order with the same rules as text boxes.
export function sortReadingOrderBy<T>(items: T[], rect: (t: T) => DetBox, dir: 'rtl' | 'ltr', page?: { w: number; h: number }, defer = true): T[] {
    if (items.length < 2) return [...items];
    const split = corridorSplit(items, rect, dir);
    if (split) return [...sortReadingOrderBy(split[0], rect, dir, page, defer), ...sortReadingOrderBy(split[1], rect, dir, page, defer)];
    const cy = (t: T) => (rect(t).y1 + rect(t).y2) / 2;
    const hs = items.map(t => { const r = rect(t); return r.y2 - r.y1; }).sort((a, b) => a - b);
    const gap = Math.max(1, hs[Math.floor(hs.length / 2)] * 0.5);
    const bands: T[][] = [];
    for (const t of [...items].sort((a, b) => cy(a) - cy(b))) {
        const last = bands[bands.length - 1];
        if (last && cy(t) - cy(last[last.length - 1]) <= gap) last.push(t);
        else bands.push([t]);
    }
    return bands.flatMap(band => {
        // labels sink to the band's end (stable) — never across rows, see splitDeferred
        if (!page || !defer) return sortBandBy(band, rect, dir);
        const { main, deferred } = splitDeferred(band.map(t => rect(t)), page.w, page.h);
        const back = new Map<DetBox, T>();
        band.forEach(t => back.set(rect(t), t));
        return [...sortBandBy(main.map(m => back.get(m)!), rect, dir), ...sortBandBy(deferred.map(m => back.get(m)!), rect, dir)];
    });
}

// one row band: x-overlap columns from the reading-start side, top first
function sortBandBy<T>(band: T[], rect: (t: T) => DetBox, dir: 'rtl' | 'ltr'): T[] {
    const rest = [...band];
    const cols: T[][] = [];
    while (rest.length) {
        const seed = rest.reduce((a, b) => dir === 'rtl' ? (rect(b).x2 > rect(a).x2 ? b : a) : (rect(b).x1 < rect(a).x1 ? b : a));
        const sr = rect(seed);
        const col = rest.filter(t => { const r = rect(t); return r.x1 < sr.x2 && sr.x1 < r.x2; });
        for (const b of col) rest.splice(rest.indexOf(b), 1);
        col.sort((a, b) => rect(a).y1 - rect(b).y1 || (dir === 'rtl' ? rect(b).x1 - rect(a).x1 : rect(a).x1 - rect(b).x1));
        cols.push(col);
    }
    return cols.flat();
}

// YOLO panel output [N*6]: x1,y1,x2,y2 (0-640 space), conf, class.
// class 1 (text) is skipped entirely — CTD owns text detection.
// In-graph NMS already applied — filter + scale + clamp only.
export const PANEL_CONF_THR = 0.20; // below the card's 0.25: bleed panels live at ~0.3 (probe); 0.15 admits strip FPs on art-heavy pages
const PANEL_FLOOR = 0.05; // below this the graph output is noise, not near-misses
export function parsePanelOutput(data: Float32Array | number[], w: number, h: number, thr = PANEL_CONF_THR): { panels: DetBox[]; dropped: DetBox[] } {
    const panels: DetBox[] = [];
    const dropped: DetBox[] = [];
    for (let i = 0; i + 5 < data.length; i += 6) {
        if (data[i + 5] !== 0) continue;
        const conf = data[i + 4];
        if (conf < PANEL_FLOOR) continue;
        const b = {
            x1: Math.max(0, data[i] / 640 * w), y1: Math.max(0, data[i + 1] / 640 * h),
            x2: Math.min(w, data[i + 2] / 640 * w), y2: Math.min(h, data[i + 3] / 640 * h),
            conf,
        };
        if (b.x2 <= b.x1 || b.y2 <= b.y1) continue;
        if (conf < thr) {
            if (dropped.length < 40) dropped.push(b);
            continue;
        }
        panels.push(b);
    }
    panels.sort((a, b) => ((b.x2 - b.x1) * (b.y2 - b.y1)) - ((a.x2 - a.x1) * (a.y2 - a.y1)));
    return { panels, dropped };
}

// Each box joins the smallest panel containing its center (inset beats host), else the
// nearest panel. Panels order with the same banding rules; boxes inside each panel band again.
// No panels → plain banding.
function nearestPanel(b: DetBox, panels: DetBox[]): number {
    const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
    let best = 0, bestArea = Infinity, found = false;
    panels.forEach((p, i) => {
        if (cx < p.x1 || cx > p.x2 || cy < p.y1 || cy > p.y2) return;
        const a = (p.x2 - p.x1) * (p.y2 - p.y1);
        if (a < bestArea) { bestArea = a; best = i; found = true; }
    });
    if (found) return best;
    let bd = Infinity;
    panels.forEach((p, i) => {
        const dx = Math.max(p.x1 - cx, 0, cx - p.x2);
        const dy = Math.max(p.y1 - cy, 0, cy - p.y2);
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
    });
    return best;
}

// Descriptive labels (room plates, signs) read after a panel's balloon dialogue. Proxy, not
// balloon detection — the model has no balloon class: small boxes (area < SMALL_FRAC of the
// page) clustered with another small box nearby sink to the end, stably. Isolated small boxes
// (short replies) are untouched. Replace with balloon containment if a balloon-class model lands.
const SMALL_FRAC = 0.005;
const CLUSTER_GAP_FRAC = 0.05; // of page diagonal
export function splitDeferred(boxes: DetBox[], pageW: number, pageH: number): { main: DetBox[]; deferred: DetBox[] } {
    const small = boxes.filter(b => ((b.x2 - b.x1) * (b.y2 - b.y1)) < SMALL_FRAC * pageW * pageH);
    const gapPx = CLUSTER_GAP_FRAC * Math.hypot(pageW, pageH);
    const linked = new Set<DetBox>();
    for (let i = 0; i < small.length; i++) {
        for (let j = i + 1; j < small.length; j++) {
            const a = small[i], b = small[j];
            const gx = Math.max(0, a.x1 - b.x2, b.x1 - a.x2);
            const gy = Math.max(0, a.y1 - b.y2, b.y1 - a.y2);
            if (Math.hypot(gx, gy) < gapPx) { linked.add(a); linked.add(b); }
        }
    }
    return { main: boxes.filter(b => !linked.has(b)), deferred: boxes.filter(b => linked.has(b)) };
}

// Panel sanity gate: YOLO was trained on whole pages — on extreme-aspect strips (long-strip
// or stitched pages, same thing geometrically) the 640-resize crushes what it learned and it
// returns sliver soup. Blind trust (nearestPanel) then scrambles reading order; banding is
// correct for both (pages flow top-to-bottom). Pure.
export function panelsUsable(panels: DetBox[], pageW: number, pageH: number): boolean {
    if (!panels.length) return false;
    if (panels.length > 25) return false; // no real page has 25 panels
    const area = pageW * pageH;
    const biggest = Math.max(...panels.map(p => (p.x2 - p.x1) * (p.y2 - p.y1)));
    // 10%: a normal 2×2-grid page peaks at 25%; sliver soup sits at ~1-2%
    return biggest >= 0.1 * area;
}

// Panels mostly inside another (>=70% area) read at their position INSIDE the parent's flow instead
// of as a peer group after it: YOLO merges/nests rects on real pages, and the peer model then pushes
// a nested panel's dialogue past the parent's whole group. A leaf may sink a small label cluster only
// when every cluster box is smaller than every main box; on SFX-heavy pages dialogue bubbles are not,
// so the sink that used to reorder speech after SFX is suppressed. Containers never sink (their own
// boxes interleave with child panels by position). Pure — unit tested.
const PANEL_CONTAIN_FRAC = 0.7; // of the child's area inside the candidate parent
export function orderByPanels(boxes: DetBox[], panels: DetBox[], dir: 'rtl' | 'ltr', page?: { w: number; h: number }, defer = true): DetBox[] {
    // no page dims → can't judge usability, keep the old trust-panels behavior
    if (!panels.length || (page && !panelsUsable(panels, page.w, page.h))) return sortReadingOrder(boxes, dir, page, defer);
    const area = (p: DetBox) => (p.x2 - p.x1) * (p.y2 - p.y1);
    const inter = (a: DetBox, b: DetBox) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
        * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const parent = panels.map(() => -1);
    panels.forEach((c, ci) => {
        let best = -1, bestArea = Infinity;
        panels.forEach((p, pi) => {
            if (pi === ci || inter(c, p) < PANEL_CONTAIN_FRAC * area(c)) return;
            // a container is strictly larger (ties break to the earlier index): near-duplicate YOLO
            // rects otherwise contain each other and vanish from the tree.
            const pa = area(p), ca = area(c);
            if (!(pa > ca || (pa === ca && pi < ci))) return;
            if (pa < bestArea) { bestArea = pa; best = pi; }
        });
        parent[ci] = best;
    });
    const children: number[][] = panels.map(() => []);
    const roots: number[] = [];
    panels.forEach((_, i) => (parent[i] < 0 ? roots : children[parent[i]]).push(i));
    const groups: DetBox[][] = panels.map(() => []);
    for (const b of boxes) groups[nearestPanel(b, panels)].push(b);
    type OrderItem = { rect: DetBox; box?: DetBox; child?: number };
    const expand = (order: OrderItem[]): DetBox[] => order.flatMap(t => t.box ? [t.box] : orderNode(t.child!));
    const orderNode = (i: number): DetBox[] => {
        const items: OrderItem[] = groups[i].map(b => ({ rect: b, box: b }));
        for (const c of children[i]) items.push({ rect: panels[c], child: c });
        let sink: { main: DetBox[]; deferred: DetBox[] } | null = null;
        if (page && defer && !children[i].length) {
            const split = splitDeferred(groups[i], page.w, page.h);
            if (split.deferred.length && Math.max(...split.deferred.map(area)) < Math.min(...split.main.map(area))) sink = split;
        }
        if (sink) {
            const mainSet = new Set(sink.main);
            return [...expand(sortReadingOrderBy(items.filter(t => !t.box || mainSet.has(t.box)), t => t.rect, dir, page, true)),
                ...expand(sortReadingOrderBy(items.filter(t => t.box && !mainSet.has(t.box)), t => t.rect, dir, page, true))];
        }
        return expand(sortReadingOrderBy(items, t => t.rect, dir, page, false));
    };
    return panelReadingOrder(roots.map(i => panels[i]), dir).map(k => roots[k]).flatMap(orderNode);
}

// panel indices in reading order — shared by translation ordering + debug numbers
// Panel rects are approximate: side-by-side panels overlap by a sliver of x, and a tall
// panel spans several text rows. Reading order is built for panels, not text boxes:
// vertical-overlap clusters form rows; within a row, substantially-x-overlapping panels
// form columns, right-to-left (rtl), then top-to-bottom. Pure — unit tested.
export const PANEL_ROW_OVERLAP = 0.25; // × the shorter panel's height — a row member
export const PANEL_COL_OVERLAP = 0.5;  // × the narrower panel's width — a column member
export function panelReadingOrder(panels: DetBox[], dir: 'rtl' | 'ltr'): number[] {
    if (panels.length < 2) return panels.map((_, i) => i);
    const w = (p: DetBox) => p.x2 - p.x1, h = (p: DetBox) => p.y2 - p.y1;
    const overlap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
    const cluster = (n: number, near: (i: number, j: number) => boolean): number[][] => {
        const parent = Array.from({ length: n }, (_, i) => i);
        const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (near(i, j)) parent[find(j)] = find(i);
        const groups = new Map<number, number[]>();
        for (let i = 0; i < n; i++) { const k = find(i); const g = groups.get(k); if (g) g.push(i); else groups.set(k, [i]); }
        return [...groups.values()];
    };
    const rows = cluster(panels.length, (i, j) => {
        const a = panels[i], b = panels[j];
        return overlap(a.y1, a.y2, b.y1, b.y2) >= PANEL_ROW_OVERLAP * Math.min(h(a), h(b));
    });
    const columnsOf = (row: number[]) => cluster(row.length, (i, j) => {
        const a = panels[row[i]], b = panels[row[j]];
        return overlap(a.x1, a.x2, b.x1, b.x2) >= PANEL_COL_OVERLAP * Math.min(w(a), w(b));
    }).map(g => g.map(i => row[i]));
    const top = (g: number[]) => Math.min(...g.map(i => panels[i].y1));
    const right = (g: number[]) => Math.max(...g.map(i => panels[i].x2));
    const left = (g: number[]) => Math.min(...g.map(i => panels[i].x1));
    return rows
        .map(g => (dir === 'rtl' ? columnsOf(g).sort((a, b) => right(b) - right(a)) : columnsOf(g).sort((a, b) => left(a) - left(b))))
        .sort((a, b) => top(a.flat()) - top(b.flat()))
        .flatMap(cols => cols.flatMap(col => col.sort((i, j) => panels[i].y1 - panels[j].y1)));
}

let iframe: HTMLIFrameElement | null = null;
let ready = false;
// per-iframe auth token (see worker.ts handshake) — the page shares our
// postMessage origin, so without this any site JS could drive the worker
let workerToken: string | null = null;
const pending = new Map<number, { resolve: (r: DetectResult) => void; reject: (e: Error) => void }>();
let nextId = 1;
const waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
let listenerInstalled = false;

// the iframe lives in the PAGE's DOM, so the page can remove it (dead contentWindow → RPCs
// time out forever) or swap in a srcdoc document that passes a bare source check. Two guards:
// only messages from OUR extension origin count, and a detached iframe resets the handshake so
// the next call recreates it instead of dying permanently.
function iframeAlive(): boolean {
    if (iframe?.isConnected && iframe.contentWindow) return true;
    if (iframe && !iframe.isConnected) { iframe = null; ready = false; workerToken = null; }
    return false;
}

function installListener(): void {
    if (listenerInstalled) return;
    listenerInstalled = true;
    window.addEventListener('message', async (ev: MessageEvent) => {
        if (ev.source !== iframe?.contentWindow) return;
        if (ev.origin !== chrome.runtime.getURL('/').slice(0, -1)) return; // our extension origin only
        if (ev.data?.type === 'mt:ready') {
            // worker registers its token with the SW under the public nonce before signalling
            // ready — fetch it before resolving so no RPC can race the handshake. Never overwrite
            // a good token with null (a failed fetch must not poison a working handshake).
            // mt:ready is posted with '*' — the PAGE sees it and can time an iframe removal into
            // the await below. Generation guard: if this frame was torn down while we fetched,
            // its result is void.
            const fr = iframe;
            if (!fr || !fr.isConnected) return;
            const t = await fetchWorkerToken(ev.data.nonce);
            if (iframe !== fr || !fr.isConnected) return; // stale generation
            if (workerToken === null) workerToken = t;
            ready = true;
            for (const w of waiters.splice(0)) w.resolve();
        } else if (ev.data?.type === 'mt:detect-result' || ev.data?.type === 'mt:rpc-result') {
            const p = pending.get(ev.data.id);
            pending.delete(ev.data.id);
            // Firefox delivers worker replies that carried a transfer list as LIVE Xray wrappers,
            // not clones. Materialize our own realm's copy at the boundary so every downstream
            // read AND write is same-realm. On Chromium the payload is already plain — one extra
            // copy per page, negligible next to inference.
            if (ev.data.ok) {
                let out: unknown = ev.data.result ?? ev.data;
                try { out = structuredClone(out); } catch { /* keep original */ }
                p?.resolve(out as DetectResult);
            } else p?.reject(new Error(ev.data.error));
        }
    });
}

function ensureIframe(): Promise<void> {
    if (ready && iframeAlive()) return Promise.resolve();
    installListener();
    return new Promise((resolve, reject) => {
        if (!iframe) {
            iframe = document.createElement('iframe');
            iframe.src = chrome.runtime.getURL('iframe/worker.html');
            // sized (not 0×0) with opacity 0: zero-sized iframes can be throttled
            // as "not rendered", which slows the wasm OCR loops inside them
            iframe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
            document.documentElement.append(iframe);
        }
        waiters.push({ resolve, reject });
        setTimeout(() => {
            const i = waiters.findIndex(w => w.resolve === resolve);
            if (i < 0) return;
            waiters.splice(i, 1);
            // a timed-out iframe is unusable but still in the DOM: leaving it made
            // every later ensureIframe() short-circuit on the dead element and the
            // whole session detect-less. Tear it down so the next call rebuilds.
            if (iframe) { try { iframe.remove(); } catch { /* already gone */ } iframe = null; }
            ready = false;
            reject(new Error('detector iframe timeout'));
        }, 30000);
    });
}

// A worker whose startup registration was lost (service-worker hiccup during the handshake)
// leaves the token null and every inference call in this document failing until a reload.
// Rebuild the iframe so a fresh worker registers again. One rebuild per call; callers bound
// how many times they try.
async function healToken(): Promise<boolean> {
    if (workerToken !== null) return true;
    if (iframe) { try { iframe.remove(); } catch { /* already gone */ } iframe = null; }
    ready = false;
    try { await ensureIframe(); } catch { return false; }
    return workerToken !== null;
}

// pipeline stage for the status pill's stepper (typed so phases never ride inside message
// strings). Order = read → detect → ocr → llm → render.
export type MtStage = 'read' | 'detect' | 'ocr' | 'llm' | 'render';
export type MtOnStatus = (s: string, stage?: MtStage) => void;

export async function ensureDetector(onStatus?: MtOnStatus): Promise<void> {
    onStatus?.('Starting inference worker…', 'detect');
    await ensureIframe();
}

// Full-page canvas encodes are the heaviest main-thread work in a page job. Sweep/paint jobs
// run up to three at once; without this they spike together and jank the reader. No throughput
// is lost — inference itself is already serialized in the worker.
let encodeChain: Promise<unknown> = Promise.resolve();
export function withEncodeLock<T>(fn: () => Promise<T>): Promise<T> {
    const p = encodeChain.then(fn, fn);
    encodeChain = p.catch(() => { /* chain survives failures */ });
    return p;
}

export async function detect(
    img: ImageBitmap | HTMLImageElement,
    onStatus?: MtOnStatus,
    thresholds?: { confThr?: number; minSize?: number; forceWasm?: boolean; lo?: boolean },
    attempt = 0, // page can tear the iframe down on every mt:ready — cap rebuilds
): Promise<DetectResult> {
    // alive-check BEFORE the PNG encode: a hostile remove-loop must not earn a full-page
    // re-encode per cycle
    if (!iframeAlive()) await ensureIframe();
    if (workerToken === null) {
        // A lost handshake registration used to fail this page (and every later attempt in the
        // document) until a reload. Rebuild the worker once per attempt; a fresh worker
        // registers again.
        if (attempt >= 2 || !(await healToken())) throw new Error('worker auth token missing — reload the page');
        return detect(img, onStatus, thresholds, attempt + 1);
    }
    const w = 'naturalWidth' in img ? img.naturalWidth : img.width;
    const h = 'naturalHeight' in img ? img.naturalHeight : img.height;
    if (w < 10 || h < 10) throw new Error(`image too small: ${w}x${h}`);
    const png = await withEncodeLock(async () => {
        const c = new OffscreenCanvas(w, h);
        c.getContext('2d')!.drawImage(img, 0, 0);
        const blob = await c.convertToBlob({ type: 'image/png' });
        return blob.arrayBuffer();
    });

    onStatus?.('Detecting text…', 'detect');
    if (!iframeAlive()) {
        if (attempt >= 2) throw new Error('inference iframe kept being torn down — the page may be hostile');
        return detect(img, onStatus, thresholds, attempt + 1); // rebuild + bounded retry
    }
    const cw = iframe!.contentWindow;
    if (!cw) throw new Error('inference iframe unavailable');
    const id = nextId++;
    const p = new Promise<DetectResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error('detect timeout'));
            }
        }, 180000);
    });
    cw.postMessage(
        { type: 'mt:detect', id, png, confThr: thresholds?.confThr, minSize: thresholds?.minSize, forceWasm: thresholds?.forceWasm === true, lo: thresholds?.lo === true, token: workerToken },
        '*', [png],
    );
    return p;
}

// ---- OCR: Tesseract in the same iframe (lazy-loaded from CDN by the worker) ----

export async function ocrLangsInstalled(langs: string[]): Promise<string[]> {
    await ensureIframe();
    const resp = await iframeRpc({ type: 'mt:ocr-status', langs }) as { installed?: string[] };
    return resp?.installed ?? [];
}

export async function ocrInWorker(png: ArrayBuffer, langs: string[]): Promise<string> {
    await ensureIframe();
    const resp = await iframeRpc({ type: 'mt:ocr', png, langs }, [png]) as { ok: boolean; text?: string; error?: string };
    if (!resp?.ok) throw new Error(resp?.error ?? 'OCR failed');
    return (resp.text ?? '').replace(/\s+/g, ' ').trim();
}

export async function baberuInstalled(): Promise<boolean> {
    await ensureIframe();
    const resp = await iframeRpc({ type: 'mt:baberu-status' }) as { installed?: boolean };
    return !!resp?.installed;
}

// Baberu reads vertical text and dirty backgrounds natively — no rotation,
// no binarization, tighter padding than Tesseract needs
export async function baberuOcr(png: ArrayBuffer, opts?: { lo?: boolean }): Promise<{ text: string; lockWaitMs: number }> {
    await ensureIframe();
    const resp = await iframeRpc({ type: 'mt:baberu-ocr', png, lo: opts?.lo === true }, [png]) as { ok: boolean; text?: string; lockWait?: number; error?: string };
    if (!resp?.ok) throw new Error(resp?.error ?? 'Baberu OCR failed');
    return { text: (resp.text ?? '').replace(/\s+/g, ' ').trim(), lockWaitMs: resp.lockWait ?? 0 };
}

// ---- Panels: YOLO26n in the same iframe (bundled model, graceful fallback
// to banding when the file is missing) ----

export interface PanelDetectResult {
    panels: DetBox[];
    dropped: DetBox[];
    inferMs: number;
    lockWaitMs?: number; // ms the panel run waited on the shared ORT lock
}

export async function panelsDetect(img: ImageBitmap, thr: number = PANEL_CONF_THR): Promise<PanelDetectResult> {
    await ensureIframe();
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext('2d')!.drawImage(img, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const png = await blob.arrayBuffer();
    const resp = await iframeRpc({ type: 'mt:panels', png, thr }, [png]) as
        { ok: boolean; panels?: DetBox[]; dropped?: DetBox[]; ms?: number; lockWait?: number; error?: string };
    if (!resp?.ok) throw new Error(resp?.error ?? 'panel detection failed');
    return { panels: resp.panels ?? [], dropped: resp.dropped ?? [], inferMs: resp.ms ?? 0, lockWaitMs: resp.lockWait ?? 0 };
}

// ---- AI text cleanup (manga-LaMa in the iframe worker, WebGPU only) -------
// The worker windows the page per erase box and returns one PNG crop per box; callers draw
// the crops in place of the built-in fill. Boxes are the ones already expanded by eraseBox
// (mask-led walk), so clipped glyphs are covered.
export interface InpaintPatch { i?: number; x1: number; y1: number; x2: number; y2: number; png: ArrayBuffer }

export async function inpaintPage(
    bitmap: ImageBitmap, boxes: { x1: number; y1: number; x2: number; y2: number }[],
    mask: { width: number; height: number; data: ArrayBuffer | Uint8Array }, padRatio = 0.5,
    opts?: { lo?: boolean; noDownload?: boolean },
): Promise<{ patches: InpaintPatch[]; windows: number; ms: number; lockWaitMs: number; encodeMs: number }> {
    await ensureIframe();
    const tEnc = performance.now();
    const png = await withEncodeLock(async () => {
        const c = new OffscreenCanvas(bitmap.width, bitmap.height);
        c.getContext('2d')!.drawImage(bitmap, 0, 0);
        return (await c.convertToBlob({ type: 'image/png' })).arrayBuffer();
    });
    const encodeMs = Math.round(performance.now() - tEnc);
    const resp = await iframeRpc({
        type: 'mt:inpaint', png,
        mask: new Uint8Array(mask.data).slice(), // copy: the caller still needs det.mask (fill path, debug view, cache)
        boxes: boxes.map(b => ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 })),
        padRatio, lo: opts?.lo === true, noDownload: opts?.noDownload === true,
    }, [png]) as { ok: boolean; patches?: InpaintPatch[]; windows?: number; ms?: number; lockWait?: number; error?: string };
    if (!resp?.ok) throw new Error(resp?.error ?? 'inpaint failed');
    const patches = (resp.patches ?? []).map(p => ({ i: p.i, x1: +p.x1, y1: +p.y1, x2: +p.x2, y2: +p.y2, png: p.png as ArrayBuffer }));
    return { patches, windows: resp.windows ?? patches.length, ms: resp.ms ?? 0, lockWaitMs: resp.lockWait ?? 0, encodeMs };
}

// AI cleanup on the user's own endpoint (cloud engine): the client sends the page as base64
// JPEG plus the prepared erase mask as base64 PNG, and gets back the same per-box PNG patches
// the local worker produces, so the paint/cache path is shared. Bodies ride as base64 through
// the SW (content-script fetch is CORS-gated on the page origin).
export async function cloudInpaint(
    bitmap: ImageBitmap, boxes: { x1: number; y1: number; x2: number; y2: number }[],
    opts: { quality: number; gray: boolean; endpoint: string; key: string; mask: { width: number; height: number; data: Uint8Array }; timing?: PageTimer },
): Promise<{ patches: InpaintPatch[]; windows: number; ms: number }> {
    const tEnc = performance.now();
    let jpegB64: string, maskB64: string;
    try {
        jpegB64 = await bitmapToJpegB64(bitmap, opts.quality, opts.gray);
        maskB64 = await maskToPngB64(opts.mask);
    } finally { opts.timing?.add('cleanupEncode', performance.now() - tEnc); }
    const tRequest = performance.now();
    let resp: { ok: boolean; page?: any; error?: string };
    try {
        resp = await sendToBackground({
            type: 'mt:cloud-inpaint', endpoint: opts.endpoint, key: opts.key, jpegB64, boxes, maskB64,
        }, { timeoutMs: 100_000, label: 'cloud inpaint' });
    } finally { opts.timing?.add('cleanupRequest', performance.now() - tRequest); }
    if (!resp?.ok) throw new Error(resp?.error ?? 'cloud inpaint failed');
    const j = resp.page;
    if (!j?.ok) throw new Error(String(j?.error ?? 'cloud inpaint failed'));
    const patches = (j.patches ?? []).map((p: any) => ({
        x1: +p.x1, y1: +p.y1, x2: +p.x2, y2: +p.y2, png: b64buf(String(p.png ?? '')),
    }));
    return { patches, windows: +(j.windows ?? patches.length), ms: +(j.ms?.total ?? 0) };
}

// ---- Cloud: panel+detect+OCR on your own endpoint (opt-in, Modal). Same boxes+texts the
// local pipeline produces; ordering/rendering stay client-side. The mask is synthesized from
// boxes (inpaint + cache work; mask-only SFX recovery is local-only).

// Binary erase mask -> base64 PNG for the cloud call (PNG squeezes 1 byte/px to tens of KB,
// where raw base64 would be ~2.4MB). Sync toDataURL — the blob path stalls on Android.
async function maskToPngB64(mask: { width: number; height: number; data: Uint8Array }): Promise<string> {
    return withEncodeLock(async () => {
        const c = document.createElement('canvas');
        c.width = mask.width;
        c.height = mask.height;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        const img = ctx.createImageData(mask.width, mask.height);
        for (let i = 0, p = 0; i < mask.data.length; i++, p += 4) {
            const v = mask.data[i] > 127 ? 255 : 0;
            img.data[p] = v; img.data[p + 1] = v; img.data[p + 2] = v; img.data[p + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        const dataUrl = c.toDataURL('image/png');
        const comma = dataUrl.indexOf(',');
        return comma < 0 ? '' : dataUrl.slice(comma + 1);
    });
}

// JPEG payload after the comma, shared by both cloud upload encoders. Sync
// toDataURL (see encode.ts) — the async blob path stalls on Android.
function jpegDataUrl(c: HTMLCanvasElement, quality: number, gray: boolean): string {
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    if (gray) {
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
            d[i] = d[i + 1] = d[i + 2] = y;
        }
        ctx.putImageData(img, 0, 0);
    }
    return canvasJpegB64(c, quality);
}

export async function bitmapToJpegB64(bitmap: ImageBitmap, quality: number, gray: boolean): Promise<string> {
    return withEncodeLock(async () => {
        const c = document.createElement('canvas');
        c.width = bitmap.width;
        c.height = bitmap.height;
        c.getContext('2d', { willReadFrequently: true })!.drawImage(bitmap, 0, 0);
        return jpegDataUrl(c, quality, gray);
    });
}

// Cloud uploads from weak devices pay the mobile uplink per byte, while CTD resizes any input
// into its fixed 1024 field and Baberu crops shrink to 224x224 — a capped long side costs
// detection nothing and OCR a sliver of sharpness on very large scans. Returns the downscale
// factor (fullPage / sent) so callers map response coords back; 1 when nothing was scaled.
export const CLOUD_MAX_SIDE = 1600;
export async function bitmapToJpegB64Capped(
    bitmap: ImageBitmap, quality: number, gray: boolean, maxSide: number,
): Promise<{ b64: string; scale: number }> {
    return withEncodeLock(async () => {
        const long = Math.max(bitmap.width, bitmap.height);
        if (maxSide <= 0 || long <= maxSide) {
            const c = document.createElement('canvas');
            c.width = bitmap.width;
            c.height = bitmap.height;
            c.getContext('2d', { willReadFrequently: true })!.drawImage(bitmap, 0, 0);
            return { b64: jpegDataUrl(c, quality, gray), scale: 1 };
        }
        const scale = long / maxSide;
        const w = Math.round(bitmap.width / scale), h = Math.round(bitmap.height / scale);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, w, h);
        return { b64: jpegDataUrl(c, quality, gray), scale };
    });
}

// Cloud endpoint/key live in mtSettings (llm/adapters), same place detectPage reads them;
// sweep prewarms from here too.
export async function cloudConfig(): Promise<{ endpoint: string; key: string }> {
    const { mtSettings } = await chrome.storage.local.get('mtSettings');
    const s = mtSettings as { cloudEndpoint?: unknown; cloudKey?: unknown } | undefined;
    return {
        endpoint: String(s?.cloudEndpoint ?? '').trim(),
        key: String(s?.cloudKey ?? '').trim(),
    };
}

// Modal scales to zero: the first request after idle pays the container boot + model load.
// A sweep pays that ONCE up front instead of letting the first page calls race the boot.
// /health is auth-exempt and returns only after the models are up.
export async function cloudWarm(endpoint: string, key: string, chapterTrace?: ChapterTrace): Promise<number> {
    const trace = chapterTrace ? { ...chapterTrace, request: crypto.randomUUID() } : undefined;
    recordChapterLog(trace, { kind: 'cloud-sent', stage: 'warm', deadlineMs: 190_000 });
    const r = await sendToBackground<{ ok: boolean; ms?: number; error?: string }>(
        { type: 'mt:cloud-warm', endpoint, key, ...(trace ? { chapterTrace: trace } : {}) }, { timeoutMs: 190_000, label: 'cloud warm' });
    if (!r?.ok) throw new Error(r?.error ?? 'cloud warm failed');
    return r.ms ?? 0;
}

export async function cloudDetect(
    bitmap: ImageBitmap,
    endpoint: string, key: string,
    opts: { confThr: number; minSize: number; quality: number; gray: boolean; inpaint?: boolean; texts?: boolean; timing?: PageTimer; chapterTrace?: ChapterTrace },
): Promise<DetectResult> {
    // capped upload (mobile uplink): CTD/Baberu inputs are resize-invariant, so anything above
    // CLOUD_MAX_SIDE is pure wire cost — response coords come back in sent space and are mapped
    // back with `scale` below
    const tEnc = performance.now();
    const trace = opts.chapterTrace ? { ...opts.chapterTrace, request: crypto.randomUUID() } : undefined;
    recordChapterLog(trace, { kind: 'stage', stage: 'cloudEncode' });
    const { b64: jpegB64, scale } = await bitmapToJpegB64Capped(bitmap, opts.quality, opts.gray, CLOUD_MAX_SIDE);
    const encMs = Math.round(performance.now() - tEnc);
    opts.timing?.add('cloudEncode', encMs);
    recordChapterLog(trace, { kind: 'cloud-sent', stage: 'cloudWait', ms: encMs, bytes: Math.round(jpegB64.length * 0.75), deadlineMs: 160_000 });
    // via the SW: content-script fetch is CORS-gated on the page origin. The channel
    // JSON-serializes, so the JPEG rides as base64 (an ArrayBuffer arrives as {}).
    const tUp = performance.now();
    let resp: { ok: boolean; page?: any; error?: string };
    try {
        resp = await sendToBackground({
            type: 'mt:cloud-page', endpoint, key,
            confThr: opts.confThr, minSize: opts.minSize, jpegB64,
            inpaint: opts.inpaint === true,
            // page/crops modes read the image at the LLM — tell the server to skip its OCR pass
            texts: opts.texts !== false,
            ...(trace ? { chapterTrace: trace } : {}),
        }, { timeoutMs: 160_000, label: 'cloud detect' });
    } catch (e) {
        recordChapterLog(trace, { kind: 'cloud-response', ...chapterLogError(e) });
        throw e;
    } finally { opts.timing?.add('cloudRequest', performance.now() - tUp); }
    const upMs = Math.round(performance.now() - tUp);
    if (!resp?.ok) throw new Error(resp?.error ?? 'cloud failed');
    recordChapterLog(trace, { kind: 'stage', stage: 'detect', ms: upMs });
    {
        const tDecode = performance.now();
        const j = resp.page;
        if (!j?.ok) throw new Error(String(j?.error ?? 'cloud failed'));
        // response coords are in SENT-image space (capped upload) — scale everything back to
        // full-page space here; every consumer downstream works in full-page coords
        const boxes: DetBox[] = (j.boxes ?? []).map((b: any) => ({
            x1: +b.x1 * scale, y1: +b.y1 * scale, x2: +b.x2 * scale, y2: +b.y2 * scale, conf: +b.conf,
            ...(b.clip ? { clip: {
                x1: +b.clip.x1 * scale, y1: +b.clip.y1 * scale,
                x2: +b.clip.x2 * scale, y2: +b.clip.y2 * scale,
            } } : null),
            ...(b.cutAxis === 'x' || b.cutAxis === 'y' ? { cutAxis: b.cutAxis } : null),
        }));
        const w = bitmap.width, h = bitmap.height;
        const serverTotal = Math.round(j.ms?.total ?? 0);
        // Real CTD mask when the server ships one (gen 2+): text-color sampling, inpaint and the
        // debug view all read it. Older servers send nothing — fall back to box-filled stand-in
        // (whole boxes read as ink, so leaked areas resolve white text; those entries miss the
        // freshness gate and re-detect anyway).
        let maskData: ArrayBuffer;
        const pm = j.mask as { w?: unknown; h?: unknown; b64?: unknown } | undefined;
        if (pm && typeof pm.b64 === 'string' && +pm.w! > 0 && +pm.h! > 0) {
            const bin = atob(pm.b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            maskData = unpackMask({ w: Math.floor(+pm.w!), h: Math.floor(+pm.h!), data: bytes.buffer }, w, h);
        } else {
            const packed = new Uint8Array(w * h);
            for (const b of boxes) {
                const x1 = Math.max(0, Math.floor(b.x1)), y1 = Math.max(0, Math.floor(b.y1));
                const x2 = Math.min(w, Math.ceil(b.x2)), y2 = Math.min(h, Math.ceil(b.y2));
                for (let y = y1; y < y2; y++) packed.fill(255, y * w + x1, y * w + x2);
            }
            maskData = packed.buffer as ArrayBuffer;
        }
        // cleanup patches computed server-side in the same roundtrip (one per box, coords in sent
        // space) — scale back to full-page space here so every consumer sees full-res coords. The
        // render filters to the erase plan and falls back to the dedicated /v1/inpaint roundtrip
        // when the keep-overlap guard rejects them.
        const cloudPatches: InpaintPatch[] = (j.patches ?? []).map((p: any) => ({
            i: +(p.i ?? -1),
            x1: Math.round(+p.x1 * scale), y1: Math.round(+p.y1 * scale),
            x2: Math.round(+p.x2 * scale), y2: Math.round(+p.y2 * scale),
            png: b64buf(String(p.png ?? '')),
        }));
        opts.timing?.add('cloudDecode', performance.now() - tDecode);
        if (opts.timing) opts.timing.meta.cloud = {
            detect: j.ms?.detect, ocr: j.ms?.ocr, inpaint: j.ms?.inpaint, total: j.ms?.total, body: j.ms?.body,
        };
        return {
            boxes,
            mask: { width: w, height: h, data: maskData },
            inferMs: Math.round(j.ms?.detect ?? 0),
            ep: 'cloud',
            splitGen: typeof j.splitGen === 'number' ? j.splitGen : 0,
            cloudTexts: (j.texts ?? []).map((t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim()),
            cloudMs: {
                detect: Math.round(j.ms?.detect ?? 0), ocr: Math.round(j.ms?.ocr ?? 0),
                ...(typeof j.ms?.inpaint === 'number' ? { inpaint: Math.round(j.ms.inpaint) } : null),
                enc: encMs, net: Math.max(0, upMs - serverTotal), total: serverTotal,
            },
            cloudPatches: cloudPatches.length ? cloudPatches : undefined,
            panels: [],
            panelSkipped: String(j.panelSkipped ?? 'cloud: banding fallback'),
        };
    }
}

// base64 → ArrayBuffer for cloud response payloads (patches PNG)
function b64buf(s: string): ArrayBuffer {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
}

// generic request/response over the iframe postMessage channel
async function iframeRpc(msg: object, transfer?: Transferable[]): Promise<unknown> {
    // null token = handshake failed — the worker would silently drop the RPC and we'd wait out
    // the full 180s per call. Rebuild once (a fresh worker re-registers), then fail fast.
    if (workerToken === null && !(await healToken())) throw new Error('worker auth token missing — reload the page');
    if (!iframeAlive()) await ensureIframe(); // page tore the iframe down — rebuild
    if (workerToken === null && !(await healToken())) throw new Error('worker auth token missing — reload the page');
    const cw = iframe?.contentWindow;
    if (!cw) throw new Error('inference iframe unavailable'); // torn down again mid-await
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (r: DetectResult) => void, reject });
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error('iframe rpc timeout'));
            }
        }, 180000);
        cw.postMessage({ ...msg, id, token: workerToken }, '*', transfer);
    });
}
