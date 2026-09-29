import type { ChapterProgress } from './model';

// WHERE a chapter run executes. Neither place is a tab, so the run survives the reader
// navigating and the user never sees a new tab appear.
//   Chromium: an offscreen document (no lifetime cap for our reasons).
//   Firefox:  the background event page itself, which has a DOM.
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
    // Firefox: the background page is the runner. Its own boot hook starts it, and a
    // restart re-attaches to the stored session, so `ensure` has nothing to create.
    return {
        kind: 'background',
        async ensure(id) {
            await chrome.runtime.sendMessage({ type: 'mt:chapter-runner-attach', id }).catch(() => {});
        },
        async stop() { await chrome.runtime.sendMessage({ type: 'mt:chapter-runner-stop' }).catch(() => {}); },
        async live() { return true; },
    };
}
