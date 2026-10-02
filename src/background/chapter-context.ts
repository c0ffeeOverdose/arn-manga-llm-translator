import { EMPTY_CONTEXT, type ContextState } from '../llm/core';
import { sessGet, sessSet } from '../storage-session';
import { recordEdits, replaceContribution, replayLedger, type ContextLedger } from '../chapter/context';
import type { Contribution } from '../chapter/model';

interface Ledger extends ContextLedger { bookKey: string; learn: boolean; maxPairs: number; maxChars?: number; last?: ContextState }
let writes: Promise<unknown> = Promise.resolve();
export function contextTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const result = writes.then(fn);
    writes = result.catch(() => {});
    return result;
}
export async function storedContext(chapter: string, bookKey: string): Promise<ContextState> {
    const key = `mtCtx:${chapter}`;
    let ctx = structuredClone(EMPTY_CONTEXT);
    try {
        const raw = JSON.parse((await sessGet(key))[key] as string || '{}');
        const c = raw.context ?? raw.ctx;
        if (Array.isArray(c?.pairs) && Array.isArray(c?.characters)) ctx = c;
    } catch { /* legacy/corrupt session */ }
    if (bookKey.startsWith('mtBook:')) {
        const raw = (await chrome.storage.local.get(bookKey))[bookKey];
        try {
            const chars = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (Array.isArray(chars)) ctx.characters = chars;
        } catch { /* keep chapter fallback */ }
    }
    return ctx;
}
async function persist(chapter: string, bookKey: string, ctx: ContextState, ledger?: Ledger, share = true): Promise<void> {
    if (ledger) ledger.last = structuredClone(ctx);
    await sessSet({
        [`mtCtx:${chapter}`]: JSON.stringify({ chapter, context: ctx }),
        [`mtShare:${chapter}`]: share,
        ...(ledger ? { [`mtChapterLedger:${chapter}`]: ledger } : {}),
    });
    if (bookKey.startsWith('mtBook:')) await chrome.storage.local.set({ [bookKey]: JSON.stringify(ctx.characters) });
}
export async function chapterContext(chapter: string, bookKey: string, learn: boolean, maxPairs: number, maxChars: number,
    entries?: Contribution[], beforeOrder?: number): Promise<ContextState> {
    return contextTransaction(async () => {
        const key = `mtChapterLedger:${chapter}`;
        let ledger = (await sessGet(key))[key] as Ledger | undefined;
        if (!ledger || ledger.bookKey !== bookKey) {
            ledger = { base: await storedContext(chapter, bookKey), entries: [], edits: [], bookKey, learn, maxPairs, maxChars };
        } else if (ledger.last) {
            recordEdits(ledger, ledger.last, await storedContext(chapter, bookKey));
        }
        ledger.learn = learn;
        ledger.maxPairs = maxPairs;
        ledger.maxChars = maxChars;
        for (const entry of entries ?? []) replaceContribution(ledger, entry);
        const ctx = replayLedger(ledger, learn, maxPairs);
        await persist(chapter, bookKey, ctx, ledger);
        return beforeOrder === undefined ? ctx : replayLedger(ledger, learn, maxPairs, beforeOrder);
    });
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id || msg?.type !== 'mt:context-save') return;
    const chapter = String(msg.chapter ?? '');
    if (!chapter || !Array.isArray(msg.context?.characters) || !Array.isArray(msg.context?.pairs)) return;
    contextTransaction(async () => {
        const key = `mtChapterLedger:${chapter}`;
        const ledger = (await sessGet(key))[key] as Ledger | undefined;
        let ctx: ContextState = msg.context;
        if (ledger) {
            recordEdits(ledger, msg.before ?? await storedContext(chapter, ledger.bookKey), ctx);
            ctx = replayLedger(ledger, ledger.learn, ledger.maxPairs);
        }
        await persist(chapter, ledger?.bookKey ?? String(msg.bookKey), ctx, ledger, msg.share !== false);
        return { ok: true, context: ctx };
    }).then(respond, e => respond({ ok: false, error: String(e) }));
    return true;
});
