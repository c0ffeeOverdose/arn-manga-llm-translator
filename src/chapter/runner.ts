import type { ChapterProgress } from './model';

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
export function createRunner(): ChapterRunner {
    const api = offscreenApi();
    if (api) {
        return {
            kind: 'offscreen',
            async ensure() {
                const has = typeof api.hasDocument === 'function' ? await api.hasDocument() : false;
                if (has) return;
                await api.createDocument({
                    url: runnerUrl(),
                    reasons: ['WORKERS', 'BLOBS'] as chrome.offscreen.Reason[],
                    justification: 'Translate the rest of a manga chapter in the background',
                });
            },
            async stop() { await api.closeDocument().catch(() => {}); },
            async live() {
                return typeof api.hasDocument === 'function' ? await api.hasDocument() : true;
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
