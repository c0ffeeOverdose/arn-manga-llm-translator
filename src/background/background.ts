// Background service worker: LLM translation (BYOK). Detection runs in the
// content script's iframe — this worker owns LLM calls only.

import { callLLM, toMtError, MtError, checkThinking, thinkingSmell, LlmHttpError, DEFAULT_BASES, DEFAULT_SETTINGS, translateRequestParts, translateRequestId, isImageCapError, sessionKey, type LLMSettings, type LlmUsage } from '../llm/adapters';
import { buildPrompt, parseResponse, mergeRegions, joinTranscription, transcriptionMatches, updateContext, applyOverrides, EMPTY_CONTEXT, type ContextState, type RegionInput, type RegionOutput, type Mention } from '../llm/core';
import { DEFAULT_PIPELINE_SETTINGS, loadPipelineSettings, type PipelineSettings } from '../llm/pipeline-settings';
import { chapterReaderUrl } from './chapter-broker';

// content scripts can't touch storage.session by default — open it up.
// ?. chain: setAccessLevel doesn't exist on older Firefox, and a sync throw
// here would kill the worker before it starts.
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
    interim?: boolean;        // caller understands {type:'mt:ocr-texts'} mid-flight messages (new content only — an old listener would read the interim as the final reply and fail the job)
}
interface TestLlmMsg {
    type: 'mt:test-llm';
    settings: LLMSettings;
    thinking?: string; // options thinking level — probed separately when set
    temperature?: number | null; // options "Custom temperature" pin — rides the connectivity call
}
interface TestOcrMsg {
    type: 'mt:test-ocr';
    settings: LLMSettings;
    thinking?: string; // VLM-reader thinking level under test
    temperature?: number | null; // OCR temperature under test
    imageB64: string; // fixed self-test crop (jpeg/png base64, no data: prefix)
    expect: string; // its known transcription (whitespace-normalized before compare)
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
    inpaint?: boolean; // ask the server to merge cleanup patches into the response
}
interface FontGetMsg {
    type: 'mt:font-get';
    id: string;               // font-store id
}
type BgMsg = TranslateMsg | TestLlmMsg | TestOcrMsg | TestCloudMsg | CloudPageMsg | CharBookMsg | FontGetMsg | { type: 'ping' } | { type: 'mt:screenshot' } | { type: 'mt:hotlink-rule'; origin: string } | { type: 'mt:fetch-image'; url: string } | { type: 'mt:worker-token'; nonce: string; token: string } | { type: 'mt:get-worker-token'; nonce: string } | { type: 'mt:cloud-warm'; endpoint: string; key: string }
    | { type: 'mt:cloud-inpaint'; endpoint: string; key: string; jpegB64: string; maskB64: string; boxes: { x1: number; y1: number; x2: number; y2: number }[] };
interface CharBookMsg {
    type: 'mt:char-book';
    book: { desc: string; gender: 'M' | 'F' | '?'; source: 'user' | 'vlm' | 'speech'; name?: string }[];
}

async function getSettings(): Promise<LLMSettings & { useVision?: boolean }> {
    const { mtSettings } = await chrome.storage.local.get('mtSettings');
    return { ...DEFAULT_SETTINGS, ...(mtSettings ?? {}) };
}

// split pipeline: a separate VLM only transcribes (never translates)
async function getOcrSettings(): Promise<LLMSettings> {
    const { mtOcrSettings } = await chrome.storage.local.get('mtOcrSettings');
    return { ...DEFAULT_SETTINGS, ...(mtOcrSettings ?? {}) };
}

async function getPipeline(): Promise<PipelineSettings> {
    const { mtPipeline } = await chrome.storage.local.get('mtPipeline');
    return loadPipelineSettings(mtPipeline);
}

// ---- split-pipeline OCR: batched vs one-region-per-call.
// Some vision models accept exactly ONE image per request — no provider exposes
// that capability, so "auto" learns it from one failed batch and remembers per
// OCR model. SW-lifetime memo: a restart costs one failed batch, never a wrong
// permanent state.
const ocrSingleImage = new Set<string>();
// models that answered 400 to a pinned temperature — same SW-lifetime memo:
// don't pay a doomed first request per call.
const ocrNoTemperature = new Set<string>();
// same idea for a rejected thinking level.
const ocrNoThinking = new Set<string>();
function ocrCapKey(s: LLMSettings): string { return `${s.provider}|${s.baseUrl ?? ''}|${s.model}`; }

// provider-visible session ids are hashed + salted per install: the raw chapter
// key must never ride a provider field. Cached for the SW lifetime.
let sessionSalt: Promise<number> | null = null;
function getSessionSalt(): Promise<number> {
    sessionSalt ??= (async () => {
        try {
            const { mtSessionSalt } = await chrome.storage.local.get('mtSessionSalt');
            if (typeof mtSessionSalt === 'number' && Number.isFinite(mtSessionSalt)) return mtSessionSalt;
            const fresh = crypto.getRandomValues(new Uint32Array(1))[0];
            await chrome.storage.local.set({ mtSessionSalt: fresh });
            return fresh;
        } catch {
            return 0;
        }
    })();
    return sessionSalt;
}

interface TranscribeResult { preRaw: string; sources: Map<number, string>; usage: LlmUsage; calls: number; ms: number; tempDropped?: boolean; thinkingDropped?: boolean }
// the handler owns retry/backoff (rate-limit aware) — helpers just call through.
// Deliberately 6 params: OCR must NOT opt into retryEmpty (it has its own
// per-region fallback and an explicit zero-text gate), so the knob is not exposed here.
type LlmCaller = (s: LLMSettings, p: string, imgs?: string[], thinking?: string, temperature?: number | null, maxTokens?: number) => Promise<{ text: string; usage?: LlmUsage; calls: number; ms: number; tempDropped?: boolean; thinkingDropped?: boolean }>;
// transcribe calls send NO output cap: the cap includes reasoning tokens on
// reasoning models, and a drifting generation is bounded by the adapter default.

async function transcribeBatched(ocr: LLMSettings, msg: TranslateMsg, pipeline: PipelineSettings, call: LlmCaller, temperature: number | null): Promise<TranscribeResult> {
    const prompt = buildPrompt(msg.regions, EMPTY_CONTEXT, true, { textOnly: msg.textOnly, transcribeOnly: true, chars: false });
    const t = await call(ocr, prompt, msg.imagesB64, pipeline.ocrThinking, temperature);
    const sources = new Map(parseResponse(t.text, msg.regions.length).regions
        .map(o => [o.index, o.translation === 'keep' ? '' : o.translation] as const));
    return { preRaw: t.text, sources, usage: t.usage ?? {}, calls: t.calls, ms: t.ms, tempDropped: t.tempDropped, thinkingDropped: t.thinkingDropped };
}

// per-region: one crop per request, run in batches of parallelLlm.
// A single region failing leaves its source empty; ALL regions failing
// rethrows the first error. A refusal (429/auth) stops the remaining regions.
async function transcribePerRegion(ocr: LLMSettings, msg: TranslateMsg, pipeline: PipelineSettings, call: LlmCaller, temperature: number | null): Promise<TranscribeResult> {
    const crops = msg.textOnly ? (msg.imagesB64 ?? []) : (msg.imagesB64 ?? []).slice(1);
    const prompt = buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, { textOnly: true, transcribeOnly: true, transcribeOne: true, chars: false });
    const sources = new Map<number, string>();
    const raws: string[] = [];
    const usage: LlmUsage = {};
    let calls = 0, failures = 0;
    let stopped = false;
    let tempDropped = false;
    let thinkingDropped = false;
    let firstErr: unknown;
    const t0 = performance.now();
    const width = Math.max(1, Math.min(6, pipeline.parallelLlm || 3));
    for (let i = 0; i < msg.regions.length; i += width) {
        await Promise.all(msg.regions.slice(i, i + width).map(async (r, j) => {
            const crop = crops[i + j];
            if (!crop) { failures++; return; }
            try {
                const res = await call(ocr, prompt, [crop], pipeline.ocrThinking, temperature);
                if (res.tempDropped) tempDropped = true;
                if (res.thinkingDropped) thinkingDropped = true;
                raws.push(`--- region ${r.index} ---\n${res.text}`);
                sources.set(r.index, joinTranscription(res.text));
                usage.inTok = (usage.inTok ?? 0) + (res.usage?.inTok ?? 0);
                usage.outTok = (usage.outTok ?? 0) + (res.usage?.outTok ?? 0);
                calls += res.calls;
            } catch (e) {
                failures++;
                if (!firstErr) firstErr = e;
                const k = toMtError(e).kind;
                if (k === 'ratelimit' || k === 'auth') stopped = true;
                console.warn('[mt:bg] ocr region failed:', r.index, (e as Error)?.message);
            }
        }));
        if (stopped) break; // no further regions — the provider is refusing
    }
    // every region failed, or we stopped early on a refusal: fail loudly.
    if (firstErr && (stopped || failures === msg.regions.length)) throw firstErr;
    return { preRaw: raws.join('\n'), sources, usage, calls, ms: Math.round(performance.now() - t0), tempDropped, thinkingDropped };
}

// ArrayBuffer → base64 for MV3 message passing (JSON-serializes the channel).
function b64encode(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(bin);
}

chrome.runtime.onMessage.addListener((msg: BgMsg, sender, sendResponse) => {
    // defense-in-depth: a future manifest change shouldn't silently expose the
    // fetch/screenshot/storage handlers below.
    if (sender.id && sender.id !== chrome.runtime.id) return;
    if (msg?.type === 'mt:worker-token') {
        // worker-iframe handshake: the token lives in storage.session keyed by
        // the worker's public nonce, where only extension contexts can reach it.
        // Nonce-keyed, NOT tab-keyed: extension pages have no sender.tab.
        if (!/^[0-9a-f]{16}$/.test(msg.nonce ?? '') || !/^[0-9a-f]{32}$/.test(msg.token ?? '')) { sendResponse({ ok: false, error: 'bad handshake' }); return; }
        (async () => {
            const { sessSet, sessGet, sessRemove } = await import('../storage-session');
            // prune stale entries: every iframe load mints a fresh nonce and old
            // ones are dead forever — cap at 32.
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
        // text-only connectivity check: key + model + reachability.
        // Thinking probe (optional second call): reports whether the selected
        // level is accepted or rejected. Only 'auto'/empty skip the probe.
        (async () => {
            try {
                const reply = await callLLM(msg.settings, 'Reply with exactly: pong', undefined, undefined, 'test', msg.temperature);
                const t = (msg.thinking ?? '').trim();
                let thinking: 'accepted' | 'rejected' | 'error' | undefined;
                let thinkingError: string | undefined;
                if (t && t.toLowerCase() !== 'auto') {
                    try {
                        // same 'test' session as the connectivity check — some
                        // proxies 400 a missing session header.
                        await checkThinking(msg.settings, t, 'test');
                        thinking = 'accepted';
                    } catch (e2) {
                        if (e2 instanceof LlmHttpError && thinkingSmell(e2)) thinking = 'rejected';
                        else { thinking = 'error'; thinkingError = String((e2 as Error)?.message ?? e2).slice(0, 160); }
                    }
                }
                sendResponse({ ok: true, reply: reply.text.slice(0, 60), thinking, thinkingError });
            } catch (e) { const m = toMtError(e); sendResponse({ ok: false, error: `${m.message}${m.hint ? ` — ${m.hint}` : ''}` }); }
        })();
        return true;
    }
    if (msg?.type === 'mt:test-ocr') {
        // VLM-reader self-test: ONE transcribe call on the fixed test crop,
        // graded against its known text.
        (async () => {
            try {
                if (!msg.imageB64 || !msg.expect) { sendResponse({ ok: false, error: 'test image missing' }); return; }
                const prompt = buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, {
                    textOnly: true, transcribeOnly: true, chars: false,
                });
                const t = (msg.thinking ?? '').trim() || 'none';
                const r = await callLLM(msg.settings, prompt, [msg.imageB64], t, 'test', msg.temperature ?? null);
                if (r.tempDropped) ocrNoTemperature.add(ocrCapKey(msg.settings));
                if (r.thinkingDropped) ocrNoThinking.add(ocrCapKey(msg.settings));
                const first = parseResponse(r.text, 1).regions[0];
                if (!first) { sendResponse({ ok: false, error: 'format error — no <r> region parsed (the model ignored the output format)' }); return; }
                const got = first.translation === 'keep' ? '' : first.translation;
                if (!got || !transcriptionMatches(got, msg.expect)) {
                    sendResponse({ ok: true, verdict: got ? 'mismatch' : 'miss', got, expected: msg.expect });
                    return;
                }
                // capability probe (2 images): the verdict seeds the split-stage
                // memo, so the first real page doesn't waste a doomed batched call.
                const capKey = ocrCapKey(msg.settings);
                // the memo already knows this model's image cap — don't spend a
                // request confirming it again.
                let multiImage: boolean | undefined = ocrSingleImage.has(capKey) ? false : undefined;
                if (multiImage === undefined) {
                    try {
                        await callLLM(msg.settings, prompt, [msg.imageB64, msg.imageB64], t, 'test', null);
                        multiImage = true;
                        ocrSingleImage.delete(capKey);
                    } catch (e) {
                        const m = toMtError(e);
                        if (isImageCapError(m)) { multiImage = false; ocrSingleImage.add(capKey); }
                        else console.warn('[mt:bg] ocr multi-image probe failed:', m.message);
                    }
                }
                sendResponse({ ok: true, verdict: 'exact', got, expected: msg.expect, multiImage, tempDropped: r.tempDropped });
            } catch (e) { const m = toMtError(e); sendResponse({ ok: false, error: `${m.message}${m.hint ? ` — ${m.hint}` : ''}` }); }
        })();
        return true;
    }
    if (msg?.type === 'mt:test-cloud') {
        // cloud inference check: reachability + auth + model readiness. Doubles
        // as a prewarm — run this from options before reading, not mid-chapter.
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
    if (msg?.type === 'mt:cloud-warm') {
        // scale-to-zero boot can outlive the per-page 90s cap: warming gets its
        // own longer one, and the reply carries the boot ms back for the pill.
        (async () => {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 180000);
            const t0 = Date.now();
            try {
                const base = String(msg.endpoint ?? '').replace(/\/$/, '');
                if (!/^https?:\/\//.test(base)) { sendResponse({ ok: false, error: 'Endpoint URL must start with http(s)://' }); return; }
                const r = await fetch(`${base}/health`, { signal: ctrl.signal });
                if (!r.ok) { sendResponse({ ok: false, error: `cloud warm HTTP ${r.status}` }); return; }
                sendResponse({ ok: true, ms: Date.now() - t0 });
            } catch (e) {
                const m = e instanceof Error && e.name === 'AbortError' ? 'cloud warm timed out after 180s' : String((e as Error)?.message ?? e);
                sendResponse({ ok: false, error: m });
            } finally {
                clearTimeout(to);
            }
        })();
        return true;
    }
    if (msg?.type === 'mt:cloud-inpaint') {
        // AI text cleanup on the user's own endpoint: page as base64 JPEG, erase
        // mask as base64 PNG, boxes as JSON; the server returns per-box PNG patches.
        (async () => {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 90000);
            try {
                const base = String(msg.endpoint ?? '').replace(/\/$/, '');
                if (!/^https?:\/\//.test(base)) { sendResponse({ ok: false, error: 'Endpoint URL must start with http(s)://' }); return; }
                const r = await fetch(`${base}/v1/inpaint`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${msg.key}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image: msg.jpegB64, boxes: msg.boxes, mask: msg.maskB64 || undefined }),
                    signal: ctrl.signal,
                });
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
    if (msg?.type === 'mt:cloud-page') {
        // content-script fetch is CORS-gated on the page origin, so the /v1/page
        // POST rides through here. 90s cap (150s with inpaint).
        (async () => {
            const capMs = msg.inpaint ? 150000 : 90000;
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), capMs);
            try {
                const base = String(msg.endpoint ?? '').replace(/\/$/, '');
                if (!/^https?:\/\//.test(base)) { sendResponse({ ok: false, error: 'Endpoint URL must start with http(s)://' }); return; }
                const bin = atob(msg.jpegB64 ?? '');
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const r = await fetch(
                    `${base}/v1/page?conf_thr=${msg.confThr}&min_size=${msg.minSize}${msg.inpaint ? '&inpaint=1' : ''}`,
                    { method: 'POST', headers: { Authorization: `Bearer ${msg.key}`, 'Content-Type': 'image/jpeg' }, body: bytes, signal: ctrl.signal });
                if (!r.ok) { const t = await r.text().catch(() => ''); sendResponse({ ok: false, error: `cloud HTTP ${r.status}: ${t.slice(0, 160)}` }); return; }
                sendResponse({ ok: true, page: await r.json() });
            } catch (e) {
                const m = e instanceof Error && e.name === 'AbortError' ? `cloud timed out after ${Math.round(capMs / 1000)}s` : String((e as Error)?.message ?? e);
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
        // live — hand the bytes over the RPC channel as base64.
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
        // Chrome requires activeTab (or <all_urls>) for captureVisibleTab — host
        // permissions do NOT cover it. So auto-translate can never capture (no
        // gesture), only manual can. Double-gate beyond that: the sender must be
        // the ACTIVE tab of its own window, and the capture pins that windowId.
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
        // hotlink-guarded CDNs 403 Referer-less SW fetch: install a session rule
        // stamping the page origin as Referer. Session-only — gone on restart.
        // ONE atomic updateSessionRules call (remove+add): concurrent 403s would
        // otherwise interleave and the second add throws "duplicate ID".
        (async () => {
            try {
                // origin must parse and be a bare origin — it becomes a Referer value.
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
        // content-script fetch is CORS-gated on the PAGE origin while the worker
        // fetches free of page CORS — proxy the bytes through here. URL policy
        // first: this fetch is CORS-exempt, so it must not become a read-anything
        // proxy for URLs a page plants in an <img>.
        (async () => {
            try {
                const { fetchImageBlocked } = await import('../content/page-cache');
                const readerUrl = await chapterReaderUrl(sender);
                const blocked = fetchImageBlocked(msg.url, readerUrl);
                if (blocked) { sendResponse({ ok: false, error: `proxy fetch blocked: ${blocked}` }); return; }
                // hard cap: a CDN that accepts the connection and never answers
                // would pend this fetch forever — the content side has no timeout.
                const resp = await fetch(msg.url, { signal: AbortSignal.timeout(60_000) });
                // re-check the FINAL url: fetch follows redirects, and a public URL
                // 302-ing to a loopback host would otherwise resurrect the
                // local-network readback the pre-fetch check exists to block.
                const blocked2 = fetchImageBlocked(resp.url, readerUrl);
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
// mt-rpc port path below. Never rejects; failures come back as {ok:false}.
// In-flight adoption: identical mt:translate calls share one provider roundtrip.
// Misses only cost the optimization (fresh call); SW death wipes the maps and
// the next call becomes the owner (self-healing).
const flightWaiters = new Map<string, ((resp: unknown) => void)[]>();
const flightRecent = new Map<string, { at: number; resp: unknown }>();
const FLIGHT_RECENT_TTL_MS = 5 * 60 * 1000;
const FLIGHT_RECENT_MAX = 20;
// honest counters (numbers only) — E2E asserts dedup through these.
const flightStats = { owners: 0, adopted: 0, recentHits: 0 };
(globalThis as Record<string, unknown>).__mtFlightStats = flightStats;
function flightRecentGet(id: string): unknown | undefined {
    const e = flightRecent.get(id);
    if (!e) return undefined;
    if (Date.now() - e.at > FLIGHT_RECENT_TTL_MS) { flightRecent.delete(id); return undefined; }
    flightRecent.delete(id); // LRU touch
    flightRecent.set(id, e);
    return e.resp;
}
function flightRecentPut(id: string, resp: unknown): void {
    flightRecent.delete(id);
    flightRecent.set(id, { at: Date.now(), resp });
    if (flightRecent.size > FLIGHT_RECENT_MAX) flightRecent.delete(flightRecent.keys().next().value!);
}

function runTranslate(msg: TranslateMsg, send: (r: unknown) => void, interim?: (r: unknown) => void) {
    // settles waiters when assigned (post-adoption); pre-adoption failures
    // answer the caller directly — nothing was claimed.
    let settle: ((resp: unknown) => void) | null = null;
    (async () => {
        try {
            const settings = await getSettings();
            const pipeline = await getPipeline();
            // user gender overrides from the options page are law
            const { mtCharOverrides, mtDebug } = await chrome.storage.local.get(['mtCharOverrides', 'mtDebug']);
            const dbg = mtDebug === true; // one read per call — always fresh, no SW sleep/wake staleness
            // provider-visible session id: opaque digest of the chapter key, salted
            // per install (the raw reader URL never leaves the extension).
            const session = msg.cacheKey ? sessionKey(msg.cacheKey, await getSessionSalt()) : undefined;
            // guard: a corrupt/absent context must not crash the pipeline.
            const msgCtx = (msg.context && Array.isArray(msg.context.characters) && Array.isArray(msg.context.pairs))
                ? msg.context : EMPTY_CONTEXT;
            const ctx = applyOverrides(msgCtx, (mtCharOverrides ?? {}) as Record<string, { gender: 'M' | 'F' | '?'; name?: string }>);
            const vision = !msg.ocr && !!msg.imagesB64?.length;
            // LLM call with strategic retry: 5xx/network get backoff retries;
            // auth/quota errors fail fast — retrying can't fix them; a 429 is
            // refused locally by the adapter's breaker until its window passes.
            // retryEmpty: a provider can return a 200 with no content (empty parse) — a
            // transient flake, not a real answer. Retried once HERE, where the caller's
            // alternative is an identical full-page call that re-uploads every crop.
            const callWithRetry = async (s: LLMSettings, p: string, imgs?: string[], thinking?: string, temperature?: number | null, maxTokens?: number, retryEmpty = false): Promise<{ text: string; usage?: LlmUsage; calls: number; ms: number; tempDropped?: boolean; thinkingDropped?: boolean }> => {
                let calls = 0;
                let ms = 0;
                let tempDropped = false;
                let thinkingDropped = false;
                let emptyRetried = false;
                // TEMP TRACE: identifies which leg (r1/r2/r3) is slow/hanging in the field.
                const traceTag = `r${retryEmpty ? '1+' : ''}${msg.regions.length}reg${imgs?.length ? `/${imgs.length}img` : ''}`;
                const tCall = Date.now();
                console.log(`[mt:trace] callWithRetry START ${traceTag}`);
                // the discarded empty attempt still billed tokens — sum, never drop.
                // Stays undefined when the provider reports no usage at all, so the
                // caller's `usage.inTok != null` gate keeps its old meaning.
                let usage: LlmUsage | undefined;
                const addUsage = (u?: LlmUsage): void => {
                    if (!u || (u.inTok == null && u.outTok == null && u.cachedInTok == null)) return;
                    usage = {
                        inTok: (usage?.inTok ?? 0) + (u.inTok ?? 0),
                        outTok: (usage?.outTok ?? 0) + (u.outTok ?? 0),
                        cachedInTok: (usage?.cachedInTok ?? 0) + (u.cachedInTok ?? 0),
                    };
                };
                // error-attempt counter is separate from the loop var: an empty retry
                // must not advance the network backoff ladder (1000ms → 4000ms)
                let errAttempt = 0;
                for (;;) {
                    calls++;
                    const tAttempt = Date.now();
                    console.log(`[mt:trace] ${traceTag} attempt#${calls} send (${Date.now() - tCall}ms in)`);
                    try {
                        const r = await callLLM(s, p, imgs, thinking ?? pipeline.thinkingLevel, session, temperature, maxTokens);
                        ms += r.ms;
                        addUsage(r.usage);
                        if (r.tempDropped) tempDropped = true;
                        if (r.thinkingDropped) thinkingDropped = true;
                        console.log(`[mt:trace] ${traceTag} attempt#${calls} OK in ${Date.now() - tAttempt}ms, text.len=${r.text.trim().length}`);
                        if (retryEmpty && !emptyRetried && !r.text.trim()) {
                            emptyRetried = true;
                            console.warn(`[mt:trace] ${traceTag} EMPTY response (200, no content) — retrying once`);
                            continue;
                        }
                        console.log(`[mt:trace] callWithRetry DONE ${traceTag} total=${Date.now() - tCall}ms calls=${calls}`);
                        return { text: r.text, usage, calls, ms, tempDropped, thinkingDropped };
                    } catch (e) {
                        const m = toMtError(e);
                        const retryable = m.kind === 'server' || m.kind === 'network';
                        console.warn(`[mt:trace] ${traceTag} attempt#${calls} FAIL in ${Date.now() - tAttempt}ms kind=${m.kind} retryable=${retryable}: ${m.message.slice(0, 120)}`);
                        if (!retryable || errAttempt >= 2) throw m;
                        await new Promise(r => setTimeout(r, errAttempt === 0 ? 1000 : 4000));
                        errAttempt++;
                    }
                }
            };
            const split = pipeline.useOcrModel && vision && !!msg.imagesB64?.length;
            const ocrSettings = split ? await getOcrSettings() : null;
            // adoption check (atomic: no await between map lookup and claim).
            const reqId = await translateRequestId(translateRequestParts(
                {
                    cacheKey: session ?? '', imagesB64: msg.imagesB64 ?? [],
                    regions: msg.regions, context: msgCtx,
                    vision, textOnly: !!msg.textOnly, ocr: !!msg.ocr, split,
                },
                {
                    provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl ?? '',
                    ocrModel: ocrSettings?.model ?? '',
                    thinkingLevel: pipeline.thinkingLevel, ocrThinking: pipeline.ocrThinking,
                    temperature: pipeline.temperature,
                    ocrTemperature: pipeline.ocrTemperature,
                    useOcrModel: pipeline.useOcrModel, stylePrompt: pipeline.stylePrompt,
                    targetLang: pipeline.targetLang, useCharacters: pipeline.useCharacters,
                    contextPairs: pipeline.contextPairs, transcribeSrc: pipeline.transcribeSrc,
                    vlmAssisted: pipeline.vlmAssistedDetection,
                },
            ));
            const recent = flightRecentGet(reqId);
            if (recent && (recent as { ok?: unknown })?.ok) {
                // the twin call finished moments ago — serve without spending.
                flightStats.recentHits++;
                if (dbg) console.log('[mt:bg] flight recent-hit', reqId.slice(0, 12));
                send(recent);
                return;
            }
            const inflight = flightWaiters.get(reqId);
            if (inflight) {
                // the twin call is still running — wait for its outcome instead
                // of paying a duplicate.
                flightStats.adopted++;
                if (dbg) console.log('[mt:bg] flight adopted', reqId.slice(0, 12));
                send(await new Promise<unknown>(res => inflight.push(res)));
                return;
            }
            const mine: ((resp: unknown) => void)[] = [];
            flightWaiters.set(reqId, mine);
            flightStats.owners++;
            // every exit (ok or error) settles waiters with the same payload.
            settle = (resp: unknown) => {
                flightWaiters.delete(reqId);
                if ((resp as { ok?: unknown })?.ok) flightRecentPut(reqId, resp);
                send(resp);
                for (const w of mine.splice(0)) { try { w(resp); } catch { /* waiter gone */ } }
            };
            let regions2 = msg.regions;
            let usage: LlmUsage = {};
            let llmCalls = 0;
            let llmMs = 0;
            let preRaw = ''; // transcribe-stage raw (debug dump)
            let ocrStatus: ('ok' | 'empty')[] | undefined;
            let ocrMs: number | undefined;
            if (split) {
                if (!ocrSettings!.model || !ocrSettings!.apiKey) {
                    throw new MtError('auth', 'OCR model not configured — open the extension options');
                }
                const ocr = ocrSettings!;
                const key = ocrCapKey(ocr);
                // a model that rejected a pinned temperature once keeps its
                // provider default from then on (SW lifetime).
                const ocrTemp = ocrNoTemperature.has(key) ? null : pipeline.ocrTemperature;
                // a model that rejected the thinking level once runs without it
                // from then on (SW lifetime).
                const ocrPl: PipelineSettings = ocrNoThinking.has(key) ? { ...pipeline, ocrThinking: 'auto' } : pipeline;
                // per-region when forced, when this model already rejected a batch
                // once, or when the batch fails with an image-count error.
                const t = pipeline.ocrPerRegion || ocrSingleImage.has(key)
                    ? await transcribePerRegion(ocr, msg, ocrPl, callWithRetry, ocrTemp)
                    : await transcribeBatched(ocr, msg, ocrPl, callWithRetry, ocrTemp).catch(async (e) => {
                        if (!isImageCapError(e)) throw e;
                        if (dbg) console.log('[mt:bg] ocr image cap → per-region fallback');
                        ocrSingleImage.add(key);
                        return await transcribePerRegion(ocr, msg, ocrPl, callWithRetry, ocrTemp);
                    });
                if (t.tempDropped) ocrNoTemperature.add(key);
                if (t.thinkingDropped) ocrNoThinking.add(key);
                // zero parsed regions = the OCR model answered nothing usable —
                // without this the page reports Done with nothing translated.
                if (!t.sources.size) {
                    throw new MtError('parse', `OCR model returned no text (${msg.regions.length} regions)`,
                        'Retry the page, or check the OCR model in Options');
                }
                preRaw = t.preRaw;
                usage = { ...t.usage };
                llmCalls = t.calls;
                llmMs = t.ms;
                regions2 = msg.regions.map(r => ({ index: r.index, source: t.sources.get(r.index) ?? '' }));
                ocrStatus = regions2.map(r => r.source ? 'ok' : 'empty');
                ocrMs = t.ms;
                // hand the transcripts over before the translate call: the content
                // script checkpoints them so a retry mid-translate never re-pays
                // the OCR stage. Port channel only, and only when the caller
                // advertises it (interim).
                if (msg.interim) interim?.({ type: 'mt:ocr-texts', texts: regions2.map(r => r.source) });
            }
            const vision2 = split ? false : vision;
            const prompt = buildPrompt(regions2, ctx, vision2, {
                vlmAssisted: pipeline.vlmAssistedDetection && vision2 && !msg.textOnly,
                stylePrompt: pipeline.stylePrompt,
                targetLang: pipeline.targetLang,
                pageW: msg.pageW,
                pageH: msg.pageH,
                textOnly: split ? true : msg.textOnly,
                ocr: split ? true : msg.ocr,
                chars: pipeline.useCharacters,
                maxPairs: pipeline.contextPairs,
                transcribeSrc: split ? false : pipeline.transcribeSrc,
            });
            if (dbg) console.log('[mt:bg] llm prompt', prompt);

            const r1 = await callWithRetry(settings, prompt, vision2 ? msg.imagesB64 : undefined, undefined, pipeline.temperature, undefined, true);
            const raw = r1.text;
            if (split) {
                usage.inTok = (usage.inTok ?? 0) + (r1.usage?.inTok ?? 0);
                usage.outTok = (usage.outTok ?? 0) + (r1.usage?.outTok ?? 0);
                usage.cachedInTok = (usage.cachedInTok ?? 0) + (r1.usage?.cachedInTok ?? 0);
                llmCalls += r1.calls;
                llmMs += r1.ms;
            } else {
                usage = { inTok: r1.usage?.inTok, outTok: r1.usage?.outTok, cachedInTok: r1.usage?.cachedInTok };
                llmCalls = r1.calls;
                llmMs = r1.ms;
            }
            const parsed = parseResponse(raw, msg.regions.length);
            let outputs = parsed.regions;
            let retryMentions: Mention[] = [];
            let rawAll = split ? '--- transcribe ---\n' + preRaw + '\n--- translate ---\n' + raw : raw; // retained so content can warn on a stale background when missing
            // retry once with only the missing regions if the model skipped any.
            const missing = regions2.filter(r => !outputs.some(o => o.index === r.index));
            if (missing.length && outputs.length) {
                console.warn('[mt:bg] missing regions, retrying:', missing.map(r => r.index).join(','));
                const retryPrompt = buildPrompt(missing, ctx, vision2, {
                    stylePrompt: pipeline.stylePrompt,
                    targetLang: pipeline.targetLang,
                    textOnly: split ? true : msg.textOnly,
                    ocr: split ? true : msg.ocr,
                    chars: pipeline.useCharacters,
                    maxPairs: pipeline.contextPairs,
                    transcribeSrc: split ? false : pipeline.transcribeSrc,
                });
                if (dbg) console.log('[mt:bg] llm prompt (retry missing: ' + missing.map(r => r.index).join(',') + ')', retryPrompt);
                // crops for the missing regions; page mode prepends the full page ([0]).
                const retryImgs = vision2 && msg.imagesB64
                    ? [...(msg.textOnly ? [] : [msg.imagesB64[0]]), ...missing.map(r => msg.imagesB64![r.index]).filter(Boolean)]
                    : undefined;
                const r2 = await callWithRetry(settings, retryPrompt, retryImgs, undefined, pipeline.temperature, undefined, true);
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
            if (!outputs.length && regions2.length) {
                // total parse failure: one full retry before failing loudly. An empty
                // result must never come back ok:true (content would cache the void).
                console.warn('[mt:bg] no regions parsed, retrying full page');
                const fullPrompt = buildPrompt(regions2, ctx, vision2, {
                    stylePrompt: pipeline.stylePrompt,
                    targetLang: pipeline.targetLang,
                    textOnly: split ? true : msg.textOnly,
                    ocr: split ? true : msg.ocr,
                    chars: pipeline.useCharacters,
                    maxPairs: pipeline.contextPairs,
                    transcribeSrc: split ? false : pipeline.transcribeSrc,
                });
                const r3 = await callWithRetry(settings, fullPrompt, vision2 ? msg.imagesB64 : undefined, undefined, pipeline.temperature, undefined, true);
                rawAll += '\n--- retry (no regions parsed) ---\n' + r3.text;
                llmCalls += r3.calls;
                llmMs += r3.ms;
                usage.inTok = (usage.inTok ?? 0) + (r3.usage?.inTok ?? 0);
                usage.outTok = (usage.outTok ?? 0) + (r3.usage?.outTok ?? 0);
                usage.cachedInTok = (usage.cachedInTok ?? 0) + (r3.usage?.cachedInTok ?? 0);
                const fullParsed = parseResponse(r3.text, msg.regions.length);
                // merge rather than replace: r1/r2 may have returned usable regions the
                // full retry happened to drop (a model that answers the whole page with
                // fewer tags than it did in pieces). First occurrence wins per index.
                outputs = mergeRegions(outputs, fullParsed.regions);
                retryMentions = [...retryMentions, ...fullParsed.mentions];
                if (!outputs.length) {
                    throw new MtError('parse', 'No usable text regions parsed (the model ignored the output format)',
                        'Retry the page, or switch to a model with better instruction-following');
                }
                // PARTIAL ACCEPT: some regions came back and the rest did not. Failing
                // the whole page would discard paid, correct translations and leave every
                // box untranslated (the "regions kept as-is: 4..16" symptom). The regions
                // with no answer are simply absent from `outputs`; content keeps their
                // source text as-is (see withSources / missingIdx), so the page renders.
                if (outputs.length < regions2.length) {
                    console.warn(`[mt:bg] partial translation accepted: ${outputs.length}/${regions2.length} regions`);
                }
            }
            const mentions = [...parsed.mentions, ...retryMentions];
            const { ctx: newCtx, bookOps } = updateContext(msgCtx, outputs, mentions, pipeline.useCharacters, pipeline.contextPairs);
            if (dbg) console.log('[mt:bg] llm raw', rawAll);
            if (dbg && bookOps.length) console.log('[mt:bg] book ops', JSON.stringify(bookOps));
            settle({
                ok: true, outputs, extras: parsed.extras, mentions, context: newCtx, model: settings.model, raw: rawAll,
                bookOps: bookOps.length ? bookOps : undefined,
                usage: usage.inTok != null || usage.outTok != null ? usage : undefined,
                llmCalls, llmMs, ocrStatus, ocrMs,
            });
        } catch (e) {
            const m = toMtError(e);
            const out = { ok: false, error: m.message, kind: m.kind, hint: m.hint, retryAfterMs: m.retryAfterMs };
            if (settle) settle(out);
            else send(out);
        }
    })();
}

// ---- context menu (right-click an image → translate just that page) ----
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'mt-keepalive') {
        // held open by content runJob while a job runs; its pings are pure
        // service-worker activity, nothing to answer.
        port.onMessage.addListener(() => { /* keepalive ping */ });
        return;
    }
    if (port.name === 'mt-rpc') {
        // per-message port-RPC — same runTranslate as the classic path, so
        // behavior is identical on both channels.
        port.onMessage.addListener((msg) => {
            if ((msg as TranslateMsg)?.type !== 'mt:translate') {
                port.postMessage({ ok: false, error: 'no handler for ' + ((msg as { type?: string })?.type ?? '?') });
                return;
            }
            runTranslate(msg as TranslateMsg, (r: unknown) => {
                try { port.postMessage(r); } catch { /* peer gone */ }
            }, (r: unknown) => {
                // split-pipeline interim (transcripts) — same channel, filtered
                // by the content script before it settles its promise
                try { port.postMessage(r); } catch { /* peer gone */ }
            });
        });
    }
});

// `chrome.contextMenus` is undefined on Firefox for Android — unguarded it
// throws at top level and kills the whole background event page.
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus?.create({
        id: 'mt-translate-image',
        title: 'Translate this image',
        // 'page' alongside 'image': overlay readers eat the right-click target,
        // so the image context never fires — the content script resolves the
        // img under the click point.
        contexts: ['image', 'page'],
    }); // already-exists errors on SW restart are fine to ignore
});
chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'mt-translate-image' || !tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'mt:translate-image', srcUrl: info.srcUrl }).catch(() => {});
});
