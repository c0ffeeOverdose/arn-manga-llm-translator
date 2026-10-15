// Detection pipeline: detectPage (local/cloud), orderDetection (panels/
// banding), preparePage (read + cache gate), paintRegions/paintExtras.

import { detect, sortReadingOrder, orderByPanels, panelsDetect, panelsUsable, cloudDetect, type DetectResult, type DetBox, type InpaintPatch, type MtOnStatus } from './detection';
import { inpaint, inpaintBoxRegion, erasePlan, eraseBoxesAndMask } from './inpaint';
import { boxIsVertical, renderRegion, prepareRegion, sizeCapFrom, effBoxesForAreas, mergeParagraphLines } from './render';
import { type RegionOutput, type ExtraRegion } from '../llm/core';
import type { LLMSettings } from '../llm/adapters';
import { isDebug } from '../debug';
import { inpaintMode } from '../llm/pipeline-settings';
import { pageHashFromBitmap, cacheKey, pageKey, selectCachedPage, settingsFingerprint, cacheGet, cachePut, dropContainedBoxes, isResumable, detFromPartial, detFromCacheEntry, cacheEntryFresh, partialEntry, readWarming, warmingFresh, writeWarming, sweepWait, samePagePath, cloudSplitFresh, type CachedPage } from './page-cache';
import { sweepPageOrder, idlePageOrder } from './sweep';
import { verifyCachedIdentity } from '../cache/identity';
import { stateFor, pipeline, loadPipeline, chapterKey, resetContextIfNewChapter, type PageRef } from './state';
import { refKey, readPage, bitmapBlank, blankVerdicts } from './page-io';
import { pageIsGrayscale } from './ocr';
import { cacheReady, assertCacheCurrent } from '../cache-generation';
import { PageTimer } from '../page-timing';
import { attachModelBalloons } from './model-balloon';
import { recordChapterLog } from '../chapter/log-store';
import type { ChapterTrace } from '../chapter/log';

export interface Prep { srcUrl: string; bitmap: ImageBitmap; det: DetectResult; hash: string; fp?: string; cacheEpoch?: string; cached?: Pick<CachedPage, 'outputs' | 'extras' | 'mentions' | 'patches' | 'patchesGen'>; resumed?: true; ocrResumed?: true; cacheMiss?: string; prepMs?: number; origBytes?: ArrayBuffer; timing?: PageTimer; signal?: AbortSignal }

// Headless detect resolve — shared by lookahead prefetch and chapter sweep (DOM jobs use
// preparePage instead). Full hit → {det:null}; resumable partial → rebuilt det; else fresh
// detect + order + checkpoint write. Zero-box pages skip the checkpoint (nothing to resume).
export async function resolveHeadlessDet(
    bitmap: ImageBitmap, hash: string, onStatus: MtOnStatus,
    token?: string,
    chapterTrace?: ChapterTrace,
): Promise<{ det: DetectResult | null; resumed: boolean; cached?: CachedPage }> {
    token ??= await cacheReady();
    assertCacheCurrent(token);
    const key = cacheKey(chapterKey(), hash);
    const fp = settingsFingerprint(pipeline);
    {
        // full entries are the translation cache (cacheEnabled gates them); resume checkpoints
        // are in-flight work and always ride (a retry after a failed LLM never re-pays detect/OCR)
        const hit = await cacheGet(key);
        if (pipeline.cacheEnabled && cacheEntryFresh(hit, fp, bitmap.width, bitmap.height, pipeline.inferEngine === 'cloud')) {
            return { det: null, resumed: false, cached: hit };
        }
        if (isResumable(hit, fp, bitmap.width, bitmap.height, pipeline.inferEngine === 'cloud')) {
            onStatus(hit.texts?.length ? 'Reusing saved text…' : 'Reusing text detection…', 'llm');
            return { det: detFromPartial(hit, bitmap.width, bitmap.height)!, resumed: true };
        }
    }
    const det = await detectPage(bitmap, onStatus, { lo: true, chapterTrace }); // lookahead/sweep headless — background
    recordChapterLog(chapterTrace, { kind: 'stage', stage: 'order' });
    await orderDetection(det, bitmap);
    assertCacheCurrent(token);
    if (det.boxes.length) {
        void cachePut(partialEntry(key, fp, det, bitmap.width, bitmap.height), pipeline.cacheMax, token);
    }
    return { det, resumed: false };
}

// Detection for one bitmap (local or cloud), no ordering — shared by preparePage and the seam path.
export async function detectPage(bitmap: ImageBitmap, onStatus: MtOnStatus, opts?: { lo?: boolean; timing?: PageTimer; chapterTrace?: ChapterTrace }): Promise<DetectResult> {
    // cloud engine: one POST returns boxes+texts. No silent fallback — a cloud failure is an
    // error, and cloud mode without endpoint/key is a config error, not a cue to go local.
    recordChapterLog(opts?.chapterTrace, { kind: 'stage', stage: 'settings' });
    const { mtSettings } = await chrome.storage.local.get('mtSettings');
    const endpoint = String((mtSettings as LLMSettings | undefined)?.cloudEndpoint ?? '').trim();
    const key = String((mtSettings as LLMSettings | undefined)?.cloudKey ?? '').trim();
    if (pipeline.inferEngine === 'cloud') {
        recordChapterLog(opts?.chapterTrace, { kind: 'stage', stage: 'detect', execution: 'cloud' });
        if (!endpoint || !key) {
            throw Object.assign(
                new Error('Cloud detection needs an endpoint URL and API key.'),
                { kind: 'cloud', hint: 'Settings → Model → Cloud: add the endpoint URL and API key, then select Test cloud connection.' },
            );
        }
        onStatus('Finding text on the server…', 'detect');
        // page/crops modes feed the image to the LLM, so the server OCR pass would be paid
        // for and discarded; only OCR-text mode (or the split reader) needs those texts
        const needsTexts = pipeline.textSource === 'ocr' || pipeline.useOcrModel;
        try {
            return await cloudDetect(bitmap, endpoint, key, {
                confThr: pipeline.detConf, minSize: pipeline.detMinSize,
                layoutModel: pipeline.layoutModel,
                koharu: { text: pipeline.koharuTextConf, sfx: pipeline.koharuSfxConf, bubble: 0.50, panel: pipeline.koharuPanelConf },
                quality: pipeline.jpegQuality, gray: pipeline.grayscaleBw && pageIsGrayscale(bitmap),
                // merge AI cleanup into the same roundtrip — the server already has the text
                // mask; a second /v1/inpaint POST re-uploads the page
                inpaint: inpaintMode(pipeline) !== 'fill',
                texts: needsTexts,
                timing: opts?.timing,
                chapterTrace: opts?.chapterTrace,
            });
        } catch (e) {
            throw Object.assign(
                new Error(`Cloud detection failed: ${(e as Error)?.message ?? e}`),
                { kind: 'cloud', hint: 'In Settings → Model → Cloud, select Test cloud connection to check or wake the server.' },
            );
        }
    }
    recordChapterLog(opts?.chapterTrace, { kind: 'stage', stage: 'detect', execution: 'local' });
    return detect(bitmap, onStatus, { confThr: pipeline.detConf, minSize: pipeline.detMinSize, forceWasm: pipeline.detEp === 'wasm', lo: opts?.lo === true,
        layoutModel: pipeline.layoutModel, koharu: { text: pipeline.koharuTextConf, sfx: pipeline.koharuSfxConf,
            bubble: 0.50, panel: pipeline.koharuPanelConf } });
}

// Box ordering for one detection (panel-guided, strip-banding, or cloud banding) —
// mutates det in place, same shared call as above.
export async function orderDetection(det: DetectResult, bitmap: ImageBitmap): Promise<void> {
    if (det.ep !== 'cloud' && !det.cloudTexts && !det.cloudPatches?.length) det.boxes = mergeParagraphLines(det.boxes, () => {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    }, det.mask);
    // cloud texts ride with their boxes: ordering sorts the same box OBJECTS, so reattach
    // by identity afterwards
    const cloudTextByBox = det.cloudTexts ? new Map<DetBox, string>(det.boxes.map((b, i) => [b, det.cloudTexts![i] ?? ''])) : null;
    // same for server-computed cleanup patches — `i` is the PRE-ordering box index; reindex
    // to the post-ordering position or the render picks the wrong patch
    const cloudPatchByBox = det.cloudPatches?.length
        ? new Map<DetBox, InpaintPatch>(det.cloudPatches
            .filter(p => (p.i ?? -1) >= 0 && p.i! < det.boxes.length)
            .map(p => [det.boxes[p.i!], p]))
        : null;
    // panel-guided ordering when the model is present, banding otherwise (the detector emits
    // confidence order — numbering always sorts)
    const page = { w: bitmap.width, h: bitmap.height };
    const defer = pipeline.deferLabels;
    // extreme-aspect strips: the 640-resize destroys panel geometry, so don't even run YOLO.
    // Normal aspects run it but the output still passes the sanity gate inside orderByPanels.
    // Cloud uses server-provided Koharu panels or text-position ordering, never local YOLO.
    if (det.layoutModel === 'koharu') {
        const panels = det.panels ?? [];
        if (!panelsUsable(panels, page.w, page.h)) det.panelSkipped ??= 'No usable Koharu panels';
        det.boxes = orderByPanels(det.boxes, panels, pipeline.readingDir, page, defer);
    } else if (det.ep === 'cloud') {
        det.boxes = sortReadingOrder(det.boxes, pipeline.readingDir, page, defer);
    } else if (page.h / page.w > 3 || page.w / page.h > 3) {
        det.panels = [];
        det.panelSkipped = `strip aspect ${page.w}x${page.h}`;
        det.boxes = sortReadingOrder(det.boxes, pipeline.readingDir, page, defer);
    } else {
        try {
            const { panels, dropped, inferMs, lockWaitMs } = await panelsDetect(bitmap, pipeline.panelConf);
            det.panels = panels;
            det.panelDropped = dropped;
            det.panelMs = Math.round(inferMs);
            det.lockWaitMs = (det.lockWaitMs ?? 0) + (lockWaitMs ?? 0); // detect + panel contention, one number
            if (!panelsUsable(panels, page.w, page.h)) det.panelSkipped = `${panels.length} panels, biggest <10% page`;
            det.boxes = orderByPanels(det.boxes, panels, pipeline.readingDir, page, defer);
        } catch {
            det.boxes = sortReadingOrder(det.boxes, pipeline.readingDir, page, defer);
        }
    }
    // containment dedup (every EP incl. cloud): a near-threshold fragment inside a real box
    // survives IoU and would paint double text. Marginal only (conf < 0.5). Dropped boxes
    // vanish from cloudTexts with them (identity reattach below).
    det.boxes = dropContainedBoxes(det.boxes, 0.9, 0.5);
    if (cloudTextByBox) det.cloudTexts = det.boxes.map(b => cloudTextByBox.get(b) ?? '');
    if (cloudPatchByBox) {
        det.cloudPatches = [];
        det.boxes.forEach((b, i) => {
            const p = cloudPatchByBox.get(b);
            if (p) det.cloudPatches!.push({ ...p, i }); // reindex to the post-ordering position
        });
    }
    if (det.balloons?.length) det.boxes = attachModelBalloons(det.boxes, det.balloons, det.mask);
}

// Detect phase — kicked off at ENQUEUE time so detection of the next page overlaps the LLM
// call of the current one. Returns null when already translated (cache hit, no-op job).
// fromSweep: the caller IS the sweep (already claimed) — skip the sweep-wait.
// waitSweep=false for user-driven jobs: an explicit Translate press must not sit behind a
// slow sweep's claim (auto prefetch still waits — it would duplicate the sweep).
export async function preparePage(ref: PageRef, force: boolean, onStatus: MtOnStatus, fromSweep = false, waitSweep = true, signal?: AbortSignal): Promise<Prep | null> {
    const timing = new PageTimer();
    timing.activate();
    try {
        const prep = await prepareMeasuredPage(ref, force, (s, stage) => {
            timing.setStage(s);
            onStatus(s, stage);
        }, fromSweep, waitSweep, timing, signal);
        if (!prep) { timing.finish('done'); return null; }
        Object.assign(timing.meta, {
            page: `${prep.bitmap.width}x${prep.bitmap.height}`, boxes: prep.det.boxes.length,
            engine: pipeline.inferEngine, textSource: pipeline.textSource,
            thinking: pipeline.thinkingLevel, debug: isDebug(), cached: !!prep.cached,
        });
        return { ...prep, timing, signal };
    } catch (e) {
        timing.finish('failed');
        throw e;
    }
}

async function prepareMeasuredPage(ref: PageRef, force: boolean, onStatus: MtOnStatus, fromSweep: boolean, waitSweep: boolean, timing: PageTimer, signal?: AbortSignal): Promise<Prep | null> {
    const cacheEpoch = await cacheReady();
    const existing = stateFor(ref);
    if (existing?.det && !force) return null;
    // prepMs: read + hash + cache-gate cost (excludes queue wait). Answers "why is a cache
    // hit slow" without guessing.
    const tPrep0 = performance.now();
    const prepMs = () => Math.round(performance.now() - tPrep0);
    // re-translate: always from the ORIGINAL page — when the translated overlay is showing,
    // img.src points at our own rendering (canvas: stashed bytes).
    const srcUrl = existing ? existing.orig : refKey(ref);
    resetContextIfNewChapter();
    await loadPipeline();
    signal?.throwIfAborted();
    const fp = settingsFingerprint(pipeline);
    Object.assign(timing.meta, { engine: pipeline.inferEngine, textSource: pipeline.textSource,
        thinking: pipeline.thinkingLevel, debug: isDebug() });
    onStatus('Reading page…', 'read');
    // sliding-window canvas readers keep BLANK placeholder canvases outside the render window —
    // translating one poisons the page, so skip (no state, no cache). The verdict is cached per
    // element+SIZE (readers resize on draw, so an unchanged size means still blank). A canvas
    // that becomes VISIBLE re-checks regardless.
    let bitmap!: ImageBitmap, bytes: ArrayBuffer | undefined;
    try {
        const readSource = (originalBytes?: ArrayBuffer) => timing.measureAsync('read', () => readPage(ref, srcUrl, originalBytes));
        if (ref.kind === 'canvas') {
            const el = ref.el;
            const size = `${el.width}x${el.height}`;
            const r = el.getBoundingClientRect();
            const visible = r.width > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
            if (blankVerdicts.get(el) === size && !visible) return null;
            ({ bitmap, bytes } = await readSource(existing?.origBytes));
            if (await bitmapBlank(bitmap)) {
                if (existing?.origBytes) { bitmap.close(); ({ bitmap, bytes } = await readSource()); }
                if (await bitmapBlank(bitmap)) {
                    blankVerdicts.set(el, size);
                    if (isDebug()) console.log('[mt] canvas blank — reader has not drawn it yet:', refKey(ref).slice(-12));
                    bitmap.close();
                    return null;
                }
            }
            blankVerdicts.delete(el);
        } else {
            ({ bitmap, bytes } = await readSource(existing?.origBytes));
        }
        timing.meta.page = `${bitmap.width}x${bitmap.height}`;
        signal?.throwIfAborted();
        const tCache = performance.now();
        const cacheDone = () => timing.add('cache', performance.now() - tCache);
        // persistent cache: same image bytes + same settings → skip detect + LLM.
        // force (re-translate) always misses and overwrites below.
        // A previous document may have died mid-job on this exact page (full-load readers kill
        // in-memory state per page-turn) — leave a trace so the next load can name the restart.
        // Read BEFORE our own write below, else every visit self-matches.
        const prevWarming = timing.measure('cacheWarm', () => readWarming());
        timing.measure('cacheWarm', () => writeWarming(refKey(ref)));
        // chapter sweep owns this page right now — wait for its commit instead of paying a
        // duplicate detect + LLM (falls through on cancel/timeout)
        if (waitSweep && !force && !fromSweep && pipeline.cacheEnabled) {
            await Promise.race([sweepWait(refKey(ref), onStatus), new Promise(r => setTimeout(r, 150000))]);
        }
        const hash = timing.measure('cacheHash', () => pageHashFromBitmap(bitmap));
        signal?.throwIfAborted();
        assertCacheCurrent(cacheEpoch);
        // miss-reason instrument: a revisit that SHOULD hit but misses needs a verdict in one
        // dump (absent | fp | dims | splitgen | mask | identity | disabled)
        let cacheMiss: string | undefined = pipeline.cacheEnabled ? 'absent' : 'disabled';
        if (!force) {
            const hit = await timing.measureAsync('cacheIdb', () => cacheGet(cacheKey(chapterKey(), hash)));
            // hit.mask gate: pre-mask entries miss once, re-detect, and heal on overwrite.
            // Partial entries never render as Done — they resume below.
            // The shared predicate IS the gate (fingerprint, dims, mask, split generation): a
            // weaker test here let a splitGen-stale entry through and the forced non-null det
            // crashed the renderer instead of falling through to re-detect.
            const hitDet = pipeline.cacheEnabled
                ? detFromCacheEntry(hit, fp, bitmap.width, bitmap.height, pipeline.inferEngine === 'cloud') : null;
            if (hitDet) {
                cacheDone();
                cacheMiss = undefined;
                onStatus('Loading saved translation…');
                return { srcUrl, bitmap, fp, det: hitDet, hash, cacheEpoch, cached: hit, prepMs: prepMs(),
                    // canvas cache hit still needs the original bytes (re-translate reads the stash)
                    origBytes: ref.kind === 'canvas' ? bytes : undefined };
            }
            if (hit && pipeline.cacheEnabled) cacheMiss = hit.fp !== fp ? 'fp' : hit.w !== bitmap.width || hit.h !== bitmap.height ? 'dims' : !cloudSplitFresh(hit, pipeline.inferEngine === 'cloud') ? 'splitgen' : 'mask';
            if (pipeline.cacheEnabled) {
                const order = sweepPageOrder(srcUrl) ?? idlePageOrder();
                const identity = order != null ? await timing.measureAsync('cacheIdb', () => cacheGet(pageKey(chapterKey(), order))) : undefined;
                const selected = selectCachedPage({ bytes: hit, identity, hash, fp, w: bitmap.width, h: bitmap.height,
                    isCloud: pipeline.inferEngine === 'cloud',
                    verifyIdentity: row => verifyCachedIdentity(bitmap!, row) });
                if (selected) {
                    onStatus('Loading saved translation…');
                    cacheDone();
                    return { srcUrl, bitmap, fp, det: selected.det, hash, cacheEpoch, cached: selected.entry, prepMs: prepMs(),
                        origBytes: ref.kind === 'canvas' ? bytes : undefined };
                }
                if (identity) cacheMiss = 'identity';
            }
            // detect checkpoint resume: the previous load finished detect but died before
            // translating — continue at translateRegions, skipping detect entirely.
            if (isResumable(hit, fp, bitmap.width, bitmap.height, pipeline.inferEngine === 'cloud')) {
                cacheDone();
                cacheMiss = undefined;
                onStatus(hit.texts?.length ? 'Reusing saved text…' : 'Reusing text detection…', 'llm');
                return { srcUrl, bitmap, fp, det: detFromPartial(hit, bitmap.width, bitmap.height)!, hash, cacheEpoch, resumed: true as const,
                    ...(hit.texts?.length ? { ocrResumed: true as const } : null), prepMs: prepMs(),
                    origBytes: ref.kind === 'canvas' ? bytes : undefined };
            }
            if (!hit) {
                // total miss with a fresh warming trace for this page = the previous document died
                // before its detect checkpoint landed (prevWarming never self-matches)
                const w = prevWarming;
                if (w && samePagePath(w.key, refKey(ref)) && warmingFresh(w.ts)) onStatus('Page preparation was interrupted. Starting again…', 'read');
            }
        }
        cacheDone();
        signal?.throwIfAborted();
        const det = await timing.measureAsync('detect', () => detectPage(bitmap, onStatus, { lo: fromSweep, timing }));
        signal?.throwIfAborted();
        await timing.measureAsync('order', () => orderDetection(det, bitmap));
        assertCacheCurrent(cacheEpoch);
        signal?.throwIfAborted();
        // detect checkpoint: a page-turn kills this document mid-job — the next load resumes
        // from this entry (same key the full entry overwrites). Zero-box pages skip it.
        // Written even with the cache off (in-flight work, not a cached translation).
        if (!force && det.boxes.length) {
            void cachePut(partialEntry(cacheKey(chapterKey(), hash), fp, det, bitmap.width, bitmap.height), pipeline.cacheMax, cacheEpoch);
        }
        // canvas pages: stash the original bytes (re-translate must read the original, not our overlay)
        const origBytes = ref.kind === 'canvas' ? (bytes ?? existing?.origBytes) : undefined;
        return { srcUrl, bitmap, fp, det, hash, cacheEpoch, cacheMiss, prepMs: prepMs(), origBytes };
    } catch (error) { bitmap?.close(); throw error; }
}

// Paint translated regions onto a canvas (inpaint source text, draw the translation per
// box) — shared by the solo path and the seam path (which paints the whole stitch, then
// slices). `patches` (AI cleanup output) replace the built-in fill when present.
export interface PaintPatch { x1: number; y1: number; x2: number; y2: number; bmp: CanvasImageSource }

export function paintRegions(
    canvas: OffscreenCanvas, frame: ImageData, det: DetectResult, outputs: RegionOutput[],
    patches?: PaintPatch[] | null,
): { i: number; f: number; n: number; o?: 1; g?: 1 }[] {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const originalPlan = erasePlan(det, outputs);
    const textFor = (k: number) => {
        const out = outputs.find(o => o.index === k);
        return out?.translation && out.translation !== 'keep' ? out.translation : '';
    };
    const effBoxes = effBoxesForAreas(ctx, frame, det.boxes, textFor, det.mask);
    const plans = new Map<number, NonNullable<ReturnType<typeof prepareRegion>>>();
    det.boxes.forEach((_, i) => {
        if (originalPlan.keepIdx.has(i + 1) || originalPlan.dupIdx.has(i + 1)) return;
        const plan = prepareRegion(ctx, frame, effBoxes[i], textFor(i + 1), det.mask);
        if (plan) plans.set(i + 1, plan);
    });
    const overlapsPlaced = (index: number) => {
        const b = det.boxes[index - 1];
        return [...plans.keys()].some(k => {
            const p = det.boxes[k - 1];
            const intersection = Math.max(0, Math.min(b.x2, p.x2) - Math.max(b.x1, p.x1))
                * Math.max(0, Math.min(b.y2, p.y2) - Math.max(b.y1, p.y1));
            return intersection >= 0.5 * Math.min((b.x2 - b.x1) * (b.y2 - b.y1), (p.x2 - p.x1) * (p.y2 - p.y1));
        });
    };
    const safeOutputs = outputs.filter(o => o.translation === 'keep' || plans.has(o.index)
        || (originalPlan.dupIdx.has(o.index) && overlapsPlaced(o.index)));
    const { boxesToErase, keepBoxes, dupIdx, missedIdx } = erasePlan(det, safeOutputs);
    if (missedIdx.length) console.warn(`[mt] regions with no translation kept as-is: ${missedIdx.join(',')}`);
    const unplaced = outputs.filter(o => o.translation && o.translation !== 'keep' && !originalPlan.dupIdx.has(o.index) && !plans.has(o.index));
    if (unplaced.length) console.warn(`[mt] ${unplaced.length} translated text groups could not fit safely; original text was kept`);
    if (dupIdx.size && isDebug()) console.log('[mt] duplicate boxes kept as-is:', [...dupIdx].join(','));
    if (patches?.length) {
        // AI cleanup ran on the original page: paint the patches instead of the built-in fill.
        // Drawn into the full rect (not 1:1): capped-upload cloud patches come back smaller —
        // drawImage scales them up; full-res patches make this a no-op.
        for (const p of patches) ctx.drawImage(p.bmp, p.x1, p.y1, p.x2 - p.x1, p.y2 - p.y1);
        // Warm/cloud/cached patches can cover a neighbour not accepted for painting.
        // Only the final owned erase mask authorizes pixel changes, including after scaling.
        const { mask } = eraseBoxesAndMask(canvas, det, boxesToErase, keepBoxes);
        const cleaned = ctx.getImageData(0, 0, canvas.width, canvas.height);
        for (let p = 0; p < mask.data.length; p++) if (!mask.data[p]) {
            const i = p * 4;
            cleaned.data[i] = frame.data[i]; cleaned.data[i + 1] = frame.data[i + 1];
            cleaned.data[i + 2] = frame.data[i + 2]; cleaned.data[i + 3] = frame.data[i + 3];
        }
        ctx.putImageData(cleaned, 0, 0);
    } else {
        inpaint(canvas, { ...det, boxes: boxesToErase, keepBoxes });
    }

    // chosen layout per rendered region (diagnoses shrink/clip issues)
    const layouts: { i: number; f: number; n: number }[] = [];
    det.boxes.forEach((box, i) => {
        const plan = plans.get(i + 1);
        if (!plan) return;
        plan.paint();
        const placed = plan.placed;
        layouts.push({
            i: i + 1, f: placed.fontSize, n: placed.lines.length,
            ...(placed.overflow ? { o: 1 as const } : {}),
            ...(placed.grown ? { g: 1 as const } : {}), // dark-caption area grew past the box cap to hold the text
            ...(isDebug() && placed.color ? { c: placed.color } : null),
            ...(isDebug() && placed.block ? { ly: placed.block.map(Math.round) } : null),
            // debug sc = source-pitch font ceiling (f at sc with no o = the cap holds)
            ...(isDebug() ? { sc: sizeCapFrom(frame, box, boxIsVertical(box)) ?? undefined } : null),
        });
    });
    return layouts;
}

// VLM-reported extra regions (hand-written signs the detector missed): erase with box
// fill, render there — same shared call as paintRegions.
export function paintExtras(canvas: OffscreenCanvas, frame: ImageData, det: DetectResult, extras: ExtraRegion[]): void {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    // skip boxes overlapping an existing report or 'keep'-style noise, then erase with box
    // fill and render the translation
    const iou = (a: DetBox, b: { x1: number; y1: number; x2: number; y2: number }) => {
        const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
        const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
        const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const ua = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
        return ua > 0 ? inter / ua : 0;
    };
    // extras must sit on a LIGHT area (hand-written signs are dark-on-light by nature).
    // Dark areas are coordinate errors or bubble art — rendering there paints over art.
    // inpaintBoxRegion's ink-density/dark-bg guards make the final call.
    const boxIsSignable = (b: { x1: number; y1: number; x2: number; y2: number }): boolean => {
        const { width: W, data } = frame;
        let lum = 0, n = 0;
        const stepX = Math.max(1, Math.floor((b.x2 - b.x1) / 16));
        const stepY = Math.max(1, Math.floor((b.y2 - b.y1) / 16));
        for (let y = Math.floor(b.y1); y < b.y2; y += stepY) {
            for (let x = Math.floor(b.x1); x < b.x2; x += stepX) {
                if (x < 0 || y < 0 || x >= W || y >= frame.height) continue;
                const i = (y * W + x) * 4;
                lum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                n++;
            }
        }
        return n >= 8 && lum / n > 110;
    };
    const usedExtras: DetBox[] = [];
    let extraCount = 0;
    for (const ex of extras) {
        if (!ex.translation || ex.translation === 'keep') continue;
        if (det.boxes.some(b => iou(b, ex) > 0.1)) continue; // overlaps a known region at all
        if (usedExtras.some(b => iou(b, ex) > 0.3)) continue; // duplicate/overlapping report
        if (!boxIsSignable(ex)) continue;
        if (extraCount >= 4) break; // ponytail: cap at 4 — extras are best-effort
        // erase returns WHERE the ink actually was — render there (VLM coords are approximate;
        // ink pixels are ground truth). Scan expanded 60%: reported boxes routinely miss the ink.
        const ex0 = Math.max(0, ex.x1 - (ex.x2 - ex.x1) * 0.6);
        const ey0 = Math.max(0, ex.y1 - (ex.y2 - ex.y1) * 0.6);
        const ex1 = ex.x2 + (ex.x2 - ex.x1) * 0.6;
        const ey1 = ex.y2 + (ex.y2 - ex.y1) * 0.6;
        const inkBox = inpaintBoxRegion(canvas, { x1: ex0, y1: ey0, x2: ex1, y2: ey1 });
        if (!inkBox) continue;
        extraCount++;
        const box: DetBox = { x1: inkBox.x1, y1: inkBox.y1, x2: inkBox.x2, y2: inkBox.y2, conf: 1 };
        usedExtras.push(box);
        renderRegion(ctx, frame, box, ex.translation, det.mask);
    }
}
