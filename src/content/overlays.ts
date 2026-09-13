// Overlay sweeper: re-apply translated/original src to every loaded page
// element. Rendering sets src on the element captured at enqueue time, but
// the paged reader can swap/replace elements while a job sits in the queue —
// the old code drew into a dead element (console says Done, screen unchanged).
// A periodic sweep also re-applies overlays if the reader resets src itself.
// ponytail: polling sweep (1s) — MutationObserver on the reader's DOM would
// be event-driven but fragile against its lazy-load churn; this is cheap
// (a handful of imgs) and self-healing.

import { chapterKey, contextChapter, resetContextIfNewChapter, pages, elStates, pipeline, loadPipeline, stateFor, overlayChoice, setOverlayOn, type PageRef } from './state';
import { refKey, getPages, readPage, repaintByHash, healImgBinding, writePage } from './page-io';
import { clearQueue, failMarks, queue, pageKeyOf, paintHas, activeKeyGet, viewportOverlap } from './queue';
import { cacheGet, cacheKey, pageHashFromBitmap } from './page-cache';
import { detFromCacheEntry } from './pipeline';
import { renderPage } from './render-page';
import { autoOn } from './auto';
import { isDebug } from '../debug';

export function applyOverlays(): void {
    // SPA navigation watch: full loads reboot the script (queue dies with it),
    // but same-tab SPA moves keep the queue + chapter loop alive — a story
    // change must not inherit the old run (it would queue story B's pages
    // into story A's chapter run and fold them into its book). Page-turns
    // share the normalized key, so 1→2→3 click-through keeps working.
    if (chapterKey() !== contextChapter) {
        clearQueue();
        resetContextIfNewChapter();
        failMarks.clear(); // new story, new marks — old cooldowns must not leak across
    }
    for (const ref of getPages()) {
        const keyed = pages.get(refKey(ref));
        const st = keyed ?? (ref.kind === 'img' ? elStates.get(ref.el) : undefined);
        if (!st) {
            // fast repaint lane (back-nav onto known content under a fresh URL) —
            // first-time pages miss the index and stay on the queue path
            if (ref.kind === 'img') void repaintByHash(ref.el);
            // arrival paint: a committed-but-unpainted page the user is looking
            // at (sweep commit while it wasn't loaded, fresh doc, auto off) —
            // IDB hit paints with no queue and no LLM; miss stays quiet.
            void arrivalPaint(ref);
            continue;
        }
        // bound element showing an unknown URL (fresh blob the map never saw):
        // verify by content hash, never paint blind (recycled nodes lie)
        if (!keyed && ref.kind === 'img') { void healImgBinding(ref.el, st); continue; }
        writePage(ref, st); // idempotent — heals reader redraws underneath
    }
}

// arrival paint, bounded: visible + loaded + stateless + jobless refs only,
// one in flight per element. A miss is dims-qualified (placeholder→full swap
// re-arms) and expires after a minute (transient read/IDB hiccups must not
// poison a src forever — the old permanent mark needed one manual press to
// unstick). renderPage folds iff !bookHas — its own guard, same rule as every
// other path (a never-folded entry folds here, an already-folded one paints
// only). Cross-module calls stay in function bodies (queue↔sweep convention).
const ARRIVAL_RETRY_MS = 60000;
const arrivalMiss = new WeakMap<Element, { src: string; dims: string; at: number }>();
const arrivalBusy = new WeakSet<Element>();
function arrivalStuck(el: Element, src: string, dims: string): boolean {
    const m = arrivalMiss.get(el);
    return !!m && m.src === src && m.dims === dims && Date.now() - m.at < ARRIVAL_RETRY_MS;
}
async function arrivalPaint(ref: PageRef): Promise<void> {
    const el = ref.el;
    // explicit intent only: a reopened page shows originals until the user
    // presses Translate chapter / enables auto — silent repainting of cached
    // pages on arrival reads as haunted (user-verdict, 2026-09-13)
    if (!autoOn() || arrivalBusy.has(el) || document.hidden) return;
    let dims = '';
    if (ref.kind === 'img') {
        const img = el as HTMLImageElement;
        if (!(img.complete && img.naturalWidth > 0)) return;
        dims = `${img.naturalWidth}x${img.naturalHeight}`;
    }
    if (viewportOverlap(ref) <= 0) return; // the sweep paints loaded offscreen pages itself
    const src = ref.kind === 'img' ? ((el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src) : refKey(ref);
    if (arrivalStuck(el, src, dims)) return;
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
        if (!det || !hit || stateFor(ref)) { arrivalMiss.set(el, { src, dims, at: Date.now() }); return; }
        if (isDebug()) console.log('[mt] arrival paint (cache):', src.slice(-24));
        await renderPage(ref, { srcUrl, bitmap, det, hash, cached: hit,
            origBytes: ref.kind === 'canvas' ? bytes : undefined }, () => {}, false);
        // first state in this document comes from arrival, not a job — flip
        // the overlay or writePage keeps showing the original underneath
        // (jobs flip it at completion; arrival must do its own). An explicit
        // "Show original" pin wins: paint into memory, display stays.
        if (overlayChoice === 'auto') setOverlayOn(true);
    } catch { /* transient — no miss mark, the minute-retry above re-arms */ }
    finally { arrivalBusy.delete(el); }
}
