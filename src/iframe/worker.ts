// Inference worker page (extension origin) — runs CTD ONNX via ORT here because
// the host page's CSP blocks wasm compilation in every world.
// Receives PNG bytes via postMessage, returns boxes + packed mask.

export interface DetBox {
    x1: number; y1: number; x2: number; y2: number;
    conf: number;
}

const INPUT = 1024;
const CONF_THR = 0.35;
const NMS_THR = 0.35;
const MASK_THR = 0.3;
const MIN_SIZE = 12; // px — configurable via mt:detect message

// ORT loaded natively (never bundled through esbuild — it breaks Emscripten glue).
// Path is built at runtime so esbuild leaves the import alone.
const ORT_URL = new URL('../ort/ort.webgpu.bundle.min.mjs', import.meta.url).href;
const ort: any = await import(/* @vite-ignore */ ORT_URL).catch((e: unknown) => {
    throw new Error(`ORT runtime load failed (${ORT_URL}): ${String((e as Error)?.message ?? e)}`);
});
ort.env.wasm.numThreads = 1; // iframe isn't cross-origin isolated

let session: any = null;
let sessionEp = '';
let sessionWasm = false; // EP the live session was built with (evict on change)
let creating: Promise<void> | null = null;
let sessionInitMs = 0; // one-time cost (model upload + shader compile) — 0 on reuse
let ctdEvictedOnce = false; // corrupt-download eviction fires once per page lifetime (never loop re-downloads on tiny devices)

// Concurrent detects (queue: next page's CTD runs while the current page's
// LLM call is in flight) must not both create a session — ORT throws
// "Session already started". Memoize the creation promise.
// Model sources, in order: IndexedDB cache → dist bundle (dev/E2E builds
// only — production dist ships no models) → HF runtime mirror (pinned,
// downloaded once per install). Same IDB keys as before ('ctd'/'panel').
// URLs live in ocr-models (DET_URL) — single source for worker + options.

function idbStore(db: IDBDatabase, mode: IDBTransactionMode) {
    return db.transaction('m', mode).objectStore('m');
}

async function openModelsDb(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
        const r = indexedDB.open('mt-models', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('m');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}

// one model file through the whole chain (throws with a user-actionable message).
// Returns whether the bytes were freshly downloaded — a session.create failure
// on fresh bytes means a corrupt download (evict so the next retry re-fetches
// instead of re-reading poison); on cached bytes it means an environment
// problem (keep the cache, retrying must not re-download 40MB).
async function loadModelFile(key: string, bundlePath: string, hfFile: string, label: string): Promise<{ buf: ArrayBuffer; fresh: boolean }> {
    const db = await openModelsDb();
    const cached = await new Promise<ArrayBuffer | undefined>(res => {
        const q = idbStore(db, 'readonly').get(key);
        q.onsuccess = () => res(q.result);
        q.onerror = () => res(undefined);
    });
    if (cached) return { buf: cached, fresh: false };
    const dl = async (url: string) => fetchWithProgress(url, (loaded, total) => {
        if (isDebug() && loaded % (10 * 1024 * 1024) < 65536) console.log(`[mt] ${label} ${(loaded / 1e6).toFixed(0)}MB${total ? ` / ${(total / 1e6).toFixed(0)}MB` : ''} (once per install)…`);
    });
    let buf: ArrayBuffer | undefined;
    try {
        buf = await dl(chrome.runtime.getURL(bundlePath));
    } catch { /* production dist ships no models — fall through to HF */ }
    if (!buf) {
        if (isDebug()) console.log(`[mt] downloading ${label} (once per install)…`);
        try {
            buf = await dl(DET_URL(hfFile));
        } catch (e) {
            throw new Error(`${label} download failed — check connection and retry (${String((e as Error)?.message ?? e)})`);
        }
    }
    idbStore(db, 'readwrite').put(buf, key);
    return { buf, fresh: true };
}

async function evictModelFile(key: string): Promise<void> {
    try {
        const db = await openModelsDb();
        await new Promise<void>(res => {
            const q = idbStore(db, 'readwrite').delete(key);
            q.onsuccess = () => res();
            q.onerror = () => res();
        });
    } catch { /* best effort */ }
}

async function ensureSession(forceWasm = false): Promise<void> {
    // evict ONLY when the user demands wasm but we hold a webgpu session —
    // 'auto' accepts its own wasm fallback (a GPU-less machine would otherwise
    // rebuild the session on every single detect). Release INSIDE the infer
    // lock: an in-flight run of this session may still be executing, and
    // releasing under it kills the run (runDetect holds its own ref, but ORT
    // may reject the call outright).
    if (session && forceWasm && !sessionWasm) {
        const old = session;
        session = null; sessionEp = '';
        try { await withInferLock(() => old.release?.()); } catch { /* best effort */ }
    }
    if (session) return;
    if (!creating) {
        creating = (async () => {
            const tInit = performance.now();
            const { buf, fresh } = await loadModelFile('ctd', 'models/ctd-int8.onnx', 'ctd-int8.onnx', 'CTD model (~40MB)');
            try {
                if (forceWasm) throw new Error('forced wasm');
                // inside the lock: the evicted session's in-flight run may still be
                // executing — an unlocked create here hits the global "Session
                // already started" guard (live-proven class of failure)
                session = await withInferLock(() => ort.InferenceSession.create(buf, { executionProviders: ['webgpu'] }));
                sessionEp = 'webgpu';
            } catch {
                // wasm create shares the runtime-wide session guard with every other
                // wasm run/create — ride the chain or a concurrent inference throws
                // "Session already started" at us
                try {
                    session = await withInferLock(() => ort.InferenceSession.create(buf, { executionProviders: ['wasm'] }));
                    sessionEp = 'wasm';
                } catch (e) {
                    // fresh bytes that don't parse are a corrupt download, not a bad
                    // device — evict so the next retry re-fetches instead of re-reading
                    // poison (cached bytes are kept: that failure is environmental).
                    // Once per lifetime: a too-small device must not loop re-downloads.
                    if (fresh && !ctdEvictedOnce) { ctdEvictedOnce = true; await evictModelFile('ctd'); }
                    throw e;
                }
            }
            sessionWasm = sessionEp === 'wasm';
            (globalThis as any).__mtReady = sessionEp;
            sessionInitMs = Math.round(performance.now() - tInit);
        })().finally(() => { creating = null; }); // clear so a failure can retry
    }
    await creating;
    // race guard: a concurrent caller with the OTHER forceWasm value may have
    // owned the create we just awaited — re-check instead of running on the
    // wrong EP (bounded recursion: the second create matches some waiter)
    if (session && forceWasm && !sessionWasm) return ensureSession(forceWasm);
}

function nms(boxes: number[][], confs: number[]): number[] {
    const idx = confs.map((_, i) => i).sort((a, b) => confs[b] - confs[a]);
    const keep: number[] = [];
    while (idx.length) {
        const i = idx.shift()!;
        keep.push(i);
        for (let j = idx.length - 1; j >= 0; j--) {
            const a = boxes[i], b = boxes[idx[j]];
            const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
            const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
            const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
            const areaA = (a[2] - a[0]) * (a[3] - a[1]);
            const areaB = (b[2] - b[0]) * (b[3] - b[1]);
            if (inter / (areaA + areaB - inter) > NMS_THR) idx.splice(j, 1);
        }
    }
    return keep;
}

// ORT's wasm glue throws "Session already started" if two inferences hit the
// same session concurrently — the session object handles one run at a time.
// Mutex JUST the inference call: decode/preprocess/mask/NMS stay parallel,
// ORT's "Session already started" guard turned out to be GLOBAL across the
// whole Emscripten runtime — every session, every EP, creates AND runs
// (live-proven twice: wasm-create vs wasm-run, then gpu-vision vs
// gpu-prefill on separate chains). ONE chain for everything ORT. The
// pipeline overlap lives on the CPU side (crops, preprocess, LLM calls).
const chains = new Map<string, Promise<void>>();
// lock contention meter: cumulative ms ORT runs spent queued on the infer
// lock behind other models' runs. Handlers snapshot per-RPC deltas into
// their replies — the page-result dump shows whether detect/panel/ocr
// actually blocked on each other (0 = the lock was free).
let lockWaitMs = 0;
function withInferLock<T>(fn: () => Promise<T>, chainId = 'ort'): Promise<T> {
    const t0 = performance.now();
    const chain = chains.get(chainId) ?? Promise.resolve();
    const run = chain.then(async () => { lockWaitMs += performance.now() - t0; return fn(); });
    chains.set(chainId, run.then(() => {}, () => {}));
    return run;
}
async function metered<T>(fn: () => Promise<T>): Promise<{ v: T; lockWait: number }> {
    const w0 = lockWaitMs;
    const v = await fn();
    return { v, lockWait: Math.round(lockWaitMs - w0) };
}

// One model pass over a bitmap region (full page or one tile): box-head
// predictions in REGION coords + the raw text-probability mask at region size.
// Extracted verbatim from the old monolithic runDetect — same pixels in,
// same numbers out; tiling just calls it N times.
async function inferOnce(bmp: ImageBitmap, confThr: number): Promise<{  boxes: number[][]; confs: number[]; lowBoxes: number[][]; lowConfs: number[];
    prob: Float32Array; inferMs: number;
}> {
    const w = bmp.width, h = bmp.height;
    const s = INPUT / Math.max(w, h);
    const nw = Math.round(w * s), nh = Math.round(h * s);
    const c = new OffscreenCanvas(INPUT, INPUT);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#717171';
    ctx.fillRect(0, 0, INPUT, INPUT);
    ctx.drawImage(bmp, 0, 0, nw, nh);
    const data = ctx.getImageData(0, 0, INPUT, INPUT).data;
    const x = new Float32Array(3 * INPUT * INPUT);
    const N = INPUT * INPUT;
    for (let i = 0; i < N; i++) {
        x[i] = data[i * 4] / 255;         // R — CTD expects RGB (spike: lb[:,:,::-1])
        x[i + N] = data[i * 4 + 1] / 255; // G
        x[i + 2 * N] = data[i * 4 + 2] / 255; // B
    }

    const t0 = performance.now();
    // local ref: a concurrent detEp flip may evict the global between passes
    // of the tile loop — this inference still runs on the session it started
    // with (the evict's release waits on the infer lock this run holds)
    const sess = session;
    if (!sess) throw new Error('CTD session unavailable');
    const res: any = await withInferLock(() => sess.run({ image: new ort.Tensor('float32', x, [1, 3, INPUT, INPUT]) }));
    const inferMs = performance.now() - t0;

    const raw = res.bbox_preds.data as Float32Array;
    const n = raw.length / 7;
    const boxes: number[][] = [];
    const confs: number[] = [];
    // ALL box-head predictions ≥0.05 (pre-threshold) — corroboration signal for
    // mask components: "the box head also thinks something texty is here"
    const lowBoxes: number[][] = [];
    const lowConfs: number[] = [];
    for (let i = 0; i < n; i++) {
        const o = i * 7;
        const conf = raw[o + 4] * Math.max(raw[o + 5], raw[o + 6]);
        if (conf < 0.05) continue;
        const cx = raw[o], cy = raw[o + 1], bw = raw[o + 2], bh = raw[o + 3];
        const bx = [(cx - bw / 2) / s, (cy - bh / 2) / s, (cx + bw / 2) / s, (cy + bh / 2) / s];
        lowBoxes.push(bx); lowConfs.push(conf);
        if (conf < confThr) continue;
        boxes.push(bx); confs.push(conf);
    }

    // mask [1,1,1024,1024] -> region size. Keep the RAW probability 0-1 —
    // the mean prob inside each component is the free text-likelihood signal.
    const mraw = res.mask.data as Float32Array;
    const mCanvas = new OffscreenCanvas(nw, nh);
    const mCtx = mCanvas.getContext('2d', { willReadFrequently: true })!;
    const mImg = mCtx.createImageData(nw, nh);
    for (let y = 0; y < nh; y++) {
        for (let xx = 0; xx < nw; xx++) {
            const p = Math.min(255, Math.max(0, Math.round(mraw[y * INPUT + xx] * 255)));
            mImg.data[(y * nw + xx) * 4 + 3] = p;
            mImg.data[(y * nw + xx) * 4] = 255;
        }
    }
    mCtx.putImageData(mImg, 0, 0);
    const full = new OffscreenCanvas(w, h);
    full.getContext('2d')!.drawImage(mCanvas, 0, 0, w, h);
    const maskData = full.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h);
    const prob = new Float32Array(w * h);
    for (let i = 0; i < prob.length; i++) prob[i] = maskData.data[i * 4 + 3] / 255;
    return { boxes, confs, lowBoxes, lowConfs, prob, inferMs };
}

async function runDetect(png: ArrayBuffer, confThr: number, minSize: number, forceWasm = false): Promise<unknown> {
    await ensureSession(forceWasm);
    const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
    const w = bitmap.width, h = bitmap.height;
    // strips tile (splitTiles [] unless aspect>3): each tile infers at near-
    // natural scale, then boxes seam-merge + masks max-stitch below. Single
    // path for normal pages — byte-identical behavior to before.
    const tiles = splitTiles(w, h);
    let boxes: number[][], confs: number[], lowBoxes: number[][], lowConfs: number[];
    let prob: Float32Array, inferMs = 0;
    if (!tiles.length) {
        ({ boxes, confs, lowBoxes, lowConfs, prob, inferMs } = await inferOnce(bitmap, confThr));
    } else {
        const per: { tile: Tile; r: Awaited<ReturnType<typeof inferOnce>> }[] = [];
        for (const t of tiles) {
            const tc = new OffscreenCanvas(t.w, t.h);
            tc.getContext('2d')!.drawImage(bitmap, t.x0, t.y0, t.w, t.h, 0, 0, t.w, t.h);
            per.push({ tile: t, r: await inferOnce(await createImageBitmap(tc), confThr) });
        }
        const merged = mergeTileBoxes(per.map(p => ({
            tile: p.tile,
            boxes: p.r.boxes.map((b, i) => ({ x1: b[0], y1: b[1], x2: b[2], y2: b[3], conf: p.r.confs[i] })),
        })));
        boxes = merged.map(b => [b.x1, b.y1, b.x2, b.y2]);
        confs = merged.map(b => b.conf);
        lowBoxes = per.flatMap(p => p.r.lowBoxes.map(b => [b[0] + p.tile.x0, b[1] + p.tile.y0, b[2] + p.tile.x0, b[3] + p.tile.y0]));
        lowConfs = per.flatMap(p => p.r.lowConfs);
        prob = new Float32Array(w * h);
        for (const p of per) {
            const { tile: t, r } = p;
            for (let y = 0; y < t.h; y++) {
                for (let x = 0; x < t.w; x++) {
                    const v = r.prob[y * t.w + x];
                    const o = (t.y0 + y) * w + (t.x0 + x);
                    if (v > prob[o]) prob[o] = v;
                }
            }
            inferMs += r.inferMs;
        }
    }
    // binary text mask from the stitched/single probability field — the
    // component passes below (mask-only SFX recovery, overlap gate) run on
    // this exactly as before, tiled or not
    const keep = nms(boxes, confs).filter(i => {
        const b = boxes[i];
        return (b[2] - b[0]) > minSize && (b[3] - b[1]) > minSize; // kills window-texture false positives
    });
    const packed = new Uint8Array(w * h);
    for (let i = 0; i < packed.length; i++) packed[i] = prob[i] > MASK_THR ? 255 : 0;

    // Mask-only text: connected components of the text mask that no detected
    // box covers (handwriting/SFX the box head missed — the mask head sees it).
    // Nearby components merge first (handwriting breaks into per-line fragments;
    // merging keeps the translation complete instead of line-partial). Each
    // merged region becomes a regular region: badged, cropped, sent to the LLM,
    // whose keep rule neutralizes non-text components (windows, texture noise).
    // Containment gate for CTD boxes themselves: a low-conf sub-box drowned
    // inside a bigger box (the box head splitting one bubble's first line off,
    // seen at conf 0.22 fully inside a 0.46 bubble when detConf is lowered)
    // renders the same text twice. If ≥80% of a box is inside another, drop
    // whichever has lower confidence.
    const contained = new Set<number>();
    for (let i = 0; i < keep.length; i++) {
        for (let j = 0; j < keep.length; j++) {
            if (i === j || contained.has(i) || contained.has(j)) continue;
            const a = boxes[keep[i]], b = boxes[keep[j]];
            const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
            const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
            const inter = ix * iy;
            const aArea = (a[2] - a[0]) * (a[3] - a[1]);
            const bArea = (b[2] - b[0]) * (b[3] - b[1]);
            if (!inter) continue;
            if (inter > 0.8 * aArea) contained.add(confs[keep[i]] <= confs[keep[j]] ? keep[i] : keep[j]);
            else if (inter > 0.8 * bArea) contained.add(confs[keep[j]] < confs[keep[i]] ? keep[j] : keep[i]);
        }
    }
    const keepFinal = keep.filter(i => !contained.has(i));

    const outBoxes = keepFinal.map(i => ({
        x1: Math.max(0, boxes[i][0]), y1: Math.max(0, boxes[i][1]),
        x2: Math.min(w, boxes[i][2]), y2: Math.min(h, boxes[i][3]),
        conf: confs[i],
    }));
    const overlap = (b: { x1: number; y1: number; x2: number; y2: number }) =>
        outBoxes.some(o => {
            const ix = Math.max(0, Math.min(o.x2, b.x2) - Math.max(o.x1, b.x1));
            const iy = Math.max(0, Math.min(o.y2, b.y2) - Math.max(o.y1, b.y1));
            const inter = ix * iy;
            // two-way gate: the two model heads disagree on box edges, so a mask
            // component of the SAME text can pass a one-sided check (saw 48%) and
            // render the translation twice. Cut on EITHER small overlap — touching
            // edges is enough evidence they're the same text.
            return inter > 0.05 * (b.x2 - b.x1) * (b.y2 - b.y1)
                || inter > 0.15 * (o.x2 - o.x1) * (o.y2 - o.y1);
        });
    // pass 1: collect components (count + mask-prob sum for the quality gate)
    type Comp = { x1: number; y1: number; x2: number; y2: number; count: number; probSum: number };
    const comps: Comp[] = [];
    const seen = new Uint8Array(packed.length);
    const stack: number[] = [];
    for (let p = 0; p < packed.length && comps.length < 400; p++) {
        if (!packed[p] || seen[p]) continue;
        stack.length = 0; stack.push(p); seen[p] = 1;
        let minX = w, minY = h, maxX = 0, maxY = 0, count = 0, probSum = 0;
        while (stack.length) {
            const q = stack.pop()!;
            const x = q % w, y = (q / w) | 0;
            count++; probSum += prob[q];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (x > 0 && packed[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; stack.push(q - 1); }
            if (x < w - 1 && packed[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; stack.push(q + 1); }
            if (y > 0 && packed[q - w] && !seen[q - w]) { seen[q - w] = 1; stack.push(q - w); }
            if (y < h - 1 && packed[q + w] && !seen[q + w]) { seen[q + w] = 1; stack.push(q + w); }
        }
        if (maxX - minX + 1 >= 8 && maxY - minY + 1 >= 8) comps.push({ x1: minX, y1: minY, x2: maxX + 1, y2: maxY + 1, count, probSum });
    }
    // pass 2: merge components whose boxes touch when padded (line spacing)
    const GAP = 28;
    let merged = true;
    while (merged) {
        merged = false;
        outer: for (let i = 0; i < comps.length; i++) {
            for (let j = i + 1; j < comps.length; j++) {
                const a = comps[i], b = comps[j];
                const sep = a.x1 - GAP > b.x2 || b.x1 - GAP > a.x2 || a.y1 - GAP > b.y2 || b.y1 - GAP > a.y2;
                if (!sep) {
                    comps[i] = {
                        x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
                        x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2),
                        count: a.count + b.count,
                        probSum: a.probSum + b.probSum,
                    };
                    comps.splice(j, 1);
                    merged = true;
                    break outer;
                }
            }
        }
    }
    // pass 3: filter + emit
    const maskBoxes: typeof outBoxes = [];
    const pageArea = w * h;
    for (const c of comps) {
        if (maskBoxes.length >= 16) break;
        const bw = c.x2 - c.x1, bh = c.y2 - c.y1;
        const fill = c.count / (bw * bh);
        // text strokes are sparse-but-present (not solid blocks like windows,
        // not dust); min bbox side keeps single pixels out; cap area stops
        // GAP-merges that swallow whole panels
        if (bw < 14 || bh < 14 || fill < 0.02 || fill > 0.6) continue;
        if (bw * bh > 0.2 * pageArea) continue;
        if (overlap(c)) continue;
        // FREE text-likelihood gate (evidence: 8-page sweep — p4 handwriting
        // 4/4 survive, p7 window false-positives 0/12 pass, junk cut 70%):
        // mean raw mask prob inside the component, corroborated by any
        // low-confidence box-head prediction overlapping it
        const maskProb = c.probSum / c.count;
        let boxConf = 0;
        const cArea = bw * bh;
        for (let i = 0; i < lowBoxes.length; i++) {
            const bx = lowBoxes[i];
            const ix = Math.max(0, Math.min(bx[2], c.x2) - Math.max(bx[0], c.x1));
            const iy = Math.max(0, Math.min(bx[3], c.y2) - Math.max(bx[1], c.y1));
            if (ix * iy > 0.1 * cArea && lowConfs[i] > boxConf) boxConf = lowConfs[i];
        }
        if (maskProb < 0.75 && boxConf < 0.20) continue;
        maskBoxes.push({ x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, conf: 0.5 });
    }

    const initMs = sessionInitMs; // reported once — reset so later pages show steady-state 0
    sessionInitMs = 0;
    return {
        boxes: [...outBoxes, ...maskBoxes],
        dropped: nearMisses(lowBoxes, lowConfs, outBoxes, confThr, minSize, w, h),
        mask: { width: w, height: h, data: packed.buffer },
        inferMs,
        initMs,
        ep: sessionEp,
    };
}

// below-threshold box-head predictions (0.05 floor lives in runDetect) that
// no kept box covers — the "model saw it, threshold cut it" set for debug.
// Capped: a noisy page could otherwise dump hundreds of overlapping rects.
function nearMisses(lowBoxes: number[][], lowConfs: number[], kept: { x1: number; y1: number; x2: number; y2: number }[], confThr: number, minSize: number, w: number, h: number): DetBox[] {
    const out: DetBox[] = [];
    for (const i of nms(lowBoxes, lowConfs)) {
        if (out.length >= 40) break;
        const b = lowBoxes[i], conf = lowConfs[i];
        if (conf >= confThr || b[2] - b[0] <= minSize || b[3] - b[1] <= minSize) continue;
        const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
        if (kept.some(o => cx >= o.x1 && cx <= o.x2 && cy >= o.y1 && cy <= o.y2)) continue;
        out.push({
            x1: Math.max(0, b[0]), y1: Math.max(0, b[1]),
            x2: Math.min(w, b[2]), y2: Math.min(h, b[3]), conf,
        });
    }
    return out;
}

// ---- Panel + text detection (YOLO26n nano, Apache-2.0 leoxs22,
// .pt exported to ONNX — see scripts/export-panel-onnx.sh).
// Same IDB-cached pattern as CTD (bundle → HF mirror). Output [1,300,6] is already NMS'd:
// x1,y1,x2,y2 (0-640 space), conf, class (0=panel, 1=text).
// Direct 640 resize, no letterbox — matches the offline probe.
const PANEL_INPUT = 640;
let panelSession: any = null;
let panelCreating: Promise<void> | null = null;

async function ensurePanelSession(): Promise<boolean> {
    if (panelSession) return true;
    if (!panelCreating) {
        panelCreating = (async () => {
            // no latch on failure: bundle-absent is normal now (HF mirror), and a
            // transient download failure must retry next page, not stay dead
            const buf = await loadModelFile('panel', 'models/panel-yolo26n.onnx', 'panel-yolo26n.onnx', 'panel model (~10MB)');
            // ponytail: wasm-only — ~40ms on CPU for this nano model, no webgpu dance
            panelSession = await withInferLock(() => ort.InferenceSession.create(buf, { executionProviders: ['wasm'] }));
        })().finally(() => { panelCreating = null; });
    }
    try { await panelCreating; } catch { /* missing/transient — caller falls back */ }
    return !!panelSession;
}

async function runPanels(png: ArrayBuffer, thr: number): Promise<{ panels: DetBox[]; dropped: DetBox[]; inferMs: number }> {
    if (!(await ensurePanelSession())) throw new Error('panel model unavailable — panel ordering falls back to banding');
    const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
    const w = bitmap.width, h = bitmap.height;
    const c = new OffscreenCanvas(PANEL_INPUT, PANEL_INPUT);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, PANEL_INPUT, PANEL_INPUT);
    const data = ctx.getImageData(0, 0, PANEL_INPUT, PANEL_INPUT).data;
    const x = new Float32Array(3 * PANEL_INPUT * PANEL_INPUT);
    const N = PANEL_INPUT * PANEL_INPUT;
    for (let i = 0; i < N; i++) {
        x[i] = data[i * 4] / 255;
        x[i + N] = data[i * 4 + 1] / 255;
        x[i + 2 * N] = data[i * 4 + 2] / 255;
    }
    const t0 = performance.now();
    const res: any = await withInferLock(() => panelSession!.run({ images: new ort.Tensor('float32', x, [1, 3, PANEL_INPUT, PANEL_INPUT]) }));
    const inferMs = performance.now() - t0;
    const { panels, dropped } = parsePanelOutput(res.output0.data as Float32Array, w, h, thr);
    return { panels, dropped, inferMs };
}

// ---- OCR: Tesseract (engine BUNDLED in dist/tesseract — MV3 forbids remote
// scripts in extension pages; only the language data is user-managed,
// downloaded from CDN on demand and cached in IndexedDB via ocr-models.ts) ----
import { ocrRead, ocrInstalled, ocrDownload, ocrDelete, baberuInstalled, baberuRead, fetchWithProgress, DET_URL } from '../llm/ocr-models';
import { parsePanelOutput, PANEL_CONF_THR, splitTiles, mergeTileBoxes, type Tile } from '../content/detection';
import { initDebug, isDebug } from '../debug';

await initDebug();

// ---- Baberu OCR (JA/EN/ZH, 115M, int4 vision tier) — ported from the published
// onnx_infer.py (pure numpy loop → TS). Vision → decoder prefill → KV-cache
// step, greedy + repetition penalty 1.2 + symbol-aware content-run cap 12.

const BABERU_MEAN = [0.485, 0.456, 0.406];
const BABERU_STD = [0.229, 0.224, 0.225];
const BABERU_PAST_IN = [...Array(6)].map((_, i) => `past_k${i}`).concat([...Array(6)].map((_, i) => `past_v${i}`));
const BABERU_PRESENT_OUT = [...Array(6)].map((_, i) => `present_k${i}`).concat([...Array(6)].map((_, i) => `present_v${i}`));

// logits come out as [1, seq, V] — the decode loop only wants the LAST
// position (the reference reads out[0][0, -1]). Reading the flat buffer as
// one row made argmax land on cross-position garbage (token ids past the
// vocab bound → Gather crash / nonsense text).
function baberuLastLogits(out: Record<string, any>): Float32Array {
    const dims: number[] = out.logits.dims;
    const V = dims[dims.length - 1];
    const seq = dims[dims.length - 2];
    return out.logits.data.subarray((seq - 1) * V, seq * V) as Float32Array;
}

interface BaberuVocab {
    id2ch: Map<number, string>;
    bos: number; eos: number;
    contentIds: Set<number>;
}

let baberuVocab: BaberuVocab | null = null;
let baberuSessions: { vis: any; pre: any; stp: any; ep: string } | null = null;
// ORT's "Session already started" guard turned out to be GLOBAL across the
// whole Emscripten runtime — webgpu included (live-proven: vision on the
// gpu chain raced a prefill on another chain and blew up). All Baberu runs
// ride ONE chain; the pipeline overlap survives via the CPU-side crop and
// the fast GPU vision (239ms/crop).
let baberuCreating: Promise<void> | null = null;

function baberuParseVocab(text: string): BaberuVocab {
    const charset = JSON.parse(text) as string[];
    const id2ch = new Map<number, string>();
    const contentIds = new Set<number>();
    for (let i = 0; i < charset.length; i++) {
        const ch = charset[i];
        id2ch.set(i + 4, ch);
        // content-run cap only tracks single letters/digits/numbers (like the
        // reference: unicodedata category L* or N*), not punctuation runs
        if ([...ch].length === 1 && !'ーｰ〜~'.includes(ch) && /[A-Za-z0-9]/.test(ch)) contentIds.add(i + 4);
    }
    return { id2ch, bos: 1, eos: 2, contentIds };
}

// CJK content chars also count for the run cap — extend the reference's
// L/N filter with the CJK/kana ranges the reference gets from unicodedata
function isContentChar(ch: string): boolean {
    const cp = ch.codePointAt(0) ?? 0;
    return /[A-Za-z0-9]/.test(ch)
        || (cp >= 0x3040 && cp <= 0x30ff) // kana
        || (cp >= 0x3400 && cp <= 0x9fff) // CJK
        || (cp >= 0xf900 && cp <= 0xfaff) // compat ideographs
        || (cp >= 0xff66 && cp <= 0xff9d); // halfwidth katakana
}

async function ensureBaberu(): Promise<void> {
    if (baberuSessions) return;
    if (!baberuCreating) {
        baberuCreating = (async () => {
            const [visBuf, preBuf, stpBuf, vocabBuf] = await Promise.all([
                baberuRead('baberu:vision4'), baberuRead('baberu:prefill'),
                baberuRead('baberu:step'), baberuRead('baberu:vocab'),
            ]);
            if (!visBuf || !preBuf || !stpBuf || !vocabBuf) {
                throw new Error('Baberu OCR model not installed — download it in Settings');
            }
            baberuVocab = baberuParseVocab(new TextDecoder().decode(vocabBuf));
            // extend content-run set with CJK ranges (reference uses unicodedata)
            for (const [id, ch] of baberuVocab.id2ch) {
                if (isContentChar(ch)) baberuVocab.contentIds.add(id);
            }
            // EP split per graph (live-proven on ORT-Web 1.29): vision_int4 runs
            // on webgpu (weight-only → fp32 activations, no shader-f16 needed)
            // at ~0.2s/crop vs ~2s wasm; int8 decoders stay on wasm (12ms/step vs
            // 153ms/step on gpu). All create/run ride ONE chain — ORT's "Session
            // already started" guard is global across the whole runtime, any EP.
            // History: on ORT-Web 1.20 the fp16 vision graph silently produced
            // all-zero embeds on webgpu and int8 decoders gave NaN logits — both
            // fixed by the 1.29 upgrade + vision_int4.
            const mk = async (buf: ArrayBuffer, eps: string[]) =>
                withInferLock(() => ort.InferenceSession.create(buf, { executionProviders: eps }));
            let vis: any;
            try {
                vis = await mk(visBuf, ['webgpu']);
            } catch {
                vis = await mk(visBuf, ['wasm']); // no webgpu → 2s/crop but correct
            }
            const pre = await mk(preBuf, ['wasm']);
            const stp = await mk(stpBuf, ['wasm']);
            baberuSessions = { vis, pre, stp, ep: 'ok' };
        })().finally(() => { baberuCreating = null; });
    }
    await baberuCreating;
}

// one bubble crop → text. Ported 1:1 from BaberuOnnxOCR.__call__
async function runBaberu(png: ArrayBuffer): Promise<string> {
    await ensureBaberu();
    const v = baberuVocab!;
    const { vis, pre, stp } = baberuSessions!;
    // preprocess: RGB 224×224 bicubic + ImageNet norm → [1,3,224,224]
    const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
    const c = new OffscreenCanvas(224, 224);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high'; // bicubic-ish
    ctx.drawImage(bitmap, 0, 0, 224, 224);
    const d = ctx.getImageData(0, 0, 224, 224).data;
    const x = new Float32Array(3 * 224 * 224);
    const N = 224 * 224;
    for (let i = 0; i < N; i++) {
        x[i] = (d[i * 4] / 255 - BABERU_MEAN[0]) / BABERU_STD[0];
        x[i + N] = (d[i * 4 + 1] / 255 - BABERU_MEAN[1]) / BABERU_STD[1];
        x[i + 2 * N] = (d[i * 4 + 2] / 255 - BABERU_MEAN[2]) / BABERU_STD[2];
    }
    const t0 = performance.now();
    const visOut = await withInferLock(async () => vis.run({ pixel_values: new ort.Tensor('float32', x, [1, 3, 224, 224]) })) as Record<string, any>;
    const rawEmbeds = visOut.vision_embeds;
    // GPU→CPU bridge: when vision ran on webgpu the tensor is gpu-resident;
    // feeding it to the wasm prefill produced all-NaN logits (empty OCR for
    // every box). Materialize plain CPU float32 data first — getData()
    // downloads GPU tensors, .data is already CPU.
    let embedsData: Float32Array;
    if (rawEmbeds.cpuData) embedsData = rawEmbeds.cpuData;
    else if (rawEmbeds.getData) embedsData = await rawEmbeds.getData();
    else embedsData = rawEmbeds.data;
    // sanity: NaN check — one bad value means the whole page reads empty
    for (let i = 0; i < Math.min(16, embedsData.length); i++) {
        if (!Number.isFinite(embedsData[i])) throw new Error('baberu vision produced non-finite embeds');
    }
    const embeds = new ort.Tensor('float32', embedsData, rawEmbeds.dims);
    const preOut = await withInferLock(async () => pre.run({
        vision_embeds: embeds,
        input_ids: new ort.Tensor('int64', BigInt64Array.from([BigInt(v.bos)]), [1, 1]),
    })) as Record<string, any>;
    // outputs: logits [1,seq,V] (use last position) + present_k/v caches
    let logits = baberuLastLogits(preOut);
    let present = BABERU_PRESENT_OUT.map(n => preOut[n]);
    const seq: number[] = [v.bos];
    const toks: number[] = [];
    let pos = embeds.dims[1] + 1;
    const repPenalty = 1.2, maxRun = 12, maxNew = 128;
    for (let step = 0; step < maxNew; step++) {
        // repetition penalty on every token seen
        const seen = new Set(seq);
        for (const tid of seen) {
            const s = logits[tid];
            logits[tid] = s < 0 ? s * repPenalty : s / repPenalty;
        }
        // symbol-aware content-run cap: if the last token repeated ≥ cap, ban it
        if (maxRun && toks.length && v.contentIds.has(toks[toks.length - 1])) {
            const last = toks[toks.length - 1];
            let run = 0;
            for (let i = toks.length - 1; i >= 0 && toks[i] === last; i--) run++;
            if (run >= maxRun) logits[last] = -Infinity;
        }
        // greedy argmax
        let nxt = 0;
        for (let i = 1; i < logits.length; i++) if (logits[i] > logits[nxt]) nxt = i;
        if (nxt === v.eos) break;
        toks.push(nxt);
        seq.push(nxt);
        if (toks.length >= maxNew) break;
        const feed: Record<string, any> = {
            input_ids: new ort.Tensor('int64', BigInt64Array.from([BigInt(nxt)]), [1, 1]),
            position_ids: new ort.Tensor('int64', BigInt64Array.from([BigInt(pos)]), [1, 1]),
        };
        BABERU_PAST_IN.forEach((nm, i) => { feed[nm] = present[i]; });
        const out = await withInferLock(async () => stp.run(feed)) as Record<string, any>;
        logits = baberuLastLogits(out);
        present = BABERU_PRESENT_OUT.map(n => out[n]);
        pos++;
    }
    baberuMs = performance.now() - t0;
    let text = '';
    for (const t of toks) text += v.id2ch.get(t) ?? '';
    return text;
}

let baberuMs = 0;

const TESS_URL = chrome.runtime.getURL('tesseract/tesseract.min.js');
const TESS_WORKER_URL = chrome.runtime.getURL('tesseract/worker.min.js');
const TESS_CORE_URL = chrome.runtime.getURL('tesseract/tesseract-core-simd-lstm.wasm.js');

let tessWorker: any = null;
let tessLangs: string[] = [];

async function ensureTesseract(langs: string[]): Promise<void> {
    if (tessWorker && langs.join('+') === tessLangs.join('+')) return;
    if (!(globalThis as any).Tesseract) {
        await new Promise<void>((res, rej) => {
            const s = document.createElement('script');
            s.src = TESS_URL;
            s.onload = () => res();
            s.onerror = () => rej(new Error('cannot load bundled tesseract.js'));
            document.head.append(s);
        });
    }
    const T: any = (globalThis as any).Tesseract;
    const langData: Record<string, ArrayBuffer | string> = {};
    for (const l of langs) {
        const buf = await ocrRead(l);
        if (!buf) throw new Error(`OCR model for ${l} not installed — download it in Settings`);
        langData[l] = buf;
    }
    if (tessWorker) await tessWorker.terminate();
    tessWorker = await T.createWorker(langs.join('+'), 1, {
        workerPath: TESS_WORKER_URL,
        corePath: TESS_CORE_URL,
        langData,
        // direct worker (no blob wrapper): blob workers inherit the page CSP and
        // their importScripts back into chrome-extension:// URLs gets blocked
        workerBlobURL: false,
        errorHandler: (e: unknown) => console.warn('[mt:tess]', e),
    });
    tessLangs = langs;
}

async function runOcr(png: ArrayBuffer, langs: string[]): Promise<string> {
    await ensureTesseract(langs);
    const { data } = await tessWorker.recognize(new Blob([png], { type: 'image/png' }));
    return data?.text ?? '';
}

// Handshake token: postMessage into this iframe carries the PAGE origin (the
// content script shares it), so origin checks can't separate our content
// script from hostile page JS — and worker.html is web-accessible, meaning
// any visited site can also embed its own copy and drive it directly. The
// token travels over chrome.runtime (invisible to the page); detection.ts
// fetches it from the SW before any RPC. Without it a page could delete the
// user's OCR models, force ~50MB model downloads, and burn CPU/GPU at will.
// Keyed by a public NONCE (not sender.tab — extension pages have no tab, so
// a tab key would collapse to one global slot that a second tab or a hostile
// WAR embed could clobber): registration and lookup agree on the nonce, and
// collisions across iframes are impossible.
const rnd = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
const TOKEN = rnd(16);
const NONCE = rnd(8);

window.addEventListener('message', async (ev: MessageEvent) => {
    const msg = ev.data;
    if (msg?.token !== TOKEN) return;
    const reply = (payload: object, transfer?: Transferable[]) =>
        (ev.source as Window | null)?.postMessage({ type: 'mt:rpc-result', ...payload, id: msg?.id }, '*', transfer);
    if (msg?.type === 'mt:probe-gpu') {
        const port = ev.ports?.[0];
        let gpu: unknown;
        try {
            if (!(navigator as any).gpu) gpu = 'missing';
            else {
                const a = await (navigator as any).gpu.requestAdapter();
                gpu = a ? (a.info?.vendor ?? 'adapter-unknown') : 'no-adapter';
            }
        } catch (e) { gpu = 'ERR ' + String(e).slice(0, 100); }
        port?.postMessage({ gpu });
        return;
    }
    if (msg?.type !== 'mt:detect' && msg?.type !== 'mt:ocr' && msg?.type !== 'mt:ocr-status'
        && msg?.type !== 'mt:ocr-download' && msg?.type !== 'mt:ocr-delete' && msg?.type !== 'mt:ocr-list'
        && msg?.type !== 'mt:panels' && msg?.type !== 'mt:baberu-ocr' && msg?.type !== 'mt:baberu-status') return;
    try {
        if (msg.type === 'mt:ocr-status' || msg.type === 'mt:ocr-list') {
            reply({ ok: true, installed: await ocrInstalled() });
        } else if (msg.type === 'mt:baberu-status') {
            reply({ ok: true, installed: await baberuInstalled() });
        } else if (msg.type === 'mt:baberu-ocr') {
            const { v: text, lockWait } = await metered(() => runBaberu(msg.png));
            reply({ ok: true, text, ms: Math.round(baberuMs), lockWait });
        } else if (msg.type === 'mt:ocr-download') {
            await ocrDownload(msg.lang); // download + cache (throws on failure)
            reply({ ok: true });
        } else if (msg.type === 'mt:ocr-delete') {
            await ocrDelete(msg.lang);
            reply({ ok: true });
        } else if (msg.type === 'mt:ocr') {
            const text = await runOcr(msg.png, msg.langs ?? ['jpn', 'eng']);
            reply({ ok: true, text });
        } else if (msg.type === 'mt:panels') {
            const { v: r, lockWait } = await metered(() => runPanels(msg.png, typeof msg.thr === 'number' ? msg.thr : PANEL_CONF_THR));
            reply({ ok: true, panels: r.panels, dropped: r.dropped, ms: Math.round(r.inferMs), lockWait });
        } else {
            const { v: result, lockWait } = await metered(() => runDetect(msg.png, msg.confThr ?? CONF_THR, msg.minSize ?? MIN_SIZE, msg.forceWasm === true));
            (result as any).lockWaitMs = lockWait;
            (ev.source as Window | null)?.postMessage(
                { type: 'mt:detect-result', id: msg.id, ok: true, result },
                '*', [((result as any).mask.data as ArrayBuffer)],
            );
        }
    } catch (e) {
        (ev.source as Window | null)?.postMessage(
            { type: 'mt:detect-result', id: msg.id, ok: false, error: String(e) },
            '*',
        );
    }
});

// register the token with the SW under the public nonce and only THEN signal
// readiness, so the content script's token fetch can never race the registration
try { await chrome.runtime.sendMessage({ type: 'mt:worker-token', nonce: NONCE, token: TOKEN }); } catch { /* SW hiccup — RPCs will fail loudly */ }
window.parent.postMessage({ type: 'mt:ready', nonce: NONCE }, '*');
