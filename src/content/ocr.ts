// OCR (Tesseract/Baberu via the iframe worker), VLM image annotation, debug
// overlay views, and the LLM translate RPC (translateRegions).

import { ocrInWorker, ocrLangsInstalled, baberuOcr, baberuInstalled, panelReadingOrder, type DetectResult, type DetBox, type MtOnStatus } from './detection';
import { restoreDetection } from './retained-detection';
import { canvasJpegB64 } from './encode';
import { EMPTY_CONTEXT, type ContextState, type RegionInput, type RegionOutput, type ExtraRegion, type Mention, type BookOp, type ImageContent } from '../llm/core';
import { isDebug } from '../debug';
import { pipeline, context, setContext, shareContext, loadContext, saveContext, chapterKey, resolveMangaId, bookKey, uniquePages, pages } from './state';
import type { PageState } from './state';
import { fetchBitmap } from './page-io';
import { readProgressT0, writeProgressT0, cacheKey, settingsFingerprint, cachePut, partialEntry, pageHashFromBitmap, annotFont, withSources, regionChunks, nextChunkSize, requestImages, INPAINT_PATCH_GEN } from './page-cache';
import { chosenOrientation, pageArea, effBoxesForAreas, expandCropToInk, balloonHint, type TextMask } from './render';
import { erasePlan, computeAiPatches, type AiPatches } from './inpaint';
import { type InpaintPatch } from './detection';
import { inpaintMode } from '../llm/pipeline-settings';
import { savedOriginal } from './page-identity';
import { cacheReady, cacheGeneration, cacheCurrent, assertCacheCurrent } from '../cache-generation';
import { PageTimer } from '../page-timing';
import { sendToBackground } from '../bg-rpc';
import { recordChapterLog } from '../chapter/log-store';
import type { ChapterTrace } from '../chapter/log';
import { planAnnotations, drawAnnotations, sourceExtras } from './vlm-annotations';
import { checkCancelled, cancellable } from './cancellation';

// Warm-path AI cleanup: compute cleanup patches for a freshly translated page
// and hand them to the caller's cache entry. Gated on cache-on + local mode;
// `noDownload` keeps a background warm from starting the 112MB model download.
// Lo-priority ORT.
// `preWarm` is the afterOcr warm (all boxes, no keep) — reused when no keep box
// overlaps an erase box, so the priority page never waits for a second inpaint.
// Missing model / no WebGPU throws (callers surface it); anything else returns null.
export class InpaintUnavailable extends Error {
    hint: string;
    constructor(message: string, hint: string) { super(message); this.hint = hint; }
}
const INPAINT_HINT = 'Settings → Model → Text cleanup: download the AI model (needs WebGPU), or switch to the built-in fill';

// ---- live translate RPCs (user Stop) ----
// A translate RPC can sit in the background for the adapter's full 240s timeout.
// Without an abort handle the sweep's cancel flag could not take effect until that
// await settled — Stop looked dead for minutes. cancelSweep() calls abortLiveRpcs().
interface LiveRpc { abort?: () => void }
const liveRpcs = new Set<LiveRpc>();
export function abortLiveRpcs(): number {
    let n = 0;
    for (const r of [...liveRpcs]) { if (r.abort) { n++; try { r.abort(); } catch { /* already gone */ } } }
    return n;
}

// Adaptive request size for region translation: null = try the whole page in one request.
// A reply that comes back empty/formatless halves this for the rest of this script instance —
// observed behaviour only, no model table; 6 is no longer a fixed cap.
let llmChunkSize: number | null = null;

export async function warmPatches(
    bitmap: ImageBitmap, det: DetectResult, outputs: RegionOutput[],
    preWarm?: Promise<AiPatches | null>,
): Promise<{ patches: InpaintPatch[]; patchesGen: number } | null> {
    if (!pipeline.cacheEnabled) return null;
    const plan = erasePlan(det, outputs);
    if (!plan.boxesToErase.length) return null;
    const overlaps = (a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }) =>
        a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
    const keepClash = plan.keepBoxes.some(k => plan.boxesToErase.some(b => overlaps(k, b)));
    // warm patches index into det.boxes and cover every box — a keep box inside an
    // erase window means the warm saw an unclear mask, so it cannot be reused.
    const reuse = (warm: AiPatches | null): InpaintPatch[] | null => {
        if (!warm || keepClash) return null;
        const idx = new Set(plan.boxesToErase.map(b => det.boxes.indexOf(b)));
        const patches = warm.patches.filter(p => idx.has(p.i ?? -1));
        return patches.length ? patches : null;
    };
    if (inpaintMode(pipeline) !== 'local') {
        // cloud: the patches were already computed server-side inside the detect
        // roundtrip — filter to the erase plan. Full coverage or nothing (a
        // partial set would strand unerased boxes); null falls back to /v1/inpaint.
        if (keepClash) return null;
        const reuseCloud = reuse({ patches: det.cloudPatches ?? [], windows: 0, ms: 0, maskMs: 0, lockWaitMs: 0, encodeMs: 0 });
        if (!reuseCloud || reuseCloud.length !== plan.boxesToErase.length) return null;
        return { patches: reuseCloud, patchesGen: INPAINT_PATCH_GEN };
    }
    try {
        if (preWarm) {
            const patches = reuse(await preWarm);
            if (patches) return { patches, patchesGen: INPAINT_PATCH_GEN };
        }
        const r = await computeAiPatches(bitmap, det, plan.boxesToErase, plan.keepBoxes, { lo: true, noDownload: true });
        if (isDebug()) console.log('[mt] warm patches', JSON.stringify({ erase: plan.boxesToErase.length, patches: r?.patches.length ?? 0 }));
        return r?.patches.length ? { patches: r.patches, patchesGen: INPAINT_PATCH_GEN } : null;
    } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        // the model is genuinely required and genuinely missing — a silent
        // fill-down would look like a broken feature, so the caller reports it.
        if (/not downloaded yet|needs WebGPU|download failed/i.test(msg)) throw new InpaintUnavailable(msg, INPAINT_HINT);
        if (isDebug()) console.log('[mt] warm patches failed:', msg.slice(0, 140));
        return null;
    }
}

// ---- OCR (Tesseract in the iframe worker; lazy-loaded from CDN) ----

// Full-page pixels for OCR-crop expansion: read once per page, shared by every crop.
async function pageImageData(bitmap: ImageBitmap): Promise<ImageData> {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
}

// crop + rotate as needed, then OCR via the iframe's Tesseract instance
export async function ocrInWorkerPng(bitmap: ImageBitmap, box: DetBox, pageImg: ImageData): Promise<string> {
    const pad = Math.max(8, (box.y2 - box.y1) * 0.30);
    const r = expandCropToInk(pageImg, box, {
        x: Math.max(0, Math.floor(box.x1 - pad)), y: Math.max(0, Math.floor(box.y1 - pad)),
        w: Math.ceil(box.x2 - box.x1 + 2 * pad), h: Math.ceil(box.y2 - box.y1 + 2 * pad),
    });
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const w = Math.min(bitmap.width - x, Math.ceil(r.w));
    const h = Math.min(bitmap.height - y, Math.ceil(r.h));
    const vertical = (box.y2 - box.y1) / Math.max(1, box.x2 - box.x1) > pipeline.verticalThreshold;
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    if (vertical) {
        // rotate so the vertical column reads left-to-right horizontally
        const r = new OffscreenCanvas(h, w);
        const rctx = r.getContext('2d', { willReadFrequently: true })!;
        rctx.translate(h / 2, w / 2);
        rctx.rotate(Math.PI / 2);
        rctx.drawImage(bitmap, x, y, w, h, -w / 2, -h / 2, w, h);
        ctx.drawImage(r, 0, 0);
    } else {
        ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
    }
    const blob = await c.convertToBlob({ type: 'image/png' });
    const png = await blob.arrayBuffer();
    return ocrInWorker(png, pipeline.ocrLangs);
}

// Baberu crop: tight padding (~10%) — the model reads vertical text + busy
// backgrounds natively (no rotate/binarize).
async function baberuCrop(bitmap: ImageBitmap, box: DetBox, pageImg: ImageData): Promise<ArrayBuffer> {
    const pad = Math.max(4, (box.y2 - box.y1) * 0.10);
    const r = expandCropToInk(pageImg, box, {
        x: Math.max(0, Math.floor(box.x1 - pad)), y: Math.max(0, Math.floor(box.y1 - pad)),
        w: Math.ceil(box.x2 - box.x1 + 2 * pad), h: Math.ceil(box.y2 - box.y1 + 2 * pad),
    });
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const w = Math.min(bitmap.width - x, Math.ceil(r.w));
    const h = Math.min(bitmap.height - y, Math.ceil(r.h));
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return blob.arrayBuffer();
}

// Prefetch pipeline: crop of box n+1 + its vision run START while box n is
// still decoding — depth 2 keeps memory bounded.
// NOTE: the worker's ORT lock is one global chain, so the win is hiding PNG
// crop/encode + message latency, not parallel inference.
export async function baberuOcrAll(bitmap: ImageBitmap, boxes: DetBox[], pageImg: ImageData, onProgress?: (done: number, total: number) => void, opts?: { lo?: boolean }): Promise<{ texts: string[]; lockWaitMs: number }> {
    const results: string[] = [];
    let lockWaitMs = 0;
    let next = 0;
    const startOne = async (): Promise<string> => {
        const i = next++;
        if (i >= boxes.length) return '';
        const png = await baberuCrop(bitmap, boxes[i], pageImg);
        const { text, lockWaitMs: w } = await baberuOcr(png, { lo: opts?.lo });
        lockWaitMs += w;
        return text;
    };
    let pending: Promise<string> = startOne();
    for (const b of boxes) {
        const following = startOne(); // fire the next crop+OCR before awaiting this one
        results.push(await pending);
        pending = following;
        onProgress?.(results.length, boxes.length);
    }
    return { texts: results, lockWaitMs };
}

// mean saturation of the page — decides grayscale stripping
export function pageIsGrayscale(bitmap: ImageBitmap): boolean {
    const c = new OffscreenCanvas(64, 64);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    let maxSat = 0;
    for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        if (mx - mn > maxSat) maxSat = mx - mn;
    }
    return maxSat < 24;
}

// Debug views use compact red discs; their centers stay inside the canvas.
function drawBadge(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, num: number, r: number, W: number, H: number): void {
    x = Math.min(Math.max(x, r), W - r);
    y = Math.min(Math.max(y, r), H - r);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ff2222';
    ctx.fill();
    // thin white rim: separates the red disc from red/busy artwork.
    ctx.lineWidth = Math.max(1.5, r * 0.16);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${r / 0.9}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), x, y + r * 0.055);
}

// Each page keeps stable marker IDs, including inside merged/chunked requests.
// Return the content rectangle so extra coordinates exclude annotation margins.
async function annotateForVLM(bitmap: ImageBitmap, boxes: (DetBox & { marker: number })[], grayscale: boolean, segment?: { y: number; h: number }): Promise<{ image: string; width: number; height: number; content: ImageContent; radius: number }> {
    const srcY = segment?.y ?? 0;
    const srcH = segment?.h ?? bitmap.height;
    const scale = Math.min(1, pipeline.fullPageSize / Math.max(bitmap.width, srcH));
    const plan = planAnnotations(boxes.map(box => ({
        x1: box.x1 * scale, y1: (box.y1 - srcY) * scale,
        x2: box.x2 * scale, y2: (box.y2 - srcY) * scale, marker: box.marker,
    })), Math.round(bitmap.width * scale), Math.round(srcH * scale), annotFont(scale));
    const fit = Math.min(1, pipeline.fullPageSize / Math.max(plan.width, plan.height));
    const content = { x: plan.content.x * fit, y: plan.content.y * fit,
        w: plan.content.w * fit, h: plan.content.h * fit };
    const c = document.createElement('canvas');
    c.width = Math.floor(plan.width * fit); c.height = Math.floor(plan.height * fit);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    try {
        ctx.scale(fit, fit);
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, plan.width, plan.height);
        const drawSource = () => {
            ctx.save();
            if (grayscale) ctx.filter = 'grayscale(1)';
            ctx.drawImage(bitmap, 0, srcY, bitmap.width, srcH,
                plan.content.x, plan.content.y, plan.content.w, plan.content.h);
            ctx.restore();
        };
        drawSource();
        drawAnnotations(ctx, plan, drawSource);
        return { image: await canvasJpegB64(c, pipeline.jpegQuality), width: c.width, height: c.height,
            content, radius: (plan.marks[0]?.label.r ?? annotFont(scale) * 0.9) * fit };
    } finally { c.width = c.height = 0; }
}

// dark pill with exact conf in threshold units — answers "what threshold catches this box?"
function confPill(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, text: string, color: string, font: number, bold = false, right?: number): void {
    ctx.font = `${bold ? 'bold ' : ''}${Math.round(font * 0.7)}px sans-serif`;
    const w = ctx.measureText(text).width;
    if (right != null) x = right - w - 8;
    ctx.fillStyle = 'rgba(0,0,0,.65)';
    ctx.fillRect(x, y, w + 8, font * 0.8);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(text, x + 4, y + 2);
}

// Measure placement from the original pixels before drawing any overlays.
// Red owns source regions; green bounds the area; orange follows its per-row runs.
export async function renderDebugView(bitmap: ImageBitmap, boxes: DetBox[], panels: DetBox[] = [], panelNums: number[] = [], dropped: DetBox[] = [], panelDropped: DetBox[] = [], outputs: RegionOutput[] = [], mask?: TextMask, original: ImageBitmap = bitmap): Promise<string> {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(original, 0, 0, c.width, c.height);
    const frame = ctx.getImageData(0, 0, c.width, c.height);
    const textFor = (index: number) => outputs.find(o => o.index === index)?.translation ?? '';
    const effBoxes = effBoxesForAreas(ctx, frame, boxes, textFor, mask);
    const areas = effBoxes.map((b, i) => pageArea(ctx, frame, b, chosenOrientation(ctx, frame, b, textFor(i + 1), mask), mask));
    ctx.drawImage(bitmap, 0, 0);
    const font = Math.max(16, Math.round(Math.max(bitmap.width, bitmap.height) / 60));
    ctx.lineWidth = Math.max(2, font * 0.12);
    panels.forEach((p, i) => {
        ctx.strokeStyle = '#00d5ff'; // cyan: reads on both ink and paper, distinct from CTD red
        ctx.strokeRect(p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1);
        const n = panelNums[i];
    // top-right: the red CTD badge owns the top-left corner.
        confPill(ctx, p.x1, p.y1, n ? `P${n} ${p.conf.toFixed(2)}` : p.conf.toFixed(2), '#00d5ff', font, true, p.x2);
    });
    // near-misses: dimmed, conf only, no badges.
    ctx.save();
    ctx.globalAlpha = 0.65;
    ctx.strokeStyle = '#888888';
    for (const d of [...dropped, ...panelDropped]) {
        ctx.strokeRect(d.x1, d.y1, d.x2 - d.x1, d.y2 - d.y1);
        confPill(ctx, d.x1, d.y1, d.conf.toFixed(2), '#888888', font);
    }
    ctx.restore();
    ctx.save();
    ctx.setLineDash([font, font * 0.6]);
    ctx.strokeStyle = '#2bff88';
    areas.forEach(a => {
        if (a) ctx.strokeRect(a.x, a.y, a.w, a.h);
    });
    // measured per-line runs (enclosed bubbles): orange outline of the shape
    // the layout actually follows. Not drawn for the no-frame fallback.
    ctx.setLineDash([font * 0.5, font * 0.4]);
    ctx.strokeStyle = '#ffa02b';
    areas.forEach(a => {
        const prof = a?.runs;
        if (!prof) return; // forEach: skip boxes without a measured profile
        const left: [number, number][] = [], right: [number, number][] = [];
        for (let p = prof.p0; p <= prof.p1; p++) {
            const k = p - prof.p0;
            if (prof.i1[k] > prof.i2[k]) continue;
            left.push(prof.vertical ? [p, prof.i1[k]] : [prof.i1[k], p]);
            right.unshift(prof.vertical ? [p, prof.i2[k]] : [prof.i2[k], p]);
        }
        if (!left.length) return;
        ctx.beginPath();
        [...left, ...right].forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
        ctx.closePath();
        ctx.stroke();
    });
    ctx.restore();
    boxes.forEach((b, i) => {
        ctx.strokeStyle = '#ff2222';
        ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
        drawBadge(ctx, b.x1, b.y1, i + 1, font * 0.9, bitmap.width, bitmap.height);
        const ly = Math.min(b.y2 + 2, bitmap.height - font);
        confPill(ctx, b.x1, ly, b.conf.toFixed(2), '#fff', font);
    });
    try {
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        return URL.createObjectURL(blob);
    } finally { c.width = c.height = 0; }
}

// 1-based reading-order rank per panel index, for debug numbers
export function panelRanks(panels: DetBox[]): number[] {
    const rank = new Array(panels.length).fill(0);
    panelReadingOrder(panels, pipeline.readingDir).forEach((idx, r) => { rank[idx] = r + 1; });
    return rank;
}

// debug views for already-translated pages (render builds them inline when on).
// canvas pages build from memory — st.orig is the still-transposed CDN puzzle,
// fetching it would put boxes on the wrong layout.
export async function ensureDebugViews(): Promise<void> {
    for (const st of uniquePages()) {
        await ensurePageDebugViews(st);
    }
}
const debugWork = new WeakMap<PageState, Promise<void>>();
export async function ensurePageDebugViews(state: PageState, original?: ImageBitmap, translated?: ImageBitmap): Promise<void> {
    if (!state.det?.boxes.length || state.debug && state.debugOrig) return;
    const pending = debugWork.get(state);
    if (pending) return pending;
    const token = state.cacheEpoch ?? cacheGeneration();
    const det = restoreDetection(state.det), ranks = panelRanks(det.panels ?? []);
    const task = (async () => {
        let source = original;
        try {
            source ??= await savedOriginal(state);
            for (const side of ['debugOrig', 'debug'] as const) {
                if (state[side] || !cacheCurrent(token)) continue;
                let bitmap: ImageBitmap | undefined, owned = false;
                try {
                    bitmap = side === 'debugOrig' ? source : translated ?? state.translatedBmp;
                    if (!bitmap) {
                        bitmap = (await fetchBitmap(state.translated)).bitmap;
                        owned = true;
                    }
                    const url = await renderDebugView(bitmap, det.boxes, det.panels, ranks, det.dropped, det.panelDropped, state.outputs, det.mask, source);
                    if (!cacheCurrent(token)) { URL.revokeObjectURL(url); continue; }
                    state[side] = url;
                    if (pages.get(state.orig) === state) pages.set(url, state);
                } catch (e) {
                    if (isDebug()) console.warn('[mt] debug view failed:', e);
                } finally { if (owned) bitmap?.close(); }
            }
        } catch (e) {
            if (isDebug()) console.warn('[mt] debug original unavailable:', e);
        } finally { if (!original) source?.close(); }
    })().finally(() => { debugWork.delete(state); });
    debugWork.set(state, task);
    return task;
}

// Zoomed crop per region (upscaled so small narration text is readable).
// One reused canvas per document: per-crop canvas churn buys nothing, and the
// sync encode path (see encode.ts) is what avoids the Android blob-encoder stall.
let cropCanvas: HTMLCanvasElement | null = null;
async function cropRegion(bitmap: ImageBitmap, box: DetBox, grayscale: boolean, pageImg: ImageData, timing: PageTimer): Promise<string> {
    const pad = Math.max(8, (box.y2 - box.y1) * 0.12);
    const r = timing.measure('cropExpand', () => expandCropToInk(pageImg, box, {
        x: Math.max(0, Math.floor(box.x1 - pad)), y: Math.max(0, Math.floor(box.y1 - pad)),
        w: Math.ceil(box.x2 - box.x1 + 2 * pad), h: Math.ceil(box.y2 - box.y1 + 2 * pad),
    }));
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const w = Math.min(bitmap.width - x, Math.ceil(r.w));
    const h = Math.min(bitmap.height - y, Math.ceil(r.h));
    const scale = Math.min(3, Math.max(1, pipeline.cropSize / Math.max(w, h)));
    const cw = Math.round(w * scale), ch = Math.round(h * scale);
    if (!cropCanvas) cropCanvas = document.createElement('canvas');
    if (cropCanvas.width !== cw || cropCanvas.height !== ch) { cropCanvas.width = cw; cropCanvas.height = ch; }
    const ctx = cropCanvas.getContext('2d', { willReadFrequently: true })!;
    timing.measure('cropDraw', () => {
        ctx.imageSmoothingQuality = 'high';
        ctx.filter = grayscale ? 'grayscale(1)' : 'none';
        ctx.drawImage(bitmap, x, y, w, h, 0, 0, cw, ch);
    });
    return timing.measure('cropEncode', () => canvasJpegB64(cropCanvas!, Math.min(0.95, pipeline.jpegQuality + 0.05)));
}

export interface TranslateOutcome {
    context?: ContextState;
    outputs: RegionOutput[];
    extras: ExtraRegion[];
    mentions: Mention[]; // named people (book input — cached + replayed with outputs)
    bookOps?: BookOp[]; // merges/corrections approved this page (debug dump)
    usedLLM: boolean;
    error?: string;          // LLM failure reason (shown in status, no silent dummy)
    errorKind?: string;      // auth | ratelimit | server | network | parse
    errorHint?: string;      // actionable hint for the toast
    errorRetryAfterMs?: number; // 429: provider cooldown the content arms its auto-halt from
    annW: number; // annotated image dims (LLM coordinate space for extras)
    annH: number;
    badgeR?: number; // drawn badge radius in that space (absent: no annotated page sent)
    raw?: string;            // present unless the background is stale
    usage?: { inTok?: number; outTok?: number; cachedInTok?: number };
    llmCalls?: number;
    llmMs?: number;
    ocrStatus?: ('ok' | 'empty')[]; // per-region OCR result (engine-agnostic)
    ocrMs?: number; // wall ms of the local OCR phase (undefined when the VLM reads images)
    ocrLockWaitMs?: number; // ms Baberu runs waited on the shared ORT lock (Tesseract path: undefined)
}

export async function translateRegions(
    bitmap: ImageBitmap,
    det: DetectResult,
    onStatus: MtOnStatus,
    // fold:false leaves the book alone and returns the raw outcome for the
    // caller to fold later — parallel workers must not setContext out of order.
    // progressKey/continued: cross-document pill continuity — stamp this page's
    // LLM dispatch and count from the earliest fresh stamp. continued needs
    // caller corroboration so a dead call never inflates the counter.
    // afterOcr: OCR finished and the ORT queue just drained — lets the caller
    // start infer-lock work while the LLM is in flight.
    // valid: paused/cancelled chapter work must not dispatch another request or fold a reply.
    opts?: { fold?: boolean; progressKey?: string; continued?: boolean; lo?: boolean; afterOcr?: () => void; valid?: () => boolean; signal?: AbortSignal; shareContext?: boolean; context?: ContextState; fresh?: boolean; cacheEpoch?: string; cacheFingerprint?: string; onStarve?: () => void; regionCap?: number; checkpoint?: boolean; pageSegments?: { y: number; h: number }[]; timing?: PageTimer; chapterTrace?: ChapterTrace },
): Promise<TranslateOutcome> {
    const timing = opts?.timing ?? new PageTimer();
    const notify = onStatus;
    onStatus = (s, stage) => { timing.setStage(s); notify(s, stage); };
    const cacheEpoch = opts?.cacheEpoch ?? await cacheReady();
    const ensureCurrent = (): void => {
        checkCancelled(opts?.signal);
        assertCacheCurrent(cacheEpoch);
        if (opts?.valid && !opts.valid()) throw Object.assign(new Error('Translation stopped'), { kind: 'abort' });
    };
    ensureCurrent();
    // A fresh user intent (Re-translate) re-probes the whole page — one-off starvation must not
    // keep every later request small for the rest of the script instance. A reload resets too.
    if (opts?.fresh) llmChunkSize = null;
    if (!det.boxes.length) return { outputs: [], extras: [], mentions: [], usedLLM: false, annW: bitmap.width, annH: bitmap.height };
    // ponytail: region cap 150 — dense art pages can drown a single LLM call. A merged
    // multi-page call raises the cap to its own box total (the cap exists per request).
    const regionCap = opts?.regionCap ?? 150;
    if (det.boxes.length > regionCap) det.boxes = det.boxes.slice(0, regionCap);
    await loadContext();
    onStatus('Translating…');
    const tPrep = performance.now();
    const regions: RegionInput[] = det.boxes.map((b, i) => ({
        index: i + 1,
        source: '',           // vision mode: the model reads from the annotated image
    }));
    // post-OCR checkpoint: persist the OCR text onto the same partial entry
    // detect wrote, so a reload/retry resumes at translation instead of
    // re-paying the OCR. Written even with the cache off (in-flight work).
    const checkpointOcr = (texts: string[]) => {
        if (opts?.signal?.aborted) return;
        if (opts?.cacheFingerprint && opts.cacheFingerprint !== settingsFingerprint(pipeline)) return;
        if (opts?.checkpoint === false || det.cloudTexts || !texts.some(t => t)) return;
        const boxes = det.boxes.length === texts.length ? det.boxes : det.boxes.slice(0, texts.length);
        void cachePut(partialEntry(cacheKey(chapterKey(), pageHashFromBitmap(bitmap)), opts?.cacheFingerprint ?? settingsFingerprint(pipeline),
            { ...det, boxes, cloudTexts: texts }, bitmap.width, bitmap.height), pipeline.cacheMax, cacheEpoch);
    };
    try {
        // unified text-source axis: 'page'/'crops' = VLM reads images, 'ocr' =
        // local OCR + text-only LLM. Split pipeline transcribes in the background —
        // except cloud pages, whose texts already arrived with detection.
        const ocr = pipeline.textSource === 'ocr' || (pipeline.useOcrModel && !!det.cloudTexts?.length);
        const vision = !ocr;
        const cropsOnly = vision && pipeline.textSource === 'crops';
        let imagesB64: string[] | undefined;
        // Page-mode requests carry their annotated full page(s) FIRST; pageImages keeps that
        // prefix separate so chunked requests can re-send it with a subset of crops.
        const pageImages: string[] = [];
        const segs = opts?.pageSegments ?? [];
        let ocrStatus: ('ok' | 'empty')[] | undefined;
        let ocrMs: number | undefined;
        let ocrLockWaitMs: number | undefined;
        // dims of the annotated image the model actually sees (extras coords come
        // back in THIS space — the model can't know the full-resolution page)
        let annW = bitmap.width, annH = bitmap.height;
        let pageContent: ImageContent | undefined;
        let badgeR: number | undefined; // drawn badge radius in annW/annH px (undefined: no annotated page sent)
        // OCR crops grow past edge-cut glyphs — one shared readback, not one per region.
        const pageImg = await timing.measureAsync('pixelRead', () => pageImageData(bitmap));
        if (ocr || pipeline.useOcrModel) {
            regions.forEach((region, i) => { region.balloonHint = balloonHint(pageImg, det.boxes[i], det.mask); });
        }
        if (ocr) {
            const tOcr = performance.now();
            onStatus('Reading text…', 'ocr');
            if (det.cloudTexts) {
                // cloud path: texts arrived with detection — no local OCR models needed.
                det.cloudTexts.forEach((t, i) => { if (regions[i]) regions[i].source = t; });
            } else if (pipeline.ocrEngine === 'baberu') {
                if (!(await baberuInstalled())) {
                    throw Object.assign(
                        new Error('Baberu OCR model not installed'),
                        { kind: 'ocr', hint: 'Open Settings → Model → Text sent for translation. Select Recognized text (OCR), then download the OCR model.' },
                    );
                }
                const { texts, lockWaitMs } = await baberuOcrAll(bitmap, det.boxes, pageImg, (done, total) => {
                    if (done % 4 === 0 || done === total) onStatus(`Reading text… ${done} of ${total}`, 'ocr');
                }, { lo: opts?.lo });
                ocrLockWaitMs = lockWaitMs;
                texts.forEach((t, i) => { regions[i].source = t; });
            } else {
                const installed = new Set(await ocrLangsInstalled(pipeline.ocrLangs));
                const missing = pipeline.ocrLangs.filter(l => !installed.has(l));
                if (missing.length) {
                    throw Object.assign(
                        new Error(`OCR language model not installed (${missing.join(', ')})`),
                        { kind: 'ocr', hint: 'Open Settings → Model → Text sent for translation. Select Recognized text (OCR), then download the OCR model.' },
                    );
                }
                for (const [i, b] of det.boxes.entries()) {
                    regions[i].source = await ocrInWorkerPng(bitmap, b, pageImg);
                }
            }
            ocrStatus = regions.map(r => r.source ? 'ok' : 'empty');
            // cloud path: local spent ~0ms — the server-side number diagnoses bottlenecks.
            ocrMs = det.cloudTexts && det.cloudMs
                ? det.cloudMs.ocr
                : Math.round(performance.now() - tOcr);
            checkpointOcr(regions.map(r => r.source));
        } else {
            const gs = pipeline.grayscaleBw && pageIsGrayscale(bitmap);
            const crops: string[] = [];
            for (const box of det.boxes) crops.push(await cropRegion(bitmap, box, gs, pageImg, timing));
            const numberedBoxes = det.boxes.map((box, i) => ({ ...box, marker: regions[i].index }));
            if (!cropsOnly) regions.forEach((region, i) => {
                const page = segs.length > 1
                    ? segs.findIndex(segment => det.boxes[i].y1 >= segment.y && det.boxes[i].y1 < segment.y + segment.h) + 1
                    : 1;
                if (page < 1) throw new Error('A text region has no matching full-page image');
                region.marker = numberedBoxes[i].marker; region.page = page;
            });
            if (!cropsOnly && segs.length > 1) {
                // merged page mode: one annotated page per segment, badges numbered globally.
                // Extras stay off — their coordinates would need one shared page space.
                for (const seg of segs) {
                    const segBoxes = numberedBoxes.filter(b => b.y1 >= seg.y && b.y1 < seg.y + seg.h);
                    const annotated = await timing.measureAsync('annotate', () => annotateForVLM(bitmap, segBoxes, gs, seg));
                    pageImages.push(annotated.image);
                }
                annW = 0; annH = 0; badgeR = undefined;
            } else if (!cropsOnly) {
                const annotated = await timing.measureAsync('annotate', () => annotateForVLM(bitmap, numberedBoxes, gs));
                annW = annotated.width; annH = annotated.height;
                pageContent = annotated.content; badgeR = annotated.radius;
                pageImages.push(annotated.image);
            }
            imagesB64 = requestImages({ mode: cropsOnly ? 'crops' : 'page', pages: pageImages, crops });
        }
        timing.add('translationPrep', performance.now() - tPrep);
        timing.meta.images = imagesB64?.length ?? 0;
        timing.meta.imageChars = imagesB64?.reduce((n, image) => n + image.length, 0) ?? 0;
        // build what we send: shareContext off = standalone page (ablation);
        // toggles strip pairs / characters independently (also ablation arms)
        let ctxToSend: ContextState;
        const snapshot = opts?.context ?? context;
        if (!(opts?.shareContext ?? shareContext)) ctxToSend = EMPTY_CONTEXT;
        else if (pipeline.useContext && pipeline.useCharacters) ctxToSend = snapshot;
        else ctxToSend = {
            pairs: pipeline.useContext ? snapshot.pairs : [],
            characters: pipeline.useCharacters ? snapshot.characters : [],
        };
        // live status during the LLM call — it can take tens of seconds and the
        // previous status would otherwise look stuck.
        ensureCurrent();
        onStatus('Translating…', 'llm');
        const tLlm = performance.now();
        let llmSeconds = 0;
        const t0local = Date.now();
        if (opts?.progressKey) writeProgressT0(opts.progressKey, t0local);
        // handoff read AFTER our own write is safe by construction: handoffRead
        // takes the earliest fresh stamp, so our entry can never shadow the older twin.
        const handedT0 = opts?.continued === true && opts?.progressKey ? readProgressT0(opts.progressKey) : null;
        const tickBase = handedT0 != null && handedT0 <= t0local ? handedT0 : t0local;
        const llmTick = setInterval(() => {
            llmSeconds = Math.max(llmSeconds + 1, Math.round((Date.now() - tickBase) / 1000));
            onStatus(`Translating… ${llmSeconds}s`, 'llm');
        }, 1000);
        opts?.afterOcr?.();
        // No fixed per-request cap: try the whole page first. A reply that comes back empty or
        // without a parseable answer halves the size for this script instance and retries the
        // same regions smaller (see the work loop). The annotated full page (index 0) rides only
        // the chunk's own regions, so the prompt stays consistent per request.
        const work = regionChunks(regions, llmChunkSize ?? Math.max(1, regions.length));
        if (!work.length) work.push(regions); // parity: an empty region list still runs one request
        // Renumber each chunk to 1..n and pair it with its own crops. The prompt numbers
        // regions by `index` while the crops travel positionally, and the background reads
        // `imagesB64[index]` — so a chunk carrying page-global indices (7..12) asked for
        // "region 7" with its first crop and read crop slot 7, which either missed or
        // mismatched. Chunk-local indices keep prompt, crops and reply aligned.
        // One flat crop map for all chunks: in page mode the crops sit AFTER the annotated
        // page prefix (one image per segment in a merged request).
        const cropOf = new Map<number, string>();
        if (vision && imagesB64?.length) {
            for (let i = 0; i < regions.length; i++) {
                const img = imagesB64[cropsOnly ? i : pageImages.length + i];
                if (img) cropOf.set(regions[i].index, img);
            }
        }
        const chunkPayload = (subset: RegionInput[]): Record<string, unknown> => {
            const local = subset.map((r, i) => ({ ...r, index: i + 1 }));
            const chunkImages = imagesB64
                ? requestImages({ mode: cropsOnly ? 'crops' : 'page', pages: pageImages, crops: subset.map(r => cropOf.get(r.index)) })
                : imagesB64;
            return { ...payload, imagesB64: chunkImages, regions: local };
        };
        let resp: any;
        // transcripts seen on the interim message — if the RPC channel dies
        // mid-translate, the fallback re-sends them so the new worker translates
        // instead of re-transcribing.
        let interimTexts: string[] | null = null;
        const mergedCount = segs.length > 1 ? segs.length : 0;
        const payload = {
            type: 'mt:translate',
            imagesB64,
            regions,
            context: ctxToSend,
            vision,
            textOnly: cropsOnly || ocr,
            ocr,
            // extras need ONE page space; a merged request has several, so it opts out
            pageW: mergedCount ? undefined : annW,
            pageH: mergedCount ? undefined : annH,
            pageContent,
            pageCount: mergedCount || undefined,
            cacheKey: await resolveMangaId() ?? chapterKey(), // stable per manga → prompt-cache affinity
            bookKey: bookKey(), // scopes user overrides to this story's book
            interim: true, // this version handles the mid-flight transcripts message (see portSend)
            requestNonce: opts?.fresh ? crypto.randomUUID() : undefined,
            cacheEpoch,
            ...(opts?.chapterTrace ? { chapterTrace: { ...opts.chapterTrace, request: crypto.randomUUID() } } : {}),
        };
        recordChapterLog(payload.chapterTrace, { kind: 'llm-sent', stage: 'llmWait', boxes: regions.length,
            bytes: Math.round((timing.meta.imageChars ?? 0) * 0.75), deadlineMs: 260_000 });
        // suspend-proof channel: an open runtime port pins the background page
        // alive AND its replies always arrive (a pending sendResponse can be
        // dropped when the page suspends). Falls back to plain sendMessage.
        // The port is registered in `liveRpcs` so a user Stop can disconnect it
        // immediately — without this a hung LLM call held the page (and the pill)
        // for its full 240s adapter timeout with no way out.
        const portSend = (sendPayload: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
            let port: chrome.runtime.Port;
            try { port = chrome.runtime.connect({ name: 'mt-rpc' }); } catch (e) { reject(e); return; }
            const tRpc = Date.now();
            if (isDebug()) console.log(`[mt:trace] translateRegions RPC send (regions=${regions.length} vision=${vision} textOnly=${payload.textOnly})`);
            const stop: LiveRpc = { abort: undefined };
            let aborted = false;
            liveRpcs.add(stop);
            const cleanup = () => { liveRpcs.delete(stop); opts?.signal?.removeEventListener('abort', onAbort); };
            const onAbort = () => stop.abort?.();
            const to = setTimeout(() => { cleanup(); try { port.disconnect(); } catch { /* gone */ } console.warn(`[mt:trace] translateRegions RPC TIMEOUT after ${Date.now() - tRpc}ms`); reject(new Error('translate RPC timeout')); }, 260000);
            stop.abort = () => {
                aborted = true;
                clearTimeout(to);
                cleanup();
                console.warn(`[mt:trace] translateRegions RPC ABORTED by user after ${Date.now() - tRpc}ms`);
                try { port.disconnect(); } catch { /* gone */ }
                reject(new DOMException('Translation stopped', 'AbortError'));
            };
            opts?.signal?.addEventListener('abort', onAbort, { once: true });
            if (opts?.signal?.aborted) { onAbort(); return; }
            port.onMessage.addListener((r: unknown) => {
                // interim: the split pipeline's transcribe finished while the translate
                // call runs — checkpoint the transcripts now (the final reply settles
                // this promise).
                const m = r as { type?: string; texts?: string[] };
                if (m?.type === 'mt:ocr-texts' && Array.isArray(m.texts)) { interimTexts = m.texts; checkpointOcr(m.texts); return; }
                if (isDebug()) console.log(`[mt:trace] translateRegions RPC reply in ${Date.now() - tRpc}ms ok=${(r as {ok?:boolean})?.ok}`);
                clearTimeout(to); cleanup(); try { port.disconnect(); } catch { /* gone */ } resolve(r);
            });
            port.onDisconnect.addListener(() => {
                clearTimeout(to); cleanup();
                if (aborted) return; // the abort already rejected with a clearer message
                console.warn(`[mt:trace] translateRegions RPC DISCONNECTED after ${Date.now() - tRpc}ms`);
                reject(new Error('background disconnected'));
            });
            try { port.postMessage(sendPayload); } catch (e) { clearTimeout(to); cleanup(); reject(e); }
        });
        // Send each chunk and merge. The reply shape is the background's own
        // (`outputs`/`extras`/`mentions`/`usage`/`llmCalls`/`llmMs`), so the merged reply
        // must be rebuilt in that shape — reading `resp.regions` here silently produced an
        // empty result and every page failed with "no usable text regions parsed".
        const merged: { outputs: RegionOutput[]; extras: ExtraRegion[]; mentions: Mention[]; raw: string;
            usage: Record<string, number>; calls: number; ms: number; context?: ContextState; bookOps: BookOp[] } =
            { outputs: [], extras: [], mentions: [], raw: '', usage: {}, calls: 0, ms: 0, bookOps: [] };
        try {
            while (work.length) {
                const chunk = work.shift()!;
                ensureCurrent();
                const one = chunkPayload(chunk);
                try {
                    resp = await portSend(one);
                } catch (e) {
                    if (!/background disconnected|RPC timeout/.test(String((e as Error)?.message ?? ''))) throw e;
                    // wake-race / no listener: retry the classic channel on a rising
                    // backoff before giving up entirely.
                    let lastErr: unknown = e;
                    for (const wait of [5000, 20000, 60000]) {
                        await cancellable(new Promise(r => setTimeout(r, wait)), opts?.signal);
                        ensureCurrent();
                        try {
                            // transcripts already paid for: the re-send is the same text-only
                            // translate stage, not a re-transcription (images dropped too).
                            const retryPayload = interimTexts
                                ? { ...one, imagesB64: undefined, regions: withSources(one.regions as RegionInput[], interimTexts), vision: false, textOnly: true, ocr: true }
                                : one;
                            resp = await cancellable(sendToBackground(retryPayload, { timeoutMs: 260_000, label: 'translate retry' }), opts?.signal);
                            lastErr = null;
                            break;
                        } catch (e2) {
                            lastErr = e2;
                            if (!/Receiving end/.test(String((e2 as Error)?.message ?? ''))) throw e2;
                        }
                    }
                    if (lastErr) throw lastErr;
                }
                ensureCurrent();
                if (!resp?.ok) {
                    const err = new Error(resp?.error ?? 'translate RPC failed') as Error & { kind?: string; hint?: string; retryAfterMs?: number };
                    err.kind = resp?.kind; err.hint = resp?.hint; err.retryAfterMs = resp?.retryAfterMs;
                    // Size-sensitive failure (empty answer / ignored format): split the same
                    // regions and retry smaller before failing the page; remember the size.
                    if (resp?.kind === 'parse' && chunk.length > 1) {
                        llmChunkSize = nextChunkSize(chunk.length);
                        console.warn(`[mt:trace] chunk starved at ${chunk.length} regions — retrying as ${llmChunkSize}`);
                        opts?.onStarve?.();
                        work.unshift(...regionChunks(chunk, llmChunkSize));
                        continue;
                    }
                    throw err;
                }
                // Replies carry chunk-local indices; map them back to the page's own
                // numbering, or the renderer paints crop 1's text on region 7.
                const globalOf = new Map(chunk.map((r, i) => [i + 1, r.index]));
                const lift = <T extends { index: number }>(list: T[]): T[] =>
                    list.map(o => ({ ...o, index: globalOf.get(o.index) ?? o.index }));
                merged.outputs.push(...lift(resp.outputs as RegionOutput[] ?? []));
                merged.extras.push(...(resp.extras ?? []));
                merged.mentions.push(...(resp.mentions ?? []));
                merged.bookOps.push(...(resp.bookOps ?? []));
                merged.raw += (merged.raw ? '\n' : '') + (resp.raw ?? '');
                for (const [k, v] of Object.entries(resp.usage ?? {})) merged.usage[k] = (merged.usage[k] ?? 0) + Number(v ?? 0);
                merged.calls += resp.llmCalls ?? 0;
                merged.ms += resp.llmMs ?? 0;
                if (typeof resp.provider === 'string') timing.meta.provider = resp.provider;
                if (typeof resp.model === 'string') timing.meta.model = resp.model;
                // The book context is the last chunk's own view; every chunk ran against the
                // same snapshot, so the final one is as correct as any single-request run.
                if (resp.context) merged.context = resp.context as ContextState;
            }
        } finally {
            clearInterval(llmTick);
            timing.add('llm', performance.now() - tLlm);
        }
        timing.meta.calls = merged.calls;
        timing.meta.apiMs = merged.ms;
        timing.meta.inTok = merged.usage.inTok;
        timing.meta.outTok = merged.usage.outTok;
        resp = { ok: true, outputs: merged.outputs, extras: merged.extras, mentions: merged.mentions,
            bookOps: merged.bookOps, raw: merged.raw, usage: merged.usage, llmCalls: merged.calls,
            llmMs: merged.ms, context: merged.context };
        // extras arrive in annotated-image space → rescale to full-page pixels.
        const rawExtras: ExtraRegion[] = resp.extras ?? [];
        const extras: ExtraRegion[] = (mergedCount ? [] : sourceExtras(rawExtras,
            pageContent ?? { x: 0, y: 0, w: annW, h: annH }, bitmap.width, bitmap.height))
            .filter(e =>
                e.x2 > e.x1 && e.y2 > e.y1 &&
                e.x2 <= bitmap.width * 1.05 && e.y2 <= bitmap.height * 1.05 &&
                (e.x2 - e.x1) > 12 && (e.y2 - e.y1) > 12);
        ensureCurrent();
        if (opts?.fold !== false && (opts?.shareContext ?? shareContext)) {
            ensureCurrent();
            const c = resp.context as ContextState | undefined;
            setContext((c && Array.isArray(c.characters) && Array.isArray(c.pairs)) ? c : context);
            await saveContext();
        }
        return {
            context: resp.context as ContextState | undefined,
            outputs: resp.outputs as RegionOutput[], extras, usedLLM: true, annW, annH,
            ...(badgeR != null ? { badgeR } : null),
            mentions: (resp.mentions ?? []) as Mention[],
            bookOps: (resp.bookOps ?? []) as BookOp[],
            raw: resp.raw as string | undefined,
            usage: resp.usage, llmCalls: resp.llmCalls, llmMs: resp.llmMs,
            // split pipeline: transcription stats come back from the background
            ocrStatus: (resp.ocrStatus ?? ocrStatus) as ('ok' | 'empty')[] | undefined, ocrMs: resp.ocrMs ?? ocrMs,
            ocrLockWaitMs,
        };
    } catch (e) {
        checkCancelled(opts?.signal);
        assertCacheCurrent(cacheEpoch);
        const err = e as Error & { kind?: string; hint?: string; retryAfterMs?: number };
        const error = String(err.message ?? e).slice(0, 160);
        console.warn('[mt] LLM translation failed:', e);
        return {
            outputs: [], extras: [], mentions: [], usedLLM: false, error,
            errorKind: err.kind, errorHint: err.hint, errorRetryAfterMs: err.retryAfterMs,
            annW: bitmap.width, annH: bitmap.height,
        };
    }
}
