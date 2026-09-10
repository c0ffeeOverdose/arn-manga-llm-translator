// Characters tab + auto-translate sites + font manager + diagnostics.

import { autoSiteList, autoSiteRemove } from '../llm/pipeline-settings';
import { sessGet, sessRemove } from '../storage-session';
import { baberuInstalled, ocrInstalled, detModelsInstalled } from '../llm/ocr-models';
import { FONT_PRESETS, fontList, fontDownload, fontDelete, fontAddCustom, fontName, fontIdFromUrl, fontRead } from '../llm/font-store';
import { $ } from './shell';
import { pipeline, markCustom, savePipeline } from './pipeline-section';

interface CharOverride { gender: 'M' | 'F' | '?'; name?: string }
const mtCharOverridesKey = 'mtCharOverrides';

// ---- characters ----

async function getBook(): Promise<{ desc: string; gender: string; source: string; name?: string; fullName?: string }[]> {
    const { mtCharBook } = await chrome.storage.local.get('mtCharBook');
    return (mtCharBook as { desc: string; gender: string; source: string; name?: string }[]) ?? [];
}
async function getOverrides(): Promise<Record<string, CharOverride>> {
    const { mtCharOverrides } = await chrome.storage.local.get(mtCharOverridesKey);
    return (mtCharOverrides as Record<string, CharOverride>) ?? {};
}

export async function renderCharacters(overrides: Record<string, CharOverride>): Promise<void> {
    const book = await getBook();
    const box = $('characters');
    box.innerHTML = '';
    if (!book.length) {
        box.innerHTML = '<div class="empty">No characters yet — translate some pages first.</div>';
        return;
    }
    for (const c of book) {
        const row = document.createElement('div');
        row.className = 'char-row';
        const desc = document.createElement('div');
        desc.className = 'desc';
        const label = c.fullName && c.fullName !== c.name ? (c.name ? `${c.name} (${c.fullName})` : c.fullName) : c.name;
        desc.textContent = (label ? `${label}: ` : '') + c.desc;
        const src = document.createElement('div');
        src.className = 'src';
        src.textContent = `learned via ${c.source}`;
        desc.append(src);
        const ov = overrides[c.desc];

        const name = document.createElement('input');
        name.type = 'text';
        name.placeholder = 'name (optional)';
        name.value = (ov?.name ?? c.name) ?? '';
        const sel = document.createElement('select');
        for (const [v, label] of [['?', 'unknown'], ['F', 'female'], ['M', 'male']] as const) {
            const o = document.createElement('option');
            o.value = v; o.textContent = label;
            sel.append(o);
        }
        sel.value = ov ? ov.gender : c.gender;
        const saveRow = async () => {
            const all = await getOverrides();
            const n = name.value.trim();
            const g = sel.value;
            if (g === '?' && !n) delete all[c.desc];
            else all[c.desc] = { gender: g as 'M' | 'F' | '?', ...(n ? { name: n } : {}) };
            await chrome.storage.local.set({ [mtCharOverridesKey]: all });
            // inline feedback on the row itself — the footer status belongs to save/test
            const saved = document.createElement('span');
            saved.className = 'char-saved';
            saved.textContent = 'saved — retranslate the page to apply';
            row.append(saved);
            setTimeout(() => saved.remove(), 2500);
            renderCharacters(all); // rows may have merged under a shared name
        };
        name.onchange = saveRow;
        sel.onchange = saveRow;
        if (ov) {
            const tag = document.createElement('span');
            tag.className = 'src';
            tag.textContent = '✓ user';
            row.append(tag);
        }
        row.append(desc, name, sel);
        box.append(row);
    }
}

export async function clearCharacters(): Promise<void> {
    await chrome.storage.local.remove(['mtCharBook', mtCharOverridesKey]);
    // manga-scoped books too (cross-chapter feature) + chapter contexts
    const all = await chrome.storage.local.get(null);
    const bookKeys = Object.keys(all).filter(k => k.startsWith('mtBook:'));
    if (bookKeys.length) await chrome.storage.local.remove(bookKeys);
    const sess = await sessGet(null);
    const ctxKeys = Object.keys(sess).filter(k => k.startsWith('mtCtx:'));
    if (ctxKeys.length) await sessRemove(ctxKeys);
    renderCharacters({});
}

// ---- auto-translate sites (per-site list; the popup owns the toggle) ----

export async function renderAutoSites(): Promise<void> {
    const { mtAutoTranslate, mtAutoSites } = await chrome.storage.local.get(['mtAutoTranslate', 'mtAutoSites']);
    const box = $('autoSites');
    box.innerHTML = '';
    const list = autoSiteList(mtAutoSites);
    // legacy global flag with no list yet = enabled everywhere until first toggle
    const rows = list.length ? list : (mtAutoTranslate === true ? ['*'] : []);
    if (!rows.length) {
        box.innerHTML = '<div class="empty">Auto-translate is off everywhere — enable it from the popup on a manga site.</div>';
        return;
    }
    for (const origin of rows) {
        const row = document.createElement('div');
        row.className = 'char-row';
        const desc = document.createElement('div');
        desc.className = 'desc';
        desc.textContent = origin === '*' ? 'All sites (old global setting)' : origin;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn ghost sm';
        btn.textContent = 'Remove';
        btn.onclick = async () => {
            const v = await chrome.storage.local.get('mtAutoSites') as { mtAutoSites?: unknown };
            const next = origin === '*' ? [] : autoSiteRemove(autoSiteList(v.mtAutoSites), origin);
            await chrome.storage.local.set({ mtAutoSites: next, mtAutoTranslate: next.length > 0 });
            renderAutoSites();
        };
        row.append(desc, btn);
        box.append(row);
    }
}

// ---- Font manager: presets + custom URL + live preview ----

export async function renderFontManager(): Promise<void> {
    const sel = $('renderFont') as HTMLSelectElement;
    const installed = new Set(await fontList());
    // rebuild the dropdown: Default + everything installed
    const cur = pipeline.renderFont;
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = 'default';
    def.textContent = 'Default (per language)';
    sel.append(def);
    for (const id of installed) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = await fontName(id);
        sel.append(o);
    }
    sel.value = installed.has(cur) || cur === 'default' ? cur : 'default';
    if (sel.value !== cur) { pipeline.renderFont = sel.value as string; savePipeline(); }

    // preset rows
    const list = $('fontPresetList');
    list.innerHTML = '';
    for (const preset of FONT_PRESETS) {
        const row = document.createElement('div');
        row.className = 'dl-row';
        const name = document.createElement('span');
        name.className = 'name';
        name.innerHTML = preset.label + (installed.has(preset.id) ? ' <span class="ok-mark">✓</span>' : '');
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
        btn.textContent = installed.has(preset.id) ? 'Delete' : 'Download';
        btn.onclick = async () => {
            btn.disabled = true;
            row.classList.add('busy');
            try {
                if (installed.has(preset.id)) {
                    await fontDelete(preset.id);
                } else {
                    btn.textContent = '…';
                    await fontDownload(preset, (loaded, total) => {
                        txt.textContent = total ? `${(loaded / 1024).toFixed(0)}/${(total / 1024).toFixed(0)}KB` : `${(loaded / 1024).toFixed(0)}KB`;
                        if (total) fill.style.width = `${Math.min(100, loaded / total * 100)}%`;
                        else fill.classList.add('indet');
                    });
                }
                await renderFontManager();
            } catch (e) {
                txt.textContent = String((e as Error).message).slice(0, 60);
                btn.disabled = false;
                // keep .busy so the error message stays visible
            }
        };
        row.append(name, txt, bar, btn);
        list.append(row);
    }
    drawFontPreview();
}

export async function drawFontPreview(): Promise<void> {
    const canvas = $('fontPreview') as HTMLCanvasElement;
    // the Appearance tab may be hidden (offsetWidth 0) when this runs at load —
    // skip the zero-size paint; the tab handler repaints on open
    if (canvas.offsetWidth === 0) return;
    const text = ($('fontPreviewText') as HTMLInputElement).value || ' ';
    const ctx = canvas.getContext('2d')!;
    canvas.width = canvas.offsetWidth * (devicePixelRatio || 1);
    canvas.height = 64 * (devicePixelRatio || 1);
    ctx.scale(devicePixelRatio || 1, devicePixelRatio || 1);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111';
    const id = pipeline.renderFont;
    let family = id === 'default' ? 'sans-serif' : id;
    if (id !== 'default') {
        const buf = await fontRead(id);
        if (buf) {
            const name = await fontName(id);
            family = `"${name}"`;
            try {
                const face = new FontFace(name, buf);
                await face.load();
                document.fonts.add(face);
            } catch { /* preview falls back to sans-serif */ }
        }
    }
    ctx.font = `28px ${family}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(text.slice(0, 60), 12, 32);
}

// custom URL add — with host-permission fallback for CORS-restricted origins
$('fontAdd').onclick = async () => {
    const url = ($('fontUrl') as HTMLInputElement).value.trim();
    const name = ($('fontNameInput') as HTMLInputElement).value.trim() || 'Custom font';
    const status = $('fontAddStatus');
    if (!/^https?:\/\//.test(url)) { status.textContent = 'Enter a font URL (http/https).'; return; }
    const id = fontIdFromUrl(url);
    status.textContent = 'Downloading…';
    const tryAdd = async (): Promise<void> => fontAddCustom(id, name, url, (l, t) => {
        status.textContent = t ? `${(l / 1024).toFixed(0)}/${(t / 1024).toFixed(0)}KB` : `${(l / 1024).toFixed(0)}KB`;
    });
    try {
        try { await tryAdd(); }
        catch (e) {
            // CORS-blocked origin: ask for host permission and retry once
            if (/failed to fetch|networkerror/i.test(String(e))) {
                const origin = new URL(url).origin + '/*';
                const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
                if (!granted) throw e;
                await tryAdd();
            } else throw e;
        }
        pipeline.renderFont = id;
        ($('fontUrl') as HTMLInputElement).value = '';
        ($('fontNameInput') as HTMLInputElement).value = '';
        status.textContent = `Added: ${name}`;
        await renderFontManager();
    } catch (e) {
        status.textContent = `Failed: ${String((e as Error).message).slice(0, 100)}`;
    }
};

($('renderFont') as HTMLSelectElement).onchange = () => {
    pipeline.renderFont = ($('renderFont') as HTMLSelectElement).value;
    markCustom();
    drawFontPreview();
};
($('fontPreviewText') as HTMLInputElement).oninput = drawFontPreview;
renderFontManager();

// ---- diagnostics (About tab): installed-file integrity + runtime models ----
const DIAG_FILES: [string, string][] = [
    ['ORT webgpu bundle', 'ort/ort.webgpu.bundle.min.mjs'],
    ['ORT wasm runtime', 'ort/ort-wasm-simd-threaded.wasm'],
];
($('diagRun') as HTMLButtonElement).onclick = async () => {
    const out = $('diagOut') as HTMLElement;
    out.textContent = 'Checking…';
    const lines: string[] = [`Extension v${chrome.runtime.getManifest().version}`];
    for (const [label, path] of DIAG_FILES) {
        try {
            const r = await fetch(chrome.runtime.getURL(path), { method: 'HEAD' });
            const len = +(r.headers.get('content-length') ?? 0);
            lines.push(`${label}: ${r.ok ? `ok · ${(len / 1048576).toFixed(1)} MB` : `HTTP ${r.status}`}`);
        } catch (e) {
            lines.push(`${label}: FAILED — ${String((e as Error)?.message ?? e).slice(0, 100)}`);
        }
    }
    try {
        const [baberu, langs, fonts, det] = await Promise.all([baberuInstalled(), ocrInstalled(), fontList(), detModelsInstalled()]);
        // detection weights live in IDB (downloaded on first on-device use), not the bundle
        lines.push(`CTD model: ${det.ctd ? 'cached' : 'not downloaded (fetches on first on-device page)'}`);
        lines.push(`Panel model: ${det.panel ? 'cached' : 'not downloaded (fetches on first page)'}`);
        lines.push(`Baberu OCR: ${baberu ? 'downloaded' : 'not downloaded'}`);
        lines.push(`Tesseract langs: ${langs.length ? langs.join(', ') : 'none'}`);
        lines.push(`Fonts: ${fonts.length ? fonts.join(', ') : 'default only'}`);
    } catch (e) {
        lines.push(`Model store: FAILED — ${String((e as Error)?.message ?? e).slice(0, 100)}`);
    }
    out.textContent = lines.join('\n');
};
