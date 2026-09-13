// Commands from popup / context menu: element resolution, spread translate,
// cancel, retranslate, toggles, cache, status poll.

import { overlayOn, setOverlayOn, setOverlayChoice, debugOn, setDebugOn, shareContext, setShareContext, loadContext, saveContext, pipeline, sessionUsage, lastPageUsage, stateFor, chapterKey, type PageRef } from './state';
import { getPages, refKey } from './page-io';
import { cacheClear, cacheCount, cacheCountPrefix } from './page-cache';
import { isDebug } from '../debug';
import { queue, isBusy, enqueue, dequeue, clearQueue, pageKeyOf, activeKeyGet, paintQueued } from './queue';
import { setStatus, idleStatus, pageCounts, makeToast, logError } from './status-ui';
import { applyOverlays } from './overlays';
import { ensureDebugViews } from './ocr';
import { toggleCharsPanel, charsPanelOpen } from './chars-ui';
import { setAutoTranslate, lookaheadActive, cancelLookahead } from './auto';
import { startSweep, cancelSweep, sweepStatus, sweepPages } from './sweep';

export function toggleOverlay(): void {
    setOverlayOn(!overlayOn);
    setOverlayChoice(overlayOn ? 'auto' : 'original');
    applyOverlays();
}

export async function toggleShareContextToggle(): Promise<void> {
    setShareContext(!shareContext);
    await loadContext(); // ensure session key exists before saving
    await saveContext();
}

function imgInViewport(): PageRef | null {
    const vh = window.innerHeight;
    let best: PageRef | null = null, bestOverlap = 0;
    for (const ref of getPages()) {
        const r = ref.el.getBoundingClientRect();
        const overlap = Math.min(r.bottom, vh) - Math.max(r.top, 0);
        if (overlap > bestOverlap) { bestOverlap = overlap; best = ref; }
    }
    return best;
}

// last right-clicked element + point + time (capture) — the context-menu
// translate hits the exact image even if the reader swapped elements/src
// since discovery. One-shot AND time-boxed: a popup press long after a
// dismissed menu must not reuse its stale point (recycled elements live
// there now) — menu picks happen within seconds of the right-click.
let lastRightClicked: Element | null = null;
let lastRightClickXY: { x: number; y: number } | null = null;
let lastRightClickT = 0;
document.addEventListener('contextmenu', e => {
    lastRightClicked = e.target as Element;
    lastRightClickXY = { x: e.clientX, y: e.clientY };
    lastRightClickT = Date.now();
}, true);

// overlay-piercing pick: some readers lay a transparent div over each page
// (overlay readers), so a right-click lands on the div and the image menu
// target is never the <img>. Scan the stack at the click point for the
// topmost page-candidate img instead. Generic — no site rules.
function imgAtPoint(x: number, y: number): PageRef | null {
    let els: Element[];
    try { els = document.elementsFromPoint(x, y); } catch { return null; }
    const refs = getPages();
    for (const el of els) {
        if (el instanceof HTMLImageElement) {
            const hit = refs.find(r => r.el === el);
            if (hit) return hit;
        }
    }
    return null;
}

// popup-button press (no click behind it): translate the whole visible
// spread, most-visible first — a 2-page spread otherwise leaves one page
// English and reads as "the button did nothing". Visibility is by AREA:
// a vertical-only overlap would also catch offscreen preloads stacked at
// the same y (spread keeps 2 hidden twins). Slivers under 20% of the
// viewport are skipped; with nothing passing, the dominant page alone keeps
// the old single-page behavior.
function translateVisible(refs: PageRef[], sendResponse: (r: unknown) => void): void {
    const vh = window.innerHeight || 1;
    const vw = window.innerWidth || 1;
    const area = (r: PageRef): number => {
        const b = r.el.getBoundingClientRect();
        return Math.max(0, Math.min(b.bottom, vh) - Math.max(b.top, 0))
            * Math.max(0, Math.min(b.right, vw) - Math.max(b.left, 0));
    };
    let cands = refs
        .map(r => ({ r, ov: area(r) }))
        .filter(c => c.ov > vw * vh * 0.2)
        .sort((a, b) => b.ov - a.ov);
    if (!cands.length) {
        const dom = imgInViewport();
        if (dom) cands = [{ r: dom, ov: 0 }];
    }
    const fresh = cands.filter(c => !stateFor(c.r)?.det);
    if (isDebug()) console.log('[mt] translate-image pick', JSON.stringify({
        via: 'spread', n: fresh.length, keys: fresh.map(c => refKey(c.r).slice(-8)),
    }));
    if (!fresh.length) {
        if (!cands.length) return missPage(sendResponse);
        setStatus('Already translated — use Retranslate to redo', 'done');
        sendResponse({ ok: true, already: true });
        return;
    }
    setOverlayChoice('auto'); // explicit translate intent unpins a previous "Show original"
    let queued = 0, cancelled = 0, active = false;
    for (const c of fresh) {
        const r = enqueue(c.r);
        if (r === 'queued') queued++;
        else if (r === 'active') active = true;
        else if (dequeue(c.r)) cancelled++; // second press on a queued spread = cancel it
    }
    if (queued) {
        setStatus('Translating spread…', 'busy');
        sendResponse({ ok: true, count: queued });
    } else if (cancelled) {
        setStatus(`Removed from queue — ${idleStatus()}`, 'idle');
        sendResponse({ ok: true, cancelled: true, count: cancelled });
    } else if (active) {
        sendResponse({ ok: true, active: true });
    } else {
        sendResponse({ ok: true, cancelled: false });
    }
}

// no page for the job: the right-click menu path has no UI of its own
// (background drops the response) — a toast is the only way this failure
// is ever seen (the popup surfaces resp.error itself, a duplicate toast
// there is harmless)
function missPage(sendResponse: (r: unknown) => void): void {
    makeToast('No manga page found here', 'error');
    void logError('no manga image found', undefined, 'parse');
    sendResponse({ ok: false, error: 'no manga image found' });
}

export function installMessageListener(): void {
    chrome.runtime.onMessage.addListener((msg: { type: string; srcUrl?: string }, _sender, sendResponse) => {
        if (msg?.type === 'mt:translate-image') {
            const refs = getPages();
            // click-directed (context menu) vs spread (popup button): a menu pick
            // arrives seconds after its right-click with or without srcUrl; a bare
            // popup press carries neither and means "everything I'm looking at"
            const clickFresh = !!lastRightClicked && Date.now() - lastRightClickT < 30000;
            const directed = clickFresh || !!msg.srcUrl;
            // right-clicked element first (precise), browser-attested srcUrl, the img
            // under the click point (overlay-piercing), viewport fallback
            const elHit = clickFresh && refs.find(r => r.el === lastRightClicked);
            const urlHit = msg.srcUrl && refs.find(r => r.kind === 'img' && r.el.src === msg.srcUrl);
            const ptHit = clickFresh && lastRightClickXY && imgAtPoint(lastRightClickXY.x, lastRightClickXY.y);
            lastRightClicked = null;
            lastRightClickXY = null;
            lastRightClickT = 0;
            if (!directed) return translateVisible(refs, sendResponse);
            const ref = elHit || urlHit || ptHit || imgInViewport();
            if (isDebug()) console.log('[mt] translate-image pick', JSON.stringify({
                via: elHit ? 'element' : urlHit ? 'srcUrl' : ptHit ? 'point' : ref ? 'viewport' : 'none',
                key: ref ? refKey(ref).slice(-14) : null, pages: refs.length, known: ref ? stateFor(ref) !== undefined : false,
            }));
            if (!ref) return missPage(sendResponse);
            // already translated → say so instead of queueing a silent no-op job.
            // (Checked before unpinning: a free click must not flip "Show original".)
            if (stateFor(ref)?.det) {
                setStatus('Already translated — use Retranslate to redo', 'done');
                sendResponse({ ok: true, already: true });
                return;
            }
            setOverlayChoice('auto'); // explicit translate intent unpins a previous "Show original"
            const r = enqueue(ref);
            if (r === 'dup') {
                // second click on a queued page = cancel it
                if (dequeue(ref)) { setStatus(`Removed from queue — ${idleStatus()}`, 'idle'); sendResponse({ ok: true, cancelled: true }); }
                else sendResponse({ ok: true, cancelled: false });
            } else if (r === 'active') {
                sendResponse({ ok: true, active: true });
            } else {
                sendResponse({ ok: true });
            }
            return;
        }
        if (msg?.type === 'mt:cancel-all') {
            // drop everything queued (the in-flight page runs out — aborting mid-LLM
            // wastes spent tokens and corrupts the book). Background engines stop
            // too: the chapter sweep (own stop otherwise) and the lookahead chain
            // (drains after its current page — same no-mid-LLM-abort rule).
            const n = queue.length + paintQueued();
            const stopping = !!sweepStatus()?.active || cancelLookahead();
            clearQueue();
            cancelSweep();
            setStatus(n ? `Cancelled — dropped ${n} queued` : stopping ? 'Stopping background work…' : idleStatus(), 'idle');
            sendResponse({ ok: true, dropped: n });
            return;
        }
        if (msg?.type === 'mt:retranslate') {
            // re-translate only the page the reader is on (with context rewind)
            setOverlayChoice('auto'); // explicit translate intent unpins a previous "Show original"
            const ref = imgInViewport();
            if (!ref) { sendResponse({ ok: false, error: 'no manga image in view' }); return; }
            if (pageKeyOf(ref) === activeKeyGet()) { sendResponse({ ok: false, error: 'page is rendering right now' }); return; }
            dequeue(ref); // re-click replaces the queued twin (keyed by page, no-op if absent)
            const r = enqueue(ref, true);
            sendResponse(r === 'queued' ? { ok: true } : { ok: false, error: 'could not queue re-translate' });
            return;
        }
        if (msg?.type === 'mt:toggle-original') {
            toggleOverlay();
            sendResponse({ ok: true, overlayOn });
            return;
        }
        if (msg?.type === 'mt:toggle-context') {
            toggleShareContextToggle().then(() => sendResponse({ ok: true, shareContext }));
            return true;
        }
        if (msg?.type === 'mt:toggle-chars') {
            toggleCharsPanel();
            sendResponse({ ok: true, open: charsPanelOpen() });
            return;
        }
        if (msg?.type === 'mt:toggle-reading-dir') {
            // takes effect on the next translate — numbering/crops/order all change
            pipeline.readingDir = pipeline.readingDir === 'rtl' ? 'ltr' : 'rtl';
            chrome.storage.local.set({ mtPipeline: pipeline })
                .then(() => sendResponse({ ok: true, readingDir: pipeline.readingDir }));
            return true;
        }
        if (msg?.type === 'mt:toggle-debug') {
            setDebugOn(!debugOn);
            const on = debugOn;
            chrome.storage.local.set({ mtDebug: on })
                .then(() => (on ? ensureDebugViews() : Promise.resolve()))
                .then(() => { applyOverlays(); sendResponse({ ok: true, debugOn }); });
            return true;
        }
        if (msg?.type === 'mt:cache-clear') {
            cacheClear().then(async () => sendResponse({ ok: true, count: await cacheCount(), mine: 0, max: pipeline.cacheMax }));
            return true;
        }
        if (msg?.type === 'mt:cache-count') {
            (async () => sendResponse({ ok: true, count: await cacheCount(), mine: await cacheCountPrefix(chapterKey() + '#'), max: pipeline.cacheMax }))();
            return true;
        }
        if (msg?.type === 'mt:status') {
            const viewed = imgInViewport();
            sendResponse({
                ok: true,
                status: uiText(),
                busy: isBusy(),
                overlayOn,
                shareContext,
                debugOn,
                readingDir: pipeline.readingDir,
                charsOpen: charsPanelOpen(),
                usage: sessionUsage,
                lastUsage: lastPageUsage,
                // viewed-page state: for the popup's main button (keyed by page — the
                // reader swaps elements, so element identity lies)
                viewedTranslated: viewed ? !!stateFor(viewed)?.det : false,
                viewedQueued: viewed ? queue.some(j => j.key === pageKeyOf(viewed)) : false,
                viewedActive: viewed ? pageKeyOf(viewed) === activeKeyGet() : false,
                sweep: sweepStatus(),
                lookaheadActive: lookaheadActive(),
                ...pageCounts(),
            });
            return;
        }
        if (msg?.type === 'mt:auto-translate') {
            const m = msg as { type: string; on?: boolean; origin?: string };
            // popup toggles one tab's site — a tab switch between open and click
            // must not flip some other site's loop
            if (typeof m.origin === 'string' && m.origin !== location.origin) {
                sendResponse({ ok: true, ignored: true });
                return;
            }
            setAutoTranslate(m.on === true);
            sendResponse({ ok: true });
            return;
        }
        if (msg?.type === 'mt:sweep-start') {
            startSweep().then(r => sendResponse(r));
            return true;
        }
        if (msg?.type === 'mt:sweep-cancel') {
            sendResponse(cancelSweep());
            return;
        }
        if (msg?.type === 'mt:sweep-count') {
            sweepPages().then(n => sendResponse({ ok: true, count: n }));
            return true;
        }
    });
}

// the pill text (harnesses + popup read it) — lives on the #mt-ui element
function uiText(): string {
    const el = document.querySelector('#mt-ui-text') ?? document.querySelector('#mt-ui span');
    return el ? (el as HTMLElement).textContent ?? '' : '';
}
