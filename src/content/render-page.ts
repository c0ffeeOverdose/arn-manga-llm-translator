// renderPage: the solo path — translate one prepared page, paint, register,
// cache, fold into the book.

import { chosenOrientation, ensureFont, renderTuning, RENDER_GEN, layoutArea } from './render';
import { updateContext, type RegionOutput, type ExtraRegion, type Mention, type BookOp } from '../llm/core';
import { isDebug } from '../debug';
import { cacheKey, settingsFingerprint, cachePut, cacheDelete, packMask, dropProgressT0, INPAINT_PATCH_GEN } from './page-cache';
import { withEncodeLock, inpaintPage, cloudInpaint, cloudConfig, type MtOnStatus } from './detection';
import { pipeline, context, setContext, shareContext, chapterKey, pages, regPage, unregPage, debugOn, sessionUsage, setLastPageUsage, loadContext, type PageRef, type PageState } from './state';
import { stateFor } from './state';
import { paintRegions, paintExtras, type Prep, type PaintPatch } from './pipeline';
import { eraseBox, erasePlan, aiCleanupMask } from './inpaint';
import { inpaintMode } from '../llm/pipeline-settings';
import { ownCopyNeeded, ownOriginalUrl } from './page-io';
import { translateRegions, renderDebugView, panelRanks } from './ocr';
import { rewindContextBefore, replayPagesAfter } from './queue';
import { bookHas, bookAdd, bookDrop } from './sweep';
import { saveContext } from './state';

// paintOnly: paint + register a page WITHOUT folding it into the book — the
// sweep paints the page the user is looking at the moment its worker finishes,
// while the ordered commit still folds it later (the commit's own
// !bookHas guard makes the eventual double-visit harmless). The book snapshot
// is skipped too: context is still mid-chapter at paint time, and a stale
// snapshot would poison a later re-translate's rewind.
export async function renderPage(ref: PageRef, prep: Prep, onStatus: MtOnStatus, force: boolean,
    opts: { paintOnly?: boolean } = {}): Promise<PageState> {
    const paintOnly = opts.paintOnly === true;

    const { srcUrl, bitmap, det } = prep;
    const existing = stateFor(ref) ?? pages.get(srcUrl);
    // twin prep made before the first job finished — reuse it, don't pay twice.
    // (force still re-translates; the twin's context contribution gets rewound below.)
    if (existing && !force) return existing;
    if (existing && shareContext) await rewindContextBefore(existing);
    // the rebuilt book excludes this page — its hash must refold (fresh fold
    // below re-registers; an error leaves it dropped so arrival refolds).
    // Same for the progress stamp: a force retranslate counts fresh.
    if (existing?.hash) bookDrop(existing.hash);
    if (existing) dropProgressT0(srcUrl);
    // the book as it was just before THIS page folds (after any rewind above):
    // a later re-translate restores it instead of replaying page states it may
    // not have (single-page readers keep one <img> — the replay wiped the book
    // down to user entries, live-proven). MUST load first: translateRegions
    // loads lazily, and a snapshot taken before that captures the empty default.
    await loadContext();
    const bookBefore = paintOnly ? undefined : context.characters;
    const pairsBefore = paintOnly ? undefined : context.pairs;
    let outputs: RegionOutput[], extras: ExtraRegion[], usedLLM: boolean;
    let mentions: Mention[] = [];
    let bookOps: BookOp[] | undefined;
    let error: string | undefined, errorKind: string | undefined, errorHint: string | undefined, errorRetryAfterMs: number | undefined;
    let annWCache: number, annHCache: number, rawLLM: string | undefined;
    let usage: { inTok?: number; outTok?: number; cachedInTok?: number } | undefined;
    let llmCalls: number | undefined, llmMs: number | undefined, ocrStatus: ('ok' | 'empty')[] | undefined, ocrMs: number | undefined, ocrLockWaitMs: number | undefined, badgeR: number | undefined;
    if (prep.cached) {
        // persistent cache hit: identical image bytes + identical settings — the
        // LLM is not called. Outputs still fold into the book (fresh session).
        onStatus('Cache hit…');
        ({ outputs, extras, mentions = [] } = prep.cached);
        usedLLM = false;
        annWCache = bitmap.width; annHCache = bitmap.height;
        rawLLM = '(cached — no LLM call)';
        // already folded by whoever produced this entry (sweep commit, an
        // earlier visit, prefetch) — refolding would duplicate its pairs.
        // Otherwise fold + register (later arrivals skip via the divert lane).
        if (shareContext && !paintOnly && !bookHas(prep.hash)) { const u = updateContext(context, outputs, mentions, pipeline.useCharacters, pipeline.contextPairs); setContext(u.ctx); bookOps = u.bookOps.length ? u.bookOps : undefined; await saveContext(); bookAdd(prep.hash); }
    } else {
        onStatus('Translating…');
        ({ outputs, extras, mentions, bookOps, usedLLM, error, errorKind, errorHint, errorRetryAfterMs, annW: annWCache, annH: annHCache, badgeR, raw: rawLLM, usage, llmCalls, llmMs, ocrStatus, ocrMs, ocrLockWaitMs } = await translateRegions(bitmap, det, onStatus,
            { progressKey: srcUrl, continued: !!prep.resumed || !pipeline.cacheEnabled }));

        if (error) {
            const e = new Error(`LLM failed: ${error}`) as Error & { kind?: string; hint?: string; retryAfterMs?: number };
            e.kind = errorKind; e.hint = errorHint; e.retryAfterMs = errorRetryAfterMs;
            throw e;
        }
        bookAdd(prep.hash); // folded above (translateRegions) — arrivals skip refold
    }

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);

    // AI text cleanup: patches from the cache when valid, otherwise generated
    // once from the original bitmap and written back to the entry. Any failure
    // (no model, no WebGPU, download error) falls back to the built-in fill —
    // a page must never fail here. Cloud mode rides the same shape (P6).
    const aiMode = inpaintMode(pipeline);
    let aiPatches: { x1: number; y1: number; x2: number; y2: number; png: ArrayBuffer }[] | null = null;
    let aiGenerated = false, aiMs = 0, aiWindows = 0, aiError: string | undefined;
    if (aiMode !== 'fill') {
        const cached = prep.cached?.patches?.length && prep.cached.patchesGen === INPAINT_PATCH_GEN
            ? prep.cached.patches : null;
        if (cached) aiPatches = cached;
        else {
            const plan = erasePlan(det, outputs);
            if (plan.boxesToErase.length) {
                onStatus('Cleaning text…', 'render');
                const rawMask = new Uint8Array(det.mask.data);
                const boxes = plan.boxesToErase.map(b => eraseBox(rawMask, bitmap.width, bitmap.height, b,
                    Math.max(8, Math.round((b.x2 - b.x1) * 0.08), Math.round((b.y2 - b.y1) * 0.08))));
                const mask = aiCleanupMask(det, boxes, plan.keepBoxes);
                if (aiMode === 'local') {
                    try {
                        const r = await inpaintPage(bitmap, boxes, mask);
                        if (r.patches.length) { aiPatches = r.patches; aiGenerated = true; aiMs = r.ms; aiWindows = r.windows; }
                    } catch (e) {
                        aiError = String((e as Error)?.message ?? e).slice(0, 120);
                        if (isDebug()) console.log('[mt] AI cleanup unavailable — using built-in fill:', aiError);
                    }
                } else {
                    // cloud engine: same client-side mask rides along, so local and
                    // cloud erase the same pixels (the server falls back to its own
                    // CTD pass for old clients)
                    const cfg = await cloudConfig();
                    if (cfg.endpoint && cfg.key) {
                        try {
                            const r = await cloudInpaint(
                                bitmap, boxes,
                                { quality: pipeline.jpegQuality, gray: pipeline.grayscaleBw, endpoint: cfg.endpoint, key: cfg.key, mask },
                            );
                            if (r.patches.length) { aiPatches = r.patches; aiGenerated = true; aiMs = r.ms; aiWindows = r.windows; }
                        } catch (e) {
                            aiError = String((e as Error)?.message ?? e).slice(0, 120);
                            if (isDebug()) console.log('[mt] cloud AI cleanup unavailable — using built-in fill:', aiError);
                        }
                    } else {
                        aiError = 'cloud endpoint not configured';
                    }
                }
            }
        }
    }
    let paintPatches: PaintPatch[] | null = null;
    if (aiPatches?.length) {
        paintPatches = await Promise.all(aiPatches.map(async p =>
            ({ x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, bmp: await createImageBitmap(new Blob([p.png], { type: 'image/png' })) })));
    }

    await ensureFont();
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);

    onStatus('Rendering…', 'render');
    // paint translated regions (shared helper — the seam path paints the whole
    // stitch, then slices per member)
    const tRender0 = performance.now();
    const layouts = paintRegions(canvas, frame, det, outputs, paintPatches);
    for (const p of paintPatches ?? []) p.bmp.close();

    // VLM extras (shared helper — the seam path paints them on the stitch too)
    paintExtras(canvas, frame, det, extras);
    const renderMs = Math.round(performance.now() - tRender0); // paint only (excludes PNG encode + overlays)

    // single debug dump: everything needed to diagnose a bad page render
    if (isDebug()) console.log('[mt] page result', JSON.stringify({
        page: `${bitmap.width}x${bitmap.height}`,
        ann: `${annWCache}x${annHCache}`,
        ...(badgeR != null ? { badgeR } : null), // drawn region-badge radius (ann px): a mis-mapping report shows the mark size without decoding the JPEG
        hash: prep.hash, // content hash — same visual page, different hash = read-path pixels differ
        ...(prep.cacheMiss ? { cacheMiss: prep.cacheMiss } : null), // why a revisit re-translated: absent|fp|dims|mask|disabled
        ...(prep.resumed ? { resumed: true } : null), // continued from a detect checkpoint, not from zero
        ...(prep.ocrResumed ? { ocrResumed: true } : null), // …and the OCR text came back too (OCR did not run)
        ...(prep.prepMs != null ? { prepMs: prep.prepMs } : null), // read + hash + cache-gate ms (excludes queue wait)
        renderMs, // paint ms (excludes PNG encode + overlays)
        ...(aiMode !== 'fill' ? {
            inpaint: {
                mode: aiMode, ms: aiMs, windows: aiWindows, patches: aiPatches?.length ?? 0,
                cached: !!aiPatches && !aiGenerated,
                ...(aiError ? { error: aiError } : null),
            },
        } : null),
        minFont: renderTuning.minFont, // effective floor — stale options look identical to a render bug
        gen: RENDER_GEN, // render-logic generation — stale extension shows an older number
        detConf: pipeline.detConf, // threshold that let these boxes through — low values explain junk regions
        usedLLM,
        det: { ep: det.ep, ms: Math.round(det.inferMs), initMs: det.initMs ?? null, panelMs: det.panelMs ?? null, lockWaitMs: det.lockWaitMs ?? null },
        llm: usage || llmCalls ? { calls: llmCalls ?? 1, ms: llmMs, inTok: usage?.inTok ?? null, outTok: usage?.outTok ?? null, cachedInTok: usage?.cachedInTok ?? null } : null,
        ocr: ocrStatus ? { ok: ocrStatus.filter(s => s === 'ok').length, empty: ocrStatus.filter(s => s === 'empty').length, ms: ocrMs ?? null, lockWaitMs: ocrLockWaitMs ?? null } : null,
        boxes: det.boxes.map(b => ({ x1: Math.round(b.x1), y1: Math.round(b.y1), x2: Math.round(b.x2), y2: Math.round(b.y2), conf: +b.conf.toFixed(2) })),
        panels: (det.panels ?? []).map(p => ({ x1: Math.round(p.x1), y1: Math.round(p.y1), x2: Math.round(p.x2), y2: Math.round(p.y2), conf: +p.conf.toFixed(2) })),
        ...(det.panelSkipped ? { panelSkipped: det.panelSkipped } : null),
        // placement areas the renderer actually used (layoutArea: flood-fill
        // clamped at bubble borders, shrunk to ink on near-empty boxes —
        // compare against boxes to spot either failure)
        areas: det.boxes.map((b, i) => {
            // same orientation the paint picked for this region (not the box
            // aspect): the dumped area must be the area the text got
            const out = outputs.find(o => o.index === i + 1);
            const text = out?.translation && out.translation !== 'keep' ? out.translation : '';
            const a = layoutArea(frame, b, chosenOrientation(ctx, frame, b, text, det.mask), det.mask) ?? { x: 0, y: 0, w: 0, h: 0 }; // null = zero ink, skipped
            return {
                x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.w), h: Math.round(a.h),
                // enclosed score >0 = per-line profile layout, absent = no-frame rect
                ...('runs' in a && a.runs ? { prof: +a.runs.enclosed.toFixed(2) } : null),
                ...('why' in a && a.why ? { why: a.why } : null), // rect path reason (debug)
                // leak guard (RUN_JUMP): rows whose run end was clamped from a
                // fill that escaped the bubble — [left, right]
                ...(a.runs?.leakL || a.runs?.leakR || a.leakL || a.leakR
                    ? { leak: [a.runs?.leakL || a.leakL || 0, a.runs?.leakR || a.leakR || 0] }
                    : null),
            };
        }),
        // chosen layout per region: {i, fontSize, line count} — null layout
        // (skipped/degenerate) is simply absent
        layout: layouts,
        outputs: outputs.map(o => ({ i: o.index, t: o.translation, s: o.source || null, spk: o.spk ? { d: o.spk.desc, g: o.spk.gender, n: o.spk.name ?? null } : null })),
        extras,
        ...(bookOps?.length ? { bookOps } : null),
    }));
    if (rawLLM == null) console.warn('[mt] llm raw unavailable — stale service worker? reload the extension');
    const blob = await withEncodeLock(() => canvas.convertToBlob({ type: 'image/png' }));
    const state: PageState = {
        orig: srcUrl,
        translated: URL.createObjectURL(blob),
        det,
        outputs,
        mentions,
        bookBefore,
        pairsBefore,
        hash: prep.hash,
        // canvas pages have no URL to re-read — carry the original bytes forward
        // (and a decoded translated bitmap for write-back) with the state
        origBytes: prep.origBytes ?? existing?.origBytes,
        translatedBmp: ref.kind === 'canvas' ? canvas.transferToImageBitmap() : undefined,
    };
    // blob-origin readers: keep an extension-owned copy of the original now —
    // once we swap in the translated blob the reader's URL may be dead and
    // "Show original" has nothing to restore from (see ownOriginalUrl)
    if (ownCopyNeeded(srcUrl, bitmap.width, bitmap.height)) {
        state.origOwn = await ownOriginalUrl(bitmap);
        if (isDebug() && state.origOwn) console.log('[mt] orig copy', JSON.stringify({ src: srcUrl.slice(-14), px: bitmap.width * bitmap.height }));
    }
    // debug views ride along only when debug is on — zero cost otherwise.
    // one on each frame so Original/Translate toggle keeps its debug boxes.
    if (debugOn && det.boxes.length) {
        const ranks = panelRanks(det.panels ?? []);
        state.debugOrig = await renderDebugView(bitmap, det.boxes, det.panels, ranks, det.dropped, det.panelDropped, outputs, det.mask);
        // canvas pages reuse the kept translated bitmap (transfer is one-shot);
        // img pages transfer here as before — the canvas is dead after this
        const bmp = state.translatedBmp ?? canvas.transferToImageBitmap();
        state.debug = await renderDebugView(bmp, det.boxes, det.panels, ranks, det.dropped, det.panelDropped, outputs, det.mask);
    }
    if (existing) {
        unregPage(existing);
        URL.revokeObjectURL(existing.translated);
        if (existing.debug) URL.revokeObjectURL(existing.debug);
        if (existing.debugOrig) URL.revokeObjectURL(existing.debugOrig);
    }
    regPage(state);
    // store fresh translations for the next visit (force re-translates
    // overwrite). Fire-and-forget — a slow IDB write never blocks the sweep.
    // Never cache a void result (boxes but zero outputs — e.g. a stale
    // background that still returns ok:true on total parse failure): it would
    // sit "translated" with nothing on it until force. Zero-box pages cache
    // fine (nothing to find twice).
    if (!prep.cached && pipeline.cacheEnabled && (det.boxes.length === 0 || outputs.length > 0)) {
        void cachePut({
            key: cacheKey(chapterKey(), prep.hash),
            fp: settingsFingerprint(pipeline),
            w: bitmap.width, h: bitmap.height,
            boxes: det.boxes, panels: det.panels ?? [],
            outputs, extras, mentions,
            mask: packMask(det.mask),
            ...(aiPatches?.length ? { patches: aiPatches, patchesGen: INPAINT_PATCH_GEN } : null),
        }, pipeline.cacheMax);
    } else if (!prep.cached) {
        // cache off: the resume checkpoint this job may have resumed from is
        // in-flight work, and the job is done — leave nothing behind
        void cacheDelete(cacheKey(chapterKey(), prep.hash));
    } else if (aiGenerated && aiPatches?.length && pipeline.cacheEnabled) {
        // cache hit that had to regenerate crops (headless prefetch/arrival
        // wrote the entry) — persist so the next visit paints without the model
        void cachePut({
            key: cacheKey(chapterKey(), prep.hash),
            fp: settingsFingerprint(pipeline),
            w: bitmap.width, h: bitmap.height,
            boxes: det.boxes, panels: det.panels ?? [],
            outputs, extras, mentions,
            mask: packMask(det.mask),
            patches: aiPatches, patchesGen: INPAINT_PATCH_GEN,
        }, pipeline.cacheMax);
    }
    if (force && shareContext) {
        replayPagesAfter(state);
        await saveContext();
    }
    // session usage counters for the popup box
    if (usage) {
        sessionUsage.pages++;
        sessionUsage.inTok += usage.inTok ?? 0;
        sessionUsage.outTok += usage.outTok ?? 0;
        sessionUsage.cachedInTok += usage.cachedInTok ?? 0;
    }
    setLastPageUsage({ inTok: usage?.inTok, outTok: usage?.outTok, cachedInTok: usage?.cachedInTok, ms: llmMs, calls: llmCalls });
    return state;
}
