// Detection client: spawns a hidden extension-origin iframe (which is allowed
// to compile wasm under OUR CSP — the host page's CSP blocks it) and talks to
// it via postMessage.

export interface DetBox {
    x1: number; y1: number; x2: number; y2: number;
    conf: number;
}

export interface DetectResult {
    boxes: DetBox[];
    // { width, height, data: ArrayBuffer } — 1 byte/pixel mask, 255 = text
    mask: { width: number; height: number; data: ArrayBuffer };
    inferMs: number;
    initMs?: number;    // one-time session cost (0/absent on reuse) — timing breakdown only
    ep: string;
    lockWaitMs?: number; // ms this page's detect runs waited on the shared ORT lock (0 = uncontended)
    cloudTexts?: string[]; // cloud path: OCR texts aligned 1:1 with boxes (raw — caller trims)
    cloudMs?: { detect: number; ocr: number }; // cloud path: server-side breakdown
    panelMs?: number;   // YOLO panel infer ms (0/absent when skipped) — timing breakdown only
    panels?: DetBox[];      // YOLO panel boxes (empty when the model is missing)
    panelSkipped?: string;  // why panel ordering was skipped (strip aspect / gate) — page-result log only
    dropped?: DetBox[];     // CTD near-misses below threshold — debug overlay only
    panelDropped?: DetBox[]; // YOLO panels below threshold — debug overlay only
}

// ---- strip tiling: CTD letterboxes the long side to 1024, so an 800×13650
// strip feeds the model ~3px-tall text (nothing detects that). Split extreme-
// aspect pages into overlapping near-natural-scale tiles, detect per tile,
// merge. Pure geometry — unit tested.

export const STRIP_ASPECT = 3;   // above this (either axis) a page is a strip
export const TILE_SIZE = 1200;   // tile long-side target at natural scale
export const TILE_OVERLAP = 180; // must exceed max dialogue line height (~80px)

export interface Tile { x0: number; y0: number; w: number; h: number }

// [] when the page isn't a strip — the caller runs the single-pass path.
export function splitTiles(w: number, h: number): Tile[] {
    const vertical = h >= w;
    const long = vertical ? h : w;
    const short = vertical ? w : h;
    if (long / short <= STRIP_ASPECT) return [];
    const step = TILE_SIZE - TILE_OVERLAP;
    const n = Math.max(2, Math.ceil((long - TILE_OVERLAP) / step));
    // distribute evenly so the last tile ends exactly at the edge (no sliver)
    const len = (long + (n - 1) * TILE_OVERLAP) / n;
    const out: Tile[] = [];
    for (let i = 0; i < n; i++) {
        const o = Math.round(i * (len - TILE_OVERLAP));
        out.push(vertical
            ? { x0: 0, y0: o, w, h: Math.round(len) }
            : { x0: o, y0: 0, w: Math.round(len), h });
    }
    return out;
}

// Merge per-tile boxes (tile coords) into page coords. Two rules, in order:
// 1. seam-union: boxes from DIFFERENT tiles that touch across a seam (gap ≤
//    8px) with x/y-overlap ≥50% of the smaller side union into one — a text
//    cut by the seam is fully visible in the neighbor tile, so the pair is
//    one text, never two translations. Fixpoint (giant SFX can span tiles).
// 2. same-tile overlaps are NOT touched — worker-side NMS owns those.
// Returns page-coord boxes; confidences ride along (max on union).
export function mergeTileBoxes(tiled: { tile: Tile; boxes: DetBox[] }[]): DetBox[] {
    type T = DetBox & { ti: number };
    const all: T[] = tiled.flatMap((t, ti) => t.boxes.map(b => ({
        x1: b.x1 + t.tile.x0, y1: b.y1 + t.tile.y0,
        x2: b.x2 + t.tile.x0, y2: b.y2 + t.tile.y0,
        conf: b.conf, ti,
    })));
    let changed = true;
    while (changed) {
        changed = false;
        outer: for (let i = 0; i < all.length; i++) {
            for (let j = i + 1; j < all.length; j++) {
                const a = all[i], b = all[j];
                if (a.ti === b.ti) continue;
                const gx = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
                const gy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
                const gapX = Math.max(a.x1 - b.x2, b.x1 - a.x2, 0);
                const gapY = Math.max(a.y1 - b.y2, b.y1 - a.y2, 0);
                const touch = (gx > 0 || gapX <= 8) && (gy > 0 || gapY <= 8);
                if (!touch) continue;
                const overlapSpan = Math.max(gx, gy);
                const minSide = Math.min(a.x2 - a.x1, a.y2 - a.y1, b.x2 - b.x1, b.y2 - b.y1);
                if (overlapSpan < 0.5 * minSide) continue;
                all[i] = {
                    x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
                    x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2),
                    conf: Math.max(a.conf, b.conf), ti: a.ti,
                };
                all.splice(j, 1);
                changed = true;
                break outer;
            }
        }
    }
    return all.map(({ x1, y1, x2, y2, conf }) => ({ x1, y1, x2, y2, conf }));
}

// Region numbering order: the detector emits confidence order, so sort into
// reading order before anything numbers the boxes. Row bands by y-center
// gaps (top to bottom), x-columns within each band from the reading-start
// side. Pure geometry on the boxes themselves — no pixels, so backgrounds
// can never fool it. Pure — unit tested.
// ponytail: flat bands, not XY-cut — pixel panel segmentation died in
// prototyping (window lines, text gaps and screentone fake every gutter
// threshold). Residual miss: vertically-overlapping staggered rows merge
// into one band and fall back to RTL; upgrade only if seen live.
export function sortReadingOrder(boxes: DetBox[], dir: 'rtl' | 'ltr', page?: { w: number; h: number }, defer = true): DetBox[] {
    return sortReadingOrderBy(boxes, b => b, dir, page, defer);
}

// Generic core so panel rects order with the same rules as text boxes.
export function sortReadingOrderBy<T>(items: T[], rect: (t: T) => DetBox, dir: 'rtl' | 'ltr', page?: { w: number; h: number }, defer = true): T[] {
    if (items.length < 2) return [...items];
    const cy = (t: T) => (rect(t).y1 + rect(t).y2) / 2;
    const hs = items.map(t => { const r = rect(t); return r.y2 - r.y1; }).sort((a, b) => a - b);
    const gap = Math.max(1, hs[Math.floor(hs.length / 2)] * 0.5);
    const bands: T[][] = [];
    for (const t of [...items].sort((a, b) => cy(a) - cy(b))) {
        const last = bands[bands.length - 1];
        if (last && cy(t) - cy(last[last.length - 1]) <= gap) last.push(t);
        else bands.push([t]);
    }
    return bands.flatMap(band => {
        // labels sink to the band's end (stable) — never across rows, see splitDeferred
        if (!page || !defer) return sortBandBy(band, rect, dir);
        const { main, deferred } = splitDeferred(band.map(t => rect(t)), page.w, page.h);
        const back = new Map<DetBox, T>();
        band.forEach(t => back.set(rect(t), t));
        return [...sortBandBy(main.map(m => back.get(m)!), rect, dir), ...sortBandBy(deferred.map(m => back.get(m)!), rect, dir)];
    });
}

// one row band: x-overlap columns from the reading-start side, top first
function sortBandBy<T>(band: T[], rect: (t: T) => DetBox, dir: 'rtl' | 'ltr'): T[] {
    const rest = [...band];
    const cols: T[][] = [];
    while (rest.length) {
        const seed = rest.reduce((a, b) => dir === 'rtl' ? (rect(b).x2 > rect(a).x2 ? b : a) : (rect(b).x1 < rect(a).x1 ? b : a));
        const sr = rect(seed);
        const col = rest.filter(t => { const r = rect(t); return r.x1 < sr.x2 && sr.x1 < r.x2; });
        for (const b of col) rest.splice(rest.indexOf(b), 1);
        col.sort((a, b) => rect(a).y1 - rect(b).y1 || (dir === 'rtl' ? rect(b).x1 - rect(a).x1 : rect(a).x1 - rect(b).x1));
        cols.push(col);
    }
    return cols.flat();
}

// YOLO panel output [N*6]: x1,y1,x2,y2 (0-640 space), conf, class.
// class 1 (text) is skipped entirely — CTD owns text detection.
// In-graph NMS already applied — filter + scale + clamp only.
export const PANEL_CONF_THR = 0.20; // below the card's 0.25: bleed panels live at ~0.3 (probe); 0.15 admits strip FPs on art-heavy pages
const PANEL_FLOOR = 0.05; // below this the graph output is noise, not near-misses
export function parsePanelOutput(data: Float32Array | number[], w: number, h: number, thr = PANEL_CONF_THR): { panels: DetBox[]; dropped: DetBox[] } {
    const panels: DetBox[] = [];
    const dropped: DetBox[] = [];
    for (let i = 0; i + 5 < data.length; i += 6) {
        if (data[i + 5] !== 0) continue;
        const conf = data[i + 4];
        if (conf < PANEL_FLOOR) continue;
        const b = {
            x1: Math.max(0, data[i] / 640 * w), y1: Math.max(0, data[i + 1] / 640 * h),
            x2: Math.min(w, data[i + 2] / 640 * w), y2: Math.min(h, data[i + 3] / 640 * h),
            conf,
        };
        if (b.x2 <= b.x1 || b.y2 <= b.y1) continue;
        if (conf < thr) {
            if (dropped.length < 40) dropped.push(b);
            continue;
        }
        panels.push(b);
    }
    panels.sort((a, b) => ((b.x2 - b.x1) * (b.y2 - b.y1)) - ((a.x2 - a.x1) * (a.y2 - a.y1)));
    return { panels, dropped };
}

// Each box joins the smallest panel containing its center (inset beats
// host), else the nearest panel. Panels order with the same banding rules;
// boxes inside each panel band again. No panels → plain banding.
function nearestPanel(b: DetBox, panels: DetBox[]): number {
    const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
    let best = 0, bestArea = Infinity, found = false;
    panels.forEach((p, i) => {
        if (cx < p.x1 || cx > p.x2 || cy < p.y1 || cy > p.y2) return;
        const a = (p.x2 - p.x1) * (p.y2 - p.y1);
        if (a < bestArea) { bestArea = a; best = i; found = true; }
    });
    if (found) return best;
    let bd = Infinity;
    panels.forEach((p, i) => {
        const dx = Math.max(p.x1 - cx, 0, cx - p.x2);
        const dy = Math.max(p.y1 - cy, 0, cy - p.y2);
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
    });
    return best;
}

// Descriptive labels (room plates, signs) read after a panel's balloon
// dialogue. Proxy, not balloon detection — leoxs22 has no balloon class:
// small boxes (area < SMALL_FRAC of the page) clustered with another small
// box nearby sink to the end, stably. Isolated small boxes (short replies)
// are untouched.
// ponytail: replace with balloon containment if a balloon-class model lands
const SMALL_FRAC = 0.005;
const CLUSTER_GAP_FRAC = 0.05; // of page diagonal
export function splitDeferred(boxes: DetBox[], pageW: number, pageH: number): { main: DetBox[]; deferred: DetBox[] } {
    const small = boxes.filter(b => ((b.x2 - b.x1) * (b.y2 - b.y1)) < SMALL_FRAC * pageW * pageH);
    const gapPx = CLUSTER_GAP_FRAC * Math.hypot(pageW, pageH);
    const linked = new Set<DetBox>();
    for (let i = 0; i < small.length; i++) {
        for (let j = i + 1; j < small.length; j++) {
            const a = small[i], b = small[j];
            const gx = Math.max(0, a.x1 - b.x2, b.x1 - a.x2);
            const gy = Math.max(0, a.y1 - b.y2, b.y1 - a.y2);
            if (Math.hypot(gx, gy) < gapPx) { linked.add(a); linked.add(b); }
        }
    }
    return { main: boxes.filter(b => !linked.has(b)), deferred: boxes.filter(b => linked.has(b)) };
}

// Panel sanity gate: YOLO was trained on whole pages — on extreme-aspect
// strips (manhwa long-strip OR stitched manga pages, same thing geometrically)
// the 640-resize crushes what it learned and it returns sliver soup. Blind
// trust (nearestPanel) then scrambles reading order; banding is correct for
// both cases (pages flow top-to-bottom, in-band order follows readingDir).
// Pure — the caller skips the model call on aspect alone, this gates output.
export function panelsUsable(panels: DetBox[], pageW: number, pageH: number): boolean {
    if (!panels.length) return false;
    if (panels.length > 25) return false; // no real page has 25 panels
    const area = pageW * pageH;
    const biggest = Math.max(...panels.map(p => (p.x2 - p.x1) * (p.y2 - p.y1)));
    // 10%: a normal 2×2-grid page peaks at 25%; sliver soup sits at ~1-2%
    return biggest >= 0.1 * area;
}

export function orderByPanels(boxes: DetBox[], panels: DetBox[], dir: 'rtl' | 'ltr', page?: { w: number; h: number }, defer = true): DetBox[] {
    // no page dims → can't judge usability, keep the old trust-panels behavior
    if (!panels.length || (page && !panelsUsable(panels, page.w, page.h))) return sortReadingOrder(boxes, dir, page, defer);
    const groups: DetBox[][] = panels.map(() => []);
    for (const b of boxes) groups[nearestPanel(b, panels)].push(b);
    return panelReadingOrder(panels, dir).filter(i => groups[i].length)
        .flatMap(i => {
            // whole-group deferral (labels can sit bands above the dialogue)
            if (!page || !defer) return sortReadingOrder(groups[i], dir);
            const { main, deferred } = splitDeferred(groups[i], page.w, page.h);
            return [...sortReadingOrder(main, dir, page, defer), ...sortReadingOrder(deferred, dir, page, defer)];
        });
}

// panel indices in reading order — shared by translation ordering + debug numbers
export function panelReadingOrder(panels: DetBox[], dir: 'rtl' | 'ltr'): number[] {
    return sortReadingOrderBy(panels.map((_, i) => i), i => panels[i], dir);
}

let iframe: HTMLIFrameElement | null = null;
let ready = false;
// per-iframe auth token (see worker.ts handshake) — the page shares our
// postMessage origin, so without this any site JS could drive the worker
let workerToken: string | null = null;
const pending = new Map<number, { resolve: (r: DetectResult) => void; reject: (e: Error) => void }>();
let nextId = 1;
const waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
let listenerInstalled = false;

// the iframe lives in the PAGE's DOM, so the page can remove it (dead
// contentWindow → RPCs time out forever) or swap in a srcdoc document that
// passes a bare source check. Two guards: only messages from OUR extension
// origin count (srcdoc/contentWindow of a hijacked frame carries the page
// origin), and a detached iframe resets the handshake so the next call
// recreates it instead of dying permanently.
function iframeAlive(): boolean {
    if (iframe?.isConnected && iframe.contentWindow) return true;
    if (iframe && !iframe.isConnected) { iframe = null; ready = false; workerToken = null; }
    return false;
}

function installListener(): void {
    if (listenerInstalled) return;
    listenerInstalled = true;
    window.addEventListener('message', async (ev: MessageEvent) => {
        if (ev.source !== iframe?.contentWindow) return;
        if (ev.origin !== chrome.runtime.getURL('/').slice(0, -1)) return; // our extension origin only
        if (ev.data?.type === 'mt:ready') {
            // worker registers its token with the SW under the public nonce
            // before signalling ready — fetch it before resolving so no RPC can
            // race the handshake (nonce-keyed: a second tab's or a hostile page's
            // embedded worker registers under a different key, no clobbering).
            // Never overwrite a good token with null (a failed fetch must not
            // poison a working handshake).
            // mt:ready is posted with '*' — the PAGE sees it and can time an
            // iframe removal into the await below. Generation guard: if this
            // frame was torn down while we fetched, its result is void (the
            // replacement frame's own mt:ready installs its token + resolves).
            const fr = iframe;
            if (!fr || !fr.isConnected) return;
            try {
                const t = ((await chrome.runtime.sendMessage({ type: 'mt:get-worker-token', nonce: ev.data.nonce })) as { token?: string } | undefined)?.token ?? null;
                if (iframe !== fr || !fr.isConnected) return; // stale generation
                if (workerToken === null) workerToken = t;
            } catch { /* keep existing token */ }
            ready = true;
            for (const w of waiters.splice(0)) w.resolve();
        } else if (ev.data?.type === 'mt:detect-result' || ev.data?.type === 'mt:rpc-result') {
            const p = pending.get(ev.data.id);
            pending.delete(ev.data.id);
            // Firefox delivers worker replies that carried a transfer list as
            // LIVE Xray wrappers, not clones (proven live: assigning onto det
            // throws "cross-origin object ... XrayWrapper", while plain replies
            // clone fine). Materialize our own realm's copy at the boundary so
            // every downstream read AND write is same-realm. On Chromium the
            // payload is already plain — one extra copy per page, negligible
            // next to inference. Fall back to the raw payload if cloning fails.
            if (ev.data.ok) {
                let out: unknown = ev.data.result ?? ev.data;
                try { out = structuredClone(out); } catch { /* keep original */ }
                p?.resolve(out as DetectResult);
            } else p?.reject(new Error(ev.data.error));
        }
    });
}

function ensureIframe(): Promise<void> {
    if (ready && iframeAlive()) return Promise.resolve();
    installListener();
    return new Promise((resolve, reject) => {
        if (!iframe) {
            iframe = document.createElement('iframe');
            iframe.src = chrome.runtime.getURL('iframe/worker.html');
            // sized (not 0×0) with opacity 0: zero-sized iframes can be throttled
            // as "not rendered", which slows the wasm OCR loops inside them
            iframe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
            document.documentElement.append(iframe);
        }
        waiters.push({ resolve, reject });
        setTimeout(() => {
            const i = waiters.findIndex(w => w.resolve === resolve);
            if (i >= 0) { waiters.splice(i, 1); reject(new Error('detector iframe timeout')); }
        }, 30000);
    });
}

// pipeline stage for the status pill's stepper (typed so phases never ride
// inside message strings). Order = read → detect → ocr → llm → render.
export type MtStage = 'read' | 'detect' | 'ocr' | 'llm' | 'render';
export type MtOnStatus = (s: string, stage?: MtStage) => void;

export async function ensureDetector(onStatus?: MtOnStatus): Promise<void> {
    onStatus?.('Starting inference worker…', 'detect');
    await ensureIframe();
}

export async function detect(
    img: ImageBitmap | HTMLImageElement,
    onStatus?: MtOnStatus,
    thresholds?: { confThr?: number; minSize?: number; forceWasm?: boolean },
    attempt = 0, // page can tear the iframe down on every mt:ready — cap rebuilds
): Promise<DetectResult> {
    // alive-check BEFORE the PNG encode: a hostile remove-loop must not earn
    // a full-page re-encode per cycle
    if (!iframeAlive()) await ensureIframe();
    const w = 'naturalWidth' in img ? img.naturalWidth : img.width;
    const h = 'naturalHeight' in img ? img.naturalHeight : img.height;
    if (w < 10 || h < 10) throw new Error(`image too small: ${w}x${h}`);
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d')!.drawImage(img, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const png = await blob.arrayBuffer();

    onStatus?.('Detecting text…', 'detect');
    if (workerToken === null) throw new Error('worker auth token missing — reload the page');
    if (!iframeAlive()) {
        if (attempt >= 2) throw new Error('inference iframe kept being torn down — the page may be hostile');
        return detect(img, onStatus, thresholds, attempt + 1); // rebuild + bounded retry
    }
    const cw = iframe!.contentWindow;
    if (!cw) throw new Error('inference iframe unavailable');
    const id = nextId++;
    const p = new Promise<DetectResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error('detect timeout'));
            }
        }, 180000);
    });
    cw.postMessage(
        { type: 'mt:detect', id, png, confThr: thresholds?.confThr, minSize: thresholds?.minSize, forceWasm: thresholds?.forceWasm === true, token: workerToken },
        '*', [png],
    );
    return p;
}

// ---- OCR: Tesseract in the same iframe (lazy-loaded from CDN by the worker) ----

export async function ocrLangsInstalled(langs: string[]): Promise<string[]> {
    await ensureIframe();
    const resp = await iframeRpc({ type: 'mt:ocr-status', langs }) as { installed?: string[] };
    return resp?.installed ?? [];
}

export async function ocrInWorker(png: ArrayBuffer, langs: string[]): Promise<string> {
    await ensureIframe();
    const resp = await iframeRpc({ type: 'mt:ocr', png, langs }, [png]) as { ok: boolean; text?: string; error?: string };
    if (!resp?.ok) throw new Error(resp?.error ?? 'OCR failed');
    return (resp.text ?? '').replace(/\s+/g, ' ').trim();
}

export async function baberuInstalled(): Promise<boolean> {
    await ensureIframe();
    const resp = await iframeRpc({ type: 'mt:baberu-status' }) as { installed?: boolean };
    return !!resp?.installed;
}

// Baberu reads vertical text and dirty backgrounds natively — no rotation,
// no binarization, tighter padding than Tesseract needs
export async function baberuOcr(png: ArrayBuffer): Promise<{ text: string; lockWaitMs: number }> {
    await ensureIframe();
    const resp = await iframeRpc({ type: 'mt:baberu-ocr', png }, [png]) as { ok: boolean; text?: string; lockWait?: number; error?: string };
    if (!resp?.ok) throw new Error(resp?.error ?? 'Baberu OCR failed');
    return { text: (resp.text ?? '').replace(/\s+/g, ' ').trim(), lockWaitMs: resp.lockWait ?? 0 };
}

// ---- Panels: YOLO26n in the same iframe (bundled model, graceful fallback
// to banding when the file is missing) ----

export interface PanelDetectResult {
    panels: DetBox[];
    dropped: DetBox[];
    inferMs: number;
    lockWaitMs?: number; // ms the panel run waited on the shared ORT lock
}

export async function panelsDetect(img: ImageBitmap, thr: number = PANEL_CONF_THR): Promise<PanelDetectResult> {
    await ensureIframe();
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext('2d')!.drawImage(img, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const png = await blob.arrayBuffer();
    const resp = await iframeRpc({ type: 'mt:panels', png, thr }, [png]) as
        { ok: boolean; panels?: DetBox[]; dropped?: DetBox[]; ms?: number; lockWait?: number; error?: string };
    if (!resp?.ok) throw new Error(resp?.error ?? 'panel detection failed');
    return { panels: resp.panels ?? [], dropped: resp.dropped ?? [], inferMs: resp.ms ?? 0, lockWaitMs: resp.lockWait ?? 0 };
}

// ---- Cloud: panel+detect+OCR on your own endpoint (opt-in, Modal).
// Same boxes+texts the local pipeline produces; ordering/rendering stay
// client-side. The mask is synthesized from boxes (inpaint + cache work;
// mask-only SFX recovery is local-only).

async function bitmapToJpeg(bitmap: ImageBitmap, quality: number, gray: boolean): Promise<ArrayBuffer> {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    if (gray) {
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
            d[i] = d[i + 1] = d[i + 2] = y;
        }
        ctx.putImageData(img, 0, 0);
    }
    return (await c.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer();
}

export async function cloudDetect(
    bitmap: ImageBitmap,
    endpoint: string, key: string,
    opts: { confThr: number; minSize: number; quality: number; gray: boolean },
): Promise<DetectResult> {
    const jpeg = new Uint8Array(await bitmapToJpeg(bitmap, opts.quality, opts.gray));
    // base64, not raw bytes: MV3 message passing JSON-serializes the channel
    // (an ArrayBuffer arrives as {} — proven live by a 15-byte "[object…]" body)
    let bin = '';
    for (let i = 0; i < jpeg.length; i += 32768) bin += String.fromCharCode(...jpeg.subarray(i, i + 32768));
    // via the SW: content-script fetch is CORS-gated on the page origin
    // (host permissions don't lift it — same trap as image fetch)
    const resp = await chrome.runtime.sendMessage({
        type: 'mt:cloud-page', endpoint, key,
        confThr: opts.confThr, minSize: opts.minSize, jpegB64: btoa(bin),
    }) as { ok: boolean; page?: any; error?: string };
    if (!resp?.ok) throw new Error(resp?.error ?? 'cloud failed');
    {
        const j = resp.page;
        if (!j?.ok) throw new Error(String(j?.error ?? 'cloud failed'));
        const boxes: DetBox[] = (j.boxes ?? []).map((b: any) => ({ x1: +b.x1, y1: +b.y1, x2: +b.x2, y2: +b.y2, conf: +b.conf }));
        const w = bitmap.width, h = bitmap.height;
        const packed = new Uint8Array(w * h);
        for (const b of boxes) {
            const x1 = Math.max(0, Math.floor(b.x1)), y1 = Math.max(0, Math.floor(b.y1));
            const x2 = Math.min(w, Math.ceil(b.x2)), y2 = Math.min(h, Math.ceil(b.y2));
            for (let y = y1; y < y2; y++) packed.fill(255, y * w + x1, y * w + x2);
        }
        return {
            boxes,
            mask: { width: w, height: h, data: packed.buffer as ArrayBuffer },
            inferMs: Math.round(j.ms?.detect ?? 0),
            ep: 'cloud',
            cloudTexts: (j.texts ?? []).map((t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim()),
            cloudMs: { detect: Math.round(j.ms?.detect ?? 0), ocr: Math.round(j.ms?.ocr ?? 0) },
            panels: [],
            panelSkipped: String(j.panelSkipped ?? 'cloud: banding fallback'),
        };
    }
}

// generic request/response over the iframe postMessage channel
async function iframeRpc(msg: object, transfer?: Transferable[]): Promise<unknown> {
    // null token = handshake failed (e.g. Firefox session-storage fallback lost
    // the SW's memory between register and fetch) — the worker would silently
    // drop the RPC and we'd wait out the full 180s per call. Fail fast instead.
    if (workerToken === null) throw new Error('worker auth token missing — reload the page');
    if (!iframeAlive()) await ensureIframe(); // page tore the iframe down — rebuild
    if (workerToken === null) throw new Error('worker auth token missing — reload the page');
    const cw = iframe?.contentWindow;
    if (!cw) throw new Error('inference iframe unavailable'); // torn down again mid-await
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (r: DetectResult) => void, reject });
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error('iframe rpc timeout'));
            }
        }, 180000);
        cw.postMessage({ ...msg, id, token: workerToken }, '*', transfer);
    });
}
