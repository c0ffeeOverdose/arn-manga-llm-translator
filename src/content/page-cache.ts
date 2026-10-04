// Persistent translation cache: reopen a chapter → already-translated pages render from
// cache instead of paying detect + LLM again. Identity is the IMAGE CONTENT (downscaled
// hash), never the URL or page index — variants fail safe to a miss. Entries carry a
// settings fingerprint so changed settings re-translate instead of showing a stale page.
// One tiny store, LRU by access time, hard cap — no versioning, corrupt entries just miss.

import type { DetBox, DetectResult, InpaintPatch, MtOnStatus } from './detection';
import type { RegionOutput, ExtraRegion, Mention } from '../llm/core';
import { cacheReady, cacheGeneration, cacheCurrent } from '../cache-generation';

// ORT inference-queue picker (worker-side, pure): first hi-priority task (0), else the
// oldest — background lookahead/sweep inference yields to the page the user is waiting on.
export function pickInferIndex(q: { prio: 0 | 1 }[]): number {
    const i = q.findIndex(t => t.prio === 0);
    return i < 0 ? 0 : i;
}

export const CACHE_MAX = 200;
const HASH_SIZE = 48;

// Sliding-window canvas readers keep placeholder pages that draw real pixels only when
// approached. Each byte is compared to the first pixel's channel (±2 for downscale ringing).
// Pure — unit-tested below.
export function uniformPixels(d: Uint8ClampedArray): boolean {
    for (let i = 4; i < d.length; i++) if (Math.abs(d[i] - d[i & 3]) > 2) return false;
    return true;
}

// Status ownership: the pill is a VIEW of live activities, not a public write slot —
// parallel jobs / queued preps each own an entry, and this picker decides which one the user
// sees. Priority: user intent (force) → the page they're looking at (max viewport overlap)
// → background work (lookahead, sweep — tied, insertion order wins). Pure — unit-tested below.
export interface ActivityEntry {
    key: string;          // page key, or 'lookahead' / 'sweep'
    kind: 'force' | 'view' | 'lookahead' | 'sweep';
    overlap: number;      // viewport area px² (0 for background work)
}
export function pickActivity<T extends ActivityEntry>(entries: T[]): T | null {
    if (!entries.length) return null;
    const rank = { force: 0, view: 1, lookahead: 2, sweep: 2 } as const;
    let best = entries[0];
    for (const e of entries) {
        if (rank[e.kind] < rank[best.kind]
            || (rank[e.kind] === rank[best.kind] && e.overlap > best.overlap)) best = e;
    }
    return best;
}

// ---- chapter-sweep waiter registry: neutral ground so pipeline.ts can await a sweep-owned
// page without importing sweep.ts (which imports pipeline.ts — a direct edge would cycle).
let sweepWaiter: ((url: string, onStatus: MtOnStatus) => Promise<void>) | null = null;
export function registerSweepWaiter(fn: (url: string, onStatus: MtOnStatus) => Promise<void>): void {
    sweepWaiter = fn;
}
export function sweepWait(url: string, onStatus: MtOnStatus): Promise<void> {
    return sweepWaiter ? sweepWaiter(url, onStatus) : Promise.resolve();
}

// ---- lookahead-abort registry (same neutral-ground pattern): sweep.ts must not import
// auto.ts (auto imports sweep), but starting/stopping a sweep must stop a lookahead chain
// warming the same pages.
let lookaheadAbort: (() => boolean) | null = null;
export function registerLookaheadAbort(fn: () => boolean): void {
    lookaheadAbort = fn;
}
export function abortLookahead(): boolean {
    return lookaheadAbort ? lookaheadAbort() : false;
}

// ---- ordered commit: parallel workers finish out of order, but the book must fold
// page-by-page (updateContext is order-sensitive: pairs append, names are first-wins).
// Buffer results by chapter index and drain only the consecutive run from the head — every
// skipped/failed index still buffers a marker, or the head stalls behind it forever.
// Mutates the map (consumes). Pure — unit-tested below.
export function takeOrdered<T>(ready: Map<number, T>, head: number): { items: T[]; head: number } {
    const items: T[] = [];
    while (ready.has(head)) {
        items.push(ready.get(head)!);
        ready.delete(head);
        head++;
    }
    return { items, head };
}

// Sweep lifecycle phase (pure — popup/pill label + unit tests). `starting` is the
// enumeration window before a run object exists: cancel must be possible there too.
export function sweepPhase(s: { cancel: boolean; dead: boolean; starting?: boolean } | null): 'idle' | 'starting' | 'running' | 'stopping' | 'dead' {
    if (!s) return 'idle';
    if (s.dead) return 'dead';
    if (s.cancel) return 'stopping';
    return s.starting ? 'starting' : 'running';
}

// ---- pool sizing: canvas work is bound by the page's renderer thread, not by the provider.
// Cloud mode keeps the sweep pool (the endpoint serves requests in parallel); local CPU
// inference is serialized behind the worker's ORT lock anyway, so extra workers only multiply
// main-thread decode/encode spikes. Painting is local CPU everywhere: parallel lanes are pure
// jank without a GPU. Pure — unit-tested.
export function sweepPoolSize(cloud: boolean, gpu: boolean, detEpWasm: boolean): number {
    if (cloud) return 3;
    return !gpu || detEpWasm ? 2 : 3;
}
export function paintLaneSize(gpu: boolean): number {
    return gpu ? 3 : 1;
}

// Split a region list for one request. The caller picks the size: the whole page first, then
// halved per observed starvation (`nextChunkSize`) — there is no fixed per-request cap. Pure.
export function regionChunks<T>(regions: T[], size: number): T[][] {
    if (!regions.length || size < 1) return [];
    const out: T[][] = [];
    for (let i = 0; i < regions.length; i += size) out.push(regions.slice(i, i + size));
    return out;
}

// After a starved (empty/formatless) reply at this size, halve it; one region is the floor.
export function nextChunkSize(failed: number): number {
    return Math.max(1, Math.floor(failed / 2));
}

// LLM request images for one chunk. Page mode leads with the annotated full page(s); crops
// follow positionally — the chunk prompt promises that order, so a dropped page shifts every
// crop by one and starves the last region. A violating call throws instead of sending a lying
// brief. Pure — unit tested.
export function requestImages(o: { mode: 'crops' | 'page'; pages: string[]; crops: (string | undefined)[] }): string[] {
    if (o.crops.some(c => !c)) throw new Error('requestImages: every region must own its crop image');
    const order = o.crops as string[];
    if (o.mode === 'crops') return [...order];
    if (!o.pages.length) throw new Error('requestImages: page mode must lead with the annotated page');
    return [...o.pages, ...order];
}

export interface CachedPage {
    cacheEpoch?: string;
    key: string;      // chapter#contentHash — bytes identity: which pixels this was made from
    fp: string;       // settings fingerprint at translate time
    w: number; h: number; // full-page dims — must still match (cheap second gate)
    atime: number;    // last hit, for LRU
    boxes: DetBox[];
    panels: DetBox[];
    outputs: RegionOutput[];
    extras: ExtraRegion[];
    mentions?: Mention[]; // page-level named people — absent on entries written before mentions existed
    // downscaled CTD mask (see packMask) — without it a cache hit renders with an empty mask
    // and inpaint erases nothing. Optional so pre-mask entries just miss once and heal.
    mask?: { w: number; h: number; data: ArrayBuffer };
    // detect checkpoint (no outputs yet): a page-turn kills the translating document mid-job —
    // the next load resumes at translation from this entry instead of re-paying detect.
    // Overwritten by the full entry under the same key; never renders as Done.
    partial?: true;
    // OCR texts aligned 1:1 with boxes (cloud path carries them at checkpoint time).
    texts?: string[];
    // detector EP at checkpoint time — restored so the Done line stays honest
    ep?: string;
    // cloud path: the server's box-split generation (server/split.py SPLIT_GEN) — cache
    // entries from older servers hold fused boxes and must re-detect
    splitGen?: number;
    // AI text cleanup output: one erased-background crop per erase box, drawn in place of
    // the built-in fill. patchesGen tags the pipeline version so old crops are regenerated.
    patches?: { x1: number; y1: number; x2: number; y2: number; png: ArrayBuffer }[];
    patchesGen?: number;
    // partial-only: cloud cleanup patches checkpointed with the detection (i = index into
    // `boxes`) — restored by detFromPartial so a resumed job skips the /v1/inpaint roundtrip.
    // Full entries never carry this.
    cpatches?: InpaintPatch[];
    // page identity: the chapter order this entry belongs to, and the scheme generation.
    // An entry without these was written under bytes identity (legacy) and must not be
    // matched by page-identity lookups.
    order?: number;
    keyGen?: number;
}

// Bump when the AI-cleanup crop pipeline changes (window geometry, model, mask recipe,
// composite) — cached patches with a different generation are regenerated.
export const INPAINT_PATCH_GEN = 4;

// Bump when the server's box-splitting changes (server/split.py SPLIT_GEN): cloud entries
// below this hold fused boxes (gen 0), box-filled stand-in masks (gen 1), missed
// overlap-swallowed text (gen 2), fused stacked groups (gen 3), splits vetoed by weak
// comps (gen 5), single vertical-text balloons split by square glyph comps (gen 6), diagonal masses
// left fused by a sub-floor gap (gen 7), a cut slicing one shared text row (gen 8),
// or an SFX tail merged into speech (gen 9) — all
// re-detect instead of rendering from cache. Local entries never carry splitGen (their tile
// fingerprint already forces re-detect) — isCloud scopes the gate to cloud mode.
export const CLOUD_SPLIT_GEN = 10;
export function cloudSplitFresh(hit: { ep?: string; splitGen?: number } | undefined, isCloud: boolean): boolean {
    return !isCloud || (hit?.splitGen ?? 0) >= CLOUD_SPLIT_GEN;
}

// CTD masks are full-page 1 byte/px (~MBs) — too big for IDB at 200 pages. packMask
// block-maxes it to ≤maxSide (~45KB/page); unpackMask nearest-neighbor upscales back.
// inpaint tolerates the coarse mask — it only needs to know WHICH rows carry text, and
// block-max never drops a text pixel the full mask had.
export function packMask(
    mask: { width: number; height: number; data: ArrayBuffer }, maxSide = 256,
): { w: number; h: number; data: ArrayBuffer } {
    const { width: W, height: H } = mask;
    const step = Math.max(1, Math.floor(Math.max(W, H) / maxSide));
    const w = Math.ceil(W / step), h = Math.ceil(H / step);
    const src = new Uint8Array(mask.data);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let v = 0;
            const y1 = Math.min(y * step + step, H), x1 = Math.min(x * step + step, W);
            for (let yy = y * step; yy < y1; yy++)
                for (let xx = x * step; xx < x1; xx++) {
                    const p = src[yy * W + xx];
                    if (p > v) v = p;
                }
            out[y * w + x] = v > 127 ? 255 : 0;
        }
    }
    return { w, h, data: out.buffer as ArrayBuffer };
}

export function unpackMask(
    packed: { w: number; h: number; data: ArrayBuffer }, W: number, H: number,
): ArrayBuffer {
    const src = new Uint8Array(packed.data);
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        const sy = Math.min(packed.h - 1, Math.floor(y * packed.h / H));
        for (let x = 0; x < W; x++) {
            const sx = Math.min(packed.w - 1, Math.floor(x * packed.w / W));
            out[y * W + x] = src[sy * packed.w + sx];
        }
    }
    return out.buffer as ArrayBuffer;
}

// ---- detect checkpoints: a partial entry (boxes, no outputs) is resumable when fingerprint
// + dims still match and it carries a mask. Full entries never resume (they render from
// cache); stale partials re-detect. Pure.
export function isResumable(hit: CachedPage | undefined, fp: string, w: number, h: number, isCloud: boolean): hit is CachedPage {
    return !!hit && hit.partial === true && hit.fp === fp
        && hit.w === w && hit.h === h && hit.boxes.length > 0 && !!hit.mask
        && cloudSplitFresh(hit, isCloud);
}

// Can a page-identity entry be used for the bytes we are holding? The translation, the
// detection and the rendered image do not depend on which encoder/host/tier produced the
// pixels, so a differing content hash is NOT a reason to discard them. Only the AI-cleanup
// crops are made of erased pixels and must come from the same bytes.
//
// `hash` is the current bytes' content hash ('' when unknown — a runner that could not read
// them). A mismatch is tolerated; the caller drops `patches` and re-derives them.
export interface PageKeyDecision {
    usable: boolean;
    // the crops must be recomputed: they were made from different pixels
    dropPatches: boolean;
    reason: 'ok' | 'no-entry' | 'legacy' | 'fingerprint' | 'dims' | 'partial';
}
export function pageEntryDecision(
    hit: CachedPage | undefined, hash: string, fp: string, w: number, h: number,
): PageKeyDecision {
    if (!hit) return { usable: false, dropPatches: false, reason: 'no-entry' };
    // Written before page identity existed: keyed by bytes, so a hash change means the work
    // may belong to different pixels. Refuse rather than guess.
    if (hit.keyGen !== PAGE_KEY_GEN) return { usable: false, dropPatches: false, reason: 'legacy' };
    if (hit.fp !== fp) return { usable: false, dropPatches: false, reason: 'fingerprint' };
    // Page dims are stable across encoders of the same page; a real change means a different
    // page landed in this slot, which page identity alone cannot detect.
    if (hit.w !== w || hit.h !== h) return { usable: false, dropPatches: false, reason: 'dims' };
    if (hit.partial === true) return { usable: false, dropPatches: false, reason: 'partial' };
    const sameBytes = !!hash && hit.key.slice(hit.key.lastIndexOf('#') + 1) === hash;
    return { usable: true, dropPatches: !sameBytes, reason: 'ok' };
}

// Crops for an identity hit whose own crops were dropped: the caller fetched the bytes entry
// under the LIVE content hash, so its crops were made from exactly these pixels — reuse them
// when the pipeline generation, fingerprint and dims still agree. Without this the cleanup
// model re-ran on every reopen of a chapter-translated page (identity entries carry no crops).
// Pure — unit-tested.
export function bytesCrops(hit: CachedPage | undefined, fp: string, w: number, h: number):
{ patches: NonNullable<CachedPage['patches']>; patchesGen: number } | null {
    if (!hit?.patches?.length || hit.patchesGen !== INPAINT_PATCH_GEN) return null;
    if (hit.fp !== fp || hit.w !== w || hit.h !== h) return null;
    return { patches: hit.patches, patchesGen: hit.patchesGen };
}

// rebuild a live DetectResult from a resumable partial — ordered boxes, panels, mask and
// texts come back as detect produced them (ordering is NOT re-run: it already ran before the
// checkpoint). Texts ride the cloudTexts slot: translateRegions treats any present texts as
// ready and skips local OCR. Returns null on a maskless entry.
export function detFromPartial(hit: CachedPage, w: number, h: number): DetectResult | null {
    if (!hit.mask) return null;
    return {
        boxes: hit.boxes, panels: hit.panels ?? [],
        mask: { width: w, height: h, data: unpackMask(hit.mask, w, h) },
        inferMs: 0, ep: hit.ep ?? 'cache', dropped: [], panelDropped: [],
        ...(hit.texts?.length ? { cloudTexts: hit.texts } : null),
        // server-computed cleanup patches already paid for in the detect roundtrip — a resumed
        // job must not re-pay /v1/inpaint for them
        ...(hit.cpatches?.length ? { cloudPatches: hit.cpatches } : null),
        ...(hit.splitGen != null ? { splitGen: hit.splitGen } : null),
    };
}

// cached full entry → render-ready det (shared by preparePage, arrival paint and the chapter
// runner).
// Null unless: full entry + fingerprint + dims + mask + split generation — the ONE gate for
// "this entry renders as-is"; callers must not re-derive it with a weaker test (a splitGen-
// stale entry that passed a weaker guard handed a null det to the renderer).
export function detFromCacheEntry(
    hit: CachedPage | undefined, fp: string, w: number, h: number, isCloud: boolean,
): DetectResult | null {
    if (!hit || hit.partial || hit.fp !== fp || hit.w !== w || hit.h !== h || !hit.mask || !cloudSplitFresh(hit, isCloud)) return null;
    return {
        boxes: hit.boxes, panels: hit.panels,
        mask: { width: w, height: h, data: unpackMask(hit.mask, w, h) },
        inferMs: 0, ep: 'cache', dropped: [], panelDropped: [],
        // the entry's generation rides along: a cache-hit render re-persists the crops, and
        // dropping this downgraded the entry to gen 0 (unusable on the next visit).
        ...(hit.splitGen != null ? { splitGen: hit.splitGen } : null),
    };
}

// split-pipeline fallback: the transcribe already ran when the channel died — stamp its texts
// onto the regions so the re-sent call is a text-only translate instead of a second (billed)
// transcription. Short lists keep the caller's own source. Pure.
export function withSources<T extends { source: string }>(regions: T[], texts: string[]): T[] {
    return regions.map((r, i) => ({ ...r, source: texts[i] ?? r.source }));
}

// checkpoint writer input (same key the full entry later overwrites). Pure.
export function partialEntry(key: string, fp: string, det: DetectResult, w: number, h: number): Omit<CachedPage, 'atime'> {
    return {
        key, fp, w, h,
        boxes: det.boxes, panels: det.panels ?? [],
        outputs: [], extras: [],
        texts: det.cloudTexts ?? [],
        // det is POST-ordering here, so cloudPatches.i already matches
        // hit.boxes positions — restore is a straight passthrough
        ...(det.cloudPatches?.length ? { cpatches: det.cloudPatches } : null),
        ep: det.ep,
        splitGen: det.splitGen ?? 0,
        mask: packMask(det.mask),
        partial: true as const,
    };
}

// cyrb53 over raw gray bytes — 10 lines, no dependency, hex output
export function hashPixels(data: ArrayLike<number>): string {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < data.length; i++) {
        const b = data[i] & 0xff;
        h1 = Math.imul(h1 ^ b, 2654435761);
        h2 = Math.imul(h2 ^ b, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

// content hash of a page: downscale to 48x48 gray, hash the bytes (~1-2ms).
export function pageHashFromBitmap(bitmap: ImageBitmap): string {
    const c = new OffscreenCanvas(HASH_SIZE, HASH_SIZE);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, HASH_SIZE, HASH_SIZE);
    const d = ctx.getImageData(0, 0, HASH_SIZE, HASH_SIZE).data;
    const gray = new Uint8Array(HASH_SIZE * HASH_SIZE);
    for (let i = 0; i < gray.length; i++) {
        gray[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    }
    return hashPixels(gray);
}

export function cacheKey(chapter: string, hash: string): string {
    return `${chapter}#${hash}`;
}

// ---- page identity vs bytes identity (they are different questions).
//
//   cacheKey(chapter, hash)  "which pixels is this work made from"  — bytes identity
//   pageKey(chapter, order)  "which page in the chapter is this"    — page identity
//
// A reader may serve the same page from another CDN host, another encoder, or the
// data-saver tier: the bytes change while the page does not. Keying the expensive, bytes-
// independent work (translation, detection, the rendered image) on bytes identity made
// those change a MISS, so the same page was re-translated — and the reader, reading under
// its own hash, never saw the chapter's result at all. Translation does not depend on which
// JPEG the CDN chose, so it is keyed by page identity; only the AI-cleanup crops, which are
// literally erased pixels, stay on bytes identity.
export function pageKey(chapter: string, order: number): string {
    return `${chapter}@p${order}`;
}

// Marks an entry written under page identity (as opposed to a legacy bytes-keyed entry).
// Bumped when the identity scheme changes so stale entries never mix schemes.
export const PAGE_KEY_GEN = 1;

// Story identity for multi-site use: origin + path + query + hash, minus obvious page-turn
// suffixes. Page-turns share a key (queue + context survive flipping pages); anything else
// differing = a new story. Pure — unit-tested below; chapterKey() is the thin location wrapper.
export function normalizeChapterKey(origin: string, path: string, search: string, hash: string): string {
    // Chapter readers fold page-turns to the chapter: the segment after /chapter/ names the
    // CHAPTER, never the page. Keep it, drop the rest.
    const m = path.match(/^(.*\/chapter\/[^/]+)/);
    if (m) return origin + m[1];
    // Purely-numeric hashes (#2, #2-3 spread) are page turns — but only when the path already
    // carries an identifier (a digit). A digit-less path with a numeric hash may BE using the
    // hash as the story id, so those still compare exactly: fail-split stands, no per-site rules.
    if (/\d/.test(path) && /^#\d+(-\d*)?$/.test(hash)) {
        hash = '';
    }
    // generic paged readers: a trailing /N under a nested path is a page turn. Depth guard: a
    // shallow /manga/1 may BE the story id — only strip at depth ≥3. Fail direction is a split
    // (lost continuity), never a merge (mixed stories).
    const segs = path.split('/').filter(Boolean);
    let p = (segs.length >= 3 && /^\d+$/.test(segs[segs.length - 1]))
        ? '/' + segs.slice(0, -1).join('/')
        : path.replace(/\/$/, '');
    if (!p) p = '/';
    // ?page=/&p=/&pg= are page turns; every other param may carry the chapter
    const sp = new URLSearchParams(search);
    sp.delete('page'); sp.delete('p'); sp.delete('pg');
    const q = sp.toString();
    // SPA hash routes name the story — compared EXACTLY, never stripped: a numeric tail may be
    // the story id, and a split only loses continuity while a merge contaminates.
    return origin + p + (q ? '?' + q : '') + hash;
}

// Page number encoded in a reader URL when its own chapter key folds it away. Explicit paged
// shapes (/chapter|read/<id>/N) first; otherwise the trailing numeric segment when removing it
// yields EXACTLY the chapter key we are on — the same guard normalizeChapterKey uses for page
// turns. null when unsure: a guessed slot must never authorize a paint, only hint a lookup.
export function readerPageNumber(origin: string, pathname: string, search: string, hash: string, chapter: string): number | null {
    const explicit = pathname.match(/\/(?:chapter|read)\/[^/]+\/(\d+)(?:\/|$)/);
    if (explicit) {
        const n = Number(explicit[1]);
        return n > 0 ? n : null;
    }
    // A hash-paged reader states its position in the fragment (`#4`, spread `#4-5`). It is a
    // page turn only when the path itself carries the chapter id AND folding the fragment away
    // lands exactly on the chapter key — a digit-less stem may be using the hash AS the story
    // id, so those still refuse (fail direction is a split).
    const h = /^#(\d+)(?:-\d*)?$/.exec(hash);
    if (h) {
        const n = Number(h[1]);
        if (n > 0 && /\d/.test(pathname) && normalizeChapterKey(origin, pathname, search, hash) === chapter) return n;
    }
    const segs = pathname.split('/').filter(Boolean);
    if (segs.length < 3) return null;
    const tail = segs[segs.length - 1];
    if (!/^\d+$/.test(tail)) return null;
    const stem = segs.slice(0, -1).join('/');
    // A digit-less stem may be using /9 AS the story id; fail-split stands.
    if (!/\d/.test(stem)) return null;
    if (normalizeChapterKey(origin, '/' + stem, search, hash) !== chapter) return null;
    const n = Number(tail);
    return n > 0 ? n : null;
}

// ---- story identity for readers we do not know ----
// The character book should span the chapters of one story. URL-first and deterministic; a
// breadcrumb link is only the fallback and the title source (state.ts wires it). Fail direction
// is a split (null → chapter scope), never a merge, so every guard below rejects anything
// ambiguous. Generic URL vocabulary only — no site names.
const NAV_SEGMENT = /^(?:read|view|watch|list|page|pages)$/i;
// listing/navigation vocabulary is never a story container, wherever it appears
const NAV_ANYWHERE = /^(?:genre|genres|tag|tags|author|authors|artist|artists|group|groups|search|popular|latest|browse|category|categories)$/i;
const isNavPath = (segs: string[]): boolean =>
    segs.some(s => NAV_ANYWHERE.test(s)) || NAV_SEGMENT.test(segs[segs.length - 1] ?? '');
const CHAPTER_WORD = /^(?:chapter|ch|episode|ep)[-_]?\d+$/i;
const UUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The story path (origin-relative) a reader URL names, or null when it does not. The caller
// compares the result with its own chapter key: an unchanged result is not a story signal.
export function deriveStoryPath(path: string, search: string): string | null {
    let segs = path.split('/').filter(Boolean);
    if (!segs.length) return null;
    for (;;) {
        // /series/abc/chapter/12 — the container names the chapter, everything before it the story
        // (and only the container decides where the story ends: a numeric tail there is the
        // story id, like /title/4, not another chapter number)
        const container = ('/' + segs.join('/')).match(/^(.*)\/(?:chapter|episode|ep|ch)\/[^/]+$/i);
        if (container) {
            segs = container[1].split('/').filter(Boolean);
            break;
        }
        const last = segs[segs.length - 1];
        // trailing numbers/uuids are chapter or page numbers — strip down to depth 2 (never the
        // last segment of a 2-segment path: /read/12345 must keep its story id)
        if (segs.length > 2 && (/^\d+$/.test(last) || UUID_SEG.test(last))) { segs.pop(); continue; }
        // a glued chapter word: chapter-12, ch_3, ep5
        if (segs.length > 2 && CHAPTER_WORD.test(last)) { segs.pop(); continue; }
        break;
    }
    if (segs.length < 2) return null;
    if (isNavPath(segs)) return null;
    // chapter-ish query params name the chapter; page params never belong to a story key
    const sp = new URLSearchParams(search);
    for (const k of ['page', 'p', 'pg', 'chapter', 'ch', 'ep', 'episode', 'vol', 'volume']) sp.delete(k);
    const q = sp.toString();
    return '/' + segs.join('/') + (q ? '?' + q : '');
}

export interface SeriesLink { path: string; title?: string }

// The best same-origin link that is a strict prefix of the current page: the reader's own
// breadcrumb back to the story. Returns the normalized path plus the link text (the title).
export function pickSeriesLink(currentHref: string, links: { href: string; text: string }[]): SeriesLink | null {
    let cur: URL;
    try { cur = new URL(currentHref); } catch { return null; }
    let best: SeriesLink | null = null;
    for (const l of links) {
        let u: URL;
        try { u = new URL(l.href, cur); } catch { continue; }
        if (u.origin !== cur.origin) continue;
        const p = u.pathname.replace(/\/+$/, '');
        const segs = p.split('/').filter(Boolean);
        if (segs.length < 2) continue;
        if (isNavPath(segs)) continue;
        // strict prefix at a segment boundary — the page itself is not its own series
        if (!cur.pathname.startsWith(p + '/')) continue;
        if (!best || p.length > best.path.length) {
            const title = l.text.replace(/\s+/g, ' ').trim().slice(0, 80);
            best = { path: p, title: title || undefined };
        }
    }
    return best;
}

// The book scope for a reader page: the URL-derived story when it is strictly shorter than the
// chapter key, or the chapter key itself when a breadcrumb link confirms it as the story page
// (promotion only changes storage lifetime, not grouping). Anything else is null → chapter
// scope, the fail-safe. A hash is never dropped: it may BE the story id.
export function pickStoryScope(origin: string, path: string, search: string, chapter: string, link: SeriesLink | null): string | null {
    if (chapter.includes('#')) return null;
    const derived = deriveStoryPath(path, search);
    const fromUrl = derived ? origin + derived : null;
    const fromLink = link ? origin + link.path : null;
    const candidate = fromUrl ?? fromLink;
    if (!candidate) return null;
    if (candidate === chapter) return fromLink === chapter ? chapter : null;
    return candidate;
}

// ---- hotlink Referer rule: some image CDNs refuse a request without a page Referer — and an
// MV3 service worker cannot send one (Chrome strips referrer from SW fetch silently), so the
// SW proxy fails where a plain <img> loads fine. Some answer 403, MangaDex's network answers
// 404, and other CDNs require it too. Fix at the network layer: a declarativeNetRequest session
// rule sets the header for fetches to these hosts. The static list below is the known guard
// set; `hosts` extends it with the hosts of the chapter's OWN page URLs (their leading label
// is the shard/edge name, the rule covers the domain family) — no domain literals for new
// readers, and the caller can only widen which requests get a Referer, never its value.
// Pure builder — the background installs it; unit-tested below.
export const HOTLINK_RULE_ID = 1001;
function hotlinkDomain(host: unknown): string | null {
    if (typeof host !== 'string') return null;
    const h = host.trim().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(h) || h.startsWith('.') || h.endsWith('.') || h.includes('..')) return null;
    const parts = h.split('.');
    if (parts.length < 2 || parts.some(p => !p.length || p.length > 63)) return null;
    return parts.length >= 3 ? parts.slice(1).join('.') : h;
}
export function hotlinkRule(origin: string, hosts: string[] = []): object {
    const base = '2xstorage\\.com|waitst\\.com|uploads\\.mangadex\\.org|mangadex\\.network';
    const extra = [...new Set(hosts.map(hotlinkDomain).filter((d): d is string => !!d))].sort().slice(0, 8)
        .map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return {
        id: HOTLINK_RULE_ID,
        priority: 1,
        action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Referer', operation: 'set', value: origin + '/' }],
        },
        condition: {
            // SW/offscreen fetch() surface as xmlhttprequest; <img> loads need no help. The
            // optional subdomain group covers host rotation (img-r2.2xstorage.com, cmdx….mangadex.network);
            // the optional port keeps local fixtures (and origin-scoped edges) matchable.
            regexFilter: `^https://([^/]+\\.)?(${base}${extra.length ? '|' + extra.join('|') : ''})(?::\\d+)?/`,
            resourceTypes: ['xmlhttprequest'],
        },
    };
}

// A referer-less fetch is refused as 403 by some CDNs and as 404 by others (MangaDex's
// network) — both warrant the session-rule retry. Pure — unit-tested.
export function hotlinkRetryable(error: string | undefined): boolean {
    return /^image HTTP (403|404)$/.test(error ?? '');
}

// ---- mt:fetch-image policy: the SW fetch is CORS-exempt under host_permissions, so without
// a guard it doubles as a read-anything proxy for whatever URL a page plants in an <img> —
// including local-network services whose response pixels flow back into the rendered page.
// http(s) only; private/loopback targets only when the requesting page itself sits on that host.
// Pure — enforced on BOTH the request URL and the post-redirect response URL; unit-tested below.
function privHost(h: string): boolean {
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
        const [a, b] = h.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    }
    // IPv4-mapped IPv6 — ::ffff:127.0.0.1 (dotted) or ::ffff:7f00:1 (hex tail)
    const m = h.match(/^::ffff:(.+)$/);
    if (m) {
        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(m[1])) return privHost(m[1]);
        const g = m[1].split(':');
        if (g.length === 2 && g.every(x => /^[0-9a-f]{1,4}$/.test(x))) {
            const n = (parseInt(g[0], 16) << 16) | parseInt(g[1], 16);
            return privHost(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
        }
        return false;
    }
    if (h === '::' || h === '::1') return true;
    if (/^fe[89ab][0-9a-f:]*$/.test(h)) return true; // link-local fe80::/10
    if (/^f[cd][0-9a-f:]*$/.test(h)) return true;    // ULA fc00::/7
    return false;
}
export function fetchImageBlocked(url: string, senderUrl: string): string | null {
    let u: URL;
    try { u = new URL(url); } catch { return 'invalid url'; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'scheme';
    // lowercase + strip brackets + trailing dot (WHATWG URL already normalizes exotic IPv4 forms)
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!privHost(host)) return null;
    let pageHost = '';
    try { pageHost = new URL(senderUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); } catch { /* no sender — treat as foreign */ }
    const norm = (h: string) => (h === 'localhost' || h === '::1' ? '127.0.0.1' : h);
    return norm(pageHost) === norm(host) ? null : 'local network';
}

// ---- single-image-reader off-DOM lookahead: these readers keep ONE <img> in the DOM (the
// current page), so a DOM-driven prefetch window can never see ahead. But they embed the whole
// gallery manifest in the page (a JSON script whose body holds pages[].path), so sibling URLs
// are derivable with zero extra fetches: current-img host + manifest path. Pure — caller passes
// the script text (or null when absent); returns absolute URLs AFTER the current page only
// (forward-only — prefetch never burns LLM on pages behind). Unit-tested below.
export function galleryAheadUrls(manifestJson: string | null, imgHost: string, curPath: string, max: number): string[] {
    if (!manifestJson || !imgHost || !curPath || max <= 0) return [];
    const paths = galleryPaths(manifestJson);
    const i = paths.indexOf(curPath);
    if (i < 0) return [];
    return paths.slice(i + 1, i + 1 + max).map((p) => `${imgHost}/${p}`);
}

// ---- paged-chapter enumeration: paged readers virtualize the DOM, so DOM refs undercount
// the chapter. Paged-reader APIs return the full page list; the parse + URL builder stay pure
// for tests, the fetch + DOM walk live in page-io (untestable — document/chrome access).
export function pagedChapterUuid(pathname: string, hostname: string): string | null {
    if (!/(^|\.)mangadex\./.test(hostname)) return null;
    const m = pathname.match(/^\/chapter\/([^/]+)/);
    // charset-gated: the id is interpolated into an API URL below
    return m && /^[0-9a-f-]{10,}$/i.test(m[1]) ? m[1] : null;
}

// Page filenames out of whatever shape a reader's chapter endpoint returns: a bare array,
// an array under a common key, or an object list of {name|file|path}. Anything else is
// junk and yields [] so the caller keeps its DOM fallback. Pure — unit-tested.
const CHAPTER_FILE_KEYS = ['pages', 'images', 'files', 'data', 'items'];
export function readerChapterFiles(payload: unknown): string[] {
    let list: unknown = payload;
    if (list && typeof list === 'object' && !Array.isArray(list)) {
        const obj = list as Record<string, unknown>;
        for (const key of CHAPTER_FILE_KEYS) if (Array.isArray(obj[key])) { list = obj[key]; break; }
        // one level of envelope: { data: { pages: [...] } }
        if (!Array.isArray(list)) {
            for (const value of Object.values(obj)) {
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    const nested = readerChapterFiles(value);
                    if (nested.length) return nested;
                }
            }
        }
    }
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const item of list) {
        const name = typeof item === 'string' ? item
            : item && typeof item === 'object'
                ? String((item as Record<string, unknown>).name ?? (item as Record<string, unknown>).file
                    ?? (item as Record<string, unknown>).path ?? (item as Record<string, unknown>).src ?? '')
                : '';
        // A URL already absolute is kept; a bare filename is joined by the caller.
        const clean = name.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+/, '');
        if (clean && !clean.includes('..') && !out.includes(clean)) out.push(clean);
    }
    return out;
}
export function buildPagedUrls(baseUrl: unknown, hash: unknown, files: unknown, kind: 'data' | 'data-saver' = 'data'): string[] {
    if (typeof baseUrl !== 'string' || typeof hash !== 'string' || !Array.isArray(files)) return [];
    if (kind !== 'data' && kind !== 'data-saver') return [];
    const b = baseUrl.replace(/\/+$/, '');
    const out: string[] = [];
    for (const f of files) {
        if (typeof f !== 'string' || !f || f.includes('/') || f.includes('\\')) continue;
        out.push(`${b}/${kind}/${hash}/${f}`);
    }
    return out;
}

// unloaded-but-addressable pages: lazy <img> with an http(s) src and no pixels yet. Loaded
// ones are covered by getPages refs; known dedupes against those + each other. data:/empty/
// blob: srcs are unusable headless — skip.
export function unloadedPageUrls(cands: { src: string; loaded: boolean }[], known: Set<string>): string[] {
    const out: string[] = [];
    for (const c of cands) {
        if (c.loaded) continue;
        if (!/^https?:/.test(c.src) || known.has(c.src)) continue;
        known.add(c.src);
        out.push(c.src);
    }
    return out;
}

// chapter sweep needs the WHOLE list in reading order (not just forward of an anchor), plus
// where the current page sits in it. Same parser, same bails — index -1 on no match.
export function galleryAllUrls(manifestJson: string | null, origSrc: string): { urls: string[]; index: number } {
    const m = origSrc.match(/^(https?:\/\/[^/]+)\/(.+)$/);
    if (!m) return { urls: [], index: -1 };
    const paths = galleryPaths(manifestJson);
    return { urls: paths.map((p) => `${m[1]}/${p}`), index: paths.indexOf(m[2]) };
}

function galleryPaths(manifestJson: string | null): string[] {
    if (!manifestJson) return [];
    try {
        const inner = JSON.parse(JSON.parse(manifestJson).body);
        const pages = inner?.pages;
        if (!Array.isArray(pages)) return [];
        const paths: string[] = [];
        for (const p of pages) if (typeof p?.path === 'string') paths.push(p.path);
        return paths;
    } catch { return []; }
}

// Sibling URLs for the lookahead window. Siblings derive from the STORED original (https):
// the live element src is a blob: URL once translated, so deriving from it yields nothing.
// Non-https input yields [] by construction.
export function galleryLookaheadUrls(manifestJson: string | null, origSrc: string, max: number): string[] {
    const m = origSrc.match(/^(https?:\/\/[^/]+)\/(.+)$/);
    if (!m) return [];
    return galleryAheadUrls(manifestJson, m[1], m[2], max);
}

// ---- hash-listed single-image readers: one page image on screen, the whole chapter published
// as a JS assignment (`var <name> = {...}` from the reader's CDN) whose files[] name every page
// by content hash. Full art sits on numbered CDN shards chosen per file, so the displayed
// page's own URL teaches the build prefix and shard family; a file's shard NUMBER is not in the
// manifest and rides as an alternate for the existing one-shot sibling retry. Pure — unit-tested.
export interface HashReaderFile { hash: string; avif: boolean }

// Reader route shape `/reader/<id>.html` names the id the manifest is fetched by. A route gate
// only — the manifest must still parse before anything is enumerated.
export function hashReaderId(pathname: string): string | null {
    const m = pathname.match(/^\/reader\/(\d+)\.html$/);
    return m ? m[1] : null;
}

// files[] out of the CDN's `var <name> = {...};` payload. ONE unusable row refuses the whole
// list: enumeration indexes parity with the reader's own page numbers, so a skipped row would
// silently shift every later page. [] keeps the DOM fallback.
export function hashReaderFiles(manifestJs: string | null): HashReaderFile[] {
    if (!manifestJs) return [];
    const from = manifestJs.indexOf('{');
    const to = manifestJs.lastIndexOf('}');
    if (from < 0 || to <= from) return [];
    try {
        const list = (JSON.parse(manifestJs.slice(from, to + 1)) as { files?: unknown }).files;
        if (!Array.isArray(list) || !list.length) return [];
        const out: HashReaderFile[] = [];
        for (const row of list) {
            const hash = (row as { hash?: unknown } | null)?.hash;
            if (typeof hash !== 'string' || !/^[0-9a-f]{16,}$/i.test(hash)) return [];
            out.push({ hash, avif: !!(row as { hasavif?: unknown }).hasavif });
        }
        return out;
    } catch { return []; }
}

// Full-size page URLs derived from one DISPLAYED image. The sample path must be
// `/<build>/<tail-swap>/<hash>.<ext>` on a `<letter><number>.<domain>` host whose letter
// matches the extension family (avif→a, webp→w): that shape teaches the build prefix and the
// sample's shard number; each file's URL differs only in hash, its computed path slot and its
// (unknown) shard number. Returns one primary URL per file plus the number alternate; null on
// any shape mismatch — the caller keeps the DOM branches rather than fetch invented URLs.
export function hashReaderUrls(files: HashReaderFile[], sample: string): { urls: string[]; alts: string[] } | null {
    let u: URL;
    try { u = new URL(sample); } catch { return null; }
    if (u.protocol !== 'https:') return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length !== 3) return null;
    const build = segs[0];
    const last = segs[2].match(/^([0-9a-f]{16,})\.(avif|webp)$/i);
    if (!build || !/^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(build) || !last) return null;
    const ext = last[2].toLowerCase();
    const label = u.hostname.split('.')[0];
    const suffix = u.hostname.split('.').slice(1).join('.');
    const shard = /^([aw])([1-9])$/.exec(label);
    if (!shard || suffix.split('.').length < 2) return null;
    if ((shard[1] === 'a') !== (ext === 'avif')) return null;
    const num = Number(shard[2]);
    const altNum = num === 1 ? 2 : 1;
    const port = u.port ? ':' + u.port : '';
    const slot = (hash: string): string | null => {
        const tail = hash.slice(-3);
        if (!/^[0-9a-f]{3}$/i.test(tail)) return null;
        return String(parseInt(tail[2] + tail.slice(0, 2), 16));
    };
    const urls: string[] = [], alts: string[] = [];
    for (const f of files) {
        const s = slot(f.hash);
        if (s == null) return null;
        const letter = f.avif ? 'a' : 'w';
        const extFor = f.avif ? 'avif' : 'webp';
        const mk = (n: number): string => `https://${letter}${n}.${suffix}${port}/${build}/${s}/${f.hash}.${extFor}`;
        urls.push(mk(num));
        alts.push(mk(altNum));
    }
    return { urls, alts };
}

// ---- episode-manifest canvas readers: the reader draws pages into <canvas> (tainted — no
// pixel readback, so canvas identity AND pixels must come from elsewhere), but embeds the whole
// episode in <script id="episode-json" data-value='...'>. The DOM holds one .js-page-area per
// manifest entry IN ORDER (1:1, including non-main), each growing its <canvas> when scrolled
// near — so area index → manifest src is the stable page identity (survives canvas recreation,
// needs zero reads). Pure: caller passes the data-value string (or null). srcs align 1:1 with
// .js-page-area order; non-main entries (link/ad/backMatter) are null — never queued, never
// stitched. Unit-tested below.
export interface EpisodeManifest { dir: 'rtl' | 'ltr' | null; srcs: (string | null)[] }
export function episodeManifest(manifestJson: string | null): EpisodeManifest | null {
    if (!manifestJson) return null;
    try {
        const ps = JSON.parse(manifestJson)?.readableProduct?.pageStructure;
        const pages = ps?.pages;
        if (!Array.isArray(pages)) return null;
        const dir = ps.readingDirection === 'ltr' ? 'ltr' : ps.readingDirection === 'rtl' ? 'rtl' : null;
        return { dir, srcs: pages.map((p) => (p?.type === 'main' && typeof p?.src === 'string' ? p.src : null)) };
    } catch { return null; }
}

// forward siblings from an area-aligned src list (episodeManifest().srcs):
// nulls (ad/promo areas) skipped, never warmed. Pure — unit-tested below.
export function manifestAheadUrls(srcs: (string | null)[], anchor: string, max: number): string[] {
    if (!anchor || max <= 0) return [];
    const i = srcs.indexOf(anchor);
    if (i < 0) return [];
    return srcs.slice(i + 1).filter((s): s is string => !!s).slice(0, max);
}

// ---- tile descramble: the CDN serves 4x4-TRANSPOSED puzzles and the viewer reassembles in
// JS (tile = 8*floor(dim/32), dst index = 4*(a%4)+floor(a/4), full-draw first so the sub-tile
// remainder strip survives, smoothing off) — then deliberately taints the canvas. Mirror it
// exactly: fetch → untranspose → pipeline. Transpose is an involution, so the same map solves
// both directions. Pure geometry — pixel ops live in content.ts.
export interface PuzzleTile { sx: number; sy: number; dx: number; dy: number }
export function puzzleTileMap(w: number, h: number): { tw: number; th: number; tiles: PuzzleTile[] } {
    const tw = 8 * Math.floor(w / 32), th = 8 * Math.floor(h / 32);
    const tiles: PuzzleTile[] = [];
    for (let b = 0; b < 16; b++) {
        const a = 4 * (b % 4) + Math.floor(b / 4);
        tiles.push({ sx: (a % 4) * tw, sy: Math.floor(a / 4) * th, dx: (b % 4) * tw, dy: Math.floor(b / 4) * th });
    }
    return { tw, th, tiles };
}

// ---- failure cooldown: a failed page parks instead of burning tokens in a retry loop
// (autoTick re-enqueues anything stateless every 2.5s). Pure.
export interface FailMark { n: number; nextOk: number }
export const COOLDOWN_MS = 60000;
export const COOLDOWN_MAX = 3; // attempts, then parked until manual force
const MARKS_MAX = 500;
export function cooldownMark(marks: Map<string, FailMark>, key: string, now: number): void {
    const n = (marks.get(key)?.n ?? 0) + 1;
    marks.delete(key); // re-insert = newest (oldest-evict below relies on order)
    marks.set(key, { n, nextOk: now + COOLDOWN_MS });
    if (marks.size > MARKS_MAX) marks.delete(marks.keys().next().value!);
}
export function cooldownClear(marks: Map<string, FailMark>, key: string): void {
    marks.delete(key);
}
export function cooldownParked(marks: Map<string, FailMark>, key: string, now: number): boolean {
    const m = marks.get(key);
    if (!m) return false;
    if (m.n >= COOLDOWN_MAX) return true;
    return now < m.nextOk;
}

// auto pre-translate window budget: refill only up to `ahead` AUTO jobs waiting — a per-tick
// slice without this grows unbounded on full-DOM long strips. Manual jobs don't consume it. Pure.
export function autoBudget(autoQueued: number, ahead: number): number {
    return Math.max(0, ahead - autoQueued);
}

// Translate-chapter priority window: the page the reader is on plus the next `count-1`
// pages, clamped to the chapter. anchor < 0 (page unknown) falls back to the chapter start.
// Pure — unit-tested.
export function priorityIndices(n: number, anchor: number, count: number): number[] {
    if (n <= 0 || count <= 0) return [];
    const start = anchor >= 0 && anchor < n ? anchor : 0;
    const end = Math.min(n - 1, start + count - 1);
    const out: number[] = [];
    for (let i = start; i <= end; i++) out.push(i);
    return out;
}

// Index of the reader's page inside the cooldown-filtered sweep array: `usableFrom[u]` is the
// source index of usable entry u, so a parked anchor walks back to the nearest page that
// survived. -1 (unknown page, or nothing usable at/before it) → priority window starts at the
// chapter head. Pure — unit-tested.
export function usableAnchor(usableFrom: number[], anchor: number): number {
    for (let k = anchor; k >= 0; k--) {
        const u = usableFrom.indexOf(k);
        if (u >= 0) return u;
    }
    return -1;
}

// Host-rotated/among-list anchor match — pure (the sweep passes the item URLs and every
// candidate src of the visible page). Exact match wins in candidate order, then the
// cross-host path twin. Unit-tested in tests/sweep-priority.test.mjs.
export function matchAnchor(itemUrls: string[], candidates: string[]): number {
    for (const u of candidates) {
        const exact = itemUrls.indexOf(u);
        if (exact >= 0) return exact;
    }
    for (const u of candidates) {
        const twin = itemUrls.findIndex(v => samePagePath(v, u)); // CDN host rotation
        if (twin >= 0) return twin;
    }
    return -1;
}

// Does any live job already own this page path? `key === path` is the exact match;
// samePagePath is the host-rotated twin (the same file served from a different CDN host).
// Pure — the queue module hands in its own state, so the whole rule is unit-testable. 
export function ownedByPath(path: string, active: string | null, queued: string[], painting: string[]): boolean {
    const hit = (key: string): boolean => key === path || samePagePath(key, path);
    return (!!active && hit(active)) || queued.some(hit) || painting.some(hit);
}

// ---- seam chains: one scene sliced into consecutive same-width images with a bubble cut at
// the shared edge. Per-page jobs see half-boxes and translate fragments — the fix stitches the
// chain into one logical page (detect/OCR/LLM once, render whole, slice write-back).
// This gate decides whether two stacked pages share a cut bubble. Pure.
export interface SeamBox { x1: number; y1: number; x2: number; y2: number }
export function seamLinked(upper: SeamBox[], upperH: number, lower: SeamBox[], lowerH: number): boolean {
    // boxes live in bitmap coords — the cut edge is exact but CTD boxes on truncated text end
    // well short of it, so the touch band is generous; the conjunction (BOTH sides edge-touching
    // the SAME seam + horizontal overlap) is what keeps it strict
    const epsU = Math.max(24, Math.round(upperH * 0.06));
    const epsL = Math.max(24, Math.round(lowerH * 0.06));
    return upper.some(u => upperH - u.y2 <= epsU && lower.some(l =>
        l.y1 <= epsL && (() => {
            const ov = Math.min(u.x2, l.x2) - Math.max(u.x1, l.x1);
            const narrow = Math.min(u.x2 - u.x1, l.x2 - l.x1);
            // a shared bubble aligns horizontally — narrow slivers touching the
            // edge are detector noise, not a cut (40px/40% floor)
            return ov >= 40 && ov >= narrow * 0.4;
        })()));
}

// Cut text the box gate misses entirely (CTD drops truncated edge text): the TEXT mask still
// flags ink rows at the cut. Same verdict from ink columns: both sides show text ink at the seam
// with horizontal overlap. Mask-only art (panel borders crossing the cut) never enters the text
// mask, so art can't false-link.
export interface SeamMask { width: number; height: number; data: ArrayBuffer }
export function seamInkLinked(upper: SeamMask, lower: SeamMask): boolean {
    if (!upper || !lower || upper.width !== lower.width) return false;
    const W = upper.width;
    if (upper.data.byteLength < W * upper.height || lower.data.byteLength < W * lower.height) return false;
    const BAND = 16; // text cut by the edge always leaves ink within these rows
    const cols = (m: SeamMask, yFrom: number, yTo: number): { rows: number; min: number; max: number } => {
        const d = new Uint8Array(m.data);
        let rows = 0, min = W, max = -1;
        for (let y = Math.max(0, yFrom); y < Math.min(m.height, yTo); y++) {
            let any = false;
            for (let x = 0; x < W; x++) {
                if (d[y * W + x] > 127) { any = true; if (x < min) min = x; if (x > max) max = x; }
            }
            if (any) rows++;
        }
        return { rows, min, max };
    };
    const u = cols(upper, upper.height - BAND, upper.height);
    const l = cols(lower, 0, BAND);
    if (u.rows < 3 || l.rows < 3 || u.max < 0 || l.max < 0) return false;
    const ov = Math.min(u.max, l.max) - Math.max(u.min, l.min);
    const narrow = Math.min(u.max - u.min, l.max - l.min);
    return ov >= 60 && ov >= narrow * 0.3;
}

// Owner-side seam suspicion, evaluated BEFORE any neighbor prep is pulled: every pull costs
// a full page read + detect (a billed cloud roundtrip). Real cut evidence is text-mask ink
// inside the 16px edge band — seamTruncated's ≥8-row run implies ≥3 such rows, and
// seamInkLinked needs them on this side too. A box merely NEAR an edge is common on normal
// pages and alone is not worth a pull; the fail-safe direction is the split. Pure — unit-tested.
export function seamEdgeSuspect(mask: SeamMask | null | undefined, H: number): boolean {
    if (!mask || mask.height !== H || mask.data.byteLength < mask.width * H) return false;
    const d = new Uint8Array(mask.data);
    const W = mask.width;
    const rowsWithInk = (y0: number, y1: number): number => {
        let rows = 0;
        for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
            for (let x = 0; x < W; x++) if (d[y * W + x] > 127) { rows++; break; }
        }
        return rows;
    };
    return rowsWithInk(H - 16, H) >= 3 || rowsWithInk(0, 16) >= 3; // seamInkLinked's BAND
}

// Containment of two boxes (intersection over the SMALLER area): catches a near-threshold
// fragment inside a real box that IoU lets through. Pure.
export function boxContained(a: SeamBox, b: SeamBox): number {
    const inter = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
        * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const minA = Math.min((a.x2 - a.x1) * (a.y2 - a.y1), (b.x2 - b.x1) * (b.y2 - b.y1));
    return minA > 0 ? inter / minA : 0;
}

// Drop near-fully-contained boxes, loser = lower conf (tie: smaller area). loserCap gates
// the drop: detection passes 0.5 (marginal fragments only — a confident nested box like a sign
// in a bubble survives), paint passes the default (heals old cache entries). Pure — order kept.
export function dropContainedBoxes<T extends SeamBox & { conf: number }>(boxes: T[], ratio = 0.9, loserCap = Infinity): T[] {
    const drop = new Set<T>();
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            if (drop.has(a) || drop.has(b) || boxContained(a, b) < ratio) continue;
            const loser = a.conf !== b.conf
                ? (a.conf < b.conf ? a : b)
                : (((a.x2 - a.x1) * (a.y2 - a.y1) <= (b.x2 - b.x1) * (b.y2 - b.y1)) ? a : b);
            if (loser.conf < loserCap) drop.add(loser);
        }
    }
    return boxes.filter(b => !drop.has(b));
}

// IoU of two boxes — the stitch safety net (below) uses it to suppress solo
// boxes the stitch detector already found. Pure.
export function boxIoU(a: SeamBox, b: SeamBox): number {
    const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
    const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const ua = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
    return ua > 0 ? inter / ua : 0;
}

// Single-sided truncation: text ink running UNDER a near-edge box into the cut. Fires without
// any evidence from the neighbor side: unboxed ink spanning ≥8 rows below the box and touching
// the edge is cut text, not a bubble curve (curves are 2-4 rows tall). Needs only a same-width
// neighbor to exist — the stitch detector decides truth, the safety net preserves solo boxes.
export function seamTruncated(boxes: SeamBox[], mask: SeamMask | null | undefined, H: number, side: 'bottom' | 'top'): boolean {
    if (!mask || mask.height !== H || mask.data.byteLength < mask.width * H) return false;
    const d = new Uint8Array(mask.data);
    const MW = mask.width;
    const hasInk = (y: number, x1: number, x2: number): boolean => {
        if (y < 0 || y >= H) return false;
        const a = Math.max(0, Math.floor(x1)), b = Math.min(MW - 1, Math.ceil(x2));
        for (let x = a; x <= b; x++) if (d[y * MW + x] > 127) return true;
        return false;
    };
    // ink rows must form a glyph-tall run CONTAINING the edge — NOT a curve (a run only counts
    // if it spans rows within 2px of the edge)
    const runTouchesEdge = (yFrom: number, yTo: number, x1: number, x2: number, edgeY: number): boolean => {
        let start = -1;
        const counts = (end: number): boolean =>
            start >= 0 && end - start + 1 >= 8 && start <= edgeY + 2 && end >= edgeY - 2;
        const lo = Math.min(yFrom, yTo), hi = Math.max(yFrom, yTo);
        for (let y = lo; y <= hi; y++) {
            if (hasInk(y, x1, x2)) { if (start < 0) start = y; }
            else if (start >= 0) { if (counts(y - 1)) return true; start = -1; }
        }
        return counts(hi);
    };
    return boxes.some(b => side === 'bottom'
        ? (H - b.y2 <= 48 && runTouchesEdge(Math.floor(b.y2), H - 1, b.x1, b.x2, H - 1))
        // +30 past y1: the run's LENGTH counts (it starts at the edge and dives under the box) —
        // the start≤edge+2 clause keeps the anchor honest
        : (b.y1 <= 48 && runTouchesEdge(0, Math.ceil(b.y1) + 30, b.x1, b.x2, 0)));
}

// Band verification (seam suspicion second stage): a band bitmap stacks the bottom quarter of
// the upper page over the top quarter of the lower one — does any detected box span the band
// seam? The band shows CTD the whole local bubble, so this is near-deterministic where
// whole-slice edge boxes are stochastic. Pure.
export function bandSpan(boxes: SeamBox[], seamY: number, margin = 8): boolean {
    return boxes.some(b => b.y1 < seamY - margin && b.y2 > seamY + margin);
}

// Seam pixel-continuity: true slices continue each other row-exact (independent webp ringing
// per slice aside). Unrelated scenes differ massively. Guards wrong-pair stitches from
// lazy-load DOM gaps regardless of filenames: the gate proves a bubble crosses, THIS proves the
// slices continue each other. Pure — rows are RGBA (getImageData), compared per-channel-max.
export function seamRowsMatch(top: Uint8ClampedArray, bottom: Uint8ClampedArray, w: number): boolean {
    if (top.length < w * 4 || bottom.length < w * 4) return false;
    let bad = 0;
    for (let x = 0; x < w; x++) {
        const o = x * 4;
        const m = Math.max(
            Math.abs(top[o] - bottom[o]),
            Math.abs(top[o + 1] - bottom[o + 1]),
            Math.abs(top[o + 2] - bottom[o + 2]),
        );
        if (m > 100 && ++bad > w * 0.1) return false; // early exit
    }
    return true;
}

// write-back guard for revoked-blob readers: state.orig points at a dead blob: URL while the
// live element shows something else. Assigning the dead URL blanks the page — block the
// assignment IFF we want the original (a blob:) on an element showing something else. Every
// other combination assigns normally. Pure.
export function srcAssignBlocked(elSrc: string, wantSrc: string, origUrl: string): boolean {
    return wantSrc === origUrl && origUrl.startsWith('blob:') && elSrc !== wantSrc;
}

// visible-overlap of a [top, bottom] rect against viewport height — queue
// priority (viewed page cuts a prefetch backlog). Pure.
export function overlapOfRect(top: number, bottom: number, vh: number): number {
    return Math.min(bottom, vh) - Math.max(top, 0);
}

// CSS-px viewport rect → integer device pixels inside a W×H screenshot
// (screenshot fallback for CORS-blocked images / tainted canvases).
export function cropPixels(r: { x: number; y: number; w: number; h: number }, dpr: number, shotW: number, shotH: number): { sx: number; sy: number; sw: number; sh: number } {
    const sx = Math.max(0, Math.floor(r.x * dpr));
    const sy = Math.max(0, Math.floor(r.y * dpr));
    const sw = Math.min(shotW - sx, Math.floor(r.w * dpr));
    const sh = Math.min(shotH - sy, Math.floor(r.h * dpr));
    return { sx, sy, sw, sh };
}

// Region-badge number size on the VLM-annotated page, in annotated-image px (the drawn disc
// radius is 0.9× this). Badges exist only to map region numbers to the crops — the crops carry
// the readable text — so they must stay small. Pure, unit-tested.
export function annotFont(scale: number): number {
    return Math.max(16, Math.round(28 * scale));
}

export interface FingerprintOpts {
    targetLang: string; textSource: string; ocrEngine: string;
    readingDir: string; detConf: number; panelConf: number; deferLabels: boolean;
    transcribeSrc: boolean; // changes the prompt (src attrs) → separate cache entries
    useOcrModel: boolean; // split pipeline (VLM transcribe → LLM translate) → separate entries
    ocrPerRegion: boolean; // per-region transcribe calls produce different OCR text → separate entries
    temperature: number | null; // pinned main-model sampling → different output, separate entries
    ocrTemperature: number | null; // pinned VLM-reader sampling → different OCR text, separate entries
}

export function settingsFingerprint(o: FingerprintOpts): string {
    // trailing detector-generation tag (currently tile24): entries from older split/render/OCR
    // pipeline versions miss once and heal on overwrite — bump it whenever touching the
    // split, layout, or mask recipe, or old entries keep rendering stale regions.
    return [o.targetLang, o.textSource, o.ocrEngine, o.readingDir,
        o.detConf, o.panelConf, o.deferLabels ? 1 : 0, o.transcribeSrc ? 1 : 0, o.useOcrModel ? 1 : 0, o.ocrPerRegion ? 1 : 0, o.temperature ?? 'd', o.ocrTemperature ?? 'd', 'tile24'].join('|');
}

// ---- IndexedDB (separate DB from mt-models — no version coordination) ----

let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
    if (!dbp) {
        dbp = new Promise(res => {
            try {
                if (typeof indexedDB === 'undefined') { res(null); return; }
                const r = indexedDB.open('mt-cache', 1);
                r.onupgradeneeded = () => {
                    const s = r.result.createObjectStore('pages', { keyPath: 'key' });
                    s.createIndex('byAtime', 'atime');
                };
                r.onsuccess = () => res(r.result);
                r.onerror = () => res(null);
                // another context holding an old version open (DevTools, a
                // stale tab across a future version bump) blocks the upgrade —
                // resolve null instead of pending forever
                r.onblocked = () => res(null);
            } catch { res(null); } // private mode etc — cache just stays off
        });
    }
    return dbp;
}

function req<T>(q: IDBRequest<T>): Promise<T> {
    return new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}

let purgedGeneration: string | undefined;
let purgeWork: Promise<void> = Promise.resolve();
// Persisted per origin: the generation sweep walks every stored row (megabytes on a
// phone — seconds), and reloads used to pay it again every document. Stale rows cannot
// be served regardless (reads filter by cacheEpoch); the sweep only reclaims space.
function purgeMarkerKey(): string { return `mtPurged:${location.origin}`; }
async function purgeStaleRows(d: IDBDatabase, token: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const tx = d.transaction('pages', 'readwrite');
        const cursor = tx.objectStore('pages').openCursor();
        cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            if ((row.value.cacheEpoch ?? '') !== token) row.delete();
            row.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Could not invalidate translation cache'));
    });
}
async function freshDb(): Promise<IDBDatabase | null> {
    await cacheReady();
    const d = await db();
    if (!d) return null;
    const token = cacheGeneration();
    purgeWork = purgeWork.catch(() => {}).then(async () => {
        if (purgedGeneration === token) return;
        const key = purgeMarkerKey();
        let swept: unknown;
        try { swept = (await chrome.storage.local.get(key))[key]; } catch { /* walk below */ }
        if (swept === token) { purgedGeneration = token; return; }
        await purgeStaleRows(d, token);
        try { await chrome.storage.local.set({ [key]: token }); } catch { /* sweep repeats next document */ }
        purgedGeneration = token;
    });
    await purgeWork;
    return cacheCurrent(token) ? d : freshDb();
}

export async function cacheGet(key: string): Promise<CachedPage | undefined> {
    try {
        const d = await freshDb();
        if (!d) return undefined;
        const token = cacheGeneration();
        const got = await req(d.transaction('pages', 'readonly').objectStore('pages').get(key)) as CachedPage | undefined;
        if (!got || !cacheCurrent(token) || (got.cacheEpoch ?? '') !== token) return undefined;
        // LRU touch — fire and forget, a miss here never matters
        try {
            got.atime = Date.now();
            d.transaction('pages', 'readwrite').objectStore('pages').put(got);
        } catch { /* ignore */ }
        return got;
    } catch { return undefined; }
}

export async function cachePut(entry: Omit<CachedPage, 'atime'>, max = CACHE_MAX, token = cacheGeneration()): Promise<void> {
    try {
        const d = await freshDb();
        if (!d || !cacheCurrent(token)) return;
        const store = d.transaction('pages', 'readwrite').objectStore('pages');
        await req(store.put({ ...entry, cacheEpoch: token, atime: Date.now() }));
        const n = await req(store.count());
        if (n > max) {
            const idx = store.index('byAtime');
            const all = await req(idx.getAllKeys() as unknown as IDBRequest<string[]>) as unknown as string[];
            // getAllKeys on the index comes back in atime order — drop the oldest surplus
            for (const k of all.slice(0, n - max)) store.delete(k);
        }
    } catch { /* cache stays best-effort */ }
}

// drop one entry (resume checkpoints are written even with the cache off — a finished job
// must leave nothing behind in that mode)
export async function cacheDelete(key: string, token = cacheGeneration()): Promise<void> {
    try {
        const d = await freshDb();
        if (d && cacheCurrent(token)) await req(d.transaction('pages', 'readwrite').objectStore('pages').delete(key));
    } catch { /* best-effort */ }
}

export async function cacheClear(): Promise<void> {
    await cacheReady();
    const d = await db();
    if (!d) throw new Error('Translation cache is unavailable');
    await new Promise<void>((resolve, reject) => {
        const tx = d.transaction('pages', 'readwrite');
        tx.objectStore('pages').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Could not clear translation cache'));
    });
    purgedGeneration = cacheGeneration();
}

export async function cacheCount(): Promise<number> {
    try {
        const d = await freshDb();
        if (!d) return 0;
        return await req(d.transaction('pages', 'readonly').objectStore('pages').count());
    } catch { return 0; }
}

// entries for one chapter (prefix `chapter#`) — the global count above spans every story
// ever visited, which reads as "unstable" on a 30-page chapter
export async function cacheCountPrefix(prefix: string): Promise<number> {
    try {
        const d = await freshDb();
        if (!d) return 0;
        const keys = await req(d.transaction('pages', 'readonly').objectStore('pages').getAllKeys()) as unknown[];
        let n = 0;
        for (const k of keys) if (typeof k === 'string' && k.startsWith(prefix)) n++;
        return n;
    } catch { return 0; }
}

// Entries belonging to one chapter, counted by the PAGE identity. Both key shapes exist
// (`chapter#hash` and `chapter@pN`) and a chapter run writes the page-shaped one, so a
// counter that only knows `#` reports 0 while the chapter is full of work.
export async function cacheCountChapter(chapter: string): Promise<number> {
    try {
        const d = await freshDb();
        if (!d) return 0;
        const keys = await req(d.transaction('pages', 'readonly').objectStore('pages').getAllKeys()) as unknown[];
        let n = 0;
        for (const k of keys) {
            if (typeof k !== 'string' || !k.startsWith(chapter)) continue;
            const rest = k.slice(chapter.length);
            if (rest.startsWith('#') || rest.startsWith('@p')) n++;
        }
        return n;
    } catch { return 0; }
}

// ---- host-volatile CDN identity: some image CDNs serve the same file from different hosts
// per image, so URL-keyed mechanisms (warming trace, progress handoff, sweep claims) miss
// across loads while content-hash mechanisms (cache/resume) hit fine. Match by origin + path
// instead — generic, no per-site rules (exact match first, so same-host behavior never changes).
// Pure — unit-tested below.
export function samePagePath(a: string, b: string): boolean {
    if (a === b) return true;
    // Only https URLs can be cross-host twins, and the SCHEME check must come before the
    // parser: readers can hand us a data: URL holding a whole page image (multi-MB base64),
    // and one `new URL(data:)` costs ~20ms — a sweep comparing it against every chapter page
    // froze the reader's main thread. Rejecting the scheme up front is exact and free.
    if (!a.startsWith('https:') || !b.startsWith('https:')) return false;
    try {
        const ua = new URL(a), ub = new URL(b);
        if (ua.protocol !== 'https:' || ub.protocol !== 'https:') return false;
        if (ua.hostname === ub.hostname) return false;
        return ua.pathname === ub.pathname && ua.pathname !== '/';
    } catch { return false; }
}

// ---- cross-load warming trace: which page key started translating, in the TAB's
// sessionStorage (survives same-tab full loads, dies with the tab — unlike every in-memory
// structure). Lets the next document say "warming was interrupted — restarting" instead of
// silently redoing. The page shares this storage, so the value shape is validated on read —
// worst case a bogus pill line, never a logic decision (resume still needs a real partial entry).
const WARM_KEY = 'mt-warming';
export const WARM_TTL_MS = 15 * 60 * 1000;
export function parseWarming(raw: string | null): { key: string; ts: number } | null {
    if (!raw) return null;
    try {
        const o = JSON.parse(raw) as { key?: unknown; ts?: unknown };
        return typeof o.key === 'string' && typeof o.ts === 'number' ? { key: o.key, ts: o.ts } : null;
    } catch { return null; }
}
export function warmingFresh(ts: number, now = Date.now(), ttlMs = WARM_TTL_MS): boolean {
    return now - ts >= 0 && now - ts < ttlMs;
}
export function readWarming(): { key: string; ts: number } | null {
    try {
        if (typeof sessionStorage === 'undefined') return null;
        return parseWarming(sessionStorage.getItem(WARM_KEY));
    } catch { return null; }
}
export function writeWarming(key: string): void {
    try {
        if (typeof sessionStorage === 'undefined') return;
        sessionStorage.setItem(WARM_KEY, JSON.stringify({ key, ts: Date.now() }));
    } catch { /* private mode etc — the trace just stays off */ }
}

// ---- cross-document LLM progress handoff: the pill counter dies with its document on
// full-load readers while the SW-side call survives (adoption). Writers stamp {pageKey → t0}
// at LLM dispatch; arrivals continue counting from the earliest fresh stamp instead of
// restarting at 1s. Hints only — readers continue only with corroboration (resumed checkpoint,
// or cache off where no checkpoint exists), so a dead SW never inflates the counter; the
// 5-minute TTL bounds the worst overcount. Force-starts drop the entry. Tab-session scoped like warming.
const LLP_KEY = 'mt-llm-prog';
export const LLP_TTL_MS = 5 * 60 * 1000;
const LLP_CAP = 40;
export function progressGetT0(map: Record<string, unknown>, key: string, now: number, ttlMs = LLP_TTL_MS): number | null {
    const t0 = map[key];
    return typeof t0 === 'number' && now - t0 >= 0 && now - t0 < ttlMs ? t0 : null;
}
export function progressPutT0(map: Record<string, unknown>, key: string, t0: number, cap = LLP_CAP): Record<string, unknown> {
    // keep-earliest: chained arrivals must count from the true start, not
    // from the latest arrival's dispatch
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(map)) if (typeof v === 'number') out[k] = v;
    const prev = out[key];
    if (typeof prev !== 'number' || t0 < prev) out[key] = t0;
    const keys = Object.keys(out);
    if (keys.length > cap) {
        keys.sort((a, b) => (out[a] as number) - (out[b] as number));
        for (const k of keys.slice(0, keys.length - cap)) delete out[k];
    }
    return out;
}
function progressMap(): Record<string, unknown> {
    try {
        const o = JSON.parse(sessionStorage.getItem(LLP_KEY) ?? '{}');
        return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : {};
    } catch { return {}; }
}
// pure core (unit-tested): earliest fresh stamp for this page across the exact key AND
// host-volatile twins. Min, not direct-first: the caller stamps its own dispatch before reading,
// and a fresh exact entry must not shadow the older twin the fallback exists for.
export function handoffRead(map: Record<string, unknown>, key: string, now: number, ttlMs = LLP_TTL_MS): number | null {
    let best: number | null = null;
    for (const k of Object.keys(map)) {
        if (k !== key && !samePagePath(k, key)) continue;
        const t0 = progressGetT0(map, k, now, ttlMs);
        if (t0 != null && (best == null || t0 < best)) best = t0;
    }
    return best;
}
// force retranslate counts fresh — drop the exact stamp plus its volatile
// twins (same logical page, other CDN host), else a twin inflates the recount.
export function handoffDrop(map: Record<string, unknown>, key: string): Record<string, unknown> {
    const out = { ...map };
    for (const k of Object.keys(out)) if (k === key || samePagePath(k, key)) delete out[k];
    return out;
}
export function readProgressT0(pageKey: string): number | null {
    try {
        if (typeof sessionStorage === 'undefined') return null;
        return handoffRead(progressMap(), pageKey, Date.now());
    } catch { return null; }
}
export function writeProgressT0(pageKey: string, t0: number): void {
    try {
        if (typeof sessionStorage === 'undefined') return;
        sessionStorage.setItem(LLP_KEY, JSON.stringify(progressPutT0(progressMap(), pageKey, t0)));
    } catch { /* the counter just restarts */ }
}
export function dropProgressT0(pageKey: string): void {
    try {
        if (typeof sessionStorage === 'undefined') return;
        sessionStorage.setItem(LLP_KEY, JSON.stringify(handoffDrop(progressMap(), pageKey)));
    } catch { /* ignore */ }
}
