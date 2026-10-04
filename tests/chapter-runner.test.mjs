// Chapter runner placement: Chromium uses an offscreen document; Firefox uses a hidden
// iframe inside the background page, because runtime.sendMessage is never delivered to the
// sender's own frame — broker and runner cannot share one context.
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/chapter/runner.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/chapter-runner.mjs', sourcemap: 'inline',
});

const { createRunner, runnerKind } =
  await import(new URL('../.test-build/chapter-runner.mjs', import.meta.url).href);

function fakeDom() {
  const appended = [];
  const document = {
    createElement(tag) {
      return { tagName: tag.toUpperCase(), style: {}, isConnected: false, src: '',
        remove() { this.isConnected = false; this.removed = true; } };
    },
    documentElement: { appendChild(el) { el.isConnected = true; appended.push(el); } },
  };
  return { document, appended };
}

test('Firefox: one hidden iframe at the runner page, reused until stopped', async () => {
  const { document, appended } = fakeDom();
  globalThis.document = document;
  globalThis.chrome = { runtime: { getURL: (p) => `moz-extension://test/${p}` } };
  try {
    assert.equal(runnerKind(), 'background');
    const runner = createRunner();
    assert.equal(runner.kind, 'background');
    assert.equal(await runner.live('s'), false);

    await runner.ensure('s');
    assert.equal(appended.length, 1);
    assert.equal(appended[0].tagName, 'IFRAME');
    assert.equal(appended[0].src, 'moz-extension://test/chapter/page.html');
    assert.equal(appended[0].style.display, 'none');
    assert.equal(await runner.live('s'), true);

    await runner.ensure('s');
    assert.equal(appended.length, 1, 'a live frame is reused, never duplicated');

    await runner.stop('s');
    assert.equal(await runner.live('s'), false);
    assert.equal(appended[0].removed, true);

    await runner.ensure('s');
    assert.equal(appended.length, 2, 'a stopped runner gets a fresh frame');
  } finally {
    delete globalThis.document;
    delete globalThis.chrome;
  }
});

test('Chromium: offscreen document path unchanged', async () => {
  const calls = [];
  let hasDoc = false;
  globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://test/${p}` },
    offscreen: {
      hasDocument: async () => hasDoc,
      createDocument: async (opts) => { calls.push(opts); hasDoc = true; },
      closeDocument: async () => { calls.push('close'); hasDoc = false; },
    },
  };
  try {
    assert.equal(runnerKind(), 'offscreen');
    const runner = createRunner();
    await runner.ensure('s');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'chrome-extension://test/chapter/page.html');
    assert.deepEqual(calls[0].reasons, ['WORKERS', 'BLOBS']);
    await runner.ensure('s');
    assert.equal(calls.length, 1, 'an existing offscreen document is reused');
    assert.equal(await runner.live('s'), true);
    await runner.stop('s');
    assert.equal(calls[1], 'close');
    assert.equal(await runner.live('s'), false);
  } finally {
    delete globalThis.chrome;
  }
});

test('the background bundle no longer loads the runner into its own context', () => {
  assert.equal(existsSync(new URL('../src/chapter/boot.ts', import.meta.url)), false, 'boot.ts is gone');
  const bg = readFileSync(new URL('../src/background/background.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(bg, /bootChapterRunner|chapter\/boot/, 'no in-context runner boot');
  const page = readFileSync(new URL('../src/chapter/page.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /mt:chapter-runner-(attach|stop)/, 'self-attach only; no direct runner messaging');
});
