import { configureChapterHost, loadPipeline, setShareContext } from '../content/state';
import { fetchBitmap, unscrambleTiles } from '../content/page-io';
import { resolveHeadlessDet, detFromCacheEntry } from '../content/pipeline';
import { translateRegions, abortLiveRpcs } from '../content/ocr';
import { renderPage } from '../content/render-page';
import { cacheGet, cachePut, cacheKey, settingsFingerprint, pageHashFromBitmap, packMask, isResumable, detFromPartial } from '../content/page-cache';
import { RENDER_GEN } from '../content/render';
import { keepaliveOpen } from '../content/queue';
import { chapterMessage, providerMessage, type ChapterPage, type ChapterProgress, type Contribution } from './model';
import { readRecord, writeRecord } from './store';
import { artifactKey, type HostConfig, type HostCheckpoint, type ChapterArtifact } from './protocol';
import type { ContextState } from '../llm/core';
import { Attempt } from './lifecycle';
import { nextDocument, documentImages, sameChapterDocument } from './discovery';
import { nextBatch, pagePhase } from './plan';

let id = '';
// Bounded breadcrumb for debugging a stalled run.
const diagnostics: string[] = [];
(globalThis as unknown as { __mtLog: string[] }).__mtLog = diagnostics;
const note = (m: string): void => {
    diagnostics.push(m);
    if (diagnostics.length > 200) diagnostics.shift();
};
let config: HostConfig;
let status: ChapterProgress;
let epoch = 0;
let pumping = false;
let priority = '';
let publishChain: Promise<unknown> = Promise.resolve();
const pendingForce = new Set<string>();
const attempts = new Set<Attempt>();
const visitedDocuments = new Set<string>();

async function discover(generation: number): Promise<boolean> {
    const url = config.nextDocument;
    if (!url || !config.imageSelector) return false;
    if (visitedDocuments.has(url)) throw new Error('Reader pagination repeats a page');
    if (!sameChapterDocument(url, config.readerUrl, config.chapter)) return false;
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Could not load the next reader page (HTTP ${response.status})`);
    if (!sameChapterDocument(response.url, config.readerUrl, config.chapter)) throw new Error('Reader redirected outside this chapter');
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    if (generation !== epoch) return false;
    const images = documentImages(doc, response.url, config.imageSelector);
    if (!images.length) throw new Error('The next page needs the reader to load its images');
    visitedDocuments.add(url);
    let order = Math.max(...config.pages.map(p => p.order)) + 1;
    for (const image of images) {
        if (config.pages.some(p => p.url === image)) continue;
        const page = { id: `url:${image}`, url: image, order: order++, descramble: false };
        config.pages.push(page);
        status.pages.push({ id: page.id, url: page.url, phase: 'queued' });
    }
    config.nextDocument = nextDocument(doc, response.url, config.chapter);
    config.completeManifest = !config.nextDocument;
    status.completeManifest = config.completeManifest;
    status.total = config.pages.length;
    await publish();
    return true;
}

function signature(): string { return JSON.stringify(config.pipeline) + ':' + RENDER_GEN; }
// The runner module is also bundled into Chromium's service worker (the broker imports the
// boot helper), where there is no document at all. Every DOM touch must go through here.
function statusElement(): HTMLElement | null {
    return typeof document === 'undefined' ? null : document.querySelector('#status');
}
function publish(): Promise<void> {
    status.done = status.pages.filter(p => p.phase === 'ready').length;
    status.errors = status.pages.filter(p => p.phase === 'failed').length;
    status.inflight = status.pages.filter(p => ['reading', 'detecting', 'translating', 'rendering'].includes(p.phase)).length;
    const statusEl = statusElement();
    if (statusEl) statusEl.textContent = chapterMessage(status);
    const snapshot = structuredClone(status);
    const checkpoint: HostCheckpoint = { config: structuredClone(config), progress: snapshot };
    const next = publishChain.then(async () => {
        await writeRecord(`checkpoint:${id}`, checkpoint);
        const r = await chrome.runtime.sendMessage({ type: 'mt:chapter-publish', id, status: snapshot });
        if (!r?.ok) throw new Error(r?.error || 'Could not save chapter progress');
    });
    publishChain = next.catch(() => {});
    return next;
}
function stop(message?: string): void {
    epoch++;
    for (const attempt of attempts) attempt.cancel();
    abortLiveRpcs();
    status.phase = message ? 'error' : pumping ? 'stopping' : 'stopped';
    status.message = message;
    void publish().catch(showFatal);
}
function showFatal(e: unknown): void {
    const msg = `Translation paused — ${(e as Error).message || String(e)}`;
    const el = statusElement();
    if (el) el.textContent = msg;
    console.error('[mt] chapter runner', e);
    // Persist the reason: an offscreen document has no console a user can open, so a crash
    // would otherwise be invisible and the reader would only see "no chapter session".
    if (id) void writeRecord(`error:${id}`, { message: msg, stack: (e as Error)?.stack ?? '' }).catch(() => {});
}
async function contextFor(entries?: Contribution[], beforeOrder?: number): Promise<ContextState> {
    if (!config.shareContext) return { pairs: [], characters: [] };
    const r = await chrome.runtime.sendMessage({ type: 'mt:chapter-context', id, entries, beforeOrder });
    if (!r?.ok) throw new Error(r?.error || 'Could not update character context');
    return r.context;
}
async function source(page: ChapterPage): Promise<ImageBitmap> {
    if (page.source) return createImageBitmap(await (await fetch(page.source)).blob());
    if (/^https?:/.test(page.url)) {
        const f = await fetchBitmap(page.url);
        if (!page.descramble) return f.bitmap;
        try {
            const fixed = await unscrambleTiles(f.bitmap);
            if (fixed) { f.bitmap.close(); return fixed.bitmap; }
            return f.bitmap;
        } catch (e) { f.bitmap.close(); throw e; }
    }
    const r = await chrome.tabs.sendMessage(config.readerTab, { type: 'mt:chapter-source', chapter: config.chapter, page });
    if (!r?.source) throw Object.assign(new Error('Waiting for this page image'), { kind: 'source' });
    return createImageBitmap(await (await fetch(r.source)).blob());
}
async function work(page: ChapterPage, snapshot: ContextState, generation: number, live: () => boolean): Promise<Contribution | null> {
    const item = status.pages.find(p => p.id === page.id)!;
    const valid = () => generation === epoch && live();
    const stage = (phase: typeof item.phase) => { if (valid()) { item.phase = phase; void publish().catch(showFatal); } };
    let bitmap: ImageBitmap | undefined;
    try {
        stage('reading');
        const previous = await readRecord<ChapterArtifact>(artifactKey(id, page.id));
        const force = config.force?.has(page.id) === true;
        if (!valid()) return null;
        if (!force && previous && previous.signature === signature()) {
            const hash = previous.entry.key.slice(previous.entry.key.lastIndexOf('#') + 1);
            item.hash = hash;
            const contribution = { id: page.id, order: page.order, hash, outputs: previous.entry.outputs, mentions: previous.entry.mentions ?? [] };
            if (!page.inBaseContext) await contextFor([contribution]);
            if (!valid()) return null;
            item.phase = 'ready';
            await publish();
            return contribution;
        }
        bitmap = await source(page).catch(e => { note(`source p${page.order} ${(e as Error).message}`); throw e; });
        if (!valid()) return null;
        const hash = pageHashFromBitmap(bitmap);
        item.hash = hash;
        if (bitmap.width < 400 || bitmap.height < 300) throw new Error('Image is too small to be a manga page');
        const key = cacheKey(config.chapter, hash);
        stage('detecting');
        if (force) {
            // Retranslation is "the same page again": fresh detection and a fresh answer, but
            // overlapping pages keep their contributions so the book stays in reading order.
            const { cacheDelete } = await import('../content/page-cache');
            await cacheDelete(key);
        }
        let resolved;
        try {
            // Resume first: when detection already ran and the OCR checkpoint landed, coming
            // back through /v1/page would re-pay detect and re-OCR, and the fresh call would
            // send empty sources. A resumed detect carries the paid texts in cloudTexts.
            const hit = await cacheGet(key);
            if (!force && isResumable(hit, settingsFingerprint(config.pipeline), bitmap.width, bitmap.height, config.pipeline.inferEngine === 'cloud')) {
                resolved = { det: detFromPartial(hit!, bitmap.width, bitmap.height), resumed: true };
            } else {
                resolved = await resolveHeadlessDet(bitmap, hash, () => {});
            }
        } catch (e) {
            note(`detect p${page.order} ${(e as Error).message}`.slice(0, 160));
            throw e;
        }
        if (!valid()) return null;
        const cached = !resolved.det ? await cacheGet(key) : undefined;
        const boxes = resolved.det?.boxes.length ?? cached?.boxes.length ?? 0;
        // A page with no detected text has nothing to translate or paint; do not cache or fold it.
        if (!boxes) {
            item.phase = 'ready';
            item.revision = (item.revision ?? 0) + 1;
            await publish();
            return null;
        }
        const det = resolved.det ?? (cached && detFromCacheEntry(cached, bitmap.width, bitmap.height));
        if (!det) throw new Error('Saved page data is incomplete');
        stage('translating');
        let out;
        try {
            out = cached ?? await translateRegions(bitmap, det, () => {}, { fold: false, lo: true, context: snapshot });
        } catch (e) {
            note(`llm p${page.order} ${(e as Error).message}`.slice(0, 200));
            throw e;
        }
        if ('error' in out && out.error) throw Object.assign(new Error(out.error), { kind: out.errorKind });
        if (!valid()) return null;
        stage('rendering');
        const rendered = await renderPage({ kind: 'img', el: document.createElement('img') },
            { srcUrl: page.url, bitmap, det, hash, cached: { outputs: out.outputs, extras: out.extras, mentions: out.mentions } },
            () => {}, false, { paintOnly: true, detached: true });
        let blob: Blob;
        try { blob = await (await fetch(rendered.translated)).blob(); }
        finally { URL.revokeObjectURL(rendered.translated); }
        if (!valid()) return null;
        const entry: ChapterArtifact['entry'] = { key, fp: settingsFingerprint(config.pipeline),
            w: bitmap.width, h: bitmap.height, boxes: det.boxes, panels: det.panels ?? [],
            outputs: out.outputs, extras: out.extras, mentions: out.mentions,
            mask: packMask(det.mask), splitGen: det.splitGen ?? 0, ep: det.ep };
        await writeRecord(artifactKey(id, page.id), { blob, entry, at: Date.now(), signature: signature() } satisfies ChapterArtifact);
        if (!valid()) return null;
        if (config.pipeline.cacheEnabled) await cachePut(entry, config.pipeline.cacheMax);
        const contribution = { id: page.id, order: page.order, hash, outputs: out.outputs, mentions: out.mentions ?? [] };
        await contextFor([contribution]);
        if (!valid()) return null;
        item.revision = (item.revision ?? 0) + 1;
        item.phase = 'ready';
        await publish();
        return contribution;
    } catch (e) {
        note(`work p${page.order} FAIL ${(e as Error).name}: ${(e as Error).message}`.slice(0, 200));
        if (!valid()) return null;
        const err = e as Error & { kind?: string };
        // A page that already reached 'ready' in this run is done; a late publish failure must
        // not demote it and re-queue an infinite retry.
        if (item.phase !== 'ready') item.phase = err.kind === 'source' ? 'waiting' : 'failed';
        console.warn('[mt] chapter page failed', page.order, err);
        if (err.kind === 'ratelimit' || err.kind === 'auth') {
            status.message = providerMessage(err.kind);
            status.phase = 'error';
        }
        await publish();
        return null;
    } finally { bitmap?.close(); }
}
function pumpCheck(): void {
    if (!pumping) void pump();
}
// pumpCheck is the only re-entry: pump() must never call itself while `pumping` is true.

async function pump(): Promise<void> {
    if (pumping || !['running', 'waiting'].includes(status.phase)) return;
    pumping = true;
    const generation = epoch;
    const release = keepaliveOpen();
    try {
        for (;;) {
            if (generation !== epoch || status.phase !== 'running') break;
            const batch = nextBatch(status.pages.map(p => pagePhase(p.phase)), config.pages,
                { perBatch: config.pipeline.parallelLlm || 3, priority });
            if (!batch.length) {
                // A page still waiting for its pixels ends the run; discovery may append more.
                if (await discover(generation)) continue;
                break;
            }
            // A bounded batch shares an immutable context. Only its ordered reducer writes the book.
            const snapshot = await contextFor(undefined, Math.min(...batch.map(p => p.order)));
            if (generation !== epoch) break;
            await Promise.all(batch.map(p => {
                const attempt = new Attempt(300_000, () => {
                    status.pages.find(s => s.id === p.id)!.phase = 'failed';
                    stop('Translation paused — a page took too long; start again to continue');
                });
                attempts.add(attempt);
                const task = work(p, structuredClone(snapshot), generation, () => attempt.valid());
                return Promise.race([task, attempt.cancelled]).finally(() => { attempt.finish(); attempts.delete(attempt); });
            }));
        }
        if (generation !== epoch) {
            for (const p of status.pages) if (['reading', 'detecting', 'translating', 'rendering'].includes(p.phase)) p.phase = 'queued';
            if (status.phase === 'stopping') status.phase = 'stopped';
        } else if (status.phase === 'running') {
            status.phase = config.completeManifest && !status.pages.some(p => p.phase === 'waiting') ? 'complete' : 'waiting';
        }
        await publish();
    } catch (e) { stop('Translation paused — could not save chapter progress'); showFatal(e); }
    finally { pumping = false; release(); if (status.phase === 'running') void pump(); }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id || msg?.type !== 'mt:chapter-command' || msg.id !== id || !status) return;
    if (msg.command === 'stop') stop();
    if (msg.command === 'prioritize' || msg.command === 'retry') {
        priority = String(msg.page);
        if (msg.command === 'retry') {
            const page = status.pages.find(p => p.id === priority);
            if (page) {
                config.force ??= new Set();
                config.force.add(page.id);
                // A page already in flight is superseded, not duplicated.
                for (const p of status.pages) if (['reading', 'detecting', 'translating', 'rendering'].includes(p.phase)) p.phase = 'queued';
                if (['reading', 'detecting', 'translating', 'rendering'].includes(page.phase)) epoch++;
                else page.phase = 'queued';
                status.phase = 'running';
                status.message = undefined;
            }
        }
    }
    if (msg.command === 'append' && Array.isArray(msg.pages)) {
        for (const p of msg.pages as ChapterPage[]) {
            if (!config.pages.some(old => old.id === p.id)) {
                config.pages.push(p);
                status.pages.push({ id: p.id, url: p.url, phase: 'queued' });
            } else {
                const old = config.pages.find(old => old.id === p.id)!;
                if (p.source) old.source = p.source;
                const state = status.pages.find(s => s.id === p.id)!;
                if (state.phase === 'waiting') state.phase = 'queued';
            }
        }
        config.completeManifest ||= msg.completeManifest === true;
        status.completeManifest = config.completeManifest;
        status.total = config.pages.length;
        if (status.phase === 'waiting') status.phase = 'running';
    }
    void publish().then(() => pumpCheck()).catch(showFatal);
    respond({ ok: true });
});

async function attach(runnerId: string): Promise<void> {
    id = runnerId;
    const response = await chrome.runtime.sendMessage({ type: 'mt:chapter-host-init', id });
    if (!response?.ok) throw new Error(response?.error || 'Chapter session expired');
    config = response.config;
    // Load custom fonts before pinning the execution session's settings.
    await loadPipeline();
    configureChapterHost(config.chapter, config.bookKey, config.pipeline, config.context);
    setShareContext(config.shareContext);
    const checkpoint = await readRecord<HostCheckpoint>(`checkpoint:${id}`);
    if (checkpoint) config = { ...config, ...checkpoint.config };
    status = checkpoint?.progress ?? { id, chapter: config.chapter, phase: 'running', done: 0, total: config.pages.length,
        inflight: 0, errors: 0, completeManifest: config.completeManifest,
        pages: config.pages.map(p => ({ id: p.id, url: p.url, phase: 'queued' })) };
    for (const p of status.pages) if (['reading', 'detecting', 'translating', 'rendering'].includes(p.phase)) p.phase = 'queued';
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && (changes.mtPipeline || changes.mtSettings || changes.mtOcrSettings)) stop('Translation paused — settings changed; start again to use them');
    });
    await publish();
    pumpCheck();
}

// Entry point for a context that hosts this runner. Chromium's offscreen document calls it
// on load; Firefox's background page calls it through chapter/boot.ts. Safe to call twice.
export async function attachChapterRunner(): Promise<void> {
    if (status) return;
    const reply = await chrome.runtime.sendMessage({ type: 'mt:chapter-runner-boot' }) as
        { ok?: boolean; id?: string } | undefined;
    if (reply?.id) await attach(reply.id);
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    // Firefox starts a run by telling the background page (which IS the runner) to attach.
    if (msg?.type === 'mt:chapter-runner-attach') {
        if (status) { respond({ ok: true, already: true }); return; }
        attach(String(msg.id)).then(() => respond({ ok: true }), e => { showFatal(e); respond({ ok: false }); });
        return true;
    }
    if (msg?.type === 'mt:chapter-runner-stop') { stop(); respond({ ok: true }); return; }
});

// A page loaded directly (offscreen document, or a developer opening page.html) attaches
// itself. Firefox reaches the same code through boot.ts, where the module also evaluates —
// attaching twice is a no-op because `status` is already set.
void attachChapterRunner().catch(showFatal);

