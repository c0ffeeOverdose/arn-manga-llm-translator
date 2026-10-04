// Host-access patterns + the Firefox ordering contract: permissions.request must be
// dispatched in the click's own task (before any await), and patterns must be port-free
// (Firefox never matches a match pattern that carries a port).
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/options/host-access.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/host-access.mjs', sourcemap: 'inline',
});

const { hostOriginPatterns, requestHostAccess } =
  await import(new URL('../.test-build/host-access.mjs', import.meta.url).href);

function withChrome(request, fn) {
  globalThis.chrome = { permissions: { request } };
  return Promise.resolve().then(fn).finally(() => { delete globalThis.chrome; });
}

test('origin patterns drop the port', () => {
  assert.deepEqual(hostOriginPatterns(['http://127.0.0.1:9080/']), ['http://127.0.0.1/*']);
  assert.deepEqual(hostOriginPatterns(['https://example.com:8443/v1']), ['https://example.com/*']);
  assert.deepEqual(hostOriginPatterns(['http://[::1]:9080/v1']), ['http://[::1]/*']);
});

test('origin patterns dedupe and skip unparsable / non-http(s) URLs', () => {
  assert.deepEqual(
    hostOriginPatterns(['http://localhost:11434/v1', 'http://localhost:9741/v1', 'ftp://files.test/x', 'nope']),
    ['http://localhost/*'],
  );
  assert.deepEqual(hostOriginPatterns([]), []);
});

test('requestHostAccess dispatches permissions.request synchronously', async () => {
  let called = false;
  await withChrome(
    () => { called = true; return Promise.resolve(true); },
    async () => {
      const pending = requestHostAccess(['http://127.0.0.1/*']);
      assert.equal(called, true, 'request must be dispatched before the first await');
      await pending;
    },
  );
});

test('requestHostAccess: granted resolves, denied / engine error surface as one message', async () => {
  await withChrome(() => Promise.resolve(true), () => requestHostAccess(['https://api.test/*']));
  await withChrome(
    () => Promise.resolve(false),
    () => assert.rejects(
      requestHostAccess(['http://127.0.0.1/*']),
      /Needs access to http:\/\/127\.0\.0\.1\/\* — approve the browser prompt \(permission denied\)/,
    ),
  );
  await withChrome(
    () => Promise.reject(new Error('permissions.request may only be called from a user input handler')),
    () => assert.rejects(requestHostAccess(['http://127.0.0.1/*']), /user input handler/),
  );
});

test('requestHostAccess with no origins never touches the permissions API', async () => {
  await withChrome(
    () => { throw new Error('must not be called'); },
    () => requestHostAccess([]),
  );
});

test('model settings ask through the shared helper only', () => {
  const model = readFileSync(new URL('../src/options/model.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(model, /permissions\.(contains|request)/, 'no ad-hoc permission calls');
  assert.match(model, /from '\.\/host-access'/, 'uses the shared helper');
});
