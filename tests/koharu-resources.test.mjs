import { transform } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

const file = ts.createSourceFile('worker.ts', readFileSync('src/iframe/worker.ts','utf8'), ts.ScriptTarget.Latest, true);
const functions = file.statements.filter(n => ts.isFunctionDeclaration(n) && ['withLayoutLock','pumpLayout','releaseKoharu','runKoharu'].includes(n.name?.text));
const compiled = await transform('const layoutQ=[]; let layoutBusy=false, koharuSession=null, koharuEp="";\n' + functions.map(n => n.getText(file)).join('\n'), {loader:'ts'});

function fixture({ fails=false, tiles=[] }={}) {
    const images=[], tensors=[], events=[];
    let held=false;
    const scope = { Blob, performance, session:null, panelSession:null, sessionEp:'',sessionInitMs:0,
        pickInferIndex:queue=>queue.findIndex(x=>x.prio===0)<0?0:queue.findIndex(x=>x.prio===0),
        creating:null,panelCreating:null, KOHARU_INPUT:1152,
        splitTiles:()=>tiles,mergeTileBoxes:()=>[], loadKoharuFile:async()=>new ArrayBuffer(1),
        koharuInput:()=>new Float32Array(3),
        decodeKoharu:(_,w,h)=>({boxes:[],panels:[],mask:{width:w,height:h,data:new Uint8Array(w*h).fill(255).buffer}}),
        async createImageBitmap(source,...args) { const bmp={width:args[2]??8,height:args[3]??8,closed:0,close(){this.closed++;}};images.push(bmp);return bmp; },
        OffscreenCanvas:class { constructor(w,h){this.width=w;this.height=h;} getContext(){return {drawImage(){},getImageData(){return {data:new Uint8ClampedArray(256)};}};} },
        async withInferLock(fn) { assert.equal(held,false); held=true;try {return await fn();}finally{held=false;} },
        ort:{Tensor:class {constructor(){this.closed=0;tensors.push(this);}dispose(){this.closed++;}},
            InferenceSession:{async create(_,opts){assert.equal(held,true);events.push(opts.executionProviders[0]);return {
                async run(){assert.equal(held,true);if(fails)throw Error('run failed');const out={closed:0,dispose(){this.closed++;}};tensors.push(out);return {masks:out};},
                async release(){assert.equal(held,true);events.push('release');},
            };}}},
    };
    runInNewContext(compiled.code,scope);
    return {...scope,images,tensors,events,scope};
}

for (const fails of [false,true]) test(`Koharu closes input and output tensors on ${fails?'failure':'success'}`,async()=>{
    const f=fixture({fails});
    const work=f.runKoharu(new ArrayBuffer(1),undefined,1,false,0);
    if(fails)await assert.rejects(work,/run failed/);else assert.equal((await work).layoutModel,'koharu');
    assert.ok(f.images.every(x=>x.closed===1));assert.ok(f.tensors.every(x=>x.closed===1));
});
test('Koharu tile masks stitch and all borrowed images close',async()=>{
    const f=fixture({tiles:[{x0:0,y0:0,w:8,h:4},{x0:0,y0:4,w:8,h:4}]});
    const result=await f.runKoharu(new ArrayBuffer(1),undefined,1,false,0);
    assert.ok(new Uint8Array(result.mask.data).every(x=>x===255));
    assert.equal(f.images.length,3);assert.ok(f.images.every(x=>x.closed===1));
});
test('switching to forced CPU releases the GPU session inside the shared lock',async()=>{
    const f=fixture();
    await f.runKoharu(new ArrayBuffer(1),undefined,1,false,0);
    await f.runKoharu(new ArrayBuffer(1),undefined,1,true,0);
    assert.deepEqual(f.events,['webgpu','release','wasm']);
    await f.releaseKoharu();assert.equal(f.events.at(-1),'release');
});
test('layout lane serializes switches and survives a failed request',async()=>{
    const f=fixture(),events=[];let resolve;
    const first=f.withLayoutLock(async()=>{events.push('first');await new Promise(r=>{resolve=r;});throw Error('failed page');});
    const second=f.withLayoutLock(async()=>{events.push('second');});
    await Promise.resolve();assert.deepEqual(events,['first']);resolve();
    await assert.rejects(first,/failed page/);await second;assert.deepEqual(events,['first','second']);
});
test('manual layout work runs before queued background pages without interrupting a borrower',async()=>{
    const f=fixture(),events=[];let resolve;
    const first=f.withLayoutLock(async()=>{events.push('running');await new Promise(r=>{resolve=r;});},1);
    const background=f.withLayoutLock(async()=>{events.push('background');},1);
    const manual=f.withLayoutLock(async()=>{events.push('manual');},0);
    assert.deepEqual(events,['running']);resolve();await Promise.all([first,background,manual]);
    assert.deepEqual(events,['running','manual','background']);
});
