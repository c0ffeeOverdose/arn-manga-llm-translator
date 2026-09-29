// Overlay sweeper: re-apply translated/original src to every loaded page element.
// The reader can swap elements mid-queue — poll every 1s (cheap, self-healing).

import { chapterKey, contextChapter, resetContextIfNewChapter, pages, elStates, pipeline, loadPipeline, stateFor, overlayChoice, setOverlayOn, type PageRef } from './state';
import { refKey, getPages, readPage, repaintByHash, healImgBinding, writePage } from './page-io';
import { clearQueue, failMarks, queue, pageKeyOf, paintHas, activeKeyGet, viewportOverlap } from './queue';
import { cacheGet, cacheKey, pageHashFromBitmap } from './page-cache';
import { detFromCacheEntry } from './pipeline';
import { renderPage } from './render-page';
import { autoOn } from './auto';
import { sweepArrivable, sweepCommitted } from './sweep';
import { isDebug } from '../debug';

export function applyOverlays(): void {
    // SPA navigation watch: an SPA story change must not inherit the old run's
    // queue/book — page-turns share the normalized key, so click-through still works.
    if (chapterKey() !== contextChapter) {
        clearQueue();
        resetContextIfNewChapter();
        failMarks.clear(); // new story, new marks — old cooldowns must not leak across
    }
    for (const ref of getPages()) {
        const keyed = pages.get(refKey(ref));
        const st = keyed ?? (ref.kind === 'img' ? elStates.get(ref.el) : undefined);
        if (!st) {
            if (ref.kind === 'img') void repaintByHash(ref.el);
            // arrival paint: a committed-but-unpainted page the user is looking
            // at — IDB hit paints with no queue and no LLM; miss stays quiet.
            void arrivalPaint(ref);
            continue;
        }
        // bound element showing an unknown URL: verify by content hash, never paint blind.
        if (!keyed && ref.kind === 'img') { void healImgBinding(ref.el, st); continue; }
        writePage(ref, st); // idempotent — heals reader redraws underneath
    }
}

// arrival paint, bounded: visible + loaded + stateless + jobless refs only,
// one in flight per element. A miss is dims-qualified and expires after a minute.
// renderPage folds iff !bookHas — its own guard, same rule as every other path.
const ARRIVAL_RETRY_MS = 60000;
const ARRIVAL_GATE_MS = 5000; // gated pages (no auto, uncommitted): recheck cheaply, never hot-loop the fetch
const arrivalMiss = new WeakMap<Element, { src: string; dims: string; at: number }>();
const arrivalGate = new WeakMap<Element, number>();
const arrivalBusy = new WeakSet<Element>();
function arrivalStuck(el: Element, src: string, dims: string): boolean {
    const m = arrivalMiss.get(el);
    return !!m && m.src === src && m.dims === dims && Date.now() - m.at < ARRIVAL_RETRY_MS;
}
async function arrivalPaint(ref: PageRef): Promise<void> {
    const el = ref.el;
    // explicit intent only: a reopened page shows originals until the user
    // presses Translate chapter / enables auto. This session's own sweep
    // commits are the exception (checked by hash below).
    if ((!autoOn() && !sweepArrivable()) || arrivalBusy.has(el) || document.hidden) return;
    let dims = '';
    if (ref.kind === 'img') {
        const img = el as HTMLImageElement;
        if (!(img.complete && img.naturalWidth > 0)) return;
        dims = `${img.naturalWidth}x${img.naturalHeight}`;
    }
    if (viewportOverlap(ref) <= 0) return; // the sweep paints loaded offscreen pages itself
    const src = ref.kind === 'img' ? ((el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src) : refKey(ref);
    if (arrivalStuck(el, src, dims)) return;
    if (Date.now() - (arrivalGate.get(el) ?? 0) < ARRIVAL_GATE_MS) return;
    const key = pageKeyOf(ref);
    if (queue.some(j => j.key === key) || paintHas(key) || activeKeyGet() === key) return;
    arrivalBusy.add(el);
    try {
        await loadPipeline();
        const srcUrl = refKey(ref);
        const { bitmap, bytes } = await readPage(ref, srcUrl);
        const hash = pageHashFromBitmap(bitmap);
        const hit = pipeline.cacheEnabled ? await cacheGet(cacheKey(chapterKey(), hash)) : undefined;
        const det = hit ? detFromCacheEntry(hit, bitmap.width, bitmap.height) : null;
        // permission: auto covers everything; otherwise only this session's sweep commits.
        if (!det || !hit || stateFor(ref)) { arrivalMiss.set(el, { src, dims, at: Date.now() }); return; }
        if (!autoOn() && !sweepCommitted(hash)) { arrivalGate.set(el, Date.now()); return; }
        if (isDebug()) console.log('[mt] arrival paint (cache):', src.slice(-24));
        await renderPage(ref, { srcUrl, bitmap, det, hash, cached: hit,
            origBytes: ref.kind === 'canvas' ? bytes : undefined }, () => {}, false);
        // first state in this document comes from arrival — flip the overlay here
        // (jobs flip at completion). An explicit "Show original" pin wins.
        if (overlayChoice === 'auto') setOverlayOn(true);
    } catch { /* transient — no miss mark, the minute-retry above re-arms */ }
    finally { arrivalBusy.delete(el); }
}
