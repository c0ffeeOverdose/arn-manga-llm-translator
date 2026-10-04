// Unit tests for the sync canvas encoders (src/content/encode.ts) — the Android
// workaround path must return the base64 payload and a working PNG Blob without
// touching the async blob encoder.
import { build } from 'esbuild';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const bundle = await build({ entryPoints: ['src/content/encode.ts'], bundle: true, format: 'esm', write: false });
const { canvasJpegB64, canvasPngBlob } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);

const prev = { document: globalThis.document };
after(() => {
  if (prev.document) globalThis.document = prev.document; else delete globalThis.document;
});

test('canvasJpegB64 returns the payload after the comma', () => {
  const canvas = { toDataURL: (type, q) => { assert.equal(type, 'image/jpeg'); assert.equal(q, 0.8); return 'data:image/jpeg;base64,QUJD'; } };
  assert.equal(canvasJpegB64(canvas, 0.8), 'QUJD');
});

test('canvasPngBlob encodes a foreign canvas through a sync data URL', async () => {
  let drew = 0;
  globalThis.document = { createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({ drawImage: () => { drew++; } }),
    toDataURL: () => 'data:image/png;base64,' + Buffer.from('png-bytes').toString('base64'),
  }) };
  const source = { width: 10, height: 20 }; // Offscreen-like: no toDataURL
  const blob = await canvasPngBlob(source);
  assert.equal(drew, 1, 'the source pixels are copied once');
  assert.equal(blob.type, 'image/png');
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), 'png-bytes');
});

test('canvasPngBlob uses an HTML canvas directly', async () => {
  const canvas = {
    width: 4, height: 4,
    toDataURL: () => 'data:image/png;base64,' + Buffer.from('direct').toString('base64'),
  };
  const blob = await canvasPngBlob(canvas);
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), 'direct');
});
