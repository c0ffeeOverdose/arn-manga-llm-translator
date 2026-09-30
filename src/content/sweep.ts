// Reader-side chapter controller. Execution and rendered artifacts live in the extension host.
import { chapterKey, pipeline, context, loadContext, loadPipeline, bookKey, shareContext, stateFor,
    regPage, unregPage, overlayChoice, setOverlayChoice, setOverlayOn, acceptChapterContext, type PageRef } from './state';
import { getPages, refKey, episodeManifestSrcs, fetchPagedUrls, galleryManifestJson,
    collectUnloadedUrls, bitmapBlank, writePage, fetchBitmap } from './page-io';
import { galleryAllUrls, matchAnchor, pageHashFromBitmap, samePagePath, unpackMask,
    registerSweepWaiter, abortLookahead, settingsFingerprint, packMask, cachePut, cacheKey } from './page-cache';
import { viewportOverlap, dropAutoQueued, resumeAuto, isBusy, paintBusy, haltAuto } from './queue';
import { lookaheadActive } from './auto';
import { setActivity, removeActivity, lastMsgSet, renderStatus, pillUnDismiss, logError } from './status-ui';
import { remainingPages, sweepCount, type SweepCountReason, chapterMessage, type ChapterPage, type ChapterProgress, type ChapterStart } from '../chapter/model';
import { blobDataUrl } from '../chapter/store';
import type { CachedPage } from './page-cache';
import { RENDER_GEN } from './render';
import { nextDocument, guessNextDocument } from '../chapter/discovery';

let progress: ChapterProgress | null = null;
let starting = false;
let startCancelled = false;
let observedChapter = '';
let refreshBusy = false;
let discoverAt = 0;
let notified = '';
let foldedChapter = '';
const folded = new Set<string>();
const refs = new Map<string, PageRef>();
const attaching = new WeakSet<Element>();
const applied = new WeakMap<Element, string>();
const sourceRequests = new Map<string, Promise<string | undefined>>();

function syncBook(): void {
    if (foldedChapter !== chapterKey()) { foldedChapter = chapterKey(); folded.clear(); }
}
export function bookHas(hash: string): boolean { syncBook(); return folded.has(hash); }
export function bookAdd(hash: string): void { syncBook(); folded.add(hash); }
export function bookDrop(hash: string): void { syncBook(); folded.delete(hash); }
export function sweepArrivable(): boolean { return !!progress && progress.chapter === chapterKey(); }
export function sweepCommitted(hash: string): boolean {
    return !!progress?.pages.some(p => p.phase === 'ready' && p.hash === hash);
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
    return stateFor(ref)?.orig ?? refKey(ref);
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
    return progress.pages.find(p => p.url === url || samePagePath(p.url, url));
}
export function sweepHas(url: string): boolean {
    return !!owned(url) && sweepActive();
}
async function control(command: string, extra: Record<string, unknown> = {}): Promise<any> {
    return chrome.runtime.sendMessage({ type: 'mt:chapter-control', chapter: chapterKey(), command, ...extra });
}

// Manual/auto requests join the chapter owner, including explicit retranslation.
export function chapterOwnsRequest(ref: PageRef, force: boolean): boolean {
    const page = owned(original(ref));
    if (!page) return false;
    if (!sweepActive() && !force && page.phase !== 'ready') return false;
    refs.set(page.id, ref);
    if (force) {
        // Retranslate through the owner already holding the pixels: a fresh detection and a
        // fresh answer, folded back in reading order. Re-entering the queue would re-render
        // the page alone and make the book's pairs depend on which path ran.
        applied.delete(ref.el);
        detach(ref);
        void control('retry', { page: page.id }).catch(reportError);
    } else {
        void control('prioritize', { page: page.id }).catch(reportError);
        if (page.phase === 'ready') void attach(ref, page);
    }
    return true;
}
// Drop our rendered state for one element so the owner's redraw is the only one left.
function detach(ref: PageRef): void {
    const state = stateFor(ref);
    if (!state) return;
    unregPage(state);
    URL.revokeObjectURL(state.translated);
}

async function enumerate(): Promise<{ pages: ChapterPage[]; anchor: number; complete: boolean }> {
    const live = getPages();
    const current = visible();
    let urls = episodeManifestSrcs();
    let descramble = !!urls?.length;
    // A paged reader whose API lists the whole chapter is the most reliable source there
    // is: it survives virtualization, lazy loading and host rotation. Ask it first.
    if (!urls?.length) urls = await fetchPagedUrls();
    if (!urls?.length) {
        const first = live.find(r => r.kind === 'img' && /^https?:/.test(original(r)));
        if (first) urls = galleryAllUrls(await galleryManifestJson(), original(first)).urls;
    }
    if (urls?.length) {
        const pages = urls.map((url, order) => ({ id: `page:${order}`, url, order, descramble }));
        const anchor = anchorInList(urls, live, current);
        return { pages, anchor, complete: true };
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
    return { pages, anchor, complete: !hasNext && !unresolved };
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

// Where the reader is inside the chapter list. Three signals, strongest first:
//  1. the visible page's URL appears in the list (exact, then host-rotated twin);
//  2. any loaded page appears in the list — the reader shows a window around itself;
//  3. the reader's page elements and the list share an ordinal: readers that mint
//     `blob:` URLs for their pages (so no URL comparison is possible at all) still
//     append them in reading order, so the visible element's index among the loaded
//     page images is its chapter index.
function anchorInList(urls: string[], live: PageRef[], current: PageRef | undefined): number {
    if (current) {
        const direct = matchAnchor(urls, [original(current), refKey(current)]);
        if (direct >= 0) return direct;
    }
    const byUrl = nearestAnchor(urls, live);
    if (byUrl >= 0) return byUrl;
    return ordinalAnchor(urls.length, live, current);
}

// Positional fallback for readers whose page URLs are unreadable (blob:) or regenerated:
// the visible page's index within the DOM's own page-image order is the best estimate of
// its chapter index. Clamped so an unexpected DOM shape can never run past the chapter.
function ordinalAnchor(total: number, live: PageRef[], current: PageRef | undefined): number {
    if (!total || !current) return -1;
    const inDom = [...document.querySelectorAll('img,canvas')].filter(el => live.some(r => r.el === el));
    const index = inDom.indexOf(current.el);
    if (index < 0) return -1;
    return Math.min(index, total - 1);
}
function reportError(e: unknown): void {
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
                } });
            page.inBaseContext = bookHas(state.hash);
        }
        // Capture readable opaque pixels before the reader can destroy their document.
        for (const page of pages) if (!/^https?:/.test(page.url)) page.source = await capture(page);
        if (startCancelled || chapter !== chapterKey()) return { ok: true, cancelled: true };
        const response = await chrome.runtime.sendMessage({ type: 'mt:chapter-start', data: {
            chapter, readerUrl: location.href, pages, completeManifest: found.complete,
            pipeline: structuredClone(pipeline), context: structuredClone(context), bookKey: bookKey(), shareContext, seeds,
            nextDocument: found.complete ? undefined : nextDocument(document, location.href, chapter)
                ?? guessNextDocument(location.href, chapter),
            imageFilter: readerImageFilter(),
        } });
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
        const ref = refs.get(page.id) ?? getPages().find(r => original(r) === page.url);
        if (!ref?.el.isConnected) return undefined;
        const old = stateFor(ref);
        let bitmap: ImageBitmap;
        if (old?.origBytes) bitmap = await createImageBitmap(new Blob([old.origBytes]));
        else if (old?.origOwn) bitmap = await createImageBitmap(await (await fetch(old.origOwn)).blob());
        else if (old) return undefined;
        else bitmap = await createImageBitmap(ref.el);
        try {
            if (await bitmapBlank(bitmap)) return undefined;
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
            return blobDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
        } finally { bitmap.close(); }
    })().catch(() => undefined).finally(() => sourceRequests.delete(page.id));
    sourceRequests.set(page.id, task);
    return task;
}
async function attach(ref: PageRef, page: ChapterProgress['pages'][number]): Promise<void> {
    if (!progress || attaching.has(ref.el) || document.hidden || viewportOverlap(ref) <= 0) return;
    const stamp = `${progress.id}:${page.id}:${page.revision ?? 0}`;
    if (applied.get(ref.el) === stamp && stateFor(ref)) return;
    const chapter = chapterKey();
    const src = original(ref);
    attaching.add(ref.el);
    let bitmap: ImageBitmap | undefined;
    try {
        const response = await chrome.runtime.sendMessage({ type: 'mt:chapter-result', chapter, page: page.id });
        const result = response?.result;
        if (!result || chapterKey() !== chapter || !ref.el.isConnected || original(ref) !== src) return;
        if (result.signature !== JSON.stringify(pipeline) + ':' + RENDER_GEN) return;
        const old = stateFor(ref);
        // Unknown/recycled bindings are verified from the original pixels before painting.
        if (old?.hash !== page.hash) {
            if (old) return;
            try {
                bitmap = await createImageBitmap(ref.el);
                if (pageHashFromBitmap(bitmap) !== page.hash) return;
            } catch {
                bitmap?.close();
                bitmap = undefined;
                if (!/^https?:/.test(src)) return;
                bitmap = (await fetchBitmap(src)).bitmap;
                if (pageHashFromBitmap(bitmap) !== page.hash) return;
            }
        }
        const imageBlob = await (await fetch(result.image)).blob();
        const packed = result.mask ? { w: result.mask.w, h: result.mask.h,
            data: Uint8Array.from(atob(result.mask.data.split(',')[1]), c => c.charCodeAt(0)).buffer } : undefined;
        const entry = { ...result.entry, mask: packed } as CachedPage;
        if (!packed || entry.fp !== settingsFingerprint(pipeline)) return;
        const translated = URL.createObjectURL(imageBlob);
        let origBytes = old?.origBytes;
        let origOwn: string | undefined;
        if (old?.origOwn) origOwn = URL.createObjectURL(await (await fetch(old.origOwn)).blob());
        else if (ref.kind === 'img' && src.startsWith('blob:') && bitmap) {
            const originalCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            originalCanvas.getContext('2d')!.drawImage(bitmap, 0, 0);
            origOwn = URL.createObjectURL(await originalCanvas.convertToBlob({ type: 'image/png' }));
        }
        if (ref.kind === 'canvas' && !origBytes && bitmap) {
            const originalCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            originalCanvas.getContext('2d')!.drawImage(bitmap, 0, 0);
            const data = await blobDataUrl(await originalCanvas.convertToBlob({ type: 'image/png' }));
            origBytes = Uint8Array.from(atob(data.split(',')[1]), c => c.charCodeAt(0)).buffer;
        }
        const translatedBmp = ref.kind === 'canvas' ? await createImageBitmap(imageBlob) : undefined;
        if (chapterKey() !== chapter || !ref.el.isConnected || original(ref) !== src) {
            URL.revokeObjectURL(translated); if (origOwn) URL.revokeObjectURL(origOwn); translatedBmp?.close(); return;
        }
        const state = { orig: src, origOwn, translated, translatedBmp, origBytes, outputs: entry.outputs,
            mentions: entry.mentions, hash: page.hash,
            det: { boxes: entry.boxes, panels: entry.panels, inferMs: 0, ep: 'cache',
                mask: { width: entry.w, height: entry.h, data: unpackMask(packed, entry.w, entry.h) } } };
        if (old) { unregPage(old); URL.revokeObjectURL(old.translated); }
        regPage(state);
        if (pipeline.cacheEnabled) await cachePut({ ...entry, key: cacheKey(chapter, page.hash!) }, pipeline.cacheMax);
        bookAdd(page.hash!);
        applied.set(ref.el, stamp);
        if (overlayChoice === 'auto') setOverlayOn(true);
        writePage(ref, state);
    } catch (e) { console.debug('[mt] chapter image attach deferred', e); }
    finally { bitmap?.close(); attaching.delete(ref.el); }
}
async function refresh(): Promise<void> {
    if (refreshBusy) return;
    refreshBusy = true;
    const chapter = chapterKey();
    try {
        if (observedChapter !== chapter) { observedChapter = chapter; progress = null; refs.clear(); removeActivity('sweep'); }
        const response = await chrome.runtime.sendMessage({ type: 'mt:chapter-status', chapter });
        if (chapterKey() !== chapter) return;
        if (response?.status) { progress = response.status; showProgress(); }
        if (!progress) return;
        for (const ref of getPages()) {
            if (viewportOverlap(ref) <= 0) continue;
            const page = owned(original(ref));
            if (!page) continue;
            refs.set(page.id, ref);
            if (page.phase === 'ready') void attach(ref, page);
            else if (page.phase === 'waiting') {
                const source = await capture(page);
                if (source) await control('append', { pages: [{ id: page.id, url: page.url, order: 0, descramble: false, source }] });
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
