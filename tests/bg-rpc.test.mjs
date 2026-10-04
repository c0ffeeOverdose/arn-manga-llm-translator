// Background RPC deadlines: a suspended service worker leaves sendMessage pending forever,
// so every call names a timeout and only opt-in retries repeat.
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/bg-rpc.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/bg-rpc.mjs', sourcemap: 'inline',
});

const { sendToBackground, BackgroundTimeoutError } =
  await import(new URL('../.test-build/bg-rpc.mjs', import.meta.url).href);

function withChrome(sendMessage, fn) {
  globalThis.chrome = { runtime: { sendMessage } };
  return Promise.resolve().then(fn).finally(() => { delete globalThis.chrome; });
}

test('resolves with the background response', async () => {
  await withChrome(() => Promise.resolve({ ok: true, n: 1 }), async () => {
    assert.deepEqual(await sendToBackground({ type: 'mt:x' }, { timeoutMs: 200 }), { ok: true, n: 1 });
  });
});

test('a silent background becomes a named timeout, not a hang', async () => {
  await withChrome(() => new Promise(() => {}), async () => {
    await assert.rejects(
      sendToBackground({ type: 'mt:context-save' }, { timeoutMs: 40, label: 'context save' }),
      (e) => e instanceof BackgroundTimeoutError && /context save — background did not respond/.test(e.message),
    );
  });
});

test('retries once on timeout then succeeds (opt-in only)', async () => {
  let calls = 0;
  await withChrome(
    () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve({ ok: true })),
    async () => {
      assert.deepEqual(await sendToBackground({ type: 'mt:x' }, { timeoutMs: 30, retries: 1 }), { ok: true });
      assert.equal(calls, 2);
    },
  );
  calls = 0;
  await withChrome(() => { calls++; return new Promise(() => {}); }, async () => {
    await assert.rejects(sendToBackground({ type: 'mt:x' }, { timeoutMs: 30 }), BackgroundTimeoutError);
    assert.equal(calls, 1, 'no retry without the option');
  });
});

test('connection wake-race errors retry; explicit failures pass through untouched', async () => {
  let calls = 0;
  await withChrome(
    () => (++calls === 1 ? Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')) : Promise.resolve({ ok: true })),
    async () => {
      assert.deepEqual(await sendToBackground({ type: 'mt:x' }, { timeoutMs: 100, retries: 1 }), { ok: true });
      assert.equal(calls, 2);
    },
  );
  calls = 0;
  await withChrome(() => { calls++; return Promise.resolve({ ok: false, error: 'denied' }); }, async () => {
    assert.deepEqual(await sendToBackground({ type: 'mt:x' }, { timeoutMs: 100, retries: 1 }), { ok: false, error: 'denied' });
    assert.equal(calls, 1);
  });
});

test('page-blocking call sites go through the helper (no bare sendMessage left)', () => {
  const files = [
    'src/content/state.ts', 'src/content/ocr.ts', 'src/content/detection.ts',
    'src/content/sweep.ts', 'src/content/worker-token.ts', 'src/content/commands.ts',
    'src/chapter/page.ts',
  ];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /chrome\.runtime\.sendMessage/, `${f} must use sendToBackground`);
  }
});
