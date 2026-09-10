// Model tab: provider credentials, test connection, thinking level, inference
// engine (local vs cloud), detection pre-download.

import { DEFAULT_BASES, DEFAULT_SETTINGS, THINKING_HINTS, THINKING_LEVELS, type LLMSettings } from '../llm/adapters';
import { mergePipeline, type PipelineSettings } from '../llm/pipeline-settings';
import { detModelsInstalled, detDownload } from '../llm/ocr-models';
import { $, setDirty, setStatus, dlProgress } from './shell';
import { pipeline, syncOcrManager } from './pipeline-section';

const MODEL_HINTS: Record<string, string> = {
    openai: 'e.g. gpt-5.4-mini, gpt-5.4-nano — or qwen/qwen3.7-flash, z-ai/glm-5.3-flash via OpenRouter (vision needs image support; OCR mode takes any text model)',
    responses: 'e.g. gpt-5.6-luna, muse-spark-1.3 (cheap + vision)',
    anthropic: 'e.g. claude-haiku-4-5, claude-sonnet-5',
    gemini: 'e.g. gemini-3.5-flash-lite, gemini-3.8-flash',
};

// model input placeholder follows the selected protocol (static HTML keeps
// the openai default for first paint before this runs)
const MODEL_PLACEHOLDERS: Record<string, string> = {
    openai: 'e.g. gpt-5.4-mini',
    responses: 'e.g. gpt-5.6-luna',
    anthropic: 'e.g. claude-haiku-4-5',
    gemini: 'e.g. gemini-3.5-flash-lite',
};

// per-provider Base URL examples (defaults live in DEFAULT_BASES)
const BASE_HINTS: Record<string, string> = {
    openai: ' · OpenRouter: https://openrouter.ai/api/v1 · ollama: http://localhost:11434/v1',
    responses: ' · OpenCode Go: https://opencode.ai/zen/go/v1 (use a /responses model, e.g. gpt-5.6-luna)',
    anthropic: '',
    gemini: '',
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

export function updateHints() {
    const provider = ($('provider') as HTMLSelectElement).value;
    ($('modelHint') as HTMLDivElement).textContent = MODEL_HINTS[provider] ?? '';
    ($('model') as HTMLInputElement).placeholder = MODEL_PLACEHOLDERS[provider] ?? '';
    ($('baseHint') as HTMLDivElement).textContent = `Default: ${DEFAULT_BASES[provider as keyof typeof DEFAULT_BASES]}${BASE_HINTS[provider] ?? ''}`;
}

async function ensureHostPermission(baseUrl: string, provider: string): Promise<void> {
    const url = baseUrl || DEFAULT_BASES[provider as keyof typeof DEFAULT_BASES];
    let origin: string;
    try { origin = new URL(url).origin + '/*'; } catch { return; }
    let has = false;
    try {
        has = await chrome.permissions.contains({ origins: [origin] });
    } catch { /* pattern with port etc. — try the request below, it reports */ }
    if (has) return;
    try {
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) throw new Error('permission denied');
    } catch (e) {
        throw new Error(`Needs access to ${origin} — approve the browser prompt (${(e as Error).message})`);
    }
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
        setStatus('Enter a model and API key first.', 'err');
        return;
    }
    try {
        await ensureHostPermission(s.baseUrl ?? '', s.provider);
    } catch (e) {
        setStatus(`Not saved — ${(e as Error).message}`, 'err');
        return;
    }
    // merge over fresh storage: keys owned by other surfaces (popup's
    // prefetchN) changed since this page loaded — a blind full-object write
    // would silently revert them
    const { mtPipeline: stored } = await chrome.storage.local.get('mtPipeline');
    Object.assign(pipeline, mergePipeline(stored, pipeline));
    await chrome.storage.local.set({ mtSettings: s, mtPipeline: pipeline });
    setDirty(false);
    setStatus('Saved ✓', 'ok', 2000);
    syncSetupBanner();
}

export async function discardAll(fill: (s: LLMSettings) => void, syncAdvancedUI: () => void): Promise<void> {
    const { mtSettings, mtPipeline } = await chrome.storage.local.get(['mtSettings', 'mtPipeline']);
    void mtPipeline; // pipeline reload is the caller's business (pipeline-section)
    fill({ ...DEFAULT_SETTINGS, ...(mtSettings ?? {}) } as LLMSettings);
    syncAdvancedUI();
    updateHints();
    syncSetupBanner();
    setDirty(false);
}

export async function testConnection(): Promise<void> {
    const s = currentSettings();
    const el = $('testStatus') as HTMLElement;
    if (!s.model || !s.apiKey) {
        setStatus('Enter a model and API key first.', 'err', 0, el);
        return;
    }
    setStatus('Testing…', '', 0, el);
    try {
        await ensureHostPermission(s.baseUrl ?? "", s.provider);
        // text-only connectivity check (key + model + reachability) — image
        // support is detected at translation time instead, where the error
        // carries a "switch to Local OCR" hint.
        const resp = await chrome.runtime.sendMessage({ type: 'mt:test-llm', settings: s });
        if (resp?.ok) {
            setStatus(`OK — ${resp.reply}`, 'ok', 0, el);
        } else {
            setStatus(`Failed: ${String(resp?.error ?? 'unknown')}`, 'err', 0, el);
        }
    } catch (e) {
        setStatus(`Failed: ${(e as Error).message}`, 'err', 0, el);
    }
}

// first-run guidance: show the banner until a key exists
export function syncSetupBanner(): void {
    const hasKey = !!($('apiKey') as HTMLInputElement).value.trim();
    ($('setupBanner') as HTMLElement).style.display = hasKey ? 'none' : 'flex';
}
$('setupGo').onclick = () => {
    (document.querySelector('.tabs button[data-tab="model"]') as HTMLButtonElement).click();
    ($('apiKey') as HTMLInputElement).focus();
};
// note: apiKey/model/baseUrl/provider inputs autosave via markModelDirty (wired at the bottom),
// which also calls syncSetupBanner — no separate oninput needed here.

// ---- inference engine: local vs cloud (your Modal endpoint). Behavior
// knob like prefetchN — dirty-tracked but never marks the preset Custom.
export function syncInferUI(): void {
    const cloud = pipeline.inferEngine === 'cloud';
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
}

// pre-download so the first on-device page doesn't pay it mid-chapter.
// Download-only (no Delete — deleting would just break the next translate).
async function renderDetRow(): Promise<void> {
    const det = await detModelsInstalled().catch(() => ({ ctd: false, panel: false }));
    ($('detLabel') as HTMLSpanElement).innerHTML =
        `Detection models (CTD 40MB + panel 10MB)${det.ctd && det.panel ? ' <span class="ok-mark">✓</span>' : ''}`;
}
$('detBtn').onclick = async () => {
    const btn = $('detBtn') as HTMLButtonElement;
    const bar = $('detBar') as HTMLElement;
    const row = bar.parentElement!;
    btn.disabled = true;
    row.classList.add('busy');
    try {
        await detDownload((file, loaded, total) => {
            (bar.parentElement!.querySelector('.dl-text') as HTMLElement).textContent = file.split('/').pop() ?? '';
            dlProgress(bar, loaded, total);
        });
        await renderDetRow();
        row.classList.remove('busy');
    } catch (e) {
        (bar.parentElement!.querySelector('.dl-text') as HTMLElement).textContent = String((e as Error).message).slice(0, 60);
        // keep .busy so the error message stays visible
    } finally {
        btn.disabled = false;
    }
};

for (const b of document.querySelectorAll<HTMLButtonElement>('#inferSeg button')) {
    b.onclick = () => {
        pipeline.inferEngine = (b.dataset.inferVal === 'cloud' ? 'cloud' : 'local') as 'local' | 'cloud';
        syncInferUI();
        syncOcrManager();
        setDirty(true);
    };
}
// CTD execution provider — behavior knob (Auto = webgpu with wasm fallback,
// force-wasm = broken GPU drivers). Same dirty-track-not-preset pattern.
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
    setStatus('Testing cloud… (first call can take a minute to wake it)', '', 0, el);
    try {
        const resp = await chrome.runtime.sendMessage({ type: 'mt:test-cloud', endpoint, key });
        if (resp?.ok) {
            setStatus(`Cloud OK — ${(resp.ms / 1000).toFixed(1)}s (warmed up, ready to read)`, 'ok', 0, el);
        } else {
            setStatus(`Cloud failed: ${String(resp?.error ?? 'unknown')}`, 'err', 0, el);
        }
    } catch (e) {
        setStatus(`Cloud failed: ${(e as Error).message}`, 'err', 0, el);
    }
}

// ---- thinking level: searchable combobox, presets depend on provider, free-text allowed ----
// ponytail: same .combo pattern as targetLang, duplicated —
// extract a shared helper if a third combo appears
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
            ? 'Custom token budget — sent as thinkingBudget/budget_tokens where supported.'
            : v
                ? 'Custom value — sent as-is; rejected values fall back to the model default.'
                : THINKING_HINTS.auto);
}

export function syncThinkingUI(): void {
    thinkInput.value = pipeline.thinkingLevel;
    syncThinkingHint();
    closeThinkList();
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
