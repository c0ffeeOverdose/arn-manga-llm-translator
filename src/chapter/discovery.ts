import { normalizeChapterKey } from '../content/page-cache';

export function sameChapterDocument(candidate: string, reader: string, chapter: string): boolean {
    try {
        const url = new URL(candidate, reader);
        return /^https?:$/.test(url.protocol) && url.origin === new URL(reader).origin
            && normalizeChapterKey(url.origin, url.pathname, url.search, url.hash) === chapter;
    } catch { return false; }
}

export function nextDocument(doc: Document, base: string, chapter: string): string | undefined {
    const next = doc.querySelector<HTMLAnchorElement | HTMLLinkElement>('a[rel~="next"],link[rel~="next"]')?.getAttribute('href');
    if (!next) return undefined;
    const url = new URL(next, base).href;
    return url !== base && sameChapterDocument(url, base, chapter) ? url : undefined;
}

export function documentImages(doc: Document, base: string, selector: string): string[] {
    const urls: string[] = [];
    for (const img of doc.querySelectorAll<HTMLImageElement>(selector)) {
        const raw = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src');
        if (!raw) continue;
        try {
            const url = new URL(raw, base);
            if (/^https?:$/.test(url.protocol) && !urls.includes(url.href)) urls.push(url.href);
        } catch { /* malformed lazy image */ }
    }
    return urls;
}
