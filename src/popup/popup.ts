// Action popup: the control center. State is polled via mt:status while open — no push channel.
import { loadPipelineSettings, isAutoSite, autoSiteOf, autoSiteList, autoSiteAdd, autoSiteRemove } from '../llm/pipeline-settings';
import { sweepCountMessage, type SweepCountReason } from '../chapter/model';
import { sessGet } from '../storage-session';
import { TIMING_LABELS, formatPageTiming, timingSeconds, type PageTimingReport, type TimingName } from '../page-timing';
import { latestChapterLogHead, readChapterLog } from '../chapter/log-store';
import { chapterLogSummary, formatChapterLog, type ChapterLogHead, type ChapterLogReport } from '../chapter/log';
import { initDebug, isDebug } from '../debug';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const btn = $<HTMLButtonElement>('translate');
const sweepBtn = $<HTMLButtonElement>('sweep');
const sweepResumeBtn = $<HTMLButtonElement>('sweepResume');
const sweepWhy = $<HTMLElement>('sweepWhy');
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
const timingWrap = $<HTMLDetailsElement>('timingWrap');
const timingCopy = $<HTMLButtonElement>('timingCopy');
const timingText = $<HTMLTextAreaElement>('timingText');
let timingReport: PageTimingReport | null = null;
const chapterLogWrap = $<HTMLDetailsElement>('chapterLogWrap');
const chapterLogCopy = $<HTMLButtonElement>('chapterLogCopy');
const chapterLogText = $<HTMLTextAreaElement>('chapterLogText');
let chapterHead: ChapterLogHead | undefined;
let chapterReport: ChapterLogReport | undefined;
let chapterLogBusy = false;
const debugReady = initDebug(on => {
    if (!on) {
        clearChapterLog();
        renderTiming(null);
        statusSection.style.display = 'none';
        $('sweepDetails').textContent = '';
        $('errBanner').style.display = 'none';
        $('errlog').style.display = 'none';
        $('errlog').textContent = '';
        $('errors').textContent = '';
    }
    void refreshStatus();
    void refreshChapterLog();
    void refreshErrors();
});

function clearChapterLog(): void {
    chapterHead = undefined;
    chapterReport = undefined;
    chapterLogWrap.hidden = true;
    chapterLogWrap.open = false;
    chapterLogText.hidden = true;
    chapterLogText.value = '';
    $('chapterLogBody').textContent = '';
}

async function refreshChapterLog(): Promise<void> {
    await debugReady;
    if (!isDebug()) { clearChapterLog(); return; }
    if (chapterLogBusy) return;
    chapterLogBusy = true;
    try {
        const head = await latestChapterLogHead();
        if (!isDebug()) return;
        chapterHead = head;
        chapterLogWrap.hidden = !head;
        if (!head) { chapterReport = undefined; return; }
        if (chapterLogWrap.open) {
            const report = await readChapterLog(head.id);
            if (!isDebug()) return;
            chapterReport = report;
            if (chapterReport) $('chapterLogBody').textContent = chapterLogSummary(chapterReport);
        }
    } catch {
        if (!chapterLogWrap.hidden) $('chapterLogBody').textContent = 'Could not read the saved chapter log — try opening it again.';
    } finally { chapterLogBusy = false; }
}
chapterLogWrap.ontoggle = () => { if (chapterLogWrap.open) void refreshChapterLog(); };
chapterLogCopy.onclick = async () => {
    if (!isDebug() || !chapterHead) return;
    chapterLogCopy.disabled = true;
    try {
        const report = await readChapterLog(chapterHead.id);
        if (!isDebug()) return;
        if (!report) throw new Error('No saved chapter log');
        chapterReport = report;
        const text = formatChapterLog(report);
        try {
            await navigator.clipboard.writeText(text);
            if (!isDebug()) return;
            chapterLogText.hidden = true;
            $('chapterLogNote').textContent = 'Copied. Attach this log when reporting a problem.';
        } catch {
            if (!isDebug()) return;
            chapterLogText.value = text;
            chapterLogText.hidden = false;
            chapterLogText.focus(); chapterLogText.select();
            $('chapterLogNote').textContent = 'Select and copy the log below.';
        }
    } catch {
        $('chapterLogNote').textContent = 'Could not read the saved chapter log — try again.';
    } finally { chapterLogCopy.disabled = false; }
};

function renderTiming(report: PageTimingReport | null): void {
    if (!isDebug()) report = null;
    timingReport = report;
    timingWrap.style.display = report ? '' : 'none';
    if (!report) {
        timingWrap.open = false;
        timingText.hidden = true;
        timingText.value = '';
        $('timingBody').textContent = '';
        return;
    }
    const { meta } = report;
    const lines = [
        `${report.state === 'running' ? 'In progress' : report.state === 'failed' ? 'Stopped' : 'Finished'} · ${timingSeconds(report.elapsedMs)}`,
        `${meta.page ?? '?'} · ${meta.boxes ?? '?'} text regions · ${meta.cached ? 'saved page' : meta.textSource ?? '?'}`,
        `Build ${report.build}`,
    ];
    for (const [key, label] of Object.entries(TIMING_LABELS)) {
        const ms = report.ms[key as TimingName];
        if (ms != null) lines.push(`${label}: ${timingSeconds(ms)}`);
    }
    if (meta.apiMs != null) lines.push(`API calls: ${meta.calls ?? '?'} · ${timingSeconds(meta.apiMs)}`);
    if (meta.cloud?.total != null) lines.push(`Cloud server: ${timingSeconds(meta.cloud.total)}`);
    lines.push('Some timings overlap; they do not add up to the total.');
    $('timingBody').textContent = lines.join('\n');
}

timingCopy.onclick = async () => {
    if (!isDebug() || !timingReport) return;
    const text = formatPageTiming(timingReport);
    try {
        await navigator.clipboard.writeText(text);
        if (!isDebug()) return;
        $('timingNote').textContent = 'Copied. Attach this report when reporting a problem.';
        timingText.hidden = true;
    } catch {
        if (!isDebug()) return;
        timingText.value = text;
        timingText.hidden = false;
        timingText.focus();
        timingText.select();
        $('timingNote').textContent = 'Select and copy the report below.';
    }
};

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

// per-site auto: checkbox reflects the ACTIVE tab's site only
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
    siteEl.textContent = new URL(origin).host;
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

// poll auto-opens usage once data arrives — never re-opens after the user collapses
let usagePinned = false;
usageWrap.ontoggle = () => { if (!usageWrap.open) usagePinned = true; };
// status auto-opens like usage — but never re-opens after the user collapses it
let statusPinned = false;
statusSection.ontoggle = () => { if (!statusSection.open) statusPinned = true; };

// optimistic labels: handlers flip instantly instead of waiting for the 1s poll; the poll confirms.
let lastCtx = true, lastChars = false, lastOverlay = true, lastDir: 'rtl' | 'ltr' = 'rtl';
let sweepRunning = false; // mirrored from mt:status each poll — the button toggles start/cancel
let viewedAction: 'translate' | 'stop' = 'translate';
let statusRevision = 0;
let renderedStatusRevision = 0;

async function refreshStatus(): Promise<void> {
    await debugReady;
    const revision = ++statusRevision;
    const resp = await send({ type: 'mt:status' });
    if (revision < renderedStatusRevision) return;
    renderedStatusRevision = revision;
    if (resp?.ok) {
        renderTiming(resp.pageTiming ?? null);
        const counts = resp.translated && resp.loaded ? ` · ${resp.translated}/${resp.loaded} pages` : '';
        const raw = resp.status || (resp.translated ? `${resp.translated} ${resp.translated === 1 ? 'page' : 'pages'} translated` : '');
        // A finished page can fail to reach the reader; without this the button just looked
        // like "not translated" and pressing it re-paid the model. Name the refusal.
        const why = typeof resp.attachWhy === 'string' && resp.attachWhy ? ` · page not shown: ${resp.attachWhy}` : '';
        statusEl.textContent = (raw + counts + why) || (resp.loaded === 0 ? 'No manga images found on this page.' : '');
        // empty idle state shows no card at all — not an empty box with a dot
        statusSection.style.display = isDebug() && statusEl.textContent ? '' : 'none';
        if (statusEl.textContent && !statusSection.open && !statusPinned) statusSection.open = true;
        const isErr = raw.startsWith('Error');
        stateDot.style.background = isErr ? 'var(--err)' : resp.busy ? 'var(--accent)' : raw.startsWith('Done') ? 'var(--ok)' : 'var(--muted)';
        errBanner.style.display = isDebug() && isErr ? 'block' : 'none';
        if (isErr) errBanner.textContent = raw;
        const busy = !!resp.busy;
        // usage box (session totals + last page) — collapsed until data exists
        const u = resp.usage, lu = resp.lastUsage;
        const hasUsage = showUsage.checked && u && (u.pages > 0);
        usageWrap.style.display = hasUsage ? 'block' : 'none';
        if (hasUsage && !usageWrap.open && !usagePinned) usageWrap.open = true;
        if (hasUsage) {
            // DOM-built, never innerHTML: usage numbers are untrusted provider JSON (see num());
            // textContent kills any markup that slips through
            usageBox.replaceChildren();
            const row = (text: string, color?: string) => {
                const d = document.createElement('div');
                if (color) d.style.color = color;
                d.textContent = text;
                return d;
            };
            usageBox.append(row(`This session: ${u.pages} ${u.pages === 1 ? 'page' : 'pages'} · ${k(u.inTok)} input / ${k(u.outTok)} output`));
            if (u.cachedInTok > 0) usageBox.append(row(`Reused by provider: ${k(u.cachedInTok)} input tokens`, 'var(--ok)'));
            if (lu) usageBox.append(row(`Last page: ${k(lu.inTok)} input${lu.cachedInTok > 0 ? ` (${k(lu.cachedInTok)} reused)` : ''} / ${k(lu.outTok)} output${lu.ms ? ` · ${(lu.ms / 1000).toFixed(1)}s` : ''}`));
        }
        // main button reflects the VIEWED page: translate → cancel-queue → disabled-while-active
        btn.disabled = false;
        viewedAction = resp.viewedActive || resp.viewedQueued ? 'stop' : 'translate';
        if (resp.viewedActive) btn.textContent = 'Stop this page';
        else if (resp.viewedQueued) btn.textContent = 'Cancel this page';
        else btn.textContent = 'Translate this page';
        redoBtn.disabled = !!resp.viewedActive || !resp.viewedTranslated;
        $('autoPaused').hidden = !resp.autoPaused || !auto.checked;
        // cancel shows while queued OR any background engine runs — otherwise a pre-translate has no stop control
        const q = resp.queued ?? 0;
        const bgRunning = !!resp.lookaheadActive || !!(resp.sweep as { active: boolean } | null)?.active;
        cancelAllBtn.style.display = q > 0 || bgRunning || busy ? '' : 'none';
        cancelAllBtn.textContent = q > 0 ? `Stop all (${q} waiting)` : 'Stop all translations';
        origBtn.textContent = resp.overlayOn ? 'Show original' : 'Show translation';
        lastOverlay = resp.overlayOn;
        ctxBtn.textContent = `Context: ${resp.shareContext ? 'on' : 'off'}`;
        ctxBtn.setAttribute('aria-pressed', String(!!resp.shareContext));
        lastCtx = resp.shareContext;
        lastDir = resp.readingDir === 'ltr' ? 'ltr' : 'rtl';
        dirBtn.textContent = lastDir === 'rtl' ? 'Right to left' : 'Left to right';
        charsBtn.textContent = resp.charsOpen ? 'Hide characters' : 'Characters';
        lastChars = resp.charsOpen;
        // Chapter execution continues independently of reader navigation.
        const sw = resp.sweep as { active: boolean; canResume?: boolean; phase: 'starting' | 'running' | 'stopping' | 'dead'; stopping: boolean; done: number; total: number; errors: number; message?: string; diagnostics?: string } | null;
        const sweepInfo = $<HTMLElement>('sweepDetails');
        const sweepParts = isDebug() && sw ? [sw.errors > 0 ? `${sw.errors} failed` : '', sw.message ?? '', sw.diagnostics ?? ''].filter(Boolean) : [];
        if (sweepParts.length) {
            sweepInfo.style.display = '';
            sweepInfo.textContent = sweepParts.join(' · ');
        } else {
            sweepInfo.style.display = 'none';
            sweepInfo.textContent = '';
        }
        sweepRunning = !!sw?.active;
        sweepResumeBtn.hidden = !sw?.canResume || sweepRunning;
        sweepResumeBtn.disabled = sweepResumeBtn.hidden;
        sweepResumeBtn.textContent = 'Resume chapter translation';
        sweepResumeBtn.title = sw?.canResume ? `Continue where you stopped: ${sw.done} of ${sw.total} pages ready` : 'Continue the previous chapter translation';
        sweepBtn.title = sweepRunning ? 'Stop this chapter translation' : 'Translate from this page to the last page of the chapter';
        sweepWhy.hidden = true;
        if (sw?.stopping) {
            sweepBtn.textContent = `Stopping… (${sw.done}/${sw.total})`;
            sweepBtn.disabled = true;
        } else if (sw?.phase === 'starting') {
            sweepBtn.textContent = 'Cancel start';
            sweepBtn.disabled = false;
        } else if (sw?.phase === 'dead') {
            sweepBtn.textContent = 'Closing previous translation…';
            sweepBtn.disabled = true;
        } else if (sw?.active) {
            sweepBtn.textContent = `Stop chapter (${sw.done}/${sw.total} ready)`;
            sweepBtn.disabled = false;
        } else {
            const sc = await send({ type: 'mt:sweep-count' }) as { ok?: boolean; count?: number; reason?: string } | null;
            if (revision !== renderedStatusRevision) return;
            const n = sc?.count ?? 0;
            const why = sc?.ok ? sweepCountMessage(sc.reason as SweepCountReason) : '';
            if (n > 0) {
                sweepBtn.textContent = `Translate to chapter end (${n} ${n === 1 ? 'page' : 'pages'})`;
                sweepBtn.disabled = false;
                sweepWhy.hidden = true;
            } else if (why) {
                // The reason beats a disabled button: "unsupported site" and "last page"
                // looked identical before.
                sweepBtn.textContent = 'Translate to chapter end';
                sweepBtn.disabled = false;
                sweepWhy.textContent = why;
                sweepWhy.hidden = false;
            } else {
                sweepBtn.textContent = 'Translate to chapter end';
                sweepBtn.disabled = false;
                sweepWhy.hidden = true;
            }
        }
        // translation cache size (separate message — IDB read, not part of mt:status)
        const cc = await send({ type: 'mt:cache-count' });
        if (revision !== renderedStatusRevision) return;
        cacheLabel.textContent = cc?.ok ? `${cc.mine ?? cc.count} on this site · ${cc.count} total` : '';
    } else {
        renderTiming(null);
        statusEl.textContent = 'Open a manga page to translate.';
        btn.disabled = redoBtn.disabled = true;
        sweepBtn.disabled = true;
        sweepResumeBtn.hidden = true;
    }
}
refreshStatus();
const poll = setInterval(refreshStatus, 1000);
void refreshChapterLog();
const chapterPoll = setInterval(() => void refreshChapterLog(), 2000);
window.addEventListener('unload', () => { clearInterval(poll); clearInterval(chapterPoll); });

btn.onclick = async () => {
    btn.disabled = true;
    const resp = await send({ type: viewedAction === 'stop' ? 'mt:stop-page' : 'mt:translate-image' });
    await refreshStatus();
    if (resp?.stopped) { statusEl.textContent = 'Page translation stopped.'; return; }
    if (resp?.already) { statusEl.textContent = 'This page is already translated.'; return; }
    if (resp?.cancelled) { statusEl.textContent = typeof resp?.count === 'number' ? `Cancelled ${resp.count} waiting pages.` : 'Page cancelled.'; return; }
    if (resp?.active) { statusEl.textContent = 'Adding translated text to this page…'; return; }
    statusEl.textContent = resp?.ok
        ? (typeof resp?.count === 'number' && resp.count > 1 ? `Queued ${resp.count} pages…` : 'Queued…')
        : (resp?.error ?? 'Could not start translation. Try again.');
};

cancelAllBtn.onclick = async () => {
    statusEl.textContent = 'Cancelling…';
    await send({ type: 'mt:cancel-all' });
    refreshStatus();
};

sweepBtn.onclick = async () => {
    if (sweepRunning) {
        statusEl.textContent = 'Stopping chapter translation…';
        await send({ type: 'mt:sweep-cancel' });
    } else {
        sweepResumeBtn.hidden = true;
        statusEl.textContent = 'Preparing chapter translation…';
        const resp = await send({ type: 'mt:sweep-start' }) as { ok?: boolean; total?: number; error?: string; starting?: boolean; cancelled?: boolean } | null;
        statusEl.textContent = resp?.cancelled ? 'Chapter translation cancelled.' : resp?.starting ? 'Preparing chapter translation…'
            : resp?.ok ? `Translating ${resp.total ?? 0} remaining pages…` : (resp?.error ?? 'Could not start chapter translation');
    }
    refreshStatus();
};
sweepResumeBtn.onclick = async () => {
    sweepResumeBtn.disabled = true;
    statusEl.textContent = 'Resuming previous chapter translation…';
    const resp = await send({ type: 'mt:sweep-resume' });
    await refreshStatus();
    if (!resp?.ok) statusEl.textContent = resp?.error ?? 'Could not resume chapter translation';
};
$('resumeAuto').onclick = async () => {
    await send({ type: 'mt:auto-resume' });
    await refreshStatus();
};
// pages-ahead: persisted to mtPipeline; content picks it up live via the storage listener (no message).
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
    else if (!resp?.ok) statusEl.textContent = 'Could not re-translate this page. Try again.';
};
origBtn.onclick = async () => {
    lastOverlay = !lastOverlay;
    origBtn.textContent = lastOverlay ? 'Show original' : 'Show translation';
    await send({ type: 'mt:toggle-original' });
    refreshStatus();
};
ctxBtn.onclick = async () => {
    lastCtx = !lastCtx;
    ctxBtn.textContent = `Context: ${lastCtx ? 'on' : 'off'}`;
    ctxBtn.setAttribute('aria-pressed', String(lastCtx));
    await send({ type: 'mt:toggle-context' });
    refreshStatus();
};
cacheClearBtn.onclick = async () => {
    cacheClearBtn.disabled = true;
    cacheClearBtn.textContent = 'Clearing…';
    const resp = await send({ type: 'mt:cache-clear' });
    if (resp?.ok) cacheLabel.textContent = `${resp.mine ?? resp.count} on this site · ${resp.count} total`;
    else statusEl.textContent = resp?.error ?? 'Could not clear translations';
    cacheClearBtn.textContent = 'Clear';
    cacheClearBtn.disabled = false;
};
dirBtn.onclick = async () => {
    lastDir = lastDir === 'rtl' ? 'ltr' : 'rtl';
    dirBtn.textContent = lastDir === 'rtl' ? 'Right to left' : 'Left to right';
    await send({ type: 'mt:toggle-reading-dir' });
    await refreshStatus();
    // survives until the next 1s poll — same flash-hint pattern as Queued…
    statusEl.textContent = 'Reading order changed. Re-translate the page to apply.';
};
charsBtn.onclick = async () => {
    lastChars = !lastChars;
    charsBtn.textContent = lastChars ? 'Hide characters' : 'Characters';
    await send({ type: 'mt:toggle-chars' });
    refreshStatus();
};

auto.onchange = async () => {
    // content owns the loop; storage.local is shared. Per-site: checkbox edits the ACTIVE tab's origin only.
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
    if (!isDebug()) return;
    errlogOpen = !errlogOpen;
    errlogEl.style.display = errlogOpen ? 'block' : 'none';
    if (!errlogOpen) return;
    const { mtErrLog } = await sessGet('mtErrLog');
    if (!isDebug()) return;
    const log = (mtErrLog as { t: number; msg: string; hint?: string }[] | undefined) ?? [];
    errlogEl.textContent = log.length
        ? log.map(l => `${new Date(l.t).toLocaleTimeString()} — ${l.msg}${l.hint ? `\n  ↳ ${l.hint}` : ''}`).join('\n')
        : 'No errors logged.';
};
async function refreshErrors(): Promise<void> {
    await debugReady;
    if (!isDebug()) { errlogOpen = false; return; }
    const v = await sessGet('mtErrLog');
    if (!isDebug()) return;
    const log = (v as { mtErrLog?: { t: number }[] }).mtErrLog;
    errorsLink.textContent = log?.length ? `Recent errors (${log.length})` : '';
}
void refreshErrors();

$('settings').onclick = () => chrome.runtime.openOptionsPage();

// first-run data-use disclosure — shown until acknowledged (store disclosure requirement).
chrome.storage.local.get('mtPrivacyAck').then(v => {
    if (!(v as { mtPrivacyAck?: boolean }).mtPrivacyAck) $('privacyNote').style.display = 'block';
});
$('privacyAck').onclick = async () => {
    await chrome.storage.local.set({ mtPrivacyAck: true });
    $('privacyNote').style.display = 'none';
};
