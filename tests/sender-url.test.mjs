import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const compiled = await build({ entryPoints: ['src/cache/sender-url.ts'], bundle: true, format: 'esm', write: false });
const { liveSenderUrl } = await import('data:text/javascript;base64,'
    + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

test('the tab\'s live URL wins over a stale content-script sender URL', () => {
    // SPA chapter switch: the document survives, sender.url keeps the injection-time chapter,
    // the tab URL (and the reader's cache keys) name the new one.
    assert.equal(liveSenderUrl('https://reader.test/chapter/old/8', 'https://reader.test/chapter/new/1'),
        'https://reader.test/chapter/new/1');
    assert.equal(liveSenderUrl('https://reader.test/chapter/old/8', undefined),
        'https://reader.test/chapter/old/8', 'no tab URL falls back to the sender');
    assert.equal(liveSenderUrl(undefined, undefined), '');
});
