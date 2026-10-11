import { CACHE_MAX, PAGE_KEY_GEN, sameCachedPlan, type CachedPage } from './policy';
import { cacheReady, cacheGeneration, cacheCurrent } from '../cache-generation';
import { sendToBackground } from '../bg-rpc';
import { encodeCache, decodeCache, type CacheWire } from './wire';

const CHECKPOINT_MAX = 200;
export const CACHE_MAX_BYTES = 256 * 1024 * 1024;
interface CacheMeta { key: string; page: string; atime: number; epoch: string; partial: boolean; bytes: number }
type Entry = Omit<CachedPage, 'atime'>;
let opening: Promise<IDBDatabase | null> | undefined;

function readerContext(): boolean {
    return typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && !!chrome.runtime?.id;
}
async function remote(command: Record<string, unknown>, token: string): Promise<{ entry?: CacheWire; count?: number }> {
    const reply = await sendToBackground<{ ok?: boolean; error?: string; entry?: CacheWire; count?: number }>(
        { type: 'mt:translation-cache', ...command, cacheEpoch: token },
        { timeoutMs: 15_000, retries: 1, label: 'Loading saved translations' });
    if (!cacheCurrent(token)) throw new DOMException('Translation cache was cleared', 'AbortError');
    if (!reply?.ok) throw new Error(reply?.error ?? 'Saved translations are unavailable — try again');
    return reply;
}

function entryBytes(value: unknown): number {
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (typeof value === 'string') return value.length * 2;
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + entryBytes(item), 0);
    if (value && typeof value === 'object') return Object.entries(value)
        .reduce((sum, [key, item]) => sum + key.length * 2 + entryBytes(item), 0);
    return 8;
}

function metadata(row: CachedPage): CacheMeta {
    const hashAt = row.key.lastIndexOf('#');
    const slot = row.order != null && row.key.endsWith(`@p${row.order}`);
    const page = !slot && row.keyGen === PAGE_KEY_GEN && Number.isInteger(row.order) && row.order! >= 0 && hashAt >= 0
        ? `${row.key.slice(0, hashAt)}@p${row.order}` : row.key;
    return { key: row.key, page, atime: row.atime, epoch: row.cacheEpoch ?? '', partial: row.partial === true,
        bytes: entryBytes(row) };
}

function db(): Promise<IDBDatabase | null> {
    return opening ??= new Promise(resolve => {
        if (typeof indexedDB === 'undefined') { resolve(null); return; }
        let settled = false, blocked = false;
        const finish = (value: IDBDatabase | null, retry = true): void => {
            if (settled) {
                if (value && blocked) { opening = Promise.resolve(value); blocked = false; }
                else value?.close();
                return;
            }
            settled = true;
            if (!value && retry) queueMicrotask(() => { opening = undefined; });
            resolve(value);
        };
        try {
            const request = indexedDB.open('mt-cache', 2);
            request.onupgradeneeded = () => {
                const d = request.result;
                const pages = d.objectStoreNames.contains('pages')
                    ? request.transaction!.objectStore('pages') : d.createObjectStore('pages', { keyPath: 'key' });
                if (!pages.indexNames.contains('byAtime')) pages.createIndex('byAtime', 'atime');
                const meta = d.createObjectStore('metadata', { keyPath: 'key' });
                const cursor = pages.openCursor();
                cursor.onsuccess = () => {
                    if (!cursor.result) return;
                    meta.put(metadata(cursor.result.value));
                    cursor.result.continue();
                };
            };
            request.onsuccess = () => {
                const d = request.result;
                d.onversionchange = () => { d.close(); opening = undefined; };
                finish(d);
            };
            request.onblocked = () => { blocked = true; finish(null, false); };
            request.onerror = () => {
                if (settled) opening = undefined;
                else finish(null);
            };
        } catch { finish(null); }
    });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Translation cache transaction failed'));
    });
}

// Eviction and counting inspect small metadata rows; page pixels never enter the LRU scan.
function trim(tx: IDBTransaction, rows: CacheMeta[], max: number, epoch: string): void {
    const pages = tx.objectStore('pages'), meta = tx.objectStore('metadata');
    let bytes = 0;
    const drop = (row: CacheMeta): void => { pages.delete(row.key); meta.delete(row.key); bytes -= row.bytes; };
    const groups = new Map<string, { atime: number; rows: CacheMeta[] }>();
    const pending: CacheMeta[] = [];
    for (const row of rows) {
        bytes += row.bytes;
        if (row.epoch !== epoch) { drop(row); continue; }
        if (row.partial) { pending.push(row); continue; }
        let group = groups.get(row.page);
        if (!group) groups.set(row.page, group = { atime: row.atime, rows: [] });
        group.atime = Math.max(group.atime, row.atime);
        group.rows.push(row);
    }
    const oldest = [...groups.values()].sort((a, b) => a.atime - b.atime);
    for (const group of oldest.slice(0, Math.max(0, oldest.length - max))) for (const row of group.rows) drop(row);
    pending.sort((a, b) => a.atime - b.atime);
    for (const row of pending.slice(0, Math.max(0, pending.length - CHECKPOINT_MAX))) drop(row);
    const survivors = [
        ...oldest.slice(Math.max(0, oldest.length - max)),
        ...pending.slice(Math.max(0, pending.length - CHECKPOINT_MAX)).map(row => ({ atime: row.atime, rows: [row] })),
    ].sort((a, b) => a.atime - b.atime);
    for (const group of survivors) {
        if (bytes <= CACHE_MAX_BYTES) break;
        for (const row of group.rows) drop(row);
    }
}

function mergeEntry(previous: CachedPage | undefined, next: CachedPage): CachedPage {
    if (!previous || (previous.cacheEpoch ?? '') !== next.cacheEpoch || previous.fp !== next.fp
        || previous.w !== next.w || previous.h !== next.h) return next;
    // Progress only moves forward within one recipe; a late detect/OCR checkpoint cannot erase a translation.
    if (next.partial && !previous.partial) return { ...previous, atime: next.atime };
    if (!sameCachedPlan(previous, next)) return next;
    if (next.partial) {
        next.texts = next.boxes.map((_, index) => next.texts?.[index] || previous.texts?.[index] || '');
        if (!next.cpatches?.length) next.cpatches = previous.cpatches;
    }
    if (!next.partial && !next.key.endsWith(`@p${next.order}`) && !next.patches?.length && previous.patches?.length) {
        next.patches = previous.patches;
        next.patchesGen = previous.patchesGen;
    }
    return next;
}

export async function cacheGet(key: string): Promise<CachedPage | undefined> {
    if (readerContext()) {
        const reply = await remote({ op: 'get', key }, await cacheReady());
        return reply.entry && decodeCache(reply.entry);
    }
    try {
        const token = await cacheReady(), d = await db();
        if (!d || !cacheCurrent(token)) return undefined;
        const tx = d.transaction(['pages', 'metadata'], 'readwrite');
        const done = transactionDone(tx), pages = tx.objectStore('pages');
        let hit: CachedPage | undefined;
        const request = pages.get(key);
        request.onsuccess = () => {
            const row = request.result as CachedPage | undefined;
            if (!cacheCurrent(token)) { tx.abort(); return; }
            if (!row || (row.cacheEpoch ?? '') !== token) return;
            hit = { ...row, atime: Date.now() };
            tx.objectStore('metadata').put(metadata(hit));
        };
        await done;
        return cacheCurrent(token) ? hit : undefined;
    } catch { return undefined; }
}

// Aliases, checkpoints and LRU changes commit together. Success means transaction completion.
export async function cachePutMany(entries: Entry[], max = CACHE_MAX, token = cacheGeneration()): Promise<void> {
    try {
        await cacheReady();
        if (!cacheCurrent(token)) return;
        if (readerContext()) {
            await remote({ op: 'put', entries: entries.map(encodeCache), max }, token);
            return;
        }
        const d = await db();
        if (!d || !cacheCurrent(token)) return;
        const tx = d.transaction(['pages', 'metadata'], 'readwrite');
        const done = transactionDone(tx), pages = tx.objectStore('pages'), meta = tx.objectStore('metadata');
        let remaining = entries.length;
        const prune = (): void => {
            const request = meta.getAll();
            request.onsuccess = () => {
                if (!cacheCurrent(token)) { tx.abort(); return; }
                trim(tx, request.result, Number.isFinite(max) ? Math.max(1, Math.floor(max)) : CACHE_MAX, token);
            };
        };
        if (!remaining) prune();
        for (const entry of entries) {
            const request = pages.get(entry.key);
            request.onsuccess = () => {
                if (!cacheCurrent(token)) { tx.abort(); return; }
                const next = mergeEntry(request.result, { ...entry, cacheEpoch: token, atime: Date.now() });
                pages.put(next); meta.put(metadata(next));
                if (--remaining === 0) prune();
            };
        }
        await done;
    } catch { /* Persistence is optional; a failed transaction leaves all aliases unchanged. */ }
}

export function cachePut(entry: Entry, max = CACHE_MAX, token = cacheGeneration()): Promise<void> {
    return cachePutMany([entry], max, token);
}

export async function cacheDelete(key: string, token = cacheGeneration()): Promise<void> {
    try {
        await cacheReady();
        if (!cacheCurrent(token)) return;
        if (readerContext()) { await remote({ op: 'delete', key }, token); return; }
        const d = await db();
        if (!d || !cacheCurrent(token)) return;
        const tx = d.transaction(['pages', 'metadata'], 'readwrite');
        const done = transactionDone(tx);
        tx.objectStore('pages').delete(key); tx.objectStore('metadata').delete(key);
        await done;
    } catch { /* Best effort. */ }
}

export async function cacheClear(): Promise<void> {
    await cacheReady();
    // Readers reset their views; only the extension coordinator clears the shared database.
    if (readerContext()) return;
    const d = await db();
    if (!d) throw new Error('Translation cache is unavailable');
    const tx = d.transaction(['pages', 'metadata'], 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('pages').clear(); tx.objectStore('metadata').clear();
    await done;
}

async function countPages(matches: (row: CacheMeta) => boolean): Promise<number> {
    try {
        const token = await cacheReady(), d = await db();
        if (!d || !cacheCurrent(token)) return 0;
        const tx = d.transaction('metadata');
        const done = transactionDone(tx), request = tx.objectStore('metadata').getAll();
        let count = 0;
        request.onsuccess = () => {
            count = new Set((request.result as CacheMeta[])
                .filter(row => row.epoch === token && !row.partial && matches(row)).map(row => row.page)).size;
        };
        await done;
        return cacheCurrent(token) ? count : 0;
    } catch { return 0; }
}
async function remoteCount(command: Record<string, unknown>): Promise<number> {
    try { return (await remote(command, await cacheReady())).count ?? 0; } catch { return 0; }
}
export function cacheCount(): Promise<number> {
    return readerContext() ? remoteCount({ op: 'count' }) : countPages(() => true);
}
export function cacheCountPrefix(prefix: string): Promise<number> {
    return readerContext() ? remoteCount({ op: 'count-prefix', prefix }) : countPages(row => row.key.startsWith(prefix));
}
export function cacheCountChapter(chapter: string): Promise<number> {
    return readerContext() ? remoteCount({ op: 'count-chapter', chapter })
        : countPages(row => row.key.startsWith(chapter + '#') || row.key.startsWith(chapter + '@p'));
}
