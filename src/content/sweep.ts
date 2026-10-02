// Reader-side chapter controller. Execution and rendered artifacts live in the extension host.
import { chapterKey, pipeline, context, loadContext, loadPipeline, bookKey, shareContext, stateFor,
    regPage, unregPage, overlayChoice, setOverlayChoice, setOverlayOn, acceptChapterContext, type PageRef } from './state';
import { getPages, refKey, episodeManifestSrcs, fetchPagedUrls, pagedTierAlternates, galleryManifestJson,
    collectUnloadedUrls, bitmapBlank, writePage, fetchBitmap, ownOriginalUrl } from './page-io';
import { galleryAllUrls, matchAnchor, pageHashFromBitmap, samePagePath, unpackMask,
    registerSweepWaiter, abortLookahead, settingsFingerprint, packMask, cachePut, cacheKey,
    pageKey, PAGE_KEY_GEN } from './page-cache';
import { viewportOverlap, dropAutoQueued, resumeAuto, isBusy, paintBusy, haltAuto } from './queue';
import { lookaheadActive } from './auto';
import { setActivity, removeActivity, lastMsgSet, renderStatus, pillUnDismiss, logError } from './status-ui';
import { remainingPages, sweepCount, type SweepCountReason, chapterMessage, type ChapterPage, type ChapterProgress, type ChapterStart } from '../chapter/model';
import { blobDataUrl } from '../chapter/store';
import type { CachedPage } from './page-cache';
import { chapterSignature } from '../chapter/protocol';
import { identifyBitmap, imageCandidates, verifyBitmap, signatureOf, type ImageIdentity } from '../image-identity';
import { readView, verifyView, verifyViewFresh, viewSource, viewToken, type PageSnapshot } from './page-identity';
import { nextDocument, guessNextDocument } from '../chapter/discovery';
import { isDebug } from '../debug';
import { ensurePageDebugViews } from './ocr';
import { cacheReady, cacheCurrent, assertCacheCurrent } from '../cache-generation';

let progress: ChapterProgress | null = null;
let starting = false;
let startCancelled = false;
let observedChapter = '';
let refreshBusy = false;
let discoverAt = 0;
let notified = '';
let foldedChapter = '';
let attachWhy = ''; // why the last attach attempt refused — a page translated but not painted
const folded = new Set<string>();
const refs = new Map<string, PageRef>();
const attaching = new WeakSet<Element>();
const applied = new WeakMap<Element, string>();
const sourceRequests = new Map<string, Promise<string | undefined>>();
type ProgressPage = ChapterProgress['pages'][number];
const imageBindings = new WeakMap<Element, { run: string; token: string; page: string; source: string;
    exact: string; revision?: number; complete: boolean }>();
const imageAliases = new Map<string, string>();
const evidence = new Map<string, Promise<ImageIdentity | undefined>>();
const sourceImages = new Map<string, Promise<ImageIdentity>>();

function syncBook(): void {
    if (foldedChapter !== chapterKey()) { foldedChapter = chapterKey(); folded.clear(); }
}
export function bookHas(hash: string): boolean { syncBook(); return folded.has(hash); }
export function bookAdd(hash: string): void { syncBook(); folded.add(hash); }
export function bookDrop(hash: string): void { syncBook(); folded.delete(hash); }
export function forgetSweep(): void {
    startCancelled = true;
    progress = null; refs.clear(); evidence.clear(); imageAliases.clear(); sourceImages.clear(); sourceRequests.clear();
    folded.clear(); notified = ''; attachWhy = '';
    removeActivity('sweep');
}
export function sweepArrivable(): boolean { return !!progress && progress.chapter === chapterKey(); }
export function sweepAttachWhy(): string { return attachWhy; }
// Debug/verification view of the window mapping: each on-screen page element in DOM order,
// with the chapter order it resolves to and how that was decided.
export async function elementMap(): Promise<{ map: { index: number; order: number | null; matchedBy: string; url: string }[] }> {
    const live = getPages();
    const dom = [...document.querySelectorAll('img,canvas')].filter(el => live.some(r => r.el === el));
    return { map: await Promise.all(dom.map(async (el, index) => {
        const ref = live.find(r => r.el === el);
        if (!ref) return { index, order: null, matchedBy: 'none', url: '' };
        const page = await resolveChapterRef(ref);
        return { index, order: page?.order ?? null, matchedBy: page?.matchedBy ?? 'unmatched', url: refKey(ref).slice(-24) };
    })) };
}
export function sweepCommitted(hash: string): boolean {
    return !!progress?.pages.some(p => p.phase === 'ready' && p.hash === hash);
}
// The page's slot in the chapter, found by the URL the reader is showing. This is the
// identity the runner writes under: it survives a different encoder/host/tier, where the
// content hash does not. Returns undefined when the reader is off-manifest.
export function sweepPageOrder(url: string): number | undefined {
    return owned(url)?.order;
}
// Page slot with NO live run: a paged reader's own /N is the durable page identity, and the
// chapter cache was written under `pageKey(chapter, order)`. Without this a plain reopen had
// no way to name the page it was showing, so a finished translation never came back until a
// whole run restarted. Only the reader's own page number is used — never a guessed ordinal.
export function idlePageOrder(): number | undefined {
    const n = urlPageNumber();
    return n != null ? n - 1 : undefined;
}
export function sweepActive(): boolean {
    return starting || !!progress && progress.chapter === chapterKey() && ['running', 'waiting', 'stopping'].includes(progress.phase);
}
export interface SweepStatus {
    active: boolean; phase: 'starting' | 'running' | 'stopping' | 'dead'; stopping: boolean;
    done: number; total: number; errors: number; skipped: number; inflight: number;
}
export function sweepStatus(): SweepStatus | null {
    if (starting) return { active: true, phase: 'starting', stopping: false, done: 0, total: 0, errors: 0, skipped: 0, inflight: 0 };
    if (!progress || progress.chapter !== chapterKey()) return null;
    return { active: sweepActive(), phase: progress.phase === 'stopping' ? 'stopping' : 'running',
        stopping: progress.phase === 'stopping', done: progress.done, total: progress.total,
        errors: progress.errors, skipped: 0, inflight: progress.inflight };
}
function original(ref: PageRef): string {
    return viewSource(ref);
}
function visible(): PageRef | undefined {
    const ranked = getPages().sort((a, b) => viewportOverlap(b) - viewportOverlap(a));
    // Any overlap wins. With no overlap at all (scrolled past the images, or hidden in a
    // container), the top-ranked page is still the reader's best-known position — a null
    // here used to abort the whole run.
    return ranked[0];
}
function owned(url: string) {
    if (progress?.chapter !== chapterKey()) return undefined;
    return progress.pages.find(p => p.url === url || samePagePath(p.url, url))
        ?? progress.pages.find(p => p.id === imageAliases.get(url));
}
const PAGE_IN_URL = /\/(?:chapter|read)\/[^/]+\/(\d+)(?:\/|$)/;
function urlPageNumber(): number | null {
    const m = location.pathname.match(PAGE_IN_URL);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function ownedRef(ref: PageRef): ProgressPage | undefined {
    if (!progress || progress.chapter !== chapterKey()) return;
    const source = original(ref);
    const direct = progress.pages.find(p => p.url === source || samePagePath(p.url, source));
    if (direct) return { ...direct, matchedBy: 'url' };
    const binding = imageBindings.get(ref.el);
    if (binding?.run !== progress.id || binding.token !== viewToken(ref)) return;
    const page = progress.pages.find(p => p.id === binding.page);
    return page ? { ...page, matchedBy: 'image' } : undefined;
}
async function pageEvidence(page: ProgressPage): Promise<ImageIdentity | undefined> {
    const run = progress?.id;
    const key = `${run}:${page.id}:${page.revision ?? 0}`;
    let task = evidence.get(key);
    if (!task) {
        task = chrome.runtime.sendMessage({ type: 'mt:chapter-result', chapter: chapterKey(), page: page.id, evidenceOnly: true })
            .then(r => r?.result?.signature === chapterSignature(pipeline) ? r.result.identity : undefined)
            .catch(() => undefined);
        evidence.set(key, task!);
    }
    return task;
}
// URL identity may prioritize work; only unique, pixel-verified evidence binds opaque images.
export async function resolveChapterRef(ref: PageRef, supplied?: PageSnapshot): Promise<ProgressPage | undefined> {
    const token = await cacheReady();
    if (!progress || progress.chapter !== chapterKey()) return;
    const run = progress.id, chapter = chapterKey();
    const direct = progress.pages.find(p => p.url === original(ref) || samePagePath(p.url, original(ref)));
    if (direct) return { ...direct, matchedBy: 'url' };
    const binding = imageBindings.get(ref.el), state = stateFor(ref);
    const live = ref.kind === 'img' ? ref.el.currentSrc || ref.el.src : '';
    const bound = progress.pages.find(p => p.id === binding?.page);
    if (ref.kind === 'img' && progress.phase === 'complete' && binding?.complete && binding.run === run
        && state?.orig === binding.source && state.image?.exact === binding.exact && bound && bound.revision === binding.revision
        && [state.translated, state.origOwn].includes(live)) {
        imageBindings.set(ref.el, { ...binding, token: viewToken(ref) });
        return { ...bound, matchedBy: 'image' };
    }
    let snapshot = supplied;
    try {
        snapshot ??= await readView(ref);
        const matches: ProgressPage[] = [];
        for (const page of imageCandidates(snapshot.image, progress.pages)) {
            const identity = await pageEvidence(page);
            if (!cacheCurrent(token) || progress?.id !== run || chapterKey() !== chapter || viewToken(ref) !== snapshot.token) return;
            // A page still being worked on has no artifact to verify against yet: SKIP it, do
            // not abort the whole resolve. Aborting here meant the visible, already-finished
            // page stayed unmatched whenever a pending neighbour happened to be a close
            // pixel candidate — it then never attached and its paid translation was stranded.
            if (!identity) continue;
            if (verifyBitmap(snapshot.bitmap, identity)) matches.push(page);
            if (matches.length > 1) return;
        }
        if (matches.length === 1) {
            const page = matches[0];
            imageBindings.set(ref.el, { run, token: snapshot.token, page: page.id, source: snapshot.source,
                exact: snapshot.image.exact, revision: page.revision, complete: progress.phase === 'complete' });
            if (ref.kind === 'img') imageAliases.set(snapshot.source, page.id);
            return { ...page, matchedBy: 'image' };
        }
        if (matches.length > 1) return;
        // Pixel evidence resolved nothing: for a reader that ships an authoritative chapter
        // manifest, the URL's own page number is a reliable position. A paged reader shows one
        // page per /N, and the run enumerated the chapter in order from the reader's API, so
        // index N-1 is that page. This is a POSITION hint, not a paint authorization on its
        // own: attach still re-reads the view and verifies the artifact's pixels before
        // painting, so a mismatch is refused there rather than painting a neighbour.
        // Only for a complete, reader-authored manifest — the case where order IS the page
        // number. An incomplete/DOM-discovered run must never be position-guessed.
        const hint = progress.completeManifest ? urlPageNumber() : null;
        if (hint != null) {
            // page.order is the ABSOLUTE chapter slot (0-based), so it survives a run that
            // started mid-chapter — a positional index would not.
            const byOrder = progress.pages.find(p => p.order === hint - 1);
            if (byOrder) {
                refs.set(byOrder.id, ref);
                return { ...byOrder, matchedBy: 'url' };
            }
        }
        return;
    } catch { return; }
    finally { if (!supplied) snapshot?.bitmap.close(); }
}
export function sweepHas(url: string): boolean {
    return !!owned(url) && sweepActive();
}
async function control(command: string, extra: Record<string, unknown> = {}): Promise<any> {
    return chrome.runtime.sendMessage({ type: 'mt:chapter-control', chapter: chapterKey(), command, ...extra });
}

// Manual/auto requests join the chapter owner, including explicit retranslation.
export function chapterOwnsRequest(ref: PageRef, force: boolean): boolean {
    const page = ownedRef(ref);
    if (!page) return false;
    if (!sweepActive() && !force && page.phase !== 'ready') return false;
    refs.set(page.id, ref);
    if (force) {
        // Keep the old state until replacement: it owns the original pixels behind a
        // revoked reader blob. The new revision replaces its paint and context together.
        applied.delete(ref.el);
        void control('retry', { page: page.id }).catch(reportError);
    } else {
        void control('prioritize', { page: page.id }).catch(reportError);
        if (page.phase === 'ready') void attach(ref, page);
    }
    return true;
}
async function enumerate(): Promise<{ pages: ChapterPage[]; anchor: number; complete: boolean }> {
    const live = getPages();
    const current = visible();
    let urls = episodeManifestSrcs();
    let unresolvedManifest = false;
    let descramble = !!urls?.length;
    // A paged reader whose API lists the whole chapter is the most reliable source there
    // is: it survives virtualization, lazy loading and host rotation. Ask it first.
    if (!urls?.length) urls = await fetchPagedUrls();
    if (!urls?.length) {
        const first = live.find(r => r.kind === 'img' && /^https?:/.test(original(r)));
        if (first) urls = galleryAllUrls(await galleryManifestJson(), original(first)).urls;
    }
    if (urls?.length) {
        // A paged reader may ship two encodings of each page; a CDN can evict one, so carry
        // the sibling as a per-page retry (positional — index i is the same page ordinal).
        const alts = pagedTierAlternates();
        const pages = urls.map((url, order) => ({ id: `page:${order}`, url, order, descramble, ...(alts[order]?.[0] ? { alt: alts[order][0] } : null) }));
        const anchor = await anchorInList(urls, live, current);
        if (anchor >= 0) return { pages, anchor, complete: true };
        unresolvedManifest = true;
    }
    descramble = false;
    const known = new Set(live.map(original));
    const unloaded = new Set(collectUnloadedUrls(known));
    const ordered: { url: string; ref?: PageRef }[] = [];
    for (const el of document.querySelectorAll('img,canvas')) {
        const ref = live.find(r => r.el === el);
        const img = el instanceof HTMLImageElement ? el : null;
        const url = ref ? original(ref) : img && (img.currentSrc || img.src);
        if (!url || (!ref && !unloaded.has(url)) || ordered.some(p => p.url === url)) continue;
        ordered.push({ url, ref });
    }
    const pages = ordered.map(({ url, ref }, order) => {
        const id = `url:${url}`;
        if (ref) refs.set(id, ref);
        return { id, url, order, descramble };
    });
    // The anchor is the visible page; when it cannot be resolved, fall back to the
    // highest page that already has pixels. A reader whose page images are all lazy
    // still has the current page decoded, and returning nothing is what the user read
    // as "this site is not supported".
    let anchor = current ? ordered.findIndex(p => p.ref?.el === current.el) : -1;
    if (anchor < 0) anchor = highestKnown(ordered, live);
    // A paginated/virtualized reader without a manifest is discovery-incomplete.
    const hasNext = !!document.querySelector('a[rel="next"], link[rel="next"], [data-next-page], [data-infinite-scroll]');
    const unresolved = live.some(r => r.kind === 'canvas' && !r.el.width);
    return { pages, anchor, complete: !unresolvedManifest && !hasNext && !unresolved };
}

// The reader's position when nothing else identifies it: the last list entry the reader
// has actually loaded, by element identity or by URL. Pages after it are still ahead.
function highestKnown(ordered: { url: string; ref?: PageRef }[], live: PageRef[]): number {
    let best = -1;
    for (const ref of live) {
        const keys = [original(ref), refKey(ref)];
        for (const key of keys) {
            const found = ordered.findIndex(p => p.ref?.el === ref.el || p.url === key
                || (p.ref && key === original(p.ref)));
            if (found > best) best = found;
        }
    }
    return best;
}
export async function sweepPages(): Promise<{ count: number; reason: SweepCountReason }> {
    const result = await enumerate();
    return sweepCount(result.pages.length, result.anchor);
}
// The chapter list and the live reader disagree (different CDN host, a swapped element).
// Anchor on the highest live page the list knows, so "translate to the end" still starts
// at the reader's position instead of at the chapter head or on nothing at all.
function nearestAnchor(urls: string[], live: PageRef[]): number {
    let best = -1;
    for (const ref of live) {
        for (const candidate of [original(ref), refKey(ref)]) {
            const found = urls.findIndex(u => u === candidate || samePagePath(u, candidate));
            if (found > best) best = found;
        }
    }
    return best;
}

// Chapter position comes from a source URL or verified pixels; a URL page number is
// only a search hint. An unreadable manifest falls back to captured DOM pages.
async function anchorInList(urls: string[], live: PageRef[], current: PageRef | undefined): Promise<number> {
    if (current) {
        const direct = matchAnchor(urls, [original(current), refKey(current)]);
        if (direct >= 0) return direct;
    }
    const byUrl = nearestAnchor(urls, live);
    if (!current) return byUrl;
    let snapshot: PageSnapshot | undefined;
    const href = location.href;
    try {
        snapshot = await readView(current);
        const hint = urlPageNumber();
        const indices = urls.map((_, i) => i);
        if (hint && hint <= urls.length) {
            indices.splice(indices.indexOf(hint - 1), 1);
            indices.unshift(hint - 1);
        }
        const matches: number[] = [];
        for (const index of indices) {
            let identity: ImageIdentity;
            try {
                let task = sourceImages.get(urls[index]);
                if (!task) {
                    task = fetchBitmap(urls[index]).then(({ bitmap }) => {
                        try { return identifyBitmap(bitmap); } finally { bitmap.close(); }
                    });
                    sourceImages.set(urls[index], task);
                }
                identity = await task;
            } catch { continue; }
            if (location.href !== href || viewToken(current) !== snapshot.token) return -1;
            if (verifyBitmap(snapshot.bitmap, identity)) {
                if (hint === index + 1) return index;
                matches.push(index);
                if (matches.length > 1) return -1;
            }
        }
        return matches.length === 1 ? matches[0] : -1;
    } catch { return byUrl; }
    finally { snapshot?.bitmap.close(); }
}
function reportError(e: unknown): void {
    if ((e as Error)?.name === 'AbortError') return;
    const text = (e as Error).message || String(e);
    lastMsgSet({ text: `Chapter translation paused — ${text}`, phase: 'error', until: Date.now() + 10000 });
    renderStatus();
    void logError(text, undefined, 'chapter');
}
export async function startSweep(): Promise<{ ok: boolean; total?: number; error?: string; starting?: boolean; cancelled?: boolean }> {
    if (starting) return { ok: true, starting: true };
    if (sweepActive()) return { ok: true, total: progress?.total };
    starting = true;
    startCancelled = false;
    const chapter = chapterKey();
    try {
        const cacheEpoch = await cacheReady();
        pillUnDismiss();
        setOverlayChoice('auto');
        abortLookahead();
        dropAutoQueued();
        resumeAuto();
        setActivity('sweep', 'Preparing chapter translation…', 'sweep', 'read');
        // Existing manual work owns its pixels and context until it settles.
        while (isBusy() || paintBusy() || lookaheadActive()) {
            if (startCancelled || chapter !== chapterKey()) return { ok: true, cancelled: true };
            setActivity('sweep', 'Finishing the current page before starting the chapter…', 'sweep', 'llm');
            await new Promise(r => setTimeout(r, 200));
        }
        await loadPipeline();
        await loadContext();
        setActivity('sweep', 'Finding the remaining pages in this chapter…', 'sweep', 'read');
        const found = await enumerate();
        const pages = remainingPages(found.pages, found.anchor);
        if (!pages.length) {
            // Distinguish "no pages at all" from "found them, but not where you are".
            // The popup already explains the reason; the pill must agree with it.
            throw new Error(found.pages.length
                ? 'Could not match the page you are on — scroll to a page image and try again'
                : 'No page images found on this reader — scroll to a page and try again');
        }
        const seeds: NonNullable<ChapterStart['seeds']> = [];
        for (const page of pages) {
            const ref = getPages().find(r => original(r) === page.url);
            const state = ref && stateFor(ref);
            if (!state?.det || !state.hash || !state.outputs) continue;
            const mask = packMask(state.det.mask);
            const encoded = await blobDataUrl(new Blob([mask.data]));
            seeds.push({ page: page.id, image: await blobDataUrl(await (await fetch(state.translated)).blob()),
                maskData: encoded.split(',')[1], entry: {
                    key: cacheKey(chapter, state.hash), fp: settingsFingerprint(pipeline), atime: Date.now(),
                    w: state.det.mask.width, h: state.det.mask.height, boxes: state.det.boxes, panels: state.det.panels ?? [],
                    outputs: state.outputs, extras: [], mentions: state.mentions, mask,
                }, identity: state.image });
            page.inBaseContext = bookHas(state.hash);
        }
        // Capture readable opaque pixels before the reader can destroy their document.
        for (const page of pages) if (!/^https?:/.test(page.url)) page.source = await capture(page);
        if (startCancelled || chapter !== chapterKey()) return { ok: true, cancelled: true };
        assertCacheCurrent(cacheEpoch);
        const response = await chrome.runtime.sendMessage({ type: 'mt:chapter-start', data: {
            chapter, cacheEpoch, readerUrl: location.href, pages, completeManifest: found.complete,
            pipeline: structuredClone(pipeline), context: structuredClone(context), bookKey: bookKey(), shareContext, seeds,
            nextDocument: found.complete ? undefined : nextDocument(document, location.href, chapter)
                ?? guessNextDocument(location.href, chapter),
            imageFilter: readerImageFilter(),
        } });
        assertCacheCurrent(cacheEpoch);
        if (!response?.ok) throw new Error(response?.error || 'Could not start chapter translation');
        if (startCancelled) { await control('stop'); return { ok: true, cancelled: true }; }
        progress = response.status ?? { id: response.id, chapter, phase: 'running', done: 0, total: pages.length,
            errors: 0, inflight: 0, completeManifest: found.complete,
            pages: pages.map(p => ({ id: p.id, url: p.url, phase: 'queued' })) };
        showProgress();
        return { ok: true, total: pages.length };
    } catch (e) {
        reportError(e);
        return { ok: false, error: (e as Error).message };
    } finally { starting = false; if (!sweepActive()) removeActivity('sweep'); }
}
// Shape floor for page art, learned from what the reader already rendered: the smallest
// loaded img that is not obviously a thumbnail. The host filters fetched documents by it.
function readerImageFilter(): { minW?: number; minH?: number } | undefined {
    const sizes = getPages()
        .filter(r => r.kind === 'img')
        .map(r => r.el as HTMLImageElement)
        .filter(el => el.naturalWidth > 0 && el.naturalHeight > 0)
        .map(el => ({ w: el.naturalWidth, h: el.naturalHeight }))
        .filter(s => s.h >= 300); // a manga page is at least this tall
    if (!sizes.length) return undefined;
    const minW = Math.min(...sizes.map(s => s.w));
    const minH = Math.min(...sizes.map(s => s.h));
    // Half the smallest seen page: ads and icons sit far below this, a real page never does.
    return { minW: Math.round(minW * 0.5), minH: Math.round(minH * 0.5) };
}
export function cancelSweep(): { ok: boolean } {
    startCancelled = true;
    if (progress && sweepActive()) {
        progress.phase = 'stopping';
        showProgress();
        void control('stop').catch(reportError);
    }
    return { ok: true };
}
function showProgress(): void {
    if (!progress || progress.chapter !== chapterKey()) return;
    const text = chapterMessage(progress);
    if (sweepActive()) setActivity('sweep', text, 'sweep', progress.inflight ? 'llm' : 'read');
    else {
        removeActivity('sweep');
        const token = progress.id + ':' + text;
        if (notified !== token) {
            notified = token;
            lastMsgSet({ text, phase: progress.phase === 'error' ? 'error' : 'done', until: Date.now() + 8000 });
            renderStatus();
        }
        if (progress.phase === 'error') haltAuto('chapter');
    }
}
async function capture(page: Pick<ChapterPage, 'id' | 'url'>): Promise<string | undefined> {
    const pending = sourceRequests.get(page.id);
    if (pending) return pending;
    const task = (async () => {
        const token = await cacheReady();
        const ref = refs.get(page.id) ?? getPages().find(r => original(r) === page.url);
        if (!ref?.el.isConnected) return undefined;
        if (original(ref) !== page.url && ownedRef(ref)?.id !== page.id) return undefined;
        const snapshot = await readView(ref);
        const bitmap = snapshot.bitmap;
        try {
            if (await bitmapBlank(bitmap)) return undefined;
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
            const source = await blobDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
            return cacheCurrent(token) && ref.el.isConnected && viewToken(ref) === snapshot.token ? source : undefined;
        } finally { bitmap.close(); }
    })().catch(() => undefined).finally(() => sourceRequests.delete(page.id));
    sourceRequests.set(page.id, task);
    return task;
}
async function attach(ref: PageRef, page: ChapterProgress['pages'][number]): Promise<void> {
    const bail = (why: string): void => {
        attachWhy = `${page.id}:${why}`;
        if (isDebug()) console.log('[mt] attach skipped', JSON.stringify({ page: page.id, why }));
    };
    if (!progress) { bail('no-progress'); return; }
    if (attaching.has(ref.el)) return; // a normal retry beat the in-flight attempt — not a refusal
    if (document.hidden) { bail('document-hidden'); return; }
    if (viewportOverlap(ref) <= 0) { bail('offscreen'); return; }
    const stamp = `${progress.id}:${page.id}:${page.revision ?? 0}`;
    if (applied.get(ref.el) === stamp && stateFor(ref)) return;
    const chapter = chapterKey(), run = progress.id;
    attaching.add(ref.el);
    let snapshot: PageSnapshot | undefined;
    let translated = '', origOwn: string | undefined, translatedBmp: ImageBitmap | undefined;
    let committed = false;
    try {
        const cacheEpoch = await cacheReady();
        snapshot = await readView(ref);
        const src = snapshot.source;
        const response = await chrome.runtime.sendMessage({ type: 'mt:chapter-result', chapter, page: page.id });
        const result = response?.result;
        if (!result) { bail(`no-result:${response?.error ?? 'empty'}`); return; }
        // The reader mints a fresh blob for the same page while we await the artifact, so the
        // view token legitimately moves. The token is a fast path, not the authority: a moved
        // token is re-verified against the artifact's pixels (verifyView) before painting, so a
        // recycled element showing another page is still refused. Requiring the token to be
        // frozen refused EVERY attach on a blob-rotating reader.
        const current = (): boolean => cacheCurrent(cacheEpoch) && chapterKey() === chapter && progress?.id === run && ref.el.isConnected
            && progress.pages.some(p => p.id === page.id && p.phase === 'ready' && p.revision === page.revision)
            && result.signature === chapterSignature(pipeline);
        if (!current()) { bail('view-changed'); return; }
        if (!result.identity) { bail('image-mismatch'); return; }
        // Pixel agreement is the default authorization. A complete, reader-authored manifest
        // plus the URL's own page number is an equally authoritative position for a paged
        // reader: its live rendition (blob, display size, another encoder) legitimately fails
        // byte-level agreement while still being the same page. Requiring it there refused
        // every attach, so a finished page never reached the reader and its cache stayed empty.
        // The live hash still rides along, so the revisit lookup stays a hit.
        const positional = page.matchedBy === 'url' && progress.completeManifest;
        if (!positional && !verifyBitmap(snapshot.bitmap, result.identity)) { bail('image-mismatch'); return; }
        const old = stateFor(ref);
        let imageBlob = await (await fetch(result.image)).blob();
        const packed = result.mask ? { w: result.mask.w, h: result.mask.h,
            data: Uint8Array.from(atob(result.mask.data.split(',')[1]), c => c.charCodeAt(0)).buffer } : undefined;
        const entry = { ...result.entry, mask: packed } as CachedPage;
        if (!packed) { bail('no-mask'); return; }
        if (entry.fp !== settingsFingerprint(pipeline)) { bail('fingerprint'); return; }
        const w = snapshot.bitmap.width, h = snapshot.bitmap.height;
        translatedBmp = await createImageBitmap(imageBlob);
        if (translatedBmp.width !== entry.w || translatedBmp.height !== entry.h) { bail('artifact-dims'); return; }
        if (w !== entry.w || h !== entry.h) {
            const resized = new OffscreenCanvas(w, h);
            resized.getContext('2d')!.drawImage(translatedBmp, 0, 0, w, h);
            imageBlob = await resized.convertToBlob({ type: 'image/png' });
            translatedBmp.close();
            translatedBmp = await createImageBitmap(imageBlob);
        }
        const sx = w / entry.w, sy = h / entry.h;
        const scale = <T extends { x1: number; y1: number; x2: number; y2: number }>(b: T): T => ({
            ...b, x1: b.x1 * sx, y1: b.y1 * sy, x2: b.x2 * sx, y2: b.y2 * sy,
        });
        const boxes = entry.boxes.map(b => ({ ...scale(b), ...(b.clip ? { clip: scale(b.clip) } : {}) }));
        const image = identifyBitmap(snapshot.bitmap, boxes);
        const hash = pageHashFromBitmap(snapshot.bitmap);
        translated = URL.createObjectURL(imageBlob);
        let origBytes: ArrayBuffer | undefined;
        if (ref.kind === 'img' && src.startsWith('blob:')) origOwn = await ownOriginalUrl(snapshot.bitmap);
        if (ref.kind === 'canvas') {
            const originalCanvas = new OffscreenCanvas(w, h);
            originalCanvas.getContext('2d')!.drawImage(snapshot.bitmap, 0, 0);
            const data = await blobDataUrl(await originalCanvas.convertToBlob({ type: 'image/png' }));
            origBytes = Uint8Array.from(atob(data.split(',')[1]), c => c.charCodeAt(0)).buffer;
        }
        const paintedImage = ref.kind === 'canvas' ? identifyBitmap(translatedBmp, boxes) : undefined;
        const state = { cacheEpoch, orig: src, origOwn, translated, translatedBmp: ref.kind === 'canvas' ? translatedBmp : undefined,
            origBytes, outputs: entry.outputs, mentions: entry.mentions, hash, image, paintedImage,
            det: { boxes, panels: entry.panels.map(scale), inferMs: 0, ep: 'cache',
                mask: { width: w, height: h, data: unpackMask(packed, w, h) } } };
        if (isDebug()) await ensurePageDebugViews(state, snapshot.bitmap, translatedBmp);
        // The view may have re-blobbed while the artifact was in flight; verify the CURRENT
        // pixels against the artifact identity instead of a frozen token (same-page only).
        // A complete, reader-authored manifest plus the URL's page number already fixed which
        // page this is; the artifact is that page by construction. Its pixels differ from the
        // reader's rendition by design (MangaDex serves /data and /data-saver of the same page
        // at different resolutions), so byte-level agreement would refuse every attach there.
        // The positional identity is re-checked live (current()), and any non-manifest page
        // still needs full pixel agreement.
        const verified = positional || (viewToken(ref) === snapshot.token
            ? await verifyView(ref, snapshot, result.identity)
            : await verifyViewFresh(ref, result.identity));
        if (!verified || !current()) { bail('view-changed'); return; }
        if (old) { unregPage(old); URL.revokeObjectURL(old.translated); }
        regPage(state);
        committed = true;
        if (pipeline.cacheEnabled && result.hash) {
            // Write through BOTH identities the reader can ask for. The runner's bytes hash
            // belongs to the pixels IT fetched; the reader is showing another rendition, so a
            // later "Translate this page" looks up the live-pixels hash and the page slot and
            // missed — re-paying the LLM for a page the chapter already finished. Page identity
            // is rendition-independent; the live hash makes the immediate revisit a hit too.
            const row = { ...entry, order: page.order ?? entry.order, keyGen: PAGE_KEY_GEN };
            void cachePut({ ...row, key: cacheKey(chapter, result.hash) }, pipeline.cacheMax, cacheEpoch);
            void cachePut({ ...row, key: cacheKey(chapter, hash) }, pipeline.cacheMax, cacheEpoch);
            if (page.order != null) void cachePut({ ...row, key: pageKey(chapter, page.order) }, pipeline.cacheMax, cacheEpoch);
        }
        if (page.hash) bookAdd(page.hash);
        applied.set(ref.el, stamp);
        if (overlayChoice === 'auto') setOverlayOn(true);
        writePage(ref, state);
        if (isDebug()) console.log('[mt] page result', JSON.stringify({ via: 'chapter', page: `${w}x${h}`, hash,
            boxes: state.det.boxes, outputs: state.outputs, ep: state.det.ep }));
    } catch (e) { console.debug('[mt] chapter image attach deferred', e); }
    finally {
        snapshot?.bitmap.close();
        if (!committed) { if (translated) URL.revokeObjectURL(translated); if (origOwn) URL.revokeObjectURL(origOwn); }
        if (!committed || ref.kind === 'img') translatedBmp?.close();
        attaching.delete(ref.el);
    }
}
async function refresh(): Promise<void> {
    if (refreshBusy) return;
    refreshBusy = true;
    const chapter = chapterKey();
    try {
        const token = await cacheReady();
        if (observedChapter !== chapter) {
            observedChapter = chapter; progress = null; refs.clear(); imageAliases.clear(); evidence.clear(); sourceImages.clear();
            removeActivity('sweep');
        }
        const response = await chrome.runtime.sendMessage({ type: 'mt:chapter-status', chapter });
        if (!cacheCurrent(token) || chapterKey() !== chapter) return;
        if (response?.status) {
            if (progress?.id !== response.status.id) { imageAliases.clear(); evidence.clear(); }
            progress = response.status; showProgress();
        }
        if (!progress) return;
        for (const ref of getPages()) {
            if (viewportOverlap(ref) <= 0) continue;
            const page = await resolveChapterRef(ref);
            if (!page) continue;
            refs.set(page.id, ref);
            if (page.phase === 'ready') void attach(ref, page);
            else if (page.phase === 'waiting') {
                const source = await capture(page);
                if (source) await control('append', { pages: [{ id: page.id, url: page.url, order: page.order ?? 0, descramble: false, source }] });
            }
            else if (sweepActive()) void control('prioritize', { page: page.id }).catch(() => {});
        }
        if (sweepActive() && !progress.completeManifest && Date.now() - discoverAt > 5000) {
            discoverAt = Date.now();
            const found = await enumerate();
            const pages = found.pages.filter(p => !progress!.pages.some(old => old.id === p.id));
            // New DOM pages append after the known sequence; never insert before the start anchor.
            const last = progress.pages.at(-1);
            const lastIndex = found.pages.findIndex(p => p.id === last?.id);
            const added = lastIndex >= 0 ? pages.filter(p => found.pages.indexOf(p) > lastIndex) : [];
            for (const page of added) if (!/^https?:/.test(page.url)) page.source = await capture(page);
            if (added.length || found.complete) await control('append', { pages: added, completeManifest: found.complete });
        }
    } catch { /* navigation/extension startup: next heartbeat reconnects */ }
    finally { refreshBusy = false; }
}
export function initSweep(): void {
    registerSweepWaiter(async () => {});
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
        if (sender.id !== chrome.runtime.id) return;
        if (msg?.type === 'mt:chapter-update' && msg.status.chapter === chapterKey()) {
            if (progress?.id !== msg.status.id) { imageAliases.clear(); evidence.clear(); }
            progress = msg.status;
            showProgress();
            void refresh();
        }
        if (msg?.type === 'mt:chapter-context-updated' && msg.chapter === chapterKey()) acceptChapterContext(msg.context);
        if (msg?.type === 'mt:chapter-source' && msg.chapter === chapterKey()) {
            capture(msg.page).then(source => respond({ source }));
            return true;
        }
    });
    setInterval(() => void refresh(), 1000);
    void refresh();
}
