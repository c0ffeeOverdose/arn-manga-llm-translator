import { configureChapterHost, loadPipeline, setShareContext } from '../content/state';
import { fetchBitmap, unscrambleTiles } from '../content/page-io';
import { resolveHeadlessDet, detFromCacheEntry } from '../content/pipeline';
import { translateRegions, abortLiveRpcs } from '../content/ocr';
import { renderPage } from '../content/render-page';
import { cacheGet, cachePut, cacheKey, pageKey, pageEntryDecision, PAGE_KEY_GEN, settingsFingerprint, pageHashFromBitmap, packMask, isResumable, detFromPartial } from '../content/page-cache';
import { keepaliveOpen } from '../content/queue';
import { initDebug, isDebug } from '../debug';
import { chapterMessage, providerMessage, fetchSourceWithAlternate, type ChapterPage, type ChapterProgress, type Contribution } from './model';
import { readRecord, writeRecord } from './store';
import { artifactKey, chapterSignature, type HostConfig, type HostCheckpoint, type ChapterArtifact } from './protocol';
import { identifyBitmap, signatureOf } from '../image-identity';
import type { ContextState } from '../llm/core';
import { Attempt } from './lifecycle';
import { nextDocument, chapterImages, guessNextDocument, sameChapterDocument } from './discovery';
import { nextBatch, pagePhase } from './plan';
import { cacheReady, cacheCurrent, assertCacheCurrent } from '../cache-generation';

let id = '';
// A page lease must cover the slowest real work (cold model load + a full LLM roundtrip) and
// still be short enough that one stuck page cannot freeze the chapter. Expiry costs that page
// only — the run carries on with the rest.
const PAGE_LEASE_MS = 300_000;
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
    if (!url) return false;
    if (visitedDocuments.has(url)) throw new Error('Reader pagination repeats a page');
    if (!sameChapterDocument(url, config.readerUrl, config.chapter)) return false;
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Could not load the next reader page (HTTP ${response.status})`);
    if (!sameChapterDocument(response.url, config.readerUrl, config.chapter)) throw new Error('Reader redirected outside this chapter');
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    if (generation !== epoch) return false;
    // No selector gate: the next document's own page images are what we take. A reader
    // that virtualizes its DOM exposes no stable class, and requiring one stopped the
    // run silently on the first page.
    const images = chapterImages(doc, response.url, config.imageFilter);
    if (!images.length) throw new Error('The next page needs the reader to load its images');
    visitedDocuments.add(url);
    let order = Math.max(...config.pages.map(p => p.order)) + 1;
    for (const image of images) {
        if (config.pages.some(p => p.url === image)) continue;
        const page = { id: `url:${image}`, url: image, order: order++, descramble: false };
        config.pages.push(page);
        status.pages.push({ id: page.id, url: page.url, order: page.order, phase: 'queued' });
    }
    config.nextDocument = nextDocument(doc, response.url, config.chapter)
        ?? guessNextDocument(response.url, config.chapter);
    config.completeManifest = !config.nextDocument;
    status.completeManifest = config.completeManifest;
    status.total = config.pages.length;
    await publish();
    return true;
}

function signature(): string { return chapterSignature(config.pipeline); }
// The runner module is also bundled into Chromium's service worker (the broker imports the
// boot helper), where there is no document at all. Every DOM touch must go through here.
function statusElement(): HTMLElement | null {
    return typeof document === 'undefined' ? null : document.querySelector('#status');
}
function publish(): Promise<void> {
    status.done = status.pages.filter(p => p.phase === 'ready').length;
    status.errors = status.pages.filter(p => p.phase === 'failed').length;
    status.inflight = status.pages.filter(p => ['reading', 'detecting', 'translating', 'rendering'].includes(p.phase)).length;
    // The runner has no console a user (or a harness) can open — the last few breadcrumbs
    // ride along for diagnosis. Never the user-facing `message`: the pill reads that.
    status.diagnostics = diagnostics.length ? diagnostics.slice(-6).join(' | ').slice(0, 900) : undefined;
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
        // The preferred encoding may be evicted on this CDN edge; the sibling tier of the SAME
        // page is a separate file, so try it once before failing the page.
        const f = await fetchSourceWithAlternate(page.url, page.alt, fetchBitmap,
            why => note(`source p${page.order} primary failed (${why}); trying sibling encoding`));
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
    const cacheEpoch = config.cacheEpoch ?? await cacheReady();
    const valid = () => generation === epoch && live() && cacheCurrent(cacheEpoch);
    const stage = (phase: typeof item.phase) => { if (valid()) { item.phase = phase; void publish().catch(showFatal); } };
    let bitmap: ImageBitmap | undefined;
    try {
        stage('reading');
        const previous = await readRecord<ChapterArtifact>(artifactKey(id, page.id));
        const force = config.force?.has(page.id) === true;
        if (!valid()) return null;
        if (!force && previous?.identity && previous.hash && previous.signature === signature()) {
            const hash = previous.hash;
            item.hash = hash;
            item.image = signatureOf(previous.identity);
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
        item.image = signatureOf(identifyBitmap(bitmap));
        if (bitmap.width < 400 || bitmap.height < 300) throw new Error('Image is too small to be a manga page');
        // Two keys, two questions. `bytesKey` is the pixels we hold (resume checkpoints and
        // crops must belong to them); `identityKey` is the page in the chapter (the
        // translation, detection and rendered image do not change with the encoder).
        const bytesKey = cacheKey(config.chapter, hash);
        const identityKey = pageKey(config.chapter, page.order);
        stage('detecting');
        if (force) {
            // Retranslation is "the same page again": fresh detection and a fresh answer, but
            // overlapping pages keep their contributions so the book stays in reading order.
            const { cacheDelete } = await import('../content/page-cache');
            await cacheDelete(bytesKey, cacheEpoch);
            await cacheDelete(identityKey, cacheEpoch);
        }
        let resolved;
        try {
            // Resume first: when detection already ran and the OCR checkpoint landed, coming
            // back through /v1/page would re-pay detect and re-OCR, and the fresh call would
            // send empty sources. A resumed detect carries the paid texts in cloudTexts.
            // The checkpoint is bytes-scoped: it describes a detection of THESE pixels.
            const hit = await cacheGet(bytesKey);
            if (!force && isResumable(hit, settingsFingerprint(config.pipeline), bitmap.width, bitmap.height, config.pipeline.inferEngine === 'cloud')) {
                resolved = { det: detFromPartial(hit!, bitmap.width, bitmap.height), resumed: true };
            } else {
                resolved = await resolveHeadlessDet(bitmap, hash, () => {}, cacheEpoch);
            }
        } catch (e) {
            note(`detect p${page.order} ${(e as Error).message}`.slice(0, 160));
            throw e;
        }
        if (!valid()) return null;
        // A finished page is reusable across encoders: prefer the page-identity entry, and
        // fall back to the bytes entry (a page whose source URL never varies writes both).
        const byIdentity = await cacheGet(identityKey);
        const decision = pageEntryDecision(byIdentity, hash, settingsFingerprint(config.pipeline), bitmap.width, bitmap.height);
        const cached = !resolved.det
            ? (decision.usable ? byIdentity : await cacheGet(bytesKey))
            : undefined;
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
        const identity = identifyBitmap(bitmap, det.boxes);
        stage('translating');
        let out;
        try {
            out = cached ?? await translateRegions(bitmap, det, () => {}, { fold: false, lo: true, context: snapshot, fresh: force, cacheEpoch });
        } catch (e) {
            note(`llm p${page.order} ${(e as Error).message}`.slice(0, 200));
            throw e;
        }
        if ('error' in out && out.error) throw Object.assign(new Error(out.error), { kind: out.errorKind });
        if (!valid()) return null;
        stage('rendering');
        // AI-cleanup crops are erased pixels, so they are reusable only when the bytes match.
        // The translation above is keyed by page identity and may have come from a different
        // encoder — carrying its crops onto these pixels would paint erased regions in the
        // wrong places, so they are dropped and re-derived from these bytes.
        const reusablePatches = cached === byIdentity && !decision.dropPatches ? byIdentity?.patches : undefined;
        const rendered = await renderPage({ kind: 'img', el: document.createElement('img') },
            { srcUrl: page.url, bitmap, det, hash, cacheEpoch,
                cached: { ...out, patches: reusablePatches,
                    ...(reusablePatches?.length ? { patchesGen: byIdentity?.patchesGen } : null) } },
            () => {}, false, { paintOnly: true, detached: true });
        let blob: Blob;
        try { blob = await (await fetch(rendered.translated)).blob(); }
        finally { URL.revokeObjectURL(rendered.translated); }
        if (!valid()) return null;
        const fp = settingsFingerprint(config.pipeline);
        // Identity entry: what the page says, reusable whatever the encoder. Written under
        // page identity so the reader finds it no matter which bytes it is showing.
        const entry: ChapterArtifact['entry'] = { key: identityKey, fp,
            w: bitmap.width, h: bitmap.height, boxes: det.boxes, panels: det.panels ?? [],
            outputs: out.outputs, extras: out.extras, mentions: out.mentions,
            mask: packMask(det.mask), splitGen: det.splitGen ?? 0, ep: det.ep,
            order: page.order, keyGen: PAGE_KEY_GEN };
        // Bytes entry: the resume checkpoint's full form, home of the crops.
        const bytesEntry: ChapterArtifact['entry'] = { ...entry, key: bytesKey };
        await writeRecord(artifactKey(id, page.id), { blob, entry, identity, hash, at: Date.now(), signature: signature() } satisfies ChapterArtifact);
        if (!valid()) return null;
        if (config.pipeline.cacheEnabled) {
            await cachePut(entry, config.pipeline.cacheMax, cacheEpoch);
            await cachePut(bytesEntry, config.pipeline.cacheMax, cacheEpoch);
        }
        const contribution = { id: page.id, order: page.order, hash, outputs: out.outputs, mentions: out.mentions ?? [] };
        if (!valid()) return null;
        await contextFor([contribution]);
        if (!valid()) return null;
        config.force?.delete(page.id);
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
                // No queued page is due: either more pages exist to discover, or only
                // pixel-waiting pages remain (not a completion — the reader may still
                // materialize them). Discovery may append work; otherwise stop cleanly.
                if (await discover(generation)) continue;
                break;
            }
            // A bounded batch shares an immutable context. Only its ordered reducer writes the book.
            const snapshot = await contextFor(undefined, Math.min(...batch.map(p => p.order)));
            if (generation !== epoch) break;
            // Stall watch: a batch that returns without any page changing phase means the work
            // is not progressing. Name each page's stage so a hang reports itself instead of
            // showing as a spinner forever.
            const before = new Map(batch.map(p => [p.id, status.pages.find(s => s.id === p.id)!.phase]));
            const t0 = Date.now();
            await Promise.all(batch.map(p => {
                const slot = status.pages.find(s => s.id === p.id)!;
                const attempt = new Attempt({
                    timeoutMs: PAGE_LEASE_MS,
                    label: () => `p${p.order} ${slot.phase}`,
                    onExpire: ({ label, elapsedMs }) => {
                        // One page that never settles must not end the run: mark it failed and
                        // let the planner take the next one. The lease already revoked its
                        // results, so a late completion cannot commit anything.
                        const phase = slot.phase;
                        slot.phase = 'failed';
                        const stuck = `p${p.order} stuck in ${phase} for ${Math.round(elapsedMs / 1000)}s`;
                        note(stuck);
                        if (isDebug()) console.warn('[mt] chapter', stuck);
                        void publish().catch(showFatal);
                    },
                });
                attempts.add(attempt);
                const task = work(p, structuredClone(snapshot), generation, () => attempt.valid());
                return Promise.race([task, attempt.cancelled]).finally(() => { attempt.finish(); attempts.delete(attempt); });
            }));
            // Report a batch where nothing moved: a page still in the same stage after a whole
            // batch round means that stage never settled (a hung fetch, an unanswered RPC).
            const stalled = batch
                .map(p => ({ p, was: before.get(p.id), now: status.pages.find(s => s.id === p.id)!.phase }))
                .filter(x => x.was === x.now && ['reading', 'detecting', 'translating', 'rendering'].includes(x.now))
                .map(x => `p${x.p.order} held ${x.now}`);
            if (stalled.length) note(`batch stalled ${Math.round((Date.now() - t0) / 1000)}s: ${stalled.join(', ')}`);
        }
        if (generation !== epoch) {
            for (const p of status.pages) if (['reading', 'detecting', 'translating', 'rendering'].includes(p.phase)) p.phase = 'queued';
            if (status.phase === 'stopping') status.phase = 'stopped';
        } else if (status.phase === 'running') {
            // Pixel-waiting pages are the reader's problem, not a failure of the run: the
            // chapter is complete when the manifest is complete and nothing is left to do.
            status.phase = config.completeManifest ? 'complete' : 'waiting';
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
                // Revoke the active generation before resetting its phases, so a late
                // answer cannot replace the user's newer retranslation intent.
                if (['reading', 'detecting', 'translating', 'rendering'].includes(page.phase)) {
                    epoch++;
                    for (const attempt of attempts) attempt.cancel();
                    abortLiveRpcs();
                    for (const p of status.pages) if (['reading', 'detecting', 'translating', 'rendering'].includes(p.phase)) p.phase = 'queued';
                }
                page.phase = 'queued';
                status.phase = 'running';
                status.message = undefined;
            }
        }
    }
    if (msg.command === 'append' && Array.isArray(msg.pages)) {
        for (const p of msg.pages as ChapterPage[]) {
            if (!config.pages.some(old => old.id === p.id)) {
                config.pages.push(p);
                status.pages.push({ id: p.id, url: p.url, order: p.order, phase: 'queued' });
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
    await cacheReady();
    await initDebug();
    const response = await chrome.runtime.sendMessage({ type: 'mt:chapter-host-init', id });
    if (!response?.ok) throw new Error(response?.error || 'Chapter session expired');
    config = response.config;
    assertCacheCurrent(config.cacheEpoch ?? '');
    // Load custom fonts before pinning the execution session's settings.
    await loadPipeline();
    configureChapterHost(config.chapter, config.bookKey, config.pipeline, config.context);
    setShareContext(config.shareContext);
    const checkpoint = await readRecord<HostCheckpoint>(`checkpoint:${id}`);
    if (checkpoint) config = { ...config, ...checkpoint.config };
    status = checkpoint?.progress ?? { id, chapter: config.chapter, phase: 'running', done: 0, total: config.pages.length,
        inflight: 0, errors: 0, completeManifest: config.completeManifest,
        pages: config.pages.map(p => ({ id: p.id, url: p.url, order: p.order, phase: 'queued' })) };
    for (const p of status.pages) if (['reading', 'detecting', 'translating', 'rendering'].includes(p.phase)) p.phase = 'queued';
    // Storage-change events are optional: an offscreen document is given only the runtime
    // API, and the shim may not cover every area this build talks to. A missing event must
    // not take the whole run down.
    chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area === 'local' && (changes.mtPipeline || changes.mtSettings || changes.mtOcrSettings)) stop('Translation paused — settings changed; start again to use them');
    });
    await publish();
    pumpCheck();
}

// Entry point for a context that hosts this runner. Chromium's offscreen document calls it
// on load; Firefox's background page calls it through chapter/boot.ts. Safe to call twice.
export async function attachChapterRunner(): Promise<void> {
    if (id) return;
    const reply = await chrome.runtime.sendMessage({ type: 'mt:chapter-runner-boot' }) as
        { ok?: boolean; id?: string } | undefined;
    if (reply?.id) await attach(reply.id);
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    // Firefox starts a run by telling the background page (which IS the runner) to attach.
    if (msg?.type === 'mt:chapter-runner-attach') {
        if (id) { respond({ ok: true, already: true }); return; }
        attach(String(msg.id)).then(() => respond({ ok: true }), e => { showFatal(e); respond({ ok: false }); });
        return true;
    }
    if (msg?.type === 'mt:chapter-runner-stop') {
        (async () => {
            if (status) stop();
            while (pumping) await new Promise(r => setTimeout(r, 20));
            await publishChain;
            id = '';
            respond({ ok: true });
        })();
        return true;
    }
});

// A page loaded directly (offscreen document, or a developer opening page.html) attaches
// itself. Firefox reaches the same code through boot.ts, where the module also evaluates —
// attaching twice is a no-op because `status` is already set.
void attachChapterRunner().catch(showFatal);
