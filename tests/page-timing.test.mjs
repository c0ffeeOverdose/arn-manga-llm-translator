import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const bundle = await build({ stdin: { contents: `export * from './src/page-timing'; export { setDebug } from './src/debug';`,
    resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', write: false });
const { PageTimer, lastPageTiming, formatPageTiming, timingSeconds, setDebug } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);

test('timings accumulate in Debug mode and preserve asynchronous failures', async () => {
    setDebug(true);
    const timer = new PageTimer();
    timer.meta.debug = true;
    timer.activate();
    timer.add('cropExpand', 3);
    timer.add('cropExpand', 4);
    assert.equal(timer.measure('paint', () => 42), 42);
    await assert.rejects(timer.measureAsync('llm', async () => { throw new Error('fixture'); }), /fixture/);
    timer.setStage('Translation requests');
    timer.finish('failed');
    const report = lastPageTiming();
    assert.equal(report.state, 'failed');
    assert.equal(report.stage, 'Translation requests');
    assert.equal(report.meta.debug, true);
    assert.equal(report.ms.cropExpand, 7);
    assert.ok(report.ms.llm >= 0);
    assert.ok(report.ms.paint >= 0);
    assert.ok(report.elapsedMs >= 0);
});

test('reports are snapshots and export only safe metadata, never full settings or responses', () => {
    setDebug(true);
    const timer = new PageTimer();
    Object.assign(timer.meta, {
        page: '2000x3000', model: 'test-model', provider: 'openai', calls: 1,
        apiKey: 'PRIVATE_KEY', cloudKey: 'PRIVATE_CLOUD_KEY', url: 'https://reader.test/private',
        source: 'PRIVATE_SOURCE', imagesB64: ['PRIVATE_IMAGE'], raw: 'PRIVATE_RESPONSE',
        cloud: { total: 2000, ocr: 500, endpoint: 'PRIVATE_ENDPOINT' },
    });
    const before = timer.report();
    timer.meta.cloud.total = 3000;
    timer.meta.model = 'another-model';
    assert.equal(before.meta.model, 'test-model');
    assert.equal(before.meta.cloud.total, 2000);
    const text = formatPageTiming(before);
    assert.doesNotMatch(text, /PRIVATE_|reader\.test/);
    assert.match(text, /test-model/);
    assert.match(text, /"total": 2000/);
});

test('copy formatting rejects unexpected durations and bounds text fields', () => {
    setDebug(true);
    const timer = new PageTimer();
    timer.add('paint', Infinity);
    timer.add('png', -5);
    const report = timer.report();
    report.meta.model = 'm'.repeat(500);
    report.ms.paint = NaN;
    report.ms.private = 'PRIVATE_DURATION';
    const text = formatPageTiming(report);
    assert.doesNotMatch(text, /PRIVATE_DURATION|NaN|Infinity/);
    assert.doesNotMatch(text, /m{129}/);
    assert.equal(timingSeconds(1234), '1.23s');
});

test('Debug off runs the work without recording timings or publishing a report', async () => {
    setDebug(false);
    const timer = new PageTimer();
    timer.activate(); timer.add('paint', 12);
    assert.equal(timer.measure('paint', () => 42), 42);
    await assert.rejects(timer.measureAsync('llm', async () => { throw Error('fixture'); }), /fixture/);
    timer.finish('failed');
    assert.equal(lastPageTiming(), null);
    assert.deepEqual(timer.report().ms, {});
    setDebug(true); timer.finish('done');
    assert.equal(lastPageTiming(), null, 'enabling Debug does not adopt work started without it');
});

test('turning Debug off invalidates an in-flight timing capture across a later re-enable', async () => {
    setDebug(true);
    const timer = new PageTimer(); timer.activate();
    let release;
    const pending = timer.measureAsync('llm', () => new Promise(resolve => { release = resolve; }));
    setDebug(false); setDebug(true); release('ok');
    assert.equal(await pending, 'ok');
    timer.finish('done');
    assert.equal(lastPageTiming(), null);
    assert.equal(timer.report().ms.llm, undefined);
    const fresh = new PageTimer(); fresh.add('paint', 3); fresh.finish('done');
    assert.equal(lastPageTiming().ms.paint, 3);
});
