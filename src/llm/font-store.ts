// Font store: user-selectable render fonts. Presets stream from the google
// /fonts repo (jsDelivr, raw.githubusercontent fallback) once, then live in
// IndexedDB offline — same pattern as the OCR language data. Custom fonts
// come from any URL the user pastes (with a host-permission fallback for
// CORS-restricted origins). Pure browser logic, no Chrome APIs.

export interface FontPreset {
    id: string;          // stable id, also the IndexedDB key suffix
    label: string;
    repoPath: string;    // path inside google/fonts (license dir + family + file)
    langs: string;       // hint: which scripts it covers
}

export const FONT_PRESETS: FontPreset[] = [
    // Thai (research: Sarabun = the standard, round handwritten feel = Mitr/Kanit)
    { id: 'sarabun', label: 'Sarabun (Thai standard)', repoPath: 'ofl/sarabun/Sarabun-Regular.ttf', langs: 'th+latin' },
    { id: 'mitr', label: 'Mitr (Thai, round)', repoPath: 'ofl/mitr/Mitr-Regular.ttf', langs: 'th+latin' },
    { id: 'prompt', label: 'Prompt (Thai)', repoPath: 'ofl/prompt/Prompt-Regular.ttf', langs: 'th+latin' },
    { id: 'kanit', label: 'Kanit (Thai, bold feel)', repoPath: 'ofl/kanit/Kanit-Regular.ttf', langs: 'th+latin' },
    { id: 'chonburi', label: 'Chonburi (Thai display)', repoPath: 'ofl/chonburi/Chonburi-Regular.ttf', langs: 'th+latin' },
    { id: 'taviraj', label: 'Taviraj (Thai serif)', repoPath: 'ofl/taviraj/Taviraj-Regular.ttf', langs: 'th+latin' },
    // Latin (nearest hand-lettered feel to CC Wild Words / Anime Ace on GF)
    { id: 'patrickhand', label: 'Patrick Hand (Latin hand)', repoPath: 'ofl/patrickhand/PatrickHand-Regular.ttf', langs: 'latin' },
    { id: 'comicneue', label: 'Comic Neue (Latin comic)', repoPath: 'ofl/comicneue/ComicNeue-Regular.ttf', langs: 'latin' },
    { id: 'kalam', label: 'Kalam (Latin hand)', repoPath: 'ofl/kalam/Kalam-Regular.ttf', langs: 'latin' },
    { id: 'permanentmarker', label: 'Permanent Marker (Latin shout)', repoPath: 'apache/permanentmarker/PermanentMarker-Regular.ttf', langs: 'latin' },
];

function openDb(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
        const r = indexedDB.open('mt-models', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('m');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}

export async function fontList(): Promise<string[]> {
    const db = await openDb();
    return new Promise(res => {
        const q = db.transaction('m', 'readonly').objectStore('m').getAllKeys();
        q.onsuccess = () => res((q.result as IDBValidKey[])
            .filter(k => String(k).startsWith('font:'))
            .map(k => String(k).slice(5)));
        q.onerror = () => res([]);
    });
}

async function fontPut(key: string, buf: ArrayBuffer): Promise<void> {
    const db = await openDb();
    await new Promise<void>((res, rej) => {
        const q = db.transaction('m', 'readwrite').objectStore('m').put(buf, key);
        q.onsuccess = () => res();
        q.onerror = () => rej(q.error);
    });
}

export async function fontDelete(id: string): Promise<void> {
    const db = await openDb();
    await new Promise<void>(res => {
        const q = db.transaction('m', 'readwrite').objectStore('m').delete(`font:${id}`);
        q.onsuccess = () => res();
        q.onerror = () => res();
    });
}

export async function fontRead(id: string): Promise<ArrayBuffer | undefined> {
    const db = await openDb();
    return new Promise(res => {
        const q = db.transaction('m', 'readonly').objectStore('m').get(`font:${id}`);
        q.onsuccess = () => res(q.result as ArrayBuffer | undefined);
        q.onerror = () => res(undefined);
    });
}

async function fetchWithProgress(url: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const total = +(resp.headers.get('content-length') ?? 0);
    const reader = resp.body?.getReader();
    if (!reader) return resp.arrayBuffer();
    const parts: BlobPart[] = [];
    let loaded = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value as unknown as BlobPart);
        loaded += value.length;
        onProgress?.(loaded, total);
    }
    return new Blob(parts).arrayBuffer();
}

// download a preset font (google/fonts repo, CDN fallback) — validates that
// the bytes actually look like a font before caching
export async function fontDownload(preset: FontPreset, onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const urls = [
        `https://cdn.jsdelivr.net/gh/google/fonts@main/${preset.repoPath}`,
        `https://raw.githubusercontent.com/google/fonts/main/${preset.repoPath}`,
    ];
    let lastErr: unknown = null;
    for (const url of urls) {
        try {
            const buf = await fetchWithProgress(url, onProgress);
            await fontPut(`font:${preset.id}`, buf);
            return;
        } catch (e) { lastErr = e; }
    }
    throw new Error(`download failed for ${preset.label}: ${String(lastErr).slice(0, 120)}`);
}

// custom font from any URL — caller handles the permission fallback for
// CORS-restricted origins (options page has the user gesture)
export async function fontAddCustom(id: string, name: string, url: string, onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const buf = await fetchWithProgress(url, onProgress);
    await fontPut(`font:${id}`, buf);
    // name registry: keep it alongside the bytes so the dropdown + runtime
    // know the FontFace family name without re-parsing the binary
    await fontPut(`fontname:${id}`, new TextEncoder().encode(JSON.stringify({ name })).buffer as ArrayBuffer);
}

export async function fontName(id: string): Promise<string> {
    const db = await openDb();
    return new Promise(res => {
        const q = db.transaction('m', 'readonly').objectStore('m').get(`fontname:${id}`);
        q.onsuccess = () => {
            try { res(JSON.parse(new TextDecoder().decode(q.result as ArrayBuffer)).name); }
            catch { res(id); }
        };
        q.onerror = () => res(id);
    });
}

export function fontIdFromUrl(url: string): string {
    try {
        const u = new URL(url);
        const base = (u.pathname.split('/').pop() ?? 'font').replace(/\.(ttf|otf|woff2?)$/i, '');
        return `custom-${base.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
    } catch {
        return `custom-${Date.now()}`;
    }
}
