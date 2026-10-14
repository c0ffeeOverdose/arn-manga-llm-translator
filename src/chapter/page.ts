import { verifyCachedIdentity } from '../cache/identity';
import { configureChapterHost, loadPipeline, setShareContext } from '../content/state';
import { fetchBitmap, unscrambleTiles } from '../content/page-io';
import { resolveHeadlessDet } from '../content/pipeline';
import { translateRegions, abortLiveRpcs } from '../content/ocr';
import { renderPage } from '../content/render-page';
import { cacheGet, cachePutMany, cacheDelete, cacheKey, pageKey, selectCachedPage, detFromCacheEntry, cacheEntryFresh, cacheMissReason, PAGE_KEY_GEN, INPAINT_PATCH_GEN, settingsFingerprint, pageHashFromBitmap, packMask } from '../content/page-cache';
import { keepaliveOpen } from '../content/queue';
import { initDebug, isDebug } from '../debug';
import { chapterMessage, providerMessage, pickRetryPages, type ChapterPage, type ChapterProgress, type Contribution, type PagePhase } from './model';
import { HashReaderSourceLoader, fetchHashReaderRouting } from './source';
import { readRecord, writeRecord } from './store';
import { artifactKey, chapterSignature, type HostConfig, type HostCheckpoint, type ChapterArtifact } from './protocol';
import { identifyBitmap, signatureOf } from '../image-identity';
import type { ContextState } from '../llm/core';
import { DEFAULT_PIPELINE_SETTINGS, inpaintMode } from '../llm/pipeline-settings';
import { releaseIdleDetector, holdInferenceHost, shiftDetectionBoxY, type DetectResult, type DetBox } from '../content/detection';
import { InferenceRpcTimeoutError } from '../content/inference-health';
import { computeAiPatches, type AiPatches } from '../content/inpaint';
import type { TranslateOutcome } from '../content/ocr';
import type { CachedPage } from '../content/page-cache';
import type { ImageIdentity } from '../image-identity';
import { Attempt } from './lifecycle';
import { nextDocument, chapterImages, guessNextDocument, sameChapterDocument, discoverEnded } from './discovery';
import { nextGroup, pagePhase } from './plan';
import { cacheReady, cacheCurrent, assertCacheCurrent } from '../cache-generation';
import { sendToBackground } from '../bg-rpc';
import { recordChapterLog } from './log-store';
import { chapterLogError, type ChapterLogStage, type ChapterTrace } from './log';

let id = '';
let logId = '';
let enablingLog: Promise<void> | undefined;
function enableChapterLog(): Promise<void> {
    if (!isDebug() || logId || !config || !status) return Promise.resolve();
    return enablingLog ??= (async () => {
        try {
            const r = await sendToBackground<{ ok?: boolean; logId?: string }>({ type: 'mt:chapter-log-enable', id },
                { timeoutMs: 10_000, label: 'enable chapter log' });
            if (!isDebug() || !r?.ok || !r.logId) return;
            logId = config.logId = status.logId = r.logId;
            await publish();
        } finally { enablingLog = undefined; }
    })();
}
function trace(pages?: number[]): ChapterTrace | undefined { return logId ? { logId, pages } : undefined; }
function step(stage: ChapterLogStage, pages?: number[]): void { recordChapterLog(trace(pages), { kind: 'stage', stage }); }
function pageStatus(pages: number[], valid: () => boolean = () => true): (text: string, stage?: string) => void {
    let last = '';
    return (_text, stage) => {
        const key = stage === 'ocr' ? 'ocr' : stage === 'llm' ? 'llmWait' : stage === 'render' ? 'render' : undefined;
        if (!valid() || !key || key === last) return;
        last = key; step(key, pages);
    };
}
// A page lease must cover the slowest real work (cold model load + a full LLM roundtrip) and
// still be short enough that one stuck page cannot freeze the chapter. Expiry costs that page
// only — the run carries on with the rest.
const PAGE_LEASE_MS = 300_000;
// Bounded breadcrumb for debugging a stalled run.
const diagnostics: string[] = [];
(globalThis as unknown as { __mtLog: string[] }).__mtLog = diagnostics;
const note = (m: string): void => {
    if (!isDebug()) return;
    diagnostics.push(m);
    if (diagnostics.length > 200) diagnostics.shift();
};
// Pages whose failure was a timeout-class fault (RPC deadline / lease expiry) — candidates for
// the single automatic retry pass — and the pages that already spent that retry. Cleared when
// a run (re)starts; a page never earns two automatic retries inside one run.
const autoRetry = new Set<string>();
const retried = new Set<string>();
let config: HostConfig;
let sourceLoader: HashReaderSourceLoader;
let status: ChapterProgress;
let epoch = 0;
let pumping = false;
let initialized = false;
let priority = '';
let publishChain: Promise<unknown> = Promise.resolve();
const pendingForce = new Set<string>();
const attempts = new Set<Attempt>();
const attemptPages = new WeakMap<Attempt, string[]>();
const leaseSignals = new WeakMap<() => boolean, AbortSignal>();
const contextSharing = new WeakMap<ContextState, boolean>();
let settingsStale = false;
const pageEpochs = new Map<string, number>();
const visitedDocuments = new Set<string>();

async function discover(generation: number): Promise<boolean> {
    if (config.requestedPages) return false;
    const url = config.nextDocument;
    if (!url) return false;
    if (visitedDocuments.has(url)) throw new Error('Reader pagination repeats a page');
    if (!sameChapterDocument(url, config.readerUrl, config.chapter)) return false;
    step('discovery');
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
        // Past the last page the reader answers the guessed next URL with 404/410 — the
        // chapter ends here. Any other status is a real failure of the walk.
        if (discoverEnded(response.status)) {
            note(`discover: next reader page answered ${response.status} — end of chapter`);
            config.completeManifest = true;
            status.completeManifest = true;
            await publish();
            return false;
        }
        throw new Error(`Could not load the next reader page (HTTP ${response.status})`);
    }
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
    status.diagnostics = isDebug() && diagnostics.length ? diagnostics.slice(-6).join(' | ').slice(0, 900) : undefined;
    recordChapterLog(trace(), { kind: 'progress', phase: status.phase, done: status.done, total: status.total,
        errors: status.errors, inflight: status.inflight });
    const statusEl = statusElement();
    if (statusEl) statusEl.textContent = chapterMessage(status);
    const snapshot = structuredClone(status);
    const checkpoint: HostCheckpoint = { config: structuredClone(config), progress: snapshot };
    const next = publishChain.then(async () => {
        await writeRecord(`checkpoint:${id}`, checkpoint);
        const r = await sendToBackground<{ ok?: boolean; error?: string }>(
            { type: 'mt:chapter-publish', id, status: snapshot }, { timeoutMs: 15_000, label: 'publish progress' });
        if (!r?.ok) throw new Error(r?.error || 'Could not save chapter progress');
    });
    publishChain = next.catch(() => {});
    return next;
}
function stop(message?: string): void {
    recordChapterLog(trace(), { kind: message ? 'failure' : 'stop' });
    epoch++;
    for (const attempt of attempts) attempt.cancel();
    abortLiveRpcs();
    status.phase = message ? 'error' : pumping ? 'stopping' : 'stopped';
    status.message = message;
    void publish().catch(showFatal);
}

// Empty replies were split into smaller batches — tell the reader once per session. The runner
// has no console anyone can open, so the notice rides the published progress and clears itself.
let starveNoticeShown = false;
function starveNotice(): void {
    if (starveNoticeShown || !status) return;
    starveNoticeShown = true;
    recordChapterLog(trace(), { kind: 'retry', reason: 'smaller-batches' });
    status.notice = 'Retrying some pages with smaller batches';
    void publish().catch(() => {});
    setTimeout(() => {
        if (status?.notice) { status.notice = undefined; void publish().catch(() => {}); }
    }, 8000);
}
function showFatal(e: unknown): void {
    recordChapterLog(trace(), { kind: 'failure', ...chapterLogError(e) });
    const msg = `Translation paused — ${(e as Error).message || String(e)}`;
    const el = statusElement();
    if (el) el.textContent = msg;
    console.error('[mt] chapter runner', e);
    // A session that already has a status must say it failed — an attach-phase crash used to
    // leave the reader with a snapshot that could never advance while the runner looked alive.
    if (status) {
        status.phase = 'error';
        status.message = msg;
        status.inflight = 0;
        void publish().catch(() => {});
    }
    // Persist the reason: an offscreen document has no console a user can open, so a crash
    // would otherwise be invisible and the reader would only see "no chapter session".
    if (id) void writeRecord(`error:${id}`, { message: msg,
        ...(isDebug() ? { stack: (e as Error)?.stack ?? '' } : {}) }).catch(() => {});
}
async function contextFor(entries?: Contribution[], beforeOrder?: number, sharing = config.shareContext): Promise<ContextState> {
    if (!sharing) return { pairs: [], characters: [] };
    step(entries ? 'contextWrite' : 'context', entries?.map(e => e.order + 1));
    const r = await sendToBackground<{ ok?: boolean; error?: string; context?: ContextState }>(
        { type: 'mt:chapter-context', id, entries, beforeOrder }, { timeoutMs: 15_000, label: 'chapter context' });
    if (!r?.ok) throw new Error(r?.error || 'Could not update character context');
    return r.context!;
}
async function source(page: ChapterPage, valid: () => boolean): Promise<ImageBitmap> {
    if (page.source) return createImageBitmap(await (await fetch(page.source)).blob());
    if (/^https?:/.test(page.url)) {
        // The preferred encoding may be evicted on this CDN edge; the sibling tier of the SAME
        // page is a separate file, so try it once before failing the page.
        const f = await sourceLoader.load(page.url, page.alt, fetchBitmap,
            why => { note(`source p${page.order} primary failed (${why}); trying sibling encoding`);
                recordChapterLog(trace([page.order + 1]), { kind: 'source-alternate' }); }, valid);
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
type ProgressItem = ChapterProgress['pages'][number];

// Phase transitions are only visible while this attempt's work is still valid: a revoked
// attempt (Stop, retranslate, cache reset) must not resurrect progress.
function stage(item: ProgressItem, valid: () => boolean, phase: ProgressItem['phase']): void {
    if (valid()) { item.phase = phase; void publish().catch(showFatal); }
}

// Page-local failures do not end the run. Provider refusals and confirmed browser-wide
// graphics stalls pause it: another page cannot repair a shared unavailable resource.
async function markFailed(page: ChapterPage, item: ProgressItem, e: unknown, valid: () => boolean): Promise<void> {
    if (!valid()) return;
    note(`work p${page.order} FAIL ${(e as Error).name}: ${(e as Error).message}`.slice(0, 200));
    const err = e as Error & { kind?: string };
    recordChapterLog(trace([page.order + 1]), { kind: err.kind === 'source' ? 'page-waiting' : 'page-failed', ...chapterLogError(e) });
    // A page that already reached 'ready' in this run is done; a late publish failure must
    // not demote it and re-queue an infinite retry.
    if (item.phase !== 'ready') item.phase = err.kind === 'source' ? 'waiting' : 'failed';
    // An RPC deadline that still left the browser's GPU responsive is a transient stall, not a
    // bad page: mark it for the one automatic retry the pump runs at the end of the walk.
    if (item.phase === 'failed' && e instanceof InferenceRpcTimeoutError) autoRetry.add(page.id);
    console.warn('[mt] chapter page failed', page.order, err);
    if (err.kind === 'ratelimit' || err.kind === 'auth' || err.kind === 'inference') {
        status.message = err.kind === 'inference' ? `Translation paused — ${err.message}` : providerMessage(err.kind);
        status.phase = 'error';
    }
    await publish();
}

// CachedPage and TranslateOutcome share the three fields the commit path needs.
type TranslationResult = Pick<CachedPage, 'outputs' | 'extras' | 'mentions'>;

// A page whose pixels and detection are ready but whose translation is not. The bitmap stays
// open until the caller commits or abandons it.
interface Prepared {
    page: ChapterPage;
    item: ProgressItem;
    bitmap: ImageBitmap;
    hash: string;
    det: DetectResult;
    identity: ImageIdentity;
    bytesKey: string;
    identityKey: string;
    force: boolean;
    shareContext?: boolean;
    out?: TranslationResult;         // cached translation: commit without an LLM call
    patches?: CachedPage['patches']; // reusable AI-cleanup patches (cached path only)
    patchesGen?: number;
    // AI cleanup starts after OCR during the LLM wait; single, merged and fallback
    // commits reuse the same promise rather than starting another model pass.
    warm?: Promise<AiPatches | null>;
}

// Everything before the LLM call: pixels, resume/cache checks, detection, cache decision.
// 'done' = already settled (artifact reuse or no text); 'skip' = failed or invalidated.
async function preparePage(page: ChapterPage, generation: number, cacheEpoch: string, valid: () => boolean): Promise<Prepared | 'done' | 'skip'> {
    const item = status.pages.find(p => p.id === page.id)!;
    let bitmap: ImageBitmap | undefined;
    try {
        stage(item, valid, 'reading');
        step('artifact', [page.order + 1]);
        const previous = await readRecord<ChapterArtifact>(artifactKey(id, page.id));
        const force = config.force?.has(page.id) === true;
        if (!valid()) return 'skip';
        if (!force && previous?.identity && previous.hash && previous.signature === signature()) {
            recordChapterLog(trace([page.order + 1]), { kind: 'cache-hit', reason: 'artifact', cached: true });
            const hash = previous.hash;
            item.hash = hash;
            item.image = signatureOf(previous.identity);
            const contribution = { id: page.id, order: page.order, hash, outputs: previous.entry.outputs, mentions: previous.entry.mentions ?? [] };
            if (!page.inBaseContext) await contextFor([contribution]);
            if (!valid()) return 'skip';
            item.phase = 'ready';
            recordChapterLog(trace([page.order + 1]), { kind: 'page-ready' });
            await publish();
            return 'done';
        }
        step('image', [page.order + 1]);
        bitmap = await source(page, valid).catch(e => { note(`source p${page.order} ${(e as Error).message}`); throw e; });
        if (!valid()) { bitmap.close(); return 'skip'; }
        step('hash', [page.order + 1]);
        const hash = pageHashFromBitmap(bitmap);
        recordChapterLog(trace([page.order + 1]), { kind: 'stage', stage: 'cache', w: bitmap.width, h: bitmap.height });
        item.hash = hash;
        item.image = signatureOf(identifyBitmap(bitmap));
        if (bitmap.width < 400 || bitmap.height < 300) throw new Error('Image is too small to be a manga page');
        // Two keys, two questions. `bytesKey` is the pixels we hold (resume checkpoints and
        // crops must belong to them); `identityKey` is the page in the chapter (the
        // translation, detection and rendered image do not change with the encoder).
        const bytesKey = cacheKey(config.chapter, hash);
        const identityKey = pageKey(config.chapter, page.order);
        stage(item, valid, 'detecting');
        if (force) {
            // Retranslation is "the same page again": fresh detection and a fresh answer, but
            // overlapping pages keep their contributions so the book stays in reading order.
            await cacheDelete(bytesKey, cacheEpoch);
            await cacheDelete(identityKey, cacheEpoch);
        }
        const fp = settingsFingerprint(config.pipeline);
        const byBytes = await cacheGet(bytesKey);
        const byIdentity = config.pipeline.cacheEnabled && !cacheEntryFresh(byBytes, fp, bitmap.width, bitmap.height, config.pipeline.inferEngine === 'cloud')
            ? await cacheGet(identityKey) : undefined;
        const selected = !force && config.pipeline.cacheEnabled ? selectCachedPage({ bytes: byBytes, identity: byIdentity,
            hash, fp, w: bitmap.width, h: bitmap.height, isCloud: config.pipeline.inferEngine === 'cloud',
            verifyIdentity: row => verifyCachedIdentity(bitmap!, row) }) : null;
        let resolved: Awaited<ReturnType<typeof resolveHeadlessDet>>;
        try {
            if (selected) resolved = { det: null, resumed: false, cached: selected.entry };
            else {
                step('detect', [page.order + 1]);
                resolved = await resolveHeadlessDet(bitmap, hash, pageStatus([page.order + 1], valid), cacheEpoch, trace([page.order + 1]));
                if (resolved.resumed) recordChapterLog(trace([page.order + 1]), { kind: 'cache-hit', reason: 'checkpoint', cached: true });
                else if (resolved.det) recordChapterLog(trace([page.order + 1]), { kind: 'cache-miss',
                    reason: !config.pipeline.cacheEnabled ? 'disabled' : cacheMissReason(byBytes, fp, bitmap.width, bitmap.height, config.pipeline.inferEngine === 'cloud'),
                    cached: false });
            }
        } catch (e) {
            note(`detect p${page.order} ${(e as Error).message}`.slice(0, 160));
            throw e;
        }
        if (!valid()) { bitmap.close(); return 'skip'; }
        const cached = resolved.cached;
        const boxes = resolved.det?.boxes.length ?? cached?.boxes.length ?? 0;
        // A page with no detected text has nothing to translate or paint; do not cache or fold it.
        if (!boxes) {
            item.phase = 'ready';
            item.revision = (item.revision ?? 0) + 1;
            recordChapterLog(trace([page.order + 1]), { kind: 'page-ready', reason: 'no-text', boxes: 0 });
            await publish();
            bitmap.close();
            return 'done';
        }
        const det = resolved.det ?? selected?.det ?? detFromCacheEntry(cached, fp, bitmap.width, bitmap.height, config.pipeline.inferEngine === 'cloud');
        if (!det) throw new Error('Saved page data is incomplete');
        recordChapterLog(trace([page.order + 1]), { kind: cached ? 'cache-hit' : 'stage', stage: 'translationPrep',
            ...(cached ? { reason: 'full-cache' as const } : {}), boxes: det.boxes.length, splitGen: det.splitGen, cached: !!cached });
        // The request pipeline caps a page at 150 regions. Cap before a group call so the
        // merged box list and the renderer see exactly what the single-page path would.
        if (!cached && det.boxes.length > 150) det.boxes = det.boxes.slice(0, 150);
        const identity = identifyBitmap(bitmap, det.boxes);
        stage(item, valid, 'translating');
        if (cached) {
            // AI-cleanup crops are erased pixels, so they are reusable only when the bytes
            // match: a translation keyed by page identity may come from a different encoder,
            // so mismatched-bytes patches are dropped and re-derived from these pixels.
            const reusable = cached.patches;
            return { page, item, bitmap, hash, det, identity, bytesKey, identityKey, force,
                out: cached, patches: reusable, patchesGen: reusable?.length ? cached.patchesGen : undefined };
        }
        return { page, item, bitmap, hash, det, identity, bytesKey, identityKey, force };
    } catch (e) {
        bitmap?.close();
        await markFailed(page, item, e, valid);
        return 'skip';
    }
}

function warmPrepared(p: Prepared, valid: () => boolean): void {
    if (valid() && status.phase === 'running' && !p.warm) p.warm = computeAiPatches(p.bitmap, p.det, p.det.boxes, []).catch(() => null);
}
function releasePrepared(p: Prepared): void {
    if (p.warm) void p.warm.finally(() => p.bitmap.close()).catch(() => {});
    else p.bitmap.close();
}

async function translateOrThrow(p: Prepared, snapshot: ContextState, cacheEpoch: string, live: () => boolean): Promise<TranslateOutcome> {
    try {
        step('translationPrep', [p.page.order + 1]);
        const out = await translateRegions(p.bitmap, p.det, pageStatus([p.page.order + 1], live), {
            fold: false, lo: true, context: snapshot, fresh: p.force, cacheEpoch, onStarve: starveNotice,
            shareContext: contextSharing.get(snapshot) ?? config.shareContext, signal: leaseSignals.get(live),
            chapterTrace: trace([p.page.order + 1]),
            valid: () => live() && status.phase === 'running',
            afterOcr: inpaintMode(config.pipeline) === 'local' ? () => warmPrepared(p, live) : undefined,
        });
        if ('error' in out && out.error) throw Object.assign(new Error(out.error), { kind: out.errorKind });
        return out;
    } catch (e) {
        if (live()) note(`llm p${p.page.order} ${(e as Error).message}`.slice(0, 200));
        throw e;
    }
}

// Paint from a translation (fresh or cached) and publish the page: artifact write, cache
// entries and the ordered book fold. The caller owns the bitmap and closes it.
async function commitPage(p: Prepared, out: TranslationResult, valid: () => boolean): Promise<void> {
    const { page, item, bitmap, det, hash, bytesKey, identityKey } = p;
    const cacheEpoch = config.cacheEpoch ?? await cacheReady();
    stage(item, valid, 'rendering');
    step('render', [page.order + 1]);
    let patches: CachedPage['patches'];
    const rendered = await renderPage({ kind: 'img', el: document.createElement('img') },
        { srcUrl: page.url, bitmap, det, hash, cacheEpoch,
            cached: { ...out, patches: p.patches, ...(p.patches?.length ? { patchesGen: p.patchesGen } : null) } },
        pageStatus([page.order + 1], valid), false, { paintOnly: true, detached: true, valid, warm: p.warm, onPatches: value => { patches = value; } });
    let blob: Blob;
    try { blob = await (await fetch(rendered.translated)).blob(); }
    finally { URL.revokeObjectURL(rendered.translated); }
    if (!valid()) return;
    const fp = settingsFingerprint(config.pipeline);
    // Identity entry: what the page says, reusable whatever the encoder. Written under
    // page identity so the reader finds it no matter which bytes it is showing.
    const entry: ChapterArtifact['entry'] = { key: identityKey, fp,
        w: bitmap.width, h: bitmap.height, boxes: det.boxes, panels: det.panels ?? [],
        outputs: out.outputs, extras: out.extras, mentions: out.mentions,
        mask: packMask(det.mask), splitGen: det.splitGen ?? 0, ep: det.ep,
        order: page.order, keyGen: PAGE_KEY_GEN, sourceHash: hash,
        idSig: signatureOf(p.identity), idGray: p.identity.gray, idRegions: p.identity.regions };
    // Bytes entry: the resume checkpoint's full form, home of the crops.
    const bytesEntry: ChapterArtifact['entry'] = { ...entry, key: bytesKey, idSig: undefined, idGray: undefined, idRegions: undefined,
        ...(patches?.length ? { patches, patchesGen: INPAINT_PATCH_GEN } : null) };
    step('result', [page.order + 1]);
    await writeRecord(artifactKey(id, page.id), { blob, entry, identity: p.identity, hash, at: Date.now(), signature: signature() } satisfies ChapterArtifact);
    if (!valid()) return;
    if (config.pipeline.cacheEnabled) {
        step('cacheWrite', [page.order + 1]);
        await cachePutMany([entry, bytesEntry], config.pipeline.cacheMax, cacheEpoch);
    } else await cacheDelete(bytesKey, cacheEpoch);
    const contribution = { id: page.id, order: page.order, hash, outputs: out.outputs, mentions: out.mentions ?? [] };
    if (!valid()) return;
    await contextFor([contribution], undefined, p.shareContext ?? config.shareContext);
    if (!valid()) return;
    config.force?.delete(page.id);
    item.revision = (item.revision ?? 0) + 1;
    item.phase = 'ready';
    recordChapterLog(trace([page.order + 1]), { kind: 'page-ready' });
    await publish();
}

// A lease covers the page's slow work. Expiry marks that page failed and revokes its late
// results — one stuck page must never hold a slot or the run.
async function withPageLease<T>(page: ChapterPage, item: ProgressItem, valid: () => boolean, run: (live: () => boolean) => Promise<T>): Promise<T | undefined> {
    const attempt = new Attempt({
        timeoutMs: PAGE_LEASE_MS,
        label: () => `p${page.order} ${item.phase}`,
        onExpire: ({ label, elapsedMs }) => {
            if (!valid()) return;
            void label;
            const phase = item.phase;
            item.phase = 'failed';
            recordChapterLog(trace([page.order + 1]), { kind: 'page-failed', reason: 'timeout' });
            const stuck = `p${page.order} stuck in ${phase} for ${Math.round(elapsedMs / 1000)}s`;
            note(stuck);
            // A lease expiry is a stalled stage, not a broken page — eligible for the one
            // automatic retry pass (same bound: `retried` admits a page only once).
            autoRetry.add(page.id);
            if (isDebug()) console.warn('[mt] chapter', stuck);
            void publish().catch(showFatal);
        },
    });
    attempts.add(attempt);
    attemptPages.set(attempt, [page.id]);
    const live = () => valid() && attempt.valid();
    leaseSignals.set(live, attempt.signal);
    const task = run(live);
    task.catch(() => {}); // a lease that expired abandons its task; late rejections are noise
    const result = await Promise.race([task, attempt.cancelled.then(() => undefined)]);
    attempt.finish();
    attempts.delete(attempt);
    return result;
}

// One prepared page: translate (unless cached) then commit. Used by single-page slots and by
// the per-page fallback of a failed group.
async function settlePrepared(p: Prepared, snapshot: ContextState, cacheEpoch: string, live: () => boolean): Promise<void> {
    try {
        p.shareContext = contextSharing.get(snapshot) ?? config.shareContext;
        // A revoked attempt (Stop, retry, cache reset) must not start new provider work.
        if (!live()) return;
        if (status.phase !== 'running') { p.item.phase = 'queued'; return; }
        const out = p.out ?? await translateOrThrow(p, snapshot, cacheEpoch, live);
        if (!live()) return;
        await commitPage(p, out, live);
    } catch (e) {
        await markFailed(p.page, p.item, e, live);
    } finally {
        releasePrepared(p);
    }
}

async function workSingle(page: ChapterPage, snapshot: ContextState, generation: number, cacheEpoch: string): Promise<void> {
    const item = status.pages.find(p => p.id === page.id)!;
    const revision = pageEpochs.get(page.id);
    const valid = () => generation === epoch && revision === pageEpochs.get(page.id) && cacheCurrent(cacheEpoch);
    await withPageLease(page, item, valid, async (live) => {
        const prepared = await preparePage(page, generation, cacheEpoch, live);
        if (prepared === 'done' || prepared === 'skip') return;
        await settlePrepared(prepared, snapshot, cacheEpoch, live);
    });
}

// Merge a group of prepared pages into one tall bitmap so the existing per-page request
// pipeline runs ONCE: crops are cut at native pixels, box lists concatenate in page order,
// and replies map back by box offsets.
async function combinePages(pages: Prepared[]): Promise<{ bitmap: ImageBitmap; det: DetectResult; total: number; segments: { y: number; h: number }[] }> {
    const width = Math.max(...pages.map(p => p.bitmap.width));
    const height = pages.reduce((a, p) => a + p.bitmap.height, 0);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    const boxes: DetBox[] = [];
    const texts: string[] = [];
    const segments: { y: number; h: number }[] = [];
    let allTexts = true;
    let y = 0;
    for (const p of pages) {
        ctx.drawImage(p.bitmap, 0, y);
        segments.push({ y, h: p.bitmap.height });
        for (const b of p.det.boxes) boxes.push(shiftDetectionBoxY(b, y));
        if (p.det.cloudTexts) texts.push(...p.det.cloudTexts);
        else allTexts = false;
        y += p.bitmap.height;
    }
    const bitmap = await createImageBitmap(canvas);
    const cloudTexts = allTexts && texts.length === boxes.length ? texts : undefined;
    return { bitmap, det: { ...pages[0].det, boxes, cloudTexts }, total: boxes.length, segments };
}

// A worker slot with mergePages>1: pages are prepared together, translated in ONE request
// (so they can see each other), then committed page by page. Cached pages commit the moment
// they are ready. Page-local group failure or lease expiry falls back to per-page calls, so one stuck
// page still costs one page.
async function runGroup(group: ChapterPage[], snapshot: ContextState, generation: number, cacheEpoch: string): Promise<void> {
    const revisions = new Map(group.map(p => [p.id, pageEpochs.get(p.id)]));
    const valid = () => generation === epoch && group.every(p => revisions.get(p.id) === pageEpochs.get(p.id)) && cacheCurrent(cacheEpoch);
    const prepared: Prepared[] = [];
    await Promise.all(group.map(async (page) => {
        const item = status.pages.find(p => p.id === page.id)!;
        const p = await withPageLease(page, item, valid, live => preparePage(page, generation, cacheEpoch, live));
        if (!p || p === 'done' || p === 'skip') return;
        if (p.out) {
            // Cached: commit now — it must not wait for the group's LLM call.
            await withPageLease(p.page, p.item, valid, live => settlePrepared(p, snapshot, cacheEpoch, live));
            return;
        }
        p.shareContext = contextSharing.get(snapshot) ?? config.shareContext;
        prepared.push(p);
    }));
    // Parallel preparation must not reorder the story seen by the merged request.
    prepared.sort((a, b) => a.page.order - b.page.order);
    if (!prepared.length) return;
    if (!valid() || status.phase !== 'running') {
        for (const p of prepared) {
            if (valid()) p.item.phase = 'queued';
            releasePrepared(p);
        }
        if (valid()) await publish();
        return;
    }
    if (prepared.length < 2) {
        // Only one page actually needs the LLM: a normal per-page call under its own lease.
        await Promise.all(prepared.map(p => withPageLease(p.page, p.item, valid, live => settlePrepared(p, snapshot, cacheEpoch, live))));
        return;
    }
    let out: TranslateOutcome | null = null;
    let sharedFailure: unknown;
    // A group too large for one canvas (or a failed combine) must degrade to per-page calls,
    // never kill the run.
    step('merge', prepared.map(p => p.page.order + 1));
    const combined = await combinePages(prepared).catch(e => {
        note(`group ${group.map(p => `p${p.order}`).join(',')} combine ${(e as Error).message}`.slice(0, 160));
        return null;
    });
    if (!combined) {
        await Promise.all(prepared.map(p => withPageLease(p.page, p.item, valid, live => settlePrepared(p, snapshot, cacheEpoch, live))));
        return;
    }
    const attempt = new Attempt({
        timeoutMs: PAGE_LEASE_MS,
        label: () => `group ${group.map(p => `p${p.order}`).join(',')} translating`,
        onExpire: ({ label, elapsedMs }) => {
            if (!valid()) return;
            const stuck = `${label} exceeded ${Math.round(elapsedMs / 1000)}s — trying per-page`;
            recordChapterLog(trace(group.map(p => p.order + 1)), { kind: 'retry', reason: 'per-page-fallback' });
            note(stuck);
            if (isDebug()) console.warn('[mt] chapter', stuck);
        },
    });
    attempts.add(attempt);
    attemptPages.set(attempt, prepared.map(p => p.page.id));
    let call: Promise<TranslateOutcome> | undefined;
    try {
        const groupPages = prepared.map(p => p.page.order + 1);
        step('translationPrep', groupPages);
        call = translateRegions(combined.bitmap, combined.det, pageStatus(groupPages, valid), {
            fold: false, lo: true, context: snapshot, fresh: prepared.some(p => p.force),
            shareContext: contextSharing.get(snapshot) ?? config.shareContext, signal: attempt.signal,
            cacheEpoch, onStarve: starveNotice, regionCap: combined.total, checkpoint: false,
            chapterTrace: trace(groupPages),
            valid: () => valid() && attempt.valid() && status.phase === 'running',
            // page mode: one annotated image per page, badges numbered globally across the group
            pageSegments: config.pipeline.textSource === 'page' ? combined.segments : undefined,
            // OCR is done and the LLM request is about to leave: the GPU is idle for the whole
            // network wait, so every page computes its cleanup patches now (single-page parity).
            afterOcr: inpaintMode(config.pipeline) === 'local'
                ? () => { for (const p of prepared) warmPrepared(p, valid); }
                : undefined,
        }).then(r => {
            if ('error' in r && r.error) throw Object.assign(new Error(r.error), { kind: r.errorKind });
            return r;
        }).finally(() => combined.bitmap.close());
        call.catch(() => {});
        out = await Promise.race([call, attempt.cancelled.then(() => null)]);
    } catch (e) {
        note(`group ${group.map(p => `p${p.order}`).join(',')} llm ${(e as Error).message}`.slice(0, 200));
        if ((e as Error & { kind?: string }).kind === 'inference') sharedFailure = e;
        out = null;
    } finally {
        attempt.finish();
        attempts.delete(attempt);
        if (!call) combined.bitmap.close();
    }
    if (!valid()) { for (const p of prepared) releasePrepared(p); return; }
    if (sharedFailure) {
        for (const p of prepared) {
            try { await markFailed(p.page, p.item, sharedFailure, valid); }
            finally { releasePrepared(p); }
        }
        return;
    }
    if (!out) {
        // Per-page fallback: each page gets its own lease, so a stuck page costs itself.
        await Promise.all(prepared.map(p => withPageLease(p.page, p.item, valid, live => settlePrepared(p, snapshot, cacheEpoch, live))));
        return;
    }
    // Split the merged answer by box offsets: outputs back to each page's own numbering.
    let base = 0;
    for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        const count = p.det.boxes.length;
        const slice: TranslationResult = {
            outputs: out.outputs.filter(o => o.index > base && o.index <= base + count).map(o => ({ ...o, index: o.index - base })),
            extras: [],
            // A merged answer carries one <names> block with no page attribution: fold it
            // with the LAST page so every id it references exists by then.
            mentions: i === prepared.length - 1 ? out.mentions : [],
        };
        base += count;
        try { await commitPage(p, slice, valid); }
        catch (e) { await markFailed(p.page, p.item, e, valid); }
        finally { releasePrepared(p); }
    }
}

// One slot: snapshot for the group's first page, then a single page or a merged group. The
// snapshot is taken when the slot starts, so an earlier slot that already folded is included
// — slots roll by completion, not by waves.
async function runSlot(group: ChapterPage[], generation: number): Promise<void> {
    step('context', group.map(p => p.order + 1));
    const cacheEpoch = config.cacheEpoch ?? await cacheReady();
    const order = Math.min(...group.map(p => p.order));
    const sharing = config.shareContext;
    const snapshot = await contextFor(undefined, order);
    contextSharing.set(snapshot, sharing);
    if (generation !== epoch) return;
    if (group.length === 1) { await workSingle(group[0], snapshot, generation, cacheEpoch); return; }
    await runGroup(group, snapshot, generation, cacheEpoch);
}

function pumpCheck(): void {
    if (initialized && !pumping) void pump();
}
// pumpCheck is the only re-entry: pump() must never call itself while `pumping` is true.

// Chapter batching knobs. mergePages sends several pages in one request — crops stack into one
// tall bitmap, page mode leads with every page's annotated image (badges numbered globally).
// The split reading stage batches with the group too: one transcribe call for all its regions
// (per-region fallback instead when the model caps image count), then one text translate call.
function mergeSize(): number {
    return Math.max(1, Math.min(10, config.pipeline.mergePages || DEFAULT_PIPELINE_SETTINGS.mergePages));
}
// Slots bound how many groups work at once — the user's "sets". 6 is a memory guard.
function slotCount(): number {
    return Math.max(1, Math.min(6, config.pipeline.parallelLlm || DEFAULT_PIPELINE_SETTINGS.parallelLlm));
}

async function pump(): Promise<void> {
    if (!initialized || pumping || !['running', 'waiting'].includes(status.phase)) return;
    pumping = true;
    const generation = epoch;
    const release = keepaliveOpen();
    // Keep the inference worker (and every loaded model) alive for the whole active run: the
    // idle dispose between a long LLM wait and the next page used to force cold model/shader
    // loads page after page. When the run pauses or ends, the hold drops and the dispose runs.
    const releaseHost = holdInferenceHost();
    const slots = new Map<number, Promise<void>>();
    let seq = 0;
    let discovery: Promise<boolean> | null = null;
    let discoveryStopped = false;
    const inScope = (p: { id: string }): boolean => !config.requestedPages || config.requestedPages.includes(p.id);
    const phases = (): PagePhase[] => status.pages.map(p => inScope(p) ? pagePhase(p.phase) : 'paused');
    const hasQueued = (): boolean => phases().some(ph => ph === 'queued');
    const fill = (): void => {
        while (slots.size < slotCount()) {
            const group = nextGroup(phases(), config.pages, { size: mergeSize(), priority });
            if (!group.length) break;
            // Claim synchronously: a later fill must not hand the same pages to a second slot.
            for (const p of group) status.pages.find(s => s.id === p.id)!.phase = 'reading';
            void publish().catch(showFatal);
            const key = ++seq;
            slots.set(key, (async () => {
                try {
                    await runSlot(group, generation);
                } catch (e) {
                    stop('Translation paused — could not save chapter progress');
                    showFatal(e);
                } finally { slots.delete(key); }
            })());
        }
    };
    try {
        for (;;) {
            if (generation !== epoch || status.phase !== 'running') break;
            fill();
            if (!slots.size) {
                // Nothing in flight: either more pages exist to discover, or only
                // pixel-waiting pages remain (not a completion — the reader may still
                // materialize them).
                if (await discover(generation)) continue;
                // End-of-walk retry pass: timeout-class failures (RPC deadline, lease expiry)
                // are usually a transient GPU stall, and re-queueing here is exactly the work a
                // manual retry does. A paused run (shared fault) or a page that already spent
                // its retry never re-enters, so this cannot loop.
                if (generation === epoch && status.phase === 'running') {
                    const retry = pickRetryPages(status.pages.filter(inScope), autoRetry, retried);
                    if (retry.length) {
                        for (const p of retry) { retried.add(p.id); p.phase = 'queued'; }
                        note(`auto-retry ${retry.length} timed-out ${retry.length === 1 ? 'page' : 'pages'}`);
                        recordChapterLog(trace(retry.flatMap(p => p.order === undefined ? [] : [p.order + 1])),
                            { kind: 'retry', reason: 'auto-timeout' });
                        status.notice = `Retrying ${retry.length} timed-out ${retry.length === 1 ? 'page' : 'pages'}`;
                        setTimeout(() => {
                            if (status?.notice) { status.notice = undefined; void publish().catch(() => {}); }
                        }, 8000);
                        await publish();
                        continue;
                    }
                }
                break;
            }
            // Walk the reader ahead while pages translate, so a freed slot never waits on
            // discovery. Only when nothing is queued — the walk is a serial reader cursor.
            if (!config.requestedPages && !hasQueued() && !discovery && !discoveryStopped && config.nextDocument) {
                discovery = discover(generation).then(ok => {
                    if (!ok) discoveryStopped = true;
                    return ok;
                }).finally(() => { discovery = null; });
            }
            const wait: Promise<unknown>[] = [...slots.values()];
            if (discovery) wait.push(discovery);
            await Promise.race(wait);
        }
        if (slots.size) await Promise.allSettled([...slots.values()]);
        if (generation !== epoch) {
            for (const p of status.pages) if (['reading', 'detecting', 'translating', 'rendering'].includes(p.phase)) p.phase = 'queued';
            if (status.phase === 'stopping') status.phase = 'stopped';
        } else if (status.phase === 'running') {
            // Pixel-waiting pages are the reader's problem, not a failure of the run: the
            // chapter is complete when the manifest is complete and nothing is left to do.
            status.phase = config.requestedPages || status.pages.some(p => p.phase === 'paused')
                ? 'stopped' : config.completeManifest ? 'complete' : 'waiting';
            if (config.requestedPages) status.message = status.pages.filter(inScope).every(p => p.phase === 'ready')
                ? 'Page translation complete' : 'Page translation paused';
        }
        await publish();
    } catch (e) { stop('Translation paused — could not save chapter progress'); showFatal(e); }
    finally {
        pumping = false;
        release();
        releaseHost();
        if (status.phase === 'running') void pump();
        else releaseIdleDetector();
    }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id || msg?.type !== 'mt:chapter-command' || msg.id !== id) return;
    if (msg.command === 'settings-changed') {
        settingsStale = true;
        if (config) config.settingsStale = true;
        if (status) { status.settingsStale = true; stop('Translation paused — settings changed; start again to use them'); }
        respond({ ok: true });
        return;
    }
    if (!status) return;
    // Priority is a scheduling hint, not a progress update. It may arrive during setup,
    // but must neither start unconfigured work nor echo a status back to the reader.
    if (msg.command === 'prioritize') {
        priority = String(msg.page);
        pumpCheck();
        respond({ ok: true });
        return;
    }
    if (msg.command === 'stop') stop();
    if (msg.command === 'context') {
        config.shareContext = msg.shareContext === true;
        setShareContext(config.shareContext);
    }
    if (msg.command === 'stop-page') {
        const page = status.pages.find(p => p.id === String(msg.page));
        if (page && page.phase !== 'ready') {
            for (const attempt of attempts) {
                const members = attemptPages.get(attempt) ?? [];
                if (!members.includes(page.id)) continue;
                attempt.cancel();
                for (const p of status.pages) if (members.includes(p.id) && p.phase !== 'ready') {
                    pageEpochs.set(p.id, (pageEpochs.get(p.id) ?? 0) + 1);
                    p.phase = 'queued';
                }
            }
            pageEpochs.set(page.id, (pageEpochs.get(page.id) ?? 0) + 1);
            page.phase = 'paused';
        }
    }
    if (['retry', 'request', 'resume'].includes(msg.command) && (settingsStale || config.settingsStale)) {
        respond({ ok: false, error: 'Settings changed — start chapter translation again to use them' });
        return;
    }
    if (msg.command === 'resume') {
        if (typeof msg.shareContext === 'boolean') { config.shareContext = msg.shareContext; setShareContext(config.shareContext); }
        config.requestedPages = undefined;
        for (const p of status.pages) if (p.phase === 'failed' || p.phase === 'paused') p.phase = 'queued';
        status.phase = 'running'; status.message = undefined;
    }
    if (msg.command === 'retry' || msg.command === 'request') {
        if (typeof msg.shareContext === 'boolean') { config.shareContext = msg.shareContext; setShareContext(config.shareContext); }
        priority = String(msg.page);
        const page = status.pages.find(p => p.id === priority);
        if (page) {
            if (!['running', 'waiting'].includes(status.phase)) config.requestedPages = [page.id];
            else if (config.requestedPages && !config.requestedPages.includes(page.id)) config.requestedPages.push(page.id);
            if (msg.command === 'retry') { config.force ??= new Set(); config.force.add(page.id); }
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
    starveNoticeShown = false; // a new session re-arms the one-time notice
    step('generation');
    await cacheReady();
    step('debug');
    await initDebug(on => {
        if (!on) diagnostics.length = 0;
        else void enableChapterLog().catch(() => {});
    });
    step('config');
    const response = await sendToBackground<{ ok?: boolean; error?: string; config?: HostConfig }>(
        { type: 'mt:chapter-host-init', id }, { timeoutMs: 12_000, label: 'host init' });
    if (!response?.ok) throw new Error(response?.error || 'Chapter session expired');
    config = response.config!;
    logId = config.logId ?? logId;
    assertCacheCurrent(config.cacheEpoch ?? '');
    step('checkpoint');
    const checkpoint = await readRecord<HostCheckpoint>(`checkpoint:${id}`);
    if (checkpoint) config = { ...config, ...checkpoint.config };
    sourceLoader = new HashReaderSourceLoader(config.sourceRouting, source => {
        note('source routing: refreshing once');
        recordChapterLog(trace(), { kind: 'retry', reason: 'source' });
        return fetchHashReaderRouting(source);
    }, publish);
    assertCacheCurrent(config.cacheEpoch ?? '');
    // Restore before the first write; setup progress must not overwrite completed work.
    status = checkpoint?.progress ?? { id, logId, chapter: config.chapter, phase: 'running', done: 0, total: config.pages.length,
        inflight: 0, errors: 0, completeManifest: config.completeManifest,
        pages: config.pages.map(p => ({ id: p.id, url: p.url, order: p.order, phase: 'queued' })) };
    status.notice = undefined;
    await enableChapterLog().catch(() => {});
    // Fresh run: retry bookkeeping must not inherit a previous run's pages or spends.
    autoRetry.clear();
    retried.clear();
    for (const p of status.pages) if (['reading', 'detecting', 'translating', 'rendering'].includes(p.phase)) p.phase = 'queued';
    await publish();
    // The run uses the reader's captured settings; only fonts need asynchronous setup.
    step('fonts');
    await loadPipeline(config.pipeline);
    configureChapterHost(config.chapter, config.bookKey, config.pipeline, config.context);
    setShareContext(config.shareContext);
    // Storage-change events are optional: an offscreen document is given only the runtime
    // API, and the shim may not cover every area this build talks to. A missing event must
    // not take the whole run down.
    settingsStale ||= config.settingsStale === true || await readRecord<boolean>(`settings-stale:${id}`) === true;
    if (settingsStale) { config.settingsStale = true; status.settingsStale = true; stop('Translation paused — settings changed; start again to use them'); }
    await publish();
    initialized = true;
    recordChapterLog(trace(), { kind: 'setup-ready' });
    const ready = await sendToBackground<{ ok?: boolean; error?: string }>(
        { type: 'mt:chapter-runner-ready', id }, { timeoutMs: 12_000, label: 'runner ready' });
    if (!ready?.ok) throw new Error(ready?.error || 'Chapter session expired');
    pumpCheck();
}

// Entry point for a context that hosts this runner. Both Chromium's offscreen document
// and Firefox's background iframe load page.html, which calls it on load. Safe to call twice.
export async function attachChapterRunner(): Promise<void> {
    if (id) return;
    const reply = await sendToBackground<{ ok?: boolean; id?: string; logId?: string }>(
        { type: 'mt:chapter-runner-boot' }, { timeoutMs: 10_000, label: 'runner boot' });
    if (reply?.id) {
        logId = reply.logId ?? '';
        step('boot');
        await attach(reply.id);
    }
}

// A page loaded directly (offscreen document, background iframe, or a developer opening
// page.html) attaches itself; attaching twice is a no-op because `status` is already set.
void attachChapterRunner().catch(showFatal);
