// BYOK LLM adapters — 4 protocols, plain fetch, no SDKs. Run in the background service worker.

import { splitStablePrefix, type ContextState, type RegionInput } from './core';

// A page can think for minutes — 240s timeout, shorter aborts mid-generation and double-bills via fallback.
const LLM_TIMEOUT_MS = 240_000;

export interface LLMSettings {
    provider: 'openai' | 'responses' | 'anthropic' | 'gemini' | 'cloudflare';
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
    cloudflare: 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai',
};

export async function callLLM(
    s: LLMSettings,
    prompt: string,
    imagesB64?: string[], // jpeg base64 (no data: prefix); [0] = full page, rest = region crops
    thinkingLevel: string = 'auto', // preset, custom text, or a numeric token budget
    cacheKey?: string, // stable per conversation (manga) — routes provider-side prompt caching
    temperature?: number | null, // pinned sampling temperature; null/undefined = provider default
    maxTokens?: number, // output cap; undefined = adapter default. Transcribe calls pass a
                        // small cap so a model that drifts past the format cannot generate a
                        // very long response at a slow provider
): Promise<LlmResult> {
    if (!s.apiKey) throw new MtError('auth', 'No API key configured — open the extension options');
    if (!s.model) throw new MtError('auth', 'No model configured — open the extension options');
    // provider still in its refusal window: refuse locally, no request sent
    const limited = rateLimitLeft(s);
    if (limited) throw new MtError('ratelimit',
        `Rate limited — ${Math.ceil(limited / 1000)}s left for this provider`,
        'Auto-translate is stopped while the provider cools down; press Translate on a page to retry, or switch model/provider',
        undefined, limited);
    const base = (s.baseUrl || DEFAULT_BASES[s.provider]).replace(/\/$/, '');
    const t = thinkingLevel.trim();
    const thinking = !t || t === 'auto' ? null : t;
    const temp = typeof temperature === 'number' && Number.isFinite(temperature) ? temperature : null;
    const imgs = imagesB64?.length ? imagesB64 : undefined;
    const t0 = Date.now();
    try {
        const r = await dispatch(base, s, prompt, imgs, thinking, cacheKey, temp, maxTokens);
        return { ...r, ms: Date.now() - t0 };
    } catch (e) {
        // refused by the provider: arm the window for this provider|baseUrl
        if (e instanceof LlmHttpError && e.status === 429) noteRateLimit(s, e.retryAfterMs ?? RATE_LIMIT_DEFAULT_MS);
        // some models reject the thinking param entirely — retry once without it
        if (thinking && e instanceof LlmHttpError && (e.status === 400 || e.status === 422)) {
            console.warn('[mt:bg] model rejected thinking level, retrying without');
            try {
                const r = await dispatch(base, s, prompt, imgs, null, cacheKey, temp, maxTokens);
                return { ...r, ms: Date.now() - t0, thinkingDropped: true };
            } catch (e2) {
                if (!(temp != null && e2 instanceof LlmHttpError && /temperature/i.test(e2.message))) throw e2;
                console.warn('[mt:bg] model rejected pinned temperature, retrying without');
                const r = await dispatch(base, s, prompt, imgs, null, cacheKey, null, maxTokens);
                return { ...r, ms: Date.now() - t0, tempDropped: true, thinkingDropped: true };
            }
        }
        // reasoning-first models may reject any non-default temperature — error-driven, no model-name table
        if (temp != null && e instanceof LlmHttpError && (e.status === 400 || e.status === 422) && /temperature/i.test(e.message)) {
            console.warn('[mt:bg] model rejected pinned temperature, retrying without');
            const r = await dispatch(base, s, prompt, imgs, thinking, cacheKey, null, maxTokens);
            return { ...r, ms: Date.now() - t0, tempDropped: true };
        }
        throw e;
    }
}

function dispatch(base: string, s: LLMSettings, prompt: string, imgs: string[] | undefined, thinking: string | null, cacheKey?: string, temperature?: number | null, maxTokens?: number): Promise<{ text: string; usage?: LlmUsage }> {
    switch (s.provider) {
        case 'openai': return openaiChat(base, s, prompt, imgs, thinking, cacheKey, temperature, maxTokens);
        case 'responses': return responses(base, s, prompt, imgs, thinking, cacheKey, temperature, maxTokens);
        case 'anthropic': return anthropic(base, s, prompt, imgs, thinking, cacheKey, temperature, maxTokens);
        case 'gemini': return gemini(base, s, prompt, imgs, thinking, cacheKey, temperature, maxTokens);
        case 'cloudflare': return cloudflareChat(base, s, prompt, imgs, thinking, cacheKey, temperature, maxTokens);
    }
}

// Provider-visible session id: opaque digest, never the raw reader URL (per-install salt).
export function sessionKey(raw: string, salt = 0): string {
    let h1 = 0xdeadbeef ^ salt, h2 = 0x41c6ce57 ^ salt;
    for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// ---- error taxonomy: every failure the user can hit, with an actionable hint

export type MtErrorKind = 'auth' | 'ratelimit' | 'network' | 'server' | 'parse';

export class MtError extends Error {
    // set when the provider rejected the REQUEST's image COUNT (not image support):
    // split-OCR falls back to one-image-per-region calls and remembers the verdict
    constructor(public kind: MtErrorKind, msg: string, public hint?: string, public imageCap?: boolean,
        // 429 only: providers asked wait time; content arms its auto-halt window from this.
        public retryAfterMs?: number) { super(msg); }
}
// "too many images" classification: tagged by adapters (CF 3030) or keyword-matched.
// Must NOT match "can't read images" (that needs Local OCR, not per-region calls).
export function isImageCapError(e: unknown): boolean {
    if (!(e instanceof MtError)) return false;
    if (e.imageCap) return true;
    if (e.kind !== 'parse') return false;
    const m = e.message;
    if (!/image/i.test(m)) return false;
    if (/not support|unsupported|invalid|base64|data uri|media_type|can't read|cannot read/i.test(m)) return false;
    return /too many|maximum|max(imum)? of|only one|single image|one image per|limit/i.test(m);
}

// result of one LLM call: text + normalized usage (when the provider reports it)
export interface LlmUsage { inTok?: number; outTok?: number; cachedInTok?: number }
export interface LlmResult {
    text: string; usage?: LlmUsage; ms: number;
    tempDropped?: boolean; // the model rejected the pinned temperature; retried without it (OCR memoizes this per model)
    thinkingDropped?: boolean; // the model rejected the thinking param; retried without (OCR memoizes this per model)
}

// Provider JSON is untrusted (BYOK baseUrl can be a proxy): coerce usage counters
// here or crafted values ride into the popup usage box and run in extension origin.
const num = (v: unknown): number | undefined => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };

class LlmHttpError extends Error {
    constructor(public status: number, msg: string, public providerCode?: number, public retryAfterMs?: number) { super(msg); }
}

// exported for tests (lets them build a faithful 400 without touching fetch)
export { LlmHttpError };

// ---- provider rate-limit breaker ----
// A 429 is a refusal, not a hiccup: refuse locally until the window passes —
// content halts auto and the user decides what to do next.
const RATE_LIMIT_DEFAULT_MS = 45_000;
const RATE_LIMIT_MAX_MS = 300_000;
const rateLimitedUntil = new Map<string, number>();
function rlKey(s: LLMSettings): string { return `${s.provider}|${s.baseUrl ?? ''}`; }
// Retry-After: seconds or HTTP-date (missing/garbage = the default window).
function retryAfterFrom(resp: Response): number {
    const h = resp.headers?.get?.('Retry-After')?.trim();
    if (!h) return RATE_LIMIT_DEFAULT_MS;
    const secs = Number(h);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - Date.now();
    if (!Number.isFinite(ms)) return RATE_LIMIT_DEFAULT_MS;
    return Math.min(RATE_LIMIT_MAX_MS, Math.max(1000, ms));
}
function rateLimitLeft(s: LLMSettings): number {
    const until = rateLimitedUntil.get(rlKey(s));
    if (!until) return 0;
    if (until <= Date.now()) { rateLimitedUntil.delete(rlKey(s)); return 0; }
    return until - Date.now();
}
function noteRateLimit(s: LLMSettings, ms: number): void {
    rateLimitedUntil.set(rlKey(s), Date.now() + Math.min(RATE_LIMIT_MAX_MS, Math.max(1000, ms)));
}

async function checkOk(resp: Response): Promise<string> {
    const text = await resp.text();
    if (!resp.ok) throw new LlmHttpError(resp.status, `LLM API ${resp.status}: ${text.slice(0, 300)}`,
        undefined, resp.status === 429 ? retryAfterFrom(resp) : undefined);
    return text;
}

// HTTP/network errors → MtError with the hint the toast will show
export function toMtError(e: unknown): MtError {
    if (e instanceof MtError) return e;
    if (e instanceof LlmHttpError) {
        if (e.status === 401 || e.status === 403) {
            // Some CF models gate behind a one-time license agreement — point at the agree call.
            if (/model agreement|[Cc]ommunity [Ll]icense|submit the prompt/i.test(e.message))
                return new MtError('auth', e.message, 'Model license not accepted — send {"prompt":"agree"} once to the model\'s /ai/run URL (Cloudflare), then Test again');
            return new MtError('auth', e.message, 'API key is wrong or expired — check the key in Settings');
        }
        if (e.status === 402) return new MtError('auth', e.message, 'Out of credits/quota — top up or switch provider');
        if (e.status === 404) return new MtError('auth', e.message, 'Wrong model name — check the model in Settings');
        if (e.status === 429) return new MtError('ratelimit', e.message,
            'Rate limited by the provider — auto-translate is stopped. Wait for the cooldown, then press Translate on a page (or lower Parallel LLM / check the model quota)',
            undefined, e.retryAfterMs);
        if (e.status === 400 && /image|base64|data uri|input_image|multimodal|media_type|content\[|not support/i.test(e.message))
            return new MtError('parse', e.message, "This model can't read images — switch to Local OCR or pick another model");
        if (e.status >= 500) return new MtError('server', e.message, 'Provider is temporarily down — you can retry');
    }
    if (e instanceof TypeError) return new MtError('network', String(e), 'Cannot reach the provider — check your network/baseUrl');
    const m = new MtError('parse', String(e));
    return m;
}

// Thinking levels: one combobox in options (free-text allowed). Mapped per provider;
// the API is the authority, rejections fall back down the chain.
export type ThinkingPreset = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const FULL_LEVELS: ThinkingPreset[] = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];
// Gemini 3 levels stop at high (no xhigh/max/none — none maps to minimal)
export const THINKING_LEVELS: Record<LLMSettings['provider'], ThinkingPreset[]> = {
    openai: FULL_LEVELS,
    responses: FULL_LEVELS,
    anthropic: FULL_LEVELS,
    gemini: ['auto', 'none', 'low', 'medium', 'high'],
    cloudflare: ['auto', 'none', 'low', 'medium', 'high'],
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
// error smells like a rejected thinking param (not e.g. an image error); the Test probe classifies with it
export function thinkingSmell(e: unknown): boolean {
    return e instanceof LlmHttpError && (e.status === 400 || e.status === 422)
        && /thinking|budget|effort|adaptive|reasoning/i.test(e.message);
}

// Single-shot thinking probe for Test: direct dispatch with NO fallback (omit-retry would mask rejection).
// Silent-ignore providers report accepted without effect — rejection, not effect, is what's probed.
export async function checkThinking(s: LLMSettings, thinking: string, cacheKey?: string): Promise<'accepted'> {
    const base = (s.baseUrl || DEFAULT_BASES[s.provider]).replace(/\/$/, '');
    await dispatch(base, s, 'Reply with exactly: pong', undefined, thinking, cacheKey);
    return 'accepted';
}

// OpenAI-compatible chat/completions (OpenAI, OpenRouter, ollama, gemini-compat...)
async function openaiChat(base: string, s: LLMSettings, prompt: string, images?: string[], thinking: string | null = null, cacheKey?: string, temperature?: number | null, maxTokens?: number): Promise<{ text: string; usage?: LlmUsage }> {
    const content: unknown[] = [{ type: 'text', text: prompt }];
    for (const b64 of images ?? []) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
    const body: Record<string, unknown> = {
        model: s.model,
        messages: [{ role: 'user', content }],
        max_tokens: maxTokens ?? 4096,
    };
    if (thinking) body.reasoning_effort = thinking; // GPT-5/o-series via chat; ignored by older
    if (temperature != null) body.temperature = temperature;
    if (cacheKey) body.prompt_cache_key = cacheKey; // OpenAI routing stickiness (60→87% hit in their docs); ignored by others
    const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${s.apiKey}`,
            ...(cacheKey ? { 'x-opencode-session': cacheKey } : {}), // opencode Go session affinity; harmless elsewhere
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    const text = await checkOk(resp);
    const data = JSON.parse(text);
    return {
        text: data.choices?.[0]?.message?.content ?? '',
        usage: { inTok: num(data.usage?.prompt_tokens), outTok: num(data.usage?.completion_tokens), cachedInTok: num(data.usage?.prompt_tokens_details?.cached_tokens) },
    };
}

// Responses API (OpenAI responses, OpenCode Zen/Go, Muse Spark)
async function responses(base: string, s: LLMSettings, prompt: string, images?: string[], thinking: string | null = null, cacheKey?: string, temperature?: number | null, maxTokens?: number): Promise<{ text: string; usage?: LlmUsage }> {
    const content: unknown[] = [{ type: 'input_text', text: prompt }];
    for (const b64 of images ?? []) content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${b64}` });
    const body: Record<string, unknown> = { model: s.model, input: [{ role: 'user', content }] };
    if (thinking) body.reasoning = { effort: thinking };
    if (temperature != null) body.temperature = temperature;
    // max_output_tokens only when explicitly set — the cap INCLUDES reasoning tokens,
    // so a default would truncate to an empty `status: incomplete` output.
    if (maxTokens != null) body.max_output_tokens = maxTokens;
    if (cacheKey) body.prompt_cache_key = cacheKey;
    const resp = await fetch(`${base}/responses`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${s.apiKey}`,
            ...(cacheKey ? { 'x-opencode-session': cacheKey } : {}), // required for opencode Go caching; 09/06+ requests without it may error
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    const text = await checkOk(resp);
    const data = JSON.parse(text);
    const out: string[] = [];
    for (const item of data.output ?? []) {
        if (item.type === 'message') {
            for (const c of item.content ?? []) if (c.type === 'output_text') out.push(c.text);
        }
    }
    const answer = out.join('\n');
    // truncated before the message started: whole budget went to reasoning.
    // Empty string would misread downstream as "ignored the output format".
    if (!answer && data.status === 'incomplete') {
        const reason = String(data.incomplete_details?.reason ?? 'unknown');
        // how much budget burned before answering: no fixed cap fixes thinking-exhaustion — change model or Thinking level
        const reasoning = num(data.usage?.output_tokens_details?.reasoning_tokens);
        if (reasoning) console.warn(`[mt:bg] model ran out of output tokens while reasoning (${reasoning} reasoning tokens)`);
        throw new MtError('parse', `Model response incomplete (${reason}) with no output${reasoning ? ` (reasoning ${reasoning} tokens)` : ''}`,
            reason === 'max_output_tokens'
                ? 'The model ran out of output tokens before answering (reasoning counts toward the cap) — lower Thinking in Options or pick a lighter model'
                : 'The provider cut the response short — retry, or pick another model in Options');
    }
    return {
        text: answer,
        usage: { inTok: num(data.usage?.input_tokens), outTok: num(data.usage?.output_tokens), cachedInTok: num(data.usage?.input_tokens_details?.cached_tokens) },
    };
}

// legacy fixed-budget scheme (Sonnet/Opus 4.5 and earlier) + adaptive headroom
const ANTHROPIC_BUDGET: Record<string, number> = { low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32000 };
const ANTHROPIC_MAXTOK: Record<string, number> = { low: 8192, medium: 8192, high: 16384, xhigh: 32768, max: 65536 };

// Anthropic messages API (direct browser access header)
async function anthropic(base: string, s: LLMSettings, prompt: string, images?: string[], thinking: string | null = null, cacheKey?: string, temperature?: number | null, maxTokens?: number): Promise<{ text: string; usage?: LlmUsage }> {
    // cache needs explicit breakpoint on the STABLE part: split at <regions>.
    // Text-first so volatile images can't cut the prefix.
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
    const baseBody: Record<string, unknown> = { model: s.model, max_tokens: maxTokens ?? 4096, messages: [{ role: 'user', content }] };
    // temperature and extended thinking are mutually exclusive (API 400) — drop temperature, keep talking
    if (temperature != null && (!thinking || thinking === 'none')) baseBody.temperature = temperature;
    const send = async (patch: Record<string, unknown>): Promise<{ text: string; usage?: LlmUsage }> => {
        const body = { ...baseBody, ...patch };
        const resp = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': s.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
                ...(cacheKey ? { 'x-opencode-session': cacheKey } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        });
        const text = await checkOk(resp);
        const data = JSON.parse(text);
        return {
            text: (data.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'),
            usage: { inTok: num(data.usage?.input_tokens), outTok: num(data.usage?.output_tokens), cachedInTok: num(data.usage?.cache_read_input_tokens) },
        };
    };
    if (!thinking || thinking === 'none') return send({});
    // modern scheme first: adaptive thinking + effort. Thinking counts toward max_tokens, so xhigh/max need headroom.
    try {
        return await send({
            max_tokens: ANTHROPIC_MAXTOK[thinking] ?? 16384,
            thinking: { type: 'adaptive' },
            output_config: { effort: thinking },
        });
    } catch (e) {
        if (!thinkingSmell(e)) throw e;
    }
    // legacy scheme: fixed budget. Custom numbers go verbatim; custom strings rethrow into the omit-retry.
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
async function gemini(base: string, s: LLMSettings, prompt: string, images?: string[], thinking: string | null = null, cacheKey?: string, temperature?: number | null, maxTokens?: number): Promise<{ text: string; usage?: LlmUsage }> {
    const parts: unknown[] = [{ text: prompt }];
    for (const b64 of images ?? []) parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
    const send = async (thinkingConfig?: Record<string, unknown>): Promise<{ text: string; usage?: LlmUsage }> => {
        const body: Record<string, unknown> = { contents: [{ parts }] };
        const generationConfig: Record<string, unknown> = {};
        if (temperature != null) generationConfig.temperature = temperature;
        if (maxTokens != null) generationConfig.maxOutputTokens = maxTokens;
        if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
        if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
        // no prompt_cache_key: Gemini rejects unknown body fields with a 400
        const resp = await fetch(`${base}/models/${s.model}:generateContent?key=${encodeURIComponent(s.apiKey)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(cacheKey ? { 'x-opencode-session': cacheKey } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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

// Cloudflare Workers AI (native run endpoint). Vision goes through /ai/run/<model>;
// the /ai/v1 compat endpoint dies on some models. Caps are NOT hardcoded — 3030 maps to a hint.
export function cfRunUrl(base: string, model: string): string {
    // accept both bases: .../ai and the OpenAI-compatible .../ai/v1
    const b = base.replace(/\/+$/, '').replace(/\/v1$/, '');
    return `${b}/run/${model.replace(/^\/+/, '')}`;
}
export function cfBody(prompt: string, images?: string[], thinking?: string | null, temperature?: number | null, maxTokens?: number): Record<string, unknown> {
    const content: unknown[] = [{ type: 'text', text: prompt }];
    for (const b64 of images ?? []) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
    // max_tokens explicit: native default 256 truncates. Temperature defaults 0 (CF 0.6 drifts); explicit setting overrides.
    const body: Record<string, unknown> = { messages: [{ role: 'user', content }], max_tokens: maxTokens ?? 4096, temperature: temperature ?? 0 };
    // 'none' = omit the param (CF 400s the literal); other levels ride along with the same fallback
    if (thinking && thinking !== 'none') body.reasoning_effort = thinking;
    return body;
}
export function cfParse(data: {
    result?: {
        response?: unknown;
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
    };
} | null): { text: string; usage?: LlmUsage } {
    const r = data?.result ?? {};
    const msg = r.choices?.[0]?.message;
    const text = typeof r.response === 'string' ? r.response : (typeof msg?.content === 'string' ? msg.content : '');
    return {
        text,
        usage: {
            inTok: num(r.usage?.prompt_tokens),
            outTok: num(r.usage?.completion_tokens),
            cachedInTok: num(r.usage?.prompt_tokens_details?.cached_tokens),
        },
    };
}
// CF reports model errors as errors[] — sometimes with HTTP 200. providerCode carries the first numeric code.
export function cfError(data: { errors?: Array<{ message?: unknown; code?: unknown }> } | null, status: number): LlmHttpError | null {
    const errs = data?.errors;
    if (!errs?.length) return null;
    const msg = errs.map(e => (typeof e?.message === 'string' ? e.message : '')).filter(Boolean).join('; ') || 'Cloudflare Workers AI error';
    const code = typeof errs[0]?.code === 'number' ? errs[0].code : undefined;
    return new LlmHttpError(status, msg, code);
}
// CF 3030 is the AiError bucket; on an image-carrying request it is the multi-image rejection.
export function cfImageCapHint(providerCode: number | undefined, imageCount: number): string | undefined {
    if (providerCode !== 3030 || imageCount < 2) return undefined;
    return `This Cloudflare model may not accept ${imageCount} images in one request — switch "How the model reads text" to OCR text (local Baberu), or pick a model that takes multiple images`;
}
async function cloudflareChat(base: string, s: LLMSettings, prompt: string, images?: string[], thinking: string | null = null, cacheKey?: string, temperature?: number | null, maxTokens?: number): Promise<{ text: string; usage?: LlmUsage }> {
    if (/<ACCOUNT_ID>/.test(base))
        throw new MtError('auth', 'Cloudflare Base URL still contains <ACCOUNT_ID>',
            'Replace <ACCOUNT_ID> with your Cloudflare account id (Settings → Model → Base URL)');
    const resp = await fetch(cfRunUrl(base, s.model), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${s.apiKey}`,
            // prefix-cache affinity: cacheable models only hit on the same instance (vision models report 0)
            ...(cacheKey ? { 'x-opencode-session': cacheKey, 'x-session-affinity': cacheKey } : {}),
        },
        body: JSON.stringify(cfBody(prompt, images, thinking, temperature, maxTokens)),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    // read body FIRST: CF signals model errors as errors[] on 2xx and 4xx — checkOk would throw before hint mapping
    const text = await resp.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* non-JSON below */ }
    const failed = !resp.ok || (data as { success?: unknown } | null)?.success === false;
    if (failed) {
        const err = cfError(data as { errors?: Array<{ message?: unknown; code?: unknown }> }, resp.status)
            ?? new LlmHttpError(resp.status, `LLM API ${resp.status}: ${text.slice(0, 300)}`);
        const hint = cfImageCapHint(err.providerCode, images?.length ?? 0);
        if (hint) throw new MtError('parse', err.message, hint, true);
        if (resp.status === 429) err.retryAfterMs = retryAfterFrom(resp);
        throw err;
    }
    if (!data) throw new LlmHttpError(resp.status, `Cloudflare Workers AI returned non-JSON: ${text.slice(0, 200)}`);
    return cfParse(data as Parameters<typeof cfParse>[0]);
}

// ---- in-flight adoption identity: everything that can change the model's output is in;
// routing-only hints stay out. A miss costs only the optimization (fresh call).
// pageW/pageH are deliberately ABSENT: this id gates a shared LLM call, and page dimensions
// are not the page's content. Including them let two different pages with no images (OCR
// mode) hash identically and share one translation.
export interface TranslateRequestFingerprint {
    cacheKey: string;
    imagesB64: string[];
    regions: RegionInput[];
    context: ContextState;
    vision: boolean; textOnly: boolean; ocr: boolean; split: boolean;
}
export interface TranslateFingerprintSettings {
    provider: string; model: string; baseUrl: string; ocrModel: string;
    thinkingLevel: string; ocrThinking: string;
    temperature: number | null; // null = provider default; pins the main model's sampling
    ocrTemperature: number | null; // null = provider default; pins the VLM reader's transcribe sampling
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
        st.temperature ?? -1,
        st.ocrTemperature ?? -1,
        st.useOcrModel, st.stylePrompt, st.targetLang,
        st.useCharacters, st.contextPairs, st.transcribeSrc, st.vlmAssisted,
        req.vision, req.textOnly, req.ocr, req.split,
        JSON.stringify(req.regions), JSON.stringify(req.context),
        ...req.imagesB64,
    ];
}
export async function translateRequestId(parts: (string | number | boolean)[]): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(parts));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
