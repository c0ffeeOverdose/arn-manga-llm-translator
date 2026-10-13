import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const built = await build({ entryPoints: ['src/content/page-io.ts'], bundle: true, format: 'esm', write: false });
const code = 'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64');
const h0 = '0123456789abcdef'.repeat(4), h1 = 'ffeeddccbbaa99887766554433221100'.repeat(2);
let instance = 0;

async function fixture(mode) {
    const previous = { fetch: globalThis.fetch, location: globalThis.location, document: globalThis.document };
    let build = '7654321';
    const requests = [], src = () => `https://w2.img.gallery.example.org/${build}/4062/${h0}.webp`;
    const image = { src: src(), currentSrc: 'data:image/png;base64,fixture', naturalWidth: 600, naturalHeight: 800,
        closest: () => null, getBoundingClientRect: () => ({ width: 600 }) };
    globalThis.location = { origin: 'https://gallery.example.org', pathname: '/reader/123456.html', search: '', hash: '#1' };
    globalThis.document = { scripts: [{ src: 'https://static.img.gallery.example.org/gg.js' }],
        querySelectorAll: selector => selector === 'img' ? [image] : [] };
    globalThis.fetch = async url => {
        requests.push(url);
        if (url.endsWith('/gg.js')) {
            if (mode === 'missing') return new Response('', { status: 404 });
            if (mode === 'malformed') return new Response('not a routing script');
            return new Response(`routing={m:function(g){var o=1;switch(g){case 16:o=0;break;}return o;},
s:function(h){var m=/(..)(.)$/.exec(h);return parseInt(m[2]+m[1],16).toString(10);},b:'${build}/'};`);
        }
        assert.ok(url.endsWith('/galleries/123456.js'));
        return new Response(`var gallery = ${JSON.stringify({ files: [{ hash: h0, hasavif: 0 }, { hash: h1, hasavif: 1 }] })};`);
    };
    const { hashReaderManifest } = await import(code + '#' + ++instance);
    return { requests, image, manifest: hashReaderManifest, rotate: () => { build = '7654322'; image.src = src(); },
        restore: () => Object.assign(globalThis, previous) };
}

test('actual manifest preparation uses routed sources and shares concurrent/count/start reads', async () => {
    const f = await fixture('healthy');
    try {
        const [first, same] = await Promise.all([f.manifest(), f.manifest()]);
        assert.deepEqual(same, first);
        assert.ok(first.urls[1].startsWith('https://a1.'));
        assert.equal(first.sourceRouting.url, 'https://static.img.gallery.example.org/gg.js');
        assert.equal(first.sourceRouting.sample, f.image.src);
        assert.equal(first.sourceRouting.refreshed, undefined, 'enumeration does not spend runner recovery');
        assert.equal(f.requests.length, 2, 'one manifest and one routing fetch');
        f.image.src = first.urls[1];
        await f.manifest();
        assert.equal(f.requests.length, 2, 'another hash/shard in the same build keeps the cached manifest');
    } finally { f.restore(); }
});

for (const mode of ['missing', 'malformed']) test(`${mode} optional routing still enumerates both original pages with alternates`, async () => {
    const f = await fixture(mode);
    try {
        const manifest = await f.manifest();
        assert.equal(manifest.urls.length, 2);
        assert.ok(manifest.urls[1].startsWith('https://a2.'));
        assert.ok(manifest.alts[1].startsWith('https://a1.'));
        assert.ok(manifest.sourceRouting, 'the runner can still spend one later recovery if both sources fail');
        await f.manifest();
        assert.equal(f.requests.length, 2);
    } finally { f.restore(); }
});

test('new displayed build invalidates only manifest routing; an opaque translated view keeps known enumeration', async () => {
    const f = await fixture('healthy');
    try {
        const old = await f.manifest();
        f.rotate();
        const current = await f.manifest();
        assert.ok(current.urls.every(url => url.includes('/7654322/')));
        assert.notDeepEqual(current.urls, old.urls);
        assert.equal(f.requests.length, 4);
        f.image.src = f.image.currentSrc = 'blob:translated';
        assert.deepEqual(await f.manifest(), current);
        assert.equal(f.requests.length, 4);
    } finally { f.restore(); }
});
