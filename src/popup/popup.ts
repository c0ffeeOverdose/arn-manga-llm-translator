// Action popup: the control center (the in-page bar is gone — only a status
// pill appears on the page while translating).
// ponytail: state is polled via mt:status while open — no push channel needed
import { loadPipelineSettings, isAutoSite, autoSiteOf, autoSiteList, autoSiteAdd, autoSiteRemove } from '../llm/pipeline-settings';
import { sessGet } from '../storage-session';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const btn = $<HTMLButtonElement>('translate');
const sweepBtn = $<HTMLButtonElement>('sweep');
const cancelAllBtn = $<HTMLButtonElement>('cancelAll');
const statusEl = $<HTMLElement>('status');
const auto = $<HTMLInputElement>('auto');
const usageBox = $<HTMLElement>('usageBox');
const showUsage = $<HTMLInputElement>('showUsage');
const origBtn = $<HTMLButtonElement>('showOriginal');
const redoBtn = $<HTMLButtonElement>('retranslate');
const charsBtn = $<HTMLButtonElement>('chars');
const dirBtn = $<HTMLButtonElement>('readingDir');
const ctxBtn = $<HTMLButtonElement>('context');
const cacheLabel = $<HTMLElement>('cacheLabel');
const cacheClearBtn = $<HTMLButtonElement>('cacheClear');
const statusSection = $<HTMLDetailsElement>('statusSection');
const stateDot = $<HTMLElement>('stateDot');
const errBanner = $<HTMLElement>('errBanner');
const usageWrap = $<HTMLDetailsElement>('usageWrap');

async function activeTab(): Promise<number | null> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
}

async function send(msg: object): Promise<any | null> {
    const tabId = await activeTab();
    if (!tabId) return null;
    return chrome.tabs.sendMessage(tabId, msg).catch(() => null);
}

// explicit theme choice (mtTheme) beats the OS default
chrome.storage.local.get('mtTheme').then(v => {
    const t = (v as { mtTheme?: string }).mtTheme;
    if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
});

// per-site auto: the checkbox reflects the ACTIVE tab's site only — other
// sites (ad redirects included) never inherit it
(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const origin = autoSiteOf(tab?.url);
    const siteEl = $<HTMLElement>('autoSite');
    if (!origin) {
        auto.checked = false;
        auto.disabled = true;
        siteEl.textContent = '(not on a web page)';
        return;
    }
    siteEl.textContent = `— ${new URL(origin).host}`;
    const v = await chrome.storage.local.get(['mtAutoTranslate', 'mtAutoSites']) as
        { mtAutoTranslate?: boolean; mtAutoSites?: unknown };
    auto.checked = isAutoSite(origin, v.mtAutoSites, v.mtAutoTranslate === true);
})();
chrome.storage.local.get('mtShowUsage').then(v => {
    showUsage.checked = v.mtShowUsage !== false; // default on
});
showUsage.onchange = async () => {
    await chrome.storage.local.set({ mtShowUsage: showUsage.checked });
    refreshStatus(); // usageWrap only re-renders in the poll — refresh now or the toggle feels laggy
};

const k = (n?: number) => { const v = Number(n); return !Number.isFinite(v) ? '?' : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v); };

// the poll auto-opens usage once data arrives — but never re-opens it after
// the user collapses it (the old code forced it open every second)
let usagePinned = false;
usageWrap.ontoggle = () => { if (!usageWrap.open) usagePinned = true; };
// status auto-opens like usage — but never re-opens after the user collapses it
let statusPinned = false;
statusSection.ontoggle = () => { if (!statusSection.open) statusPinned = true; };

// last-known toggle states — click handlers flip the label instantly
// (optimistic) instead of waiting for the 1s poll; the poll confirms.
let lastCtx = true, lastChars = false, lastOverlay = true, lastDir: 'rtl' | 'ltr' = 'rtl';
let sweepRunning = false; // mirrored from mt:status each poll — the button toggles start/cancel

async function refreshStatus(): Promise<void> {
    const resp = await send({ type: 'mt:status' });
    if (resp?.ok) {
        const counts = resp.translated && resp.loaded ? ` · ${resp.translated}/${resp.loaded} pages` : '';
        const raw = resp.status || (resp.translated ? `${resp.translated} page(s) translated` : '');
        statusEl.textContent = raw + counts || (resp.loaded === 0 ? 'No manga images found on this page.' : '');
        // empty idle state shows no card at all — not an empty box with a dot
        statusSection.style.display = statusEl.textContent ? '' : 'none';
        if (statusEl.textContent && !statusSection.open && !statusPinned) statusSection.open = true;
        const isErr = raw.startsWith('Error');
        stateDot.style.background = isErr ? 'var(--err)' : resp.busy ? 'var(--accent)' : raw.startsWith('Done') ? 'var(--ok)' : 'var(--muted)';
        errBanner.style.display = isErr ? 'block' : 'none';
        if (isErr) errBanner.textContent = raw;
        const busy = !!resp.busy;
        // usage box (session totals + last page) — collapsed until data exists
        const u = resp.usage, lu = resp.lastUsage;
        const hasUsage = showUsage.checked && u && (u.pages > 0);
        usageWrap.style.display = hasUsage ? 'block' : 'none';
        if (hasUsage && !usageWrap.open && !usagePinned) usageWrap.open = true;
        if (hasUsage) {
            // DOM-built, never innerHTML: usage numbers originate from provider
            // JSON (untrusted — see num() in adapters.ts); textContent kills any
            // markup that slips through
            usageBox.replaceChildren();
            const row = (text: string, color?: string) => {
                const d = document.createElement('div');
                if (color) d.style.color = color;
                d.textContent = text;
                return d;
            };
            usageBox.append(row(`Session: ${u.pages} pages · ${k(u.inTok)} in / ${k(u.outTok)} out`));
            if (u.cachedInTok > 0) usageBox.append(row(`Cache: ${k(u.cachedInTok)} in tok served from cache`, '#5fbf7a'));
            if (lu) usageBox.append(row(`Last page: ${k(lu.inTok)} in${lu.cachedInTok > 0 ? ` (${k(lu.cachedInTok)} cached)` : ''} / ${k(lu.outTok)} out${lu.ms ? ` · ${(lu.ms / 1000).toFixed(1)}s` : ''}`, '#8a8aa5'));
        }
        // main button reflects the VIEWED page: translate → cancel-queue → disabled-while-active
        btn.disabled = !!resp.viewedActive;
        if (resp.viewedActive) btn.textContent = 'Translating this page…';
        else if (resp.viewedQueued) btn.textContent = 'Cancel this page';
        else btn.textContent = 'Translate this page';
        redoBtn.disabled = busy || !resp.viewedTranslated;
        // cancel lives in the status card: visible while work is queued OR any
        // background engine runs (lookahead chain, chapter sweep) — otherwise
        // a running pre-translate has no stop control at all
        const q = resp.queued ?? 0;
        const bgRunning = !!resp.lookaheadActive || !!(resp.sweep as { active: boolean } | null)?.active;
        cancelAllBtn.style.display = q > 0 || bgRunning ? '' : 'none';
        cancelAllBtn.textContent = q > 0 ? `Cancel all (${q})` : 'Stop background work';
        // state label, not action: the switch shows originals until the first
        // translation lands (fresh doc defaults off), and users read the
        // button as "what am I looking at", not "what happens on click"
        origBtn.textContent = resp.overlayOn ? 'Translated ✓' : 'Original';
        lastOverlay = resp.overlayOn;
        ctxBtn.textContent = `Context: ${resp.shareContext ? 'on' : 'off'}`;
        lastCtx = resp.shareContext;
        lastDir = resp.readingDir === 'ltr' ? 'ltr' : 'rtl';
        dirBtn.textContent = lastDir.toUpperCase();
        charsBtn.textContent = resp.charsOpen ? 'Hide characters' : 'Characters';
        lastChars = resp.charsOpen;
        // chapter sweep: explicit whole-chapter background run (separate from
        // auto) — label shows progress while running, page count when idle.
        // stopping: Stop was pressed but in-flight pages still drain (no mid-LLM
        // abort) — say so instead of showing a live Stop button that "does
        // nothing". starting: enumeration in flight — cancel is still possible.
        const sw = resp.sweep as { active: boolean; phase: 'starting' | 'running' | 'stopping' | 'dead'; stopping: boolean; done: number; total: number; errors: number } | null;
        sweepRunning = !!sw?.active;
        if (sw?.stopping) {
            sweepBtn.textContent = `Stopping… (${sw.done}/${sw.total})`;
            sweepBtn.disabled = true;
        } else if (sw?.phase === 'starting') {
            sweepBtn.textContent = 'Cancel start';
            sweepBtn.disabled = false;
        } else if (sw?.phase === 'dead') {
            sweepBtn.textContent = 'Finishing previous sweep…';
            sweepBtn.disabled = true;
        } else if (sw?.active) {
            sweepBtn.textContent = `Stop sweep (${sw.done}/${sw.total})`;
            sweepBtn.disabled = false;
        } else {
            const sc = await send({ type: 'mt:sweep-count' }) as { ok?: boolean; count?: number } | null;
            const n = sc?.count ?? 0;
            sweepBtn.textContent = n > 0 ? `Translate chapter (${n} pages)` : 'Translate chapter';
            sweepBtn.disabled = !sc?.ok || n === 0;
        }
        // translation cache size (separate message — IDB read, not part of mt:status)
        const cc = await send({ type: 'mt:cache-count' });
        cacheLabel.textContent = cc?.ok ? `Cached pages (${cc.mine ?? cc.count} here · ${cc.count} total)` : 'Cached pages';
    } else {
        statusEl.textContent = 'Open a manga page to translate.';
        btn.disabled = redoBtn.disabled = true;
    }
}
refreshStatus();
const poll = setInterval(refreshStatus, 1000);
window.addEventListener('unload', () => clearInterval(poll));

btn.onclick = async () => {
    const resp = await send({ type: 'mt:translate-image' });
    if (resp?.already) { statusEl.textContent = 'This page is already translated.'; return; }
    if (resp?.cancelled) { statusEl.textContent = typeof resp?.count === 'number' ? `Removed ${resp.count} from queue.` : 'Removed from queue.'; return; }
    if (resp?.active) { statusEl.textContent = 'This page is rendering right now.'; return; }
    statusEl.textContent = resp?.ok
        ? (typeof resp?.count === 'number' && resp.count > 1 ? `Queued ${resp.count} pages…` : 'Queued…')
        : (resp?.error ?? 'failed');
};

cancelAllBtn.onclick = async () => {
    statusEl.textContent = 'Cancelling…';
    await send({ type: 'mt:cancel-all' });
    refreshStatus();
};

sweepBtn.onclick = async () => {
    if (sweepRunning) {
        statusEl.textContent = 'Stopping sweep…';
        await send({ type: 'mt:sweep-cancel' });
    } else {
        statusEl.textContent = 'Starting chapter sweep…';
        const resp = await send({ type: 'mt:sweep-start' }) as { ok?: boolean; total?: number; error?: string; starting?: boolean; cancelled?: boolean } | null;
        statusEl.textContent = resp?.starting ? 'Starting…' : resp?.ok ? `Sweeping ${resp.total} pages…` : (resp?.error ?? 'failed');
    }
    refreshStatus();
};
// pages-ahead slider: persisted to mtPipeline, content picks it up live via
// the storage listener (no message needed — preparePage reloads per job)
const ahead = $<HTMLInputElement>('ahead');
const aheadVal = $<HTMLElement>('aheadVal');
async function loadAhead(): Promise<void> {
    const { mtPipeline } = await chrome.storage.local.get('mtPipeline');
    const n = loadPipelineSettings(mtPipeline).prefetchN;
    ahead.value = String(n);
    aheadVal.textContent = String(n);
}
ahead.oninput = async () => {
    const n = Math.min(30, Math.max(1, Math.round(Number(ahead.value) || 3)));
    aheadVal.textContent = String(n);
    const { mtPipeline } = await chrome.storage.local.get('mtPipeline');
    const p = loadPipelineSettings(mtPipeline);
    p.prefetchN = n;
    await chrome.storage.local.set({ mtPipeline: p });
};
loadAhead();
redoBtn.onclick = async () => {
    statusEl.textContent = 'Queued…';
    const resp = await send({ type: 'mt:retranslate' });
    await refreshStatus();
    // survives until the next 1s poll — same flash-hint pattern as readingDir
    if (resp?.error) statusEl.textContent = resp.error;
    else if (!resp?.ok) statusEl.textContent = 'failed';
};
origBtn.onclick = async () => {
    lastOverlay = !lastOverlay;
    origBtn.textContent = lastOverlay ? 'Translated ✓' : 'Original';
    await send({ type: 'mt:toggle-original' });
    refreshStatus();
};
ctxBtn.onclick = async () => {
    lastCtx = !lastCtx;
    ctxBtn.textContent = `Context: ${lastCtx ? 'on' : 'off'}`;
    await send({ type: 'mt:toggle-context' });
    refreshStatus();
};
cacheClearBtn.onclick = async () => {
    cacheClearBtn.textContent = 'Clearing…';
    const resp = await send({ type: 'mt:cache-clear' });
    if (resp?.ok) cacheLabel.textContent = `Cached pages (${resp.mine ?? resp.count} here · ${resp.count} total)`;
    cacheClearBtn.textContent = 'Clear';
};
dirBtn.onclick = async () => {
    lastDir = lastDir === 'rtl' ? 'ltr' : 'rtl';
    dirBtn.textContent = lastDir.toUpperCase();
    await send({ type: 'mt:toggle-reading-dir' });
    await refreshStatus();
    // survives until the next 1s poll — same flash-hint pattern as Queued…
    statusEl.textContent = 'Reading order flipped — re-translate the page to apply.';
};
charsBtn.onclick = async () => {
    lastChars = !lastChars;
    charsBtn.textContent = lastChars ? 'Hide characters' : 'Characters';
    await send({ type: 'mt:toggle-chars' });
    refreshStatus();
};

auto.onchange = async () => {
    // content script owns the loop; storage.local is the shared state.
    // per-site: the checkbox edits the ACTIVE tab's origin only.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const origin = autoSiteOf(tab?.url);
    if (!origin) { auto.checked = false; return; }
    const v = await chrome.storage.local.get('mtAutoSites') as { mtAutoSites?: unknown };
    const list = auto.checked
        ? autoSiteAdd(autoSiteList(v.mtAutoSites), origin)
        : autoSiteRemove(autoSiteList(v.mtAutoSites), origin);
    // legacy flag mirrors "anything on" for pre-list readers; the list rules
    await chrome.storage.local.set({ mtAutoSites: list, mtAutoTranslate: list.length > 0 });
    send({ type: 'mt:auto-translate', on: auto.checked, origin });
};

// error log toggle — reads the content script's last-20 ring buffer
let errlogOpen = false;
const errlogEl = $<HTMLElement>('errlog');
const errorsLink = $<HTMLElement>('errors');
errorsLink.onclick = async (e) => {
    e.preventDefault();
    errlogOpen = !errlogOpen;
    errlogEl.style.display = errlogOpen ? 'block' : 'none';
    if (!errlogOpen) return;
    const { mtErrLog } = await sessGet('mtErrLog');
    const log = (mtErrLog as { t: number; msg: string; hint?: string }[] | undefined) ?? [];
    errlogEl.textContent = log.length
        ? log.map(l => `${new Date(l.t).toLocaleTimeString()} — ${l.msg}${l.hint ? `\n  ↳ ${l.hint}` : ''}`).join('\n')
        : 'No errors logged.';
};
sessGet('mtErrLog').then(v => {
    const log = (v as { mtErrLog?: { t: number }[] }).mtErrLog;
    errorsLink.textContent = log?.length ? `Recent errors (${log.length})` : '';
});

$('settings').onclick = () => chrome.runtime.openOptionsPage();

// first-run data-use disclosure — shown until acknowledged, so the user sees
// where translation data goes before the first translate, not just in the
// store listing (Chrome Web Store Disclosure Requirements, 2026 update)
chrome.storage.local.get('mtPrivacyAck').then(v => {
    if (!(v as { mtPrivacyAck?: boolean }).mtPrivacyAck) $('privacyNote').style.display = 'block';
});
$('privacyAck').onclick = async () => {
    await chrome.storage.local.set({ mtPrivacyAck: true });
    $('privacyNote').style.display = 'none';
};
