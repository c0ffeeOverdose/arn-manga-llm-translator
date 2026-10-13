import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const built = await build({ stdin: { contents: "export * from './src/chapter/source'; export * from './src/content/page-cache';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', write: false });
const { fetchHashReaderRouting, HashReaderSourceLoader, hashReaderRouting, hashReaderUrls } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const hash = '0123456789abcdef'.repeat(4), other = 'ffeeddccbbaa99887766554433221100'.repeat(2);
const primary = `https://w2.img.gallery.example.org/7654321/4062/${hash}.webp`;
const alt = primary.replace('w2.', 'w1.');
const descriptor = () => ({ url: 'https://static.img.gallery.example.org/gg.js', sample: primary });
const script = build => `routing = { m: function(g) { var o = 1; switch (g) { case 16: o = 0; break; } return o; },
s: function(h) { var m = /(..)(.)$/.exec(h); return parseInt(m[2]+m[1], 16).toString(10); }, b: '${build}/' };`;
const route = hashReaderRouting(script('7654322'));
const newPrimary = primary.replace('/7654321/', '/7654322/');
const newAlt = alt.replace('/7654321/', '/7654322/');
const gone = () => { throw new Error('image HTTP 404'); };

test('healthy sources and a working sibling do not refresh routing', async () => {
    const seen = [], reasons = [];
    const reader = new HashReaderSourceLoader(descriptor(), async () => { throw new Error('No refresh allowed'); });
    assert.equal(await reader.load(primary, alt, async url => { seen.push(url); return 'pixels'; }), 'pixels');
    assert.deepEqual(seen, [primary]);
    seen.length = 0;
    assert.equal(await reader.load(primary, alt, async url => { seen.push(url); return url === alt ? 'pixels' : gone(); }, m => reasons.push(m)), 'pixels');
    assert.deepEqual(seen, [primary, alt]);
    assert.deepEqual(reasons, ['image HTTP 404']);
});

test('two dead old sources trigger one persisted refresh and recover the same full-size file', async () => {
    const source = descriptor(), seen = [], saved = [];
    let reads = 0;
    const reader = new HashReaderSourceLoader(source, async () => {
        assert.equal(saved[0].refreshed, true, 'claim is saved before fetching routing');
        reads++; return route;
    }, async () => saved.push(structuredClone(source)));
    assert.equal(await reader.load(primary, alt, async url => { seen.push(url); return url === newPrimary ? 'pixels' : gone(); }), 'pixels');
    assert.deepEqual(seen, [primary, alt, newPrimary]);
    assert.equal(reads, 1);
    assert.equal(saved.length, 2);
    const next = hashReaderUrls([{ hash: other, avif: true }], primary).urls[0];
    const expected = next.replace('a2.', 'a1.').replace('/7654321/', '/7654322/');
    assert.equal(await reader.load(next, next.replace('a2.', 'a1.'), async url => { assert.equal(url, expected); return 'next'; }), 'next');
    assert.equal(reads, 1);
});

test('concurrent failures share one refresh rather than fetching a table per page', async () => {
    let release, reads = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const reader = new HashReaderSourceLoader(descriptor(), async () => { reads++; return pending; });
    const requests = [0, 1, 2].map(() => reader.load(primary, alt, async url => url === newPrimary ? 'pixels' : gone()));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(reads, 1);
    release(route);
    assert.deepEqual(await Promise.all(requests), ['pixels', 'pixels', 'pixels']);
});

test('missing or throwing refresh remains bounded, and another page can still succeed', async () => {
    for (const read of [async () => null, async () => { throw new Error('offline'); }]) {
        let calls = 0;
        const reader = new HashReaderSourceLoader(descriptor(), async source => { calls++; return read(source); });
        for (let i = 0; i < 2; i++) {
            const tried = [];
            await assert.rejects(reader.load(primary, alt, async url => { tried.push(url); return gone(); }), /HTTP 404/);
            assert.deepEqual(tried, [primary, alt]);
        }
        assert.equal(calls, 1);
        assert.equal(await reader.load(primary, alt, async () => 'later-page'), 'later-page');
    }
});

test('unchanged routing never repeats old URLs; permanently missing images stop after four unique candidates', async () => {
    for (const [routing, expected] of [[hashReaderRouting(script('7654321')), [primary, alt]], [route, [primary, alt, newPrimary, newAlt]]]) {
        const tried = [], reasons = [];
        const reader = new HashReaderSourceLoader(descriptor(), async () => routing);
        await assert.rejects(reader.load(primary, alt, async url => { tried.push(url); return gone(); }, reason => reasons.push(reason)), /HTTP 404/);
        assert.deepEqual(tried, expected);
        assert.equal(new Set(tried).size, tried.length);
        assert.equal(reasons.length, expected.length === 4 ? 2 : 1, 'only actual sibling attempts are reported');
    }
});

test('checkpoint resume cannot buy another refresh, and saved routing remains usable', async () => {
    const source = { ...descriptor(), refreshed: true, routing: route };
    const reader = new HashReaderSourceLoader(structuredClone(source), async () => { throw new Error('No refresh after resume'); });
    const tried = [];
    assert.equal(await reader.load(primary, alt, async url => { tried.push(url); return 'pixels'; }), 'pixels');
    assert.deepEqual(tried, [newPrimary]);
    const failed = new HashReaderSourceLoader({ ...descriptor(), refreshed: true }, async () => { throw new Error('No repeat'); });
    await assert.rejects(failed.load(primary, alt, async () => gone()), /HTTP 404/);
});

test('non-HTTP failures and foreign CDN sources cannot trigger routing refresh', async () => {
    let reads = 0;
    const reader = new HashReaderSourceLoader(descriptor(), async () => { reads++; return route; });
    await assert.rejects(reader.load(primary, alt, async () => { throw new Error('image could not be decoded'); }), /decoded/);
    const foreign = primary.replace('img.gallery.example.org', 'other.example.org');
    await assert.rejects(reader.load(foreign, foreign.replace('w2.', 'w1.'), async () => gone()), /HTTP 404/);
    assert.equal(reads, 0);
});

test('cancellation during a primary read or shared refresh launches no later source request', async () => {
    let valid = true, reads = 0;
    const seen = [];
    const reader = new HashReaderSourceLoader(descriptor(), async () => { reads++; return route; });
    await assert.rejects(reader.load(primary, alt, async url => { seen.push(url); valid = false; return gone(); }, undefined, () => valid));
    assert.deepEqual(seen, [primary]);
    assert.equal(reads, 0);
    valid = true; seen.length = 0;
    const cancelled = new HashReaderSourceLoader(descriptor(), async () => { valid = false; return route; });
    await assert.rejects(cancelled.load(primary, alt, async url => { seen.push(url); return gone(); }, undefined, () => valid), { name: 'AbortError' });
    assert.deepEqual(seen, [primary, alt]);
});

test('routing transport handles missing, malicious, redirected and oversized data without execution', async () => {
    let requests = 0;
    assert.equal(await fetchHashReaderRouting({ ...descriptor(), url: 'https://ads.example.org/gg.js' }, async () => { requests++; }), null);
    assert.equal(requests, 0);
    for (const response of [new Response('', { status: 404 }), new Response(script('7654321') + ';throw new Error("run");'),
        new Response(script('7654321'), { headers: { 'content-length': '200000' } }),
        { ok: true, url: 'https://ads.example.org/gg.js', headers: new Headers(), text: () => { throw new Error('Must not read foreign response'); } }]) {
        assert.equal(await fetchHashReaderRouting(descriptor(), async () => response), null);
    }
    assert.deepEqual(await fetchHashReaderRouting(descriptor(), async () => new Response(script('7654322'))), route);
});

test('routing fetch/body deadlines abort at five seconds and are cleared on success and failure', async () => {
    const previous = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    let deadline, cleared = 0;
    globalThis.setTimeout = (fn, ms) => { deadline = { fn, ms }; return 123; };
    globalThis.clearTimeout = id => { assert.equal(id, 123); cleared++; };
    try {
        for (const body of [false, true]) {
            const pending = fetchHashReaderRouting(descriptor(), async (_url, opts) => {
                assert.equal(opts.cache, 'no-store');
                const wait = () => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError'))));
                return body ? { ok: true, url: '', headers: new Headers(), text: wait } : wait();
            });
            await Promise.resolve();
            assert.equal(deadline.ms, 5000);
            deadline.fn();
            assert.equal(await pending, null);
        }
        assert.deepEqual(await fetchHashReaderRouting(descriptor(), async () => new Response(script('7654322'))), route);
        assert.equal(cleared, 3);
    } finally { Object.assign(globalThis, previous); }
});
