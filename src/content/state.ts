// Shared state hub: page registry, context/book, pipeline settings, theme, usage.
// Every module imports from here; nothing here imports from another content module.

import { EMPTY_CONTEXT, type ContextState, type CharacterEntry, type Mention, type RegionOutput, type PairLine } from '../llm/core';
import { DEFAULT_PIPELINE_SETTINGS, loadPipelineSettings, type PipelineSettings } from '../llm/pipeline-settings';
import { fontStackFor, setRenderTuning } from './render';
import { sessGet } from '../storage-session';
import { normalizeChapterKey, type EpisodeManifest } from './page-cache';
import type { DetectResult } from './detection';
import type { ImageIdentity } from '../image-identity';
import { cacheGeneration, cacheCurrent } from '../cache-generation';

declare const __BUILD_ID__: string; // injected by build.mjs — which build is this?

export interface PageState {
    cacheEpoch?: string;
    orig: string;
    translated: string;
    // extension-owned PNG copy of the original pixels for blob-URL readers (their URLs
    // die) — the only reliable way back for "Show original", minted while pixels are readable.
    origOwn?: string;
    debug?: string; // full-res boxes+badges+conf view on the TRANSLATED image
    debugOrig?: string; // same boxes on the ORIGINAL (Show original keeps its debug)
    det?: DetectResult;
    outputs?: RegionOutput[];
    mentions?: Mention[]; // page-level named people (folded into the book with outputs)
    // book/pairs exactly as they were BEFORE this page folded. rewindContextBefore restores
    // the snapshot on re-translate — exact, and survives a fresh session.
    bookBefore?: CharacterEntry[];
    pairsBefore?: PairLine[];
    hash?: string; // content hash of the ORIGINAL pixels — element-identity fallback
    image?: ImageIdentity;
    paintedImage?: ImageIdentity;
    // canvas pages only: no URL to re-read, so the first read is stashed (original bytes
    // for re-translate, translated bitmap for write-back)
    origBytes?: ArrayBuffer;
    translatedBmp?: ImageBitmap;
    // decoded-on-demand paint sources (Show original + debug frames) — closed with the page
    origBmp?: ImageBitmap;
    debugBmp?: ImageBitmap;
    debugOrigBmp?: ImageBitmap;
}

// A page is an <img> or a reader <canvas> — pixels in and pixels out, keyed by identity.
export type PageRef = { kind: 'img'; el: HTMLImageElement } | { kind: 'canvas'; el: HTMLCanvasElement; key: string; pageSrc?: string };

export const pages = new Map<string, PageState>();
// element binding: blob-rotating readers mint a fresh blob: URL per display, breaking
// URL-keyed identity. The element itself is the stable identity: every successful write
// binds element→state, and an unknown src is verified by content hash (match → alias +
// paint; mismatch = recycled node showing another page → drop the binding). WeakMap.
export let elStates = new WeakMap<Element, PageState>();
// in-flight / failed hash verifications per element+src (the 1s sweep must not re-hash them)
export let verifying = new WeakMap<Element, string>();
export let verifyFailed = new WeakMap<Element, string>();
// content index: original-pixel hash → translated state, for the fast repaint lane
// (known content under an unknown URL repaints with no queue/prep/fold). Same lifecycle
// as the pages map; memory-only, dies with the tab.
export const hashStates = new Map<string, { state: PageState; w: number; h: number }>();
// hash repaints already attempted per element+src with no index hit — genuinely-new pages
// stay on the queue path instead of re-hashing every sweep. Re-arms on src change.
export let hashMiss = new WeakMap<Element, string>();
export let hashPending = new WeakMap<Element, string>();
export function clearPageBindings(): void {
    pages.clear(); hashStates.clear();
    elStates = new WeakMap(); verifying = new WeakMap(); verifyFailed = new WeakMap();
    hashMiss = new WeakMap(); hashPending = new WeakMap();
}

// fastest truth first: a KNOWN url (orig, translated blob, retired alias) always wins over
// a possibly-stale element binding. refKey logic duplicated (one-liner) — no page-io import (cycle).
export function stateFor(ref: PageRef): PageState | undefined {
    let key: string;
    if (ref.kind === 'canvas') key = ref.pageSrc ?? ref.key;
    else {
        const live = ref.el.currentSrc || ref.el.src;
        const ex = pages.get(live);
        key = ex ? ex.orig : (retiredBlobs.get(live) ?? live);
    }
    const keyed = pages.get(key);
    if (keyed || ref.kind === 'canvas') return keyed;
    const bound = elStates.get(ref.el);
    const live = ref.el.currentSrc || ref.el.src;
    return bound && [bound.orig, bound.origOwn, bound.translated, bound.debug, bound.debugOrig].includes(live) ? bound : undefined;
}

// retired blob URLs: unregPage deletes live keys, but elements still showing an old blob
// must keep resolving to their page — else re-translate fetches the dead blob. Bounded.
export const retiredBlobs = new Map<string, string>();
const RETIRED_MAX = 50;
export function retireBlob(blob: string | undefined, orig: string): void {
    if (!blob || !blob.startsWith('blob:')) return;
    retiredBlobs.delete(blob);
    retiredBlobs.set(blob, orig);
    if (retiredBlobs.size > RETIRED_MAX) retiredBlobs.delete(retiredBlobs.keys().next().value!);
}

export function regPage(state: PageState): void {
    if (!cacheCurrent(state.cacheEpoch ?? cacheGeneration())) return;
    pages.set(state.orig, state);
    pages.set(state.translated, state);
    if (state.origOwn) pages.set(state.origOwn, state);
    if (state.debug) pages.set(state.debug, state);
    if (state.debugOrig) pages.set(state.debugOrig, state);
    // content index for the fast repaint lane: same-pixel pages repaint without queue/prep/fold
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
// debug overlay (boxes + badges + conf): session-level, persisted under its own key
export let debugOn = false;
export function setDebugOn(v: boolean): void { debugOn = v; }
// 'auto' = show translations as pages finish (default); 'original' = the user asked for
// originals — jobs finishing later must NOT flip it back
export let overlayChoice: 'auto' | 'original' = 'auto';
export function setOverlayChoice(v: 'auto' | 'original'): void { overlayChoice = v; }
export let ui: HTMLDivElement | null = null;
export function setUi(v: HTMLDivElement | null): void { ui = v; }

export let pipeline: PipelineSettings = { ...DEFAULT_PIPELINE_SETTINGS };
let customFontLoaded = ''; // font-store id whose FontFace is already on document.fonts

export async function loadPipeline(): Promise<PipelineSettings> {
    if (hostIdentity) return pipeline;
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
    // user-selected render font: fetch bytes from the background, register a FontFace FIRST
    // in the stack — missing glyphs fall through to the per-language default
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

// Context is chapter-scoped — but "chapter" means STORY, not URL: page-turns share one key
// so queue + context survive flipping pages, while a new story gets a fresh key.
// Pure logic lives in normalizeChapterKey (unit-tested).
export function chapterKey(): string {
    if (hostIdentity) return hostIdentity.chapter;
    return normalizeChapterKey(location.origin, location.pathname, location.search, location.hash);
}

export let context: ContextState = EMPTY_CONTEXT;
let savedContext: ContextState = structuredClone(EMPTY_CONTEXT);
let hostIdentity: { chapter: string; bookKey: string } | null = null;
export function configureChapterHost(chapter: string, book: string, settings: PipelineSettings, ctx: ContextState): void {
    hostIdentity = { chapter, bookKey: book };
    pipeline = settings;
    context = structuredClone(ctx);
    savedContext = structuredClone(ctx);
    contextChapter = chapter;
    contextLoaded = true;
    setRenderTuning({ minFont: pipeline.minFont, letterSpacing: pipeline.letterSpacing,
        verticalThreshold: pipeline.verticalThreshold, font: fontStackFor(pipeline.targetLang),
        textColor: pipeline.textColor, strokeColor: pipeline.strokeColor,
        textStroke: pipeline.textStroke, textScale: pipeline.textScale });
}
export function setContext(c: ContextState): void { context = c; }
export let contextChapter = chapterKey();
let contextLoaded = false;
let contextLoading: { chapter: string; promise: Promise<void> } | null = null;
let contextSaveRevision = 0;
export let shareContext = true; // in-page toggle; off = translate each page standalone
export function setShareContext(v: boolean): void { shareContext = v; }

// chapter id → manga id (for the cross-chapter book). Resolved once per
// chapter change; a failure falls back to the old chapter-scoped behavior.
let mangaId: string | null = null;
let mangaIdTried = false;

export async function resolveMangaId(): Promise<string | null> {
    if (mangaIdTried) return mangaId;
    mangaIdTried = true;
    // MangaDex-only: anywhere else the regex misses and the book stays chapter-scoped
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

// The book is manga-scoped (storage.local, survives restarts) when cross-chapter is on and
// the manga resolved; otherwise per-chapter session.
export function bookKey(): string {
    if (hostIdentity) return hostIdentity.bookKey;
    return pipeline.crossChapter && mangaId ? `mtBook:${mangaId}` : `mtCtx:${chapterKey()}`;
}

export async function loadContext(): Promise<void> {
    if (contextLoaded) return;
    const chapter = chapterKey();
    if (contextLoading?.chapter === chapter) return contextLoading.promise;
    const promise = readContext(chapter).finally(() => {
        if (contextLoading?.promise === promise) contextLoading = null;
    });
    contextLoading = { chapter, promise };
    return promise;
}
async function readContext(chapter: string): Promise<void> {
    await resolveMangaId();
    if (chapterKey() !== chapter) return;
    const key = `mtCtx:${chapter}`;
    const bk = bookKey();
    const stored = await sessGet([key, `mtShare:${chapter}`]);
    // pairs (narrative flow) are ALWAYS chapter-scoped — they die with the chapter
    let pairs: PairLine[] = [];
    if (stored[key]) {
        try {
            const v = JSON.parse(stored[key] as string) as { ctx?: ContextState; context?: ContextState };
            const ctx = v.context ?? v.ctx;
            if (Array.isArray(ctx?.pairs)) pairs = ctx.pairs;
        } catch { /* corrupt — start fresh */ }
    }
    // the character book follows bookKey()
    let characters: CharacterEntry[] = [];
    try {
        const entry = bk.startsWith('mtBook:') ? null : JSON.parse((await sessGet(bk))[bk] as string ?? '{}');
        const raw = bk.startsWith('mtBook:')
            ? (await chrome.storage.local.get(bk))[bk]
            : (entry.context ?? entry.ctx)?.characters;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) characters = parsed as CharacterEntry[];
    } catch { /* corrupt — start fresh */ }
    if (chapterKey() !== chapter) return;
    if (stored[`mtShare:${chapter}`] === false) shareContext = false;
    context = { pairs, characters };
    savedContext = structuredClone(context);
    contextLoaded = true;
}

export async function saveContext(): Promise<void> {
    const chapter = chapterKey();
    const revision = ++contextSaveRevision;
    const result = await chrome.runtime.sendMessage({ type: 'mt:context-save', chapter,
        bookKey: bookKey(), before: savedContext, context, share: shareContext });
    if (!result?.ok) throw new Error(result?.error || 'Could not save character context');
    if (chapterKey() !== chapter || revision !== contextSaveRevision) return;
    context = result.context;
    savedContext = structuredClone(context);
    // surface the character book to the options page
    if (context.characters.length) {
        chrome.runtime.sendMessage({ type: 'mt:char-book', book: context.characters }).catch(() => {});
    }
}

export function acceptChapterContext(ctx: ContextState): void {
    context = structuredClone(ctx);
    savedContext = structuredClone(ctx);
    contextLoaded = true;
}

export function resetContextIfNewChapter() {
    if (chapterKey() !== contextChapter) {
        contextChapter = chapterKey();
        // pairs die with the chapter; the BOOK survives when cross-chapter is on
        const keepBook = pipeline.crossChapter && !!mangaId ? context.characters : [];
        context = { pairs: [], characters: keepBook };
        contextLoaded = false;
        contextSaveRevision++;
        shareContext = true;
        mangaId = null;
        mangaIdTried = false;
        resolveMangaId(); // resolve for the new chapter (async, non-blocking)
    }
}

// ---- theme (shared by pill, chars panel, toasts) ----

// In-page UI shares the popup/options theme. `mtTheme` storage ('system' = OS default).
// No shadow DOM: three fixed divs with inline styles.
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

// theme application: swap the palette + repaint the pill (chars panel registers its own repaint)
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
