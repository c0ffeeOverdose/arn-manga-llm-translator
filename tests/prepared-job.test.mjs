import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const built = await build({ entryPoints: ['src/content/prepared-job.ts'], bundle: true, format: 'esm', write: false });
const { disposePreparedJob, retainPreparedJob } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function prepared() {
    let resolve, closed = 0;
    const job = { prep: new Promise(r => { resolve = r; }) };
    return { job, finish: () => resolve({ bitmap: { close() { closed++; } } }), get closed() { return closed; } };
}

test('a finished job closes its prepared image once', async () => {
    const f = prepared(); f.finish(); await tick();
    assert.equal(f.closed, 0);
    disposePreparedJob(f.job); disposePreparedJob(f.job); await tick();
    assert.equal(f.closed, 1);
});

test('cancellation also releases preparation that completes later', async () => {
    const f = prepared(); disposePreparedJob(f.job); await tick();
    assert.equal(f.closed, 0);
    f.finish(); await tick();
    assert.equal(f.closed, 1);
});

test('seam borrowers keep a cancelled image valid until the final borrower releases it', async () => {
    const f = prepared();
    const a = retainPreparedJob(f.job), b = retainPreparedJob(f.job);
    disposePreparedJob(f.job); f.finish(); await tick();
    assert.equal(f.closed, 0);
    a(); a(); await tick(); assert.equal(f.closed, 0);
    b(); await tick(); assert.equal(f.closed, 1);
});

test('returning a borrow does not close an unfinished job', async () => {
    const f = prepared(); retainPreparedJob(f.job)(); f.finish(); await tick();
    assert.equal(f.closed, 0);
    disposePreparedJob(f.job); await tick(); assert.equal(f.closed, 1);
});

test('empty and failed preparations can be discarded without unhandled rejections', async () => {
    disposePreparedJob({ prep: Promise.resolve(null) });
    disposePreparedJob({ prep: Promise.reject(Error('read failed')) });
    await tick();
});
