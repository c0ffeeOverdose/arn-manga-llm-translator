import { sessGet, sessSet, sessRemove } from '../storage-session';
import { readRecord, writeRecord, blobDataUrl } from '../chapter/store';
import { hostUrl, artifactKey, type HostConfig, type ChapterArtifact } from '../chapter/protocol';
import type { ChapterProgress, ChapterStart } from '../chapter/model';
import { chapterContext } from './chapter-context';
import { RENDER_GEN } from '../content/render';

interface Binding { id: string; hostTab?: number; chapter: string }
const bindingKey = (tab: number) => `mtChapterTab:${tab}`;
const starts = new Map<number, Promise<unknown>>();
// The reader's frame request must be the ONLY init attempt, or a duplicate
// overrides the real host's id in storage.session and orphans it.
const frameAttempts = new Map<number, string>();
async function binding(tab: number): Promise<Binding | undefined> {
    return (await sessGet(bindingKey(tab)))[bindingKey(tab)] as Binding | undefined;
}
async function authenticatedHost(sender: chrome.runtime.MessageSender, id: string): Promise<HostConfig | undefined> {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(hostUrl() + '#')) return;
    const config = await readRecord<HostConfig>(`host:${id}`);
    if (config && sender.url === hostUrl() + '#' + id && (config.hostTab === undefined || !sender.tab || sender.tab.id === config.hostTab)) return config;
}
export async function chapterReaderUrl(sender: chrome.runtime.MessageSender): Promise<string> {
    if (!sender.url?.startsWith(hostUrl() + '#')) return sender.url ?? '';
    return (await authenticatedHost(sender, sender.url.slice(hostUrl().length + 1)))?.readerUrl ?? '';
}
async function start(tab: number, data: ChapterStart): Promise<unknown> {
    const old = await binding(tab);
    if (old) {
        const status = await readRecord<ChapterProgress>(`status:${old.id}`);
        if (old.chapter === data.chapter && status && ['running', 'waiting'].includes(status.phase)) {
            try { if (old.hostTab !== undefined) { await chrome.tabs.get(old.hostTab); return { ok: true, id: old.id, status }; } } catch { /* host was closed */ }
        }
        if (old.hostTab !== undefined) await chrome.tabs.remove(old.hostTab).catch(() => {});
    }
    const id = crypto.randomUUID();
    const config: HostConfig = { ...data, id, readerTab: tab };
    for (const seed of data.seeds ?? []) {
        const entry = { ...seed.entry, mask: seed.entry.mask ? { ...seed.entry.mask,
            data: Uint8Array.from(atob(seed.maskData), c => c.charCodeAt(0)).buffer } : undefined };
        await writeRecord(artifactKey(id, seed.page), { entry, blob: await (await fetch(seed.image)).blob(),
            at: Date.now(), signature: JSON.stringify(data.pipeline) + ':' + RENDER_GEN } satisfies ChapterArtifact);
    }
    delete config.seeds;
    await writeRecord(`host:${id}`, config);
    await sessSet({ [bindingKey(tab)]: { id, chapter: data.chapter } });
    const host = await chrome.tabs.create({ url: hostUrl() + '#' + id, active: false, openerTabId: tab });
    config.hostTab = host.id;
    await writeRecord(`host:${id}`, config);
    await sessSet({ [bindingKey(tab)]: { id, hostTab: host.id, chapter: data.chapter } });
    if (host.id !== undefined) void chrome.tabs.update(host.id, { autoDiscardable: false }).catch(() => {});
    return { ok: true, id, total: data.pages.length };
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id || typeof msg?.type !== 'string' || !msg.type.startsWith('mt:chapter-') || msg.type === 'mt:chapter-command') return;
    const work = async () => {
        if (msg.type === 'mt:chapter-host-init' || msg.type === 'mt:chapter-publish' || msg.type === 'mt:chapter-context') {
            const config = await authenticatedHost(sender, msg.id);
            if (!config) return { ok: false, error: 'Unknown chapter host' };
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
                // new document in the same tab — the old frame's request is stale
                const stale = await binding(tab);
                if (stale?.hostTab !== undefined) await chrome.tabs.remove(stale.hostTab).catch(() => {});
            }            frameAttempts.set(tab, sender.url);
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
            if (b.hostTab !== undefined && status && ['running', 'waiting', 'stopping'].includes(status.phase)) {
                try { await chrome.tabs.get(b.hostTab); } catch {
                    status.phase = 'error';
                    status.message = 'Translation paused — the processing tab was closed; start again to continue';
                    status.inflight = 0;
                    await writeRecord(`status:${b.id}`, status);
                }
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
            if (b.hostTab !== undefined) await chrome.tabs.remove(b.hostTab).catch(() => {});
            await sessRemove(bindingKey(tab));
        }
    })();
});
