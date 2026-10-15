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
await build({entryPoints:['src/layout-model.ts'],format:'esm',outfile:'.test-build/cloud-layout-model.mjs'});
const { KOHARU_MODEL } = await import('../.test-build/cloud-layout-model.mjs');

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
    { confThr: 0.35, minSize: 12, quality: 0.85, gray: false, texts: false, layoutModel: 'ctd' });
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
    { confThr: 0.35, minSize: 12, quality: 0.85, gray: false, layoutModel: 'ctd' });
  assert.equal(captured.texts, true);
});

test('Cloud defaults request Koharu and preserve panels, balloon source dimensions and thresholds', async () => {
  stubGlobals(); let captured;
  const balloon={width:100,height:1600,x1:10,y1:100,x2:20,y2:102,conf:.9,rows:[[10,20],[10,20]]};
  globalThis.chrome={runtime:{sendMessage:async msg=>{captured=msg;return {ok:true,page:{ok:true,
    layoutModel:'koharu',layoutRecipe:KOHARU_MODEL.recipe,modelSha256:KOHARU_MODEL.sha256,
    boxes:[],panels:[{x1:10,y1:20,x2:50,y2:100,conf:.9}],balloons:[balloon]}};}}};
  const thresholds={text:.4,sfx:.3,bubble:.5,panel:.6};
  const result=await cloudDetect({width:200,height:3200},'https://cloud.example.test','mock',
    {confThr:.35,minSize:12,quality:.85,gray:false,koharu:thresholds});
  assert.equal(captured.layoutModel,'koharu');assert.deepEqual(captured.koharu,thresholds);
  assert.equal(result.layoutModel,'koharu');assert.equal(result.ep,'cloud');
  assert.deepEqual(result.panels,[{x1:20,y1:40,x2:100,y2:200,conf:.9}]);
  assert.deepEqual(result.balloons,[balloon]);
});

test('Cloud never stores old-server or mismatched model results as selected Koharu output', async () => {
  stubGlobals();
  for (const identity of [{},{layoutModel:'ctd'},
    {layoutModel:'koharu',layoutRecipe:'old',modelSha256:KOHARU_MODEL.sha256},
    {layoutModel:'koharu',layoutRecipe:KOHARU_MODEL.recipe,modelSha256:'wrong'}]) {
    globalThis.chrome={runtime:{sendMessage:async()=>({ok:true,page:{ok:true,boxes:[],...identity}})}};
    await assert.rejects(cloudDetect({width:10,height:10},'https://cloud.example.test','mock',
      {confThr:.35,minSize:12,quality:.85,gray:false}),/Update your server/);
  }
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
