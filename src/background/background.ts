// Background service worker: LLM translation (BYOK). Detection runs in the
// content script's iframe (src/iframe) — this worker owns LLM calls only.

import { callLLM, toMtError, DEFAULT_BASES, DEFAULT_SETTINGS, type LLMSettings, type LlmUsage } from '../llm/adapters';
import { buildPrompt, parseResponse, updateContext, applyOverrides, EMPTY_CONTEXT, type ContextState, type RegionInput, type RegionOutput, type Mention } from '../llm/core';
import { DEFAULT_PIPELINE_SETTINGS, loadPipelineSettings, type PipelineSettings } from '../llm/pipeline-settings';

// content scripts can't touch storage.session by default — open it up.
// ?. chain: setAccessLevel doesn't exist on older Firefox (sess* falls back to
// memory there), and a sync throw here would kill the worker before it starts.
chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })?.catch(() => {});

interface TranslateMsg {
    type: 'mt:translate';
    imagesB64?: string[];     // [0] = annotated full page, [1..n] = region crops (crops mode: crops only; ocr: absent)
    regions: RegionInput[];
    context: ContextState;
    vision: boolean;          // false in OCR mode (no images sent)
    textOnly?: boolean;       // crops mode: no full-page image
    ocr?: boolean;            // OCR mode: source text provided per region
    pageW: number;            // px — for validating VLM-reported extra regions
    pageH: number;
    cacheKey?: string;        // stable per manga — routes provider-side prompt caching
}
interface TestLlmMsg {
    type: 'mt:test-llm';
    settings: LLMSettings;
}
interface TestCloudMsg {
    type: 'mt:test-cloud';
    endpoint: string;
    key: string;
}
interface CloudPageMsg {
    type: 'mt:cloud-page';
    endpoint: string;
    key: string;
    confThr: number;
    minSize: number;
    jpegB64: string; // base64 JPEG (raw bytes don't survive MV3 messaging)
}
interface FontGetMsg {
    type: 'mt:font-get';
    id: string;               // font-store id
}
type BgMsg = TranslateMsg | TestLlmMsg | TestCloudMsg | CloudPageMsg | CharBookMsg | FontGetMsg | { type: 'ping' } | { type: 'mt:screenshot' } | { type: 'mt:hotlink-rule'; origin: string } | { type: 'mt:fetch-image'; url: string } | { type: 'mt:worker-token'; nonce: string; token: string } | { type: 'mt:get-worker-token'; nonce: string };
interface CharBookMsg {
    type: 'mt:char-book';
    book: { desc: string; gender: 'M' | 'F' | '?'; source: 'user' | 'vlm' | 'speech'; name?: string }[];
}

async function getSettings(): Promise<LLMSettings & { useVision?: boolean }> {
    const { mtSettings } = await chrome.storage.local.get('mtSettings');
    return { ...DEFAULT_SETTINGS, ...(mtSettings ?? {}) };
}

async function getPipeline(): Promise<PipelineSettings> {
    const { mtPipeline } = await chrome.storage.local.get('mtPipeline');
    return loadPipelineSettings(mtPipeline);
}

// ArrayBuffer → base64 for MV3 message passing (JSON-serializes the channel)
function b64encode(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(bin);
}

chrome.runtime.onMessage.addListener((msg: BgMsg, sender, sendResponse) => {
    // defense-in-depth: today web pages can't reach this listener (no
    // externally_connectable), but a future manifest change shouldn't silently
    // expose the fetch/screenshot/storage handlers below
    if (sender.id && sender.id !== chrome.runtime.id) return;
    if (msg?.type === 'mt:worker-token') {
        // worker-iframe handshake: the token lives in storage.session keyed by
        // the worker's public nonce, where only extension contexts can reach it.
        // postMessage from the page carries the page origin, so page JS could
        // otherwise drive the worker's RPC (model delete/downloads, inference
        // abuse) unauthenticated. Nonce-keyed, NOT tab-keyed: extension pages
        // have no sender.tab, so a tab key collapses to one global slot that a
        // second tab or a hostile WAR embed could clobber (detection DoS).
        if (!/^[0-9a-f]{16}$/.test(msg.nonce ?? '') || !/^[0-9a-f]{32}$/.test(msg.token ?? '')) { sendResponse({ ok: false, error: 'bad handshake' }); return; }
        (async () => {
            const { sessSet, sessGet, sessRemove } = await import('../storage-session');
            // prune stale entries: every iframe load mints a fresh nonce and old
            // ones are dead forever — without a cap, a page reloading our iframe
            // (or embedding WAR copies) in a loop grows storage.session until quota
            const all = await sessGet(null);
            const keys = Object.keys(all).filter(k => k.startsWith('mtWorkerToken:'));
            if (keys.length >= 32) {
                await sessRemove(keys.slice(0, keys.length - 31).map(k => k.slice('mtWorkerToken:'.length)));
            }
            await sessSet({ ['mtWorkerToken:' + msg.nonce]: msg.token });
            sendResponse({ ok: true });
        })().catch(e => sendResponse({ ok: false, error: String(e) }));
        return true;
    }
    if (msg?.type === 'mt:get-worker-token') {
        if (!/^[0-9a-f]{16}$/.test(msg.nonce ?? '')) { sendResponse({ token: null }); return true; }
        (async () => {
            const { sessGet } = await import('../storage-session');
            const r = await sessGet('mtWorkerToken:' + msg.nonce);
            sendResponse({ token: (r['mtWorkerToken:' + msg.nonce] as string | undefined) ?? null });
        })().catch(e => sendResponse({ token: null, error: String(e) }));
        return true;
    }
    if (msg?.type === 'ping') {
        sendResponse({ ok: true, service: 'arn-manga-background' });
        return;
    }  if (msg?.type === 'mt:test-llm') {
        // text-only connectivity check: key + model + reachability. Image
        // support used to be probed here with a hardcoded JPEG, but the string
        // rotted once (silent truncation → invalid base64) and the test's job is
        // auth/reachability, not capability — translation-time errors carry the
        // "switch to Local OCR" hint instead (see toMtError).
        callLLM(msg.settings, 'Reply with exactly: pong', undefined, undefined, 'test')
            .then(reply => sendResponse({ ok: true, reply: reply.text.slice(0, 60) }))
            .catch(e => { const m = toMtError(e); sendResponse({ ok: false, error: `${m.message}${m.hint ? ` — ${m.hint}` : ''}` }); });
        return true;
    }
    if (msg?.type === 'mt:test-cloud') {
        // cloud inference check: reachability + auth + model readiness. Doubles
        // as a prewarm — the first call wakes a sleeping endpoint, so run this
        // from options before reading, not mid-chapter.
        (async () => {
            try {
                const base = String(msg.endpoint ?? '').replace(/\/$/, '');
                if (!/^https?:\/\//.test(base)) { sendResponse({ ok: false, error: 'Endpoint URL must start with http(s)://' }); return; }
                const t0 = Date.now();
                const ctrl = new AbortController();
                const to = setTimeout(() => ctrl.abort(), 120000);
                try {
                    const r = await fetch(`${base}/health`, {
                        headers: msg.key ? { Authorization: `Bearer ${msg.key}` } : {},
                        signal: ctrl.signal,
                    });
                    if (!r.ok) { sendResponse({ ok: false, error: `cloud HTTP ${r.status}` }); return; }
                    const j = await r.json().catch(() => ({}));
                    if (!j?.ok) { sendResponse({ ok: false, error: 'endpoint reports not-ready' }); return; }
                    sendResponse({ ok: true, ms: Date.now() - t0, ep: j?.ep ?? null });
                } finally {
                    clearTimeout(to);
                }
            } catch (e) {
                const m = e instanceof Error && e.name === 'AbortError' ? 'timed out (endpoint may be waking — retry in a minute)' : String((e as Error)?.message ?? e);
                sendResponse({ ok: false, error: m });
            }
        })();
        return true;
    }
    if (msg?.type === 'mt:cloud-page') {
        // content-script fetch is CORS-gated on the page origin (host permissions
        // don't lift it — same trap as mt:fetch-image), so the /v1/page POST
        // rides through here. 90s cap: past this, local fallback wins anyway.
        (async () => {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 90000);
            try {
                const base = String(msg.endpoint ?? '').replace(/\/$/, '');
                if (!/^https?:\/\//.test(base)) { sendResponse({ ok: false, error: 'Endpoint URL must start with http(s)://' }); return; }
                const bin = atob(msg.jpegB64 ?? '');
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const r = await fetch(
                    `${base}/v1/page?conf_thr=${msg.confThr}&min_size=${msg.minSize}`,
                    { method: 'POST', headers: { Authorization: `Bearer ${msg.key}`, 'Content-Type': 'image/jpeg' }, body: bytes, signal: ctrl.signal });
                if (!r.ok) { const t = await r.text().catch(() => ''); sendResponse({ ok: false, error: `cloud HTTP ${r.status}: ${t.slice(0, 160)}` }); return; }
                sendResponse({ ok: true, page: await r.json() });
            } catch (e) {
                const m = e instanceof Error && e.name === 'AbortError' ? 'cloud timed out after 90s' : String((e as Error)?.message ?? e);
                sendResponse({ ok: false, error: m });
            } finally {
                clearTimeout(to);
            }
        })();
        return true;
    }
    if (msg?.type === 'mt:char-book') {
        chrome.storage.local.set({ mtCharBook: msg.book })
            .then(() => sendResponse({ ok: true }))
            .catch(e => sendResponse({ ok: false, error: String(e) }));
        return true;
    }
    if (msg?.type === 'mt:font-get') {
        // content scripts can't read the extension-origin IndexedDB where fonts
        // live — hand the bytes over the RPC channel. MV3 message passing
        // JSON-serializes, so the ArrayBuffer travels as base64.
        (async () => {
            const { fontRead, fontName } = await import('../llm/font-store');
            try {
                const buf = await fontRead(msg.id);
                if (!buf) { sendResponse({ ok: false, error: `font not installed: ${msg.id}` }); return; }
                sendResponse({ ok: true, name: await fontName(msg.id), b64: b64encode(buf) });
            } catch (e) {
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true;
    }
    if (msg?.type === 'mt:screenshot') {
        // last-resort pixel source for CORS-blocked <img> / tainted canvas.
        // Chrome requires activeTab (granted by the popup/context-menu gesture
        // that queued this job) or <all_urls> for captureVisibleTab — host
        // permissions do NOT cover it (live-proven: an un-gestured call on an
        // https tab the extension fully hosts still throws "Either the
        // '<all_urls>' or 'activeTab' permission is required"). So auto-translate
        // can never capture (no gesture), only manual can. Double-gate beyond
        // that: the sender must be the ACTIVE tab of its own window, and the
        // capture pins that windowId — captureVisibleTab otherwise photographs
        // the last-focused window, so a backgrounded window's request would get
        // pixels of whatever the user is viewing elsewhere.
        (async () => {
            try {
                if (!sender.tab?.id || !sender.tab.windowId) throw new Error('no requesting tab');
                const [tab] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
                if (!tab || tab.id !== sender.tab.id) throw new Error('requesting tab is not visible');
                const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
                sendResponse({ ok: true, dataUrl });
            } catch (e) {
                sendResponse({ ok: false, error: String((e as Error)?.message ?? e) });
            }
        })();
        return true;
    }
    if (msg?.type === 'mt:hotlink-rule') {
        // hotlink-guarded CDNs (*.2xstorage.com 403s Referer-less SW
        // fetch): install a session rule stamping the page origin as Referer, so
        // the mt:fetch-image retry below succeeds. Session-only — gone on restart.
        // ONE atomic updateSessionRules call (remove+add): concurrent 403s from
        // parallel preps interleave separate calls and the second add throws
        // "duplicate ID" — leaving that prep rule-less and holeing its seam run.
        (async () => {
            try {
                // origin must parse and be a bare origin — it becomes a Referer value
                // (regexFilter stays hardcoded to the two hotlink CDNs regardless)
                if (typeof msg.origin !== 'string' || new URL(msg.origin).origin !== msg.origin) {
                    sendResponse({ ok: false, error: 'bad origin' }); return;
                }
                const { hotlinkRule, HOTLINK_RULE_ID } = await import('../content/page-cache');
                await chrome.declarativeNetRequest.updateSessionRules({
                    removeRuleIds: [HOTLINK_RULE_ID],
                    addRules: [hotlinkRule(msg.origin) as chrome.declarativeNetRequest.Rule],
                });
                sendResponse({ ok: true });
            } catch (e) {
                sendResponse({ ok: false, error: String((e as Error)?.message ?? e) });
            }
        })();
        return true;
    }
    if (msg?.type === 'mt:fetch-image') {
        // content-script fetch is CORS-gated on the PAGE origin (host permissions
        // don't lift it — some image servers send no ACAO) while the worker fetches
        // free of page CORS — proxy the bytes through here. URL policy first
        // (fetchImageBlocked): this fetch is CORS-exempt, so it must not become
        // a read-anything proxy for URLs a page plants in an <img>.
        (async () => {
            try {
                const { fetchImageBlocked } = await import('../content/page-cache');
                const blocked = fetchImageBlocked(msg.url, sender.url ?? '');
                if (blocked) { sendResponse({ ok: false, error: `proxy fetch blocked: ${blocked}` }); return; }
                const resp = await fetch(msg.url);
                // re-check the FINAL url: fetch follows redirects, and a public https
                // URL 302-ing to http://127.0.0.1/… would otherwise resurrect the
                // local-network readback the pre-fetch check exists to block
                const blocked2 = fetchImageBlocked(resp.url, sender.url ?? '');
                if (blocked2) { sendResponse({ ok: false, error: `proxy fetch blocked (redirect): ${blocked2}` }); return; }
                if (!resp.ok) { sendResponse({ ok: false, error: `image HTTP ${resp.status}` }); return; }
                sendResponse({ ok: true, b64: b64encode(await resp.arrayBuffer()) });
            } catch (e) {
                let host = '?';
                try { host = new URL(msg.url).hostname || '(local)'; } catch { /* keep ? */ }
                sendResponse({ ok: false, error: `proxy fetch ${host}: ${String((e as Error)?.message ?? e)}` });
            }
        })();
        return true;
    }
    if (msg?.type !== 'mt:translate') return;

    runTranslate(msg, sendResponse);
    return true; // async response
});

// Shared translate implementation for the classic sendResponse path and the
// mt-rpc port path below. Long async handler: on Firefox the event page can
// be suspended while a sendResponse is still pending (live-proven: reply
// vanished silently at ~30s) — port replies survive because an open port
// pins the page. Never rejects; failures come back as {ok:false}.
function runTranslate(msg: TranslateMsg, send: (r: unknown) => void) {
    (async () => {
        try {
            const settings = await getSettings();
            const pipeline = await getPipeline();
            // user gender overrides from the options page are law
            const { mtCharOverrides, mtDebug } = await chrome.storage.local.get(['mtCharOverrides', 'mtDebug']);
            const dbg = mtDebug === true; // one read per call — always fresh, no SW sleep/wake staleness
            // guard: a corrupt/absent context must not crash the pipeline
            const msgCtx = (msg.context && Array.isArray(msg.context.characters) && Array.isArray(msg.context.pairs))
                ? msg.context : EMPTY_CONTEXT;
            const ctx = applyOverrides(msgCtx, (mtCharOverrides ?? {}) as Record<string, { gender: 'M' | 'F' | '?'; name?: string }>);
            const vision = !msg.ocr && !!msg.imagesB64?.length;
            const prompt = buildPrompt(msg.regions, ctx, vision, {
                vlmAssisted: pipeline.vlmAssistedDetection && vision && !msg.textOnly,
                stylePrompt: pipeline.stylePrompt,
                targetLang: pipeline.targetLang,
                pageW: msg.pageW,
                pageH: msg.pageH,
                textOnly: msg.textOnly,
                ocr: msg.ocr,
                chars: pipeline.useCharacters,
                maxPairs: pipeline.contextPairs,
                transcribeSrc: pipeline.transcribeSrc,
            });
            if (dbg) console.log('[mt:bg] llm prompt', prompt);

            // LLM call with strategic retry: 429/5xx/network get backoff retries
            // (a page costing 2 retries still beats failing the whole job);
            // auth/quota errors fail fast — retrying can't fix them.
            const callWithRetry = async (p: string, imgs?: string[]): Promise<{ text: string; usage?: LlmUsage; calls: number; ms: number }> => {
                let calls = 0;
                let ms = 0;
                for (let attempt = 0; ; attempt++) {
                    calls++;
                    try {
                        const r = await callLLM(settings, p, imgs, pipeline.thinkingLevel, msg.cacheKey);
                        ms += r.ms;
                        return { text: r.text, usage: r.usage, calls, ms };
                    } catch (e) {
                        const m = toMtError(e);
                        const retryable = m.kind === 'ratelimit' || m.kind === 'server' || m.kind === 'network';
                        if (!retryable || attempt >= 2) throw m;
                        await new Promise(r => setTimeout(r, attempt === 0 ? 1000 : 4000));
                    }
                }
            };
            const r1 = await callWithRetry(prompt, vision ? msg.imagesB64 : undefined);
            const raw = r1.text;
            const usage: LlmUsage = { inTok: r1.usage?.inTok, outTok: r1.usage?.outTok, cachedInTok: r1.usage?.cachedInTok };
            let llmCalls = r1.calls;
            let llmMs = r1.ms;
            const parsed = parseResponse(raw, msg.regions.length);
            let outputs = parsed.regions;
            let retryMentions: Mention[] = [];
            let rawAll = raw; // retained so content can warn on a stale background when missing
            // retry once with only the missing regions if the model skipped any
            const missing = msg.regions.filter(r => !outputs.some(o => o.index === r.index));
            if (missing.length && outputs.length) {
                console.warn('[mt:bg] missing regions, retrying:', missing.map(r => r.index).join(','));
                const retryPrompt = buildPrompt(missing, ctx, vision, {
                    stylePrompt: pipeline.stylePrompt,
                    targetLang: pipeline.targetLang,
                    textOnly: msg.textOnly,
                    ocr: msg.ocr,
                    chars: pipeline.useCharacters,
                    maxPairs: pipeline.contextPairs,
                    transcribeSrc: pipeline.transcribeSrc,
                });
                if (dbg) console.log('[mt:bg] llm prompt (retry missing: ' + missing.map(r => r.index).join(',') + ')', retryPrompt);
                // crops for the missing regions; page mode prepends the full page ([0])
                const retryImgs = vision && msg.imagesB64
                    ? [...(msg.textOnly ? [] : [msg.imagesB64[0]]), ...missing.map(r => msg.imagesB64![r.index]).filter(Boolean)]
                    : undefined;
                const r2 = await callWithRetry(retryPrompt, retryImgs);
                rawAll += '\n--- retry (missing regions) ---\n' + r2.text;
                llmCalls += r2.calls;
                llmMs += r2.ms;
                usage.inTok = (usage.inTok ?? 0) + (r2.usage?.inTok ?? 0);
                usage.outTok = (usage.outTok ?? 0) + (r2.usage?.outTok ?? 0);
                usage.cachedInTok = (usage.cachedInTok ?? 0) + (r2.usage?.cachedInTok ?? 0);
                const retryParsed = parseResponse(r2.text, msg.regions.length);
                outputs = [...outputs, ...retryParsed.regions];
                retryMentions = retryParsed.mentions;
            }
            const mentions = [...parsed.mentions, ...retryMentions];
            const { ctx: newCtx, bookOps } = updateContext(msgCtx, outputs, mentions, pipeline.useCharacters, pipeline.contextPairs);
            if (dbg) console.log('[mt:bg] llm raw', rawAll);
            if (dbg && bookOps.length) console.log('[mt:bg] book ops', JSON.stringify(bookOps));
            send({
                ok: true, outputs, extras: parsed.extras, mentions, context: newCtx, model: settings.model, raw: rawAll,
                bookOps: bookOps.length ? bookOps : undefined,
                usage: usage.inTok != null || usage.outTok != null ? usage : undefined,
                llmCalls, llmMs,
            });
        } catch (e) {
            const m = toMtError(e);
            send({ ok: false, error: m.message, kind: m.kind, hint: m.hint });
        }
    })();
}

// ---- context menu (right-click an image → translate just that page) ----
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'mt-keepalive') return; // held open by content runJob — see there
    if (port.name === 'mt-rpc') {
        // per-message port-RPC: port.postMessage({type:'mt:translate',...}) is
        // answered with port.postMessage(result) — same runTranslate as the
        // classic path, so behavior is identical on both channels.
        port.onMessage.addListener((msg) => {
            if ((msg as TranslateMsg)?.type !== 'mt:translate') {
                port.postMessage({ ok: false, error: 'no handler for ' + ((msg as { type?: string })?.type ?? '?') });
                return;
            }
            runTranslate(msg as TranslateMsg, (r: unknown) => {
                try { port.postMessage(r); } catch { /* peer gone */ }
            });
        });
    }
});

// `chrome.contextMenus` is undefined on Firefox for Android (menus API
// unsupported there) — unguarded it throws at top level and kills the whole
// background event page, so the extension must survive its absence.
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus?.create({
        id: 'mt-translate-image',
        title: 'Translate this image',
        // 'page' alongside 'image': overlay readers (overlay readers' per-page
        // div) eat the right-click target, so the image context never fires —
        // the content script then resolves the img under the click point
        contexts: ['image', 'page'],
    }); // already-exists errors on SW restart are fine to ignore
});
chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'mt-translate-image' || !tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'mt:translate-image', srcUrl: info.srcUrl }).catch(() => {});
});
