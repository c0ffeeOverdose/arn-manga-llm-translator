// Unit tests for the cloud-detect JPEG payload. Canvas + FileReader are
// stubbed and the fake blob's arrayBuffer() throws the exact Firefox error —
// a regression back to TypedArray byte reads fails here, not on FF.
import { build } from 'esbuild';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/content/detection.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/cloud-detection.mjs', sourcemap: 'inline',
});

const { bitmapToJpegB64, cloudDetect } = await import(new URL('../.test-build/cloud-detection.mjs', import.meta.url).href);

const prev = { OC: globalThis.OffscreenCanvas, FR: globalThis.FileReader, chrome: globalThis.chrome };

function stubGlobals(dataUrl) {
  const calls = { arrayBuffer: 0, readAsDataURL: 0, drawImage: 0 };
  const blob = {
    arrayBuffer() {
      calls.arrayBuffer++;
      throw new Error('Permission denied to access property "constructor"');
    },
  };
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() {
      return {
        drawImage: () => { calls.drawImage++; },
        getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: () => {},
      };
    }
    convertToBlob() { return Promise.resolve(blob); }
  };
  globalThis.FileReader = class {
    readAsDataURL(b) {
      calls.readAsDataURL++;
      this.result = b === blob ? dataUrl : '';
      queueMicrotask(() => this.onload?.());
    }
  };
  return calls;
}

after(() => {
  if (prev.OC) globalThis.OffscreenCanvas = prev.OC; else delete globalThis.OffscreenCanvas;
  if (prev.FR) globalThis.FileReader = prev.FR; else delete globalThis.FileReader;
  if (prev.chrome) globalThis.chrome = prev.chrome; else delete globalThis.chrome;
});

test('cloudDetect preserves and scales split ownership with boxes, texts and patches', async () => {
  stubGlobals('data:image/jpeg;base64,AAECAwQ=');
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true, page: {
    ok: true, boxes: [{ x1: 100, y1: 200, x2: 300, y2: 400, conf: 0.9,
      clip: { x1: 80, y1: 150, x2: 320, y2: 450 }, cutAxis: 'x' }],
    texts: ['source'], patches: [{ i: 0, x1: 90, y1: 190, x2: 310, y2: 410, png: 'AAE=' }],
    splitGen: 5, ms: { detect: 1, ocr: 1, total: 2 },
  } }) } };
  const result = await cloudDetect({ width: 1600, height: 2400 }, 'https://cloud.example.test', 'mock',
    { confThr: 0.35, minSize: 12, quality: 0.85, gray: false });
  assert.deepEqual(result.boxes[0], { x1: 150, y1: 300, x2: 450, y2: 600, conf: 0.9,
    clip: { x1: 120, y1: 225, x2: 480, y2: 675 }, cutAxis: 'x' });
  assert.deepEqual(result.cloudTexts, ['source']);
  assert.deepEqual([result.cloudPatches[0].i, result.cloudPatches[0].x1, result.cloudPatches[0].y1], [0, 135, 285]);
});

test('bitmapToJpegB64: reads the canvas blob via FileReader, never arrayBuffer', async () => {
  const calls = stubGlobals('data:image/jpeg;base64,AAECAwQ=');
  const out = await bitmapToJpegB64({ width: 4, height: 2 }, 0.85, false);
  assert.equal(out, 'AAECAwQ=');
  assert.equal(calls.readAsDataURL, 1);
  assert.equal(calls.arrayBuffer, 0); // the Firefox trap must stay untouched
  assert.equal(calls.drawImage, 1);
});

test('bitmapToJpegB64: grayscale pass still returns the payload', async () => {
  const calls = stubGlobals('data:image/jpeg;base64,//8A');
  const out = await bitmapToJpegB64({ width: 3, height: 1 }, 0.7, true);
  assert.equal(out, '//8A');
  assert.equal(calls.arrayBuffer, 0);
});

test('bitmapToJpegB64: concurrent full-page encodes never overlap (encode lock)', async () => {
  let active = 0, maxActive = 0;
  const blob = { arrayBuffer() { throw new Error('unused'); } };
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() {
      return {
        drawImage() {},
        getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData() {},
      };
    }
    async convertToBlob() {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 25));
      active--;
      return blob;
    }
  };
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = 'data:image/jpeg;base64,AAA=';
      queueMicrotask(() => this.onload?.());
    }
  };
  const [a, b] = await Promise.all([
    bitmapToJpegB64({ width: 4, height: 2 }, 0.8, false),
    bitmapToJpegB64({ width: 4, height: 2 }, 0.8, false),
  ]);
  assert.equal(a, 'AAA=');
  assert.equal(b, 'AAA=');
  assert.equal(maxActive, 1, 'the encode lock must serialize the canvas work');
});
