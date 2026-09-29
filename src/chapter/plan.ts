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
    // A page still waiting for its pixels blocks the run: taking it now would strand it
    // and loop on the same candidates forever.
    if (phases.includes('waiting')) return [];
    const due = pages.filter((_, i) => phases[i] === 'queued');
    due.sort((a, b) => Number(b.id === opts.priority) - Number(a.id === opts.priority) || a.order - b.order);
    return due.slice(0, Math.max(1, Math.min(3, opts.perBatch)));
}
