// Extension-origin storage is shared by execution hosts, not by reader origins.
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
    return database ??= new Promise((resolve, reject) => {
        const r = indexedDB.open('mt-chapter', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('records'); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => { database = undefined; reject(r.error); };
        r.onblocked = () => { database = undefined; reject(new Error('Chapter storage is blocked')); };
    });
}
export async function readRecord<T>(key: string): Promise<T | undefined> {
    const d = await db();
    return new Promise((resolve, reject) => {
        const r = d.transaction('records').objectStore('records').get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}
export async function writeRecord(key: string, value: unknown): Promise<void> {
    const d = await db();
    return new Promise((resolve, reject) => {
        const tx = d.transaction('records', 'readwrite');
        tx.objectStore('records').put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Chapter storage failed'));
    });
}
export async function deleteRecord(key: string): Promise<void> {
    const d = await db();
    return new Promise((resolve, reject) => {
        const tx = d.transaction('records', 'readwrite');
        tx.objectStore('records').delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
    });
}
export function blobDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}
