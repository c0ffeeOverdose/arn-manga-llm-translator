// Every producer retains the generation it started in; clearing invalidates old results
// across extension and reader origins without touching settings, models or character data.
export const CACHE_GENERATION_KEY = 'mtCacheGeneration';
let generation = '';
let revision = 0;
let loading: Promise<string> | undefined;
let resetWork: Promise<void> = Promise.resolve();
const listeners = new Set<() => void | Promise<void>>();

export function cacheGeneration(): string { return generation; }
export function cacheCurrent(token: string): boolean { return token === generation; }
export function assertCacheCurrent(token: string): void {
    if (!cacheCurrent(token)) throw new DOMException('Translation cache was cleared', 'AbortError');
}
export function onCacheReset(listener: () => void | Promise<void>): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function acceptCacheGeneration(value: unknown): Promise<void> {
    const next = typeof value === 'string' ? value : '';
    if (next === generation) return resetWork;
    generation = next;
    revision++;
    resetWork = Promise.all([...listeners].map(fn => Promise.resolve().then(fn))).then(() => {});
    return resetWork;
}
export function cacheReady(): Promise<string> {
    if (!loading) {
        const before = revision;
        loading = (async () => {
            try {
                const stored = await chrome.storage.local.get(CACHE_GENERATION_KEY);
                if (revision === before) generation = typeof stored[CACHE_GENERATION_KEY] === 'string' ? stored[CACHE_GENERATION_KEY] : '';
            } catch { /* contexts without storage keep the initial generation */ }
            return generation;
        })();
        try {
            chrome.storage?.onChanged?.addListener((changes, area) => {
                if (area === 'local' && changes[CACHE_GENERATION_KEY]) void acceptCacheGeneration(changes[CACHE_GENERATION_KEY].newValue).catch(console.error);
            });
        } catch { /* offscreen hosts receive reset through their runner lifecycle */ }
    }
    return loading.then(() => generation);
}
