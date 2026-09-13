// Unit tests for thinking-level → provider param mapping + fallback chain.
// Run: npm test (builds adapters.ts to ESM first — node:test can't load TS directly)
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/llm/adapters.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/thinking-adapters.mjs', sourcemap: 'inline',
});

const { callLLM, checkThinking, thinkingSmell, LlmHttpError } =
  await import(new URL('../.test-build/thinking-adapters.mjs', import.meta.url).href);

// ---- fetch stub: scripted responses, records request bodies ----

let queue;
let bodies;
let headers;
const okBody = {
  openai: { choices: [{ message: { content: 'x' } }], usage: {} },
  responses: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }], usage: {} },
  anthropic: { content: [{ type: 'text', text: 'x' }], usage: {} },
  gemini: { candidates: [{ content: { parts: [{ text: 'x' }] } }], usageMetadata: {} },
};

function stubFetch(provider) {
  bodies = [];
  headers = [];
  queue = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    headers.push(init.headers);
    const next = queue.shift() ?? { status: 200 };
    if (next.status !== 200) {
      return { ok: false, status: next.status, text: async () => next.msg };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(okBody[provider]) };
  };
}

const settings = (provider) => ({ provider, model: 'm', apiKey: 'k', baseUrl: 'https://t.test' });

// ---- OpenAI + Responses: verbatim passthrough ----

test('openai passes max through; custom text goes verbatim', async () => {
  stubFetch('openai');
  await callLLM(settings('openai'), 'p', undefined, 'max');
  assert.equal(bodies[0].reasoning_effort, 'max');
  await callLLM(settings('openai'), 'p', undefined, 'turbo');
  assert.equal(bodies[1].reasoning_effort, 'turbo');
});

test('openai none is explicit; auto omits the param', async () => {
  stubFetch('openai');
  await callLLM(settings('openai'), 'p', undefined, 'none');
  assert.equal(bodies[0].reasoning_effort, 'none');
  await callLLM(settings('openai'), 'p', undefined, 'auto');
  assert.ok(!('reasoning_effort' in bodies[1]));
});

test('responses maps to reasoning.effort', async () => {
  stubFetch('responses');
  await callLLM(settings('responses'), 'p', undefined, 'xhigh');
  assert.deepEqual(bodies[0].reasoning, { effort: 'xhigh' });
});

// ---- Anthropic: adaptive first, legacy budget fallback, omit last ----

test('anthropic high sends adaptive+effort with headroom', async () => {
  stubFetch('anthropic');
  await callLLM(settings('anthropic'), 'p', undefined, 'high');
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].thinking, { type: 'adaptive' });
  assert.deepEqual(bodies[0].output_config, { effort: 'high' });
  assert.equal(bodies[0].max_tokens, 16384);
});

test('anthropic none omits thinking', async () => {
  stubFetch('anthropic');
  await callLLM(settings('anthropic'), 'p', undefined, 'none');
  assert.ok(!('thinking' in bodies[0]));
});

test('anthropic legacy fallback on thinking-400 (old models)', async () => {
  stubFetch('anthropic');
  queue = [{ status: 400, msg: 'thinking: adaptive thinking is not supported by this model' }];
  await callLLM(settings('anthropic'), 'p', undefined, 'high');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].thinking, { type: 'enabled', budget_tokens: 8192 });
});

test('anthropic custom number becomes a legacy budget after adaptive 400', async () => {
  stubFetch('anthropic');
  queue = [{ status: 400, msg: 'invalid effort value' }];
  await callLLM(settings('anthropic'), 'p', undefined, '12000');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].thinking, { type: 'enabled', budget_tokens: 12000 });
});

test('anthropic custom string skips legacy (no budget) and retries omitted', async () => {
  stubFetch('anthropic');
  queue = [{ status: 400, msg: 'invalid effort value: turbo' }];
  await callLLM(settings('anthropic'), 'p', undefined, 'turbo');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].output_config, { effort: 'turbo' });
  assert.ok(!('thinking' in bodies[1]));
});

test('anthropic non-thinking 400 goes straight to omit-retry (no middle attempt)', async () => {
  stubFetch('anthropic');
  queue = [{ status: 400, msg: 'images: invalid base64 data uri' }];
  await callLLM(settings('anthropic'), 'p', undefined, 'high');
  assert.equal(bodies.length, 2);
  assert.ok(!('thinking' in bodies[1]));
});

// ---- Gemini: level first, numeric budget, 2.5 fallback ----

test('gemini low sends thinkingLevel, not thinkingBudget', async () => {
  stubFetch('gemini');
  await callLLM(settings('gemini'), 'p', undefined, 'low');
  assert.deepEqual(bodies[0].generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});

test('gemini none maps to minimal; xhigh/max degrade to high', async () => {
  stubFetch('gemini');
  await callLLM(settings('gemini'), 'p', undefined, 'none');
  await callLLM(settings('gemini'), 'p', undefined, 'max');
  assert.deepEqual(bodies[0].generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  assert.deepEqual(bodies[1].generationConfig.thinkingConfig, { thinkingLevel: 'high' });
});

test('gemini bare number is a token budget', async () => {
  stubFetch('gemini');
  await callLLM(settings('gemini'), 'p', undefined, '12000');
  assert.deepEqual(bodies[0].generationConfig.thinkingConfig, { thinkingBudget: 12000 });
});

test('gemini 2.5 fallback: level 400 retries with budget', async () => {
  stubFetch('gemini');
  queue = [{ status: 400, msg: 'thinkingLevel is not supported for gemini-2.5-flash' }];
  await callLLM(settings('gemini'), 'p', undefined, 'high');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].generationConfig.thinkingConfig, { thinkingBudget: 8192 });
});

test('gemini auto omits generationConfig', async () => {
  stubFetch('gemini');
  await callLLM(settings('gemini'), 'p', undefined, 'auto');
  assert.ok(!('generationConfig' in bodies[0]));
});

// ---- checkThinking: single-shot probe, no fallback ----

test('checkThinking accepted on 200, exactly one call', async () => {
  stubFetch('openai');
  assert.equal(await checkThinking(settings('openai'), 'high'), 'accepted');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].reasoning_effort, 'high');
});

test('checkThinking throws thinking-smelling 400 with no retry', async () => {
  stubFetch('openai');
  queue = [{ status: 400, msg: 'reasoning_effort is not supported by this model' }];
  await assert.rejects(checkThinking(settings('openai'), 'high'), (e) => {
    assert.ok(e instanceof LlmHttpError);
    assert.ok(thinkingSmell(e));
    return true;
  });
  assert.equal(bodies.length, 1); // no omit-retry — that's callLLM's job
});

test('checkThinking passes non-thinking errors through unclassified', async () => {
  stubFetch('openai');
  queue = [{ status: 429, msg: 'rate limited, slow down' }];
  await assert.rejects(checkThinking(settings('openai'), 'high'), (e) => {
    assert.ok(e instanceof LlmHttpError);
    assert.ok(!thinkingSmell(e));
    return true;
  });
});

test('checkThinking forwards the session header (missing-session proxies)', async () => {
  stubFetch('responses');
  await checkThinking(settings('responses'), 'high', 'test');
  assert.equal(headers[0]['x-opencode-session'], 'mt-test');
  await checkThinking(settings('responses'), 'high');
  assert.ok(!('x-opencode-session' in headers[1]));
});

test("checkThinking probes 'none' too — it is transmitted, not a no-op", async () => {
  stubFetch('openai');
  assert.equal(await checkThinking(settings('openai'), 'none', 'test'), 'accepted');
  assert.equal(bodies[0].reasoning_effort, 'none');
});
