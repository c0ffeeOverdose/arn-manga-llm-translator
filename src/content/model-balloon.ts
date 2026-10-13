import type { DetBox } from './detection';
import { interiorSeed, seedLike, internalDivider, type BalloonSurface } from './balloon-surface';

// Page-space half-open spans preserve holes and disconnected pieces of one instance.
// Coordinates retain their source dimensions so proportional cache renditions can reuse them.
export interface ModelBalloon {
    width: number; height: number;
    x1: number; y1: number; x2: number; y2: number;
    conf: number;
    rows: number[][];
}

export function balloonRow(shape: ModelBalloon, y: number, width: number, height: number): number[] {
    const sy = Math.floor((y + 0.5) * shape.height / height);
    const row = shape.rows[sy - shape.y1];
    if (!row) return [];
    const sx = width / shape.width;
    return row.map((x, i) => i % 2 ? Math.floor(x * sx) : Math.ceil(x * sx));
}

export function attachModelBalloons(boxes: DetBox[], shapes: ModelBalloon[], mask: { width: number; height: number; data: ArrayBuffer }): DetBox[] {
    const { width: W, height: H } = mask, data = new Uint8Array(mask.data);
    const assigned = boxes.map(box => {
        const x1 = Math.max(0, Math.floor(box.x1)), x2 = Math.min(W, Math.ceil(box.x2));
        const y1 = Math.max(0, Math.floor(box.y1)), y2 = Math.min(H, Math.ceil(box.y2));
        const candidates = shapes.filter(shape => {
            const sx = W / shape.width, sy = H / shape.height;
            const overlap = Math.max(0, Math.min(box.x2, shape.x2 * sx) - Math.max(box.x1, shape.x1 * sx))
                * Math.max(0, Math.min(box.y2, shape.y2 * sy) - Math.max(box.y1, shape.y1 * sy));
            return overlap >= (box.x2 - box.x1) * (box.y2 - box.y1) * 0.8;
        }).sort((a, b) => (a.x2 - a.x1) * (a.y2 - a.y1) / (a.width * a.height)
            - (b.x2 - b.x1) * (b.y2 - b.y1) / (b.width * b.height));
        for (const shape of candidates) {
            let ink = 0, covered = 0;
            for (let y = y1; y < y2; y++) {
                const row = balloonRow(shape, y, W, H);
                for (let x = x1; x < x2; x++) {
                    if (!data[y * W + x]) continue;
                    ink++;
                    if (row.some((a, i) => i % 2 === 0 && x >= a && x < row[i + 1])) covered++;
                }
            }
            if (ink >= 4 && covered >= ink * 0.95) return { ...box, balloon: shape };
        }
        return box;
    });
    return assigned.map((box, index) => {
        const shape = box.balloon;
        if (!shape) return box;
        const peers = assigned.map((other, i) => ({ box: other, index: i }))
            .filter(other => other.index !== index && other.box.balloon === shape);
        if (!peers.length) return box;
        const distance = (x: number, y: number, b: DetBox) => Math.max(b.x1 - x, x - b.x2, 0) ** 2
            + Math.max(b.y1 - y, y - b.y2, 0) ** 2;
        const rows: number[][] = [];
        let first = -1, last = -1, minX = shape.width, maxX = 0;
        for (let k = 0; k < shape.rows.length; k++) {
            const row: number[] = [], y = shape.y1 + k;
            for (let i = 0; i < shape.rows[k].length; i += 2) {
                let start = -1;
                const end = shape.rows[k][i + 1];
                for (let x = shape.rows[k][i]; x < end; x++) {
                    const px = (x + 0.5) * W / shape.width, py = (y + 0.5) * H / shape.height;
                    const d = distance(px, py, box);
                    const own = peers.every(other => {
                        const od = distance(px, py, other.box);
                        return d < od || (d === od && index < other.index);
                    });
                    if (own && start < 0) start = x;
                    if (start >= 0 && (!own || x === end - 1)) {
                        const stop = own ? x + 1 : x;
                        row.push(start, stop); minX = Math.min(minX, start); maxX = Math.max(maxX, stop); start = -1;
                    }
                }
            }
            if (row.length) { if (first < 0) first = y; last = y; }
            rows.push(row);
        }
        const owned: ModelBalloon = { ...shape, x1: minX, y1: first, x2: maxX, y2: last + 1,
            rows: rows.slice(first - shape.y1, last - shape.y1 + 1) };
        let ink = 0, covered = 0;
        for (let y = Math.max(0, Math.floor(box.y1)); y < Math.min(H, Math.ceil(box.y2)); y++) {
            const row = balloonRow(owned, y, W, H);
            for (let x = Math.max(0, Math.floor(box.x1)); x < Math.min(W, Math.ceil(box.x2)); x++) {
                if (!data[y * W + x]) continue;
                ink++; if (row.some((a, i) => i % 2 === 0 && x >= a && x < row[i + 1])) covered++;
            }
        }
        const { balloon: _old, ...plain } = box;
        return first >= 0 && ink >= 4 && covered >= ink * 0.95 ? { ...plain, balloon: owned } : plain;
    });
}

interface Pixels { width: number; height: number; data: Uint8ClampedArray }
interface TextMask { width: number; height: number; data: ArrayBuffer }
const surfaceCache = new WeakMap<Pixels, WeakMap<ArrayBuffer, WeakMap<ModelBalloon, Map<string, BalloonSurface | null>>>>();

// The model bounds the search; original pixels keep internal walls and artwork out.
// Text ownership and erase masks remain independent of the resulting placement surface.
export function modelBalloonSurface(img: Pixels, box: DetBox, mask?: TextMask): BalloonSurface | null {
    const shape = box.balloon;
    const { width: W, height: H, data } = img;
    if (!shape || !mask || mask.width !== W || mask.height !== H || mask.data.byteLength !== W * H
        || !(shape.width > 0 && shape.height > 0) || shape.rows.length !== shape.y2 - shape.y1
        || Math.abs((shape.width / shape.height) / (W / H) - 1) > 0.005) return null;
    const masks = surfaceCache.get(img) ?? new WeakMap<ArrayBuffer, WeakMap<ModelBalloon, Map<string, BalloonSurface | null>>>();
    surfaceCache.set(img, masks);
    const cache = masks.get(mask.data) ?? new WeakMap<ModelBalloon, Map<string, BalloonSurface | null>>(); masks.set(mask.data, cache);
    const keyed = cache.get(shape) ?? new Map<string, BalloonSurface | null>(); cache.set(shape, keyed);
    const key = `${box.x1},${box.y1},${box.x2},${box.y2}`;
    if (keyed.has(key)) return keyed.get(key)!;
    const result = measure(); keyed.set(key, result); return result;

    function measure(): BalloonSurface | null {
        const s = shape!;
        const x0 = Math.max(0, Math.floor(s.x1 * W / s.width)), x2 = Math.min(W, Math.ceil(s.x2 * W / s.width));
        const y0 = Math.max(0, Math.floor(s.y1 * H / s.height)), y2 = Math.min(H, Math.ceil(s.y2 * H / s.height));
        const rw = x2 - x0, rh = y2 - y0;
        if (rw <= 0 || rh <= 0 || rw * rh > 1_500_000) return null;
        const mk = new Uint8Array(mask!.data), allowed = new Uint8Array(rw * rh), visited = new Uint8Array(rw * rh);
        for (let y = y0; y < y2; y++) {
            const row = balloonRow(s, y, W, H);
            if (row.length % 2 || row.some((x, i) => !Number.isFinite(x) || (i > 0 && x < row[i - 1]))) return null;
            for (let i = 0; i < row.length; i += 2) {
                const a = Math.max(x0, row[i]), b = Math.min(x2, row[i + 1]);
                if (b > a) allowed.fill(1, (y - y0) * rw + a - x0, (y - y0) * rw + b - x0);
            }
        }
        const seed = interiorSeed(data, W, H, box, mk);
        const cx = (box.x1 + box.x2) / 2, cy = (box.y1 + box.y2) / 2;
        const probes: [number, number][] = [[box.x1 - 3, cy], [box.x2 + 3, cy], [cx, box.y1 - 3], [cx, box.y2 + 3]];
        for (const fy of [0.1, 0.5, 0.9]) for (const fx of [0.1, 0.5, 0.9]) probes.push([
            box.x1 + (box.x2 - box.x1) * fx, box.y1 + (box.y2 - box.y1) * fy,
        ]);
        let best: BalloonSurface | null = null, tag = 0;
        const queue = new Int32Array(rw * rh);
        for (const [px, py] of probes) {
            const sx = Math.floor(px), sy = Math.floor(py);
            if (sx < x0 || sx >= x2 || sy < y0 || sy >= y2) continue;
            const start = (sy - y0) * rw + sx - x0;
            if (!allowed[start] || visited[start] || !seedLike(data, (sy * W + sx) * 4, seed)) continue;
            tag++; let head = 0, count = 1;
            queue[0] = start; visited[start] = tag;
            let minY = sy, maxY = sy;
            while (head < count) {
                const p = queue[head++], x = x0 + p % rw, y = y0 + Math.floor(p / rw);
                minY = Math.min(minY, y); maxY = Math.max(maxY, y);
                for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                    const xx = x + dx, yy = y + dy;
                    if (xx < x0 || xx >= x2 || yy < y0 || yy >= y2) continue;
                    const q = (yy - y0) * rw + xx - x0;
                    if (!allowed[q] || visited[q] || !seedLike(data, (yy * W + xx) * 4, seed)) continue;
                    visited[q] = tag; queue[count++] = q;
                }
            }
            if (count < 64 || (best && count <= best.count)) continue;
            const left = new Int32Array(maxY - minY + 1).fill(W), right = new Int32Array(left.length).fill(-1);
            let minX = W, maxX = 0, ink = 0, covered = 0;
            for (let y = minY; y <= maxY; y++) {
                let edgeL = W, edgeR = -1;
                for (let x = x0; x < x2; x++) if (visited[(y - y0) * rw + x - x0] === tag) {
                    edgeL = Math.min(edgeL, x); edgeR = Math.max(edgeR, x + 1);
                }
                const spans: number[] = []; let begin = -1;
                for (let x = x0; x < x2; x++) {
                    const p = (y - y0) * rw + x - x0;
                    const own = x >= Math.floor(box.x1) && x < Math.ceil(box.x2)
                        && y >= Math.floor(box.y1) && y < Math.ceil(box.y2);
                    const free = allowed[p] && ((x >= edgeL && x < edgeR) || own);
                    if (free && begin < 0) begin = x;
                    if (begin >= 0 && (!free || x === x2 - 1)) { spans.push(begin, free ? x + 1 : x); begin = -1; }
                }
                let chosen = -1, distance = Infinity;
                for (let i = 0; i < spans.length; i += 2) {
                    const d = Math.max(spans[i] - cx, cx - spans[i + 1], 0);
                    if (d < distance) { chosen = i; distance = d; }
                }
                if (chosen >= 0) {
                    left[y - minY] = spans[chosen]; right[y - minY] = spans[chosen + 1];
                    minX = Math.min(minX, spans[chosen]); maxX = Math.max(maxX, spans[chosen + 1]);
                }
            }
            for (let y = Math.max(0, Math.floor(box.y1)); y < Math.min(H, Math.ceil(box.y2)); y++) {
                for (let x = Math.max(0, Math.floor(box.x1)); x < Math.min(W, Math.ceil(box.x2)); x++) {
                    if (!mk[y * W + x]) continue;
                    ink++;
                    if (y >= minY && y <= maxY && x >= left[y - minY] && x < right[y - minY]) covered++;
                }
            }
            if (ink >= 4 && covered >= ink * 0.95 && maxX > minX) {
                const candidate = { x1: minX, y1: minY, x2: maxX, y2: maxY + 1, left, right, seed, count };
                if (!internalDivider(img, candidate, box, mk)) best = candidate;
            }
        }
        return best;
    }
}
