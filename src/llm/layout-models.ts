import { KOHARU_MODEL } from '../layout-model';

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
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== KOHARU_MODEL.bytes) throw new Error('Choose the Koharu FP32 ONNX file (149.8 MB)');
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    if (sha !== KOHARU_MODEL.sha256) throw new Error('This is a different Koharu model file. Import the supported FP32 export.');
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

// Only verified local artifacts are accepted; no unconfigured public mirror is assumed.
export async function loadKoharuFile(): Promise<ArrayBuffer> {
    const cached = await read();
    if (cached) { await validateKoharuFile(cached); return cached; }
    let bytes: ArrayBuffer;
    try {
        const response = await fetch(chrome.runtime.getURL(`models/${KOHARU_MODEL.file}`));
        if (!response.ok) throw new Error('missing');
        bytes = await response.arrayBuffer();
    } catch { throw new Error('Koharu FP32 is not installed. Open Options → Model → Import model file.'); }
    await importKoharuFile(bytes);
    return bytes;
}
