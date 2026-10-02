// In-page characters panel (per-chapter book inspection + overrides).

import { context, saveContext, loadContext, mtPal } from './state';
import { normalizeBook, type CharacterEntry } from '../llm/core';

let charsPanel: HTMLDivElement | null = null;

// The override key is the roster id once a row has one — ids survive desc rewrites; a legacy
// row falls back to its desc until then.
const okey = (c: CharacterEntry): string => c.id ?? c.desc;

async function dropOverride(key: string): Promise<void> {
    const stored = await chrome.storage.local.get('mtCharOverrides');
    const all = { ...((stored.mtCharOverrides ?? {}) as Record<string, { gender: 'M' | 'F' | '?'; name?: string }>) };
    delete all[key];
    await chrome.storage.local.set({ mtCharOverrides: all });
}

export async function renderCharsPanel(): Promise<void> {
    await loadContext();
    const { mtCharOverrides } = await chrome.storage.local.get('mtCharOverrides');
    const overrides = (mtCharOverrides ?? {}) as Record<string, { gender: 'M' | 'F' | '?'; name?: string }>;
    if (!charsPanel) return;
    const box = charsPanel.querySelector('#mt-chars-list') as HTMLDivElement;
    box.innerHTML = '';
    // hygiene view: junk rows ("?") are not editable rows; ids shown here are the ones the
    // next translation will use (same deterministic assignment as the pipeline).
    const rows = normalizeBook(context.characters);
    const ovOf = (c: CharacterEntry) => overrides[okey(c)] ?? overrides[c.desc];
    if (!rows.length) {
        box.innerHTML = '<div style="color:#888;padding:6px">No characters yet — translate some pages first.</div>';
    }
    let unnamedHeader = false;
    for (const c of rows) {
        const unnamed = !c.name && !c.fullName;
        if (unnamed && !unnamedHeader) {
            unnamedHeader = true;
            const head = document.createElement('div');
            head.textContent = 'Unnamed speakers';
            head.style.cssText = `color:${mtPal.muted};font-size:11px;padding:8px 0 2px;text-transform:uppercase;letter-spacing:.04em`;
            box.append(head);
        }
        // two-line row: the panel is only 320px wide, so the name input gets its own line.
        const row = document.createElement('div');
        row.style.cssText = `padding:7px 0;border-bottom:1px solid ${mtPal.border}`;
        const top = document.createElement('div');
        top.style.cssText = 'display:flex;gap:6px;align-items:center';
        const shownName = ovOf(c)?.name ?? c.name;
        const name = document.createElement('input');
        name.type = 'text';
        name.placeholder = unnamed ? 'unnamed — who is this?' : 'name?';
        name.title = 'Character name — saved as an override, no options page needed';
        name.setAttribute('aria-label', `Name for ${c.desc || c.id}`);
        name.value = shownName ?? '';
        name.style.cssText = `flex:1;min-width:0;background:${mtPal.field};color:${mtPal.text};border:1px solid ${mtPal.border};border-radius:4px;padding:4px 6px;font-size:13px`;
        const sel = document.createElement('select');
        sel.title = 'Gender (your choice always wins)';
        sel.setAttribute('aria-label', `Gender for ${c.desc || c.id}`);
        sel.style.cssText = `background:${mtPal.field};color:${mtPal.text};border:1px solid ${mtPal.border};border-radius:4px;padding:3px 2px`;
        for (const [v, label] of [['?', '?'], ['F', 'F'], ['M', 'M']] as const) {
            const o = document.createElement('option');
            o.value = v; o.textContent = label;
            sel.append(o);
        }
        sel.value = ovOf(c)?.gender ?? c.gender;
        // one saver for name + gender — never write without merging (clobbers the stored name).
        const saveRow = async () => {
            const stored = await chrome.storage.local.get('mtCharOverrides');
            const all = { ...((stored.mtCharOverrides ?? {}) as Record<string, { gender: 'M' | 'F' | '?'; name?: string }>) };
            const n = name.value.trim();
            // migrate a legacy desc-keyed override onto the row's id
            if (okey(c) !== c.desc) delete all[c.desc];
            if (sel.value === '?' && !n) delete all[okey(c)];
            else all[okey(c)] = { gender: sel.value as 'M' | 'F' | '?', ...(n ? { name: n } : {}) };
            await chrome.storage.local.set({ mtCharOverrides: all });
            const st = charsPanel?.querySelector('#mt-char-status');
            if (st) st.textContent = 'Saved — hit Re-translate to apply.';
            renderCharsPanel();
        };
        name.onchange = saveRow;
        sel.onchange = saveRow;
        const del = document.createElement('button');
        del.textContent = '×';
        del.title = 'Remove from this chapter';
        del.setAttribute('aria-label', `Remove ${c.desc || c.id}`);
        del.style.cssText = 'background:none;color:#888;border:0;cursor:pointer;font-size:15px;padding:4px 8px';
        del.onclick = async () => {
            // desc-only rows have no stored id yet; match those too so a legacy row really goes
            context.characters = context.characters.filter(x => !(x.desc === c.desc && (!x.id || !c.id || x.id === c.id)));
            await dropOverride(okey(c)); // or the override resurrects it in later prompts
            if (okey(c) !== c.desc) await dropOverride(c.desc);
            await saveContext();
            renderCharsPanel();
        };
        top.append(name, sel, del);
        const sub = document.createElement('div');
        sub.style.cssText = `color:${mtPal.muted};font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
        sub.textContent = (c.desc || c.id) + (c.source === 'user' ? ' ✓' : '');
        sub.title = c.desc;
        row.append(top, sub);
        box.append(row);
    }
    // manual character entry.
    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:6px;margin-top:8px';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'e.g. the class president';
    inp.style.cssText = `flex:1;background:${mtPal.field};color:${mtPal.text};border:1px solid ${mtPal.border};border-radius:4px;padding:4px`;
    const gsel = document.createElement('select');
    gsel.title = 'Gender';
    gsel.setAttribute('aria-label', 'Gender for the new character');
    gsel.style.cssText = `background:${mtPal.field};color:${mtPal.text};border:1px solid ${mtPal.border};border-radius:4px`;
    for (const [v, label] of [['?', '?'], ['F', 'F'], ['M', 'M']] as const) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        gsel.append(o);
    }
    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add';
    addBtn.style.cssText = `background:${mtPal.accent};color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer`;
    addBtn.onclick = async () => {
        const desc = inp.value.trim();
        if (!desc) return;
        context.characters = normalizeBook([...context.characters, { desc, gender: gsel.value as 'M' | 'F' | '?', source: 'user' }]);
        await saveContext();
        inp.value = '';
        renderCharsPanel();
    };
    addRow.append(inp, gsel, addBtn);
    box.append(addRow);
    // header Clear-all lives in makeCharsPanel — show it only when rows exist
    const clr = charsPanel?.querySelector('#mt-chars-clear') as HTMLButtonElement | null;
    if (clr) clr.style.display = context.characters.length ? '' : 'none';
}

// clear all: this book only (the global wipe stays in options). Cleared rows' overrides go
// too (both id- and desc-keyed) — applyOverrides would resurrect them otherwise.
async function clearAllChars(): Promise<void> {
    const keys = normalizeBook(context.characters).map(c => okey(c));
    const descs = context.characters.map(x => x.desc);
    context.characters = [];
    const stored = await chrome.storage.local.get('mtCharOverrides');
    const all = { ...((stored.mtCharOverrides ?? {}) as Record<string, { gender: 'M' | 'F' | '?'; name?: string }>) };
    for (const k of new Set([...keys, ...descs])) delete all[k];
    await chrome.storage.local.set({ mtCharOverrides: all });
    await saveContext();
    renderCharsPanel();
}

export function makeCharsPanel(): HTMLDivElement {
    const p = document.createElement('div');
    p.style.cssText = `position:fixed;bottom:64px;right:16px;z-index:99999;background:${mtPal.bg};color:${mtPal.text};padding:12px;border:1px solid ${mtPal.border};border-radius:12px;font:13px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.4);width:320px;max-height:420px;overflow:auto;display:none`;
    p.innerHTML = '<div style="display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:6px">' +
        '<span style="flex:1">Characters (this chapter)</span>' +
        '<button id="mt-chars-clear" title="Remove all characters from this chapter" style="background:none;color:' + mtPal.err + ';border:0;cursor:pointer;font-size:12px;font-weight:400;padding:4px 6px">Clear all</button>' +
        '<button id="mt-chars-close" title="Close" style="background:none;color:#888;border:0;cursor:pointer;font-size:15px;line-height:1;padding:4px 6px">×</button></div>' +
        '<div id="mt-chars-list"></div>' +
        '<div id="mt-char-status" style="color:#7f7;font-size:11px;margin-top:4px"></div>';
    // popup polls charsOpen, so it follows without a message round-trip
    (p.querySelector('#mt-chars-close') as HTMLButtonElement).onclick = () => { p.style.display = 'none'; };
    (p.querySelector('#mt-chars-clear') as HTMLButtonElement).onclick = () => { clearAllChars(); };
    return p;
}

export function toggleCharsPanel(): void {
    if (!charsPanel) {
        charsPanel = makeCharsPanel();
        document.body.append(charsPanel);
    }
    const open = charsPanel.style.display !== 'none';
    charsPanel.style.display = open ? 'none' : 'block';
    if (!open) renderCharsPanel();
}

export function charsPanelOpen(): boolean {
    return charsPanel ? charsPanel.style.display !== 'none' : false;
}

export function onThemeChanged(): void {
    if (charsPanel && charsPanel.style.display !== 'none') renderCharsPanel();
}
