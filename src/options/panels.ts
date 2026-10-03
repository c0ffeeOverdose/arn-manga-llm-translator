// Characters tab + auto-translate sites + font manager + diagnostics.

import { autoSiteList, autoSiteRemove } from '../llm/pipeline-settings';
import { sessGet, sessRemove } from '../storage-session';
import { baberuInstalled, ocrInstalled, detModelsInstalled } from '../llm/ocr-models';
import { FONT_PRESETS, fontList, fontDownload, fontDelete, fontAddCustom, fontName, fontIdFromUrl, fontRead } from '../llm/font-store';
import { charKey, overrideKey, claimLegacyOverrides, type CharOverride } from '../llm/core';
import { $ } from './shell';
import { pipeline, markCustom, savePipeline } from './pipeline-section';

const mtCharOverridesKey = 'mtCharOverrides';
const mtCharTitlesKey = 'mtCharTitles';

interface BookRow { id?: string; desc: string; gender: string; source: string; name?: string; fullName?: string; note?: string }
interface BookSection { scope?: string; label: string; rows: BookRow[]; current: boolean }

// ---- characters ----

async function getOverrides(): Promise<Record<string, CharOverride>> {
    const { mtCharOverrides } = await chrome.storage.local.get(mtCharOverridesKey);
    return (mtCharOverrides as Record<string, CharOverride>) ?? {};
}

function rowLabel(c: { name?: string; fullName?: string; desc: string }): string {
    return c.name || c.fullName || c.desc || '(unnamed)';
}

function textInput(value: string, placeholder: string, aria: string): HTMLInputElement {
    const el = document.createElement('input');
    el.type = 'text';
    el.value = value;
    el.placeholder = placeholder;
    el.setAttribute('aria-label', aria);
    return el;
}

// Keys a row's override can live under: scoped to its book first, then the legacy bare forms.
function ovKeys(scope: string | undefined, c: BookRow): string[] {
    const out: string[] = [];
    const add = (k: string | undefined): void => { if (k && !out.includes(k)) out.push(k); };
    if (scope) { add(overrideKey(scope, charKey(c))); add(overrideKey(scope, c.desc)); }
    add(charKey(c));
    add(c.desc);
    return out;
}
function findOv(overrides: Record<string, CharOverride>, scope: string | undefined, c: BookRow): CharOverride | undefined {
    for (const k of ovKeys(scope, c)) {
        const ov = overrides[k];
        if (ov) return ov;
    }
    return undefined;
}

// Titles for persistent per-story books, fetched once per id and cached; while offline (or
// for non-MangaDex ids) the short id stays the label.
const titleAttempted = new Set<string>();
let titleFetch: Promise<boolean> | null = null;
async function ensureTitles(ids: string[]): Promise<boolean> {
    if (!ids.length) return false;
    const { [mtCharTitlesKey]: cached } = await chrome.storage.local.get(mtCharTitlesKey);
    const titles = { ...((cached as Record<string, string> | undefined) ?? {}) };
    const missing = ids.filter(id => !titles[id] && !titleAttempted.has(id) && /^[0-9a-f-]{36}$/i.test(id));
    if (!missing.length) return false;
    if (!titleFetch) {
        titleFetch = (async () => {
            let got = false;
            for (const id of missing) {
                titleAttempted.add(id);
                try {
                    const r = await fetch(`https://api.mangadex.org/manga/${id}`, { signal: AbortSignal.timeout(6000) });
                    if (!r.ok) continue;
                    const t = ((await r.json()) as { data?: { attributes?: { title?: Record<string, string> } } })?.data?.attributes?.title ?? {};
                    const name = t.en ?? t.ja ?? Object.values(t)[0];
                    if (typeof name === 'string' && name) { titles[id] = name; got = true; }
                } catch { /* offline → the id stays the label */ }
            }
            if (got) await chrome.storage.local.set({ [mtCharTitlesKey]: titles });
            return got;
        })().finally(() => { titleFetch = null; });
    }
    return titleFetch;
}

// Sections: the snapshot the open tab last pushed, plus every per-story book in storage.local.
async function getBooks(): Promise<BookSection[]> {
    const all = await chrome.storage.local.get(null);
    const raw = all.mtCharBook as { bookKey?: string; characters?: BookRow[] } | BookRow[] | undefined;
    const titles = (all[mtCharTitlesKey] as Record<string, string> | undefined) ?? {};
    const sections: BookSection[] = [];
    const snapRows = Array.isArray(raw) ? raw : raw?.characters;
    const snapScope = Array.isArray(raw) ? undefined : raw?.bookKey;
    if (snapRows?.length) sections.push({ scope: snapScope, label: 'Currently open', rows: snapRows, current: true });
    for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith('mtBook:')) continue;
        if (sections.some(s => s.scope === k)) continue; // the snapshot already shows that book
        let rows: BookRow[] = [];
        try {
            const parsed = typeof v === 'string' ? JSON.parse(v) : v;
            if (Array.isArray(parsed)) rows = parsed as BookRow[];
        } catch { continue; }
        if (!rows.length) continue;
        const id = k.slice('mtBook:'.length);
        sections.push({ scope: k, label: `${titles[id] ?? 'Manga'} (${id.slice(0, 8)})`, rows, current: false });
    }
    return sections;
}

// Per-book clear: the stored rows, the snapshot if it belongs to that book, and the book's
// overrides (scoped + legacy) — otherwise they would reappear on the next translate.
async function clearBook(section: BookSection): Promise<void> {
    if (section.scope?.startsWith('mtBook:')) await chrome.storage.local.remove(section.scope);
    else if (section.scope?.startsWith('mtCtx:')) await sessRemove(section.scope);
    const { mtCharBook } = await chrome.storage.local.get('mtCharBook');
    const snapScope = Array.isArray(mtCharBook) ? undefined : (mtCharBook as { bookKey?: string } | undefined)?.bookKey;
    if (section.current || (section.scope !== undefined && snapScope === section.scope)) {
        await chrome.storage.local.remove('mtCharBook');
    }
    const all = { ...await getOverrides() };
    for (const c of section.rows) for (const k of ovKeys(section.scope, c)) delete all[k];
    await chrome.storage.local.set({ [mtCharOverridesKey]: all });
    renderCharacters(all);
}

// One row shows its roster id and lets the user edit every field that reaches the model:
// name, gender, description (visual anchor), note (social facts). Unchanged values are not
// stored, so touching one field never pins the others as user data.
function charRow(section: BookSection, c: BookRow, overrides: Record<string, CharOverride>): HTMLElement {
    const ov = findOv(overrides, section.scope, c);
    const item = document.createElement('div');
    item.className = 'char-item';
    const head = document.createElement('div');
    head.className = 'head';
    const idTag = document.createElement('span');
    idTag.className = 'char-id';
    idTag.textContent = c.id ?? '—';
    idTag.title = 'Roster id — the model answers spk="…" with this id';
    const label = c.fullName && c.fullName !== c.name ? (c.name ? `${c.name} (${c.fullName})` : c.fullName) : c.name;
    const name = textInput(ov?.name ?? label ?? '', 'name', `Name for ${rowLabel(c)}`);
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `Gender for ${rowLabel(c)}`);
    for (const [v, text] of [['?', 'unknown'], ['F', 'female'], ['M', 'male']] as const) {
        const o = document.createElement('option');
        o.value = v; o.textContent = text;
        sel.append(o);
    }
    sel.value = ov ? ov.gender : c.gender;
    head.append(idTag, name, sel);

    const descLine = document.createElement('div');
    descLine.className = 'line';
    const descLabel = document.createElement('label');
    descLabel.textContent = 'desc';
    const desc = textInput(ov?.desc ?? c.desc ?? '', 'how to recognize them', `Description for ${rowLabel(c)}`);
    desc.title = 'Visual anchor sent to the model — what makes this person recognizable';
    descLine.append(descLabel, desc);
    const noteLine = document.createElement('div');
    noteLine.className = 'line';
    const noteLabel = document.createElement('label');
    noteLabel.textContent = 'note';
    const note = textInput(ov?.note ?? c.note ?? '', 'relation, rank, how they are called', `Note for ${rowLabel(c)}`);
    note.title = 'Page-stated facts (relations, rank, how others address them)';
    noteLine.append(noteLabel, note);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = `learned via ${c.source}`;
    meta.append(src);

    const saveRow = async () => {
        const all = { ...await getOverrides() };
        const key = overrideKey(section.scope, charKey(c));
        const n = name.value.trim(), d = desc.value.trim(), nt = note.value.trim();
        const next: CharOverride = { gender: sel.value as 'M' | 'F' | '?' };
        if (n && n !== (c.name ?? '')) next.name = n;
        if (d && d !== (c.desc ?? '')) next.desc = d;
        if (nt && nt !== (c.note ?? '')) next.note = nt;
        // the scoped key replaces every legacy bare key for this row
        for (const k of ovKeys(section.scope, c)) if (k !== key) delete all[k];
        if (next.gender === '?' && !next.name && !next.desc && !next.note) delete all[key];
        else all[key] = next;
        await chrome.storage.local.set({ [mtCharOverridesKey]: all });
        // inline feedback on the row itself — the footer status belongs to save/test
        const saved = document.createElement('span');
        saved.className = 'char-saved';
        saved.textContent = 'saved — retranslate the page to apply';
        item.append(saved);
        setTimeout(() => saved.remove(), 2500);
        renderCharacters(all); // rows may have merged under a shared name
    };
    name.onchange = saveRow;
    sel.onchange = saveRow;
    desc.onchange = saveRow;
    note.onchange = saveRow;
    if (ov) {
        const tag = document.createElement('span');
        tag.className = 'src';
        tag.textContent = '✓ user';
        meta.append(tag);
    }
    item.append(head, descLine, noteLine, meta);
    return item;
}

export async function renderCharacters(overrides: Record<string, CharOverride>): Promise<void> {
    const sections = await getBooks();
    const box = $('characters');
    box.innerHTML = '';
    if (!sections.length) {
        box.innerHTML = '<div class="empty">No characters yet — translate some pages first.</div>';
        return;
    }
    // legacy bare edits get pinned to the book that shows the row (once), so a c1 from one
    // story can no longer leak onto another
    let claimed = false;
    for (const s of sections) {
        if (!s.scope) continue;
        const claim = claimLegacyOverrides(overrides, s.scope, [...new Set(s.rows.flatMap(c => [charKey(c), c.desc].filter(Boolean)))]);
        if (claim.changed) { overrides = claim.overrides; claimed = true; }
    }
    if (claimed) await chrome.storage.local.set({ [mtCharOverridesKey]: overrides });

    const titleIds: string[] = [];
    for (const section of sections) {
        const head = document.createElement('div');
        head.className = 'char-book';
        const nameEl = document.createElement('span');
        nameEl.className = 'char-book-name';
        nameEl.textContent = section.label;
        const count = document.createElement('span');
        count.className = 'src';
        count.textContent = `${section.rows.length} row${section.rows.length === 1 ? '' : 's'}`;
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'btn ghost sm';
        clear.textContent = 'Clear';
        clear.title = 'Remove this book and its edits';
        clear.onclick = () => { void clearBook(section); };
        head.append(nameEl, count, clear);
        box.append(head);
        for (const c of section.rows) box.append(charRow(section, c, overrides));
        if (!section.current && section.scope?.startsWith('mtBook:')) titleIds.push(section.scope.slice('mtBook:'.length));
    }
    if (titleIds.length) void ensureTitles(titleIds).then(got => { if (got) void renderCharacters(overrides); });
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
    // skip zero-size paint when the tab is hidden (offsetWidth 0); the tab handler repaints on open
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
