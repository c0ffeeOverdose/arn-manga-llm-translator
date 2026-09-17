// Auto-translate: follow the reader's scroll, pre-translate ahead, off-DOM
// lookahead for single-img and canvas-manifest readers.

import { pageHashFromBitmap, cacheKey, settingsFingerprint, cachePut, cacheDelete, packMask, autoBudget, galleryLookaheadUrls, manifestAheadUrls, readWarming, warmingFresh, writeWarming, samePagePath, registerLookaheadAbort } from './page-cache';
import { isAutoSite } from '../llm/pipeline-settings';
import { isDebug } from '../debug';
import type { MtOnStatus } from './detection';
import { pipeline, loadPipeline, chapterKey, resetContextIfNewChapter, sessionUsage, setLastPageUsage, stateFor, type PageRef } from './state';
import { fetchBitmap, getPages, unscrambleTiles, episodeManifestSrcs, galleryManifestJson } from './page-io';
import { resolveHeadlessDet } from './pipeline';
import { sweepHas, sweepActive, bookAdd } from './sweep';
import { translateRegions, warmPatches, type TranslateOutcome } from './ocr';
import { queue, failMarks, enqueue, viewportOverlap, pageKeyOf, activeRefGet, dropAutoQueued, paintHas, autoHalted, resumeAuto, keepaliveOpen } from './queue';
import { cooldownMark, cooldownParked } from './page-cache';
import { setActivity, removeActivity, lastMsgSet, renderStatus, registerAutoTranslateFlag } from './status-ui';

let autoTranslate = false;          // user toggle (persisted in storage.local)
let autoTimer: number | undefined;  // single poll loop, no matter how often toggled

// rolling pre-translate window: every tick refills the queue up to
// pipeline.prefetchN AUTO jobs waiting (most-visible first, hidden preload
// follows when the window allows). The cap is on the total, not per tick —
// without it a full-DOM long strip queues the whole chapter. Manual jobs
// bypass the budget. Cooling/parked failures are skipped, never force-fed.
async function autoTick(): Promise<void> {
    // E2E hook (debug only): the harness asserts auto is really on in-page
    // instead of inferring it from side effects minutes later. A DOM attribute,
    // not a window expando — content scripts run in an isolated world whose
    // window props are invisible to page.evaluate; the DOM is shared.
    // Written only on transitions (a 2.5s attribute churn is rude to observers).
    if (isDebug()) {
        const flag = autoTranslate ? '1' : '0';
        if (lastMtAutoFlag !== flag) {
            lastMtAutoFlag = flag;
            try { document.documentElement.dataset.mtAuto = flag; } catch { /* early load */ }
        }
    }
    if (!autoTranslate) return;
    // provider refused (rate limit / auth): auto is stopped until the user acts
    // — every request in the meantime would be refused again (see haltAuto)
    if (autoHalted()) return;
    // chapter sweep owns this chapter right now — its commits paint arrivals
    // and its folds must stay ordered; auto jobs would duplicate work, and a
    // fresh-translate setContext would clobber the sweep's book. Manual
    // intent (popup/menu/force) bypasses this entirely; auto resumes when the
    // sweep ends.
    if (sweepActive()) return;
    const now = Date.now();
    const ahead = Math.min(30, Math.max(1, pipeline.prefetchN ?? 3));
    // live-only budget: ghost jobs (dead elements) sitting in the queue must
    // not block the viewed page from enqueuing — they die at runJob anyway
    const budget = autoBudget(queue.filter(j => j.auto && j.ref.el.isConnected).length, ahead);
    if (!budget) return;
    const cands = getPages()
        .filter(r => !stateFor(r) && !queue.some(j => j.ref.el === r.el) && !paintHas(pageKeyOf(r)) && !cooldownParked(failMarks, pageKeyOf(r), now) && !sweepHas(pageKeyOf(r)))
        .sort((a, b) => viewportOverlap(b) - viewportOverlap(a))
        .slice(0, budget);
    for (const ref of cands) {
        // img must be decoded; canvas is always ready
        if (ref.kind === 'img' && !(ref.el.complete && ref.el.naturalWidth > 0)) continue;
        enqueue(ref, false, true); // auto work stays quiet — the pill counts report progress
    }
    // DOM window exhausted → off-DOM lookahead (single-img readers) spends the
    // remaining budget warming the next pages; fire-and-forget, single chain
    void prefetchAhead();
}

// off-DOM lookahead for single-img readers (the DOM holds only the
// current page, so the rolling window can never see ahead): warm the next
// pages from the embedded gallery manifest. No element, no paint — results
// land in the IDB cache (arrival = cache hit) and translateRegions folds the
// outputs into the persisted book itself. Serial, forward-only, auto-quiet.
let prefetchBusy = false;
const warmedUrls = new Set<string>(); // per script instance — a nav resets it, correctly (new page, new lookahead)
// user cancel (popup button / auto toggle-off): the chain stops AFTER the
// in-flight page (mid-LLM abort wastes tokens + corrupts the book — same rule
// as queue/sweep). Armed only while a chain runs, consumed by its epilogue —
// a stale flag blocking future chains is impossible by construction.
let lookaheadCancel = false;
export function lookaheadActive(): boolean { return prefetchBusy; }
// readers (arrival paint): auto.ts imports nobody that imports overlays —
// this edge is cycle-free, unlike going through status-ui
export function autoOn(): boolean { return autoTranslate; }
export function cancelLookahead(): boolean {
    if (!prefetchBusy) return false;
    lookaheadCancel = true;
    return true;
}
let lastMtAutoFlag: string | undefined; // E2E auto hook above — transition-only writes
async function prefetchHeadless(url: string, descramble = false, onStatus: MtOnStatus = () => {}): Promise<void> {
    resetContextIfNewChapter();
    await loadPipeline();
    // trace before work: a page-turn kills this chain silently, and the next
    // load names the restart off this (see preparePage). Read first — our own
    // write below must not mask a previous load's trace.
    const prev = readWarming();
    writeWarming(url);
    onStatus('Reading page…', 'read');
    const f = await fetchBitmap(url); // direct → SW proxy → DNR retry, same as DOM pages
    let bitmap = f.bitmap;
    if (descramble) {
        try {
            const fixed = await unscrambleTiles(bitmap);
            if (fixed) {
                bitmap.close();
                bitmap = fixed.bitmap;
                if (isDebug()) console.log('[mt] unscrambled', JSON.stringify({ unshuffled: url.slice(-24) }));
            }
        } catch { /* gate/pixel failure — translate fetched bytes as-is */ }
    }
    try {
        const hash = pageHashFromBitmap(bitmap);
        const key = cacheKey(chapterKey(), hash);
        const fp = settingsFingerprint(pipeline);
        // shared headless resolve (full hit → return, partial → resume,
        // else detect + order + checkpoint) — see resolveHeadlessDet
        const r = await resolveHeadlessDet(bitmap, hash, onStatus);
        if (!r.det) return;
        if (!r.resumed && prev && samePagePath(prev.key, url) && warmingFresh(prev.ts)) {
            onStatus('Warming was interrupted — restarting…', 'read');
        }
        const det = r.det;
        // solo only: seam needs DOM siblings (unknown off-DOM) — a solo result
        // still beats an untranslated arrival, and arrival can force if needed
        const endKeepalive = keepaliveOpen(); // FF event page drops cold-start LLM calls (see keepaliveOpen)
        let o: TranslateOutcome;
        try {
            o = await translateRegions(bitmap, det, onStatus,
                { progressKey: url, continued: r.resumed || !pipeline.cacheEnabled, lo: true });
        } finally {
            endKeepalive();
        }
        if (o.error) throw Object.assign(new Error(`LLM failed: ${o.error}`), { kind: o.errorKind, hint: o.errorHint, retryAfterMs: o.errorRetryAfterMs });
        onStatus('Saving…', 'render'); // headless has no paint — the cache write is the last leg
        bookAdd(hash); // folded above (translateRegions) — arrival must not refold
        if (pipeline.cacheEnabled) {
            // AI cleanup precompute: arrival paints with the model's patches
            // instead of running it while the user waits (lo-priority ORT)
            const ai = await warmPatches(bitmap, det, o.outputs);
            void cachePut({
                key,
                fp,
                w: bitmap.width, h: bitmap.height,
                boxes: det.boxes, panels: det.panels ?? [],
                outputs: o.outputs, extras: o.extras, mentions: o.mentions,
                mask: packMask(det.mask),
                splitGen: det.splitGen ?? 0,
                ep: det.ep,
                ...(ai ? { patches: ai.patches, patchesGen: ai.patchesGen } : null),
            }, pipeline.cacheMax);
        } else {
            void cacheDelete(key); // cache off: drop the resume checkpoint this headless job finished
        }
        if (o.usage) {
            sessionUsage.pages++;
            sessionUsage.inTok += o.usage.inTok ?? 0;
            sessionUsage.outTok += o.usage.outTok ?? 0;
            sessionUsage.cachedInTok += o.usage.cachedInTok ?? 0;
        }
        setLastPageUsage({ inTok: o.usage?.inTok, outTok: o.usage?.outTok, cachedInTok: o.usage?.cachedInTok, ms: o.llmMs, calls: o.llmCalls });
    } finally {
        try { bitmap.close(); } catch { /* already closed */ }
    }
}

// lookahead driver: runs when the DOM window is exhausted but budget remains
// AND the viewed page is done (viewed-first — never races the current page
// for the LLM, and the book holds its context before farther pages build on
// it). One chain per page-view: warmed/parked/sweep-claimed URLs are skipped,
// a busy chain is never doubled, and a chapter change aborts the run.
async function prefetchAhead(): Promise<void> {
    if (prefetchBusy) return;
    const ahead = Math.min(30, Math.max(1, pipeline.prefetchN ?? 3));
    const liveAuto = queue.filter(j => j.auto && j.ref.el.isConnected).length;
    const budget = autoBudget(liveAuto, ahead);
    if (!budget) return;
    const refs = getPages().sort((a, b) => viewportOverlap(b) - viewportOverlap(a));
    const cur = refs[0];
    // viewed page must exist and be DONE — its state proves it (translated or
    // no-text); anything still queued/active means hands off
    const curState = cur ? stateFor(cur) : undefined;
    if (!cur || !curState || activeRefGet() || queue.some(j => j.ref.el === cur.el)) return;
    // orig, not the live src: after translation el.src is our own blob, which
    // matches no host/path pattern (silent no-op every tick — the bug that kept
    // lookahead from ever firing). PageState.orig is the https original.
    // (galleryLookaheadUrls keeps this pure + regression-locked in unit tests.)
    // Canvas readers (gigaviewer): anchor on the viewed canvas's manifest index
    // and warm the next MAIN srcs (nulls = ad/promo areas, skipped) — same
    // headless driver, arrival hits the cache like the gallery pages.
    let cands: string[];
    if (cur.kind === 'img') {
        cands = galleryLookaheadUrls(await galleryManifestJson(), curState.orig, budget);
    } else {
        const srcs = episodeManifestSrcs();
        const anchor = cur.pageSrc ?? curState.orig; // live DOM truth first, stored orig second
        cands = srcs && anchor ? manifestAheadUrls(srcs, anchor, budget) : [];
    }
    const urls = cands
        .filter(u => !warmedUrls.has(u) && !sweepHas(u) && !paintHas(u) && !cooldownParked(failMarks, u, Date.now()));
    if (!urls.length) return;
    prefetchBusy = true;
    const chapter = chapterKey();
    setActivity('lookahead', `Pre-translating 1/${urls.length}…`, 'lookahead', undefined); // visible: the only proof lookahead fired (auto is quiet otherwise)
    // stages flow into the same activity — the stepper lights up read→detect→
    // ocr→llm→render exactly like a visible job (priority stays lowest, so a
    // real page's progress always wins the pill while both run). The count
    // survives page advances (same key overwritten) so the chain no longer
    // reads as "restarted" every page.
    const lkStatus: MtOnStatus = (s, stage) => setActivity('lookahead', `Pre-translating ${warmed + 1}/${urls.length}: ${s}`, 'lookahead', stage);
    let warmed = 0, firstErr = '';
    try {
        for (const url of urls) {
            if (chapterKey() !== chapter) break; // SPA story change — abort quietly
            if (lookaheadCancel) break; // user stop — drain after the in-flight page below
            if (autoHalted()) break; // provider refused — the job that hit it already stopped us
            if (sweepActive()) break; // sweep started mid-chain — it owns these pages now (startSweep also aborts us, belt & braces)
            try {
                if (isDebug()) console.log('[mt] prefetch lookahead:', url); // full URL — host matters (volatile CDN hosts)
                await prefetchHeadless(url, cur.kind !== 'img', lkStatus); // canvas-branch URLs are manifest puzzles (descramble); img-branch URLs are final pixels
                warmedUrls.add(url);
                warmed++;
            } catch (e) {
                const msg = (e as Error)?.message ?? String(e);
                if (!firstErr) firstErr = msg;
                cooldownMark(failMarks, url, Date.now());
                console.warn('[mt] prefetch failed:', msg); // always-visible: silent parks are why "nothing works" is undebuggable
            }
        }
    } finally {
        prefetchBusy = false;
    }
    // restore the pill: success reports what was warmed (a short done-message,
    // then idle counts — background work, so 4s not the usual lingering Done);
    // total failure names the reason for 10s (then idle — a stuck error
    // misleads worse than silence). A user-cancelled run goes quiet — the
    // cancel control already said its piece, and error reports of a run the
    // user killed would read as fresh failures.
    removeActivity('lookahead');
    const cancelled = lookaheadCancel;
    lookaheadCancel = false;
    if (cancelled) {
        lastMsgSet(null);
        renderStatus();
        return;
    }
    if (warmed > 0) {
        lastMsgSet({
            text: firstErr ? `Prepared ${warmed} pages ahead (1 failed)` : `Next ${warmed} page${warmed > 1 ? 's' : ''} ready`,
            phase: 'done',
            until: Date.now() + 4000,
        });
        renderStatus();
    } else if (!firstErr) {
        lastMsgSet(null);
        renderStatus();
    } else {
        lastMsgSet({ text: `Lookahead failed: ${firstErr.slice(0, 90)}`, phase: 'error', until: Date.now() + 10000 });
        renderStatus();
    }
}

export async function setAutoTranslate(on: boolean): Promise<void> {
    autoTranslate = on;
    if (!on) {
        // stopping the loop stops the backlog too: queued AUTO jobs are
        // dropped (explicit manual/force intent + the in-flight page survive)
        // and a running lookahead chain drains after its current page (no
        // restart — the flag is off). Completed pages are cached.
        let touched = dropAutoQueued() > 0;
        touched = cancelLookahead() || touched;
        if (touched) renderStatus();
        return;
    }
    resumeAuto(); // the user switched auto on again — their intent outranks a provider halt
    if (autoTimer == null) {
        autoTimer = setInterval(autoTick, 2500);
        autoTick(); // start with the page the reader is on right now
    }
}

registerAutoTranslateFlag(() => autoTranslate);
registerLookaheadAbort(cancelLookahead); // sweep start/stop must not leave a warming chain running

// per-site: auto runs only where the user enabled it (see isAutoSite).
// Persistence lives in the popup (the toggle owner); here we only evaluate.
async function autoStateHere(): Promise<boolean> {
    const v = await chrome.storage.local.get(['mtAutoTranslate', 'mtAutoSites']) as
        { mtAutoTranslate?: boolean; mtAutoSites?: unknown };
    return isAutoSite(location.origin, v.mtAutoSites, v.mtAutoTranslate === true);
}

export function initAuto(): void {
    autoStateHere().then(on => { if (on) setAutoTranslate(true); });
    chrome.storage.onChanged.addListener((ch, area) => {
        // per-site toggle flipped elsewhere (another tab's popup): open tabs of the
        // same site follow live, other sites ignore it
        if (area === 'local' && (ch.mtAutoSites || ch.mtAutoTranslate)) autoStateHere().then(setAutoTranslate);
    });
}
