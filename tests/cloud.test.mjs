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

const { bitmapToJpegB64 } = await import(new URL('../.test-build/cloud-detection.mjs', import.meta.url).href);

const prev = { OC: globalThis.OffscreenCanvas, FR: globalThis.FileReader };

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
