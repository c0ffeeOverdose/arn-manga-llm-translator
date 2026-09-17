// Pipeline tab: presets, advanced sliders/toggles, tone, target language,
// OCR model manager, translation cache row.

import { applyPreset, filterTargetLangs, matchingPreset, mergePipeline, type PipelineSettings } from '../llm/pipeline-settings';
import { OCR_LANGUAGES, ocrInstalled, ocrDownload, ocrDelete, baberuInstalled, baberuDownload, baberuDelete } from '../llm/ocr-models';
import { $, setDirty, dlProgress } from './shell';

// ---- shared pipeline state (the options page's working copy) ----
export let pipeline: PipelineSettings = applyPreset('balanced');
export let presetsPristine = true; // false once user edits advanced fields → show Custom

export function loadStoredPipeline(stored: PipelineSettings | undefined): void {
    pipeline = stored
        ? { ...applyPreset('balanced'), ...stored }
        : applyPreset('balanced');
    presetsPristine = stored == null;
}

export function savePipeline(): void {
    chrome.storage.local.get('mtPipeline')
        .then(({ mtPipeline: stored }) => {
            Object.assign(pipeline, mergePipeline(stored, pipeline));
            return chrome.storage.local.set({ mtPipeline: pipeline });
        })
        .catch(() => {});
}

export function markCustom(): void {
    presetsPristine = false;
    ($('preset') as HTMLSelectElement).value = 'custom';
    setDirty(true);
}

// ---- presets + advanced ----

function syncRange(id: string, key: string): void {
    ($<HTMLInputElement>(id)).value = String((pipeline as any)[key]);
    ($<HTMLInputElement>(id + 'Num')).value = String((pipeline as any)[key]);
}

// text/outline color controls: Auto checkbox wins, picker holds the manual
// value. The picker is NEVER disabled — touching it drops out of auto
// (a disabled color input eats all clicks, which reads as "broken").
function syncColorUI(): void {
    for (const [auto, pick, key, fallback] of [
        ['textColorAuto', 'textColorPick', 'textColor', '#111111'],
        ['strokeColorAuto', 'strokeColorPick', 'strokeColor', '#ffffff'],
    ] as const) {
        const isAuto = (pipeline as any)[key] === 'auto';
        ($<HTMLInputElement>(auto)).checked = isAuto;
        if (isAuto) ($<HTMLInputElement>(pick)).value = fallback;
        else ($<HTMLInputElement>(pick)).value = (pipeline as any)[key];
    }
}

export function syncAdvancedUI(): void {
    ($('preset') as HTMLSelectElement).value = presetsPristine ? matchingPreset(pipeline) : 'custom';
    for (const id of ['detConf', 'detMinSize', 'panelConf', 'cropSize', 'fullPageSize', 'contextPairs', 'parallelLlm', 'minFont', 'textScale', 'cacheMax']) syncRange(id, id);
    syncColorUI();
    ($('deferLabels') as HTMLInputElement).checked = pipeline.deferLabels;
    ($('vlmAssisted') as HTMLInputElement).checked = pipeline.vlmAssistedDetection;
    ($('useContext') as HTMLInputElement).checked = pipeline.useContext;
    ($('useCharacters') as HTMLInputElement).checked = pipeline.useCharacters;
    ($('crossChapter') as HTMLInputElement).checked = pipeline.crossChapter;
    ($('grayscaleBw') as HTMLInputElement).checked = pipeline.grayscaleBw;
    ($('cacheEnabled') as HTMLInputElement).checked = pipeline.cacheEnabled;
    ($('showToasts') as HTMLInputElement).checked = pipeline.showToasts;
    ($('stylePrompt') as HTMLTextAreaElement).value = pipeline.stylePrompt;
    syncToneUI();
    ($('targetLang') as HTMLInputElement).value = pipeline.targetLang;
    ($('textSource') as HTMLSelectElement).value = pipeline.textSource;
    ($('readingDir') as HTMLSelectElement).value = pipeline.readingDir;
    ($('transcribeSrc') as HTMLInputElement).checked = pipeline.transcribeSrc === true;
    syncOcrManager();
    syncOcrSeparateUI();
}
($<HTMLSelectElement>('textSource')).onchange = () => {
    pipeline.textSource = ($<HTMLSelectElement>('textSource')).value as 'page' | 'crops' | 'ocr';
    syncOcrManager();
    syncOcrSeparateUI();
    markCustom();
};
($<HTMLSelectElement>('readingDir')).onchange = () => {
    pipeline.readingDir = ($<HTMLSelectElement>('readingDir')).value as 'rtl' | 'ltr';
    markCustom();
};
($<HTMLInputElement>('transcribeSrc')).onchange = () => {
    pipeline.transcribeSrc = ($<HTMLInputElement>('transcribeSrc')).checked;
    markCustom();
};

($<HTMLInputElement>('ocrPerRegion')).onchange = () => {
    pipeline.ocrPerRegion = ($<HTMLInputElement>('ocrPerRegion')).checked;
    markCustom();
};

// ---- separate VLM reader: checkbox always visible, creds only when it can
// run (vision modes — local-OCR mode never sends images anywhere)
export function syncOcrSeparateUI(): void {
    ($('ocrSeparate') as HTMLInputElement).checked = pipeline.useOcrModel;
    ($('ocrPerRegion') as HTMLInputElement).checked = pipeline.ocrPerRegion;
    $('ocrSeparateFields').style.display = pipeline.useOcrModel && pipeline.textSource !== 'ocr' ? '' : 'none';
}

// ---- OCR model manager: download/delete per language, with progress ----

export function syncOcrManager(): void {
    const manager = $('ocrManager');
    // cloud engine ships its own OCR — local model downloads are meaningless there
    const show = pipeline.textSource === 'ocr' && pipeline.inferEngine === 'local';
    manager.style.display = show ? 'block' : 'none';
    if (!show) return;
    syncOcrEngineUI();
    renderOcrLangs();
}

function syncOcrEngineUI(): void {
    ($('ocrEngine') as HTMLSelectElement).value = pipeline.ocrEngine;
    $('ocrLangList').style.display = pipeline.ocrEngine === 'tesseract' ? 'flex' : 'none';
    $('baberuRow').style.display = pipeline.ocrEngine === 'baberu' ? 'block' : 'none';
    renderBaberuRow();
}

async function renderBaberuRow(): Promise<void> {
    const installed = await baberuInstalled();
    ($('baberuLabel') as HTMLSpanElement).innerHTML =
        `Baberu OCR model${installed ? ' <span class="ok-mark">✓</span>' : ''}`;
    ($('baberuBtn') as HTMLButtonElement).textContent = installed ? 'Delete' : 'Download';
}

$('baberuBtn').onclick = async () => {
    const btn = $('baberuBtn') as HTMLButtonElement;
    const bar = $('baberuBar') as HTMLElement;
    const row = bar.parentElement!;
    btn.disabled = true;
    row.classList.add('busy');
    try {
        if (await baberuInstalled()) {
            await baberuDelete();
        } else {
            btn.textContent = '…';
            await baberuDownload((file, loaded, total) => {
                (bar.parentElement!.querySelector('.dl-text') as HTMLElement).textContent = file.split('/').pop() ?? '';
                dlProgress(bar, loaded, total);
            });
        }
        await renderBaberuRow();
        row.classList.remove('busy');
    } catch (e) {
        (bar.parentElement!.querySelector('.dl-text') as HTMLElement).textContent = String((e as Error).message).slice(0, 60);
        // keep .busy so the error message stays visible
    } finally {
        btn.disabled = false;
    }
};

($<HTMLSelectElement>('ocrEngine')).onchange = () => {
    pipeline.ocrEngine = ($<HTMLSelectElement>('ocrEngine')).value as 'tesseract' | 'baberu';
    syncOcrEngineUI();
    markCustom();
};

async function renderOcrLangs(): Promise<void> {
    const list = $('ocrLangList');
    const installed = new Set(await ocrInstalled());
    list.innerHTML = '';
    for (const { code, label } of OCR_LANGUAGES) {
        const row = document.createElement('div');
        row.className = 'dl-row';
        const use = document.createElement('input');
        use.type = 'checkbox';
        use.checked = pipeline.ocrLangs.includes(code);
        use.onchange = () => {
            pipeline.ocrLangs = use.checked
                ? [...pipeline.ocrLangs, code]
                : pipeline.ocrLangs.filter(l => l !== code);
            markCustom();
        };
        const name = document.createElement('span');
        name.className = 'name';
        name.innerHTML = label + (installed.has(code) ? ' <span class="ok-mark">✓</span>' : '');
        const bar = document.createElement('span');
        bar.className = 'dl-bar';
        const fill = document.createElement('span');
        fill.className = 'fill';
        bar.append(fill);
        const txt = document.createElement('span');
        txt.className = 'dl-text';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn ghost sm';
        btn.textContent = installed.has(code) ? 'Delete' : 'Download';
        btn.onclick = async () => {
            btn.disabled = true;
            row.classList.add('busy');
            try {
                if (installed.has(code)) {
                    await ocrDelete(code);
                } else {
                    btn.textContent = '…';
                    await ocrDownload(code, (loaded, total) => {
                        txt.textContent = total ? `${(loaded / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)}MB` : `${(loaded / 1e6).toFixed(1)}MB`;
                        if (total) fill.style.width = `${Math.min(100, loaded / total * 100)}%`;
                        else fill.classList.add('indet');
                    });
                }
                renderOcrLangs();
            } catch (e) {
                txt.textContent = String((e as Error).message).slice(0, 60);
                btn.disabled = false;
                // keep .busy so the error message stays visible
            }
        };
        row.append(use, name, txt, bar, btn);
        list.append(row);
    }
}

($('preset') as HTMLSelectElement).onchange = () => {
    const v = ($('preset') as HTMLSelectElement).value;
    if (v === 'custom') return; // selected by editing advanced fields
    pipeline = applyPreset(v);
    presetsPristine = true;
    syncAdvancedUI();
    setDirty(true);
};

// one slider + exact number input per row (min/max/step live on the slider).
// The slider snaps to its steps; the number holds the exact value; garbage
// reverts to the stored value. Nothing persists until Save Changes.
function wireRange(id: string, key: string, abs?: { min?: number; max?: number }): void {
    const slider = $<HTMLInputElement>(id);
    const num = $<HTMLInputElement>(id + 'Num');
    slider.oninput = () => {
        (pipeline as any)[key] = Number(slider.value);
        num.value = String((pipeline as any)[key]);
        markCustom();
    };
    num.onchange = () => {
        const step = Number(slider.step || 1);
        const dec = (String(slider.step).split('.')[1] ?? '').length;
        // type=number sanitizes garbage to '' (Number('') is 0 — not a revert)
        let v = num.value.trim() === '' ? NaN : Number(num.value);
        if (!Number.isFinite(v)) v = (pipeline as any)[key]; // garbage → revert
        else {
            v = step >= 1 ? Math.round(v) : Math.round(v * 10 ** dec) / 10 ** dec;
            // the number box may exceed the slider bounds (try 6px fonts) — clamp
            // to absolute limits instead (slider just pins at its edge visually)
            const lo = abs?.min ?? Number(slider.min), hi = abs?.max ?? Number(slider.max);
            v = Math.min(hi, Math.max(lo, v));
        }
        (pipeline as any)[key] = v;
        num.value = String(v);
        slider.value = String(v);
        markCustom();
    };
}
// abs = hard limits for the number box (slider pins at its own edge
// visually — the browser clamps range inputs on assignment). Values beyond
// the slider are real: the pipeline uses them verbatim, so caps here are
// physical/sanity bounds, not the slider's comfort range.
const RANGE_ABS: Record<string, { min?: number; max?: number }> = {
    detConf: { min: 0, max: 1 },
    detMinSize: { min: 1, max: 200 },
    panelConf: { min: 0.05, max: 1 },
    cropSize: { min: 100, max: 1200 },
    fullPageSize: { min: 400, max: 2560 },
    contextPairs: { min: 0, max: 200 },
    parallelLlm: { min: 1, max: 10 },
    minFont: { min: 1, max: 72 },
    textScale: { min: 0.6, max: 1.6 },
    textStroke: { min: 0, max: 0.5 },
    cacheMax: { min: 10, max: 2000 },
};
for (const id of Object.keys(RANGE_ABS)) wireRange(id, id, RANGE_ABS[id]);
for (const [auto, pick, key] of [['textColorAuto', 'textColorPick', 'textColor'], ['strokeColorAuto', 'strokeColorPick', 'strokeColor']] as const) {
    ($<HTMLInputElement>(auto)).onchange = () => {
        (pipeline as any)[key] = ($<HTMLInputElement>(auto)).checked ? 'auto' : ($<HTMLInputElement>(pick)).value;
        syncColorUI();
        markCustom();
    };
    ($<HTMLInputElement>(pick)).oninput = () => {
        (pipeline as any)[key] = ($<HTMLInputElement>(pick)).value;
        ($<HTMLInputElement>(auto)).checked = false;
        syncColorUI();
        markCustom();
    };
    // picking the same color fires no input event — a click alone still
    // means "go manual" so the swatch never feels dead
    ($<HTMLInputElement>(pick)).onclick = () => {
        if ((pipeline as any)[key] === 'auto') {
            (pipeline as any)[key] = ($<HTMLInputElement>(pick)).value;
            syncColorUI();
            markCustom();
        }
    };
}
($<HTMLInputElement>('vlmAssisted')).onchange = () => {
    pipeline.vlmAssistedDetection = ($<HTMLInputElement>('vlmAssisted')).checked;
    markCustom();
};
($<HTMLInputElement>('deferLabels')).onchange = () => {
    pipeline.deferLabels = ($<HTMLInputElement>('deferLabels')).checked;
    markCustom();
};
// outside the dirty model (like the theme): content scripts pick it up live
($<HTMLInputElement>('debugBoxes')).onchange = () => {
    chrome.storage.local.set({ mtDebug: ($<HTMLInputElement>('debugBoxes')).checked });
};
($<HTMLInputElement>('useContext')).onchange = () => {
    pipeline.useContext = ($<HTMLInputElement>('useContext')).checked;
    markCustom();
};
($<HTMLInputElement>('useCharacters')).onchange = () => {
    pipeline.useCharacters = ($<HTMLInputElement>('useCharacters')).checked;
    markCustom();
};
($<HTMLInputElement>('showToasts')).onchange = () => {
    pipeline.showToasts = ($<HTMLInputElement>('showToasts')).checked;
    markCustom();
};
($<HTMLInputElement>('crossChapter')).onchange = () => {
    pipeline.crossChapter = ($<HTMLInputElement>('crossChapter')).checked;
    markCustom();
};
($<HTMLInputElement>('grayscaleBw')).onchange = () => {
    pipeline.grayscaleBw = ($<HTMLInputElement>('grayscaleBw')).checked;
    markCustom();
};
($<HTMLInputElement>('cacheEnabled')).onchange = () => {
    pipeline.cacheEnabled = ($<HTMLInputElement>('cacheEnabled')).checked;
    markCustom();
};
// Tone = one select + a textarea that only appears for "Custom…".
// The select reflects the stored prompt when it matches a preset exactly.
function syncToneUI(): void {
    const sel = $<HTMLSelectElement>('stylePreset');
    const box = $<HTMLTextAreaElement>('stylePrompt');
    const match = [...sel.options].find(o => o.value && o.value !== '__custom' && o.value === box.value);
    sel.value = match ? (match as HTMLOptionElement).value
        : box.value ? '__custom' : '';
    box.style.display = sel.value === '__custom' ? 'block' : 'none';
}
($<HTMLSelectElement>('stylePreset')).onchange = () => {
    const sel = $<HTMLSelectElement>('stylePreset');
    const box = $<HTMLTextAreaElement>('stylePrompt');
    if (sel.value === '__custom') {
        box.style.display = 'block';
        box.focus();
    } else {
        box.value = sel.value;
        pipeline.stylePrompt = sel.value;
        box.style.display = 'none';
    }
    markCustom();
};
($<HTMLTextAreaElement>('stylePrompt')).oninput = () => {
    pipeline.stylePrompt = ($<HTMLTextAreaElement>('stylePrompt')).value;
    markCustom();
};
// ---- target language: searchable combobox, free-text still allowed ----
const targetInput = $<HTMLInputElement>('targetLang');
const targetList = $<HTMLUListElement>('targetLangList');
let targetItems = filterTargetLangs('');
let targetActive = -1;

function closeTargetList(): void {
    targetList.hidden = true;
    targetInput.setAttribute('aria-expanded', 'false');
    targetInput.removeAttribute('aria-activedescendant');
    targetActive = -1;
}

function renderTargetList(): void {
    targetList.innerHTML = '';
    targetItems.forEach((l, i) => {
        const li = document.createElement('li');
        li.id = `tlang-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(targetInput.value.trim() === l.en));
        if (i === targetActive) li.classList.add('active');
        const en = document.createElement('span');
        en.textContent = l.en;
        li.append(en);
        if (l.native) {
            const nat = document.createElement('span');
            nat.className = 'native';
            nat.textContent = l.native;
            li.append(nat);
        }
        // mousedown fires before input blur → selection survives the outside-click close
        li.onmousedown = (e) => {
            e.preventDefault();
            targetInput.value = l.en;
            pipeline.targetLang = l.en;
            markCustom();
            closeTargetList();
        };
        targetList.append(li);
    });
    const open = targetItems.length > 0;
    targetList.hidden = !open;
    targetInput.setAttribute('aria-expanded', String(open));
    if (targetActive >= 0) targetInput.setAttribute('aria-activedescendant', `tlang-${targetActive}`);
    else targetInput.removeAttribute('aria-activedescendant');
    targetList.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function openTargetList(all: boolean): void {
    targetItems = filterTargetLangs(all ? '' : targetInput.value);
    targetActive = -1;
    renderTargetList();
}

targetInput.oninput = () => {
    pipeline.targetLang = targetInput.value.trim() || 'Thai';
    markCustom();
    openTargetList(false);
};
targetInput.onfocus = () => openTargetList(true); // full list first — typing narrows it
targetInput.onkeydown = (e) => {
    if (targetList.hidden && (e.key === 'ArrowDown' || e.key === 'Enter')) { openTargetList(false); e.preventDefault(); return; }
    if (targetList.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        targetActive = (targetActive + (e.key === 'ArrowDown' ? 1 : -1) + targetItems.length) % targetItems.length;
        renderTargetList();
    } else if (e.key === 'Enter') {
        if (targetActive >= 0) {
            e.preventDefault();
            targetInput.value = targetItems[targetActive].en;
            pipeline.targetLang = targetItems[targetActive].en;
            markCustom();
            closeTargetList();
        } else closeTargetList(); // free-text stays as typed
    } else if (e.key === 'Escape') closeTargetList();
};
targetInput.onblur = () => closeTargetList();
($('targetLangToggle') as HTMLButtonElement).onclick = () => {
    if (!targetList.hidden) { closeTargetList(); return; }
    targetInput.focus();
    openTargetList(true);
};
document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.combo')) closeTargetList();
});

($('resetAdv') as HTMLButtonElement).onclick = () => {
    if (!confirm('Restore default tuning? Your custom values will be lost.')) return;
    pipeline = applyPreset('balanced');
    presetsPristine = true;
    syncAdvancedUI();
    setDirty(true);
};

// translation cache lives in the manga tab's content script (per-site IDB) —
// the options page just forwards. No manga tab open → count stays '…' and
// Clear explains itself instead of failing silently.
async function mangaTab(): Promise<number | null> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const t = tabs[0];
    // url may be hidden without activeTab grant — try the send anyway, the
    // content script's reply (or lack of it) is the real test.
    if (!t?.id || (t.url && !/^(https?|blob):/.test(t.url))) return null;
    return t.id;
}
async function refreshCacheCount(): Promise<void> {
    const el = $('cacheCount') as HTMLElement;
    const row = $('cacheCountRow') as HTMLElement;
    const id = await mangaTab();
    const resp = id ? await chrome.tabs.sendMessage(id, { type: 'mt:cache-count' }).catch(() => null) : null;
    // no manga tab (or unreachable) → hide the row instead of showing an
    // error as if it were a count — the options page is often opened standalone
    if (!resp?.ok) { row.style.display = 'none'; return; }
    row.style.display = '';
    el.textContent = `${resp.mine ?? resp.count} here · ${resp.count} total`;
}
($('cacheClear') as HTMLButtonElement).onclick = async () => {
    const id = await mangaTab();
    if (!id) { alert('Open a manga page first — the cache lives with the site.'); return; }
    const btn = $('cacheClear') as HTMLButtonElement;
    btn.textContent = 'Clearing…';
    const resp = await chrome.tabs.sendMessage(id, { type: 'mt:cache-clear' }).catch(() => null);
    btn.textContent = 'Clear translation cache';
    if (resp?.ok) ($('cacheCount') as HTMLElement).textContent = `${resp.mine ?? resp.count} here · ${resp.count} total`;
};
refreshCacheCount();
