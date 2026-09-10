// renderPage: the solo path — translate one prepared page, paint, register,
// cache, fold into the book.

import { ensureFont, renderTuning, RENDER_GEN, layoutArea } from './render';
import { updateContext, type RegionOutput, type ExtraRegion, type Mention, type BookOp } from '../llm/core';
import { isDebug } from '../debug';
import { cacheKey, settingsFingerprint, cachePut, packMask } from './page-cache';
import { type MtOnStatus } from './detection';
import { pipeline, context, setContext, shareContext, chapterKey, pages, regPage, unregPage, debugOn, sessionUsage, setLastPageUsage, type PageRef, type PageState } from './state';
import { stateFor } from './state';
import { paintRegions, paintExtras, type Prep } from './pipeline';
import { translateRegions, renderDebugView, panelRanks } from './ocr';
import { rewindContextBefore, replayPagesAfter } from './queue';
import { saveContext } from './state';

export async function renderPage(ref: PageRef, prep: Prep, onStatus: MtOnStatus, force: boolean): Promise<PageState> {

    const { srcUrl, bitmap, det } = prep;
    const existing = stateFor(ref) ?? pages.get(srcUrl);
    // twin prep made before the first job finished — reuse it, don't pay twice.
    // (force still re-translates; the twin's context contribution gets rewound below.)
    if (existing && !force) return existing;
    if (existing && shareContext) await rewindContextBefore(existing);
    let outputs: RegionOutput[], extras: ExtraRegion[], usedLLM: boolean;
    let mentions: Mention[] = [];
    let bookOps: BookOp[] | undefined;
    let error: string | undefined, errorKind: string | undefined, errorHint: string | undefined;
    let annWCache: number, annHCache: number, rawLLM: string | undefined;
    let usage: { inTok?: number; outTok?: number; cachedInTok?: number } | undefined;
    let llmCalls: number | undefined, llmMs: number | undefined, ocrStatus: ('ok' | 'empty')[] | undefined, ocrMs: number | undefined;
    if (prep.cached) {
        // persistent cache hit: identical image bytes + identical settings — the
        // LLM is not called. Outputs still fold into the book (fresh session).
        onStatus('Cache hit…');
        ({ outputs, extras, mentions = [] } = prep.cached);
        usedLLM = false;
        annWCache = bitmap.width; annHCache = bitmap.height;
        rawLLM = '(cached — no LLM call)';
        if (shareContext) { const u = updateContext(context, outputs, mentions, pipeline.useCharacters, pipeline.contextPairs); setContext(u.ctx); bookOps = u.bookOps.length ? u.bookOps : undefined; await saveContext(); }
    } else {
        onStatus('Translating…');
        ({ outputs, extras, mentions, bookOps, usedLLM, error, errorKind, errorHint, annW: annWCache, annH: annHCache, raw: rawLLM, usage, llmCalls, llmMs, ocrStatus, ocrMs } = await translateRegions(bitmap, det, onStatus));

        if (error) {
            const e = new Error(`LLM failed: ${error}`) as Error & { kind?: string; hint?: string };
            e.kind = errorKind; e.hint = errorHint;
            throw e;
        }
    }

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);

    await ensureFont();
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);

    onStatus('Rendering…', 'render');
    // paint translated regions (shared helper — the seam path paints the whole
    // stitch with it, then slices per member)
    const layouts = paintRegions(canvas, frame, det, outputs);

    // VLM extras (shared helper — the seam path paints them on the stitch too)
    paintExtras(canvas, frame, det, extras);

    // single debug dump: everything needed to diagnose a bad page render
    if (isDebug()) console.log('[mt] page result', JSON.stringify({
        page: `${bitmap.width}x${bitmap.height}`,
        ann: `${annWCache}x${annHCache}`,
        hash: prep.hash, // content hash — same visual page, different hash = read-path pixels differ
        ...(prep.cacheMiss ? { cacheMiss: prep.cacheMiss } : null), // why a revisit re-translated: absent|fp|dims|mask|disabled
        minFont: renderTuning.minFont, // effective floor — stale options look identical to a render bug
        gen: RENDER_GEN, // render-logic generation — stale extension shows an older number
        detConf: pipeline.detConf, // threshold that let these boxes through — low values explain junk regions
        usedLLM,
        det: { ep: det.ep, ms: Math.round(det.inferMs), initMs: det.initMs ?? null, panelMs: det.panelMs ?? null },
        llm: usage || llmCalls ? { calls: llmCalls ?? 1, ms: llmMs, inTok: usage?.inTok ?? null, outTok: usage?.outTok ?? null, cachedInTok: usage?.cachedInTok ?? null } : null,
        ocr: ocrStatus ? { ok: ocrStatus.filter(s => s === 'ok').length, empty: ocrStatus.filter(s => s === 'empty').length, ms: ocrMs ?? null } : null,
        boxes: det.boxes.map(b => ({ x1: Math.round(b.x1), y1: Math.round(b.y1), x2: Math.round(b.x2), y2: Math.round(b.y2), conf: +b.conf.toFixed(2) })),
        panels: (det.panels ?? []).map(p => ({ x1: Math.round(p.x1), y1: Math.round(p.y1), x2: Math.round(p.x2), y2: Math.round(p.y2), conf: +p.conf.toFixed(2) })),
        ...(det.panelSkipped ? { panelSkipped: det.panelSkipped } : null),
        // placement areas the renderer actually used (layoutArea: flood-fill
        // clamped at bubble borders, shrunk to ink on near-empty boxes —
        // compare against boxes to spot either failure)
        areas: det.boxes.map(b => {
            const a = layoutArea(frame, b) ?? { x: 0, y: 0, w: 0, h: 0 }; // null = zero ink, skipped
            return { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.w), h: Math.round(a.h) };
        }),
        // chosen layout per region: {i, fontSize, line count} — null layout
        // (skipped/degenerate) is simply absent
        layout: layouts,
        outputs: outputs.map(o => ({ i: o.index, t: o.translation, s: o.source || null, spk: o.spk ? { d: o.spk.desc, g: o.spk.gender, n: o.spk.name ?? null } : null })),
        extras,
        ...(bookOps?.length ? { bookOps } : null),
    }));
    if (rawLLM == null) console.warn('[mt] llm raw unavailable — stale service worker? reload the extension');
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const state: PageState = {
        orig: srcUrl,
        translated: URL.createObjectURL(blob),
        det,
        outputs,
        mentions,
        hash: prep.hash,
        // canvas pages have no URL to re-read — carry the original bytes forward
        // (and a decoded translated bitmap for write-back) with the state
        origBytes: prep.origBytes ?? existing?.origBytes,
        translatedBmp: ref.kind === 'canvas' ? canvas.transferToImageBitmap() : undefined,
    };
    // debug views ride along only when debug is on — zero cost otherwise.
    // one on each frame so Original/Translate toggle keeps its debug boxes.
    if (debugOn && det.boxes.length) {
        const ranks = panelRanks(det.panels ?? []);
        state.debugOrig = await renderDebugView(bitmap, det.boxes, det.panels, ranks, det.dropped, det.panelDropped);
        // canvas pages reuse the kept translated bitmap (transfer is one-shot);
        // img pages transfer here as before — the canvas is dead after this
        const bmp = state.translatedBmp ?? canvas.transferToImageBitmap();
        state.debug = await renderDebugView(bmp, det.boxes, det.panels, ranks, det.dropped, det.panelDropped);
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
    if (!prep.cached && pipeline.cacheEnabled) {
        void cachePut({
            key: cacheKey(chapterKey(), prep.hash),
            fp: settingsFingerprint(pipeline),
            w: bitmap.width, h: bitmap.height,
            boxes: det.boxes, panels: det.panels ?? [],
            outputs, extras, mentions,
            mask: packMask(det.mask),
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
