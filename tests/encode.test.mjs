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
  const temporary = {
    width: 0, height: 0,
    getContext: () => ({ drawImage: () => { drew++; } }),
    toDataURL: () => 'data:image/png;base64,' + Buffer.from('png-bytes').toString('base64'),
  };
  globalThis.document = { createElement: () => temporary };
  const source = { width: 10, height: 20 }; // Offscreen-like: no toDataURL
  const blob = await canvasPngBlob(source);
  assert.equal(drew, 1, 'the source pixels are copied once');
  assert.equal(blob.type, 'image/png');
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), 'png-bytes');
  assert.equal(temporary.width * temporary.height, 0, 'owned pixel storage is released after encoding');
  assert.deepEqual(source, { width: 10, height: 20 }, 'caller keeps its source');
});

test('canvasPngBlob uses an HTML canvas directly', async () => {
  const canvas = {
    width: 4, height: 4,
    toDataURL: () => 'data:image/png;base64,' + Buffer.from('direct').toString('base64'),
  };
  const blob = await canvasPngBlob(canvas);
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), 'direct');
  assert.equal(canvas.width * canvas.height, 16, 'caller-owned pixels remain available');
});

for (const stage of ['draw', 'encode']) test(`canvasPngBlob releases its temporary canvas after ${stage} failure`, async () => {
  const temporary = { width: 0, height: 0,
    getContext: () => ({ drawImage() { if (stage === 'draw') throw Error('draw failed'); } }),
    toDataURL() { throw Error('encode failed'); },
  };
  globalThis.document = { createElement: () => temporary };
  await assert.rejects(canvasPngBlob({ width: 100, height: 200 }), /failed/);
  assert.equal(temporary.width * temporary.height, 0);
});
