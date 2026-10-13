import { koharuThresholds, type KoharuThresholds } from '../layout-model';
import type { DetBox } from '../content/detection';
import type { ModelBalloon } from '../content/model-balloon';

export const KOHARU_INPUT = 1152;
interface TensorData { dims: readonly number[]; data: Float32Array }
export interface KoharuOutput { dets: TensorData; labels: TensorData; masks: TensorData }

interface Sample { start: number; weights: Float32Array }
function samples(input: number, output: number): Sample[] {
    const scale = Math.fround(input / output), support = Math.max(1, scale);
    const inverse = Math.fround(1 / support);
    return Array.from({ length: output }, (_, i) => {
        const center = Math.fround((i + 0.5) * scale);
        const start = Math.max(0, Math.floor(Math.fround(center - support) + 0.5));
        const end = Math.min(input, Math.floor(Math.fround(center + support) + 0.5));
        const weights = new Float32Array(end - start);
        let sum = 0;
        for (let j = start; j < end; j++) {
            const distance = Math.fround((Math.fround(j - center) + 0.5) * inverse);
            weights[j - start] = Math.max(0, Math.fround(1 - Math.abs(distance)));
            sum = Math.fround(sum + weights[j - start]);
        }
        for (let j = 0; j < weights.length; j++) weights[j] /= sum;
        return { start, weights };
    });
}

// RGB float antialiased bilinear resize, followed by ImageNet normalization in NCHW.
export function koharuInput(rgba: Uint8ClampedArray, w: number, h: number, size = KOHARU_INPUT): Float32Array {
    if (rgba.length !== w * h * 4 || w < 1 || h < 1 || size < 1) throw new Error('Invalid Koharu image dimensions');
    const xs = samples(w, size), ys = samples(h, size);
    const horizontal = new Float32Array(h * size * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < size; x++) {
        const sample = xs[x], dest = (y * size + x) * 3;
        for (let c = 0; c < 3; c++) {
            let value = 0;
            for (let j = 0; j < sample.weights.length; j++) value = Math.fround(value + Math.fround(Math.fround(rgba[(y * w + sample.start + j) * 4 + c] / 255) * sample.weights[j]));
            horizontal[dest + c] = value;
        }
    }
    const out = new Float32Array(3 * size * size), mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let c = 0; c < 3; c++) {
        const sample = ys[y];
        let value = 0;
        for (let j = 0; j < sample.weights.length; j++) value = Math.fround(value + Math.fround(horizontal[((sample.start + j) * size + x) * 3 + c] * sample.weights[j]));
        out[c * size * size + y * size + x] = Math.fround(value - Math.fround(mean[c])) / Math.fround(std[c]);
    }
    return out;
}

export function decodeKoharu(output: KoharuOutput, w: number, h: number, thresholds?: Partial<KoharuThresholds>, minSize = 1) {
    const { dets, labels, masks } = output;
    if (!dets || !labels || !masks || dets.dims.join(',') !== '1,300,4' || labels.dims.join(',') !== '1,300,5'
        || masks.dims.join(',') !== '1,300,288,288'
        || dets.data.length !== 1200 || labels.data.length !== 1500 || masks.data.length !== 300 * 288 * 288) {
        throw new Error('Koharu model outputs do not match the installed FP32 model');
    }
    for (const tensor of [dets, labels, masks]) {
        for (const value of tensor.data) if (!Number.isFinite(value)) throw new Error('Koharu returned invalid values');
    }
    const t = koharuThresholds(thresholds), limits = [t.text, t.sfx, t.bubble, t.panel];
    const choices = Array.from(labels.data, (logit, i) => ({ query: Math.floor(i / 5), classId: i % 5, conf: 1 / (1 + Math.exp(-logit)) }));
    choices.sort((a, b) => b.conf - a.conf);
    const boxes: DetBox[] = [], panels: DetBox[] = [], bubbles: DetBox[] = [], dropped: DetBox[] = [];
    const inkQueries = new Set<number>(), bubbleQueries: { query: number; box: DetBox }[] = [];
    for (const candidate of choices.slice(0, 160)) {
        const { query, classId, conf } = candidate;
        if (classId >= 4) continue;
        const i = query * 4, [cx, cy, bw, bh] = dets.data.subarray(i, i + 4);
        const box = { x1: Math.max(0, (cx - bw / 2) * w), y1: Math.max(0, (cy - bh / 2) * h),
            x2: Math.min(w, (cx + bw / 2) * w), y2: Math.min(h, (cy + bh / 2) * h), conf };
        if (box.x2 <= box.x1 || box.y2 <= box.y1) continue;
        if (conf < limits[classId]) { if (classId < 2 && conf >= 0.05 && dropped.length < 40) dropped.push(box); continue; }
        if (classId < 2) {
            if (box.x2 - box.x1 <= minSize || box.y2 - box.y1 <= minSize) continue;
            boxes.push(box); inkQueries.add(query);
        } else if (classId === 2) { bubbles.push(box); bubbleQueries.push({ query, box }); }
        else panels.push(box);
    }
    const mask = new Uint8Array(w * h), side = 288;
    const xs = Array.from({ length: w }, (_, x) => {
        const f = (x + 0.5) * side / w - 0.5, lo = Math.floor(f);
        return { lo: Math.max(0, lo), hi: Math.min(side - 1, lo + 1), frac: f - lo };
    });
    // Interpolate instance logits before thresholding; bubble/panel masks never erase artwork.
    for (const query of inkQueries) for (let y = 0; y < h; y++) {
        const f = (y + 0.5) * side / h - 0.5, lo = Math.floor(f), fy = f - lo;
        const a = query * side * side + Math.max(0, lo) * side;
        const b = query * side * side + Math.min(side - 1, lo + 1) * side;
        for (let x = 0; x < w; x++) {
            if (mask[y * w + x]) continue;
            const { lo: x0, hi: x1, frac } = xs[x];
            const v0 = masks.data[a + x0] * (1 - frac) + masks.data[a + x1] * frac;
            const v1 = masks.data[b + x0] * (1 - frac) + masks.data[b + x1] * frac;
            if (v0 * (1 - fy) + v1 * fy > 0) mask[y * w + x] = 255;
        }
    }
    const balloons: ModelBalloon[] = [];
    for (const { query, box } of bubbleQueries) {
        const x0 = Math.max(0, Math.floor(box.x1)), x2 = Math.min(w, Math.ceil(box.x2));
        const y0 = Math.max(0, Math.floor(box.y1)), y2 = Math.min(h, Math.ceil(box.y2));
        const rows: number[][] = [];
        let minX = w, maxX = 0, first = -1, last = -1;
        for (let y = y0; y < y2; y++) {
            const f = (y + 0.5) * side / h - 0.5, lo = Math.floor(f), fy = f - lo;
            const a = query * side * side + Math.max(0, lo) * side;
            const b = query * side * side + Math.min(side - 1, lo + 1) * side;
            const row: number[] = [];
            let start = -1;
            for (let x = x0; x < x2; x++) {
                const { lo: xlo, hi: xhi, frac } = xs[x];
                const v0 = masks.data[a + xlo] * (1 - frac) + masks.data[a + xhi] * frac;
                const v1 = masks.data[b + xlo] * (1 - frac) + masks.data[b + xhi] * frac;
                const inside = v0 * (1 - fy) + v1 * fy > 0;
                if (inside && start < 0) start = x;
                if (start >= 0 && (!inside || x === x2 - 1)) {
                    const end = inside ? x + 1 : x;
                    row.push(start, end); minX = Math.min(minX, start); maxX = Math.max(maxX, end); start = -1;
                }
            }
            if (row.length) { if (first < 0) first = y; last = y; }
            rows.push(row);
        }
        if (first >= 0 && maxX > minX) balloons.push({ width: w, height: h, x1: minX, y1: first, x2: maxX, y2: last + 1,
            conf: box.conf, rows: rows.slice(first - y0, last - y0 + 1) });
    }
    return { boxes, panels, bubbles, balloons, dropped, mask: { width: w, height: h, data: mask.buffer as ArrayBuffer } };
}
