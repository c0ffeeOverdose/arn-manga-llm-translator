import { cacheGet, cachePutMany, cacheDelete, cacheCount, cacheCountChapter, cacheCountPrefix } from '../cache/store';
import { encodeCache, decodeCache } from '../cache/wire';
import { normalizeChapterKey } from '../content/page-cache';
import { cacheReady, assertCacheCurrent } from '../cache-generation';
import { liveSenderUrl } from '../cache/sender-url';

chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'mt:translation-cache' || sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return;
    const work = async (): Promise<unknown> => {
        const url = new URL(liveSenderUrl(sender.url, sender.tab?.url));
        if (!/^https?:$/.test(url.protocol)) throw new Error('Reader cache access is unavailable');
        const chapter = normalizeChapterKey(url.origin, url.pathname, url.search, url.hash);
        const owns = (key: unknown): key is string => typeof key === 'string'
            && (key.startsWith(chapter + '#') || key.startsWith(chapter + '@p'));
        await cacheReady();
        assertCacheCurrent(message.cacheEpoch);
        if (message.op === 'get' && owns(message.key)) {
            const row = await cacheGet(message.key);
            return { ok: true, entry: row && encodeCache(row) };
        }
        if (message.op === 'put' && Array.isArray(message.entries) && message.entries.every((row: { key?: unknown }) => owns(row?.key))) {
            await cachePutMany(message.entries.map(decodeCache), message.max, message.cacheEpoch);
            return { ok: true };
        }
        if (message.op === 'delete' && owns(message.key)) {
            await cacheDelete(message.key, message.cacheEpoch);
            return { ok: true };
        }
        if (message.op === 'count') return { ok: true, count: await cacheCount() };
        if (message.op === 'count-chapter' && message.chapter === chapter) return { ok: true, count: await cacheCountChapter(chapter) };
        if (message.op === 'count-prefix' && owns(message.prefix)) return { ok: true, count: await cacheCountPrefix(message.prefix) };
        throw new Error('Saved page does not belong to this reader');
    };
    work().then(respond, error => respond({ ok: false, error: (error as Error).message }));
    return true;
});
