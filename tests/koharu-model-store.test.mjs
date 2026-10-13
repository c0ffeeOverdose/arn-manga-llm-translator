import { build } from 'esbuild';
import { IDBFactory } from 'fake-indexeddb';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const result=await build({entryPoints:['src/llm/layout-models.ts'],bundle:true,format:'esm',write:false});
const {importKoharuFile,loadKoharuFile,koharuInstalled,validateKoharuFile}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
const old={indexedDB:globalThis.indexedDB,chrome:globalThis.chrome,fetch:globalThis.fetch,crypto:Object.getOwnPropertyDescriptor(globalThis,'crypto')};
after(()=>{
    globalThis.indexedDB=old.indexedDB;globalThis.chrome=old.chrome;globalThis.fetch=old.fetch;
    if(old.crypto)Object.defineProperty(globalThis,'crypto',old.crypto);
});
function setup() {
    globalThis.indexedDB=new IDBFactory();
    globalThis.chrome={runtime:{getURL:file=>`https://extension.test/${file}`}};
    globalThis.fetch=async()=>{throw Error('No network source');};
}
const digest='35d89289e92a6dba75b9ccd4ebd447a55aad69c993d0a8e439c57509d598dfd6';
function mockHash(hash) {
    Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:async()=>Uint8Array.from(hash.match(/../g),v=>parseInt(v,16)).buffer}}});
}

test('missing model has an actionable import error and never tries a public mirror',async()=>{
    setup();const urls=[];
    globalThis.fetch=async url=>{urls.push(url);return {ok:false};};
    assert.equal(await koharuInstalled(),'missing');
    await assert.rejects(loadKoharuFile(),/Import model file/);
    assert.ok(urls.every(url=>url==='https://extension.test/models/koharu-fp32-chunked.onnx'));
});
test('wrong-size imports leave the model store empty',async()=>{
    setup();await assert.rejects(importKoharuFile(new ArrayBuffer(4)),/149.8 MB/);
    assert.equal(await koharuInstalled(),'missing');
});
test('bundled model availability does not depend on optional extension-resource headers',async()=>{
    setup();globalThis.fetch=async()=>({ok:true,headers:new Headers()});
    assert.equal(await koharuInstalled(),'bundled');
});
test('checksum validation precedes persistence; an imported artifact loads without fetch',async()=>{
    setup();const bytes=new ArrayBuffer(149799163);
    mockHash('0'.repeat(64));
    await assert.rejects(importKoharuFile(bytes),/different Koharu/);
    assert.equal(await koharuInstalled(),'missing');
    mockHash(digest);await validateKoharuFile(bytes);await importKoharuFile(bytes);
    globalThis.fetch=()=>{assert.fail('An imported model must not use bundle/network fetch');};
    assert.equal(await koharuInstalled(),'cached');
    assert.equal((await loadKoharuFile()).byteLength,bytes.byteLength);
});
