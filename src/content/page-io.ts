// Page discovery + pixel I/O: getPages, refKey, fetch/read/descramble,
// write-back (img src swap + canvas repaint), hash-lane repaint + healing.

import { pageHashFromBitmap, cropPixels, puzzleTileMap, episodeManifest, uniformPixels, srcAssignBlocked, pagedChapterUuid, buildPagedUrls, unloadedPageUrls, type EpisodeManifest } from './page-cache';
import { isDebug } from '../debug';
import { pages, elStates, verifying, verifyFailed, hashStates, hashMiss, hashPending, retiredBlobs, overlayOn, debugOn, type PageRef, type PageState } from './state';

// page identity: img = its original src (translated blob URLs alias via
// pages.get), canvas = the manifest image URL when the reader embeds one
// (gigaviewer: stable across canvas recreation, needs no pixel readback),
// else the assigned data-mt-key fallback
export function refKey(ref: PageRef): string {
    if (ref.kind === 'canvas') return ref.pageSrc ?? ref.key;
    const ex = pages.get(ref.el.src);
    if (ex) return ex.orig;
    // zombie element showing a revoked blob: resolve via the retired map so it
    // re-fetches the (alive) original instead of the dead blob
    return retiredBlobs.get(ref.el.src) ?? ref.el.src;
}

export function getPages(): PageRef[] {
    // generic: any large content image is a page candidate (blob = reader
    // canvases like MangaDex, https = plain <img> sites); icons/avatars fall
    // below the size floor. Rendered-size floor kills header logos served at
    // large natural size (site logos: 410px natural, 70px displayed) while
    // zero-rect (hidden/offscreen) images are kept — the sweep picks them up
    // when the reader shows them. ponytail: size heuristic only — per-site
    // rules only if a real site is proven to break it.
    const out: PageRef[] = [];
    for (const img of document.querySelectorAll('img')) {
        if (!/^(blob:|https?:)/.test(img.src)) continue;
        // gigaviewer promo slots (.link-page): same-size ad images that pass the
        // size floor — proven stitched into a seam "chain" + translated as manga
        // (LLM burn, junk paint, book contamination). Never pages.
        if (img.closest('.link-page')) continue;
        if (img.naturalWidth < 400 || img.naturalHeight < 300) continue;
        if (img.closest('[data-mt-skip]')) continue;
        const r = img.getBoundingClientRect();
        if (r.width > 0 && r.width < 200) continue; // chrome, not content
        out.push({ kind: 'img', el: img });
    }
    // canvas readers draw pages into <canvas> instead of <img>. Never probe
    // with getContext here — a speculative getContext('2d') LOCKS the canvas
    // mode and breaks WebGL readers; mode is resolved once, at write time.
    for (const el of document.querySelectorAll('canvas')) {
        if (el.width < 400 || el.height < 300) continue;
        if (el.closest('[data-mt-skip]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.width < 200) continue;
        let key = el.getAttribute('data-mt-key');
        if (!key) {
            // per-sweep counters restart at 0, so late-created canvases collide
            // with early ones (#canvas0 twice — states cross-paint). The module
            // counter only moves forward and skips keys already taken this tab.
            do { key = `${location.origin}${location.pathname}#canvas${canvasKeySeq++}`; }
            while (document.querySelector(`[data-mt-key="${CSS.escape(key)}"]`));
            el.setAttribute('data-mt-key', key);
        }
        // manifest non-page (link/ad/backMatter area that grew a canvas — promo
        // art, unreadable + untranslatable): never queued, or it fails tainted
        // every sweep and parks the queue in error noise
        const rawSrc = episodePageSrc(el);
        if (rawSrc === null) continue;
        out.push({ kind: 'canvas', el, key, pageSrc: rawSrc ?? undefined });
    }
    return out;
}

// gigaviewer canvas → manifest URL: one .js-page-area per manifest entry in
// order, each growing its canvas when scrolled near. Other pages (no
// #episode-json) bail to undefined = legacy key behavior. The parse is cached
// per script element (getPages runs every sweep — no re-parse).
// Tri-state: string = main-page image URL; null = manifest maps this area to
// a non-page (link/ad/backMatter — never queued, its canvas is unreadable
// anyway); undefined = no manifest (other sites, legacy key path).
let episodeCache: { el: Element | null; href: string; m: EpisodeManifest | null } | null = null;
let canvasKeySeq = 0;
export function episodePageSrc(el: HTMLCanvasElement): string | null | undefined {
    const script = document.querySelector('#episode-json');
    const href = location.href;
    if (!script) return undefined;
    if (!episodeCache || episodeCache.el !== script || episodeCache.href !== href) {
        episodeCache = { el: script, href, m: episodeManifest((script as HTMLElement).dataset?.value ?? null) };
    }
    const m = episodeCache.m;
    if (!m) return undefined;
    const area = el.closest('.js-page-area');
    if (!area?.parentElement) return undefined;
    const i = [...area.parentElement.querySelectorAll(':scope > .js-page-area')].indexOf(area);
    if (i < 0 || i >= m.srcs.length) return undefined;
    return m.srcs[i];
}

// main-page srcs for the current episode (lookahead driver); null off-manifest
export function episodeManifestSrcs(): string[] | null {
    const srcs = episodeCache?.m?.srcs;
    return srcs ? srcs.filter((s): s is string => !!s) : null;
}

// gallery-manifest source for single-img readers: the embedded script
// payload first, same-origin API as fallback (hydration may drop the script —
// the data-url IS the API route, so a direct GET returns the same gallery
// object; cached per gallery, and a failed fetch caches null so callers
// never retry-loop it). Shared by lookahead and chapter sweep.
let galleryManifestCache: { key: string; json: string | null } | null = null;
export async function galleryManifestJson(): Promise<string | null> {
    const script = document.querySelector('script[type="application/json"][data-url^="/api/v2/galleries/"]');
    if (script?.textContent) return script.textContent;
    const g = location.pathname.match(/^\/g\/(\d+)\/\d+\/?$/);
    if (!g) return null;
    if (galleryManifestCache?.key === g[1]) return galleryManifestCache.json;
    try {
        const r = await fetch(`/api/v2/galleries/${g[1]}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = JSON.stringify({ body: JSON.stringify(await r.json()) });
        galleryManifestCache = { key: g[1], json };
        return json;
    } catch {
        galleryManifestCache = { key: g[1], json: null };
        return null;
    }
}

// Full-chapter enumeration for paged readers that virtualize the DOM (only
// the loaded window stays — sweeping DOM refs undercounts). Same public API
// family resolveMangaId already uses; [] on any failure (external chapter,
// offline) so callers fall through to the DOM branches silently.
// Tier match: the reader may show the data-saver variant (different bytes) —
// sweeping full-data then paints nowhere (URL and hash both miss) and forks
// a second cache universe the reader can never hit. Probe the first page's
// full-data dims against a loaded page image; mismatch walks data-saver.
export async function fetchPagedUrls(): Promise<string[]> {
    const uuid = pagedChapterUuid(location.pathname, location.hostname);
    if (!uuid) return [];
    try {
        const r = await fetch(`https://api.mangadex.org/at-home/server/${encodeURIComponent(uuid)}`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) return [];
        const j = await r.json();
        const baseUrl = j?.baseUrl, hash = j?.chapter?.hash;
        const data = j?.chapter?.data, saver = j?.chapter?.dataSaver;
        const tier = await pagedTier(baseUrl, hash, data);
        const files = tier === 'data-saver' && Array.isArray(saver) && saver.length ? saver : data;
        return buildPagedUrls(baseUrl, hash, files, tier === 'data-saver' && files === saver ? 'data-saver' : 'data');
    } catch { return []; }
}

// which at-home tier the reader shows: full-data dims equal a loaded page
// image, saver dims don't. No loaded page / unreadable probe / junk payload
// keeps today's full-data default (status quo, never worse).
async function pagedTier(baseUrl: unknown, hash: unknown, data: unknown): Promise<'data' | 'data-saver'> {
    try {
        if (typeof baseUrl !== 'string' || typeof hash !== 'string' || !Array.isArray(data) || !data.length) return 'data';
        const shown = getPages().find(r => r.kind === 'img' && (r.el as HTMLImageElement).naturalWidth >= 400)?.el as HTMLImageElement | undefined;
        if (!shown) return 'data';
        const first = buildPagedUrls(baseUrl, hash, [data[0]], 'data');
        if (!first.length) return 'data';
        const f = await fetchBitmap(first[0]);
        let dw = 0, dh = 0;
        try { dw = f.bitmap.width; dh = f.bitmap.height; }
        finally { try { f.bitmap.close(); } catch { /* already closed */ } }
        const tier = (dw === shown.naturalWidth && dh === shown.naturalHeight) ? 'data' : 'data-saver';
        if (isDebug()) console.log('[mt] paged tier:', JSON.stringify({ tier, shown: `${shown.naturalWidth}x${shown.naturalHeight}`, data: `${dw}x${dh}` }));
        return tier;
    } catch { return 'data'; }
}

// DOM walk for lazy <img> with an addressable src but no pixels yet (the
// sweep can fetch these headless — getPages only sees loaded ones). Thin
// wrapper: the filter/dedupe predicate is pure in page-cache (tested).
// Same promo/skip exclusions as getPages — an unloaded ad is still an ad.
export function collectUnloadedUrls(known: Set<string>): string[] {
    const cands: { src: string; loaded: boolean }[] = [];
    for (const img of document.querySelectorAll('img')) {
        if (img.closest('.link-page') || img.closest('[data-mt-skip]')) continue;
        cands.push({ src: img.currentSrc || img.src, loaded: img.naturalWidth > 0 });
    }
    return unloadedPageUrls(cands, known);
}

// Last-resort pixel source: the direct read failed (CORS-blocked <img>,
// tainted canvas, hotlink-guarded CDN). Scroll the element into view and ask
// the background for a viewport screenshot, then crop to the element rect.
async function screenshotPage(el: Element): Promise<ImageBitmap> {
    // captureVisibleTab photographs the ACTIVE tab of the last-focused window —
    // NOT the requesting tab. A hidden/backgrounded tab must never ask: the
    // pixels would belong to whatever the user is looking at elsewhere (bank,
    // email) and flow back into this page's readable blob. Auto jobs park via
    // the normal cooldown when this throws.
    if (document.hidden) throw new Error('tab not visible — screenshot needs the tab you are looking at');
    el.scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 350));
    const r = el.getBoundingClientRect();
    const resp = await chrome.runtime.sendMessage({ type: 'mt:screenshot' }) as
        { ok: boolean; dataUrl?: string; error?: string };
    if (!resp?.ok || !resp.dataUrl) throw new Error(resp?.error ?? 'screenshot failed');
    const blob = await (await fetch(resp.dataUrl)).blob();
    const probe = await createImageBitmap(blob);
    const { sx, sy, sw, sh } = cropPixels({ x: r.x, y: r.y, w: r.width, h: r.height }, window.devicePixelRatio || 1, probe.width, probe.height);
    probe.close();
    if (sw <= 0 || sh <= 0) throw new Error('page is outside the viewport');
    return createImageBitmap(blob, sx, sy, sw, sh);
}

export async function fetchBitmap(srcUrl: string): Promise<{ bitmap: ImageBitmap; bytes: ArrayBuffer }> {
    // fast path: direct fetch (CORS-open CDNs — comix, MangaDex image servers).
    // Timeout: a long-tail hang here would wedge a sweep worker forever (the
    // run watchdog is the last resort — page fetch is the first).
    try {
        const resp = await fetch(srcUrl, { signal: AbortSignal.timeout(120_000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const bytes = await (await resp.blob()).arrayBuffer();
        return { bitmap: await createImageBitmap(new Blob([bytes])), bytes };
    } catch { /* CORS/hotlink-blocked/timeout → worker proxy below */ }
    // content-script fetch is CORS-gated on the page origin even with host
    // permissions (some image servers send no ACAO) — the worker fetches free of
    // page CORS, so proxy the bytes through it (readPage falls back to
    // screenshot if this throws too)
    type FetchResp = { ok: boolean; b64?: string; error?: string };
    const via = (url: string): Promise<FetchResp> =>
        chrome.runtime.sendMessage({ type: 'mt:fetch-image', url }) as Promise<FetchResp>;
    let r = await via(srcUrl);
    // hotlink-guarded CDN (403s the Referer-less worker fetch): ask
    // the worker to stamp our origin as Referer via a DNR session rule, then
    // retry ONCE — a second 403 is a real block, not a missing header.
    if ((!r?.ok || !r.b64) && (r?.error ?? '').startsWith('image HTTP 403')) {
        const rule = await chrome.runtime.sendMessage({ type: 'mt:hotlink-rule', origin: location.origin }) as
            { ok: boolean; error?: string };
        if (rule?.ok) r = await via(srcUrl);
    }
    if (!r?.ok || !r.b64) throw new Error(r?.error ?? `fetch failed: ${srcUrl.slice(0, 80)}`);
    const bin = atob(r.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bitmap: await createImageBitmap(new Blob([bytes.buffer])), bytes: bytes.buffer };
}

// gigaviewer reassembly, mirrored from the viewer's own solver (chunk.1819):
// full draw first (the sub-tile remainder strip survives it), then the 16
// transposed tiles, smoothing off. Runs behind a discontinuity gate: unshuffle
// ONLY when it heals tile borders (margin 0.85) — a clean image must pass
// through untouched. Returns null when already clean.
export async function unscrambleTiles(bmp: ImageBitmap): Promise<{ bitmap: ImageBitmap; bytes: ArrayBuffer } | null> {
    const W = bmp.width, H = bmp.height;
    const { tw, th, tiles } = puzzleTileMap(W, H);
    if (!tw || !th) return null;
    const mk = () => {
        const c = new OffscreenCanvas(W, H);
        const x = c.getContext('2d', { willReadFrequently: true })!;
        x.imageSmoothingEnabled = false;
        return { c, x };
    };
    // tile-border discontinuity: scrambled grids tear art mid-panel, clean pages
    // only cross borders at real panel gutters
    const disc = (d: Uint8ClampedArray): number => {
        let s = 0;
        for (let gx = 1; gx < 4; gx++) {
            const x = gx * tw;
            if (x <= 0 || x >= W) continue;
            for (let y = 0; y < H; y++) {
                const i = (y * W + x) * 4;
                s += Math.abs(d[i] - d[i - 4]) + Math.abs(d[i + 1] - d[i - 3]) + Math.abs(d[i + 2] - d[i - 2]);
            }
        }
        for (let gy = 1; gy < 4; gy++) {
            const y = gy * th;
            if (y <= 0 || y >= H) continue;
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4, j = ((y - 1) * W + x) * 4;
                s += Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]);
            }
        }
        return s;
    };
    const full = mk();
    full.x.drawImage(bmp, 0, 0);
    const before = disc(full.x.getImageData(0, 0, W, H).data);
    const out = mk();
    out.x.drawImage(full.c, 0, 0);
    for (const t of tiles) out.x.drawImage(full.c, t.sx, t.sy, tw, th, t.dx, t.dy, tw, th);
    const after = disc(out.x.getImageData(0, 0, W, H).data);
    if (!(after < before * 0.85)) return null;
    const bytes = await (await out.c.convertToBlob({ type: 'image/png' })).arrayBuffer();
    return { bitmap: await createImageBitmap(out.c), bytes };
}

export async function readPage(ref: PageRef, srcUrl: string, stashed?: ArrayBuffer): Promise<{ bitmap: ImageBitmap; bytes?: ArrayBuffer }> {
    // canvas re-translate: the canvas already shows OUR drawing — re-read from
    // the stashed original bytes instead
    if (ref.kind === 'canvas' && stashed) {
        return { bitmap: await createImageBitmap(new Blob([stashed])) };
    }
    try {
        if (ref.kind === 'img') {
            // revoked-blob readers (MANGA Plus revokes its blob URLs right after
            // load — fetch/XHR then fail while the decoded <img> stays readable):
            // decode from the live element first, network fetch second. Gate is
            // blob:-only: element-decoding a cross-origin https img yields a
            // TAINTED bitmap that explodes later at getImageData, while same-origin
            // blobs are never tainted.
            if (srcUrl.startsWith('blob:')) {
                try {
                    return { bitmap: await createImageBitmap(ref.el) };
                } catch { /* not decoded yet → fetch below */ }
            }
            // return AWAIT — a bare `return fetchBitmap(...)` skips this try's
            // catch (the promise escapes before the try closes) and the screenshot
            // fallback below never runs; this bit us live (raw 403 instead of a
            // screenshot on fully fetch-blocked pages)
            return await fetchBitmap(srcUrl);
        }
        // manifest-backed canvas (gigaviewer): the live canvas is deliberately
        // tainted (makeTainted) and cdn-img serves 4x4-TRANSPOSED puzzles the
        // viewer reassembles in JS — so fetch the original and untranspose it
        // (full-res, better than any readback). Falls through on failure.
        if (ref.pageSrc) {
            try {
                const f = await fetchBitmap(ref.pageSrc);
                try {
                    const fixed = await unscrambleTiles(f.bitmap);
                    if (fixed) {
                        f.bitmap.close();
                        if (isDebug()) console.log('[mt] unscrambled', JSON.stringify({ unshuffled: ref.pageSrc.slice(-14) }));
                        return fixed;
                    }
                } catch { /* gate/pixel failure — use fetched bytes as-is */ }
                return f;
            } catch { /* tainted-canvas path below */ }
        }
        const url = ref.el.toDataURL('image/png'); // throws when tainted
        const blob = await (await fetch(url)).blob();
        const bytes = await blob.arrayBuffer();
        return { bitmap: await createImageBitmap(new Blob([bytes])), bytes };
    } catch (e) {
        // direct read blocked → screenshot fallback, else a clear error naming it
        try {
            return { bitmap: await screenshotPage(ref.el) };
        } catch {
            throw new Error(`site blocks image access (${ref.kind === 'img' ? 'CORS' : 'tainted canvas'}) — screenshot fallback failed: ${(e as Error).message}`);
        }
    }
}

// blank = uniform pixels at thumbnail scale — a placeholder canvas with
// nothing to translate (see preparePage). Pure half in page-cache (unit-tested).
export async function bitmapBlank(b: ImageBitmap): Promise<boolean> {
    const c = new OffscreenCanvas(16, 16);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(b, 0, 0, 16, 16);
    return uniformPixels(g.getImageData(0, 0, 16, 16).data);
}
// "this canvas was blank at size WxH" — sliding-window readers resize on
// draw, so a size match means still blank (no readback re-check needed)
export const blankVerdicts = new WeakMap<HTMLCanvasElement, string>();

// <picture> + <source srcset> (AVIF-first readers) beats img.src —
// the browser keeps showing the source even after we swap img.src to the
// translated blob. Stash + clear sibling srcsets on translate, restore them
// when showing the original.
function syncPictureSources(img: HTMLImageElement, translated: boolean): boolean {
    const pic = img.closest('picture');
    if (!pic) return false;
    const sources = [...pic.querySelectorAll('source')];
    if (translated) {
        if (img.dataset.mtSrcsets === undefined) {
            img.dataset.mtSrcsets = JSON.stringify(sources.map(s => s.getAttribute('srcset') ?? ''));
        }
        let cleared = false;
        sources.forEach(s => { if (s.hasAttribute('srcset')) { s.removeAttribute('srcset'); cleared = true; } });
        return cleared;
    } else if (img.dataset.mtSrcsets !== undefined) {
        let saved: string[] = [];
        try { saved = JSON.parse(img.dataset.mtSrcsets); } catch { /* corrupt — leave cleared */ }
        sources.forEach((s, i) => { if (saved[i]) s.setAttribute('srcset', saved[i]); });
        delete img.dataset.mtSrcsets;
    }
    return false;
}

// Extension-owned copy of the original page, for "Show original" on
// blob-origin readers (MangaDex etc.): the reader's blob URL is dead or
// unassignable (the dead-orig guard in writePage), so the only reliable way
// back is a blob WE own, minted while the pixels are still readable. PNG on
// purpose — healImgBinding/repaintByHash re-hash element pixels against
// state.hash; a lossy re-encode would never match and would drop bindings /
// re-translate the page. Giant strips skip the copy (encode + memory cost):
// blob readers serve book-sized pages, not 13k-px manhwa strips.
export const OWN_COPY_MAX_PIXELS = 4_000_000;
export function ownCopyNeeded(orig: string, w: number, h: number): boolean {
    return orig.startsWith('blob:') && w * h <= OWN_COPY_MAX_PIXELS;
}
export async function ownOriginalUrl(bitmap: ImageBitmap): Promise<string | undefined> {
    try {
        const c = new OffscreenCanvas(bitmap.width, bitmap.height);
        c.getContext('2d')!.drawImage(bitmap, 0, 0);
        return URL.createObjectURL(await c.convertToBlob({ type: 'image/png' }));
    } catch {
        return undefined; // no copy — the old (blocked) behavior, never a broken page
    }
}

// explicit "show original" beats everything; each side keeps its own debug
// view when debug is on (falls back gracefully on pages rendered before it)
export function shownSrc(st: PageState): string {
    if (!overlayOn) return debugOn && st.debugOrig ? st.debugOrig : (st.origOwn ?? st.orig);
    if (debugOn && st.debug) return st.debug;
    return st.translated;
}

// pixels out: img swaps src to the translated blob (existing behavior),
// canvas gets the translated bitmap drawn back over itself (same in-place
// philosophy, no overlay layer). Re-applied by the sweep — a reader redraw
// underneath is painted over again within 2s.
export function writePage(ref: PageRef, state: PageState): void {
    if (ref.kind === 'img') {
        // single writer for img src — the sweep used to assign src directly and
        // bypassed syncPictureSources (AVIF kept showing through). The src guard
        // avoids reload flicker, but <source> clearing runs EVERY sweep while
        // translated: those readers re-render <picture> on page turns and fresh AVIF
        // srcsets beat our blob even when img.src is already right (the revert
        // bug). Clearing a srcset attribute never reloads the img, so this is
        // free — and the warn below is the fight detector if reverts persist.
        const src = shownSrc(state);
        const translated = src !== state.orig;
        // dead-orig guard: revoked-blob readers leave state.orig pointing at a
        // dead blob: URL while the live element shows something else (a fresh
        // original or our translation). Assigning the dead URL blanks the page —
        // leave the live pixels alone (reader navigation restores originals).
        if (ref.el.src !== src && !srcAssignBlocked(ref.el.src, src, state.orig)) ref.el.src = src;
        if (translated) {
            if (syncPictureSources(ref.el, true)) console.warn('[mt] re-cleared resurrected <source> srcsets (reader re-rendered <picture>)');
        } else {
            syncPictureSources(ref.el, false);
        }
        elStates.set(ref.el, state);
        return;
    }
    if (!state.translatedBmp && overlayOn) return; // debug toggle on canvas: translated only
    // canvas has no src to swap — repaint from kept bitmaps, honoring Show
    // original (stashed bytes: the viewer never redraws, nothing else can
    // restore them) and debug frames, the same choice shownSrc makes for img.
    // Decodes resolve once then cache on the state, so the 1s sweep stays a
    // cheap drawImage. Staleness-guarded: a double toggle mid-decode must not
    // paint the losing side.
    const wantOverlay = overlayOn, wantDebug = debugOn;
    const which = !wantOverlay
        ? (wantDebug && state.debugOrig ? 'debugOrig' as const : 'orig' as const)
        : (wantDebug && state.debug ? 'debug' as const : 'translated' as const);
    void canvasPaintSrc(state, which).then(bmp => {
        if (!bmp) { if (isDebug()) console.warn('[mt] canvas paint source unavailable:', which); return; }
        if (overlayOn !== wantOverlay || debugOn !== wantDebug) return;
        const ctx = ref.el.getContext('2d');
        if (!ctx) { console.warn('[mt] canvas page is not 2d — leaving original'); return; }
        ctx.drawImage(bmp, 0, 0, ref.el.width, ref.el.height);
        elStates.set(ref.el, state);
    });
    return;
}

// canvas paint sources: translated lives decoded already; original and debug
// frames decode once on first use (blob URLs / stashed bytes, no network)
// and cache on the state
async function canvasPaintSrc(state: PageState, which: 'orig' | 'translated' | 'debug' | 'debugOrig'): Promise<ImageBitmap | undefined> {
    if (which === 'translated') return state.translatedBmp;
    if (which === 'orig') {
        if (!state.origBmp && state.origBytes) {
            try {
                state.origBmp = await createImageBitmap(new Blob([state.origBytes]));
            } catch { return undefined; }
        }
        return state.origBmp;
    }
    const key = which === 'debug' ? 'debugBmp' : 'debugOrigBmp';
    const url = which === 'debug' ? state.debug : state.debugOrig;
    if (!state[key] && url) {
        try {
            state[key] = await createImageBitmap(await (await fetch(url)).blob());
        } catch { return undefined; }
    }
    return state[key];
}

// fast repaint lane: an element with NO state (unknown URL, no binding —
// typically back-nav after the reader minted a fresh blob) showing KNOWN
// content repaints here, inside the sweep, with no queue / prep / book fold.
// First-time pages miss the index and stay on the auto/manual queue. Decode +
// 48×48 hash is ms-scale, no network; tainted/undecoded elements bail silently.
export async function repaintByHash(el: HTMLImageElement): Promise<void> {
    const src = el.src;
    if (!src || pages.has(src) || elStates.get(el) || hashPending.get(el) === src || hashMiss.get(el) === src) return;
    hashPending.set(el, src);
    try {
        let bmp: ImageBitmap;
        try {
            bmp = await createImageBitmap(el);
        } catch { return; }
        const W = bmp.width, H = bmp.height;
        let h: string;
        try {
            h = pageHashFromBitmap(bmp);
        } catch { return; } // tainted bitmap — queue path handles it (screenshot)
        finally {
            try { bmp.close(); } catch { /* already closed */ }
        }
        if (el.src !== src) return; // rotated mid-hash — next sweep re-fires
        const e = hashStates.get(h);
        if (e && e.w === W && e.h === H) {
            pages.set(src, e.state);
            elStates.set(el, e.state);
            writePage({ kind: 'img', el }, e.state);
            if (isDebug()) console.log('[mt] seam?', JSON.stringify({ why: 'hash-repaint', src: src.slice(-14) }));
        } else {
            hashMiss.set(el, src); // genuinely new — stop re-hashing until src changes
        }
    } finally {
        if (hashPending.get(el) === src) hashPending.delete(el);
    }
}

// unknown-src triangulation: the element is bound to a state but shows a URL
// the pages map never saw (blob-rotating reader minted a fresh URL). Never
// paint blind — a recycled node may show a DIFFERENT page now. Hash the live
// decoded pixels (no network, ms-scale) against the state's original hash:
// match → alias the new URL (identity heals forward) + paint; mismatch → drop
// the binding so autoTick treats it as the new page it is. Taint/decode
// failures are unverifiable — keep the binding and retry never (negative
// cache per src); the next src change re-arms.
export async function healImgBinding(el: HTMLImageElement, state: PageState): Promise<void> {
    const src = el.src;
    if (!src || pages.has(src) || verifying.get(el) === src || verifyFailed.get(el) === src || state.hash == null) return;
    verifying.set(el, src);
    try {
        if (pages.has(el.src)) return; // healed concurrently while decoding
        let bmp: ImageBitmap;
        try {
            bmp = await createImageBitmap(el);
        } catch { verifyFailed.set(el, src); return; }
        // src rotated mid-decode — this result is about NOBODY now; the sweep
        // re-fires for the current src on its next pass
        const cur = el.src;
        if (cur !== src) return;
        try {
            if (pageHashFromBitmap(bmp) === state.hash) {
                pages.set(cur, state);
                elStates.set(el, state);
                writePage({ kind: 'img', el }, state);
                if (isDebug()) console.log('[mt] seam?', JSON.stringify({ why: 'url-healed', src: cur.slice(-14) }));
            } else if (elStates.get(el) === state) {
                elStates.delete(el);
                if (isDebug()) console.log('[mt] seam?', JSON.stringify({ why: 'binding-dropped', src: cur.slice(-14) }));
            }
        } catch {
            verifyFailed.set(el, cur); // tainted bitmap — unverifiable, never retry this src
        } finally {
            try { bmp.close(); } catch { /* already closed */ }
        }
    } finally {
        if (verifying.get(el) === src) verifying.delete(el);
    }
}
