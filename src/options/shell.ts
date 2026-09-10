// Options page shared shell: element helper, dirty model, status line, theme.
// Each tab section imports $ + setDirty/setStatus from here.

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- dirty model (Discord-style): nothing persists until Save Changes ----
let dirty = false;

// shared download-progress renderer (bars in OCR / model / font sections)
export function dlProgress(bar: HTMLElement, loaded: number, total: number): void {
    const fill = bar.querySelector('.fill') as HTMLElement ?? bar;
    const txt = total ? `${(loaded / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)}MB` : `${(loaded / 1e6).toFixed(1)}MB`;
    (bar.parentElement!.querySelector('.dl-text') as HTMLElement).textContent = txt;
    if (total) fill.style.width = `${Math.min(100, loaded / total * 100)}%`;
    else fill.classList.add('indet');
}

export function renderBar(): void {
    const el = $('status') as HTMLSpanElement;
    if (dirty && !el.textContent) el.textContent = 'You have unsaved changes';
    const visible = dirty || !!el.textContent;
    $('dirtyBar').style.display = visible ? 'flex' : 'none';
    ($('barBtns') as HTMLElement).style.display = dirty ? 'flex' : 'none';
    document.body.classList.toggle('has-bar', visible);
}

export function setDirty(d: boolean): void {
    dirty = d;
    if (!d) ($('status') as HTMLSpanElement).textContent = '';
    renderBar();
}

// single status line in the dirty bar. kind drives the color. Optional
// target: per-button status (test connection / test cloud) reports under its
// own button instead of the shared bar — a test error next to "Save Changes"
// reads as "the save broke".
export function setStatus(text: string, kind: 'ok' | 'err' | '' = '', ms = 0, target?: HTMLElement): void {
    const el = target ?? ($('status') as HTMLSpanElement);
    el.textContent = text;
    el.className = kind;
    if (target) return; // inline targets are static, no bar coupling
    renderBar();
    if (ms) setTimeout(() => { if (el.textContent === text) setStatus(''); }, ms);
}

// ---- theme: segmented tri-state, applies instantly everywhere,
// not part of the dirty model ----
function applyThemeAttr(t: string): void {
    if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#themeSeg button')) {
        const on = b.dataset.themeVal === t;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
}

export async function loadThemeChoice(): Promise<void> {
    const { mtTheme } = await chrome.storage.local.get('mtTheme');
    applyThemeAttr((mtTheme as string | undefined) ?? 'system');
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#themeSeg button')) {
    b.onclick = async () => {
        const t = b.dataset.themeVal ?? 'system';
        await chrome.storage.local.set({ mtTheme: t });
        applyThemeAttr(t);
    };
}

// ---- tabs ----
export function wireTabs(onOpen: (tab: string) => void): void {
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
        btn.onclick = () => {
            for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.classList.toggle('on', b === btn);
            for (const t of document.querySelectorAll<HTMLDivElement>('.tab')) t.classList.toggle('on', t.id === `tab-${btn.dataset.tab}`);
            onOpen(btn.dataset.tab ?? '');
        };
    }
}
