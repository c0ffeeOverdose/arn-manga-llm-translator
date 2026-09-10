// Overlay sweeper: re-apply translated/original src to every loaded page
// element. Rendering sets src on the element captured at enqueue time, but
// the paged reader can swap/replace elements while a job sits in the queue —
// the old code drew into a dead element (console says Done, screen unchanged).
// A periodic sweep also re-applies overlays if the reader resets src itself.
// ponytail: polling sweep (1s) — MutationObserver on the reader's DOM would
// be event-driven but fragile against its lazy-load churn; this is cheap
// (a handful of imgs) and self-healing.

import { chapterKey, contextChapter, resetContextIfNewChapter, pages, elStates } from './state';
import { refKey, getPages, repaintByHash, healImgBinding, writePage } from './page-io';
import { clearQueue, failMarks } from './queue';

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
            continue;
        }
        // bound element showing an unknown URL (fresh blob the map never saw):
        // verify by content hash, never paint blind (recycled nodes lie)
        if (!keyed && ref.kind === 'img') { void healImgBinding(ref.el, st); continue; }
        writePage(ref, st); // idempotent — heals reader redraws underneath
    }
}
