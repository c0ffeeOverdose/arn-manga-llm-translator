// In-page characters panel (per-chapter book inspection + overrides).
// Identity-first: each row shows its roster id, and name/desc/note are the user's to edit.
// Rows can be merged (fold one row into another) and split (restore absorbed rows).

import { context, saveContext, loadContext, mtPal } from './state';
import { normalizeBook, charKey, mergeBookRows, splitBookRow, type CharacterEntry, type CharOverride } from '../llm/core';

let charsPanel: HTMLDivElement | null = null;

async function getOverrides(): Promise<Record<string, CharOverride>> {
    const { mtCharOverrides } = await chrome.storage.local.get('mtCharOverrides');
    return (mtCharOverrides ?? {}) as Record<string, CharOverride>;
}

async function dropOverride(key: string): Promise<void> {
    const all = { ...await getOverrides() };
    delete all[key];
    await chrome.storage.local.set({ mtCharOverrides: all });
}

// The dropped row's user edits move onto the row that survives the merge.
async function transferOverride(from: string, to: string): Promise<void> {
    const all = { ...await getOverrides() };
    const src = all[from];
    delete all[from];
    if (src) {
        const dst = all[to];
        all[to] = {
            gender: dst && dst.gender !== '?' ? dst.gender : src.gender,
            name: dst?.name ?? src.name,
            desc: dst?.desc ?? src.desc,
            note: dst?.note ?? src.note,
        };
    }
    await chrome.storage.local.set({ mtCharOverrides: all });
}

const rowLabel = (c: { name?: string; fullName?: string; desc: string }): string =>
    c.name || c.fullName || c.desc || '(unnamed)';

function mkInput(value: string, placeholder: string, aria: string): HTMLInputElement {
    const el = document.createElement('input');
    el.type = 'text';
    el.value = value;
    el.placeholder = placeholder;
    el.setAttribute('aria-label', aria);
    el.style.cssText = `width:100%;box-sizing:border-box;background:${mtPal.field};color:${mtPal.text};border:1px solid ${mtPal.border};border-radius:4px;padding:4px 6px;font-size:13px`;
    return el;
}

function mkButton(text: string, title: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    b.style.cssText = `flex:none;background:${mtPal.field};color:${mtPal.text};border:1px solid ${mtPal.border};border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer`;
    return b;
}

export async function renderCharsPanel(): Promise<void> {
    await loadContext();
    const overrides = await getOverrides();
    if (!charsPanel) return;
    const box = charsPanel.querySelector('#mt-chars-list') as HTMLDivElement;
    box.innerHTML = '';
    // hygiene view: junk rows ("?") are not editable rows; ids shown here are the ones the
    // next translation will use (same deterministic assignment as the pipeline).
    const rows = normalizeBook(context.characters);
    const ovOf = (c: CharacterEntry) => overrides[charKey(c)] ?? overrides[c.desc];
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
        const ov = ovOf(c);
        const row = document.createElement('div');
        row.style.cssText = `padding:7px 0;border-bottom:1px solid ${mtPal.border}`;
        // line 1: the id the model references + the name it should use
        const top = document.createElement('div');
        top.style.cssText = 'display:flex;gap:6px;align-items:center';
        const idTag = document.createElement('span');
        idTag.textContent = c.id ?? '—';
        idTag.title = 'Roster id — the model answers spk="…" with this id';
        idTag.style.cssText = `flex:none;min-width:22px;text-align:center;background:${mtPal.accent};color:#fff;border-radius:4px;padding:2px 4px;font-size:11px;font-weight:600`;
        const name = mkInput(ov?.name ?? c.name ?? '', unnamed ? 'unnamed — who is this?' : 'name?',
            `Name for ${rowLabel(c)}`);
        name.title = 'Character name — saved as an override, no options page needed';
        name.style.flex = '1';
        name.style.minWidth = '0';
        const sel = document.createElement('select');
        sel.title = 'Gender (your choice always wins)';
        sel.setAttribute('aria-label', `Gender for ${rowLabel(c)}`);
        sel.style.cssText = `flex:none;background:${mtPal.field};color:${mtPal.text};border:1px solid ${mtPal.border};border-radius:4px;padding:3px 2px`;
        for (const [v, label] of [['?', '?'], ['F', 'F'], ['M', 'M']] as const) {
            const o = document.createElement('option');
            o.value = v; o.textContent = label;
            sel.append(o);
        }
        sel.value = ov?.gender ?? c.gender;
        const del = document.createElement('button');
        del.textContent = '×';
        del.title = 'Remove from this chapter';
        del.setAttribute('aria-label', `Remove ${rowLabel(c)}`);
        del.style.cssText = 'flex:none;background:none;color:#888;border:0;cursor:pointer;font-size:15px;padding:4px 6px';
        top.append(idTag, name, sel, del);
        // line 2/3: the visual anchor and the social facts (both feed the roster)
        const desc = mkInput(ov?.desc ?? c.desc ?? '', 'description — how to recognize them', `Description for ${rowLabel(c)}`);
        desc.title = 'Visual anchor sent to the model — say what makes this person recognizable';
        desc.style.marginTop = '4px';
        const note = mkInput(ov?.note ?? c.note ?? '', 'note — relation, rank, how they are called', `Note for ${rowLabel(c)}`);
        note.title = 'Page-stated facts the model accumulates (relations, rank, how others address them)';
        note.style.marginTop = '4px';
        // line 4: provenance + row surgery
        const meta = document.createElement('div');
        meta.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:4px';
        const src = document.createElement('span');
        src.style.cssText = `flex:1;min-width:0;color:${mtPal.muted};font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
        src.textContent = (ov ? '✓ user' : `learned via ${c.source}`) + (c.absorbed?.length ? ` · ${c.absorbed.length} merged` : '');
        meta.append(src);
        const others = rows.filter(r => charKey(r) !== charKey(c));
        if (others.length) {
            const mergeSel = document.createElement('select');
            mergeSel.title = 'Fold this row into another character';
            mergeSel.setAttribute('aria-label', `Merge ${rowLabel(c)} into`);
            mergeSel.style.cssText = `flex:none;max-width:140px;background:${mtPal.field};color:${mtPal.text};border:1px solid ${mtPal.border};border-radius:4px;padding:3px 2px;font-size:12px`;
            const none = document.createElement('option');
            none.value = ''; none.textContent = 'merge into…';
            mergeSel.append(none);
            for (const r of others) {
                const o = document.createElement('option');
                o.value = charKey(r);
                o.textContent = `${r.id ?? '?'} ${rowLabel(r)}`.slice(0, 34);
                mergeSel.append(o);
            }
            mergeSel.onchange = async () => {
                const target = mergeSel.value;
                if (!target) return;
                const key = charKey(c);
                context.characters = mergeBookRows(normalizeBook(context.characters), target, key);
                await transferOverride(key, target);
                await saveContext();
                renderCharsPanel();
            };
            meta.append(mergeSel);
        }
        if (c.absorbed?.length) {
            const split = mkButton(`split (${c.absorbed.length})`, 'Restore the rows that were merged into this one');
            split.onclick = async () => {
                context.characters = splitBookRow(normalizeBook(context.characters), charKey(c));
                await saveContext();
                renderCharsPanel();
            };
            meta.append(split);
        }
        // one saver for every field — never write without merging (clobbers stored values).
        // Unchanged values are not stored, so touching one field never pins the others as user.
        const saveRow = async () => {
            const all = { ...await getOverrides() };
            const key = charKey(c);
            const n = name.value.trim(), d = desc.value.trim(), nt = note.value.trim();
            const next: CharOverride = { gender: sel.value as 'M' | 'F' | '?' };
            if (n && n !== (c.name ?? '')) next.name = n;
            if (d && d !== (c.desc ?? '')) next.desc = d;
            if (nt && nt !== (c.note ?? '')) next.note = nt;
            // migrate a legacy desc-keyed override onto the row's id
            if (key !== c.desc) delete all[c.desc];
            if (next.gender === '?' && !next.name && !next.desc && !next.note) delete all[key];
            else all[key] = next;
            await chrome.storage.local.set({ mtCharOverrides: all });
            const st = charsPanel?.querySelector('#mt-char-status');
            if (st) st.textContent = 'Saved — hit Re-translate to apply.';
            renderCharsPanel();
        };
        name.onchange = saveRow;
        sel.onchange = saveRow;
        desc.onchange = saveRow;
        note.onchange = saveRow;
        del.onclick = async () => {
            // operate on the normalized view: a raw duplicate row would resurrect the merge
            const rowsNow = normalizeBook(context.characters);
            context.characters = c.id
                ? rowsNow.filter(x => x.id !== c.id)
                : rowsNow.filter(x => x.desc !== c.desc);
            await dropOverride(charKey(c));
            if (charKey(c) !== c.desc) await dropOverride(c.desc);
            await saveContext();
            renderCharsPanel();
        };
        row.append(top, desc, note, meta);
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
    const keys = normalizeBook(context.characters).map(c => charKey(c));
    const descs = context.characters.map(x => x.desc);
    context.characters = [];
    const all = { ...await getOverrides() };
    for (const k of new Set([...keys, ...descs])) delete all[k];
    await chrome.storage.local.set({ mtCharOverrides: all });
    await saveContext();
    renderCharsPanel();
}

export function makeCharsPanel(): HTMLDivElement {
    const p = document.createElement('div');
    p.style.cssText = `position:fixed;bottom:64px;right:16px;z-index:99999;background:${mtPal.bg};color:${mtPal.text};padding:12px;border:1px solid ${mtPal.border};border-radius:12px;font:13px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.4);width:340px;max-height:480px;overflow:auto;display:none`;
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
