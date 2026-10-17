import type { DetBox } from './detection';

interface Pixels { width: number; height: number; data: Uint8ClampedArray }
interface Mask { width: number; height: number; data: ArrayBuffer }
type Tone = [number, number, number];

export interface BalloonSurface {
    x1: number; y1: number; x2: number; y2: number;
    left: Int32Array; right: Int32Array;
    seed: Tone;
    count: number;
}

// Modal non-text tone; quantized votes keep antialiasing from splitting the background.
export function interiorSeed(data: Uint8ClampedArray, W: number, H: number, box: DetBox, mask?: Uint8Array): Tone {
    const x1 = Math.max(0, Math.floor(box.x1)), y1 = Math.max(0, Math.floor(box.y1));
    const x2 = Math.min(W - 1, Math.ceil(box.x2)), y2 = Math.min(H - 1, Math.ceil(box.y2));
    const sx = Math.max(1, Math.floor((x2 - x1) / 24)), sy = Math.max(1, Math.floor((y2 - y1) / 24));
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    let best: { n: number; r: number; g: number; b: number } | undefined;
    for (let y = y1; y <= y2; y += sy) for (let x = x1; x <= x2; x += sx) {
        if (mask?.[y * W + x]) continue;
        const i = (y * W + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
        const key = (r >> 4 << 8) | (g >> 4 << 4) | (b >> 4);
        const vote = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        vote.n++; vote.r += r; vote.g += g; vote.b += b; buckets.set(key, vote);
        if (!best || vote.n > best.n) best = vote;
    }
    if (best) return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
    const cx = Math.max(0, Math.min(W - 1, Math.floor((box.x1 + box.x2) / 2)));
    const cy = Math.max(0, Math.min(H - 1, Math.floor((box.y1 + box.y2) / 2)));
    const i = (cy * W + cx) * 4;
    return [data[i], data[i + 1], data[i + 2]];
}

export function seedLike(data: Uint8ClampedArray, i: number, seed: Tone): boolean {
    return Math.abs(data[i] - seed[0]) + Math.abs(data[i + 1] - seed[1]) + Math.abs(data[i + 2] - seed[2]) < 60;
}

export function surfaceContains(surface: BalloonSurface, box: DetBox): boolean {
    if (box.y1 < surface.y1 || box.y2 > surface.y2) return false;
    for (let y = Math.floor(box.y1); y < Math.ceil(box.y2); y++) {
        const k = y - surface.y1;
        if (k < 0 || k >= surface.left.length || box.x1 < surface.left[k] || box.x2 > surface.right[k]) return false;
    }
    return true;
}

const surfaces = new WeakMap<Pixels, BalloonSurface[]>();

export function internalDivider(img: Pixels, surface: BalloonSurface, box: DetBox, mask?: Uint8Array): boolean {
    const y0 = surface.y1, y2 = surface.y2;
    for (let x = surface.x1; x < surface.x2; x++) {
        if (x >= box.x1 && x < box.x2) continue;
        let ink = 0;
        for (let y = y0; y < y2; y++) {
            const k = y - surface.y1, p = y * img.width + x;
            if (x < surface.left[k] || x >= surface.right[k] || mask?.[p]) continue;
            if (!seedLike(img.data, p * 4, surface.seed)) ink++;
        }
        if (ink >= (y2 - y0) * 0.4) return true;
    }
    return false;
}

// Measure a closed background component independently of artificial split clips.
// Text is not a bridge through walls; callers apply ownership clips only after measurement.
export function balloonSurface(img: Pixels, box: DetBox, mask?: Mask, search: DetBox = box): BalloonSurface | null {
    const { width: W, height: H, data } = img;
    if (!(box.x2 > box.x1 && box.y2 > box.y1)) return null;
    const mk = mask?.width === W && mask.height === H && mask.data.byteLength === W * H ? new Uint8Array(mask.data) : undefined;
    const cached = surfaces.get(img) ?? [];
    const known = cached.find(s => surfaceContains(s, box) && !internalDivider(img, s, box, mk));
    if (known) return known;
    const bw = search.x2 - search.x1, bh = search.y2 - search.y1;
    const gx = Math.max(24, bw * 1.2, bh * 0.7), gy = Math.max(24, bh * 0.6, bw * 0.7);
    const loX = Math.max(0, Math.floor(search.x1 - gx)), hiX = Math.min(W - 1, Math.ceil(search.x2 + gx));
    const loY = Math.max(0, Math.floor(search.y1 - gy)), hiY = Math.min(H - 1, Math.ceil(search.y2 + gy));
    const rw = hiX - loX + 1, rh = hiY - loY + 1;
    if (rw <= 0 || rh <= 0 || rw * rh > 1_500_000) return null;
    const cx = Math.floor((box.x1 + box.x2) / 2), cy = Math.floor((box.y1 + box.y2) / 2);
    const probes: [number, number][] = [
        [Math.floor(box.x1) - 3, cy], [Math.ceil(box.x2) + 3, cy],
        [cx, Math.floor(box.y1) - 3], [cx, Math.ceil(box.y2) + 3],
        [Math.floor(box.x1), Math.floor(box.y1)], [Math.ceil(box.x2), Math.ceil(box.y2)], [cx, cy],
    ];
    const visited = new Uint8Array(rw * rh);
    const queue: number[] = [];
    const seenTones = new Set<number>();
    for (const [sx, sy] of probes) {
        if (sx <= loX || sx >= hiX || sy <= loY || sy >= hiY || mk?.[sy * W + sx]) continue;
        const at = (sy * W + sx) * 4, seed: Tone = [data[at], data[at + 1], data[at + 2]];
        const key = (seed[0] >> 4 << 8) | (seed[1] >> 4 << 4) | (seed[2] >> 4);
        if (seenTones.has(key)) continue;
        seenTones.add(key);
        visited.fill(0); queue.length = 0;
        const start = (sy - loY) * rw + sx - loX;
        visited[start] = 1; queue.push(start);
        let minX = sx, maxX = sx, minY = sy, maxY = sy, leaked = false;
        const left = new Int32Array(rh).fill(W), right = new Int32Array(rh).fill(-1);
        for (let head = 0; head < queue.length; head++) {
            const p = queue[head], x = loX + p % rw, y = loY + Math.floor(p / rw);
            if (x === loX || x === hiX || y === loY || y === hiY) { leaked = true; break; }
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            left[y - loY] = Math.min(left[y - loY], x); right[y - loY] = Math.max(right[y - loY], x + 1);
            for (const q of [p - 1, p + 1, p - rw, p + rw]) {
                if (visited[q]) continue;
                const xx = loX + q % rw, yy = loY + Math.floor(q / rw);
                if (!seedLike(data, (yy * W + xx) * 4, seed)) continue;
                visited[q] = 1; queue.push(q);
            }
        }
        if (leaked || queue.length < Math.max(64, (box.x2 - box.x1) * (box.y2 - box.y1) * 0.25)) continue;
        const surface: BalloonSurface = { x1: minX, y1: minY, x2: maxX + 1, y2: maxY + 1,
            left: left.slice(minY - loY, maxY - loY + 1), right: right.slice(minY - loY, maxY - loY + 1), seed, count: queue.length };
        if (!surfaceContains(surface, box) || internalDivider(img, surface, box, mk)) continue;
        const outlined = (x: number, y: number, dir: -1 | 1) => {
            let n = 0;
            const light = 0.299 * seed[0] + 0.587 * seed[1] + 0.114 * seed[2] >= 128;
            for (let k = 0; k < 16; k++, x += dir) {
                if (x < 0 || x >= W) return false;
                const i = (y * W + x) * 4, lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                if (!seedLike(data, i, seed) && (light ? lum < 100 : lum > 155)) n++;
                else if (n > 0 || k >= 2) return n > 0;
            }
            return false;
        };
        let rows = 0, enclosed = 0;
        for (let y = Math.floor(box.y1); y < Math.ceil(box.y2); y++) {
            const k = y - surface.y1;
            if (surface.right[k] <= surface.left[k]) continue;
            rows++;
            if (outlined(surface.left[k] - 1, y, -1) && outlined(surface.right[k], y, 1)) enclosed++;
        }
        if (!rows || enclosed < rows * 0.5) continue;
        if (cached.length < 64) { cached.push(surface); surfaces.set(img, cached); }
        return surface;
    }
    return null;
}

function maskComponents(mask: Uint8Array, W: number, H: number, box: DetBox): DetBox[] {
    const x0 = Math.max(0, Math.floor(box.x1)), y0 = Math.max(0, Math.floor(box.y1));
    const x2 = Math.min(W, Math.ceil(box.x2)), y2 = Math.min(H, Math.ceil(box.y2));
    const rw = x2 - x0, rh = y2 - y0;
    if (rw <= 0 || rh <= 0) return [];
    const seen = new Uint8Array(rw * rh), out: DetBox[] = [], queue: number[] = [];
    for (let p = 0; p < seen.length; p++) {
        if (seen[p] || !mask[(y0 + Math.floor(p / rw)) * W + x0 + p % rw]) continue;
        seen[p] = 1; queue.length = 0; queue.push(p);
        let ax = W, ay = H, bx = 0, by = 0;
        for (let head = 0; head < queue.length; head++) {
            const q = queue[head], x = q % rw, y = Math.floor(q / rw);
            ax = Math.min(ax, x + x0); bx = Math.max(bx, x + x0 + 1); ay = Math.min(ay, y + y0); by = Math.max(by, y + y0 + 1);
            for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                const xx = x + dx, yy = y + dy, i = yy * rw + xx;
                if (xx < 0 || xx >= rw || yy < 0 || yy >= rh || seen[i] || !mask[(yy + y0) * W + xx + x0]) continue;
                seen[i] = 1; queue.push(i);
            }
        }
        if (queue.length >= 4) out.push({ x1: ax, y1: ay, x2: bx, y2: by, conf: box.conf });
        if (out.length > 400) return [];
    }
    return out;
}

// ---- connected lobes: one physical surface, several text columns -----------------
// A balloon can be drawn as interlocking lobes sharing one interior (no wall between them).
// Their comps all resolve to one surface, so the surface split cannot fire; cut at the
// text-block seams instead: words on one row and lines stacked with real cross overlap
// belong to one block, while a corridor between side-by-side blocks is a lobe boundary.
// The predicate is shared with the lettering extraction (which needs the raw neighbourhood).
function textCompLinked(a: DetBox, b: DetBox): boolean {
    const ha = a.y2 - a.y1, hb = b.y2 - b.y1, unit = Math.min(ha, hb);
    const wa = a.x2 - a.x1, wb = b.x2 - b.x1;
    const xGap = Math.max(a.x1 - b.x2, b.x1 - a.x2, 0);
    const yGap = Math.max(a.y1 - b.y2, b.y1 - a.y2, 0);
    const xOverlap = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
    const sameRow = Math.abs((a.y1 + a.y2) - (b.y1 + b.y2)) <= 1.2 * unit && xGap <= 0.9 * unit;
    const stackUnit = Math.max(unit, Math.min(wa, wb, Math.max(ha, hb)));
    const stacked = xGap === 0 && xOverlap >= 0.5 * Math.min(wa, wb) && yGap <= 0.6 * stackUnit;
    return sameRow || stacked;
}
export function clusterTextComponents(comps: DetBox[]): DetBox[][] {
    const parent = comps.map((_, i) => i);
    const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) {
        if (textCompLinked(comps[i], comps[j])) parent[find(j)] = find(i);
    }
    const groups = new Map<number, DetBox[]>();
    comps.forEach((comp, i) => { const k = find(i); const group = groups.get(k) ?? []; group.push(comp); groups.set(k, group); });
    return [...groups.values()];
}

// Display lettering is oversized in both dimensions; a connected vertical column strip
// is tall but only one glyph column wide and must stay with its paragraph.
function isLettering(c: DetBox, medianH: number): boolean {
    return c.y2 - c.y1 >= 2.5 * medianH && c.x2 - c.x1 >= 1.8 * medianH;
}

function blockHeight(cs: DetBox[], medianH: number): number {
    const main = cs.filter(c => c.y2 - c.y1 > 0.7 * medianH);
    const use = main.length ? main : cs;
    return Math.max(...use.map(c => c.y2)) - Math.min(...use.map(c => c.y1));
}

// Stray fragments and short dot runs must not veto a split or become their own region:
// blocks that cannot stand alone (a single component, or a cluster under the block floor)
// attach to the nearest full block when close. Display-lettering scale components stand
// alone by design — they are the SFX the split is meant to separate.
function attachOrphans(clusters: DetBox[][], medianH: number): DetBox[][] {
    const out = clusters.filter(cs => cs.length > 1 && blockHeight(cs, medianH) >= 1.8 * medianH);
    for (const cs of clusters) {
        if (out.includes(cs)) continue;
        if (cs.length === 1 && isLettering(cs[0], medianH)) { out.push(cs); continue; }
        // Dust (a sliver far below glyph scale) attaches from farther out: a 4px speck
        // floating between blocks must not veto the split.
        const dusty = cs.some(c => c.y2 - c.y1 <= 0.5 * medianH);
        const bound = (dusty ? 3 : 1.2) * medianH;
        let best: DetBox[] | null = null, bestD = Infinity;
        for (const target of out) {
            let d = Infinity;
            for (const c of cs) for (const o of target) {
                const dx = Math.max(0, Math.max(c.x1 - o.x2, o.x1 - c.x2));
                const dy = Math.max(0, Math.max(c.y1 - o.y2, o.y1 - c.y2));
                d = Math.min(d, Math.hypot(dx, dy));
            }
            if (d < bestD) { bestD = d; best = target; }
        }
        if (best && bestD <= bound) best.push(...cs);
        else out.push(cs);
    }
    return out;
}

// Frame-clamped children: each child owns its text block plus a margin that stops short of
// every sibling's ink. Erase/crop/layout clamp to that frame, so a shared physical surface
// can never leak a sibling glyph into this child's cleanup. null = not safely splittable.
export function splitConnectedClusters(comps: DetBox[], parent: DetBox, W: number, H: number, sib: number,
    accept?: (clusters: DetBox[][]) => boolean): DetBox[] | null {
    if (comps.length < 2) return null;
    const rawHeights = comps.map(c => c.y2 - c.y1).sort((a, b) => a - b);
    const glyphHeights = rawHeights.filter(h => h >= 12);
    const heights = glyphHeights.length >= 2 ? glyphHeights : rawHeights;
    const medianH = heights[heights.length >> 1];
    const clusters = attachOrphans(clusterTextComponents(comps), medianH);
    // Display lettering (SFX scale) glued to a dialogue block is its own region: the big
    // components split out whenever the rest still holds a real block, taking ornament
    // components that hang off the lettering alone (a heart under an "Ah!", whose only
    // grammar neighbour is the lettering component itself).
    const split: DetBox[][] = [];
    for (const cs of clusters) {
        const big = cs.filter(c => isLettering(c, medianH));
        if (!big.length || cs.length - big.length < 2) { split.push(cs); continue; }
        const rest = cs.filter(c => !big.includes(c));
        const nearBig = (c: DetBox) => big.some(b => {
            const dx = Math.max(0, Math.max(c.x1 - b.x2, b.x1 - c.x2));
            const dy = Math.max(0, Math.max(c.y1 - b.y2, b.y1 - c.y2));
            return Math.hypot(dx, dy) <= 0.5 * medianH;
        });
        const stray = rest.filter(c => rest.every(o => o === c || !textCompLinked(o, c))
            && (big.some(b => textCompLinked(b, c)) || nearBig(c)));
        if (stray.length) {
            big.push(...stray);
            for (const c of stray) rest.splice(rest.indexOf(c), 1);
        }
        split.push(big, rest);
    }
    if (split.length < 2 || split.length > 8) return null;
    if (accept && !accept(split)) return null;
    const boxes = split.map(cs => ({
        x1: Math.min(...cs.map(c => c.x1)), y1: Math.min(...cs.map(c => c.y1)),
        x2: Math.max(...cs.map(c => c.x2)), y2: Math.max(...cs.map(c => c.y2)), conf: parent.conf,
    }));
    // Each child must be a text block of its own: ≥2 components and at least about two
    // lines tall. A lone word or an ink fragment never becomes its own region — but a
    // single OVERSIZED component is display lettering (SFX scale, several times the block's
    // glyphs): keeping it in the box would erase it with the neighbours' cleanup, so it
    // becomes its own (keep-path) region instead.
    const oversized = (cs: DetBox[]) => cs.length === 1 && isLettering(cs[0], medianH);
    if (split.some(cs => cs.length < 2 ? !oversized(cs) : blockHeight(cs, medianH) < 1.8 * medianH)) return null;
    // A mid-column seam is not a block boundary: two substantial blocks that share almost the
    // same x-range and sit only about a line apart are rows of one column of text (a single
    // missing row link must not cut a paragraph in half). Lettering pieces exempt themselves
    // by being small, real block stacks by their gap.
    for (let i = 0; i < split.length; i++) for (let j = i + 1; j < split.length; j++) {
        if (split[i].length < 3 || split[j].length < 3) continue;
        const overlap = Math.min(boxes[i].x2, boxes[j].x2) - Math.max(boxes[i].x1, boxes[j].x1);
        const gap = Math.max(boxes[i].y1 - boxes[j].y2, boxes[j].y1 - boxes[i].y2, 0);
        if (overlap > 0.6 * Math.min(boxes[i].x2 - boxes[i].x1, boxes[j].x2 - boxes[j].x1)
            && gap <= 1.3 * medianH) return null;
    }
    const frameFor = (b: DetBox, i: number): { x1: number; y1: number; x2: number; y2: number } | null => {
        const others = comps.filter(c => !split[i].includes(c));
        const bandY = others.filter(o => o.y1 < b.y2 && o.y2 > b.y1);
        const bandX = others.filter(o => o.x1 < b.x2 && o.x2 > b.x1);
        const soft = (clearance: number) => clearance === Infinity ? 14 : Math.max(0, Math.min(14, Math.floor((clearance - 2) / 2)));
        const l = bandY.length ? b.x1 - Math.max(...bandY.map(o => o.x2)) : Infinity;
        const r = bandY.length ? Math.min(...bandY.map(o => o.x1)) - b.x2 : Infinity;
        const t = bandX.length ? b.y1 - Math.max(...bandX.map(o => o.y2)) : Infinity;
        const d = bandX.length ? Math.min(...bandX.map(o => o.y1)) - b.y2 : Infinity;
        return { x1: Math.max(0, b.x1 - soft(l)), y1: Math.max(0, b.y1 - soft(t)),
            x2: Math.min(W, b.x2 + soft(r)), y2: Math.min(H, b.y2 + soft(d)) };
    };
    // Frames are repaired, not vetoed: a sibling component that intrudes into a child's
    // erase reach shrinks that side of the frame (never below its own ink, 1px leash for
    // exclusive edges and float worker clips) instead of aborting the whole split — a ±2px
    // detection jitter must not resurrect the merged region. As a last resort a sliver
    // budget lets two blocks whose boxes interlock by a few pixels still split: the reach
    // may graze that corner rather than keep one fused region over two blocks.
    const withinCoverage = (f: { x1: number; y1: number; x2: number; y2: number }, b: DetBox) =>
        Math.ceil(f.x1) <= b.x1 + 1 && Math.ceil(f.y1) <= b.y1 + 1
        && Math.ceil(f.x2) >= b.x2 - 1 && Math.ceil(f.y2) >= b.y2 - 1;
    const intrudes = (f: { x1: number; y1: number; x2: number; y2: number }, c: DetBox, slack: number) => {
        const ix1 = Math.max(c.x1, f.x1), ix2 = Math.min(c.x2 - 1, f.x2 - 1);
        const iy1 = Math.max(c.y1, f.y1), iy2 = Math.min(c.y2 - 1, f.y2 - 1);
        if (ix2 < ix1 || iy2 < iy1) return false;
        return (ix2 - ix1 + 1) * (iy2 - iy1 + 1) > slack;
    };
    const SLIVER_REACH = 384; // px² of interlock the sliver fallback tolerates
    const repairFrames = (start: { x1: number; y1: number; x2: number; y2: number }[], slack: number): { x1: number; y1: number; x2: number; y2: number }[] | null => {
        let frames = start.map(f => ({ ...f }));
        if (parent.clip) {
            const clip = parent.clip;
            frames = frames.map(f => ({ x1: Math.max(f.x1, clip.x1), y1: Math.max(f.y1, clip.y1),
                x2: Math.min(f.x2, clip.x2), y2: Math.min(f.y2, clip.y2) }));
        }
        if (boxes.some((b, i) => !withinCoverage(frames[i], b))) return null;
        for (let guard = 0; guard < 128; guard++) {
            let moved = false;
            scan: for (let i = 0; i < frames.length; i++) {
                const b = boxes[i];
                for (const c of comps) {
                    const f = frames[i];
                    if (split[i].includes(c) || !intrudes(f, c, slack)) continue;
                    const ix1 = Math.max(c.x1, f.x1), ix2 = Math.min(c.x2 - 1, f.x2 - 1);
                    const iy1 = Math.max(c.y1, f.y1), iy2 = Math.min(c.y2 - 1, f.y2 - 1);
                    const options: ['x1' | 'x2' | 'y1' | 'y2', number][] =
                        [['x1', ix2 + 1], ['x2', ix1], ['y1', iy2 + 1], ['y2', iy1]];
                    let bestF: typeof f | null = null, bestD = Infinity;
                    for (const [k, v] of options) {
                        if (v === f[k]) continue;
                        const nf = { ...f, [k]: v };
                        if (nf.x1 >= nf.x2 || nf.y1 >= nf.y2 || !withinCoverage(nf, b)) continue;
                        const d = Math.abs(v - f[k]);
                        if (d < bestD) { bestD = d; bestF = nf; }
                    }
                    if (!bestF) return null;
                    frames[i] = bestF; moved = true;
                    break scan;
                }
            }
            if (!moved) return frames;
        }
        return null;
    };
    const soft = boxes.map((b, i) => frameFor(b, i) ?? { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 });
    const bare = boxes.map(b => ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }));
    const frames = repairFrames(soft, 0) ?? repairFrames(bare, 0)
        ?? repairFrames(soft, SLIVER_REACH) ?? repairFrames(bare, SLIVER_REACH);
    if (!frames) return null;
    return boxes.map((b, i) => ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, conf: b.conf, clip: frames[i], sib }));
}

// A detector cut's children are re-decided from their union: the cut's seam evidence may not
// survive the physical-surface measurement (one lobe's sentence can sit on both sides of the
// cut). One measured enclosure that yields >=2 text blocks is the only green light; every
// other outcome (unresolved ink, several enclosures, one block) keeps the cut's children.
function splitCutFamily(img: Pixels, raw: Uint8Array, mask: Mask, boxes: DetBox[], family: number[]): DetBox[] | null {
    const members = family.map(i => boxes[i]);
    if (members.some(b => !b.clip)) return null;
    const union: DetBox = {
        x1: Math.min(...members.map(b => b.x1)), y1: Math.min(...members.map(b => b.y1)),
        x2: Math.max(...members.map(b => b.x2)), y2: Math.max(...members.map(b => b.y2)),
        conf: Math.min(...members.map(b => b.conf)),
        // the members' clips share the cut's slack, so their union still owns the seam strip
        clip: { x1: Math.min(...members.map(b => b.clip!.x1)), y1: Math.min(...members.map(b => b.clip!.y1)),
            x2: Math.max(...members.map(b => b.clip!.x2)), y2: Math.max(...members.map(b => b.clip!.y2)) },
    };
    const comps = maskComponents(raw, img.width, img.height, union);
    if (comps.length < 2) return null;
    const surface = balloonSurface(img, comps[0], mask, union);
    if (!surface) return null;
    for (const comp of comps.slice(1)) if (balloonSurface(img, comp, mask, union) !== surface) return null;
    // A member carrying a full multi-line block (>= 6 components) is a settled block: the
    // cut's seam is real for it, and no union cluster may merge two such members — that is
    // how two touching balloons separated by a gutter come back fused. Fragment-like members
    // (an outlier line or two) may still join another member's block.
    const major = family.map(i => maskComponents(raw, img.width, img.height, boxes[i]).length >= 6);
    const of = new Map<DetBox, number>();
    for (const c of comps) {
        const cx = (c.x1 + c.x2) / 2, cy = (c.y1 + c.y2) / 2;
        const k = family.findIndex(i => {
            const m = boxes[i];
            return cx >= m.x1 && cx <= m.x2 && cy >= m.y1 && cy <= m.y2;
        });
        if (k >= 0) of.set(c, k);
    }
    const accept = (clusters: DetBox[][]): boolean => clusters.every(cs => {
        const involved = new Set<number>();
        for (const c of cs) {
            const k = of.get(c);
            if (k != null && major[k]) involved.add(k);
        }
        return involved.size <= 1;
    });
    return splitConnectedClusters(comps, union, img.width, img.height, family[0], accept);
}

// Split only when every supported ink component belongs to a measured enclosure.
// A shared enclosure never merges distinct lobes merely because their backgrounds connect.
export function splitBalloonSurfaces(img: Pixels, boxes: DetBox[], mask: Mask): DetBox[] {
    if (mask.width !== img.width || mask.height !== img.height || mask.data.byteLength !== img.width * img.height) return boxes;
    const raw = new Uint8Array(mask.data);
    // Children of one detector cut (shared sib) are grouped first and decided as a unit.
    const families = new Map<number, number[]>();
    for (const [i, box] of boxes.entries()) if (box.sib != null) {
        const family = families.get(box.sib) ?? [];
        family.push(i);
        families.set(box.sib, family);
    }
    const decided = new Map<number, DetBox[]>();
    const dropped = new Set<number>();
    for (const family of families.values()) {
        if (family.length < 2) continue;
        const pieces = splitCutFamily(img, raw, mask, boxes, family);
        if (!pieces) continue;
        decided.set(family[0], pieces);
        for (const i of family.slice(1)) dropped.add(i);
    }
    let changed = false;
    const result = boxes.flatMap((box, bi) => {
        if (dropped.has(bi)) return [];
        const familyPieces = decided.get(bi);
        if (familyPieces) { changed = true; return familyPieces; }
        const comps = maskComponents(raw, img.width, img.height, box);
        if (comps.length < 2) return [box];
        const groups = new Map<BalloonSurface, DetBox[]>();
        let unresolved = false;
        for (const comp of comps) {
            const surface = balloonSurface(img, comp, mask, box);
            if (!surface) { unresolved = true; continue; }
            const group = groups.get(surface) ?? [];
            group.push(comp); groups.set(surface, group);
        }
        if (groups.size >= 2 && !unresolved) {
            const pieces: DetBox[] = [];
            for (const [surface, cs] of groups) {
                const x1 = Math.min(...cs.map(c => c.x1)), y1 = Math.min(...cs.map(c => c.y1));
                const x2 = Math.max(...cs.map(c => c.x2)), y2 = Math.max(...cs.map(c => c.y2));
                if (x2 - x1 < 8 || y2 - y1 < 8) return [box];
                const pad = Math.max(2, Math.min(6, Math.min(x2 - x1, y2 - y1) * 0.15));
                const clip = { x1: Math.max(surface.x1, box.clip?.x1 ?? 0), y1: Math.max(surface.y1, box.clip?.y1 ?? 0),
                    x2: Math.min(surface.x2, box.clip?.x2 ?? img.width), y2: Math.min(surface.y2, box.clip?.y2 ?? img.height) };
                if (x1 < clip.x1 || y1 < clip.y1 || x2 > clip.x2 || y2 > clip.y2) return [box];
                pieces.push({ x1: Math.max(box.x1, clip.x1, x1 - pad), y1: Math.max(box.y1, clip.y1, y1 - pad),
                    x2: Math.min(box.x2, clip.x2, x2 + pad), y2: Math.min(box.y2, clip.y2, y2 + pad), conf: box.conf, clip });
            }
            changed = true;
            return pieces;
        }
        // A shared interior, or ink the surface measurement could not resolve (fragments near a
        // lobe edge): frame-clamped seam splitting needs no per-component surface and is safe.
        const pieces = splitConnectedClusters(comps, box, img.width, img.height, bi);
        if (!pieces) return [box];
        changed = true;
        return pieces;
    });
    return changed ? result : boxes;
}

// Regular aligned horizontal lines merge only after one physical surface contains the group.
// Geometry nominates neighbours; shared enclosure alone never establishes a paragraph.
export function mergeBalloonLines(img: Pixels, boxes: DetBox[], mask: Mask): DetBox[] {
    if (mask.width !== img.width || mask.height !== img.height || mask.data.byteLength !== img.width * img.height) return boxes;
    const raw = new Uint8Array(mask.data);
    const supported = (box: DetBox) => {
        let count = 0;
        for (let y = Math.max(0, Math.floor(box.y1)); y < Math.min(img.height, Math.ceil(box.y2)); y++) {
            for (let x = Math.max(0, Math.floor(box.x1)); x < Math.min(img.width, Math.ceil(box.x2)); x++) {
                if (raw[y * img.width + x] && ++count >= 4) return true;
            }
        }
        return false;
    };
    const parent = boxes.map((_, i) => i);
    const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
    const line = (b: DetBox) => b.x2 - b.x1 >= 1.5 * (b.y2 - b.y1);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j], ah = a.y2 - a.y1, bh = b.y2 - b.y1;
        if (a.clip || b.clip) continue; // frame-owned children never re-merge
        if (!line(a) || !line(b) || Math.max(ah, bh) > 1.5 * Math.min(ah, bh)) continue;
        const gap = Math.max(a.y1, b.y1) - Math.min(a.y2, b.y2);
        const span = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        if (gap < 0 || gap > 0.6 * Math.min(ah, bh) || span < 0.8 * Math.min(a.x2 - a.x1, b.x2 - b.x1)) continue;
        parent[find(j)] = find(i);
    }
    const groups = new Map<number, number[]>();
    boxes.forEach((_, i) => { const k = find(i), group = groups.get(k) ?? []; group.push(i); groups.set(k, group); });
    const replacements = new Map<number, DetBox>(), removed = new Set<number>();
    for (const indices of groups.values()) {
        if (indices.length < 2) continue;
        const rows = indices.map(i => boxes[i]).sort((a, b) => a.y1 - b.y1);
        if (!rows.every(supported)) continue;
        const pitches = rows.slice(1).map((b, i) => (b.y1 + b.y2 - rows[i].y1 - rows[i].y2) / 2);
        if (Math.max(...pitches) > 1.2 * Math.min(...pitches)) continue;
        const union = { x1: Math.min(...rows.map(b => b.x1)), y1: Math.min(...rows.map(b => b.y1)),
            x2: Math.max(...rows.map(b => b.x2)), y2: Math.max(...rows.map(b => b.y2)), conf: Math.min(...rows.map(b => b.conf)) };
        if (!balloonSurface(img, union, mask)) continue;
        replacements.set(indices[0], union);
        indices.slice(1).forEach(i => removed.add(i));
    }
    return replacements.size ? boxes.flatMap((b, i) => removed.has(i) ? [] : [replacements.get(i) ?? b]) : boxes;
}
