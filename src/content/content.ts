// Content script: find page images on any manga site, run pipeline, draw over them.
// detect (iframe) → translate (background LLM, BYOK) → inpaint → render Thai.
// Pipeline tuning comes from mtPipeline settings (options page / presets).
// Orchestrator logic lives in the sibling modules; this entry only boots.

import { ensureDetector } from './detection';
import { setUi, ui, loadPipeline, loadTheme, applyTheme, onThemeChange } from './state';
import { makePill, loadDebug, renderStatus } from './status-ui';
import { applyOverlays } from './overlays';
import { installMessageListener } from './commands';
import { initAuto } from './auto';
import { onThemeChanged } from './chars-ui';

declare const __BUILD_ID__: string; // injected by build.mjs — which build is this?

// Single-execution guard: reloading the extension re-injects this script
// into open tabs while the old instance keeps running (timers, listeners,
// pill) — two instances fight over the DOM (revoke wars, double LLM calls,
// greyed-out image menu). The newcomer dies on the spot; the survivor keeps
// working until the tab reloads (its [mt] build stamp shows stale).
if ((window as any).__mtContentLoaded) throw new Error('[mt] duplicate content script — old instance still owns this tab');
(window as any).__mtContentLoaded = true;

onThemeChange(onThemeChanged); // chars panel repaints on theme flips
chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.mtTheme) applyTheme((ch.mtTheme.newValue as string | undefined) ?? 'system');
    if (area === 'local' && ch.mtPipeline) void loadPipeline(); // slider/settings edits apply live, next job reads them
});

installMessageListener();
initAuto();

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
            // overlay sweeper: re-apply overlays when the reader swaps/replaces
            // page elements (paged navigation mid-queue was drawing into dead ones).
            // 1s rhythm: the fast repaint lane (back-nav onto known content) must
            // feel instant — the pass itself is cheap (a handful of imgs, sync map
            // hits; hashing only fires for unknown URLs, once per src).
            setInterval(applyOverlays, 1000);
        }
    }, 500);
}

main();
