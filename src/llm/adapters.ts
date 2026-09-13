// BYOK LLM adapters — 4 protocols, plain fetch, no SDKs.
// All run in the background service worker (host_permissions cover CORS).

import { splitStablePrefix, type ContextState, type RegionInput } from './core';

export interface LLMSettings {
    provider: 'openai' | 'responses' | 'anthropic' | 'gemini';
    model: string;
    apiKey: string;
    baseUrl?: string; // override for openai-compatible endpoints (openrouter, ollama, opencode...)
    cloudEndpoint?: string; // optional cloud inference (Modal) for detection+OCR — URL + key below
    cloudKey?: string;
    useVision?: boolean;
}

export const DEFAULT_SETTINGS: LLMSettings = {
    provider: 'openai',
    model: '',
    apiKey: '',
    baseUrl: '',
    cloudEndpoint: '',
    cloudKey: '',
};

export const DEFAULT_BASES: Record<LLMSettings['provider'], string> = {
    openai: 'https://api.openai.com/v1',
    responses: 'https://opencode.ai/zen/v1',
    anthropic: 'https://api.anthropic.com',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

export async function callLLM(
    s: LLMSettings,
    prompt: string,
    imagesB64?: string[], // jpeg base64 (no data: prefix); [0] = full page, rest = region crops
    thinkingLevel: string = 'auto', // preset, custom text, or a numeric token budget
    cacheKey?: string, // stable per conversation (manga) — routes provider-side prompt caching
): Promise<LlmResult> {
    if (!s.apiKey) throw new MtError('auth', 'No API key configured — open the extension options');
    if (!s.model) throw new MtError('auth', 'No model configured — open the extension options');
    const base = (s.baseUrl || DEFAULT_BASES[s.provider]).replace(/\/$/, '');
    const t = thinkingLevel.trim();
    const thinking = !t || t === 'auto' ? null : t;
    const imgs = imagesB64?.length ? imagesB64 : undefined;
    const t0 = Date.now();
    try {
        const r = await dispatch(base, s, prompt, imgs, thinking, cacheKey);
        return { ...r, ms: Date.now() - t0 };
    } catch (e) {
        // some models reject the thinking param entirely — retry once without it
        if (thinking && e instanceof LlmHttpError && (e.status === 400 || e.status === 422)) {
            console.warn('[mt:bg] model rejected thinking level, retrying without');
            const r = await dispatch(base, s, prompt, imgs, null, cacheKey);
            return { ...r, ms: Date.now() - t0 };
        }
        throw e;
    }
}

function dispatch(base: string, s: LLMSettings, prompt: string, imgs: string[] | undefined, thinking: string | null, cacheKey?: string): Promise<{ text: string; usage?: LlmUsage }> {
    switch (s.provider) {
        case 'openai': return openaiChat(base, s, prompt, imgs, thinking, cacheKey);
        case 'responses': return responses(base, s, prompt, imgs, thinking, cacheKey);
        case 'anthropic': return anthropic(base, s, prompt, imgs, thinking, cacheKey);
        case 'gemini': return gemini(base, s, prompt, imgs, thinking, cacheKey);
    }
}

// ---- error taxonomy: every failure the user can hit, with an actionable hint

export type MtErrorKind = 'auth' | 'ratelimit' | 'network' | 'server' | 'parse';

export class MtError extends Error {
    constructor(public kind: MtErrorKind, msg: string, public hint?: string) { super(msg); }
}

// result of one LLM call: text + normalized usage (when the provider reports it)
export interface LlmUsage { inTok?: number; outTok?: number; cachedInTok?: number }
export interface LlmResult { text: string; usage?: LlmUsage; ms: number }

// provider JSON is untrusted (BYOK baseUrl can be http:// or a MITM'd proxy):
// coerce usage counters to numbers here or a crafted "prompt_tokens":
// "<img onerror=…>" rides into the popup's usage box (innerHTML) and runs in
// the extension origin, where storage.local (API keys) is readable
const num = (v: unknown): number | undefined => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };

class LlmHttpError extends Error {
    constructor(public status: number, msg: string) { super(msg); }
}

// exported for tests (lets them build a faithful 400 without touching fetch)
export { LlmHttpError };

async function checkOk(resp: Response): Promise<string> {
    const text = await resp.text();
    if (!resp.ok) throw new LlmHttpError(resp.status, `LLM API ${resp.status}: ${text.slice(0, 300)}`);
    return text;
}

// HTTP/network errors → MtError with the hint the toast will show
export function toMtError(e: unknown): MtError {
    if (e instanceof MtError) return e;
    if (e instanceof LlmHttpError) {
        if (e.status === 401 || e.status === 403) return new MtError('auth', e.message, 'API key is wrong or expired — check the key in Settings');
        if (e.status === 402) return new MtError('auth', e.message, 'Out of credits/quota — top up or switch provider');
        if (e.status === 404) return new MtError('auth', e.message, 'Wrong model name — check the model in Settings');
        if (e.status === 429) return new MtError('ratelimit', e.message, 'Rate limited — lower Parallel LLM in Settings or wait a moment');
        if (e.status === 400 && /image|base64|data uri|input_image|multimodal|media_type|content\[|not support/i.test(e.message))
            return new MtError('parse', e.message, "This model can't read images — switch to Local OCR or pick another model");
        if (e.status >= 500) return new MtError('server', e.message, 'Provider is temporarily down — you can retry');
    }
    if (e instanceof TypeError) return new MtError('network', String(e), 'Cannot reach the provider — check your network/baseUrl');
    const m = new MtError('parse', String(e));
    return m;
}

// Thinking levels: one combobox in the options page (free-text allowed —
// custom text/numbers go out verbatim). Mapped per provider at send time;
// the API is the authority on what each model accepts, rejects fall back
// down the chain (modern scheme → legacy scheme → omitted).
export type ThinkingPreset = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const FULL_LEVELS: ThinkingPreset[] = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];
// Gemini 3 levels stop at high (no xhigh/max/none — none maps to minimal)
export const THINKING_LEVELS: Record<LLMSettings['provider'], ThinkingPreset[]> = {
    openai: FULL_LEVELS,
    responses: FULL_LEVELS,
    anthropic: FULL_LEVELS,
    gemini: ['auto', 'none', 'low', 'medium', 'high'],
};
export const THINKING_HINTS: Record<ThinkingPreset, string> = {
    auto: 'Leave it to the model.',
    none: 'No reasoning — fastest and cheapest.',
    low: 'Light reasoning, low latency.',
    medium: 'Balanced — a good default.',
    high: 'Deep reasoning for hard pages — slower, pricier.',
    xhigh: 'Very deep — only when it measurably helps.',
    max: 'Unconstrained — most capable, most expensive.',
};

const isNumericLevel = (s: string) => /^\d+$/.test(s);
// error smells like a rejected thinking param (as opposed to e.g. an image error)
// exported: the Test-connection probe classifies rejections with it
export function thinkingSmell(e: unknown): boolean {
    return e instanceof LlmHttpError && (e.status === 400 || e.status === 422)
        && /thinking|budget|effort|adaptive|reasoning/i.test(e.message);
}

// single-shot thinking probe for the Test button: one direct dispatch with NO
// fallback (callLLM's omit-retry would mask a rejection as success).
// Resolves 'accepted'; rejects with the provider error for the caller to
// classify (thinkingSmell = rejected level, anything else = real problem).
// cacheKey is forwarded so session-affinity headers (x-opencode-session)
// ride along — without it some proxies 400 the probe for a missing session.
// Caveat: silent-ignore providers (old OpenAI models dropping reasoning_effort)
// report accepted without effect — rejection, not effect, is what's probed.
export async function checkThinking(s: LLMSettings, thinking: string, cacheKey?: string): Promise<'accepted'> {
    const base = (s.baseUrl || DEFAULT_BASES[s.provider]).replace(/\/$/, '');
    await dispatch(base, s, 'Reply with exactly: pong', undefined, thinking, cacheKey);
    return 'accepted';
}

// OpenAI-compatible chat/completions (OpenAI, OpenRouter, ollama, gemini-compat...)
async function openaiChat(base: string, s: LLMSettings, prompt: string, images?: string[], thinking: string | null = null, cacheKey?: string): Promise<{ text: string; usage?: LlmUsage }> {
    const content: unknown[] = [{ type: 'text', text: prompt }];
    for (const b64 of images ?? []) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
    const body: Record<string, unknown> = {
        model: s.model,
        messages: [{ role: 'user', content }],
        max_tokens: 4096,
    };
    if (thinking) body.reasoning_effort = thinking; // GPT-5/o-series via chat; ignored by older
    if (cacheKey) body.prompt_cache_key = cacheKey; // OpenAI routing stickiness (60→87% hit in their docs); ignored by others
    const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${s.apiKey}`,
            ...(cacheKey ? { 'x-opencode-session': `mt-${cacheKey}` } : {}), // opencode Go session affinity; harmless elsewhere
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
    });
    const text = await checkOk(resp);
    const data = JSON.parse(text);
    return {
        text: data.choices?.[0]?.message?.content ?? '',
        usage: { inTok: num(data.usage?.prompt_tokens), outTok: num(data.usage?.completion_tokens), cachedInTok: num(data.usage?.prompt_tokens_details?.cached_tokens) },
    };
}

// Responses API (OpenAI responses, OpenCode Zen/Go, Muse Spark)
async function responses(base: string, s: LLMSettings, prompt: string, images?: string[], thinking: string | null = null, cacheKey?: string): Promise<{ text: string; usage?: LlmUsage }> {
    const content: unknown[] = [{ type: 'input_text', text: prompt }];
    for (const b64 of images ?? []) content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${b64}` });
    const body: Record<string, unknown> = { model: s.model, input: [{ role: 'user', content }] };
    if (thinking) body.reasoning = { effort: thinking };
    if (cacheKey) body.prompt_cache_key = cacheKey;
    const resp = await fetch(`${base}/responses`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${s.apiKey}`,
            ...(cacheKey ? { 'x-opencode-session': `mt-${cacheKey}` } : {}), // required for opencode Go caching; 09/06+ requests without it may error
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
    });
    const text = await checkOk(resp);
    const data = JSON.parse(text);
    const out: string[] = [];
    for (const item of data.output ?? []) {
        if (item.type === 'message') {
            for (const c of item.content ?? []) if (c.type === 'output_text') out.push(c.text);
        }
    }
    return {
        text: out.join('\n'),
        usage: { inTok: num(data.usage?.input_tokens), outTok: num(data.usage?.output_tokens), cachedInTok: num(data.usage?.input_tokens_details?.cached_tokens) },
    };
}

// legacy fixed-budget scheme (Sonnet/Opus 4.5 and earlier) + adaptive headroom
const ANTHROPIC_BUDGET: Record<string, number> = { low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32000 };
const ANTHROPIC_MAXTOK: Record<string, number> = { low: 8192, medium: 8192, high: 16384, xhigh: 32768, max: 65536 };

// Anthropic messages API (direct browser access header)
async function anthropic(base: string, s: LLMSettings, prompt: string, images?: string[], thinking: string | null = null, cacheKey?: string): Promise<{ text: string; usage?: LlmUsage }> {
    // cache requires an explicit breakpoint on the STABLE part: split the
    // prompt at <regions> (everything before it repeats across pages of the
    // same manga). Text-first so the volatile images can't cut the prefix.
    const split = splitStablePrefix(prompt);
    const content: unknown[] = [];
    if (split) {
        content.push({ type: 'text', text: split.stable, cache_control: { type: 'ephemeral' } });
        content.push({ type: 'text', text: split.varying });
    } else {
        content.push({ type: 'text', text: prompt });
    }
    for (const b64 of images ?? []) {
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
    }
    const baseBody: Record<string, unknown> = { model: s.model, max_tokens: 4096, messages: [{ role: 'user', content }] };
    const send = async (patch: Record<string, unknown>): Promise<{ text: string; usage?: LlmUsage }> => {
        const body = { ...baseBody, ...patch };
        const resp = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': s.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
                ...(cacheKey ? { 'x-opencode-session': `mt-${cacheKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
        });
        const text = await checkOk(resp);
        const data = JSON.parse(text);
        return {
            text: (data.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'),
            usage: { inTok: num(data.usage?.input_tokens), outTok: num(data.usage?.output_tokens), cachedInTok: num(data.usage?.cache_read_input_tokens) },
        };
    };
    if (!thinking || thinking === 'none') return send({});
    // modern scheme first: adaptive thinking + effort (Opus 4.6+/Sonnet 4.6+/5.x).
    // thinking counts toward max_tokens, so xhigh/max need large headroom.
    try {
        return await send({
            max_tokens: ANTHROPIC_MAXTOK[thinking] ?? 16384,
            thinking: { type: 'adaptive' },
            output_config: { effort: thinking },
        });
    } catch (e) {
        if (!thinkingSmell(e)) throw e;
    }
    // legacy scheme: fixed budget (4.5 and earlier). Custom numbers go verbatim;
    // custom strings can't map to a budget — rethrow into the omit-retry.
    const budget = isNumericLevel(thinking)
        ? Math.min(32000, Math.max(1024, parseInt(thinking, 10)))
        : ANTHROPIC_BUDGET[thinking];
    if (budget == null) throw new LlmHttpError(400, `thinking not supported: ${thinking}`);
    return send({
        thinking: { type: 'enabled', budget_tokens: budget },
        max_tokens: Math.max(8192, budget + 4096), // budget must fit under max_tokens
    });
}

// legacy numeric budgets (Gemini 2.5 — no thinkingLevel there)
const GEMINI_BUDGET: Record<string, number> = { none: 0, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 24576 };

// Gemini generateContent
async function gemini(base: string, s: LLMSettings, prompt: string, images?: string[], thinking: string | null = null, cacheKey?: string): Promise<{ text: string; usage?: LlmUsage }> {
    const parts: unknown[] = [{ text: prompt }];
    for (const b64 of images ?? []) parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
    const send = async (thinkingConfig?: Record<string, unknown>): Promise<{ text: string; usage?: LlmUsage }> => {
        const body: Record<string, unknown> = { contents: [{ parts }] };
        if (thinkingConfig) body.generationConfig = { thinkingConfig };
        // no prompt_cache_key: Gemini rejects unknown body fields with a 400
        const resp = await fetch(`${base}/models/${s.model}:generateContent?key=${encodeURIComponent(s.apiKey)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(cacheKey ? { 'x-opencode-session': `mt-${cacheKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
        });
        const text = await checkOk(resp);
        const data = JSON.parse(text);
        return {
            text: (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join(''),
            usage: { inTok: num(data.usageMetadata?.promptTokenCount), outTok: num(data.usageMetadata?.candidatesTokenCount) },
        };
    };
    if (!thinking) return send();
    // a bare number is a token budget on every Gemini generation
    if (isNumericLevel(thinking)) return send({ thinkingBudget: Math.min(32768, Math.max(0, parseInt(thinking, 10))) });
    // Gemini 3 levels first (minimal ≈ off; xhigh/max degrade to high)
    const level = thinking === 'none' ? 'minimal' : thinking === 'xhigh' || thinking === 'max' ? 'high' : thinking;
    try {
        return await send({ thinkingLevel: level });
    } catch (e) {
        if (!thinkingSmell(e)) throw e;
    }
    const budget = GEMINI_BUDGET[thinking];
    if (budget == null) throw new LlmHttpError(400, `thinking not supported: ${thinking}`);
    return send({ thinkingBudget: budget });
}

// ---- in-flight adoption identity: which request fingerprints must match for
// two mt:translate calls to share one provider roundtrip. Everything that can
// change the model's output is in (images, regions, context snapshot, mode
// flags incl. split, both models, thinking levels, prompt-shaping settings,
// manga scope); routing-only hints (prompt_cache_key, session affinity) stay
// out. Raw msg values + split (effective flags derive from those — no logic
// duplication). Deterministic by construction (fixed-order array).
// A miss only costs the optimization (fresh call, today's behavior); a hit
// across documents is safe because equal inputs mean an equally valid output
// (same content-identity philosophy as the page cache).
export interface TranslateRequestFingerprint {
    cacheKey: string;
    imagesB64: string[];
    regions: RegionInput[];
    context: ContextState;
    vision: boolean; textOnly: boolean; ocr: boolean; split: boolean;
    pageW: number; pageH: number;
}
export interface TranslateFingerprintSettings {
    provider: string; model: string; baseUrl: string; ocrModel: string;
    thinkingLevel: string; ocrThinking: string;
    useOcrModel: boolean; stylePrompt: string; targetLang: string;
    useCharacters: boolean; contextPairs: number; transcribeSrc: boolean; vlmAssisted: boolean;
}
export function translateRequestParts(
    req: TranslateRequestFingerprint, st: TranslateFingerprintSettings,
): (string | number | boolean)[] {
    return [
        'mt-tr-v1', req.cacheKey,
        st.provider, st.model, st.baseUrl, st.ocrModel,
        st.thinkingLevel, st.ocrThinking,
        st.useOcrModel, st.stylePrompt, st.targetLang,
        st.useCharacters, st.contextPairs, st.transcribeSrc, st.vlmAssisted,
        req.vision, req.textOnly, req.ocr, req.split, req.pageW, req.pageH,
        JSON.stringify(req.regions), JSON.stringify(req.context),
        ...req.imagesB64,
    ];
}
export async function translateRequestId(parts: (string | number | boolean)[]): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(parts));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
