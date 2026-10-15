// Model tab: provider credentials, test connection, thinking level, inference engine, detection pre-download.

import { DEFAULT_BASES, DEFAULT_SETTINGS, THINKING_HINTS, THINKING_LEVELS, type LLMSettings } from '../llm/adapters';
import { inpaintMode, mergePipeline, type PipelineSettings } from '../llm/pipeline-settings';
import { detModelsInstalled, detDownload, detDelete, inpaintInstalled, inpaintDownload, inpaintDelete } from '../llm/ocr-models';
import { koharuInstalled, koharuDownload, koharuDelete, importKoharuFile } from '../llm/layout-models';
import { KOHARU_MODEL } from '../layout-model';
import { $, setDirty, setStatus, dlProgress } from './shell';
import { pipeline, loadStoredPipeline, syncOcrManager, syncOcrSeparateUI, syncDetectionTuning } from './pipeline-section';
import { hostOriginPatterns, requestHostAccess } from './host-access';

const MODEL_HINTS: Record<string, string> = {
    openai: 'Use the exact model ID from your provider, including any provider prefix.',
    responses: 'Use a model ID that your provider supports through the Responses API.',
    anthropic: 'Use the model ID from your Anthropic account.',
    gemini: 'Use the model ID from Google AI Studio.',
    cloudflare: 'Use the full model ID, starting with @cf/.',
};

// placeholder follows the protocol (static HTML keeps the openai default for first paint)
const MODEL_PLACEHOLDERS: Record<string, string> = {
    openai: 'Model ID from your provider',
    responses: 'Model ID from your provider',
    anthropic: 'Claude model ID',
    gemini: 'Gemini model ID',
    cloudflare: '@cf/provider/model-name',
};

// per-provider Base URL examples (defaults live in DEFAULT_BASES)
const BASE_HINTS: Record<string, string> = {
    openai: ' For other providers, enter their API URL.',
    responses: ' For other providers, enter their API URL.',
    anthropic: '',
    gemini: '',
    cloudflare: ' Replace <ACCOUNT_ID> with your account ID. The token needs Workers AI access.',
};

export function fillModelFields(s: LLMSettings): void {
    ($('provider') as HTMLSelectElement).value = s.provider;
    ($('model') as HTMLInputElement).value = s.model;
    ($('apiKey') as HTMLInputElement).value = s.apiKey;
    ($('baseUrl') as HTMLInputElement).value = s.baseUrl ?? '';
    ($('cloudEndpoint') as HTMLInputElement).value = s.cloudEndpoint ?? '';
    ($('cloudKey') as HTMLInputElement).value = s.cloudKey ?? '';
    syncInferUI();
    syncThinkingUI();
    syncTemperatureUI();
}

export function currentSettings(): LLMSettings {
    return {
        provider: ($('provider') as HTMLSelectElement).value as LLMSettings['provider'],
        model: ($('model') as HTMLInputElement).value.trim(),
        apiKey: ($('apiKey') as HTMLInputElement).value.trim(),
        baseUrl: ($('baseUrl') as HTMLInputElement).value.trim(),
        cloudEndpoint: ($('cloudEndpoint') as HTMLInputElement).value.trim().replace(/\/$/, ''),
        cloudKey: ($('cloudKey') as HTMLInputElement).value.trim(),
    };
}

// split pipeline: the VLM that only transcribes (never translates)
export function fillOcrFields(s: LLMSettings): void {
    ($('ocrProvider') as HTMLSelectElement).value = s.provider;
    ($('ocrModel') as HTMLInputElement).value = s.model;
    ($('ocrApiKey') as HTMLInputElement).value = s.apiKey;
    ($('ocrBaseUrl') as HTMLInputElement).value = s.baseUrl ?? '';
    ($('ocrThinking') as HTMLInputElement).value = pipeline.ocrThinking;
    renderOcrThinkingList();
    syncOcrThinkingHint();
    syncOcrTemperatureUI();
}

export function currentOcrSettings(): LLMSettings {
    return {
        provider: ($('ocrProvider') as HTMLSelectElement).value as LLMSettings['provider'],
        model: ($('ocrModel') as HTMLInputElement).value.trim(),
        apiKey: ($('ocrApiKey') as HTMLInputElement).value.trim(),
        baseUrl: ($('ocrBaseUrl') as HTMLInputElement).value.trim(),
        cloudEndpoint: '',
        cloudKey: '',
    };
}

export function updateHints() {
    const provider = ($('provider') as HTMLSelectElement).value;
    ($('modelHint') as HTMLDivElement).textContent = MODEL_HINTS[provider] ?? '';
    ($('model') as HTMLInputElement).placeholder = MODEL_PLACEHOLDERS[provider] ?? '';
    ($('baseHint') as HTMLDivElement).textContent = `Leave blank to use ${DEFAULT_BASES[provider as keyof typeof DEFAULT_BASES]}.${BASE_HINTS[provider] ?? ''}`;
}

// provider endpoint used for host access; an empty override falls back to the default
function baseUrlOf(baseUrl: string | undefined, provider: LLMSettings['provider']): string {
    return baseUrl || DEFAULT_BASES[provider];
}

// model credentials: edit → dirty only. Host permission is asked at
// Save/Test time, not while typing.
export function markModelDirty(): void {
    syncSetupBanner(); // banner tracks the key field live
    setDirty(true);
}

export async function saveAll(): Promise<void> {
    const s = currentSettings();
    if (!s.model || !s.apiKey) {
        setStatus('Enter a model ID and API key first.', 'err');
        return;
    }
    const o = currentOcrSettings();
    if (pipeline.useOcrModel && pipeline.textSource !== 'ocr' && (!o.model || !o.apiKey)) {
        setStatus('Enter the reader model ID and API key, or turn off the separate reader.', 'err');
        return;
    }
    // one request covers every origin this save touches: Firefox allows it only in
    // the click's own task, before any await (see host-access.ts)
    const urls = [baseUrlOf(s.baseUrl, s.provider)];
    if (o.model || o.apiKey) urls.push(baseUrlOf(o.baseUrl, o.provider));
    try {
        await requestHostAccess(hostOriginPatterns(urls));
    } catch (e) {
        setStatus(`Not saved — ${(e as Error).message}`, 'err');
        return;
    }
    // merge over fresh storage: popup-owned keys changed since load — blind write would revert them
    const { mtPipeline: stored } = await chrome.storage.local.get('mtPipeline');
    Object.assign(pipeline, mergePipeline(stored, pipeline));
    await chrome.storage.local.set({ mtSettings: s, mtOcrSettings: o, mtPipeline: pipeline });
    setDirty(false);
    setStatus('Changes saved.', 'ok', 2000);
    syncSetupBanner();
}

export async function discardAll(fill: (s: LLMSettings) => void, syncAdvancedUI: () => void): Promise<void> {
    const { mtSettings, mtOcrSettings, mtPipeline } = await chrome.storage.local.get(['mtSettings', 'mtOcrSettings', 'mtPipeline']);
    // reload pipeline too: thinking/temperature controls read the in-memory object
    loadStoredPipeline(mtPipeline as PipelineSettings | undefined);
    fill({ ...DEFAULT_SETTINGS, ...(mtSettings ?? {}) } as LLMSettings);
    fillOcrFields({ ...DEFAULT_SETTINGS, ...(mtOcrSettings ?? {}) } as LLMSettings);
    syncAdvancedUI();
    updateHints();
    syncSetupBanner();
    setDirty(false);
}

export async function testConnection(): Promise<void> {
    const s = currentSettings();
    const el = $('testStatus') as HTMLElement;
    if (!s.model || !s.apiKey) {
        setStatus('Enter a model ID and API key first.', 'err', 0, el);
        return;
    }
    setStatus('Testing…', '', 0, el);
    try {
        await requestHostAccess(hostOriginPatterns([baseUrlOf(s.baseUrl, s.provider)]));
        // text-only check (key + model + reachability); image support is detected at translation time.
        // Thinking rides along for the probe (accepted/rejected).
        const resp = await chrome.runtime.sendMessage({ type: 'mt:test-llm', settings: s, thinking: pipeline.thinkingLevel, temperature: pipeline.temperature });
        if (resp?.ok) {
            setStatus(`Connected.${thinkingSuffix(pipeline.thinkingLevel, resp)}`, 'ok', 0, el);
        } else {
            setStatus(`Failed: ${String(resp?.error ?? 'unknown')}`, 'err', 0, el);
        }
    } catch (e) {
        setStatus(`Failed: ${(e as Error).message}`, 'err', 0, el);
    }
}

// shared Test-status tail for the thinking probe (main + OCR buttons)
function thinkingSuffix(level: string, resp: { thinking?: string; thinkingError?: string }): string {
    if (resp.thinking === 'accepted') return ` Thinking setting "${level}" accepted.`;
    if (resp.thinking === 'rejected') return ` Thinking setting "${level}" isn't supported. The model default will be used.`;
    if (resp.thinking === 'error') return ` Couldn't test the thinking setting: ${resp.thinkingError ?? 'unknown error'}`;
    return '';
}

export async function testOcr(): Promise<void> {
    const s = currentOcrSettings();
    const el = $('ocrTestStatus') as HTMLElement;
    if (!s.model || !s.apiKey) {
        setStatus('Enter a reader model ID and API key first.', 'err', 0, el);
        return;
    }
    setStatus('Reading the test image…', '', 0, el);
    const t0 = Date.now();
    // drifting models take a while — show the clock
    const tick = setInterval(() => setStatus(`Reading the test image… ${Math.round((Date.now() - t0) / 1000)}s`, '', 0, el), 1000);
    try {
        await requestHostAccess(hostOriginPatterns([baseUrlOf(s.baseUrl, s.provider)]));
        const imageB64 = await ocrTestImageB64();
        const resp = await chrome.runtime.sendMessage({ type: 'mt:test-ocr', settings: s, thinking: pipeline.ocrThinking, temperature: pipeline.ocrTemperature, imageB64, expect: OCR_TEST_EXPECT });
        const secs = ` · ${((Date.now() - t0) / 1000).toFixed(1)}s`;
        if (resp?.ok && resp.verdict === 'exact') {
            const cap = resp.multiImage === true ? ' · accepts multiple images'
                : resp.multiImage === false ? ' · will read one crop per request'
                : '';
            const tempNote = resp.tempDropped ? ' · using provider default temperature' : '';
            setStatus(`Test image read correctly${cap}${tempNote}${secs}`, 'ok', 0, el);
        } else if (resp?.ok) {
            setStatus((resp.verdict === 'miss'
                ? `No text recognized. Expected "${resp.expected}".`
                : `Mismatch — returned "${resp.got}" (expected "${resp.expected}")`) + secs, 'err', 0, el);
        } else {
            setStatus(`Failed: ${String(resp?.error ?? 'unknown')}`, 'err', 0, el);
        }
    } catch (e) {
        setStatus(`Failed: ${(e as Error).message}`, 'err', 0, el);
    } finally {
        clearInterval(tick);
    }
}

// fixed self-test crop (copied to dist by build.mjs) + its known transcription
const OCR_TEST_EXPECT = 'We thirst for the seven wailings. We bear the koan of Jericho.';

async function ocrTestImageB64(): Promise<string> {
    const blob = await (await fetch(chrome.runtime.getURL('options/ocr-test.png'))).blob();
    const dataUrl: string = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onerror = () => reject(fr.error ?? new Error('readAsDataURL failed'));
        fr.onload = () => resolve(fr.result as string);
        fr.readAsDataURL(blob);
    });
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

// ---- separate VLM reader: behavior knob (dirty-tracked, never Custom) ----
($('ocrSeparate') as HTMLInputElement).onchange = () => {
    pipeline.useOcrModel = ($('ocrSeparate') as HTMLInputElement).checked;
    syncOcrSeparateUI();
    setDirty(true);
};
for (const id of ['ocrModel', 'ocrApiKey', 'ocrBaseUrl'] as const) {
    ($<HTMLInputElement>(id)).oninput = markModelDirty;
}
($('ocrProvider') as HTMLSelectElement).onchange = () => { renderOcrThinkingList(); markModelDirty(); };
// OCR thinking: native datalist (free-text allowed); options follow the OCR provider
function renderOcrThinkingList(): void {
    const list = $<HTMLDataListElement>('ocrThinkingList');
    list.innerHTML = '';
    const provider = ($('ocrProvider') as HTMLSelectElement).value as keyof typeof THINKING_LEVELS;
    for (const v of THINKING_LEVELS[provider] ?? THINKING_LEVELS.openai) {
        const o = document.createElement('option');
        o.value = v;
        list.append(o);
    }
}
function syncOcrThinkingHint(): void {
    const v = ($('ocrThinking') as HTMLInputElement).value.trim().toLowerCase();
    ($('ocrThinkingHint') as HTMLElement).textContent =
        (THINKING_HINTS as Record<string, string>)[v]
        ?? (/^\d+$/.test(v)
            ? 'Maximum thinking tokens, if your provider supports a token limit.'
            : v
                ? 'Uses this value if supported. Otherwise, uses the model default.'
                : THINKING_HINTS.none);
}
($('ocrThinking') as HTMLInputElement).oninput = () => {
    pipeline.ocrThinking = ($('ocrThinking') as HTMLInputElement).value.trim() || 'none';
    syncOcrThinkingHint();
    setDirty(true);
};
$('ocrCopy').onclick = () => {
    const s = currentSettings();
    ($('ocrProvider') as HTMLSelectElement).value = s.provider;
    ($('ocrModel') as HTMLInputElement).value = s.model;
    ($('ocrApiKey') as HTMLInputElement).value = s.apiKey;
    ($('ocrBaseUrl') as HTMLInputElement).value = s.baseUrl ?? '';
    markModelDirty();
};

// first-run guidance: show the banner until a key exists
export function syncSetupBanner(): void {
    const hasKey = !!($('apiKey') as HTMLInputElement).value.trim();
    ($('setupBanner') as HTMLElement).style.display = hasKey ? 'none' : 'flex';
}
$('setupGo').onclick = () => {
    (document.querySelector('.tabs button[data-tab="model"]') as HTMLButtonElement).click();
    ($('apiKey') as HTMLInputElement).focus();
};
// note: credential inputs autosave via markModelDirty (wired at the bottom) — no separate oninput needed here.

// ---- inference engine: local vs cloud. Behavior knob — dirty-tracked but never marks Custom.
export function syncInferUI(): void {
    const cloud = pipeline.inferEngine === 'cloud';
    ($('layoutModel') as HTMLSelectElement).value = pipeline.layoutModel;
    $('layoutModelHint').textContent = pipeline.layoutModel === 'koharu'
        ? cloud ? 'Your server uses KoharuLayout to find text, sound effects, speech bubbles and panels.'
            : 'Finds text, sound effects, speech bubbles and panels.'
        : cloud ? 'Your server uses CTD to find text. Reading order follows text positions.' : 'CTD finds text. The panel model sets the reading order.';
    syncDetectionTuning();
    for (const b of document.querySelectorAll<HTMLButtonElement>('#inferSeg button')) {
        const on = (b.dataset.inferVal === 'cloud') === cloud;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    ($('cloudFields') as HTMLFieldSetElement).disabled = !cloud;
    $('cloudFields').style.display = cloud ? '' : 'none';
    $('detRow').style.display = cloud ? 'none' : 'block';
    $('detEpField').style.display = cloud ? 'none' : 'block';
    ($('forceWasm') as HTMLInputElement).checked = pipeline.detEp === 'wasm';
    if (!cloud) renderDetRow();
    syncAiCleanupUI();
}

// AI cleanup follows the engine (no separate picker): cloud auto, on-device opt-in + download.
// The download row shows only when actually needed.
export function syncAiCleanupUI(): void {
    const cb = $('aiCleanup') as HTMLInputElement;
    const hint = $('aiCleanupHint') as HTMLElement;
    const cloud = pipeline.inferEngine === 'cloud';
    cb.checked = inpaintMode(pipeline) !== 'fill';
    if (pipeline.inpaint === 'off') {
        hint.textContent = 'Uses basic cleanup to remove the original text.';
    } else if (cloud) {
        hint.textContent = 'Removes text on your detection server. No download needed on this device.';
    } else if (cb.checked) {
        hint.textContent = 'Runs on this device. Download the model below to use it.';
    } else {
        hint.textContent = 'Uses basic cleanup. Enable AI cleanup to fill in artwork behind the text.';
    }
    const showRow = !cloud && cb.checked;
    $('aiCleanupRow').style.display = showRow ? '' : 'none';
    if (showRow) void renderAiCleanupRow();
}

async function renderAiCleanupRow(): Promise<void> {
    const have = await inpaintInstalled().catch(() => false);
    ($('aiCleanupBtn') as HTMLButtonElement).textContent = have ? 'Delete' : 'Download';
    ($('aiCleanupLabel') as HTMLSpanElement).innerHTML =
        `Text cleanup model (112 MB)${have ? ' <span class="ok-mark">✓</span>' : ''}`;
}

$('aiCleanupBtn').onclick = async () => {
    const btn = $('aiCleanupBtn') as HTMLButtonElement;
    const bar = $('aiCleanupBar') as HTMLElement;
    const row = bar.parentElement!;
    btn.disabled = true;
    row.classList.add('busy');
    try {
        if (await inpaintInstalled()) await inpaintDelete();
        else {
            await inpaintDownload((loaded, total) => {
                (bar.parentElement!.querySelector('.dl-text') as HTMLElement).textContent = 'text cleanup model';
                dlProgress(bar, loaded, total);
            }, true);
        }
        await renderAiCleanupRow();
        row.classList.remove('busy');
    } catch (e) {
        (bar.parentElement!.querySelector('.dl-text') as HTMLElement).textContent = String((e as Error).message).slice(0, 60);
        // keep .busy so the error message stays visible
    } finally {
        btn.disabled = false;
    }
};

($('aiCleanup') as HTMLInputElement).onchange = () => {
    pipeline.inpaint = ($('aiCleanup') as HTMLInputElement).checked ? 'on' : 'off';
    syncAiCleanupUI();
    setDirty(true);
};

// Installed models use the same Delete → Download flow as OCR models.
async function renderDetRow(): Promise<void> {
    const selected = pipeline.layoutModel;
    $('layoutImportRow').hidden = selected !== 'koharu';
    if (selected === 'koharu') {
        const status = await koharuInstalled().catch(() => 'missing');
        if (pipeline.layoutModel !== selected) return;
        const installed = status === 'cached';
        ($('detBtn') as HTMLButtonElement).textContent = installed ? 'Delete' : 'Download';
        $('detLabel').textContent = `KoharuLayout (149.8 MB) · ${installed ? 'Ready' : 'Not installed'}`;
        return;
    }
    const det = await detModelsInstalled().catch(() => ({ ctd: false, panel: false }));
    if (pipeline.layoutModel !== selected) return;
    ($('detBtn') as HTMLButtonElement).textContent = det.ctd || det.panel ? 'Delete' : 'Download';
    ($('detLabel') as HTMLSpanElement).innerHTML =
        `CTD + Panel models (50 MB)${det.ctd && det.panel ? ' <span class="ok-mark">✓</span>' : ''}`;
}
$('detBtn').onclick = async () => {
    const selected = pipeline.layoutModel;
    const btn = $('detBtn') as HTMLButtonElement;
    const importBtn = $('layoutImportBtn') as HTMLButtonElement;
    const bar = $('detBar') as HTMLElement;
    const row = bar.parentElement!;
    btn.disabled = importBtn.disabled = true;
    $('layoutFileStatus').textContent = '';
    row.classList.add('busy');
    try {
        const progress = (file: string, loaded: number, total: number) => {
            (bar.parentElement!.querySelector('.dl-text') as HTMLElement).textContent = file.split('/').pop() ?? '';
            dlProgress(bar, loaded, total);
        };
        if (selected === 'koharu') {
            if (await koharuInstalled() === 'cached') await koharuDelete();
            else await koharuDownload((loaded, total) => progress('KoharuLayout', loaded, total), true);
        } else {
            const have = await detModelsInstalled();
            if (have.ctd || have.panel) await detDelete();
            else await detDownload(progress, true);
        }
        await renderDetRow();
        row.classList.remove('busy');
    } catch (e) {
        const message = String((e as Error).message);
        (bar.parentElement!.querySelector('.dl-text') as HTMLElement).textContent = message.slice(0, 60);
        if (selected === 'koharu' && pipeline.layoutModel === selected) $('layoutFileStatus').textContent = message;
        // keep .busy so the error message stays visible
    } finally {
        btn.disabled = importBtn.disabled = false;
    }
};

$('layoutImportBtn').onclick = () => ($('layoutFile') as HTMLInputElement).click();

($('layoutFile') as HTMLInputElement).onchange = async () => {
    const input = $('layoutFile') as HTMLInputElement, file = input.files?.[0];
    if (!file) return;
    const button = $('detBtn') as HTMLButtonElement, status = $('layoutFileStatus');
    const importButton = $('layoutImportBtn') as HTMLButtonElement;
    button.disabled = importButton.disabled = true; status.textContent = 'Checking model file…';
    try {
        if (file.size !== KOHARU_MODEL.bytes) throw new Error('Choose the KoharuLayout ONNX file (149.8 MB)');
        await importKoharuFile(await file.arrayBuffer());
        status.textContent = 'KoharuLayout is installed and ready.';
        await renderDetRow();
    } catch (e) { status.textContent = (e as Error).message; }
    finally { button.disabled = importButton.disabled = false; input.value = ''; }
};

($('layoutModel') as HTMLSelectElement).onchange = () => {
    pipeline.layoutModel = ($('layoutModel') as HTMLSelectElement).value === 'koharu' ? 'koharu' : 'ctd';
    $('layoutFileStatus').textContent = '';
    syncInferUI(); setDirty(true);
};
for (const id of ['preset', 'resetAdv']) $(id).addEventListener(id === 'preset' ? 'change' : 'click', () => {
    syncInferUI();
    syncThinkingUI();
    syncTemperatureUI();
    syncOcrTemperatureUI();
});

for (const b of document.querySelectorAll<HTMLButtonElement>('#inferSeg button')) {
    b.onclick = () => {
        const engine = b.dataset.inferVal === 'cloud' ? 'cloud' : 'local';
        pipeline.inferEngine = engine;
        syncInferUI();
        syncOcrManager();
        setDirty(true);
    };
}
// CTD execution provider — behavior knob (Auto = webgpu with wasm fallback; force-wasm = broken GPU drivers).
($('forceWasm') as HTMLInputElement).onchange = () => {
    pipeline.detEp = ($('forceWasm') as HTMLInputElement).checked ? 'wasm' : 'auto';
    syncInferUI();
    setDirty(true);
};
for (const id of ['cloudEndpoint', 'cloudKey'] as const) {
    ($<HTMLInputElement>(id)).oninput = markModelDirty;
}

export async function testCloud(): Promise<void> {
    const endpoint = ($('cloudEndpoint') as HTMLInputElement).value.trim().replace(/\/$/, '');
    const key = ($('cloudKey') as HTMLInputElement).value.trim();
    const el = $('cloudTestStatus') as HTMLElement;
    if (!endpoint || !key) {
        setStatus('Enter the endpoint URL and API key first.', 'err', 0, el);
        return;
    }
    setStatus('Connecting to the detection server… It may need time to wake up.', '', 0, el);
    try {
        const resp = await chrome.runtime.sendMessage({ type: 'mt:test-cloud', endpoint, key });
        if (resp?.ok) {
            setStatus(`Detection server ready · ${(resp.ms / 1000).toFixed(1)}s`, 'ok', 0, el);
        } else {
            setStatus(`Cloud failed: ${String(resp?.error ?? 'unknown')}`, 'err', 0, el);
        }
    } catch (e) {
        setStatus(`Cloud failed: ${(e as Error).message}`, 'err', 0, el);
    }
}

// ---- temperature: "Provider default" checkbox; touching slider/number drops out of auto.
// One implementation for main model and VLM reader; only the fallbacks differ (main 0.3, OCR 0).
function wireTemperature(autoId: string, sliderId: string, numId: string, key: 'temperature' | 'ocrTemperature', fallback: number): () => void {
    const sync = (): void => {
        const auto = pipeline[key] == null;
        const shown = auto ? fallback : pipeline[key];
        ($<HTMLInputElement>(autoId)).checked = auto;
        ($<HTMLInputElement>(sliderId)).value = String(shown);
        ($<HTMLInputElement>(numId)).value = String(shown);
        ($<HTMLInputElement>(sliderId)).classList.toggle('dim', auto);
        ($<HTMLInputElement>(numId)).classList.toggle('dim', auto);
    };
    ($<HTMLInputElement>(autoId)).onchange = () => {
        pipeline[key] = ($<HTMLInputElement>(autoId)).checked
            ? null
            : Number(($<HTMLInputElement>(sliderId)).value);
        sync();
        markModelDirty();
    };
    ($<HTMLInputElement>(sliderId)).oninput = () => {
        pipeline[key] = Number(($<HTMLInputElement>(sliderId)).value);
        sync();
        markModelDirty();
    };
    ($<HTMLInputElement>(numId)).onchange = () => {
        const raw = ($<HTMLInputElement>(numId)).value.trim();
        let v = raw === '' ? NaN : Number(raw);
        if (!Number.isFinite(v)) v = pipeline[key] ?? fallback; // garbage → revert
        else v = Math.min(1, Math.max(0, Math.round(v * 20) / 20)); // slider step 0.05
        pipeline[key] = v;
        sync();
        markModelDirty();
    };
    return sync;
}
const syncTemperatureUI = wireTemperature('temperatureAuto', 'temperature', 'temperatureNum', 'temperature', 0.3);
export const syncOcrTemperatureUI = wireTemperature('ocrTemperatureAuto', 'ocrTemperature', 'ocrTemperatureNum', 'ocrTemperature', 0);

// ---- thinking level: searchable combobox, presets per provider, free-text allowed ----
const thinkInput = $<HTMLInputElement>('thinking');
const thinkList = $<HTMLUListElement>('thinkingList');
let thinkItems: string[] = [];
let thinkActive = -1;

function thinkPresets(): string[] {
    const provider = ($('provider') as HTMLSelectElement).value as keyof typeof THINKING_LEVELS;
    return THINKING_LEVELS[provider] ?? THINKING_LEVELS.openai;
}

function syncThinkingHint(): void {
    const v = thinkInput.value.trim().toLowerCase();
    ($('thinkingHint') as HTMLElement).textContent =
        (THINKING_HINTS as Record<string, string>)[v]
        ?? (/^\d+$/.test(v)
            ? 'Maximum thinking tokens, if your provider supports a token limit.'
            : v
                ? 'Uses this value if supported. Otherwise, uses the model default.'
                : THINKING_HINTS.auto);
}

export function syncThinkingUI(): void {
    thinkInput.value = pipeline.thinkingLevel;
    syncThinkingHint();    closeThinkList();
}

function closeThinkList(): void {
    thinkList.hidden = true;
    thinkInput.setAttribute('aria-expanded', 'false');
    thinkInput.removeAttribute('aria-activedescendant');
    thinkActive = -1;
}

function renderThinkList(): void {
    thinkList.innerHTML = '';
    const cur = thinkInput.value.trim().toLowerCase();
    thinkItems.forEach((v, i) => {
        const li = document.createElement('li');
        li.id = `tthink-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(cur === v));
        if (i === thinkActive) li.classList.add('active');
        li.textContent = v;
        li.onmousedown = (e) => {
            e.preventDefault();
            thinkInput.value = v;
            pipeline.thinkingLevel = v;
            syncThinkingHint();
            closeThinkList();
            setDirty(true);
        };
        thinkList.append(li);
    });
    const open = thinkItems.length > 0;
    thinkList.hidden = !open;
    thinkInput.setAttribute('aria-expanded', String(open));
    if (thinkActive >= 0) thinkInput.setAttribute('aria-activedescendant', `tthink-${thinkActive}`);
    else thinkInput.removeAttribute('aria-activedescendant');
    thinkList.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function openThinkList(all: boolean): void {
    const q = all ? '' : thinkInput.value.trim().toLowerCase();
    thinkItems = thinkPresets().filter(v => !q || v.includes(q));
    thinkActive = -1;
    renderThinkList();
}

thinkInput.oninput = () => {
    pipeline.thinkingLevel = thinkInput.value.trim() || 'auto';
    syncThinkingHint();
    openThinkList(false);
    setDirty(true);
};
thinkInput.onfocus = () => openThinkList(true); // full list first — typing narrows it
thinkInput.onkeydown = (e) => {
    if (thinkList.hidden && (e.key === 'ArrowDown' || e.key === 'Enter')) { openThinkList(false); e.preventDefault(); return; }
    if (thinkList.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        thinkActive = (thinkActive + (e.key === 'ArrowDown' ? 1 : -1) + thinkItems.length) % thinkItems.length;
        renderThinkList();
    } else if (e.key === 'Enter') {
        if (thinkActive >= 0) {
            e.preventDefault();
            thinkInput.value = thinkItems[thinkActive];
            pipeline.thinkingLevel = thinkItems[thinkActive];
            syncThinkingHint();
            closeThinkList();
            setDirty(true);
        } else closeThinkList(); // free-text stays as typed
    } else if (e.key === 'Escape') closeThinkList();
};
thinkInput.onblur = () => closeThinkList();
($('thinkingToggle') as HTMLButtonElement).onclick = () => {
    if (!thinkList.hidden) { closeThinkList(); return; }
    thinkInput.focus();
    openThinkList(true);
};
document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.combo')) closeThinkList();
});
