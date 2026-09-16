// Job queue: CTD detection parallel, LLM serial. Clicking translate while a
// page is running no longer rejects — the new page enters the queue and its
// DETECTION starts immediately (overlaps the current page's LLM call). LLM
// calls + context updates stay strictly ordered so the character book
// accumulates in reading order.
// NOTE: mutual imports with status-ui/overlays are fine — every cross-module
// use happens inside function bodies, never at module top level.

import { updateContext, type CharacterEntry } from '../llm/core';
import { cooldownMark, cooldownClear, paintLaneSize, type FailMark, pageHashFromBitmap } from './page-cache';
import { isDebug } from '../debug';
import type { MtStage } from './detection';
import { pipeline, context, setContext, shareContext, loadContext, saveContext, chapterKey, contextChapter, resetContextIfNewChapter, pages, uniquePages, overlayChoice, setOverlayOn, type PageRef, type PageState } from './state';
import { refKey, getPages } from './page-io';
import { preparePage, type Prep } from './pipeline';
import { trySeam, type Job } from './seam';
import { renderPage } from './render-page';
import { setActivity, removeActivity, lastMsgSet, renderStatus, makeToast, logError, pillUnDismiss, setStatus } from './status-ui';
import { applyOverlays } from './overlays';
import { bookHas } from './sweep'; // paint-lane divert decision — queue↔sweep calls stay in function bodies only, like the queue↔seam cycle

export const queue: Job[] = [];
let running = false;
// paint lane: cache-hit jobs whose outputs are already folded (bookHas) need
// no LLM and no book mutation, so they must not hold the serial pump — they
// run here, up to paintLaneSize at once. Visible to seam/auto-twin guards:
// queued paints resolve like queued preps, active paints like the active one.
const paintQueue: Job[] = [];
const paintActive = new Map<string, Job>();
let paintRunning = 0;
// parallel paint lanes: GPU boxes run three; a WebGPU-less machine paints one
// page at a time (see paintLaneSize — paints are main-thread canvas work)
export function paintFind(key: string): Job | undefined {
    return paintQueue.find(j => j.key === key) ?? paintActive.get(key);
}
export function paintHas(key: string): boolean { return paintQueue.some(j => j.key === key) || paintActive.has(key); }
export function paintQueued(): number { return paintQueue.length; }
export function paintBusy(): boolean { return paintRunning > 0 || paintQueue.length > 0; }
// failure cooldown per page key: a failed job parks for 60s (max 3 attempts)
// instead of being re-enqueued every autoTick — auto-retry without token burn
export const failMarks = new Map<string, FailMark>();
// provider stop ("halt"): a rate-limit refusal — or an auth/quota error — cannot
// be fixed by translating the next page, and the stacked retry layers (call
// attempts x page cooldown x lookahead/sweep workers) are what turned one 429
// into a request storm (live: 24 identical requests in 3 minutes). The first
// refusal arms a window (the adapter refuses further calls to that provider)
// and halts auto fanout; only explicit user intent resumes: Translate /
// Retranslate, the popup auto toggle, Translate chapter, or a page reload.
let autoHalt: { kind: string; until: number } | null = null;
export function haltAuto(kind: string, retryAfterMs = 0): void {
    autoHalt = { kind, until: retryAfterMs > 0 ? Date.now() + retryAfterMs : 0 };
}
export function autoHalted(): { kind: string; until: number } | null { return autoHalt; }
export function resumeAuto(): void { autoHalt = null; }
let activeRef: PageRef | null = null; // job currently rendering
let activeKey: string | null = null; // its page key — twins on swapped elements map here
let activePrep: Promise<Prep | null> | null = null; // its prep — seam owners await members' preps, active included

// background keepalive: an open runtime Port + periodic messages is the
// documented way to stop a MV3 event page (Firefox) / service worker (Chrome)
// suspending mid-job. Firefox kills the page ~30s into a long async handler
// even with the response still pending — live-proven: the LLM send died at
// exactly ~29s with "Receiving end does not exist", and again for every sweep
// worker (a 200s translate died at the idle window and surfaced as
// "Could not establish connection" — sweep had no keepalive at all). A held
// port alone does not reset Chrome's 30s idle timer; port messages do, so ping
// well under it. Returns the closer.
export function keepaliveOpen(): () => void {
    let port: chrome.runtime.Port | null = null;
    try { port = chrome.runtime.connect({ name: 'mt-keepalive' }); } catch { /* context invalidated — job fails loudly anyway */ }
    const timer = setInterval(() => { try { port?.postMessage(0); } catch { /* gone */ } }, 15000);
    return () => { clearInterval(timer); try { port?.disconnect(); } catch { /* already gone */ } };
}

export function activeKeyGet(): string | null { return activeKey; }
export function activePrepGet(): Promise<Prep | null> | null { return activePrep; }
export function activeRefGet(): PageRef | null { return activeRef; }
export function queueFind(key: string): Job | undefined { return queue.find(j => j.key === key); }

export function isBusy(): boolean {
    return running || queue.length > 0;
}

export function pageKeyOf(ref: PageRef): string {
    return refKey(ref);
}

// Re-translate must not see the target page's own stale contribution to the
// book: rebuild the chapter book as it was BEFORE that page — replay every
// other page's outputs in reading order, keep user-added entries. Without
// this, a wrong first guess (first-wins naming) survives every re-translate.
export async function rewindContextBefore(...targets: (PageState | undefined)[]): Promise<void> {
    await loadContext();
    // Snapshot first: the target's bookBefore/pairsBefore is the exact state
    // before it folded, and unlike a replay it works in a fresh session (the
    // book came from storage, so there are no page states to rebuild from —
    // the replay silently wiped it: live-proven 10 → 3 entries, and the
    // re-translate then swapped speakers/genders it had known).
    const snapped = targets.find((t): t is PageState => !!t?.bookBefore);
    if (snapped) {
        setContext({ pairs: [...(snapped.pairsBefore ?? [])], characters: [...snapped.bookBefore!] });
        return;
    }
    // No snapshot (state created before this field existed): rebuild PAIRS only
    // from the accumulated page states and keep the characters untouched —
    // dropping rows the replay cannot re-derive is worse than a stale row (the
    // model's correct=/sameAs ops can fix rows; a wiped book is unrecoverable).
    let rebuilt: { pairs: [string, string][]; characters: CharacterEntry[] } = { pairs: [], characters: [] };
    for (const st of uniquePages()) {
        if (targets.includes(st) || !st.outputs?.length) continue;
        rebuilt = updateContext(rebuilt, st.outputs, [], false, pipeline.contextPairs).ctx;
    }
    setContext({ pairs: rebuilt.pairs, characters: context.characters });
}

// …and after the fresh translation, fold the pages that FOLLOW the target
// back in (their stored outputs — no LLM calls) so the book ends up whole.
export function replayPagesAfter(target: PageState): void {
    const refs = getPages();
    const at = refs.findIndex(ref => pages.get(refKey(ref)) === target);
    if (at === -1) return;
    for (const ref of refs.slice(at + 1)) {
        const st = pages.get(refKey(ref));
        if (st?.outputs?.length) setContext(updateContext(context, st.outputs, st.mentions ?? [], pipeline.useCharacters, pipeline.contextPairs).ctx);
    }
}

// enqueue result: 'queued' (new job) | 'dup' (already queued) | 'active'
// (currently rendering — a second click must NOT re-translate it).
// Twin suppression is keyed by PAGE (orig src), not element: readers swap
// <img> elements under us, so the same page on a fresh element must still
// hit 'dup' instead of paying a second LLM call.
export function enqueue(ref: PageRef, force = false, auto = false): 'queued' | 'dup' | 'active' {
    if (ref.el === activeRef?.el) return 'active';
    const key = pageKeyOf(ref);
    if (force) cooldownClear(failMarks, key); // manual retranslate retries immediately
    if (key === activeKey) return 'active';
    if (paintHas(key)) return 'active'; // paint lane owns it — a twin would only double-render
    const twin = queue.findIndex(j => j.key === key);
    if (twin !== -1) {
        if (!force) return 'dup';
        queue.splice(twin, 1); // force replaces the queued twin (its prep resolves, dropped)
    }
    // detection kicks off NOW — it overlaps whatever LLM call is in flight.
    // Status goes to the activity registry (priority picks the winner), never
    // straight to the pill — a queued prep must not cover the running job.
    const prep = preparePage(ref, force, (s, stage) => setActivity(key, s, force ? 'force' : 'view', stage), false, auto)
        .catch(e => { throw e; }); // surface prepare errors in runJob
    // orphan suppressor: dropped twins (dequeue/clearQueue/force-splice) never
    // get awaited — without this their late rejections surface as pageerror
    // noise (a 403 fetch failing after its job was dropped). runJob still sees
    // every rejection through job.prep above.
    prep.catch(() => {});
    const job = { ref, force, prep, key, auto };
    // explicit intent (manual / re-translate) jumps a prefetch backlog
    if (force) queue.unshift(job);
    else queue.push(job);
    pump();
    return 'queued';
}

// Pull a page out of the queue before it starts (detection prep is fire-and-
// forget; its result is simply dropped). Keyed by PAGE, not element — the
// reader swaps <img> elements, so the cancel button's element may not be the
// queued one. Returns false if it's already running.
export function dequeue(ref: PageRef): boolean {
    const key = pageKeyOf(ref);
    const i = queue.findIndex(j => j.key === key);
    if (i === -1) return false;
    queue.splice(i, 1);
    removeActivity(key); // its in-flight prep must not resurrect as a ghost
    return true;
}

export async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
        while (queue.length) {
            // viewed page cuts the line — a serial backlog of prefetch must not
            // leave the user staring at an untranslated page for minutes
            queue.sort((a, b) => viewportOverlap(b.ref) - viewportOverlap(a.ref));
            // Parallel mode: with context OFF every page is standalone (no shared
            // book to keep ordered), so several LLM calls may run at once — bounded
            // by the setting. Any force (re-translate) job needs ordered rewind/
            // replay → falls back to serial for the whole batch.
            const parallel = !shareContext && pipeline.parallelLlm > 1 && !queue.some(j => j.force);
            if (parallel) {
                const n = Math.min(pipeline.parallelLlm, queue.length);
                await Promise.all(Array.from({ length: n }, () => runJob(false)));
                continue;
            }
            await runJob(true);
        }
    } finally {
        running = false;
    }
}

// paint pump: up to paintLaneSize cached repaints at once (local CPU only — no
// LLM, no book writes). Quiet completions (no per-page Done — the counts +
// progress bar already report); failures park + surface like normal errors.
function pumpPaint(): void {
    while (paintRunning < paintLaneSize('gpu' in navigator)) {
        const job = paintQueue.shift();
        if (!job) return;
        paintRunning++;
        paintActive.set(job.key, job);
        const st = (s: string, stage?: MtStage) => setActivity(job.key, s, job.force ? 'force' : 'view', stage);
        void (async () => {
            try {
                const prep = await job.prep;
                if (!prep) { removeActivity(job.key); renderStatus(); return; } // painted while queued
                await renderPage(job.ref, prep, st, job.force);
                cooldownClear(failMarks, job.key);
                removeActivity(job.key);
                renderStatus();
            } catch (e) {
                const err = e as Error & { kind?: string; hint?: string };
                cooldownMark(failMarks, job.key, Date.now());
                removeActivity(job.key);
                lastMsgSet({ text: 'Error: ' + err.message, phase: 'error' });
                renderStatus();
                void logError(err.message, err.hint, err.kind);
            } finally {
                paintActive.delete(job.key);
                paintRunning--;
                applyOverlays();
                pumpPaint();
            }
        })();
    }
}

// unprocessed image with the largest viewport overlap — auto-translate
// follows what the reader is actually looking at, not DOM order. AREA, not
// vertical-only: splide-based paged readers stack every
// page in the same vertical band, so a y-only overlap ties them all and the
// sort collapses to DOM order — the first blank canvases then hog the auto
// budget forever while the visible page starves (live-proven).
export function viewportOverlap(ref: PageRef): number {
    const r = ref.el.getBoundingClientRect();
    const vh = window.innerHeight, vw = window.innerWidth;
    const oh = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const ow = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    return oh * ow;
}

// ghost-drop: an AUTO job whose element died or moved on while queued must
// not burn an LLM call on pixels nobody looks at (blob-rotating readers
// recycle nodes mid-queue — the pump was translating scrolled-past pages
// while the viewed one starved). Drop ⟺ element detached, OR (img showing a
// different URL AND different pixels). Same-URL proceeds (read-path hash
// wobble is fine — identity is stable); same-pixels proceeds (rotation of the
// same page). Force/manual jobs skip this — explicit intent always wins.
async function ghostDropped(job: Job, prep: Prep): Promise<boolean> {
    if (job.ref.kind !== 'img') return job.ref.el.isConnected === false;
    const el = job.ref.el;
    if (!el.isConnected) return true;
    if (el.src === job.key) return false;
    try {
        const bmp = await createImageBitmap(el);
        try {
            return pageHashFromBitmap(bmp) !== prep.hash;
        } finally {
            try { bmp.close(); } catch { /* already closed */ }
        }
    } catch { return false; } // undecodable — let the job run, prep pixels decide
}

// run one job from the queue; returns when the job settles (success or error).
// allowSeam=false in parallel batches: concurrent stitch owners could
// interleave slice writes with no shared book to keep ordered — those pages
// keep today's solo behavior (no regression, just no seam fix).
export async function runJob(allowSeam: boolean): Promise<void> {
    const job = queue.shift();
    if (!job) return;
    // A queued job outlives reader churn on purpose (pre-translate-ahead):
    // story changes are caught by the sweep's clearQueue, so the only stale
    // case left is the <2s race — drop if the chapter already moved on.
    if (chapterKey() !== contextChapter) return;
    pillUnDismiss(); // new job → un-dismiss the pill
    activeRef = job.ref;
    activeKey = job.key;
    activePrep = job.prep;
    const endKeepalive = keepaliveOpen();
    const st = (s: string, stage?: MtStage) => setActivity(job.key, s, job.force ? 'force' : 'view', stage);
    try {
        let prep;
        try {
            prep = await job.prep;
        } catch (e) {
            const pe = e as Error & { kind?: string; hint?: string };
            const wrapped = new Error('Detection failed: ' + (pe.message ?? e)) as Error & { kind?: string; hint?: string };
            wrapped.kind = pe.kind; wrapped.hint = pe.hint;
            throw wrapped;
        }
        if (!prep) {
            // translated while queued — restore counts, stay silent (unless debug:
            // a no-op job with nothing to show is otherwise indistinguishable
            // from "the button did nothing")
            if (isDebug()) console.log('[mt] job dropped (already translated):', job.key.slice(-14));
            removeActivity(job.key); lastMsgSet(null); renderStatus(); return;
        }
        // ghost-drop BEFORE any LLM call (auto only — manual intent always wins).
        // A 2.5s pill flash (not silence): without console access this is the
        // only trace that a page-turn orphaned the job.
        if (job.auto && (await ghostDropped(job, prep))) {
            if (isDebug()) console.log('[mt] job dropped (ghost):', job.key.slice(-14));
            removeActivity(job.key); lastMsgSet(null); setStatus('Skipped (page changed)', 'idle'); renderStatus(); return;
        }
        // paint-lane divert: cached + already folded — painting it here would
        // hold the serial pump (and its LLM ordering) for pure local CPU
        // work. The lane stays visible to seam/auto-twin guards; completions
        // stay quiet (counts + progress bar already report them).
        if (prep.cached && bookHas(prep.hash)) {
            if (isDebug()) console.log('[mt] paint lane divert:', job.key.slice(-14));
            paintQueue.push(job);
            pumpPaint();
            return;
        }
        const state = (allowSeam && job.ref.kind === 'img' && !prep.cached)
            ? (await trySeam(job, prep, st).catch(e => {
                console.warn('[mt] seam failed, solo fallback:', (e as Error)?.message ?? e);
                return null;
            }) ?? await renderPage(job.ref, prep, st, job.force))
            : await renderPage(job.ref, prep, st, job.force);
        if (state.det && state.det.boxes.length) {
            // auto-show only when the user hasn't pinned "Show original" mid-run
            if (overlayChoice === 'auto') setOverlayOn(true);
            const mode = state.outputs?.length ? `LLM ${state.outputs.length}/${state.det.boxes.length} regions` : 'no usable text';
            removeActivity(job.key);
            lastMsgSet({ text: `Done (${state.det.ep}, ${Math.round(state.det.inferMs)}ms, ${mode}, ${context.characters.length} characters)`, phase: 'done' });
            renderStatus();
            // single-page work toasts per page; auto pre-translate stays quiet and
            // reports through the pill counts + paused hint instead of a toast storm
            if (!job.auto) makeToast('Page done — ' + mode, 'ok');
        } else {
            removeActivity(job.key);
            lastMsgSet({ text: 'Done (no text found)', phase: 'done' });
            renderStatus();
        }
        // sweep instead of pointing at the (possibly replaced) element —
        // picks up fresh reader elements for THIS page and any earlier ones
        applyOverlays();
        cooldownClear(failMarks, job.key);
    } catch (e) {
        const err = e as Error & { kind?: string; hint?: string; retryAfterMs?: number };
        cooldownMark(failMarks, job.key, Date.now());
        // a refusal stops the chapter's background work: retrying page after
        // page cannot succeed while the provider refuses (see haltAuto)
        if (err.kind === 'ratelimit' || err.kind === 'auth') {
            haltAuto(err.kind, err.retryAfterMs ?? 0);
            dropAutoQueued();
        }
        const msg = 'Error: ' + err.message;
        removeActivity(job.key);
        lastMsgSet({ text: msg, phase: 'error' });
        renderStatus();
        if (!job.auto) makeToast(msg, 'error', err.hint);
        void logError(err.message, err.hint, err.kind);
    } finally {
        endKeepalive();
        activeRef = null;
        activeKey = null;
        activePrep = null;
    }
}

// Drop everything still queued (story change / manual cancel). The page
// currently rendering runs to completion — aborting mid-LLM would corrupt
// the book (and the tokens are spent already). Paint-lane backlog drops too
// (in-flight paints are sub-second and run out on their own).
export function clearQueue(): void {
    for (const j of queue) removeActivity(j.key);
    queue.length = 0;
    for (const j of paintQueue) removeActivity(j.key);
    paintQueue.length = 0;
}

// Toggle-off: drop queued AUTO work (explicit manual/force intent + the
// in-flight page survive). Completed pages are cached — nothing repeats, the
// unstarted backlog simply never runs.
export function dropAutoQueued(): number {
    let n = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].auto && !queue[i].force) { removeActivity(queue[i].key); queue.splice(i, 1); n++; }
    }
    for (let i = paintQueue.length - 1; i >= 0; i--) {
        if (paintQueue[i].auto && !paintQueue[i].force) { removeActivity(paintQueue[i].key); paintQueue.splice(i, 1); n++; }
    }
    return n;
}
