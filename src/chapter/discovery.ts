import { normalizeChapterKey, samePagePath } from '../content/page-cache';

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

// A page image is never a 1px spacer, an icon or a tracker: readers annotate thumbnails
// with width/height attributes and full page art is always tall. These are the only
// non-DOM signals that survive a fetched (undragged, undecoded) document.
export interface ImageFilterOpts {
    minW?: number;
    minH?: number;
}

function attributeSize(img: HTMLImageElement): { w: number; h: number } | null {
    const w = Number(img.getAttribute('width') || 0);
    const h = Number(img.getAttribute('height') || 0);
    return w > 0 && h > 0 ? { w, h } : null;
}

type LazyImage = HTMLImageElement & { loading?: string; currentSrc?: string };

// Chosen source attribute for a page image: the reader may ship several candidates and a
// placeholder. Preference order is the same one the live DOM read uses.
function pageImageSrc(img: LazyImage): string | null {
    const src = img.getAttribute('data-src') || img.getAttribute('data-original')
        || img.getAttribute('data-lazy-src') || img.getAttribute('data-url') || img.getAttribute('src');
    return src || null;
}

// URLs that are structurally never page art. Functional identifiers only (extension
// assets and data URIs); no per-site host rules live here — a real CDN is never excluded.
function implausibleImage(url: URL): boolean {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return true;
    return /\.(svg|ico|gif)$/i.test(url.pathname);
}

// The same chapter from a sibling document. Broad by design: readers swap between one
// <img> per page and a lazily-built column, and the same page must not be fetched twice.
export function chapterImages(doc: Document, base: string, opts: ImageFilterOpts = {}): string[] {
    const urls: string[] = [];
    const consider = (candidate: string): void => {
        try {
            const url = new URL(candidate, base);
            if (implausibleImage(url) || urls.includes(url.href)) return;
            if (urls.some(u => samePagePath(u, url.href))) return; // CDN host rotation
            urls.push(url.href);
        } catch { /* malformed lazy image */ }
    };
    const candidates = doc.querySelectorAll<LazyImage>('img[src], img[data-src], img[data-original], img[data-lazy-src], img[data-url], source[srcset], source[data-srcset]');
    for (const img of candidates) {
        const raw = img.tagName === 'SOURCE'
            ? (img.getAttribute('srcset') || img.getAttribute('data-srcset') || '').split(',')[0]?.trim().split(/\s+/)[0]
            : pageImageSrc(img);
        if (!raw) continue;
        const size = attributeSize(img as HTMLImageElement);
        if (size && ((opts.minW && size.w < opts.minW) || (opts.minH && size.h < opts.minH))) continue;
        consider(raw);
    }
    return urls;
}

// Fallback for documents that declare no rel=next (paginated readers often only ship a
// script that swaps content in place). Tries the next page by the URL shapes those
// readers actually use, and the caller stops on a 404, a redirect or repeated content.
// Every shape is re-checked against the chapter key, so a guess can never leave the
// chapter the user started on.
export function guessNextDocument(current: string, chapter: string, step = 1): string | undefined {
    let url: URL;
    try { url = new URL(current); } catch { return undefined; }
    const chapterKey = chapterFromUrl(chapter);
    const shapes: string[] = [];
    if (url.searchParams.has('page')) {
        const n = Number(url.searchParams.get('page'));
        if (Number.isFinite(n)) {
            const next = new URL(url.href);
            next.searchParams.set('page', String(n + step));
            shapes.push(next.href);
        }
    }
    // A trailing numeric segment is a page ONLY when the rest of the path already carries
    // the chapter (a digit outside that segment) — the same guard normalizeChapterKey
    // applies. Otherwise /title/9 is a chapter id, and bumping it walks into the next
    // chapter, which the caller must never do.
    const segs = url.pathname.split('/').filter(Boolean);
    const tail = segs[segs.length - 1];
    const stem = segs.slice(0, -1).join('/');
    if (segs.length >= 2 && /^\d+$/.test(tail) && /\d/.test(stem)) {
        const next = new URL(url.href);
        segs[segs.length - 1] = String(Number(tail) + step);
        next.pathname = '/' + segs.join('/');
        shapes.push(next.href);
    }
    // Numeric hash routes: normalizeChapterKey keeps a hash verbatim (it may BE the story
    // id), so a hash-bearing URL compares by its hash even on a path that carries the
    // chapter. Step it only when the current URL's own stem key (hash folded away, as the
    // path rules would) still equals the chapter — that means the hash is not the identity
    // and walking it cannot leave the chapter.
    if (/^#\d+(-\d*)?$/.test(url.hash)) {
        const stemKey = chapterFromUrl(url.origin + url.pathname + url.search);
        if (chapterKey && stemKey === chapterKey) {
            const next = new URL(url.href);
            const m = url.hash.match(/^#(\d+)(?:-(\d*))?$/);
            if (m) next.hash = `#${Number(m[1]) + step}${m[2] ? '-' + m[2] : ''}`;
            if (next.href !== current) shapes.push(next.href);
        }
    }
    for (const shape of shapes) {
        if (shape === current) continue;
        if (chapterKey ? chapterFromUrl(shape) === chapterKey : sameChapterDocument(shape, current, chapter)) return shape;
    }
    return undefined;
}

function chapterFromUrl(url: string): string | undefined {
    try {
        const u = new URL(url);
        return normalizeChapterKey(u.origin, u.pathname, u.search, u.hash);
    } catch { return undefined; }
}
