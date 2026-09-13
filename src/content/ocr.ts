// OCR (Tesseract/Baberu via the iframe worker), VLM image annotation, debug
// overlay views, and the LLM translate RPC (translateRegions).

import { ocrInWorker, ocrLangsInstalled, baberuOcr, baberuInstalled, panelReadingOrder, type DetectResult, type DetBox, type MtOnStatus } from './detection';
import { EMPTY_CONTEXT, type ContextState, type RegionInput, type RegionOutput, type ExtraRegion, type Mention, type BookOp } from '../llm/core';
import { isDebug } from '../debug';
import { pipeline, context, setContext, shareContext, loadContext, saveContext, chapterKey, resolveMangaId, uniquePages, pages } from './state';
import type { PageState } from './state';
import { fetchBitmap } from './page-io';
import { readProgressT0, writeProgressT0 } from './page-cache';

// ---- OCR (Tesseract in the iframe worker; lazy-loaded from CDN) ----

// crop + rotate as needed, then OCR via the iframe's Tesseract instance
export async function ocrInWorkerPng(bitmap: ImageBitmap, box: DetBox): Promise<string> {
    const pad = Math.max(8, (box.y2 - box.y1) * 0.30);
    const x = Math.max(0, Math.floor(box.x1 - pad));
    const y = Math.max(0, Math.floor(box.y1 - pad));
    const w = Math.min(bitmap.width - x, Math.ceil(box.x2 - box.x1 + 2 * pad));
    const h = Math.min(bitmap.height - y, Math.ceil(box.y2 - box.y1 + 2 * pad));
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

// Baberu crop: tight padding (~10%) — the model was trained on tight bubble
// crops and reads vertical text + busy backgrounds natively (no rotate/binarize)
async function baberuCrop(bitmap: ImageBitmap, box: DetBox): Promise<ArrayBuffer> {
    const pad = Math.max(4, (box.y2 - box.y1) * 0.10);
    const x = Math.max(0, Math.floor(box.x1 - pad));
    const y = Math.max(0, Math.floor(box.y1 - pad));
    const w = Math.min(bitmap.width - x, Math.ceil(box.x2 - box.x1 + 2 * pad));
    const h = Math.min(bitmap.height - y, Math.ceil(box.y2 - box.y1 + 2 * pad));
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return blob.arrayBuffer();
}

// Prefetch pipeline: crop of box n+1 + its vision run START while box n is
// still decoding — the per-session locks in the worker make the vision of
// the next box overlap the decode of the current one (OCR ~40s → ~15s/page).
// Depth 2 keeps memory bounded (two decoded KV states max).
export async function baberuOcrAll(bitmap: ImageBitmap, boxes: DetBox[], onProgress?: (done: number, total: number) => void): Promise<string[]> {
    const results: string[] = [];
    let next = 0;
    const startOne = async (): Promise<string> => {
        const i = next++;
        if (i >= boxes.length) return '';
        const png = await baberuCrop(bitmap, boxes[i]);
        return baberuOcr(png);
    };
    let pending: Promise<string> = startOne();
    for (const b of boxes) {
        const following = startOne(); // fire the next crop+OCR before awaiting this one
        results.push(await pending);
        pending = following;
        onProgress?.(results.length, boxes.length);
    }
    return results;
}

// JPEG base64 helper. Grayscale strips ~2/3 of the payload on B&W pages.
// FileReader (not arrayBuffer + fromCharCode-spread + btoa): pulling a canvas
// JPEG blob's bytes through JS TypedArrays throws "Permission denied to access
// property constructor" on Firefox (live-proven) — the data URL hands back a
// plain string instead. Same output on Chromium.
async function toJpegB64(canvas: OffscreenCanvas, quality: number): Promise<string> {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const dataUrl: string = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onerror = () => reject(fr.error ?? new Error('readAsDataURL failed'));
        fr.onload = () => resolve(fr.result as string);
        fr.readAsDataURL(blob);
    });
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
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

// one numbered badge: red disc + white number, the same mark the VLM sees.
// center clamped into the canvas — edge boxes (x1≈0) lost their badge off-canvas.
function drawBadge(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, num: number, r: number, W: number, H: number): void {
    x = Math.min(Math.max(x, r), W - r);
    y = Math.min(Math.max(y, r), H - r);
    ctx.fillStyle = '#ff2222';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${r / 0.9}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), x, y + r * 0.055);
}

// Draw numbered badges over each region so the VLM can map them, downscale.
async function annotateForVLM(bitmap: ImageBitmap, boxes: DetBox[], grayscale: boolean): Promise<string> {
    const scale = Math.min(1, pipeline.fullPageSize / Math.max(bitmap.width, bitmap.height));
    const c = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const ctx = c.getContext('2d')!;
    if (grayscale) ctx.filter = 'grayscale(1)';
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    const font = Math.max(18, Math.round(28 * scale * 2));
    boxes.forEach((b, i) => drawBadge(ctx, b.x1 * scale, b.y1 * scale, i + 1, font * 0.9, c.width, c.height));
    return toJpegB64(c, pipeline.jpegQuality); // keep badges red
}

// dark pill with exact conf in threshold units (0.xx) — answers directly
// "what threshold catches this box?"
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

// full-res debug view: translated image + CTD boxes/badges/conf, YOLO panels
// (cyan, numbered in reading order). Below-threshold near-misses draw dimmed
// gray with conf and NO badge — a badge means "translated in this order".
export async function renderDebugView(bitmap: ImageBitmap, boxes: DetBox[], panels: DetBox[] = [], panelNums: number[] = [], dropped: DetBox[] = [], panelDropped: DetBox[] = []): Promise<string> {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const font = Math.max(16, Math.round(Math.max(bitmap.width, bitmap.height) / 60));
    ctx.lineWidth = Math.max(2, font * 0.12);
    panels.forEach((p, i) => {
        ctx.strokeStyle = '#00d5ff'; // cyan: reads on both ink and paper, distinct from CTD red
        ctx.strokeRect(p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1);
        const n = panelNums[i];
        // top-right: the red CTD badge owns the top-left corner
        confPill(ctx, p.x1, p.y1, n ? `P${n} ${p.conf.toFixed(2)}` : p.conf.toFixed(2), '#00d5ff', font, true, p.x2);
    });
    // near-misses (under everything live): dimmed, conf only, no badges
    ctx.save();
    ctx.globalAlpha = 0.65;
    ctx.strokeStyle = '#888888';
    for (const d of [...dropped, ...panelDropped]) {
        ctx.strokeRect(d.x1, d.y1, d.x2 - d.x1, d.y2 - d.y1);
        confPill(ctx, d.x1, d.y1, d.conf.toFixed(2), '#888888', font);
    }
    ctx.restore();
    boxes.forEach((b, i) => {
        ctx.strokeStyle = '#ff2222';
        ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
        drawBadge(ctx, b.x1, b.y1, i + 1, font * 0.9, bitmap.width, bitmap.height);
        const ly = Math.min(b.y2 + 2, bitmap.height - font);
        confPill(ctx, b.x1, ly, b.conf.toFixed(2), '#fff', font);
    });
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return URL.createObjectURL(blob);
}

// 1-based reading-order rank per panel index, for debug numbers
export function panelRanks(panels: DetBox[]): number[] {
    const rank = new Array(panels.length).fill(0);
    panelReadingOrder(panels, pipeline.readingDir).forEach((idx, r) => { rank[idx] = r + 1; });
    return rank;
}

// debug views for already-translated pages (render builds them inline when on).
// one per frame so Original/Translate toggle keeps its debug boxes.
// canvas pages build from memory (stashed descrambled bytes + kept translated
// bitmap) — st.orig is the still-transposed CDN puzzle, fetching it would put
// boxes on the wrong layout.
export async function ensureDebugViews(): Promise<void> {
    for (const st of uniquePages()) {
        if (!st.det?.boxes.length || (st.debug && st.debugOrig)) continue;
        if (st.origBytes || st.translatedBmp) {
            try {
                const ranks = panelRanks(st.det.panels ?? []);
                if (!st.debugOrig) {
                    const orig = await canvasPaintSrc(st, 'orig');
                    if (orig) {
                        st.debugOrig = await renderDebugView(orig, st.det.boxes, st.det.panels, ranks, st.det.dropped, st.det.panelDropped);
                        pages.set(st.debugOrig, st);
                    }
                }
                if (!st.debug && st.translatedBmp) {
                    st.debug = await renderDebugView(st.translatedBmp, st.det.boxes, st.det.panels, ranks, st.det.dropped, st.det.panelDropped);
                    pages.set(st.debug, st);
                }
            } catch (e) {
                if (isDebug()) console.warn('[mt] debug view failed:', e);
            }
            continue;
        }
        if (!/^(blob:|https?:)/.test(st.orig)) continue;
        try {
            const ranks = panelRanks(st.det.panels ?? []);
            if (!st.debugOrig) {
                st.debugOrig = await renderDebugView((await fetchBitmap(st.orig)).bitmap, st.det.boxes, st.det.panels, ranks, st.det.dropped, st.det.panelDropped);
                pages.set(st.debugOrig, st);
            }
            if (!st.debug) {
                st.debug = await renderDebugView((await fetchBitmap(st.translated)).bitmap, st.det.boxes, st.det.panels, ranks, st.det.dropped, st.det.panelDropped);
                pages.set(st.debug, st);
            }
        } catch (e) {
            console.warn('[mt] debug view failed:', e);
        }
    }
}

// canvas paint sources (imported from state-adjacent logic; lives with the
// debug views that need it) — kept local to avoid a page-io cycle
async function canvasPaintSrc(state: PageState, which: 'orig' | 'translated' | 'debug' | 'debugOrig'): Promise<ImageBitmap | undefined> {
    if (which === 'translated') return state.translatedBmp;
    if (which === 'orig') {
        if (!state.origBmp && state.origBytes) {
            try {
                state.origBmp = await createImageBitmap(new Blob([state.origBytes]));
            } catch { return undefined; }
        }
        return state.origBmp;
    }
    const key = which === 'debug' ? 'debugBmp' : 'debugOrigBmp';
    const url = which === 'debug' ? state.debug : state.debugOrig;
    if (!state[key] && url) {
        try {
            state[key] = await createImageBitmap(await (await fetch(url)).blob());
        } catch { return undefined; }
    }
    return state[key];
}

// Zoomed crop per region (upscaled so small narration text is readable).
async function cropRegion(bitmap: ImageBitmap, box: DetBox, grayscale: boolean): Promise<string> {
    const pad = Math.max(8, (box.y2 - box.y1) * 0.12);
    const x = Math.max(0, Math.floor(box.x1 - pad));
    const y = Math.max(0, Math.floor(box.y1 - pad));
    const w = Math.min(bitmap.width - x, Math.ceil(box.x2 - box.x1 + 2 * pad));
    const h = Math.min(bitmap.height - y, Math.ceil(box.y2 - box.y1 + 2 * pad));
    const scale = Math.min(3, Math.max(1, pipeline.cropSize / Math.max(w, h)));
    const c = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale));
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    if (grayscale) ctx.filter = 'grayscale(1)';
    ctx.drawImage(bitmap, x, y, w, h, 0, 0, c.width, c.height);
    return toJpegB64(c, Math.min(0.95, pipeline.jpegQuality + 0.05));
}

export interface TranslateOutcome {
    outputs: RegionOutput[];
    extras: ExtraRegion[];
    mentions: Mention[]; // named people (book input — cached + replayed with outputs)
    bookOps?: BookOp[]; // merges/corrections approved this page (debug dump)
    usedLLM: boolean;
    error?: string;          // LLM failure reason (shown in status, no silent dummy)
    errorKind?: string;      // auth | ratelimit | server | network | parse
    errorHint?: string;      // actionable hint for the toast
    annW: number; // annotated image dims (LLM coordinate space for extras)
    annH: number;
    raw?: string;            // present unless the background is stale
    usage?: { inTok?: number; outTok?: number; cachedInTok?: number };
    llmCalls?: number;
    llmMs?: number;
    ocrStatus?: ('ok' | 'empty')[]; // per-region OCR result (engine-agnostic)
    ocrMs?: number; // wall ms of the local OCR phase (undefined when the VLM reads images)
}

export async function translateRegions(
    bitmap: ImageBitmap,
    det: DetectResult,
    onStatus: MtOnStatus,
    // fold:false leaves the book alone and returns the raw outcome for the
    // caller to fold later — parallel workers must not setContext out of
    // order (each response is folded over its dispatch-time snapshot, so a
    // late page would clobber earlier commits). Default folds immediately,
    // exactly like before.
    // progressKey/continued: cross-document pill continuity — stamp this
    // page's LLM dispatch and count from the earliest fresh stamp (an arrival
    // continuing a shared SW call) instead of restarting at 1s. continued
    // needs caller corroboration (resumed checkpoint, or no cache to resume
    // from) so a dead call never inflates the counter; force callers drop the
    // entry first (fresh work counts fresh).
    opts?: { fold?: boolean; progressKey?: string; continued?: boolean },
): Promise<TranslateOutcome> {
    if (!det.boxes.length) return { outputs: [], extras: [], mentions: [], usedLLM: false, annW: bitmap.width, annH: bitmap.height };
    // ponytail: region cap 150 — dense art pages can drown a single LLM call;
    // detector output is normally ≤60. Add a "translate top N" flow if real
    // pages ever hit this.
    if (det.boxes.length > 150) det.boxes = det.boxes.slice(0, 150);
    await loadContext();
    onStatus('Translating…');
    const regions: RegionInput[] = det.boxes.map((b, i) => ({
        index: i + 1,
        source: '',           // vision mode: the model reads from the annotated image
    }));
    try {
        // unified text-source axis: 'page'/'crops' = VLM reads images, 'ocr' =
        // Tesseract reads locally and the LLM gets text only. Split pipeline
        // (useOcrModel) transcribes in the background — except cloud pages,
        // whose texts already arrived with detection (re-reading them is waste).
        const ocr = pipeline.textSource === 'ocr' || (pipeline.useOcrModel && !!det.cloudTexts?.length);
        const vision = !ocr;
        const cropsOnly = vision && pipeline.textSource === 'crops';
        let imagesB64: string[] | undefined;
        let ocrStatus: ('ok' | 'empty')[] | undefined;
        let ocrMs: number | undefined;
        // dims of the annotated image the model actually sees (extras coords come
        // back in THIS space — the model can't know the full-resolution page)
        let annW = bitmap.width, annH = bitmap.height;
        if (ocr) {
            const tOcr = performance.now();
            onStatus('OCR…', 'ocr');
            if (det.cloudTexts) {
                // cloud path: texts arrived with detection — no local OCR models needed
                det.cloudTexts.forEach((t, i) => { regions[i].source = t; });
            } else if (pipeline.ocrEngine === 'baberu') {
                if (!(await baberuInstalled())) {
                    throw Object.assign(
                        new Error('Baberu OCR model not installed'),
                        { kind: 'ocr', hint: 'Download the model first — Settings → Model → Text source → OCR engine → Download' },
                    );
                }
                const texts = await baberuOcrAll(bitmap, det.boxes, (done, total) => {
                    if (done % 4 === 0 || done === total) onStatus(`OCR ${done}/${total}…`, 'ocr');
                });
                texts.forEach((t, i) => { regions[i].source = t; });
            } else {
                const installed = new Set(await ocrLangsInstalled(pipeline.ocrLangs));
                const missing = pipeline.ocrLangs.filter(l => !installed.has(l));
                if (missing.length) {
                    throw Object.assign(
                        new Error(`OCR language model not installed (${missing.join(', ')})`),
                        { kind: 'ocr', hint: 'Download the model first — Settings → Text source → OCR → Download' },
                    );
                }
                for (const [i, b] of det.boxes.entries()) {
                    regions[i].source = await ocrInWorkerPng(bitmap, b);
                }
            }
            ocrStatus = regions.map(r => r.source ? 'ok' : 'empty');
            // cloud path: local spent ~0ms — the server-side number diagnoses bottlenecks
            ocrMs = det.cloudTexts && det.cloudMs
                ? det.cloudMs.ocr
                : Math.round(performance.now() - tOcr);
        } else {
            const gs = pipeline.grayscaleBw && pageIsGrayscale(bitmap);
            if (cropsOnly) {
                imagesB64 = [];
                for (const box of det.boxes) imagesB64.push(await cropRegion(bitmap, box, gs));
            } else {
                const scale = Math.min(1, pipeline.fullPageSize / Math.max(bitmap.width, bitmap.height));
                annW = Math.round(bitmap.width * scale);
                annH = Math.round(bitmap.height * scale);
                imagesB64 = [await annotateForVLM(bitmap, det.boxes, gs)];
                for (const box of det.boxes) imagesB64.push(await cropRegion(bitmap, box, gs));
            }
        }
        // build what we send: shareContext off = standalone page (ablation);
        // toggles strip pairs / characters independently (also ablation arms)
        let ctxToSend: ContextState;
        if (!shareContext) ctxToSend = EMPTY_CONTEXT;
        else if (pipeline.useContext && pipeline.useCharacters) ctxToSend = context;
        else ctxToSend = {
            pairs: pipeline.useContext ? context.pairs : [],
            characters: pipeline.useCharacters ? context.characters : [],
        };
        // live status during the LLM call — it can take tens of seconds and the
        // previous status ("OCR n/n…") would otherwise look stuck
        onStatus('LLM translating…', 'llm');
        let llmSeconds = 0;
        const t0local = Date.now();
        if (opts?.progressKey) writeProgressT0(opts.progressKey, t0local);
        // handoff read AFTER our own write is safe by construction: handoffRead
        // takes the earliest fresh stamp across exact + host-volatile twin keys,
        // so our just-written entry can never shadow the older twin.
        const handedT0 = opts?.continued === true && opts?.progressKey ? readProgressT0(opts.progressKey) : null;
        const tickBase = handedT0 != null && handedT0 <= t0local ? handedT0 : t0local;
        const llmTick = setInterval(() => {
            llmSeconds = Math.max(llmSeconds + 1, Math.round((Date.now() - tickBase) / 1000));
            onStatus(`LLM translating… ${llmSeconds}s`, 'llm');
        }, 1000);
        let resp: any;
        const payload = {
            type: 'mt:translate',
            imagesB64,
            regions,
            context: ctxToSend,
            vision,
            textOnly: cropsOnly || ocr,
            ocr,
            pageW: annW,
            pageH: annH,
            cacheKey: await resolveMangaId() ?? chapterKey(), // stable per manga → prompt-cache affinity
        };
        // suspend-proof channel: an open runtime port pins the background
        // page alive AND its replies always arrive (Firefox drops a pending
        // sendResponse when it suspends the event page — live-proven silent
        // hang mid-LLM). Falls back to plain sendMessage (Chrome SW never
        // showed the problem, and the port listener is FF-new anyway).
        const portSend = () => new Promise<unknown>((resolve, reject) => {
            let port: chrome.runtime.Port;
            try { port = chrome.runtime.connect({ name: 'mt-rpc' }); } catch (e) { reject(e); return; }
            const to = setTimeout(() => { try { port.disconnect(); } catch { /* gone */ } reject(new Error('translate RPC timeout')); }, 180000);
            port.onMessage.addListener((r: unknown) => { clearTimeout(to); try { port.disconnect(); } catch { /* gone */ } resolve(r); });
            port.onDisconnect.addListener(() => { clearTimeout(to); reject(new Error('background disconnected')); });
            try { port.postMessage(payload); } catch (e) { clearTimeout(to); reject(e); }
        });
        try {
            try {
                resp = await portSend();
            } catch (e) {
                if (!/background disconnected|RPC timeout/.test(String((e as Error)?.message ?? ''))) throw e;
                // wake-race / no listener: retry the classic channel on a
                // rising backoff before giving up entirely
                let lastErr: unknown = e;
                for (const wait of [5000, 20000, 60000]) {
                    await new Promise(r => setTimeout(r, wait));
                    try {
                        resp = await chrome.runtime.sendMessage(payload);
                        lastErr = null;
                        break;
                    } catch (e2) {
                        lastErr = e2;
                        if (!/Receiving end/.test(String((e2 as Error)?.message ?? ''))) throw e2;
                    }
                }
                if (lastErr) throw lastErr;
            }
        } finally {
            clearInterval(llmTick);
        }
        if (!resp?.ok) {
            const err = new Error(resp?.error ?? 'translate RPC failed') as Error & { kind?: string; hint?: string };
            err.kind = resp?.kind; err.hint = resp?.hint;
            throw err;
        }
        // extras arrive in annotated-image space → rescale to full-page pixels
        const rawExtras: ExtraRegion[] = resp.extras ?? [];
        const extras: ExtraRegion[] = rawExtras
            .map(e => ({
                ...e,
                x1: e.x1 * bitmap.width / annW, y1: e.y1 * bitmap.height / annH,
                x2: e.x2 * bitmap.width / annW, y2: e.y2 * bitmap.height / annH,
            }))
            .filter(e =>
                e.x2 > e.x1 && e.y2 > e.y1 &&
                e.x2 <= bitmap.width * 1.05 && e.y2 <= bitmap.height * 1.05 &&
                (e.x2 - e.x1) > 12 && (e.y2 - e.y1) > 12);
        if (opts?.fold !== false && shareContext) {
            const c = resp.context as ContextState | undefined;
            setContext((c && Array.isArray(c.characters) && Array.isArray(c.pairs)) ? c : context);
            await saveContext();
        }
        return {
            outputs: resp.outputs as RegionOutput[], extras, usedLLM: true, annW, annH,
            mentions: (resp.mentions ?? []) as Mention[],
            bookOps: (resp.bookOps ?? []) as BookOp[],
            raw: resp.raw as string | undefined,
            usage: resp.usage, llmCalls: resp.llmCalls, llmMs: resp.llmMs,
            // split pipeline: transcription stats come back from the background
            ocrStatus: (resp.ocrStatus ?? ocrStatus) as ('ok' | 'empty')[] | undefined, ocrMs: resp.ocrMs ?? ocrMs,
        };
    } catch (e) {
        const err = e as Error & { kind?: string; hint?: string };
        const error = String(err.message ?? e).slice(0, 160);
        console.warn('[mt] LLM translation failed:', e);
        return {
            outputs: [], extras: [], mentions: [], usedLLM: false, error,
            errorKind: err.kind, errorHint: err.hint,
            annW: bitmap.width, annH: bitmap.height,
        };
    }
}
