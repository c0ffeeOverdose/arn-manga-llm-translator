// OCR model manager: shared by the options page (download/delete UI) and
// the iframe worker (runtime loads). Same origin → same IndexedDB store
// ('mt-models', keys 'tess:{lang}'). Nothing ships in the bundle; users
// choose what to download. CDNs tried in order.
// Pure browser logic — no Chrome APIs, usable from any extension page.

const TESSDATA_URLS = (lang: string) => [
    `https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/${lang}.traineddata`,
    `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${lang}.traineddata`,
];

// lang is interpolated into download URLs — keep it to real tessdata codes
// (jpn, eng, chi_sim, …) so a crafted value can't steer the fetch elsewhere
export const langOk = (lang: string) => /^[a-z]{2,3}(_[a-z]{2,4})?$/.test(lang);

export const OCR_LANGUAGES: { code: string; label: string }[] = [
    { code: 'jpn', label: 'Japanese' },
    { code: 'eng', label: 'English' },
    { code: 'kor', label: 'Korean' },
    { code: 'chi_sim', label: 'Chinese (simplified)' },
    { code: 'chi_tra', label: 'Chinese (traditional)' },
    { code: 'fra', label: 'French' },
    { code: 'deu', label: 'German' },
    { code: 'spa', label: 'Spanish' },
    { code: 'rus', label: 'Russian' },
    { code: 'vie', label: 'Vietnamese' },
];

function openDb(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
        const r = indexedDB.open('mt-models', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('m');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}

export async function ocrInstalled(): Promise<string[]> {
    const db = await openDb();
    return new Promise(res => {
        const q = db.transaction('m', 'readonly').objectStore('m').getAllKeys();
        q.onsuccess = () => res((q.result as IDBValidKey[]).filter(k => String(k).startsWith('tess:')).map(k => String(k).slice(5)));
        q.onerror = () => res([]);
    });
}

// keys 'ctd'/'panel' live in the same store (detection models, not OCR)

// detection weights cached for on-device inference (downloaded on first use)
export async function detModelsInstalled(): Promise<{ ctd: boolean; panel: boolean }> {
    const db = await openDb();
    const has = (k: string) => new Promise<boolean>(res => {
        const q = db.transaction('m', 'readonly').objectStore('m').getKey(k);
        q.onsuccess = () => res(q.result !== undefined);
        q.onerror = () => res(false);
    });
    const [ctd, panel] = await Promise.all([has('ctd'), has('panel')]);
    return { ctd, panel };
}

// detection weights (CTD + panel) — same HF runtime mirror the worker uses,
// same IDB keys ('ctd'/'panel'). Pre-downloaded here so on-device users can
// fetch on wifi instead of mid-chapter; the worker finds them and skips its own fetch.
export const DET_FILES = [
    { key: 'ctd', file: 'ctd-int8.onnx', label: 'CTD model (~40MB)' },
    { key: 'panel', file: 'panel-yolo26n.onnx', label: 'panel model (~10MB)' },
] as const;

export const DET_URL = (file: string) => `https://huggingface.co/c0ffeeOverdose/arn-manga-models/resolve/main/${file}?download=true`;

export async function detDownload(onProgress?: (file: string, loaded: number, total: number) => void): Promise<void> {
    for (const f of DET_FILES) {
        const db = await openDb();
        const have = await new Promise<boolean>(res => {
            const q = db.transaction('m', 'readonly').objectStore('m').getKey(f.key);
            q.onsuccess = () => res(q.result !== undefined);
            q.onerror = () => res(false);
        });
        if (have) continue; // already cached (resume-friendly across files)
        const buf = await fetchWithProgress(DET_URL(f.file), (loaded, total) => onProgress?.(f.file, loaded, total));
        await new Promise<void>((res2, rej2) => {
            const q = db.transaction('m', 'readwrite').objectStore('m').put(buf, f.key);
            q.onsuccess = () => res2();
            q.onerror = () => rej2(q.error);
        });
    }
}

// stream a URL to an ArrayBuffer with progress (shared by all model downloads).
// Hardened: short reads (truncated stream) throw instead of returning a corrupt
// buffer that would poison the IDB cache; a stalled connection (no bytes for
// STALL_MS) aborts — a total cap would punish slow-but-alive networks.
const STALL_MS = 30000;
// Transient network failures (truncated stream after a reconnect, RST
// mid-body — live-proven: a 52MB file died with "Error in input stream"
// right after a router restart) must not kill a multi-file batch: retry
// each fetch before surfacing. All callers fetch immutable files, so a
// retried GET is always safe.
const FETCH_RETRIES = 3;
export async function fetchWithProgress(url: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
    let lastErr: unknown = null;
    for (let attempt = 0; ; attempt++) {
        try {
            return await fetchOnce(url, onProgress);
        } catch (e) {
            lastErr = e;
            if (attempt + 1 >= FETCH_RETRIES) throw lastErr;
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
    }
}

async function fetchOnce(url: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
    const ctrl = new AbortController();
    let to: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { if (to !== undefined) { clearTimeout(to); to = undefined; } };
    const bump = () => { clear(); to = setTimeout(() => ctrl.abort(new Error('stalled')), STALL_MS); };
    try {
        bump();
        const resp = await fetch(url, { signal: ctrl.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const total = +(resp.headers.get('content-length') ?? 0);
        const reader = resp.body?.getReader();
        if (!reader) {
            const buf = await resp.arrayBuffer();
            if (total > 0 && buf.byteLength !== total) throw new Error(`short read (${buf.byteLength}/${total})`);
            return buf;
        }
        const parts: BlobPart[] = [];
        let loaded = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value as unknown as BlobPart);
            loaded += value.length;
            bump();
            onProgress?.(loaded, total);
        }
        if (total > 0 && loaded !== total) throw new Error(`short read (${loaded}/${total})`);
        return new Blob(parts).arrayBuffer();
    } finally {
        clear();
    }
}

// download traineddata (gzip) from CDN with fallback, decompress, cache.
// onProgress gets called with bytes as they arrive (for the UI bar).
export async function ocrDownload(lang: string, onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (!langOk(lang)) throw new Error(`bad language code: ${lang}`);
    let lastErr: unknown = null;
    let buf: ArrayBuffer | null = null;
    for (const url of TESSDATA_URLS(lang)) {
        try {
            buf = await fetchWithProgress(url, onProgress);
            break;
        } catch (e) { lastErr = e; }
    }
    if (!buf) throw new Error(`download failed for ${lang}: ${String(lastErr).slice(0, 120)}`);
    const db = await openDb();
    await new Promise<void>((res, rej) => {
        const q = db.transaction('m', 'readwrite').objectStore('m').put(buf, `tess:${lang}`);
        q.onsuccess = () => res();
        q.onerror = () => rej(q.error);
    });
}

export async function ocrDelete(lang: string): Promise<void> {
    const db = await openDb();
    await new Promise<void>(res => {
        const q = db.transaction('m', 'readwrite').objectStore('m').delete(`tess:${lang}`);
        q.onsuccess = () => res();
        q.onerror = () => res();
    });
}

// read cached traineddata for runtime use (iframe worker)
export async function ocrRead(lang: string): Promise<ArrayBuffer | undefined> {
    const db = await openDb();
    return new Promise(res => {
        const q = db.transaction('m', 'readonly').objectStore('m').get(`tess:${lang}`);
        q.onsuccess = () => res(q.result as ArrayBuffer | undefined);
        q.onerror = () => res(undefined);
    });
}

// ---- Baberu OCR (JA/EN/ZH, 115M) — int4 vision tier, 4 files from Hugging Face ----
// vision_int4 (weight-only, fp32 activations): runs correctly on webgpu with
// ORT-Web 1.29+ WITHOUT shader-f16 (fp16 graph needs f16, hard-fails without)

export const BABERU_FILES = [
    { key: 'baberu:vision4', file: 'onnx/vision_int4.onnx' },
    { key: 'baberu:prefill', file: 'onnx/decoder_prefill_int8.onnx' },
    { key: 'baberu:step', file: 'onnx/decoder_step_int8.onnx' },
    { key: 'baberu:vocab', file: 'tokenizer/vocab.json' },
] as const;

const BABERU_URL = (file: string) => `https://huggingface.co/genshiai-daichi/baberu-ocr/resolve/main/${file}`;

export async function baberuInstalled(): Promise<boolean> {
    const db = await openDb();
    return new Promise(res => {
        const q = db.transaction('m', 'readonly').objectStore('m').getAllKeys();
        q.onsuccess = () => {
            const keys = new Set((q.result as IDBValidKey[]).map(String));
            res(BABERU_FILES.every(f => keys.has(f.key)));
        };
        q.onerror = () => res(false);
    });
}

export async function baberuDownload(onProgress?: (file: string, loaded: number, total: number) => void): Promise<void> {
    // stale pre-int4 cache (172MB fp16 vision) — drop it so old installs re-fetch
    await new Promise<void>(res => {
        const q = openDb().then(db => db.transaction('m', 'readwrite').objectStore('m').delete('baberu:vision'));
        q.then(() => res(), () => res());
    });
    for (const f of BABERU_FILES) {
        await (async () => {
            const db = await openDb();
            const have = await new Promise<boolean>(res => {
                const q = db.transaction('m', 'readonly').objectStore('m').getKey(f.key);
                q.onsuccess = () => res(q.result !== undefined);
                q.onerror = () => res(false);
            });
            if (have) return; // already downloaded (resume-friendly across files)
            const buf = await fetchWithProgress(BABERU_URL(f.file), (loaded, total) => onProgress?.(f.file, loaded, total));
            await new Promise<void>((res2, rej2) => {
                const q = db.transaction('m', 'readwrite').objectStore('m').put(buf, f.key);
                q.onsuccess = () => res2();
                q.onerror = () => rej2(q.error);
            });
        })();
    }
}

export async function baberuDelete(): Promise<void> {
    const db = await openDb();
    await new Promise<void>(res => {
        const q = db.transaction('m', 'readwrite').objectStore('m');
        for (const f of BABERU_FILES) q.delete(f.key);
        q.delete('baberu:vision'); // stale pre-int4 key
        q.transaction.oncomplete = () => res();
        q.transaction.onerror = () => res();
    });
}

export async function baberuRead(key: string): Promise<ArrayBuffer | undefined> {
    const db = await openDb();
    return new Promise(res => {
        const q = db.transaction('m', 'readonly').objectStore('m').get(key);
        q.onsuccess = () => res(q.result as ArrayBuffer | undefined);
        q.onerror = () => res(undefined);
    });
}
