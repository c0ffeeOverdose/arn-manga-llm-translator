// Persistent translation cache: reopen a chapter → already-translated pages
// render from cache instead of paying detect + LLM again. Identity is the
// IMAGE CONTENT (downscaled hash), never the URL or page index — re-uploaded
// art, quality variants and spread-mode reshuffles all fail safe to a miss.
// Entries also carry a settings fingerprint so a changed target language (or
// threshold) re-translates instead of showing a stale page.
// ponytail: one tiny store, LRU by access time, hard cap — no versioning,
// no migrations, corrupt entries just miss.

import type { DetBox, DetectResult, MtOnStatus } from './detection';
import type { RegionOutput, ExtraRegion, Mention } from '../llm/core';

export const CACHE_MAX = 200;
const HASH_SIZE = 48;

// Sliding-window canvas readers keep every page canvas in the
// DOM from load; pages outside the render window are uniform placeholders
// that draw real pixels only when approached. Each byte is compared to the
// first pixel's channel (±2 for downscale ringing). Pure — unit-tested below.
export function uniformPixels(d: Uint8ClampedArray): boolean {
    for (let i = 4; i < d.length; i++) if (Math.abs(d[i] - d[i & 3]) > 2) return false;
    return true;
}

// Status ownership: the pill is a VIEW of live activities, not a public
// write slot — parallel jobs / queued preps each own an entry, and this
// picker decides which one the user sees. Priority: user intent (force) →
// the page they're looking at (max viewport overlap) → background work
// (lookahead, chapter sweep — tied, insertion order wins). Pure —
// unit-tested below.
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

// ---- chapter-sweep waiter registry: neutral ground so pipeline.ts can await
// a sweep-owned page without importing sweep.ts (which imports pipeline.ts
// for detection — a direct edge would cycle). Registered once at load.
let sweepWaiter: ((url: string, onStatus: MtOnStatus) => Promise<void>) | null = null;
export function registerSweepWaiter(fn: (url: string, onStatus: MtOnStatus) => Promise<void>): void {
    sweepWaiter = fn;
}
export function sweepWait(url: string, onStatus: MtOnStatus): Promise<void> {
    return sweepWaiter ? sweepWaiter(url, onStatus) : Promise.resolve();
}

// ---- lookahead-abort registry (same neutral-ground pattern): sweep.ts must
// not import auto.ts (one-way edge — auto imports sweep), but starting/stopping
// a sweep must stop a lookahead chain that is warming the same pages.
let lookaheadAbort: (() => boolean) | null = null;
export function registerLookaheadAbort(fn: () => boolean): void {
    lookaheadAbort = fn;
}
export function abortLookahead(): boolean {
    return lookaheadAbort ? lookaheadAbort() : false;
}

// ---- ordered commit: parallel workers finish out of order, but the book
// must fold page-by-page (updateContext is order-sensitive: pairs append,
// names are first-wins). Buffer results by chapter index and drain only the
// consecutive run from the head — every skipped/failed index still buffers a
// marker, or the head stalls behind it forever. Mutates the map (consumes).
// Pure — unit-tested below.
export function takeOrdered<T>(ready: Map<number, T>, head: number): { items: T[]; head: number } {
    const items: T[] = [];
    while (ready.has(head)) {
        items.push(ready.get(head)!);
        ready.delete(head);
        head++;
    }
    return { items, head };
}

// Sweep lifecycle phase (pure — popup/pill label + unit tests). `starting` is
// the enumeration window before a run object exists: cancel must be possible
// there too (it used to be a silent no-op and the run started anyway).
export function sweepPhase(s: { cancel: boolean; dead: boolean; starting?: boolean } | null): 'idle' | 'starting' | 'running' | 'stopping' | 'dead' {
    if (!s) return 'idle';
    if (s.dead) return 'dead';
    if (s.cancel) return 'stopping';
    return s.starting ? 'starting' : 'running';
}

// ---- pool sizing: canvas work is bound by the page's renderer thread, not by
// the provider. Cloud mode keeps the sweep pool (the endpoint serves requests
// in parallel — live-probed); local CPU inference is serialized behind the
// worker's ORT lock anyway, so extra workers only multiply main-thread decode/
// encode spikes on machines that can least afford them. Painting is local CPU
// everywhere: parallel lanes are pure jank without a GPU. Pure — unit-tested.
export function sweepPoolSize(cloud: boolean, gpu: boolean, detEpWasm: boolean): number {
    if (cloud) return 3;
    return !gpu || detEpWasm ? 2 : 3;
}
export function paintLaneSize(gpu: boolean): number {
    return gpu ? 3 : 1;
}

export interface CachedPage {
    key: string;      // chapter#contentHash
    fp: string;       // settings fingerprint at translate time
    w: number; h: number; // full-page dims — must still match (cheap second gate)
    atime: number;    // last hit, for LRU
    boxes: DetBox[];
    panels: DetBox[];
    outputs: RegionOutput[];
    extras: ExtraRegion[];
    mentions?: Mention[]; // page-level named people — absent on entries written before mentions existed
    // downscaled CTD mask (see packMask) — without it a cache hit renders with
    // an empty mask and inpaint erases nothing (ghost source text). Optional so
    // pre-mask entries just miss once and heal on overwrite.
    mask?: { w: number; h: number; data: ArrayBuffer };
    // detect checkpoint (no outputs yet): a page-turn kills the translating
    // document mid-job (full-load readers) — the next load resumes at
    // translation from this entry instead of re-paying detect. Overwritten by
    // the full entry under the same key; never renders as Done (cache).
    partial?: true;
    // OCR texts aligned 1:1 with boxes (cloud path carries them at checkpoint
    // time — local OCR runs later, inside translateRegions).
    texts?: string[];
    // detector EP at checkpoint time — restored so the Done line stays honest
    ep?: string;
}

// CTD masks are full-page 1 byte/px (~MBs) — too big for IDB at 200 pages.
// packMask block-maxes it to ≤maxSide (~45KB/page); unpackMask nearest-
// neighbor upscales back to full res. inpaint's row-fill + faint-text
// fallback tolerates the coarse mask — it only needs to know WHICH rows
// carry text, and block-max never drops a text pixel the full mask had.
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

// ---- detect checkpoints: a partial entry (boxes, no outputs) is resumable
// when fingerprint + dims still match and it carries a mask. Full entries
// never resume (they render from cache); stale partials re-detect. Pure.
export function isResumable(hit: CachedPage | undefined, fp: string, w: number, h: number): hit is CachedPage {
    return !!hit && hit.partial === true && hit.fp === fp
        && hit.w === w && hit.h === h && hit.boxes.length > 0 && !!hit.mask;
}

// rebuild a live DetectResult from a resumable partial — ordered boxes,
// panels, mask and texts come back as detect produced them (ordering is NOT
// re-run: it already ran before the checkpoint). Texts ride the cloudTexts
// slot: translateRegions treats any present texts as ready and skips local
// OCR. Returns null on a maskless entry (callers check isResumable first).
export function detFromPartial(hit: CachedPage, w: number, h: number): DetectResult | null {
    if (!hit.mask) return null;
    return {
        boxes: hit.boxes, panels: hit.panels ?? [],
        mask: { width: w, height: h, data: unpackMask(hit.mask, w, h) },
        inferMs: 0, ep: hit.ep ?? 'cache', dropped: [], panelDropped: [],
        ...(hit.texts?.length ? { cloudTexts: hit.texts } : null),
    };
}

// split-pipeline fallback: the transcribe already ran when the channel died —
// stamp its texts onto the regions so the re-sent call is a text-only
// translate instead of a second (billed) transcription. Short lists keep the
// caller's own source. Pure.
export function withSources<T extends { source: string }>(regions: T[], texts: string[]): T[] {
    return regions.map((r, i) => ({ ...r, source: texts[i] ?? r.source }));
}

// checkpoint writer input (same key the full entry later overwrites — LRU
// and force-overwrite need no partial awareness). Pure.
export function partialEntry(key: string, fp: string, det: DetectResult, w: number, h: number): Omit<CachedPage, 'atime'> {
    return {
        key, fp, w, h,
        boxes: det.boxes, panels: det.panels ?? [],
        outputs: [], extras: [],
        texts: det.cloudTexts ?? [],
        ep: det.ep,
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

// content hash of a page: downscale to 48x48 gray, hash the bytes.
// ~1-2ms — preparePage already decoded the bitmap for rendering anyway.
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

// Story identity for multi-site use: origin + path + query + hash, minus
// obvious page-turn suffixes. Page-turns share a key (queue + context
// survive flipping 1→2→3); anything else differing = a new story.
// Pure — unit-tested below; chapterKey() is the thin location wrapper.
export function normalizeChapterKey(origin: string, path: string, search: string, hash: string): string {
    // Chapter readers fold page-turns to the chapter: the segment after
    // /chapter/ names the CHAPTER, never the page (MangaDex pushStates page
    // numbers, title-page readers putting the id in the path never touch
    // the URL on page turns at all — live-proven). Keep it, drop the rest.
    const m = path.match(/^(.*\/chapter\/[^/]+)/);
    if (m) return origin + m[1];
    // Purely-numeric hashes (#2, #2-3 spread) are page turns — but only when
    // the path already carries an identifier (a digit: story/chapter ids are
    // numeric in every reader design seen). A digit-less path with a numeric
    // hash may BE using the hash as the story id, so those still compare
    // exactly: fail-split stands, no per-site rules.
    if (/\d/.test(path) && /^#\d+(-\d*)?$/.test(hash)) {
        hash = '';
    }
    // generic paged readers: a trailing /N under a nested path is a page turn
    // (/manga/x/1 → /manga/x). Depth guard: a shallow /manga/1 may BE the story
    // id — only strip at depth ≥3, where a story parent exists. Fail direction
    // is a split (lost continuity), never a merge (mixed stories).
    const segs = path.split('/').filter(Boolean);
    let p = (segs.length >= 3 && /^\d+$/.test(segs[segs.length - 1]))
        ? '/' + segs.slice(0, -1).join('/')
        : path.replace(/\/$/, '');
    if (!p) p = '/';
    // ?page=/&p=/&pg= are page turns; every other param may carry the chapter
    const sp = new URLSearchParams(search);
    sp.delete('page'); sp.delete('p'); sp.delete('pg');
    const q = sp.toString();
    // SPA hash routes name the story (#/reader/123 vs #/reader/456) — compared
    // EXACTLY, never stripped: a numeric tail may be the story id, and a split
    // only loses continuity while a merge contaminates.
    return origin + p + (q ? '?' + q : '') + hash;
}

// ---- hotlink Referer rule: some image CDNs (*.2xstorage.com)
// 403 any request without a page Referer — and an MV3 service worker cannot
// send one (Chrome strips referrer/unsafe-url from SW fetch silently), so the
// SW proxy 403s where a plain <img> loads fine (proven: 403→200 on the same
// URL by adding a page Referer). Fix at the network
// layer: a declarativeNetRequest session rule sets the header for SW fetches
// to these hosts. Pure builder — the background installs it via
// updateSessionRules; unit-tested below.
export const HOTLINK_RULE_ID = 1001;
export function hotlinkRule(origin: string): object {
    return {
        id: HOTLINK_RULE_ID,
        priority: 1,
        action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Referer', operation: 'set', value: origin + '/' }],
        },
        condition: {
            // SW fetch() surfaces as xmlhttprequest; <img> loads need no help
            regexFilter: '^https://[^/]*\\.(2xstorage\\.com|waitst\\.com)/',
            resourceTypes: ['xmlhttprequest'],
        },
    };
}

// ---- mt:fetch-image policy: the SW fetch is CORS-exempt under
// host_permissions, so without a guard it doubles as a read-anything proxy
// for whatever URL a page plants in an <img> — including local-network
// services (http://127.0.0.1:8080/…) whose response pixels flow back into
// the rendered page. http(s) only; private/loopback targets only when the
// requesting page itself sits on that host (self-hosted readers stay
// working). Pure — the background enforces it (on BOTH the request URL and
// the post-redirect response URL); unit-tested below.
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
    // lowercase + strip brackets + strip trailing dot ("localhost." resolves
    // to loopback; WHATWG URL already normalizes decimal/octal/hex IPv4)
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!privHost(host)) return null;
    let pageHost = '';
    try { pageHost = new URL(senderUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); } catch { /* no sender — treat as foreign */ }
    const norm = (h: string) => (h === 'localhost' || h === '::1' ? '127.0.0.1' : h);
    return norm(pageHost) === norm(host) ? null : 'local network';
}

// ---- single-image-reader off-DOM lookahead: these readers keep ONE <img> in
// the DOM (the current page — their "preload" is in-memory, invisible to
// querySelectorAll), so a DOM-driven prefetch window can never see ahead.
// But they embed the whole gallery manifest in the page (a
// script[type="application/json"][data-url="/api/v2/galleries/{id}"] whose
// body is itself a JSON string with pages[].path), so sibling URLs are
// derivable with zero extra fetches: current-img host + manifest path.
// Pure — caller passes the script text (or null when absent); returns
// absolute URLs AFTER the current page only (forward-only — prefetch never
// burns LLM on pages behind). Unit-tested below.
export function galleryAheadUrls(manifestJson: string | null, imgHost: string, curPath: string, max: number): string[] {
    if (!manifestJson || !imgHost || !curPath || max <= 0) return [];
    const paths = galleryPaths(manifestJson);
    const i = paths.indexOf(curPath);
    if (i < 0) return [];
    return paths.slice(i + 1, i + 1 + max).map((p) => `${imgHost}/${p}`);
}

// ---- paged-chapter enumeration: paged readers virtualize the DOM (only the
// loaded window stays — the rest are lazy <img> with no pixels yet, or absent
// entirely), so DOM refs undercount the chapter. Paged-reader APIs return the
// full page list; the parse + URL builder stay pure for tests, the fetch +
// DOM walk live in page-io (untestable — document/chrome access).
export function pagedChapterUuid(pathname: string, hostname: string): string | null {
    if (!/(^|\.)mangadex\./.test(hostname)) return null;
    const m = pathname.match(/^\/chapter\/([^/]+)/);
    // charset-gated: the id is interpolated into an API URL below
    return m && /^[0-9a-f-]{10,}$/i.test(m[1]) ? m[1] : null;
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
// unloaded-but-addressable pages: lazy <img> with an http(s) src and no
// pixels yet. Loaded ones are covered by getPages refs (element path handles
// blob/taint); known dedupes against those + each other. data:/empty/blob:
// srcs are unusable headless — skip.
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

// chapter sweep needs the WHOLE list in reading order (not just forward of
// an anchor), plus where the current page sits in it. Same parser, same
// bails — index -1 when the anchor matches nothing (sweep from page 0).
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

// caller-side wiring, kept pure so the translated-blob regression stays
// locked by test: the live element src is a blob: URL after translation, so
// siblings must derive from the STORED original (https) — never the live
// src. Non-https input (blob:, empty, garbage) yields [] by construction.
export function galleryLookaheadUrls(manifestJson: string | null, origSrc: string, max: number): string[] {
    const m = origSrc.match(/^(https?:\/\/[^/]+)\/(.+)$/);
    if (!m) return [];
    return galleryAheadUrls(manifestJson, m[1], m[2], max);
}

// ---- episode-manifest canvas readers (gigaviewer-style): the reader
// draws pages into <canvas> (tainted — no pixel readback, so canvas identity
// AND pixels must come from elsewhere), but embeds the whole episode in
// <script id="episode-json" data-value='{"readableProduct":{"pageStructure":
// {readingDirection, pages:[{type,src}...]}}}'>. The DOM holds one
// .js-page-area per manifest entry IN ORDER (1:1, including non-main), each
// growing its <canvas> when scrolled near — so area index → manifest src is
// the stable page identity (survives canvas recreation, needs zero reads).
// Pure: caller passes the data-value string (or null). srcs align 1:1 with
// .js-page-area order; non-main entries (link/ad/backMatter) are null —
// never queued, never stitched. Unit-tested below.
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

// ---- gigaviewer tile descramble: cdn-img serves 4x4-TRANSPOSED puzzles and
// the viewer reassembles in JS (chunk.1819: DIVIDE_NUM=4, MULTIPLE=8, tile =
// 8*floor(dim/32), dst index = 4*(a%4)+floor(a/4), full-draw first so the
// sub-tile remainder strip survives, smoothing off) — then deliberately
// taints the canvas (makeTainted: 1px no-CORS draw). Mirror it exactly:
// fetch → untranspose → pipeline. Transpose is an involution, so the same
// map solves both directions. Pure geometry — pixel ops live in content.ts.
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

// ---- failure cooldown: a failed page parks instead of burning tokens in
// a retry loop (autoTick re-enqueues anything stateless every 2.5s). Pure.
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

// auto pre-translate window budget: refill only up to `ahead` AUTO jobs
// waiting — a per-tick slice without this grows unbounded on full-DOM long
// strips (long-strip readers hold 36 imgs at once; virtualized readers self-limit
// and hid the bug). Manual jobs don't consume the budget. Pure.
export function autoBudget(autoQueued: number, ahead: number): number {
    return Math.max(0, ahead - autoQueued);
}

// ---- seam chains: one scene sliced into consecutive same-width images with
// a bubble cut at the shared edge (long-strip readers slice tall scenes ~1500px;
// taming-my-master-mage ch1 p8/p9 cut "BLOO[D...!]" mid-word). Per-page jobs
// see half-boxes and translate fragments — the fix stitches the chain into
// one logical page (detect/OCR/LLM once, render whole, slice write-back).
// This gate decides whether two stacked pages share a cut bubble. Pure.
export interface SeamBox { x1: number; y1: number; x2: number; y2: number }
export function seamLinked(upper: SeamBox[], upperH: number, lower: SeamBox[], lowerH: number): boolean {
    // boxes live in bitmap coords — the cut edge is exact but CTD boxes on
    // truncated text end well short of it (23px on a 378px slice, live-proven),
    // so the touch band is generous; the conjunction (BOTH sides edge-touching
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

// Cut text the box gate misses entirely (CTD drops truncated edge text —
// taming-my-master-mage p8's "BLOO[D" made zero boxes): the TEXT mask still
// flags ink rows at the cut. Same verdict from ink columns: both sides show
// text ink at the seam with horizontal overlap. Mask-only art (panel borders
// crossing the cut) never enters the text mask, so art can't false-link.
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

// Containment of two boxes (intersection over the SMALLER area): catches a
// near-threshold fragment inside a real box that IoU lets through (live:
// conf 0.36 box fully inside a conf 0.95 one, IoU only 0.30 — both painted,
// double text). Pure.
export function boxContained(a: SeamBox, b: SeamBox): number {
    const inter = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
        * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const minA = Math.min((a.x2 - a.x1) * (a.y2 - a.y1), (b.x2 - b.x1) * (b.y2 - b.y1));
    return minA > 0 ? inter / minA : 0;
}

// Drop near-fully-contained boxes, loser = lower conf (tie: smaller area).
// loserCap gates the drop: detection passes 0.5 (marginal fragments only —
// a confident nested box like a sign in a bubble survives), paint passes the
// default (heals every old cache entry on revisit). Pure — same refs, order kept.
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

// Single-sided truncation: text ink running UNDER a near-edge box into the
// cut (live: p8's box ended at y2=355 on H=378 while glyph strokes ≥8px wide
// reach y=377 — the "BLOO[D" bottoms CTD didn't box). Fires without any
// evidence from the neighbor side: unboxed ink spanning ≥8 rows below the box
// and touching the edge is cut text, not a bubble curve (curves are 2-4 rows
// tall). Needs only a same-width neighbor to exist — the stitch detector
// decides truth, the safety net preserves solo boxes either way.
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
    // ink rows must form a glyph-tall run CONTAINING the edge — NOT a curve
    // (a run only counts if it spans rows within 2px of the edge)
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
        // +30 past y1: the run's LENGTH counts (it starts at the edge and dives
        // under the box) — the start≤edge+2 clause keeps the anchor honest
        : (b.y1 <= 48 && runTouchesEdge(0, Math.ceil(b.y1) + 30, b.x1, b.x2, 0)));
}

// Band verification (seam suspicion second stage): a band bitmap stacks the
// bottom quarter of the upper page over the top quarter of the lower one —
// does any detected box span the band seam? The band shows CTD the whole
// local bubble (slices show it fragments), so this is near-deterministic
// where whole-slice edge boxes are stochastic. Pure.
export function bandSpan(boxes: SeamBox[], seamY: number, margin = 8): boolean {
    return boxes.some(b => b.y1 < seamY - margin && b.y2 > seamY + margin);
}

// Seam pixel-continuity: true slices continue each other row-exact (live
// 8/9: 95.7% of seam pixels within 100/255 — the rest is independent webp
// ringing per slice). Unrelated scenes differ massively. Guards wrong-pair
// stitches from lazy-load DOM gaps regardless of filenames: the gate proves
// a bubble crosses, THIS proves the slices continue each other. Pure — rows
// are RGBA (getImageData), compared per-channel-max per pixel.
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

// write-back guard for revoked-blob readers (MM/M+): state.orig points at a
// dead blob: URL while the live element shows something else. Assigning the
// dead URL blanks the page — block the assignment IFF we want the original
// (a blob:) on an element showing something else. Every other combination
// (translated blob, https orig, already-correct src) assigns normally. Pure.
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

// Region-badge number size on the VLM-annotated page, in annotated-image px
// (the drawn disc radius is 0.9× this). Badges exist only to map region
// numbers to the crops — the crops carry the readable text — so they must stay
// small: the old formula doubled the size on top of the downscale (56×scale
// with scale ≤ 1) and drew 54px discs on a 907px-wide page (6% of the width),
// covering corner text on dense pages (live-reported). Pure, unit-tested.
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
    // trailing detector-generation tag: entries detected before tiled-strip
    // CTD miss once and heal on overwrite (old entries hold fewer boxes).
    // Bumped to tile2: pre-fix entries may hold EMPTY outputs (total parse
    // failures used to come back ok:true and get cached) — orphan them all at
    // once instead of making the user Clear by hand.
    return [o.targetLang, o.textSource, o.ocrEngine, o.readingDir,
        o.detConf, o.panelConf, o.deferLabels ? 1 : 0, o.transcribeSrc ? 1 : 0, o.useOcrModel ? 1 : 0, o.ocrPerRegion ? 1 : 0, o.temperature ?? 'd', o.ocrTemperature ?? 'd', 'tile2'].join('|');
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
            } catch { res(null); } // private mode etc — cache just stays off
        });
    }
    return dbp;
}

function req<T>(q: IDBRequest<T>): Promise<T> {
    return new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}

export async function cacheGet(key: string): Promise<CachedPage | undefined> {
    try {
        const d = await db();
        if (!d) return undefined;
        const got = await req(d.transaction('pages', 'readonly').objectStore('pages').get(key)) as CachedPage | undefined;
        if (!got) return undefined;
        // LRU touch — fire and forget, a miss here never matters
        try {
            got.atime = Date.now();
            d.transaction('pages', 'readwrite').objectStore('pages').put(got);
        } catch { /* ignore */ }
        return got;
    } catch { return undefined; }
}

export async function cachePut(entry: Omit<CachedPage, 'atime'>, max = CACHE_MAX): Promise<void> {
    try {
        const d = await db();
        if (!d) return;
        const store = d.transaction('pages', 'readwrite').objectStore('pages');
        await req(store.put({ ...entry, atime: Date.now() }));
        const n = await req(store.count());
        if (n > max) {
            const idx = store.index('byAtime');
            const all = await req(idx.getAllKeys() as unknown as IDBRequest<string[]>) as unknown as string[];
            // getAllKeys on the index comes back in atime order — drop the oldest surplus
            for (const k of all.slice(0, n - max)) store.delete(k);
        }
    } catch { /* cache stays best-effort */ }
}

// drop one entry (resume checkpoints are written even with the cache off —
// a finished job must leave nothing behind in that mode)
export async function cacheDelete(key: string): Promise<void> {
    try {
        const d = await db();
        if (d) await req(d.transaction('pages', 'readwrite').objectStore('pages').delete(key));
    } catch { /* best-effort */ }
}

export async function cacheClear(): Promise<void> {
    try {
        const d = await db();
        if (d) await req(d.transaction('pages', 'readwrite').objectStore('pages').clear());
    } catch { /* ignore */ }
}

export async function cacheCount(): Promise<number> {
    try {
        const d = await db();
        if (!d) return 0;
        return await req(d.transaction('pages', 'readonly').objectStore('pages').count());
    } catch { return 0; }
}

// entries for one chapter (prefix `chapter#`) — the global count above spans
// every story ever visited, which reads as "unstable" on a 30-page chapter
export async function cacheCountPrefix(prefix: string): Promise<number> {
    try {
        const d = await db();
        if (!d) return 0;
        const keys = await req(d.transaction('pages', 'readonly').objectStore('pages').getAllKeys()) as unknown[];
        let n = 0;
        for (const k of keys) if (typeof k === 'string' && k.startsWith(prefix)) n++;
        return n;
    } catch { return 0; }
}

// ---- host-volatile CDN identity: some image CDNs serve the same file from
// different hosts per image (round-robin i-subdomains), so URL-keyed
// mechanisms (warming trace, progress handoff, sweep claims) miss across
// loads while content-hash mechanisms (cache/resume) hit fine. Match by
// origin + path instead — generic, no per-site rules (exact match first, so
// same-host behavior never changes). Pure — unit-tested below.
export function samePagePath(a: string, b: string): boolean {
    if (a === b) return true;
    try {
        const ua = new URL(a), ub = new URL(b);
        if (ua.protocol !== 'https:' || ub.protocol !== 'https:') return false;
        if (ua.hostname === ub.hostname) return false;
        return ua.pathname === ub.pathname && ua.pathname !== '/';
    } catch { return false; }
}

// ---- cross-load warming trace: which page key started translating, in the
// TAB's sessionStorage (survives same-tab full loads, dies with the tab —
// unlike every in-memory structure). Lets the next document say "warming was
// interrupted — restarting" instead of silently redoing. The page shares this
// storage, so the value shape is validated on read — worst case a bogus pill
// line, never a logic decision (resume still needs a real partial entry).
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

// ---- cross-document LLM progress handoff: the pill counter dies with its
// document on full-load readers while the SW-side call survives (adoption).
// Writers stamp {pageKey → t0} at LLM dispatch; arrivals continue counting
// from the earliest fresh stamp instead of restarting at 1s. Hints only —
// readers continue only with corroboration (resumed checkpoint, or cache off
// where no checkpoint exists), so a dead SW never inflates the counter; the
// 5-minute TTL bounds the worst overcount to a rare race. Force-starts drop
// the entry (fresh work counts fresh). Tab-session scoped like warming.
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
// pure core (unit-tested): earliest fresh stamp for this page across the
// exact key AND host-volatile twins. Min, not direct-first: the caller stamps
// its own dispatch before reading, and a fresh exact entry must not shadow
// the older twin the fallback exists for (live-proven i4→i2: direct-first
// counted local every time while the twin sat unused in the map).
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
