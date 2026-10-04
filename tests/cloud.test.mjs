// Unit tests for the cloud-detect upload payload. The canvas is stubbed through a
// document stub and every encode must go through the sync toDataURL path — a
// regression back to the async blob encoder (convertToBlob/FileReader) for the page
// upload must fail here, not on the phone.
import { build } from 'esbuild';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/content/detection.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/cloud-detection.mjs', sourcemap: 'inline',
});

const { bitmapToJpegB64, cloudDetect, withEncodeLock } = await import(new URL('../.test-build/cloud-detection.mjs', import.meta.url).href);

const prev = { document: globalThis.document, FileReader: globalThis.FileReader, chrome: globalThis.chrome };

function stubGlobals(payload = 'AAECAwQ=') {
  const calls = { readAsDataURL: 0, drawImage: 0, toDataURL: 0, types: [] };
  const makeCanvas = () => ({
    width: 1, height: 1,
    getContext: () => ({
      drawImage: () => { calls.drawImage++; },
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => {},
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    }),
    toDataURL: (type) => { calls.toDataURL++; calls.types.push(type); return `data:${type};base64,${payload}`; },
  });
  globalThis.document = { createElement: () => makeCanvas() };
  // Any FileReader use is a regression to the stalled path.
  globalThis.FileReader = class { readAsDataURL() { calls.readAsDataURL++; throw new Error('FileReader must not be used'); } };
  return calls;
}

after(() => {
  if (prev.document) globalThis.document = prev.document; else delete globalThis.document;
  if (prev.FileReader) globalThis.FileReader = prev.FileReader; else delete globalThis.FileReader;
  if (prev.chrome) globalThis.chrome = prev.chrome; else delete globalThis.chrome;
});

test('cloudDetect preserves and scales split ownership with boxes, texts and patches', async () => {
  const calls = stubGlobals('AAECAwQ=');
  let captured;
  globalThis.chrome = { runtime: { sendMessage: async (msg) => { captured = msg; return { ok: true, page: {
    ok: true, boxes: [{ x1: 100, y1: 200, x2: 300, y2: 400, conf: 0.9,
      clip: { x1: 80, y1: 150, x2: 320, y2: 450 }, cutAxis: 'x' }],
    texts: ['source'], patches: [{ i: 0, x1: 90, y1: 190, x2: 310, y2: 410, png: 'AAE=' }],
    splitGen: 5, ms: { detect: 1, ocr: 1, total: 2 },
  } } } } };
  const result = await cloudDetect({ width: 1600, height: 2400 }, 'https://cloud.example.test', 'mock',
    { confThr: 0.35, minSize: 12, quality: 0.85, gray: false, texts: false });
  assert.deepEqual(result.boxes[0], { x1: 150, y1: 300, x2: 450, y2: 600, conf: 0.9,
    clip: { x1: 120, y1: 225, x2: 480, y2: 675 }, cutAxis: 'x' });
  assert.deepEqual(result.cloudTexts, ['source']);
  assert.deepEqual([result.cloudPatches[0].i, result.cloudPatches[0].x1, result.cloudPatches[0].y1], [0, 135, 285]);
  assert.equal(calls.toDataURL, 1, 'the page upload encodes once');
  assert.equal(calls.readAsDataURL, 0);
  assert.equal(captured.texts, false, 'page/crops mode asks the server to skip OCR');
});

test('cloudDetect keeps asking for OCR texts when the caller needs them', async () => {
  stubGlobals('AAECAwQ=');
  let captured;
  globalThis.chrome = { runtime: { sendMessage: async (msg) => { captured = msg; return { ok: true, page: {
    ok: true, boxes: [], texts: [], splitGen: 5, ms: { detect: 1, ocr: 1, total: 2 },
  } } } } };
  await cloudDetect({ width: 100, height: 100 }, 'https://cloud.example.test', 'mock',
    { confThr: 0.35, minSize: 12, quality: 0.85, gray: false });
  assert.equal(captured.texts, true);
});

test('bitmapToJpegB64: sync toDataURL encode, never the async blob path', async () => {
  const calls = stubGlobals('AAECAwQ=');
  const out = await bitmapToJpegB64({ width: 4, height: 2 }, 0.85, false);
  assert.equal(out, 'AAECAwQ=');
  assert.equal(calls.toDataURL, 1);
  assert.deepEqual(calls.types, ['image/jpeg']);
  assert.equal(calls.readAsDataURL, 0);
  assert.equal(calls.drawImage, 1);
});

test('bitmapToJpegB64: grayscale pass still returns the payload', async () => {
  const calls = stubGlobals('//8A');
  const out = await bitmapToJpegB64({ width: 3, height: 1 }, 0.7, true);
  assert.equal(out, '//8A');
  assert.equal(calls.toDataURL, 1);
  assert.equal(calls.readAsDataURL, 0);
});

test('withEncodeLock serializes concurrent encode work', async () => {
  let active = 0, maxActive = 0;
  const task = () => withEncodeLock(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 25));
    active--;
    return true;
  });
  const results = await Promise.all([task(), task(), task()]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(maxActive, 1, 'the encode lock must serialize its callers');
});
