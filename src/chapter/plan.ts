import type { ChapterPage, PagePhase } from './model';

export interface ChapterPlanPage extends ChapterPage { phase: PagePhase }

export function pagePhase(planned: PagePhase): PagePhase {
    return planned;
}

// `phases` is positional (status.pages[i] describes planned page i) — never index it by
// order, or a page whose order drifted from its slot gets planned over and over.
function orderedDue<T extends { id: string; order: number }>(phases: PagePhase[], pages: T[], priority: string): T[] {
    // A page waiting for its pixels is skipped, never allowed to block the run: the reader
    // may not materialize it for a long time (virtualized/lazy DOM), and holding every other
    // page behind it left a chapter stuck part-way with work still available.
    const due = pages.filter((_, i) => phases[i] === 'queued');
    due.sort((a, b) => Number(b.id === priority) - Number(a.id === priority) || a.order - b.order);
    return due;
}

export function nextBatch<T extends { id: string; order: number }>(
    phases: PagePhase[], pages: T[], opts: { perBatch: number; priority: string },
): T[] {
    return orderedDue(phases, pages, opts.priority).slice(0, Math.max(1, Math.min(3, opts.perBatch)));
}

// One work slot: up to `size` queued pages for ONE LLM request. Priority page first, then
// reading order. No wave cap — the pump's slot count bounds concurrency, not the planner.
export function nextGroup<T extends { id: string; order: number }>(
    phases: PagePhase[], pages: T[], opts: { size: number; priority: string },
): T[] {
    return orderedDue(phases, pages, opts.priority).slice(0, Math.max(1, Math.min(10, opts.size)));
}
