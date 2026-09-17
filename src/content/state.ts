// Content-script shared state: page registry, context/book, pipeline settings,
// theme palettes, session usage. Every module imports from here; nothing here
// imports from another content module (no cycles).

import { EMPTY_CONTEXT, type ContextState, type CharacterEntry, type Mention, type RegionOutput } from '../llm/core';
import { DEFAULT_PIPELINE_SETTINGS, loadPipelineSettings, type PipelineSettings } from '../llm/pipeline-settings';
import { fontStackFor, setRenderTuning } from './render';
import { sessGet, sessSet } from '../storage-session';
import { normalizeChapterKey, type EpisodeManifest } from './page-cache';
import type { DetectResult } from './detection';

declare const __BUILD_ID__: string; // injected by build.mjs — which build is this?

export interface PageState {
    orig: string;
    translated: string;
    // blob-origin readers (MangaDex etc.): extension-owned PNG copy of the
    // original pixels. The reader's blob URL is dead or unassignable (the
    // dead-orig guard), so this is the only reliable way back for
    // "Show original" — minted while the pixels are still readable.
    origOwn?: string;
    debug?: string; // full-res boxes+badges+conf view on the TRANSLATED image
    debugOrig?: string; // same boxes on the ORIGINAL (Show original keeps its debug)
    det?: DetectResult;
    outputs?: RegionOutput[];
    mentions?: Mention[]; // page-level named people (folded into the book with outputs)
    // book/pairs exactly as they were BEFORE this page folded (references to
    // the immutable context arrays). rewindContextBefore restores the snapshot
    // on re-translate: it is exact and survives a fresh session, where the
    // loaded book cannot be re-derived from page states at all.
    bookBefore?: CharacterEntry[];
    pairsBefore?: [string, string][];
    hash?: string; // content hash of the ORIGINAL pixels — element-identity fallback
    // canvas pages only: the page has no URL to re-read, so the first read is
    // stashed (original bytes for re-translate, translated bitmap for write-back)
    origBytes?: ArrayBuffer;
    translatedBmp?: ImageBitmap;
    // decoded-on-demand paint sources (Show original + debug frames have no URL
    // to swap like img — closed with the page in unregPage)
    origBmp?: ImageBitmap;
    debugBmp?: ImageBitmap;
    debugOrigBmp?: ImageBitmap;
}

// A page is an <img> or a reader <canvas> — the pipeline only needs pixels
// in and pixels out, keyed by a stable identity string either way.
export type PageRef = { kind: 'img'; el: HTMLImageElement } | { kind: 'canvas'; el: HTMLCanvasElement; key: string; pageSrc?: string };

export const pages = new Map<string, PageState>();
// element binding: blob-rotating readers (MM mints a fresh blob: URL per
// display and revokes the old one) break URL-keyed identity — the state is
// filed under blobA while the live element already shows blobB, so the sweep
// can never paint it and auto re-translates forever (log churns, screen
// unchanged). The element itself is the stable identity: every successful
// write binds element→state, and an unknown src is verified by content hash
// (match = same page under a new URL → alias + paint; mismatch = recycled
// node showing another page → drop the binding). WeakMap — dead nodes vanish.
export const elStates = new WeakMap<Element, PageState>();
// in-flight / failed hash verifications per element+src (sweep is 1s —
// without these every sweep re-decodes + re-hashes the same mismatch)
export const verifying = new WeakMap<Element, string>();
export const verifyFailed = new WeakMap<Element, string>();
// content index: original-pixel hash → translated state, for the fast repaint
// lane (back-nav: known content under an unknown URL repaints with no queue,
// no prep, no book fold — it folded on first translation). Same lifecycle as
// the pages map (reg/unreg together); memory-only, dies with the tab.
export const hashStates = new Map<string, { state: PageState; w: number; h: number }>();
// hash repaints already attempted per element+src with no index hit —
// genuinely-new pages stay on the queue path instead of re-hashing every
// sweep. Re-arms on src change; a later translation covers via pages.has.
export const hashMiss = new WeakMap<Element, string>();
export const hashPending = new WeakMap<Element, string>();

// fastest truth first: a KNOWN url (orig, our translated blob, retired alias)
// always wins over a possibly-stale element binding (recycled node showing a
// different page whose url we already know paints THAT page, then rebinds).
// refKey logic duplicated (one-liner) — importing page-io here would cycle.
export function stateFor(ref: PageRef): PageState | undefined {
    let key: string;
    if (ref.kind === 'canvas') key = ref.pageSrc ?? ref.key;
    else {
        const ex = pages.get(ref.el.src);
        key = ex ? ex.orig : (retiredBlobs.get(ref.el.src) ?? ref.el.src);
    }
    return pages.get(key) ?? (ref.kind === 'img' ? elStates.get(ref.el) : undefined);
}

// retired blob URLs: unregPage deletes live keys, but elements still showing
// an old blob (preload twins, recycled mobile DOM) must keep resolving to
// their page — otherwise re-translate fetches the dead blob ("Failed to
// fetch") and the sweep can never heal them. String-only, bounded.
export const retiredBlobs = new Map<string, string>();
const RETIRED_MAX = 50;
export function retireBlob(blob: string | undefined, orig: string): void {
    if (!blob || !blob.startsWith('blob:')) return;
    retiredBlobs.delete(blob);
    retiredBlobs.set(blob, orig);
    if (retiredBlobs.size > RETIRED_MAX) retiredBlobs.delete(retiredBlobs.keys().next().value!);
}

export function regPage(state: PageState): void {
    pages.set(state.orig, state);
    pages.set(state.translated, state);
    if (state.origOwn) pages.set(state.origOwn, state);
    if (state.debug) pages.set(state.debug, state);
    if (state.debugOrig) pages.set(state.debugOrig, state);
    // content index for the fast repaint lane (back-nav after blob rotation):
    // same-pixel pages repaint from here without queue/prep/fold
    const m = state.det?.mask;
    if (state.hash && m) hashStates.set(state.hash, { state, w: m.width, h: m.height });
}
export function unregPage(state: PageState): void {
    retireBlob(state.translated, state.orig);
    retireBlob(state.origOwn, state.orig);
    retireBlob(state.debug, state.orig);
    retireBlob(state.debugOrig, state.orig);
    if (state.hash && hashStates.get(state.hash)?.state === state) hashStates.delete(state.hash);
    pages.delete(state.orig);
    pages.delete(state.translated);
    if (state.origOwn) { URL.revokeObjectURL(state.origOwn); pages.delete(state.origOwn); }
    if (state.debug) pages.delete(state.debug);
    if (state.debugOrig) pages.delete(state.debugOrig);
    state.translatedBmp?.close(); // canvas write-back bitmap — freed with the page
    state.translatedBmp = undefined;
    state.origBmp?.close();
    state.origBmp = undefined;
    state.debugBmp?.close();
    state.debugBmp = undefined;
    state.debugOrigBmp?.close();
    state.debugOrigBmp = undefined;
}
export function uniquePages(): PageState[] {
    return [...new Set(pages.values())];
}

export let overlayOn = false;
export function setOverlayOn(v: boolean): void { overlayOn = v; }
// debug overlay (detection boxes + badges + conf): session-level like the
// popup toggles, persisted under its own key so it never touches presets
export let debugOn = false;
export function setDebugOn(v: boolean): void { debugOn = v; }
// 'auto' = show translations as pages finish (default); 'original' = the user
// explicitly asked for originals — jobs finishing later must NOT flip it back
export let overlayChoice: 'auto' | 'original' = 'auto';
export function setOverlayChoice(v: 'auto' | 'original'): void { overlayChoice = v; }
export let ui: HTMLDivElement | null = null;
export function setUi(v: HTMLDivElement | null): void { ui = v; }

export let pipeline: PipelineSettings = { ...DEFAULT_PIPELINE_SETTINGS };
let customFontLoaded = ''; // font-store id whose FontFace is already on document.fonts

export async function loadPipeline(): Promise<PipelineSettings> {
    const { mtPipeline } = await chrome.storage.local.get('mtPipeline');
    pipeline = loadPipelineSettings(mtPipeline);
    setRenderTuning({
        minFont: pipeline.minFont,
        letterSpacing: pipeline.letterSpacing,
        verticalThreshold: pipeline.verticalThreshold,
        font: fontStackFor(pipeline.targetLang),
        textColor: pipeline.textColor,
        strokeColor: pipeline.strokeColor,
        textStroke: pipeline.textStroke,
        textScale: pipeline.textScale,
    });
    // user-selected render font: fetch bytes from the background (they live in
    // the extension-origin IndexedDB), register a FontFace, and put it FIRST in
    // the stack — missing glyphs fall through to the per-language default
    if (pipeline.renderFont !== 'default' && pipeline.renderFont !== customFontLoaded) {
        const resp = await chrome.runtime.sendMessage({ type: 'mt:font-get', id: pipeline.renderFont }) as
            { ok: boolean; name?: string; b64?: string; error?: string } | null;
        if (resp?.ok && resp.b64 && resp.name) {
            try {
                const bin = atob(resp.b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const face = new FontFace(resp.name, bytes.buffer);
                await face.load();
                document.fonts.add(face);
                customFontLoaded = pipeline.renderFont;
                setRenderTuning({ font: `"${resp.name}", ${fontStackFor(pipeline.targetLang)}` });
            } catch (e) {
                console.warn('[mt] custom font failed, using default:', e);
            }
        } else if (resp && !resp.ok) {
            console.warn('[mt] custom font unavailable:', resp.error);
        }
    }
    return pipeline;
}

// ---- chapter-scoped memory ----

// Context is chapter-scoped — but "chapter" means STORY, not URL: page-turns
// (/chapter/{id}/{page}, trailing /N, ?page=) share one key so queue +
// context survive flipping 1→2→3, while a new story (path/query/hash) gets
// a fresh key. Pure logic lives in normalizeChapterKey (unit-tested).
export function chapterKey(): string {
    return normalizeChapterKey(location.origin, location.pathname, location.search, location.hash);
}

export let context: ContextState = EMPTY_CONTEXT;
export function setContext(c: ContextState): void { context = c; }
export let contextChapter = chapterKey();
let contextLoaded = false;
export let shareContext = true; // in-page toggle; off = translate each page standalone
export function setShareContext(v: boolean): void { shareContext = v; }

// chapter id → manga id (for the cross-chapter book). Resolved once per
// chapter change; a failure falls back to the old chapter-scoped behavior.
let mangaId: string | null = null;
let mangaIdTried = false;

export async function resolveMangaId(): Promise<string | null> {
    if (mangaIdTried) return mangaId;
    mangaIdTried = true;
    // MangaDex-only: anywhere else the regex misses and the book stays
    // chapter-scoped — skip the network call entirely instead of trying it
    if (!/(^|\.)mangadex\./.test(location.hostname)) return null;
    const m = location.pathname.match(/^\/chapter\/([^/]+)/);
    if (!m) return null;
    try {
        const resp = await fetch(`https://api.mangadex.org/chapter/${m[1]}?includes%5B%5D=manga`);
        const data = await resp.json();
        const rel = (data?.data?.relationships ?? []).find((r: { type: string }) => r.type === 'manga');
        if (rel?.id) mangaId = rel.id as string;
    } catch { /* offline/API fail → book stays chapter-scoped */ }
    return mangaId;
}

// The book is manga-scoped (storage.local, survives restarts) when
// cross-chapter is on and the manga resolved; otherwise per-chapter session.
function bookKey(): string {
    return pipeline.crossChapter && mangaId ? `mtBook:${mangaId}` : `mtCtx:${chapterKey()}`;
}

export async function loadContext(): Promise<void> {
    if (contextLoaded) return;
    contextLoaded = true;
    await resolveMangaId();
    const key = `mtCtx:${chapterKey()}`;
    const stored = await sessGet([key, `mtShare:${chapterKey()}`]);
    if (stored[`mtShare:${chapterKey()}`] === false) shareContext = false;
    // pairs (narrative flow) are ALWAYS chapter-scoped — they die with the chapter
    let pairs: [string, string][] = [];
    if (stored[key]) {
        try {
            const v = JSON.parse(stored[key] as string) as { ctx: ContextState };
            if (Array.isArray(v.ctx?.pairs)) pairs = v.ctx.pairs;
        } catch { /* corrupt — start fresh */ }
    }
    // the character book follows bookKey()
    let characters: CharacterEntry[] = [];
    try {
        const bk = bookKey();
        const raw = bk.startsWith('mtBook:')
            ? (await chrome.storage.local.get(bk))[bk]
            : JSON.parse((await sessGet(bk))[bk] as string ?? '{}')?.ctx?.characters;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) characters = parsed as CharacterEntry[];
    } catch { /* corrupt — start fresh */ }
    context = { pairs, characters };
}

export async function saveContext(): Promise<void> {
    const key = `mtCtx:${chapterKey()}`;
    // pairs stay chapter-scoped; the book follows bookKey()
    await sessSet({
        [key]: JSON.stringify({ chapter: chapterKey(), context: { pairs: context.pairs, characters: [] } }),
        [`mtShare:${chapterKey()}`]: shareContext,
    });
    const bk = bookKey();
    if (bk.startsWith('mtBook:')) {
        await chrome.storage.local.set({ [bk]: JSON.stringify(context.characters) });
    } else {
        await sessSet({ [bk]: JSON.stringify({ chapter: chapterKey(), context }) });
    }
    // surface the character book to the options page
    if (context.characters.length) {
        chrome.runtime.sendMessage({ type: 'mt:char-book', book: context.characters }).catch(() => {});
    }
}

export function resetContextIfNewChapter() {
    if (chapterKey() !== contextChapter) {
        contextChapter = chapterKey();
        // pairs die with the chapter; the BOOK survives when cross-chapter is on
        const keepBook = pipeline.crossChapter && !!mangaId ? context.characters : [];
        context = { pairs: [], characters: keepBook };
        contextLoaded = false;
        shareContext = true;
        resolveMangaId(); // resolve for the new chapter (async, non-blocking)
    }
}

// ---- theme (shared by pill, chars panel, toasts) ----

// In-page UI shares the popup/options theme so all surfaces read as one
// product on any host site. `mtTheme` storage ('system' = OS default) picks
// the palette; options page saves it, this module applies it live.
// No shadow DOM on purpose:
// ponytail: three fixed divs with inline styles; isolate fully if a host's
// CSS is ever proven to break them.
export const MT_DARK = {
    bg: '#151722', border: 'rgba(255,255,255,.12)', text: '#e8eaf2',
    muted: '#a3a8c0', accent: '#8b5cf6', ok: '#4ade80', err: '#f87171',
    field: '#1c1f2e',
} as const;
export const MT_LIGHT = {
    bg: '#ffffff', border: 'rgba(20,22,40,.14)', text: '#191b26',
    muted: '#676d85', accent: '#7c3aed', ok: '#15803d', err: '#dc2626',
    field: '#eef0f7',
} as const;
export let mtPal: typeof MT_DARK | typeof MT_LIGHT = MT_DARK; // active palette (swapped in place by applyTheme)
export type MtState = 'busy' | 'done' | 'error' | 'idle';
export const mtDot = (st: MtState): string =>
    st === 'busy' ? mtPal.accent : st === 'done' ? mtPal.ok : st === 'error' ? mtPal.err : mtPal.muted;

// theme application: swap the palette + repaint the pill; module-level
// listener list (chars panel registers for its own repaint)
const themeListeners: (() => void)[] = [];
export function onThemeChange(fn: () => void): void { themeListeners.push(fn); }
export function applyTheme(t: string): void {
    const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    mtPal = dark ? MT_DARK : MT_LIGHT;
    if (ui) {
        ui.style.background = mtPal.bg;
        ui.style.color = mtPal.text;
        ui.style.border = `1px solid ${mtPal.border}`;
    }
    for (const fn of themeListeners) fn();
}

export async function loadTheme(): Promise<void> {
    const { mtTheme } = await chrome.storage.local.get('mtTheme');
    applyTheme((mtTheme as string | undefined) ?? 'system');
}

// ---- session usage (popup box) ----
export const sessionUsage = { pages: 0, inTok: 0, outTok: 0, cachedInTok: 0 };
export let lastPageUsage: { inTok?: number; outTok?: number; cachedInTok?: number; ms?: number; calls?: number } | null = null;
export function setLastPageUsage(u: typeof lastPageUsage): void { lastPageUsage = u; }

export type { EpisodeManifest };
