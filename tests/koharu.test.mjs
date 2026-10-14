import { build, transform } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

const bundle = async entry => {
    const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false });
    return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
};
const { koharuInput, decodeKoharu } = await bundle('src/iframe/koharu.ts');
const { applyPreset, loadPipelineSettings } = await bundle('src/llm/pipeline-settings.ts');
const { settingsFingerprint, isResumable, partialEntry } = await bundle('src/cache/policy.ts');

test('native antialiased RGB resize and normalization matches a non-square reference', () => {
    const pixels = Uint8ClampedArray.from({ length: 5 * 7 * 4 }, (_, i) => i);
    const expected = [-1.9621502161,-1.8555526733,-1.7295145988,-1.6229170561,-1.4027416706,-1.2961441278,-1.1701060534,-1.0635083914,-0.8433331251,-0.7367354035,-0.6106973290,-0.5040999055,-0.2839246392,-0.1773268133,-0.0512887537,0.0553085543,-1.8589768410,-1.7499998808,-1.6211483479,-1.5121715069,-1.2870814800,-1.1781044006,-1.0492531061,-0.9402760863,-0.7151861191,-0.6062090397,-0.4773576260,-0.3683807850,-0.1432908922,-0.0343136489,0.0945377499,0.2035143375,-1.6110633612,-1.5025707483,-1.3742918968,-1.2657994032,-1.0417097807,-0.9332170486,-0.8049382567,-0.6964456439,-0.4723560810,-0.3638633192,-0.2355845869,-0.1270920783,0.0969974250,0.2054903358,0.3337690532,0.4422613084];
    const actual = koharuInput(pixels, 7, 5, 4);
    assert.equal(actual.length, 48);
    assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) < 1e-6));
    assert.throws(() => koharuInput(pixels, 1, 1), /dimensions/);
});

test('fractional image scales preserve native FP32 coordinate precision near the far edge', () => {
    const rgba = Uint8ClampedArray.from({ length:137 * 192 * 4 }, (_, i) => i % 256);
    const actual = koharuInput(rgba, 137, 192, 115);
    const reference = [[0,-1.8371890783],[110,-1.6326242685],[114,-1.3176308870],[12996,0.5069682002],[13224,1.9168220758],[13225,-1.7312264442],[18329,-1.0939903259],[26449,2.1065795422],[28888,0.0147638060],[39674,2.3368687630]];
    assert.ok(reference.every(([i,v]) => Math.abs(actual[i] - v) < 2e-6));
});

const output = {
    dets: { dims: [1,300,4], data: new Float32Array(1200) },
    labels: { dims: [1,300,5], data: new Float32Array(1500) },
    masks: { dims: [1,300,288,288], data: new Float32Array(300 * 288 * 288) },
};
function reset() {
    output.dets.data.fill(0); output.labels.data.fill(-20); output.masks.data.fill(-1);
}
function instance(q, cls, score, rect = [.5,.5,.5,.5]) {
    output.dets.data.set(rect, q * 4);
    output.labels.data[q * 5 + cls] = Math.log(score / (1 - score));
}
function ink(q) { output.masks.data.fill(1, q * 288 * 288, (q + 1) * 288 * 288); }

test('text and effects use sigmoid, per-class thresholds and original coordinates', () => {
    reset(); instance(0,0,.30); ink(0); instance(1,1,.22,[.2,.2,.1,.1]);
    instance(2,2,.7); instance(3,3,.8); instance(4,4,.99);
    const decoded = decodeKoharu(output, 200, 400);
    assert.equal(decoded.boxes.length, 2); assert.equal(decoded.panels.length, 1); assert.equal(decoded.bubbles.length, 1);
    assert.deepEqual(decoded.boxes[0], { x1: 50, y1: 100, x2: 150, y2: 300, conf: decoded.boxes[0].conf });
    assert.ok(new Uint8Array(decoded.mask.data).every(x => x === 255));
    assert.equal(decodeKoharu(output, 200, 400, { text: .4 }).boxes.length, 1);
});

test('balloon, panel, background and rejected instances never contribute erase pixels', () => {
    reset();
    for (const [q, c, conf] of [[0,0,.1],[1,1,.1],[2,2,.9],[3,3,.9],[4,4,.99]]) { instance(q,c,conf); ink(q); }
    const decoded = decodeKoharu(output, 20, 30);
    assert.equal(decoded.boxes.length, 0); assert.equal(decoded.panels.length, 1);
    assert.ok(new Uint8Array(decoded.mask.data).every(x => x === 0));
    reset(); instance(0,0,.9,[.5,.5,.01,.01]); ink(0);
    assert.ok(new Uint8Array(decodeKoharu(output, 20, 30, undefined, 12).mask.data).every(x => x === 0));
});

test('global top-160 query/class ranking is preserved without box NMS', () => {
    reset();
    for (let q = 0; q < 161; q++) instance(q, 0, .9 - q / 1000);
    assert.equal(decodeKoharu(output, 2, 2, undefined, 0).boxes.length, 160);
});

test('bubble instance spans preserve segmentation holes without entering the erase mask', () => {
    reset(); instance(0,2,.9,[.5,.5,1,1]);
    for (let y=0;y<288;y++) {
        output.masks.data.fill(1,y*288,y*288+96);
        output.masks.data.fill(1,y*288+192,y*288+288);
    }
    const decoded=decodeKoharu(output,6,6);
    assert.equal(decoded.balloons.length,1);
    assert.deepEqual(decoded.balloons[0].rows[3],[0,2,4,6]);
    assert.ok(new Uint8Array(decoded.mask.data).every(x=>x===0));
});

test('instance logits interpolate before threshold and invalid outputs fail loudly', () => {
    reset(); instance(0,0,.9);
    for (let y = 0; y < 288; y++) output.masks.data.fill(1, y * 288, y * 288 + 144);
    assert.deepEqual([...new Uint8Array(decodeKoharu(output, 4, 1, undefined, 0).mask.data)], [255,255,0,0]);
    output.masks.data[0] = NaN;
    assert.throws(() => decodeKoharu(output, 4, 1), /invalid values/);
    assert.throws(() => decodeKoharu({ ...output, dets: output.labels }, 4, 1), /outputs/);
});

test('model selection migrates defensively and survives quality presets', () => {
    assert.equal(loadPipelineSettings({}).layoutModel, 'koharu');
    assert.equal(loadPipelineSettings({ layoutModel: 'unknown' }).layoutModel, 'koharu');
    const chosen = loadPipelineSettings({ layoutModel: 'koharu', inferEngine: 'local', detEp: 'wasm', koharuTextConf: .4 });
    assert.equal(applyPreset('fast', chosen).layoutModel, 'koharu');
    assert.equal(applyPreset('best', chosen).detEp, 'wasm');
    for (const invalid of [NaN, Infinity, -1, 2, '0.2']) assert.equal(loadPipelineSettings({ koharuTextConf: invalid }).koharuTextConf, .25);
});

test('CTD cache identity ignores Koharu settings; Koharu model and thresholds separate checkpoints', () => {
    const original = '["Thai","crops","baberu","rtl",0.35,12,0.2,true,false,false,false,null,0,"local",["jpn","eng"],"",false,1280,420,0.85,true,true,true,true,15,10,"auto","none",3,"tile40"]';
    assert.equal(settingsFingerprint({ layoutModel: 'ctd' }), original);
    assert.equal(settingsFingerprint({ layoutModel: 'ctd', koharuTextConf: .5 }), original);
    const fp = settingsFingerprint({ layoutModel: 'koharu' });
    assert.equal(settingsFingerprint({}), fp);
    assert.notEqual(fp, original); assert.notEqual(fp, settingsFingerprint({ layoutModel: 'koharu', koharuTextConf: .5 }));
    const checkpoint = partialEntry('chapter#hash', fp, { boxes: [{x1:0,y1:0,x2:4,y2:4,conf:1}], panels: [],
        ep: 'webgpu', mask: { width:4,height:4,data:new Uint8Array(16).fill(255).buffer } }, 4, 4);
    assert.equal(isResumable(checkpoint, original, 4, 4, false), false);
    assert.equal(isResumable(checkpoint, fp, 4, 4, false), true);
});

test('cloud cache defaults agree with loaded settings and the existing CTD identity', () => {
    const legacy = { inferEngine: 'cloud' };
    assert.equal(settingsFingerprint(legacy), settingsFingerprint({ ...legacy, layoutModel: 'ctd' }));
    assert.equal(settingsFingerprint(legacy), settingsFingerprint(loadPipelineSettings(legacy)));
    assert.notEqual(settingsFingerprint(legacy), settingsFingerprint({ ...legacy, layoutModel: 'koharu' }));
});

const file = ts.createSourceFile('pipeline.ts', readFileSync('src/content/pipeline.ts','utf8'), ts.ScriptTarget.Latest, true);
const fns = file.statements.filter(n => ts.isFunctionDeclaration(n) && ['orderDetection','detectPage'].includes(n.name?.text));
const compiled = await transform(fns.map(n => n.getText(file)).join('\n').replaceAll('export ',''), { loader:'ts' });
function pipelineFixture(settings) {
    const scope = { pipeline: loadPipelineSettings(settings), chrome: { storage:{ local:{ get:async()=>({}) } } },
        recordChapterLog(){}, mergeParagraphLines: boxes=>boxes, panelsUsable:()=>true,
        sortReadingOrder: boxes=>boxes, orderByPanels: boxes=>boxes, dropContainedBoxes: boxes=>boxes,
        panelsDetect:()=>{ throw new Error('Legacy panel model must not run'); },
        cloudDetect:()=>{ throw new Error('Page must not upload'); }, detect:()=>{ throw new Error('Local must not run'); } };
    runInNewContext(compiled.code, scope); return scope;
}
test('Koharu ordering consumes its own panels, including an empty panel result', async () => {
    for (const panels of [[],[{x1:0,y1:0,x2:20,y2:20,conf:1}]]) {
        const f = pipelineFixture({ layoutModel:'koharu' });
        await f.orderDetection({ layoutModel:'koharu',ep:'webgpu',boxes:[],mask:{},panels }, {width:20,height:20});
    }
});
test('unsupported Cloud selection fails before local inference or page upload', async () => {
    const f = pipelineFixture({ layoutModel:'koharu', inferEngine:'cloud' });
    await assert.rejects(f.detectPage({},()=>{}), e => e.kind === 'cloud' && /On-device/.test(e.message));
});
