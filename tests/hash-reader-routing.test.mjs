import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const built = await build({ entryPoints: ['src/content/page-cache.ts'], bundle: true, format: 'esm', write: false });
const { hashReaderRouting, hashReaderRoutingUrl, hashReaderUrls } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const h0 = '0123456789abcdef'.repeat(4), h1 = 'ffeeddccbbaa99887766554433221100'.repeat(2);
const sample = `https://w2.img.gallery.example.org:8443/7654321/4062/${h0}.webp`;
const files = [{ hash: h0, avif: false }, { hash: h1, avif: true }];
const script = (build = '7654321', cases = [16], base = 1) => `'use strict';
routing = { m: function(g) { var o = ${base}; switch (g) {
${cases.map(n => `case ${n}:`).join('\n')}
o = ${1 - base}; break; } return o; },
s: function(h) { var m = /(..)(.)$/.exec(h); return parseInt(m[2]+m[1], 16).toString(10); },
b: '${build}/' };`;

test('routing parses the binary table as data and keeps all 4096 hash slots', () => {
    const route = hashReaderRouting(script());
    assert.equal(route.build, '7654321');
    assert.equal(route.shards.length, 4096);
    assert.equal(route.shards[16], '1');
    assert.equal(route.shards[4062], '2');
    const inverse = hashReaderRouting(script('7654321', [0, 4095], 0));
    assert.equal(inverse.shards[0], '2');
    assert.equal(inverse.shards[4095], '2');
    assert.equal(inverse.shards[100], '1');
});

test('unsupported, malformed or executable routing scripts fail closed without running them', () => {
    for (const text of [null, '', 'not javascript', script().replace('16).toString', '10).toString'),
        script('7654321', [4096]), script('7654321', [16, 16]), script('7654321', [-1]),
        script('../other'), script().replace('return o;', 'globalThis.untrustedRan = true; return o;'),
        script() + '\nglobalThis.untrustedRan = true;', ' '.repeat(150000) + script()]) {
        assert.equal(hashReaderRouting(text), null);
    }
    assert.equal(globalThis.untrustedRan, undefined);
});

test('routing picks each file shard while preserving order, full-size hash, encoding and alternate', () => {
    const old = hashReaderUrls(files, sample);
    const routed = hashReaderUrls(files, sample, { routing: hashReaderRouting(script()) });
    assert.equal(routed.urls[0], old.urls[0], 'the displayed source remains the sample');
    assert.equal(routed.urls[1], `https://a1.img.gallery.example.org:8443/7654321/16/${h1}.avif`);
    assert.equal(routed.alts[1], old.urls[1], 'the other shard remains available');
    assert.equal(routed.urls.length, files.length);
});

test('missing, different-build or sample-mismatched initial routing keeps the existing fallback', () => {
    const fallback = hashReaderUrls(files, sample);
    for (const routing of [null, hashReaderRouting(script('7654322')), hashReaderRouting(script('7654321', [16, 4062])),
        { build: '7654321', shards: '1' }, { build: '7654321', shards: 'x'.repeat(4096) }]) {
        assert.deepEqual(hashReaderUrls(files, sample, { routing }), fallback);
    }
});

test('explicit recovery may change a build but never the page hash or encoder', () => {
    const route = hashReaderRouting(script('7654322'));
    const recovered = hashReaderUrls(files, sample, { routing: route, refresh: true });
    assert.deepEqual(recovered.urls, [
        `https://w2.img.gallery.example.org:8443/7654322/4062/${h0}.webp`,
        `https://a1.img.gallery.example.org:8443/7654322/16/${h1}.avif`,
    ]);
});

test('only a reader-declared HTTPS routing script in the sample CDN family is eligible', () => {
    const url = 'https://static.img.gallery.example.org:8443/gg.js';
    assert.equal(hashReaderRoutingUrl(['https://ads.example.org/gg.js', url], sample), url);
    for (const candidates of [[], ['http://static.img.gallery.example.org/gg.js'], ['https://ads.example.org/gg.js'],
        ['https://static.img.gallery.example.org.evil.test/gg.js'], ['https://static.img.gallery.example.org/other.js'],
        ['https://user:password@static.img.gallery.example.org/gg.js']]) {
        assert.equal(hashReaderRoutingUrl(candidates, sample), undefined);
    }
    assert.equal(hashReaderRoutingUrl([url], 'not a url'), undefined);
});
