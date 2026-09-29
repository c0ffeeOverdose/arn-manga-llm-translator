import { sessGet, sessSet, sessRemove } from '../storage-session';
import { readRecord, writeRecord, blobDataUrl } from '../chapter/store';
import { artifactKey, runnerHtml, type HostConfig, type ChapterArtifact } from '../chapter/protocol';
import type { ChapterProgress, ChapterStart } from '../chapter/model';
import { chapterContext } from './chapter-context';
import { RENDER_GEN } from '../content/render';
import { createRunner, runnerKind, runnerUrl, type ChapterRunner } from '../chapter/runner';

interface Binding { id: string; kind: 'offscreen' | 'background'; chapter: string }
const bindingKey = (tab: number) => `mtChapterTab:${tab}`;
const starts = new Map<number, Promise<unknown>>();
// The reader's frame request must be the ONLY init attempt, or a duplicate overrides the
// real session id in storage.session and orphans the runner.
const frameAttempts = new Map<number, string>();
let runner: ChapterRunner = createRunner();
let liveId = '';
async function binding(tab: number): Promise<Binding | undefined> {
    return (await sessGet(bindingKey(tab)))[bindingKey(tab)] as Binding | undefined;
}
// Only a runner context may speak for a session. The id must name a stored config, and the
// sender must be either the offscreen document or our own background page (Firefox) — a
// content script or another page is rejected. Offscreen documents have no sender.tab, so
// the check is on the URL/context, never on a tab.
async function authenticatedRunner(sender: chrome.runtime.MessageSender, msg: { id?: unknown }): Promise<HostConfig | undefined> {
    const id = String(msg?.id ?? '');
    if (!id) return;
    if (!isRunnerSender(sender)) return;
    const config = await readRecord<HostConfig>(`host:${id}`);
    return config && config.id === id ? config : undefined;
}
export function isChapterRunnerSender(sender: chrome.runtime.MessageSender): boolean {
    return isRunnerSender(sender);
}
function isRunnerSender(sender: chrome.runtime.MessageSender): boolean {
    if (sender.id !== chrome.runtime.id) return false;
    const contexts = (chrome.runtime as unknown as { getContexts?: (f?: unknown) => Promise<{ contextType?: string; documentUrl?: string }[]> }).getContexts;
    // Chromium: the offscreen document is the only allowed non-tab context.
    if (sender.tab) return false;
    if (runnerKind() === 'background') return true; // Firefox: our background page IS the runner
    return !contexts || sender.url?.startsWith(runnerUrl()) === true;
}
export async function chapterReaderUrl(sender: chrome.runtime.MessageSender): Promise<string> {
    // A fetch proxied on behalf of the runner has no tab: it must inherit the reader's
    // origin so the private-network policy compares against the page the user is reading.
    if (isRunnerSender(sender)) {
        const id = liveId;
        return id ? (await readRecord<HostConfig>(`host:${id}`))?.readerUrl ?? '' : '';
    }
    return sender.url ?? '';
}
async function start(tab: number, data: ChapterStart): Promise<unknown> {
    const old = await binding(tab);
    if (old) {
        const status = await readRecord<ChapterProgress>(`status:${old.id}`);
        if (old.chapter === data.chapter && status && ['running', 'waiting'].includes(status.phase) && await runner.live(old.id)) {
            return { ok: true, id: old.id, status };
        }
        await runner.stop(old.id);
    }
    const id = crypto.randomUUID();
    const config: HostConfig = { ...data, id, readerTab: tab, kind: runnerKind() };
    for (const seed of data.seeds ?? []) {
        const entry = { ...seed.entry, mask: seed.entry.mask ? { ...seed.entry.mask,
            data: Uint8Array.from(atob(seed.maskData), c => c.charCodeAt(0)).buffer } : undefined };
        await writeRecord(artifactKey(id, seed.page), { entry, blob: await (await fetch(seed.image)).blob(),
            at: Date.now(), signature: JSON.stringify(data.pipeline) + ':' + RENDER_GEN } satisfies ChapterArtifact);
    }
    delete config.seeds;
    await writeRecord(`host:${id}`, config);
    liveId = id;
    await sessSet({ [bindingKey(tab)]: { id, kind: config.kind, chapter: data.chapter } });
    await runner.ensure(id);
    return { ok: true, id, total: data.pages.length };
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id || typeof msg?.type !== 'string' || !msg.type.startsWith('mt:chapter-')) return;
    // The runner asks which session it owns; the answer is also what starts it pumping.
    if (msg.type === 'mt:chapter-runner-boot') {
        if (!isRunnerSender(sender)) return;
        respond({ ok: true, id: liveId || undefined });
        return true;
    }
    if (msg.type === 'mt:chapter-command') return;
    const work = async () => {
        if (msg.type === 'mt:chapter-host-init' || msg.type === 'mt:chapter-publish' || msg.type === 'mt:chapter-context') {
            const config = await authenticatedRunner(sender, msg);
            if (!config) return { ok: false, error: 'Unknown chapter session' };
            if (msg.type === 'mt:chapter-host-init') return { ok: true, config };
            if (msg.type === 'mt:chapter-context') {
                const context = await chapterContext(config.chapter, config.bookKey, config.pipeline.useCharacters,
                    config.pipeline.contextPairs, msg.entries, msg.beforeOrder);
                if (msg.entries) void chrome.tabs.sendMessage(config.readerTab, { type: 'mt:chapter-context-updated', chapter: config.chapter, context }).catch(() => {});
                return { ok: true, context };
            }
            const status = msg.status as ChapterProgress;
            if (status.id !== config.id || status.chapter !== config.chapter) return { ok: false };
            await writeRecord(`status:${config.id}`, status);
            void chrome.tabs.sendMessage(config.readerTab, { type: 'mt:chapter-update', status }).catch(() => {});
            return { ok: true };
        }
        const tab = sender.tab?.id;
        if (tab === undefined) return { ok: false, error: 'Open a manga reader first' };
        if (sender.frameId !== 0) {
            if (msg.type !== 'mt:chapter-status' && msg.type !== 'mt:chapter-result') return { ok: false, error: 'Reader frame changed' };
            const b = await binding(tab);
            return b ? { ok: true, status: null, result: null } : { ok: false, error: 'No chapter session for this reader' };
        }
        if (msg.type === 'mt:chapter-start') {
            const data = msg.data as ChapterStart;
            if (!data?.pages?.length || data.readerUrl !== sender.url) return { ok: false, error: 'Reader changed; try again' };
            const previous = frameAttempts.get(tab);
            if (previous === sender.url) return { ok: false, error: 'Chapter translation is already running in this reader' };
            if (previous) {
                const stale = await binding(tab);
                if (stale) await runner.stop(stale.id);
            }
            frameAttempts.set(tab, sender.url);
            const pending = starts.get(tab);
            if (pending) return pending;
            const p = start(tab, data).finally(() => starts.delete(tab));
            starts.set(tab, p);
            return p;
        }
        const b = await binding(tab);
        if (!b || b.chapter !== msg.chapter) return { ok: true, status: null };
        if (msg.type === 'mt:chapter-status') {
            const status = await readRecord<ChapterProgress>(`status:${b.id}`);
            if (status && ['running', 'waiting', 'stopping'].includes(status.phase) && !(await runner.live(b.id))) {
                status.phase = 'error';
                status.message = 'Translation paused — the background task stopped; start again to continue';
                status.inflight = 0;
                await writeRecord(`status:${b.id}`, status);
            }
            return { ok: true, status, id: b.id };
        }
        if (msg.type === 'mt:chapter-result') {
            const artifact = await readRecord<ChapterArtifact>(artifactKey(b.id, msg.page));
            if (!artifact) return { ok: true, result: null };
            const { mask, patches: _patches, ...entry } = artifact.entry;
            return { ok: true, result: { image: await blobDataUrl(artifact.blob), entry, signature: artifact.signature,
                mask: mask ? { w: mask.w, h: mask.h, data: await blobDataUrl(new Blob([mask.data])) } : undefined } };
        }
        if (msg.type === 'mt:chapter-control') {
            if (msg.command === 'stop') {
                // The runner owns the cancel; closing it early would strand the drain.
                await chrome.runtime.sendMessage({ type: 'mt:chapter-command', id: b.id, command: msg.command }).catch(() => {});
                return { ok: true };
            }
            return await chrome.runtime.sendMessage({ type: 'mt:chapter-command', id: b.id,
                command: msg.command, page: msg.page, pages: msg.pages, completeManifest: msg.completeManifest });
        }
        return { ok: false };
    };
    work().then(respond, e => respond({ ok: false, error: (e as Error).message }));
    return true;
});

chrome.tabs.onRemoved.addListener(tab => {
    void (async () => {
        const b = await binding(tab);
        if (b) {
            await runner.stop(b.id);
            await sessRemove(bindingKey(tab));
        }
    })();
});

// A runner URL change on hot reload must not leave two live runners.
export function chapterRunnerPageUrl(): string { return runnerHtml(); }
