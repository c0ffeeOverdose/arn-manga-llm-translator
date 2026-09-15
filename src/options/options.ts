// Options page: LLM settings + quality presets + advanced tuning + characters.
// Section logic lives in model.ts / pipeline-section.ts / panels.ts; this file
// owns load order and final wiring.

import { DEFAULT_SETTINGS, type LLMSettings } from '../llm/adapters';
import type { PipelineSettings } from '../llm/pipeline-settings';
import { $, setDirty, wireTabs, loadThemeChoice } from './shell';
import { fillModelFields, fillOcrFields, updateHints, markModelDirty, saveAll, discardAll, testConnection, testOcr, syncSetupBanner, syncInferUI, syncThinkingUI, testCloud } from './model';
import { pipeline, loadStoredPipeline, syncAdvancedUI } from './pipeline-section';
import { renderCharacters, clearCharacters, renderAutoSites, drawFontPreview } from './panels';

interface CharOverride { gender: 'M' | 'F' | '?'; name?: string }

async function load(): Promise<void> {
    const { mtSettings, mtOcrSettings, mtPipeline, mtCharOverrides, mtDebug } = await chrome.storage.local.get(['mtSettings', 'mtOcrSettings', 'mtPipeline', 'mtCharOverrides', 'mtDebug']);
    // pipeline first — fillModelFields reads pipeline.thinkingLevel
    loadStoredPipeline(mtPipeline as PipelineSettings | undefined);

    fillModelFields({ ...DEFAULT_SETTINGS, ...(mtSettings ?? {}) } as LLMSettings);
    fillOcrFields({ ...DEFAULT_SETTINGS, ...(mtOcrSettings ?? {}) } as LLMSettings);
    syncAdvancedUI();
    // debug overlay is its own key (not pipeline): applies instantly, no save needed
    ($('debugBoxes') as HTMLInputElement).checked = mtDebug === true;
    updateHints();
    syncSetupBanner();
    loadThemeChoice();
    renderCharacters((mtCharOverrides ?? {}) as Record<string, CharOverride>);
    renderAutoSites();
    // popup toggles while options sits open — the list follows live
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && (ch.mtAutoSites || ch.mtAutoTranslate)) renderAutoSites();
    });
    ($('autoSitesClear') as HTMLButtonElement).onclick = async () => {
        await chrome.storage.local.set({ mtAutoSites: [], mtAutoTranslate: false });
        renderAutoSites();
    };
}

// ---- wire up ----

($('provider') as HTMLSelectElement).onchange = () => { updateHints(); syncThinkingUI(); markModelDirty(); };
for (const id of ['model', 'apiKey', 'baseUrl'] as const) {
    ($<HTMLInputElement>(id)).oninput = markModelDirty;
}
$('test').onclick = testConnection;
$('ocrTest').onclick = testOcr;
$('testCloud').onclick = testCloud;
($('saveAll') as HTMLButtonElement).onclick = saveAll;
($('discard') as HTMLButtonElement).onclick = () => discardAll(fillModelFields, syncAdvancedUI);
$('clearChars').onclick = clearCharacters;
wireTabs((tab) => {
    // the preview paints blank while its tab is hidden — repaint on open
    if (tab === 'appearance') drawFontPreview();
});
load();
