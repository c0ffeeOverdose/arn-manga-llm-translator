// Chapter sweep: explicit whole-chapter background translation (popup button,
// not auto). A pool of headless workers walks the chapter manifest in reading
// order; slow stages (fetch/detect/translate) overlap, but the book folds
// strictly in page order (commit pointer + takeOrdered buffer — updateContext
// is order-sensitive: pairs append, names are first-wins). A serial warm-up
// (2 commits) seeds the book before the pool opens, so parallel pages still
// see real context; pages dispatched ahead of unfinished predecessors see
// dispatch-time snapshots (thinner context), but the book END STATE stays
// exactly ordered — the documented price of parallelism.
//
// Arrival never pays twice: claimed URLs make DOM jobs wait (sweepWait, wired
// into preparePage via the page-cache registry at initSweep), commits write
// full cache entries, and the viewed page gets a paint job on commit.
// Same-chapter tab only — closing/reopening resumes from IDB for free
// (completed cached, partials resumable); a chapter change aborts quietly.
//
// Folded-hash set (bookHas/bookAdd/bookDrop): a folded page must not refold
// on arrival (cached-path fold would duplicate its pairs — the same dup the
// lookahead path always had). Fresh folds register, rewind unregisters,
// chapter change resets lazily. render-page/seam/prefetch join the scheme.
//
// Module edges, function bodies only, no top-level cross-calls: sweep →
// pipeline (headless detect), page-io (pixels/manifests), ocr (translate),
// queue (fail marks + paint enqueue), status-ui (pill), state + llm/core
// (book). Reverse edges (auto, render-page, seam, commands, content) import
// FROM here — never the other way.

import { updateContext } from '../llm/core';
import { pipeline, context, setContext, shareContext, loadContext, loadPipeline, resetContextIfNewChapter, saveContext, chapterKey, sessionUsage, setLastPageUsage, stateFor, type PageRef } from './state';
import { fetchBitmap, getPages, refKey, unscrambleTiles, episodeManifestSrcs, galleryManifestJson, fetchPagedUrls, collectUnloadedUrls } from './page-io';
import { resolveHeadlessDet, preparePage } from './pipeline';
import { translateRegions, type TranslateOutcome } from './ocr';
import { pageHashFromBitmap, cacheKey, settingsFingerprint, cachePut, packMask, galleryAllUrls, takeOrdered, cooldownMark, cooldownParked, registerSweepWaiter, samePagePath } from './page-cache';
import type { DetectResult, MtOnStatus } from './detection';
import { failMarks, enqueue, pageKeyOf } from './queue';
import { setActivity, removeActivity, lastMsgSet, renderStatus, pillUnDismiss, autoTranslateOn } from './status-ui';
import { isDebug } from '../debug';

// ponytail: fixed pool + warm-up, no settings — provider rate limits (not
// CPU) bind sweep throughput. Settings if real chapters prove otherwise.
const SWEEP_JOBS = 3;
const SWEEP_WARMUP = 2;
const SWEEP_MAX_CONSECUTIVE_ERRORS = 3;
const SWEEP_SETTLE_MS = 150000; // DOM waiter gives up waiting (sweep died silently) and translates solo

interface SweepItem {
    url: string; // claim key (manifest URL headless, refKey for DOM) — DOM jobs wait on it
    descramble: boolean; // headless episode puzzles only
    ref?: PageRef; // DOM readers: translate the live element (blob srcs, taint, canvas blanks)
}
interface SweepRun { cancel: boolean; dead: boolean; failed: boolean; done: number; total: number; errors: number; skipped: number; firstErr: string; chapter: string }
type Commit =
    | { i: number; url: string; hash: string; w: number; h: number; det: DetectResult; o: TranslateOutcome; ref?: PageRef }
    | { i: number; url: string; cached: true; ref?: PageRef }
    | { i: number; url: string; skip: true } // blank canvas (translating it poisons) — head advances, counts neither done nor error
    | { i: number; url: string; error: true; msg?: string };

let sweep: SweepRun | null = null;
const inflight = new Map<string, true>(); // claimed urls (DOM jobs wait on these)
const waiters = new Map<string, Set<() => void>>();
let translating = 0; // workers inside translateRegions (pill stage honesty)
let pagesCache: { chapter: string; n: number } | null = null;

// ---- folded hashes: which content hashes already contributed to the live book
let foldedChapter = '';
const foldedHashes = new Set<string>();
function foldedSync(): void {
    if (foldedChapter !== chapterKey()) { foldedChapter = chapterKey(); foldedHashes.clear(); }
}
export function bookHas(hash: string): boolean { foldedSync(); return foldedHashes.has(hash); }
export function bookAdd(hash: string): void { foldedSync(); foldedHashes.add(hash); }
export function bookDrop(hash: string): void { foldedHashes.delete(hash); }

// ---- DOM attach: a DOM job for a sweep-owned page waits for the commit
// instead of paying a duplicate detect + LLM (falls through on timeout)
function settleUrl(url: string): void {
    const set = waiters.get(url);
    if (!set) return;
    waiters.delete(url);
    for (const r of set) { try { r(); } catch { /* waiter gone */ } }
}
export function sweepHas(url: string): boolean {
    return !!sweep && !sweep.cancel && !sweep.dead && claimFor(url) !== undefined;
}
// claim lookup with host-volatile fallback (same file, different CDN host)
function claimFor(url: string): string | undefined {
    if (inflight.has(url)) return url;
    for (const k of inflight.keys()) if (samePagePath(k, url)) return k;
    return undefined;
}
export function awaitSweep(url: string, onStatus: MtOnStatus): Promise<void> {
    const s = sweep;
    const claim = s && !s.cancel && !s.dead ? claimFor(url) : undefined;
    if (!claim) return Promise.resolve();
    onStatus('Waiting for chapter sweep…');
    return new Promise<void>(res => {
        let set = waiters.get(claim);
        if (!set) { set = new Set(); waiters.set(claim, set); }
        set.add(res);
        // claimed-and-settled between the check and the add — resolve at once
        if (!inflight.has(claim)) settleUrl(claim);
    });
}

// ---- control + status (popup)
export function sweepStatus(): { active: boolean; done: number; total: number; errors: number; skipped: number } | null {
    return sweep ? { active: true, done: sweep.done, total: sweep.total, errors: sweep.errors, skipped: sweep.skipped } : null;
}
// autoTick consults this (auto jobs would duplicate sweep work and clobber
// its ordered book) — a cancelled-but-draining sweep still counts: its
// commits are still landing.
export function sweepActive(): boolean {
    const s = sweep;
    return !!s && !s.dead;
}
export async function sweepPages(): Promise<number> {
    const ch = chapterKey();
    if (pagesCache && pagesCache.chapter === ch) return pagesCache.n;
    const n = (await sweepItems()).length;
    pagesCache = { chapter: ch, n };
    return n;
}
export async function startSweep(): Promise<{ ok: boolean; total?: number; error?: string }> {
    if (sweep) return { ok: true, total: sweep.total };
    resetContextIfNewChapter();
    await loadPipeline();
    await loadContext();
    const now = Date.now();
    const items = await sweepItems();
    const usable = items.filter(it => !cooldownParked(failMarks, it.url, now));
    if (!usable.length) {
        return { ok: false, error: items.length ? 'all pages parked after errors — force one manually to retry' : 'no sweepable pages found' };
    }
    sweep = { cancel: false, dead: false, failed: false, done: 0, total: usable.length, errors: 0, skipped: 0, firstErr: '', chapter: chapterKey() };
    pagesCache = { chapter: sweep.chapter, n: usable.length };
    pillUnDismiss();
    pumpSweepStatus();
    void runSweep(usable);
    return { ok: true, total: usable.length };
}
export function cancelSweep(): { ok: boolean } {
    if (sweep) sweep.cancel = true;
    return { ok: true };
}
export function initSweep(): void {
    registerSweepWaiter(awaitSweep);
}

// ---- manifest walk: episode canvases → gallery manifest → DOM refs (DOM
// order). DOM readers (whole chapter in DOM, blob srcs, canvases) sweep the
// live elements through preparePage — the same read path as DOM jobs
// (taint/screenshot fallbacks, blank guards) instead of URL fetching.
// Always from chapter start (index 0): the book must accumulate in reading
// order, and partially-cached chapters fast-forward through the cache checks
// anyway.
function origOf(ref: PageRef): string | null {
    // callers pass img refs only (filtered by kind) — the cast is safe
    const el = ref.el as HTMLImageElement;
    const kept = stateFor(ref)?.orig;
    if (kept && /^https?:/.test(kept)) return kept;
    return /^https?:/.test(el.src) ? el.src : null;
}
async function sweepItems(): Promise<SweepItem[]> {
    const ep = episodeManifestSrcs();
    if (ep?.length) return ep.map(url => ({ url, descramble: true }));
    // paged readers virtualize the DOM (loaded window only) — the chapter
    // API lists every page, so the count is the chapter, not the window.
    // [] off-host or on any failure → fall through to the DOM branches.
    const paged = await fetchPagedUrls();
    if (paged.length) return paged.map(url => ({ url, descramble: false }));
    const refs = getPages().filter(r => r.kind === 'img');
    for (const r of refs) {
        const anchor = origOf(r);
        if (!anchor) continue;
        const g = galleryAllUrls(await galleryManifestJson(), anchor);
        if (g.urls.length) return g.urls.map(url => ({ url, descramble: false }));
        break; // anchor read, manifest absent — DOM reader, fall through once
    }
    // plain DOM reader: sweep the live refs (blob srcs are document-local but
    // fetchable in-session; claim = refKey, same key DOM jobs wait on) PLUS
    // lazy <img> with an http(s) src but no pixels yet — headless URL items,
    // deduped against the live refs. Junk fetched this way dies at the fetch
    // size-gate in workPage (skip, never an LLM call).
    const live = getPages();
    const known = new Set<string>();
    for (const r of live) {
        known.add(refKey(r));
        if (r.kind === 'img') { known.add(r.el.src); known.add(r.el.currentSrc); }
    }
    const items: SweepItem[] = live.map(ref => ({ url: refKey(ref), descramble: false, ref }));
    for (const u of collectUnloadedUrls(known)) items.push({ url: u, descramble: false });
    return items;
}

// ---- the run: N workers, ordered commit, warm-up gate
async function runSweep(items: SweepItem[]): Promise<void> {
    const chapter = sweep!.chapter;
    let next = 0, head = 0, streak = 0;
    const ready = new Map<number, Commit>();
    // drain the consecutive run from the head (atomic: sync take + head move,
    // then awaited commits of disjoint sets — workers never double-commit)
    const commitAhead = async (): Promise<void> => {
        const r = takeOrdered(ready, head);
        head = r.head;
        for (const c of r.items) {
            const s = sweep;
            if (!s || s.chapter !== chapter) { // aborted mid-drain — drop (book safety), unblock waiter
                for (const d of r.items) settleUrl(d.url);
                return;
            }
            await commitPage(c, s);
            if ('error' in c) streak++;
            else streak = 0;
        }
    };
    const worker = async (): Promise<void> => {
        for (;;) {
            const s = sweep;
            if (!s || s.cancel || s.dead || chapterKey() !== chapter) {
                if (s && !s.dead && chapterKey() !== chapter) s.dead = true; // SPA story change — quiet abort
                return;
            }
            if (inflight.size >= (s.done >= SWEEP_WARMUP ? SWEEP_JOBS : 1)) { await sleep(400); continue; }
            const k = next++;
            const job = items[k];
            if (!job) return;
            inflight.set(job.url, true);
            let res: Commit | null = null;
            try {
                res = await workPage({ ...job, i: k }, chapter);
            } catch (e) {
                if (isDebug()) console.log('[mt] sweep worker threw:', (e as Error)?.message);
            } finally {
                inflight.delete(job.url);
            }
            if (!sweep || sweep.chapter !== chapter) { settleUrl(job.url); return; } // dropped, unblock waiter
            ready.set(k, res ?? { i: k, url: job.url, error: true });
            await commitAhead();
            pumpSweepStatus();
            if (streak >= SWEEP_MAX_CONSECUTIVE_ERRORS) {
                sweep.failed = true;
                sweep.cancel = true; // stop dispatch, drain commits
                return;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(SWEEP_JOBS, items.length) }, () => worker()));
    await commitAhead(); // final drain (usually a no-op)
    finishSweep();
}

async function workPage(job: SweepItem & { i: number }, chapter: string): Promise<Commit | null> {
    if (cooldownParked(failMarks, job.url, Date.now())) return { i: job.i, url: job.url, error: true };
    if (job.ref) return workDomPage(job as SweepItem & { i: number; ref: PageRef }, chapter);
    const st: MtOnStatus = () => {}; // the pool shares one pill line (pumpSweepStatus) — per-worker stages would thrash it
    try {
        const f = await fetchBitmap(job.url); // direct → SW proxy → DNR retry, same as DOM pages
        let bitmap = f.bitmap;
        // fetch size-gate (mirrors the getPages floor): unloaded-URL items
        // arrive unsized — junk below this is skipped, never an LLM call
        if (bitmap.width < 400 || bitmap.height < 300) return { i: job.i, url: job.url, skip: true };
        if (job.descramble) {
            try {
                const fixed = await unscrambleTiles(bitmap);
                if (fixed) { bitmap.close(); bitmap = fixed.bitmap; }
            } catch { /* gate/pixel failure — translate fetched bytes as-is */ }
        }
        try {
            if (chapterKey() !== chapter) return null; // story moved on mid-fetch — drop silently
            const hash = pageHashFromBitmap(bitmap);
            const w = bitmap.width, h = bitmap.height;
            // shared headless resolve (full hit → cached marker, partial →
            // resume, else detect + order + checkpoint)
            const r = await resolveHeadlessDet(bitmap, hash, st);
            if (!r.det) return { i: job.i, url: job.url, cached: true };
            translating++;
            let o: TranslateOutcome;
            try {
                // fold:false — the commit folds in chapter order (rebase), never here
                o = await translateRegions(bitmap, r.det, st, { fold: false, progressKey: job.url, continued: r.resumed || !pipeline.cacheEnabled });
            } finally {
                translating--;
            }
            if (o.error) throw Object.assign(new Error(`LLM failed: ${o.error}`), { kind: o.errorKind, hint: o.errorHint });
            return { i: job.i, url: job.url, hash, w, h, det: r.det, o };
        } finally {
            try { bitmap.close(); } catch { /* already closed */ }
        }
    } catch (e) {
        cooldownMark(failMarks, job.url, Date.now());
        const msg = (e as Error)?.message ?? String(e);
        console.warn('[mt] sweep page failed:', job.url.slice(-24), msg);
        return { i: job.i, url: job.url, error: true as const, msg };
    }
}

// DOM flavor: read through preparePage (blob srcs, taint, screenshot
// fallbacks, canvas blanks — all handled there), translate, commit shared.
// Null prep with existing state = done elsewhere (cached marker); null
// without state = blank canvas (skip marker — translating it poisons).
async function workDomPage(job: SweepItem & { i: number; ref: PageRef }, chapter: string): Promise<Commit | null> {
    const st: MtOnStatus = () => {};
    try {
        if (stateFor(job.ref)) return { i: job.i, url: job.url, cached: true, ref: job.ref };
        const prep = await preparePage(job.ref, false, st, true);
        if (!prep) {
            return stateFor(job.ref)
                ? { i: job.i, url: job.url, cached: true, ref: job.ref }
                : { i: job.i, url: job.url, skip: true };
        }
        if (prep.cached) return { i: job.i, url: job.url, cached: true, ref: job.ref };
        if (chapterKey() !== chapter) { try { prep.bitmap.close(); } catch {} return null; }
        const w = prep.bitmap.width, h = prep.bitmap.height; // before close below
        translating++;
        let o: TranslateOutcome;
        try {
            o = await translateRegions(prep.bitmap, prep.det, st, { fold: false, progressKey: job.url, continued: !!prep.resumed || !pipeline.cacheEnabled });
        } finally {
            translating--;
            try { prep.bitmap.close(); } catch { /* already closed */ }
        }
        if (o.error) throw Object.assign(new Error(`LLM failed: ${o.error}`), { kind: o.errorKind, hint: o.errorHint });
        return { i: job.i, url: job.url, hash: prep.hash, w, h, det: prep.det, o, ref: job.ref };
    } catch (e) {
        cooldownMark(failMarks, job.url, Date.now());
        const msg = (e as Error)?.message ?? String(e);
        console.warn('[mt] sweep page failed:', job.url.slice(-24), msg);
        return { i: job.i, url: job.url, error: true as const, msg };
    }
}

// full commit, in chapter order: rebase fold (serial-equivalent by induction —
// the live book holds exactly pages <i when i commits) + cache write +
// counters. Cached skips count done without folding (their paint job folds on
// arrival and registers — later arrivals divert to the paint lane instead).
async function commitPage(c: Commit, s: SweepRun): Promise<void> {
    settleUrl(c.url);
    if ('error' in c) {
        s.errors++;
        if (c.msg && !s.firstErr) s.firstErr = c.msg;
        return;
    }
    if ('skip' in c) { s.skipped++; return; }
    if ('cached' in c) {
        s.done++;
        // unconditional (like the fresh branch below): headless cached commits
        // carry no ref, but the user may be looking at the page right now —
        // paintIfLoaded resolves loaded refs itself and no-ops otherwise
        paintIfLoaded(c.url, c.ref);
        return;
    }
    if (shareContext) {
        const u = updateContext(context, c.o.outputs, c.o.mentions, pipeline.useCharacters, pipeline.contextPairs);
        setContext(u.ctx);
        await saveContext();
    }
    bookAdd(c.hash);
    if (pipeline.cacheEnabled) {
        void cachePut({
            key: cacheKey(s.chapter, c.hash),
            fp: settingsFingerprint(pipeline),
            w: c.w, h: c.h,
            boxes: c.det.boxes, panels: c.det.panels ?? [],
            outputs: c.o.outputs, extras: c.o.extras, mentions: c.o.mentions,
            mask: packMask(c.det.mask),
        }, pipeline.cacheMax);
    }
    s.done++;
    if (c.o.usage) {
        sessionUsage.pages++;
        sessionUsage.inTok += c.o.usage.inTok ?? 0;
        sessionUsage.outTok += c.o.usage.outTok ?? 0;
        sessionUsage.cachedInTok += c.o.usage.cachedInTok ?? 0;
    }
    setLastPageUsage({ inTok: c.o.usage?.inTok, outTok: c.o.usage?.outTok, cachedInTok: c.o.usage?.cachedInTok, ms: c.o.llmMs, calls: c.o.llmCalls });
    paintIfLoaded(c.url, c.ref);
}

// a commit must paint every copy the user can see — arrival only paints via
// a DOM job, and headless commits create no state, so without this the user
// stares at finished pages until they click each one (or enable auto).
// Cache-hit job (fold skipped when already registered — bookAdd covered it).
// DOM commits carry their ref directly; headless ones resolve it by claim key
// (only the viewed page has an element — the rest don't exist yet). Exact key
// first, samePagePath fallback for CDN host rotation (proven predicate —
// pixel-hash verify can't cross quality variants, exact or nothing, so no
// third stage: a miss logs one line with the cause instead of painting blind).
function paintIfLoaded(url: string, direct?: PageRef): void {
    if (!sweep) return;
    const ref = (direct && direct.el.isConnected && !stateFor(direct) ? direct : undefined)
        ?? getPages().find(r => pageKeyOf(r) === url && !stateFor(r))
        ?? getPages().find(r => !stateFor(r) && samePagePath(pageKeyOf(r), url));
    if (!ref) { if (isDebug()) console.log('[mt] sweep paint miss: no ref', url.slice(-24)); return; }
    if (stateFor(ref)) return; // painted while resolving
    // zero-rect only (hidden placeholders arrive-paint when the reader shows
    // them): offscreen-but-loaded pages paint too — a committed page the user
    // scrolls to must already carry its translation, not paint on arrival.
    const b = ref.el.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) { if (isDebug()) console.log('[mt] sweep paint miss: zero-rect', url.slice(-24)); return; }
    enqueue(ref, false, true);
}

function pumpSweepStatus(): void {
    const s = sweep;
    if (!s) return;
    // auto yields to the sweep by design (its jobs would duplicate sweep work
    // and clobber the ordered book) — say so, or an enabled-but-silent auto
    // reads as broken.
    const paused = autoTranslateOn() ? ' · auto paused' : '';
    const tail = [s.errors ? `${s.errors} failed` : '', s.skipped ? `${s.skipped} skipped` : ''].filter(Boolean).join(' · ');
    setActivity('sweep', `Sweeping chapter ${s.done}/${s.total}${paused}…${tail ? ` (${tail})` : ''}`,
        'sweep', translating > 0 ? 'llm' : 'detect');
}

function finishSweep(): void {
    const s = sweep;
    sweep = null;
    removeActivity('sweep');
    for (const url of [...waiters.keys()]) settleUrl(url); // undispatched claims never exist — belt & braces
    if (!s) { renderStatus(); return; }
    if (s.dead) { renderStatus(); return; } // chapter moved on — quiet, the new chapter owns the pill
    if (!s.failed && !s.cancel) {
        // best-effort paint pass (natural finish only — cancel/error must not
        // start new work): elements that appeared after their commit (lazy
        // canvases) otherwise wait for a manual click. Uncached leftovers
        // translate solo here — the user asked for the whole chapter;
        // failures park via the normal cooldown.
        for (const ref of getPages()) {
            if (!stateFor(ref) && ref.el.isConnected) enqueue(ref, false, true);
        }
    }    const gaps = [s.errors ? `${s.errors} failed` : '', s.skipped ? `${s.skipped} skipped` : ''].filter(Boolean).join(', ');
    const until = Date.now() + 6000;
    if (s.failed) lastMsgSet({ text: `Sweep stopped after errors — ${s.done}/${s.total} ready (${(s.firstErr || 'unknown').slice(0, 90)})`, phase: 'error', until: Date.now() + 10000 });
    else if (s.cancel) lastMsgSet({ text: `Sweep stopped — ${s.done}/${s.total} ready`, phase: 'done', until });
    else lastMsgSet({
        text: gaps ? `Chapter ready with gaps — ${s.done}/${s.total} pages (${gaps})` : `Chapter ready — ${s.done}/${s.total} pages`,
        phase: 'done', until,
    });
    renderStatus();
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
