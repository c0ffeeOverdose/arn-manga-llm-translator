import type { ContextState, RegionOutput, Mention } from '../llm/core';
import type { PipelineSettings } from '../llm/pipeline-settings';
import type { ImageIdentity, ImageSignature } from '../image-identity';

export interface ChapterPage {
    id: string;
    url: string;
    order: number;
    descramble: boolean;
    source?: string;
    inBaseContext?: boolean;
    // Sibling encoding of the same page (paged readers that ship two tiers): a CDN may evict
    // one tier's file while the other is intact, so a 404 on `url` retries this once. Same
    // page ordinal, never a different page.
    alt?: string;
}
export type PagePhase = 'queued' | 'reading' | 'detecting' | 'translating' | 'rendering' | 'ready' | 'failed' | 'waiting';
export interface ChapterProgress {
    id: string;
    chapter: string;
    phase: 'running' | 'stopping' | 'stopped' | 'complete' | 'waiting' | 'error';
    done: number;
    total: number;
    inflight: number;
    errors: number;
    completeManifest: boolean;
    pages: { id: string; url: string; phase: PagePhase; hash?: string; revision?: number; order?: number;
        image?: ImageSignature; matchedBy?: 'url' | 'image' }[];
    message?: string;
    // Transient, user-facing line shown with the running progress (e.g. "retrying with smaller
    // batches" after an empty reply was split). Set and cleared by the runner.
    notice?: string;
    // Last breadcrumbs from the runner, for a harness debugging a failure. Never shown
    // to the user: the pill reads `message`, this is diagnosis only.
    diagnostics?: string;
}
export interface ChapterStart {
    cacheEpoch?: string;
    chapter: string;
    readerUrl: string;
    pages: ChapterPage[];
    completeManifest: boolean;
    pipeline: PipelineSettings;
    context: ContextState;
    bookKey: string;
    shareContext: boolean;
    nextDocument?: string;
    // Page-image shape floor, learned from the images already loaded in the reader. The
    // runner needs it to tell page art from ads/spacers in a document it only parsed.
    imageFilter?: { minW?: number; minH?: number };
    seeds?: { page: string; image: string; entry: import('../content/page-cache').CachedPage; maskData: string; identity?: ImageIdentity }[];
}
export interface Contribution {
    id: string;
    order: number;
    hash: string;
    outputs: RegionOutput[];
    mentions: Mention[];
}

// Fetch a paged page's pixels, retrying the sibling encoding when the preferred URL is gone
// (a CDN evicts one tier while the other survives; the tiers are different files, so only the
// alternate the enumerator captured can reach it). `onRetry` reports why, for diagnostics.
// Pure control flow — the fetch itself is injected so the retry contract is unit-tested.
export async function fetchSourceWithAlternate<T>(
    primary: string, alt: string | undefined,
    load: (url: string) => Promise<T>, onRetry?: (message: string) => void,
): Promise<T> {
    try {
        return await load(primary);
    } catch (e) {
        if (!alt) throw e;
        onRetry?.((e as Error).message);
        return load(alt);
    }
}

export function remainingPages<T>(pages: T[], anchor: number): T[] {
    // An unknown anchor must not silently translate from the chapter head.
    return anchor >= 0 && anchor < pages.length ? pages.slice(anchor) : [];
}

// Why a chapter enumeration found nothing to do. Kept pure so the popup can say the real
// reason instead of leaving a disabled button to be misread as "this site is unsupported".
export type SweepCountReason = 'known' | 'no-pages' | 'no-anchor' | 'last-page';
export function sweepCount(total: number, anchor: number): { count: number; reason: SweepCountReason } {
    if (!total) return { count: 0, reason: 'no-pages' };
    if (anchor < 0) return { count: 0, reason: 'no-anchor' };
    const count = Math.max(0, total - anchor);
    return { count, reason: count ? 'known' : 'last-page' };
}

export function sweepCountMessage(reason: SweepCountReason): string {
    switch (reason) {
        case 'no-pages': return 'No pages found on this reader — open a page image and try again';
        case 'no-anchor': return 'Could not match the page you are on — scroll to a page image and try again';
        case 'last-page': return 'You are on the last page of this chapter';
        default: return '';
    }
}

export function chapterMessage(s: ChapterProgress): string {
    const ready = `${s.done} of ${s.total} ${s.total === 1 ? 'page' : 'pages'} ready to read`;
    if (s.phase === 'stopping') return `Stopping chapter translation… · ${ready}`;
    if (s.phase === 'stopped') return `Translation stopped · ${ready}`;
    if (s.phase === 'error') return `${s.message || 'Chapter translation paused'} · ${ready}`;
    if (s.phase === 'waiting') return `${ready} · Waiting for more page images`;
    if (s.phase === 'complete') return s.errors
        ? `${ready} · ${s.errors} ${s.errors === 1 ? 'page' : 'pages'} could not be translated`
        : `Chapter translation complete · ${s.done} ${s.done === 1 ? 'page' : 'pages'} ready to read`;
    const working = `${ready}${s.inflight ? ` · Working on ${s.inflight} ${s.inflight === 1 ? 'page' : 'pages'}` : ''}`;
    return s.notice ? `${working} · ${s.notice}` : working;
}

export function providerMessage(kind?: string): string {
    if (kind === 'ratelimit') return 'Translation paused — provider request limit reached';
    if (kind === 'auth') return 'Translation paused — check your API key and provider balance';
    return 'Chapter translation paused — open the error details to continue';
}
