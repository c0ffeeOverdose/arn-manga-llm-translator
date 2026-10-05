import { sanitizeChapterEvent, updateChapterLogPage, type ChapterLogHead, type ChapterLogInput, type ChapterLogEvent,
    type ChapterLogPage, type ChapterLogReport, type ChapterTrace } from './log';

// Separate event/page rows keep each write small. All writers share one atomic IDB
// transaction; the popup reads this extension-origin database without a worker RPC.
interface StoredHead extends ChapterLogHead { readerTab: number; scope: string }
let database: Promise<IDBDatabase> | undefined;
const KEEP_RUNS = 3;
const KEEP_EVENTS = 1200;
const KEEP_PAGES = 2048;
function db(): Promise<IDBDatabase> {
    return database ??= new Promise((resolve, reject) => {
        const open = indexedDB.open('mt-chapter-logs', 1);
        open.onupgradeneeded = () => {
            open.result.createObjectStore('heads', { keyPath: 'id' });
            for (const name of ['events', 'pages']) {
                const store = open.result.createObjectStore(name);
                store.createIndex('byRun', 'logId');
            }
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => { database = undefined; reject(open.error); };
        open.onblocked = () => { database = undefined; reject(new Error('Chapter log storage is blocked')); };
    });
}
function request<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function safeText(value: string, max: number): string {
    return value.replace(/https?:\/\/\S+|(?:sk-|AIza)[\w-]+|Bearer\s+\S+/gi, '[redacted]').slice(0, max);
}
async function scopeOf(chapter: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(chapter));
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
function publicHead(head: StoredHead): ChapterLogHead {
    const safe: ChapterLogHead = { id: head.id, build: head.build, userAgent: head.userAgent, startedAt: head.startedAt,
        updatedAt: head.updatedAt, phase: head.phase, stage: head.stage, stageAt: head.stageAt, done: head.done,
        total: head.total, errors: head.errors, inflight: head.inflight, sequence: head.sequence, droppedEvents: head.droppedEvents };
    for (const key of ['endedAt', 'engine', 'textSource', 'parallelLlm', 'mergePages', 'runnerKind', 'hasOffscreenApi', 'hasContextsApi', 'hasSessionStorage'] as const) {
        if (head[key] !== undefined) Object.assign(safe, { [key]: head[key] });
    }
    return safe;
}
export async function createChapterLog(readerTab: number, chapter: string, build: string, userAgent: string): Promise<string> {
    const d = await db();
    const id = crypto.randomUUID(), now = Date.now();
    const scope = await scopeOf(chapter);
    await new Promise<void>((resolve, reject) => {
        const tx = d.transaction(['heads', 'events', 'pages'], 'readwrite');
        const heads = tx.objectStore('heads');
        const all = heads.getAll();
        all.onsuccess = () => {
            const old = (all.result as StoredHead[]).sort((a, b) => b.startedAt - a.startedAt).slice(KEEP_RUNS - 1);
            for (const head of old) {
                heads.delete(head.id);
                for (const name of ['events', 'pages']) {
                    const store = tx.objectStore(name);
                    const cursor = store.index('byRun').openKeyCursor(IDBKeyRange.only(head.id));
                    cursor.onsuccess = () => { if (cursor.result) { store.delete(cursor.result.primaryKey); cursor.result.continue(); } };
                }
            }
            heads.put({ id, readerTab, scope, build: safeText(build, 128), userAgent: safeText(userAgent, 512),
                startedAt: now, updatedAt: now, phase: 'preparing', stage: 'preparing', stageAt: now,
                done: 0, total: 0, errors: 0, inflight: 0, sequence: 0, droppedEvents: 0 } satisfies StoredHead);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Could not save chapter log'));
    });
    return id;
}
export async function appendChapterLog(logId: string, input: ChapterLogInput): Promise<void> {
    const event = sanitizeChapterEvent(input);
    if (!event || !logId) return;
    const d = await db();
    await new Promise<void>((resolve, reject) => {
        const tx = d.transaction(['heads', 'events', 'pages'], 'readwrite');
        const heads = tx.objectStore('heads');
        const headRequest = heads.get(logId);
        headRequest.onsuccess = () => {
            const head = headRequest.result as StoredHead | undefined;
            if (!head) return;
            const seq = ++head.sequence;
            head.updatedAt = Math.max(head.updatedAt, event.at);
            if (event.stage && !event.pages?.length && event.at >= head.stageAt) { head.stage = event.stage; head.stageAt = event.at; }
            for (const key of ['phase', 'done', 'total', 'errors', 'inflight', 'engine', 'textSource', 'parallelLlm', 'mergePages', 'runnerKind', 'hasOffscreenApi', 'hasContextsApi', 'hasSessionStorage'] as const) {
                if (event[key] !== undefined) Object.assign(head, { [key]: event[key] });
            }
            if (event.kind === 'failure' || event.kind === 'runner-lost') head.phase = 'error';
            if (event.kind === 'cancel') head.phase = 'stopped';
            if (['stopped', 'complete', 'error'].includes(head.phase)) head.endedAt ??= event.at;
            else head.endedAt = undefined;
            const events = tx.objectStore('events');
            events.put({ logId, event }, [logId, seq]);
            if (seq > KEEP_EVENTS) { events.delete([logId, seq - KEEP_EVENTS]); head.droppedEvents++; }
            heads.put(head);
            const pages = tx.objectStore('pages');
            for (const page of event.pages ?? []) {
                if (page > KEEP_PAGES) continue;
                const get = pages.get([logId, page]);
                get.onsuccess = () => pages.put({ logId, page: updateChapterLogPage(get.result?.page, page, event) }, [logId, page]);
            }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Could not append chapter log'));
    });
}
export function recordChapterLog(trace: ChapterTrace | undefined, event: ChapterLogInput): void {
    if (!trace?.logId) return;
    void appendChapterLog(trace.logId, { ...event, at: Date.now(), pages: event.pages ?? trace.pages,
        request: event.request ?? trace.request }).catch(() => {});
}
export async function chapterLogOwned(logId: string, readerTab: number, chapter: string): Promise<boolean> {
    const d = await db();
    const head = await request(d.transaction('heads').objectStore('heads').get(logId)) as StoredHead | undefined;
    return head?.readerTab === readerTab && head?.scope === await scopeOf(chapter);
}
export async function latestChapterLogHead(readerTab?: number): Promise<ChapterLogHead | undefined> {
    const d = await db();
    const all = await request(d.transaction('heads').objectStore('heads').getAll()) as StoredHead[];
    all.sort((a, b) => b.startedAt - a.startedAt);
    const head = all.find(h => h.readerTab === readerTab) ?? all[0];
    return head ? publicHead(head) : undefined;
}
export async function readChapterLog(logId: string): Promise<ChapterLogReport | undefined> {
    const d = await db();
    const tx = d.transaction(['heads', 'events', 'pages']);
    const [head, rows, pages] = await Promise.all([
        request(tx.objectStore('heads').get(logId)) as Promise<StoredHead | undefined>,
        request(tx.objectStore('events').index('byRun').getAll(logId)) as Promise<{ event: ChapterLogEvent }[]>,
        request(tx.objectStore('pages').index('byRun').getAll(logId)) as Promise<{ page: ChapterLogPage }[]>,
    ]);
    return head ? { schema: 1, capturedAt: Date.now(), head: publicHead(head),
        pages: pages.map(row => row.page).sort((a, b) => a.page - b.page), events: rows.map(row => row.event) } : undefined;
}
export async function recordChapterWorkerWake(): Promise<void> {
    const d = await db();
    const heads = await request(d.transaction('heads').objectStore('heads').getAll()) as StoredHead[];
    await Promise.all(heads.filter(h => ['preparing', 'running', 'waiting', 'stopping'].includes(h.phase))
        .map(h => appendChapterLog(h.id, { kind: 'background-woke' })));
}
