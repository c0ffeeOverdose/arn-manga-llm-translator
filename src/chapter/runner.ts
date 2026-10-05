// WHERE a chapter run executes. Neither place is a tab, so the run survives the reader
// navigating and the user never sees a new tab appear.
//   Chromium: an offscreen document (no lifetime cap for our reasons).
//   Firefox:  a hidden iframe inside the background event page. The broker shares that
//             page, and runtime.sendMessage is never delivered to the sender's own
//             frame, so broker and runner must be separate frames to talk at all.
// This module is the only place that knows the difference.
export interface ChapterRunner {
    readonly kind: RunnerKind;
    ensure(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    live(id: string): Promise<boolean>;
}
export type RunnerKind = 'offscreen' | 'background';

function offscreenApi(): typeof chrome.offscreen | undefined {
    return (chrome as unknown as { offscreen?: typeof chrome.offscreen }).offscreen;
}
export function runnerKind(): RunnerKind {
    return offscreenApi() ? 'offscreen' : 'background';
}
export function runnerUrl(): string {
    // The runner asks for its session by messaging, so the URL only has to be a static
    // extension page bundled with the build.
    return chrome.runtime.getURL('chapter/page.html');
}

// Presence checks must describe this runner document, not another extension window.
// Older Chromium exposes context/client enumeration without offscreen.hasDocument.
// A fork whose getContexts filter misbehaves must not read as "runner is dead" — every probe
// falls through to the next instead of trusting one API, and only a definitive no is false.
async function offscreenLive(api: typeof chrome.offscreen): Promise<boolean> {
    const url = runnerUrl();
    const runtime = chrome.runtime as unknown as {
        getContexts?: (filter: { contextTypes: string[]; documentUrls: string[] }) => Promise<{ documentUrl?: string }[]>;
    };
    try {
        if (runtime.getContexts) {
            const contexts = await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
            if (contexts.some(context => context.documentUrl === url)) return true;
        }
    } catch { /* fall through to the older probes */ }
    try {
        if (typeof api.hasDocument === 'function') return await api.hasDocument();
    } catch { /* fall through */ }
    try {
        const clients = (globalThis as unknown as {
            clients?: { matchAll(options: { type: string; includeUncontrolled: boolean }): Promise<{ url: string }[]> };
        }).clients;
        if (!clients) return false;
        return (await clients.matchAll({ type: 'window', includeUncontrolled: true })).some(client => client.url === runnerUrl());
    } catch { return false; }
}

export function createRunner(): ChapterRunner {
    const api = offscreenApi();
    if (api) {
        return {
            kind: 'offscreen',
            async ensure() {
                const has = await offscreenLive(api);
                if (has) return;
                await api.createDocument({
                    url: runnerUrl(),
                    reasons: ['WORKERS', 'BLOBS'] as chrome.offscreen.Reason[],
                    justification: 'Translate the rest of a manga chapter in the background',
                });
            },
            async stop() { await api.closeDocument().catch(() => {}); },
            async live() {
                return offscreenLive(api);
            },
        };
    }
    // Firefox: the runner is a hidden iframe in this (background) page; its own boot hook
    // attaches it (see chapter/page.ts) and broker messages now cross frames.
    let frame: HTMLIFrameElement | null = null;
    return {
        kind: 'background',
        async ensure() {
            if (frame?.isConnected) return;
            frame?.remove();
            frame = document.createElement('iframe');
            frame.src = runnerUrl();
            frame.style.display = 'none';
            document.documentElement.appendChild(frame);
        },
        async stop() { frame?.remove(); frame = null; },
        async live() { return !!frame?.isConnected; },
    };
}
