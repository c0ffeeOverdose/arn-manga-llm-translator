// Content script entry: pipeline is detect (iframe) → translate (background LLM) → inpaint → render.
// This module only boots; orchestration lives in the sibling modules.

import { ensureDetector } from './detection';
import { setUi, ui, loadPipeline, loadTheme, applyTheme, onThemeChange } from './state';
import { makePill, loadDebug, renderStatus } from './status-ui';
import { applyOverlays } from './overlays';
import { installMessageListener } from './commands';
import { initAuto } from './auto';
import { initSweep } from './sweep';
import { onThemeChanged } from './chars-ui';

declare const __BUILD_ID__: string; // injected by build.mjs — which build is this?

// Single-execution guard: a re-injected copy must die — two instances
// fight over the DOM (revoke wars, double LLM calls).
if ((window as any).__mtContentLoaded) throw new Error('[mt] duplicate content script — old instance still owns this tab');
(window as any).__mtContentLoaded = true;

onThemeChange(onThemeChanged); // chars panel repaints on theme flips
chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.mtTheme) applyTheme((ch.mtTheme.newValue as string | undefined) ?? 'system');
    if (area === 'local' && ch.mtPipeline) void loadPipeline(); // slider/settings edits apply live, next job reads them
});

installMessageListener();
initAuto();
initSweep(); // registers the chapter-sweep waiter (preparePage attach lane)

async function main() {
    console.log('[mt] build', __BUILD_ID__);
    await loadTheme();
    await loadDebug();
    await loadPipeline();
    await ensureDetector().catch(e => console.error('[mt] detector init failed:', e));
    const t = setInterval(() => {
        if (document.body && !ui) {
            const pill = makePill();
            setUi(pill);
            document.body.append(pill);
            clearInterval(t);
            renderStatus();
            // Overlay sweeper: the reader can swap page elements mid-queue —
            // re-apply overlays every 1s (cheap sync map hits).
            setInterval(applyOverlays, 1000);
        }
    }, 500);
}

main();
