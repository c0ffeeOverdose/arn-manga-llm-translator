import { hashReaderRouting, hashReaderRoutingUrl, hashReaderUrls,
    type HashReaderRouting, type HashReaderRoutingSource } from '../content/page-cache';
import { fetchSourceWithAlternate } from './model';

// Routing is optional data from a reader-declared CDN script, not executable code.
// Bound the whole fetch/read and clear its deadline on every settlement.
export async function fetchHashReaderRouting(source: HashReaderRoutingSource, fetcher: typeof fetch = fetch): Promise<HashReaderRouting | null> {
    if (!hashReaderRoutingUrl([source.url], source.sample)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const r = await fetcher(source.url, { cache: 'no-store', signal: controller.signal });
        if (!r.ok || (r.url && !hashReaderRoutingUrl([r.url], source.sample))
            || Number(r.headers.get('content-length')) > 131_072) return null;
        return hashReaderRouting(await r.text());
    } catch { return null; }
    finally { clearTimeout(timer); }
}

function rerouted(primary: string, routing: HashReaderRouting | undefined): { urls: string[]; alts: string[] } | null {
    const file = /\/([0-9a-f]{16,})\.(avif|webp)$/i.exec(new URL(primary).pathname);
    return file && routing ? hashReaderUrls([{ hash: file[1], avif: file[2].toLowerCase() === 'avif' }], primary,
        { routing, refresh: true }) : null;
}

// One shared refresh per chapter, persisted before the request. Recovery can change
// build/shard only; each page keeps its hash, encoder and a deduplicated attempt list.
export class HashReaderSourceLoader {
    private refreshTask?: Promise<void>;
    constructor(
        private readonly source: HashReaderRoutingSource | undefined,
        private readonly read = fetchHashReaderRouting,
        private readonly save: () => Promise<void> = async () => {},
    ) {}

    private refresh(): Promise<void> {
        if (this.refreshTask) return this.refreshTask;
        if (!this.source || this.source.refreshed) return Promise.resolve();
        this.source.refreshed = true;
        return this.refreshTask = (async () => {
            await this.save();
            const routing = await this.read(this.source!);
            if (routing) this.source!.routing = routing;
            await this.save();
        })().catch(() => {});
    }

    async load<T>(primary: string, alt: string | undefined, load: (url: string) => Promise<T>,
        onRetry?: (message: string) => void, valid: () => boolean = () => true,
    ): Promise<T> {
        const source = this.source;
        if (!source || !hashReaderRoutingUrl([source.url], primary)) return fetchSourceWithAlternate(primary, alt, load, onRetry);
        const tried = new Set<string>();
        const attempt = (url: string): Promise<T> => {
            if (!valid()) throw new DOMException('Source read cancelled', 'AbortError');
            tried.add(url);
            return load(url);
        };
        const routed = rerouted(primary, source.routing);
        const first = routed?.urls[0] ?? primary, second = routed?.alts[0] ?? alt;
        try {
            return await fetchSourceWithAlternate(first, second === first ? undefined : second, attempt, onRetry);
        } catch (original) {
            if (!valid() || !/\bHTTP\s+(?:403|404)\b/i.test((original as Error)?.message ?? '')) throw original;
            await this.refresh();
            if (!valid()) throw new DOMException('Source read cancelled', 'AbortError');
            const refreshed = rerouted(primary, source.routing);
            let last = original;
            const remaining = [refreshed?.urls[0], refreshed?.alts[0]].filter((url): url is string => !!url && !tried.has(url));
            for (const [i, url] of remaining.entries()) {
                try { return await attempt(url); }
                catch (e) {
                    if (!valid() || (e as Error)?.name === 'AbortError') throw e;
                    last = e;
                    if (i + 1 < remaining.length) onRetry?.((e as Error)?.message ?? 'Image source failed');
                }
            }
            throw last;
        }
    }
}
