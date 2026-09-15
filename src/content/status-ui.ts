// Status pill (view of the activity registry), toasts, error log.
// Cross-imports with queue.ts are function-level only — no TDZ.

import { pickActivity, cooldownParked } from './page-cache';
import type { MtStage } from './detection';
import { initDebug, isDebug } from '../debug';
import { pipeline, ui, mtPal, mtDot, stateFor, setDebugOn, type MtState } from './state';
import { getPages } from './page-io';
import { queue, failMarks, activeKeyGet, activeRefGet, pageKeyOf, viewportOverlap, paintFind, paintHas, paintQueued, autoHalted } from './queue';
import { ensureDebugViews } from './ocr';
import { applyOverlays } from './overlays';

// ---- status ownership: one pill, many writers ----
// Parallel jobs, fire-and-forget preps and lookahead all used to write the
// pill directly — whoever wrote last won, so progress jumped between pages
// mid-run ("LLM 3s" A → "OCR 4/8" B → …). Now the pill is a VIEW:
//  - activities: live jobs keyed by page, each with a kind for priority
//    (force > most-visible > background sweep/lookahead — the user reads the
//    page they're looking at, not FIFO). Stale writes from dropped jobs are
//    ignored.
//  - lastMsg: the most recent settled job (Done/Error) — lingers like the
//    old single-job behavior until the next job replaces it.
//  - override: one-shot user feedback (click acks), wins briefly over
//    running jobs so a click response is never eaten by background work.
export interface Activity { text: string; kind: 'force' | 'view' | 'lookahead' | 'sweep'; stage?: MtStage }
const activities = new Map<string, Activity>();
let lastMsg: { text: string; phase: MtState; until?: number } | null = null;
let overrideMsg: { text: string; phase: MtState; until: number } | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;
let pillDismissed = false; // user closed the pill — stay hidden until the next job

export function pillUnDismiss(): void { pillDismissed = false; }

// a job's status is only valid while it is queued, painting, or running —
// dropped preps (dequeue/cancel/twin-splice) keep resolving and would
// otherwise resurrect as ghost pill entries
function jobLive(key: string): boolean {
    return key === activeKeyGet() || queue.some(j => j.key === key) || paintHas(key);
}
export function setActivity(key: string, text: string, kind: Activity['kind'], stage: MtStage | undefined): void {
    // background work (lookahead, sweep) owns no queue entry — exempt from
    // the liveness gate like lookahead always was
    if (kind !== 'lookahead' && kind !== 'sweep' && !jobLive(key)) return;
    activities.set(key, { text, kind, stage });
    renderStatus();
}
export function removeActivity(key: string): void {
    activities.delete(key);
    renderStatus();
}
export function lastMsgSet(m: { text: string; phase: MtState; until?: number } | null): void {
    lastMsg = m;
}

// page-count status for the pill/popup: how many of the reader's currently
// loaded pages have translations, and whether the viewed page is queued
export function pageCounts(): { loaded: number; translated: number; queued: number } {
    const refs = getPages();
    let translated = 0;
    for (const ref of refs) if (stateFor(ref)?.det) translated++;
    return { loaded: refs.length, translated, queued: queue.length + paintQueued() };
}

export function idleStatus(): string {
    // a provider halt outranks the counts: nothing else will run until the user
    // acts, and that is the one thing the pill should be saying (see haltAuto)
    const halted = autoHalted();
    if (halted) {
        if (halted.kind !== 'ratelimit') return 'Auth/quota error — fix the key, then press Translate';
        const left = halted.until > Date.now() ? ` (${Math.ceil((halted.until - Date.now()) / 1000)}s)` : '';
        return `Rate limited${left} — stopped; press Translate to resume`;
    }
    const { loaded, translated, queued } = pageCounts();
    // pages parked after errors — shown only while auto is on (the mode that
    // would otherwise retry them silently). Counts loaded pages only.
    let parked = 0;
    if (autoTranslateFlag()) {
        const now = Date.now();
        const loadedKeys = new Set(getPages().map(pageKeyOf));
        for (const k of failMarks.keys()) if (loadedKeys.has(k) && cooldownParked(failMarks, k, now)) parked++;
    }
    const pause = parked ? ` · ${parked} paused after errors` : '';
    // complete and quiet → empty: a "1/1 pages" pill says nothing the user
    // can't already see (the page in front of them is translated). The counts
    // only earn the pixels when work remains (partial progress / queue / parks)
    if (translated >= loaded && !queued && !parked) return '';
    if (!translated) return parked ? `${parked} paused after errors` : '';
    return (queued ? `${translated}/${loaded} pages · ${queued} queued` : `${translated}/${loaded} pages`) + pause;
}

// stage stepper: 5 dots (read → detect → ocr → llm → render), done stages
// lit, current one accent, unrun ones gray. Hidden outside busy-with-stage.
function renderSteps(stage: MtStage | undefined): void {
    const el = ui?.querySelector('#mt-ui-steps') as HTMLElement | null;
    if (!el) return;
    if (!stage) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    const order: MtStage[] = ['read', 'detect', 'ocr', 'llm', 'render'];
    const cur = order.indexOf(stage);
    el.querySelectorAll('span').forEach((d, i) => {
        (d as HTMLElement).style.background =
            i < cur ? mtPal.ok : i === cur ? mtPal.accent : mtPal.border;
    });
}

export function renderStatus(): void {
    if (!ui) return;
    const now = Date.now();
    if (overrideMsg && overrideMsg.until < now) overrideMsg = null;
    if (lastMsg?.until && lastMsg.until < now) lastMsg = null;
    const list = [...activities.entries()].map(([key, a]) => ({
        key, text: a.text, kind: a.kind, stage: a.stage,
        overlap: a.kind === 'lookahead' ? 0 : viewportOverlapByKey(key),
    }));
    const primary: (typeof list)[number] | null = pickActivity(list);
    let text: string, phase: MtState, stage: MtStage | undefined;
    if (overrideMsg) { ({ text } = overrideMsg); phase = overrideMsg.phase; }
    else if (primary) { text = primary.text; phase = 'busy'; stage = primary.stage; }
    else if (lastMsg) { ({ text } = lastMsg); phase = lastMsg.phase; }
    else { text = idleStatus(); phase = 'idle'; }
    // the work the pill is NOT showing: other running jobs + waiting queue
    const parts: string[] = [];
    if (primary && list.length > 1) parts.push(`+${list.length - 1} running`);
    if (queue.length) parts.push(`${queue.length} queued`);
    if (primary && parts.length) text += ` · ${parts.join(' · ')}`;
    const el = ui.querySelector('#mt-ui-text') as HTMLElement ?? ui.querySelector('span') as HTMLElement;
    el.textContent = text;
    el.title = text; // hover shows what line-clamp cuts
    (ui.querySelector('#mt-ui-dot') as HTMLElement | null)?.style.setProperty('background', mtDot(phase));
    renderSteps(phase === 'busy' ? stage : undefined);
    // progress from translated/loaded counts — same numbers the popup shows
    const bar = ui.querySelector('#mt-ui-bar') as HTMLElement | null;
    const fill = ui.querySelector('#mt-ui-fill') as HTMLElement | null;
    if (bar && fill) {
        const { loaded, translated } = pageCounts();
        if (loaded > 0 && (phase === 'busy' || (phase === 'idle' && translated > 0))) {
            bar.style.display = 'block';
            fill.style.width = `${Math.min(100, Math.round(translated / loaded * 100))}%`;
            fill.style.background = phase === 'busy' ? mtPal.accent : mtDot(phase);
        } else bar.style.display = 'none';
    }
    // empty status = idle → keep the pill up with the page count instead of
    // hiding it (readers want to know which pages are done)
    const show = (text || idleStatus()) && !pillDismissed;
    ui.style.display = show ? 'block' : 'none';
}

// viewport overlap for an activity key: resolve the queued/active/painting
// job's element (the queue holds the ref); 0 when it can't be found (dropped)
function viewportOverlapByKey(key: string): number {
    if (key === activeKeyGet() && activeRefGet()) return viewportOverlap(activeRefGet()!);
    const j = queue.find(j => j.key === key) ?? paintFind(key);
    return j ? viewportOverlap(j.ref) : 0;
}

// instant pill message (click acks, cancellations): overrides running jobs
// briefly; empty string clears everything (the dismiss × uses this)
export function setStatus(s: string, phase: MtState = 'idle', ms = 2500): void {
    if (!s) { overrideMsg = null; lastMsg = null; }
    else overrideMsg = { text: s, phase, until: Date.now() + ms };
    if (statusTimer) clearTimeout(statusTimer);
    if (s) statusTimer = setTimeout(renderStatus, ms + 50);
    renderStatus();
}

// ---- toasts + error log ----

// Toasts carry what the status pill can't: transient, stackable, VISIBLE.
// Errors especially — one long job overwrites the pill instantly, so without
// a toast a failed page is invisible unless DevTools is open.
export function makeToast(msg: string, kind: 'error' | 'ok', hint?: string): void {
    if (!pipeline.showToasts) return; // user-deafened: pill + popup log still report
    const host = document.getElementById('mt-toasts');
    const t = document.createElement('div');
    t.style.cssText = `position:relative;background:${mtPal.bg};color:${mtPal.text};padding:10px 30px 10px 14px;border:1px solid ${mtPal.border};border-left:3px solid ${kind === 'error' ? mtPal.err : mtPal.ok};border-radius:10px;font:13px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.5);max-width:340px;margin-top:8px;cursor:default`;
    t.textContent = msg;
    if (hint) {
        const h = document.createElement('div');
        h.style.cssText = `color:${mtPal.muted};font-size:12px;margin-top:4px`;
        h.textContent = hint;
        t.append(h);
    }
    const x = document.createElement('span');
    x.textContent = '×';
    x.style.cssText = 'position:absolute;top:6px;right:10px;cursor:pointer;opacity:.7';
    x.onclick = () => t.remove();
    t.append(x);
    (host ?? (() => {
        const h = document.createElement('div');
        h.id = 'mt-toasts';
        h.style.cssText = 'position:fixed;top:16px;right:16px;z-index:100000';
        document.body.append(h);
        return h;
    })()).append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 10000 : 5000);
}

interface ErrLogEntry { t: number; msg: string; hint?: string; kind?: string }

// last 20 errors, readable from the popup long after the toast faded
export async function logError(msg: string, hint?: string, kind?: string): Promise<void> {
    const { sessGet, sessSet } = await import('../storage-session');
    const { mtErrLog } = await sessGet('mtErrLog');
    const log = (mtErrLog as ErrLogEntry[] | undefined) ?? [];
    log.unshift({ t: Date.now(), msg, hint, kind });
    await sessSet({ mtErrLog: log.slice(0, 20) });
}

// Minimal status pill (all controls live in the action popup). Hidden until
// the first status; keeps id `#mt-ui` + span so the eval harnesses can wait
// on Done/Error text even while the pill is invisible.
export function makePill(): HTMLDivElement {
    const div = document.createElement('div');
    div.id = 'mt-ui';
    div.style.cssText = `position:fixed;bottom:16px;right:16px;z-index:99999;background:${mtPal.bg};color:${mtPal.text};padding:10px 28px 10px 14px;border:1px solid ${mtPal.border};border-radius:12px;font:13px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.4);display:none;width:340px`;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px';
    const dot = document.createElement('span');
    dot.id = 'mt-ui-dot';
    dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${mtPal.muted};flex:none`;
    const status = document.createElement('span');
    status.id = 'mt-ui-text';
    status.style.cssText = 'flex:1;min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical';
    status.textContent = '';
    row.append(dot, status);
    const steps = document.createElement('div');
    steps.id = 'mt-ui-steps';
    steps.style.cssText = 'display:none;gap:5px;margin-top:7px;align-items:center';
    for (let i = 0; i < 5; i++) {
        const d = document.createElement('span');
        d.style.cssText = `width:22px;height:3px;border-radius:2px;background:${mtPal.border}`;
        steps.append(d);
    }
    const bar = document.createElement('div');
    bar.id = 'mt-ui-bar';
    bar.style.cssText = `height:3px;border-radius:2px;background:rgba(255,255,255,.08);margin-top:8px;display:none`;
    const fill = document.createElement('div');
    fill.id = 'mt-ui-fill';
    fill.style.cssText = `height:100%;width:0;border-radius:2px;background:${mtPal.accent};transition:width .2s`;
    bar.append(fill);
    div.append(row, steps, bar);
    // closable: an error pill would otherwise stick forever (no auto-dismiss)
    const x = document.createElement('span');
    x.textContent = '×';
    x.style.cssText = 'position:absolute;top:6px;right:8px;cursor:pointer;opacity:.7';
    x.onclick = () => { pillDismissed = true; setStatus('', 'idle'); };
    div.append(x);
    return div;
}

// debug flag loading lives here (theme application touches the pill)
export async function loadDebug(): Promise<void> {
    await initDebug(v => {
        setDebugOn(v);
        if (v) ensureDebugViews().then(applyOverlays);
        else applyOverlays();
    });
    setDebugOn(isDebug());
}

// auto-translate flag accessor (auto.ts owns the flag; late import avoids a cycle)
let autoTranslateFlagFn: (() => boolean) | null = null;
export function registerAutoTranslateFlag(fn: () => boolean): void { autoTranslateFlagFn = fn; }
function autoTranslateFlag(): boolean { return autoTranslateFlagFn?.() ?? false; }
// readers (sweep status): no new module edges — auto registers here already
export function autoTranslateOn(): boolean { return autoTranslateFlag(); }
