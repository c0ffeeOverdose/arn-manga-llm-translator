import { KOHARU_MODEL } from '../layout-model';
import { DET_URL, fetchWithProgress } from './ocr-models';

class KoharuIntegrityError extends Error {}

function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('mt-models', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('m');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function read(): Promise<ArrayBuffer | undefined> {
    const db = await open();
    try {
        return await new Promise((resolve, reject) => {
            const q = db.transaction('m', 'readonly').objectStore('m').get(KOHARU_MODEL.key);
            q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);
        });
    } finally { db.close(); }
}

export async function validateKoharuFile(bytes: ArrayBuffer): Promise<void> {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== KOHARU_MODEL.bytes) throw new KoharuIntegrityError('Choose the KoharuLayout ONNX file (149.8 MB)');
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    if (sha !== KOHARU_MODEL.sha256) throw new KoharuIntegrityError('This is a different KoharuLayout model file. Download or import the supported model file.');
}

export async function importKoharuFile(bytes: ArrayBuffer): Promise<void> {
    await validateKoharuFile(bytes);
    const db = await open();
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('m', 'readwrite');
            tx.objectStore('m').put(bytes, KOHARU_MODEL.key);
            tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
        });
    } finally { db.close(); }
}

export async function koharuDelete(): Promise<void> {
    const db = await open();
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('m', 'readwrite');
            tx.objectStore('m').delete(KOHARU_MODEL.key);
            tx.oncomplete = () => resolve();
            tx.onerror = tx.onabort = () => reject(tx.error);
        });
    } finally { db.close(); }
}

export async function koharuInstalled(): Promise<'cached' | 'bundled' | 'missing'> {
    const db = await open();
    try {
        const cached = await new Promise<boolean>((resolve, reject) => {
            const q = db.transaction('m', 'readonly').objectStore('m').getKey(KOHARU_MODEL.key);
            q.onsuccess = () => resolve(q.result !== undefined); q.onerror = () => reject(q.error);
        });
        if (cached) return 'cached';
    } finally { db.close(); }
    try {
        const response = await fetch(chrome.runtime.getURL(`models/${KOHARU_MODEL.file}`), { method: 'HEAD' });
        if (response.ok) return 'bundled';
    } catch { /* an optional development bundle may be absent */ }
    return 'missing';
}

// Every source must match the supported export before it enters the shared model store.
export async function loadKoharuFile(options: {
    noDownload?: boolean;
    forceDownload?: boolean;
    onProgress?: (loaded: number, total: number) => void;
} = {}): Promise<ArrayBuffer> {
    let invalid: KoharuIntegrityError | undefined;
    if (!options.forceDownload) {
        const cached = await read();
        if (cached) {
            try { await validateKoharuFile(cached); return cached; }
            catch (e) {
                if (!(e instanceof KoharuIntegrityError)) throw e;
                invalid = e;
            }
        }
        let bundled: ArrayBuffer | undefined;
        try {
            const response = await fetch(chrome.runtime.getURL(`models/${KOHARU_MODEL.file}`));
            if (response.ok) bundled = await response.arrayBuffer();
        } catch { /* an optional development bundle may be absent */ }
        if (bundled) {
            try { await importKoharuFile(bundled); return bundled; }
            catch (e) {
                if (!(e instanceof KoharuIntegrityError)) throw e;
                invalid = e;
            }
        }
    }
    if (options.noDownload) throw invalid ?? new Error('KoharuLayout is not installed. Open Options → Model → Download.');
    options.onProgress?.(0, KOHARU_MODEL.bytes);
    let bytes: ArrayBuffer;
    try {
        bytes = await fetchWithProgress(DET_URL(KOHARU_MODEL.file),
            (loaded, total) => options.onProgress?.(loaded, total || KOHARU_MODEL.bytes),
            { cache: options.forceDownload || invalid ? 'reload' : 'default' });
    } catch (e) {
        throw new Error(`KoharuLayout download failed. Check your connection and try Download in Options → Model. (${(e as Error).message})`);
    }
    await importKoharuFile(bytes);
    return bytes;
}

export async function koharuDownload(onProgress?: (loaded: number, total: number) => void, force = false): Promise<void> {
    await loadKoharuFile({ onProgress, forceDownload: force });
}
