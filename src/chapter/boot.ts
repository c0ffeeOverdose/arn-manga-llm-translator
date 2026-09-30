// Firefox-only boot hook, kept in its own module: the worker's `background.ts` imports it,
// and that file is bundled into Chromium's service worker, which has no DOM at all.
//
// The runner module is loaded through a DYNAMIC import so the bundler cannot pull it (and
// its document/OffscreenCanvas code) into the service-worker bundle. Chromium skips the
// import entirely: its offscreen document attaches itself (see runner.ts).
import { runnerKind } from './runner';

export async function bootChapterRunner(): Promise<void> {
    // Firefox: the background page IS the runner, so the runner code must live in this
    // context. Chromium: an offscreen document is created by the broker instead.
    if (runnerKind() !== 'background') return;
    const { attachChapterRunner } = await import('./page');
    await attachChapterRunner();
}
