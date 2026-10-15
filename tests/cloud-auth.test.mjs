import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';

const source = readFileSync(new URL('../src/background/background.ts', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf("    if (msg?.type === 'mt:test-cloud')"),
    source.indexOf("    if (msg?.type === 'mt:char-book')"));
const { code } = await transform(`function dispatch(msg, sender, sendResponse, recordChapterLog, chapterLogError, isChapterRunnerSender, fetch) {\n${handlers}\n}`,
    { loader: 'ts' });
const dispatch = new Function(`${code}\nreturn dispatch;`)();

function send(message, fetch) {
    return new Promise(resolve => {
        const handled = dispatch(message, { frameId: 0 }, resolve, () => {}, () => ({}), () => false, fetch);
        assert.equal(handled, true);
    });
}

const operations = [
    { type: 'mt:test-cloud', path: '/health' },
    { type: 'mt:cloud-warm', path: '/health' },
    { type: 'mt:cloud-page', path: '/v1/page' },
    { type: 'mt:cloud-inpaint', path: '/v1/inpaint' },
];

for (const key of ['standalone-fixture-key', 'wk-fixture.ws-fixture']) {
    for (const { type, path } of operations) {
        test(`${type} authenticates with the unchanged ${key.startsWith('wk-') ? 'combined proxy token' : 'standalone key'}`, async () => {
            let calls = 0;
            const response = await send({ type, endpoint: 'https://cloud.example.test/', key,
                confThr: 0.35, minSize: 12, jpegB64: 'AA==', maskB64: '', boxes: [] }, async (url, init) => {
                calls++;
                assert.equal(new URL(url).pathname, path);
                assert.equal(init.headers?.Authorization, `Bearer ${key}`);
                return new Response(JSON.stringify({ ok: true, boxes: [], patches: [], ep: { koharu: ['CUDAExecutionProvider'] } }),
                    { headers: { 'Content-Type': 'application/json' } });
            });
            assert.equal(response.ok, true, response.error);
            assert.equal(calls, 1);
        });
    }
}

for (const { type } of operations) {
    test(`${type} reports proxy rejection without retrying`, async () => {
        let calls = 0;
        const response = await send({ type, endpoint: 'https://cloud.example.test', key: 'wk-invalid.ws-invalid',
            confThr: 0.35, minSize: 12, jpegB64: 'AA==', boxes: [] }, async () => {
            calls++;
            return new Response('Unauthorized', { status: 401 });
        });
        assert.equal(response.ok, false);
        assert.match(response.error, /HTTP 401/);
        assert.equal(calls, 1);
    });
}
