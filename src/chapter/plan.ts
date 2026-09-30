import type { ChapterPage, PagePhase } from './model';

export interface ChapterPlanPage extends ChapterPage { phase: PagePhase }

export function pagePhase(planned: PagePhase): PagePhase {
    return planned;
}

// `phases` is positional (status.pages[i] describes planned page i) — never index it by
// order, or a page whose order drifted from its slot gets planned over and over.
export function nextBatch<T extends { id: string; order: number }>(
    phases: PagePhase[], pages: T[], opts: { perBatch: number; priority: string },
): T[] {
    // A page waiting for its pixels is skipped, never allowed to block the run: the reader
    // may not materialize it for a long time (virtualized/lazy DOM), and holding every other
    // page behind it left a chapter stuck part-way with work still available.
    const due = pages.filter((_, i) => phases[i] === 'queued');
    due.sort((a, b) => Number(b.id === opts.priority) - Number(a.id === opts.priority) || a.order - b.order);
    return due.slice(0, Math.max(1, Math.min(3, opts.perBatch)));
}
