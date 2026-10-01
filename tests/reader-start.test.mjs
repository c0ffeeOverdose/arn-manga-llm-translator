import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

await build({ entryPoints: ['src/chapter/reader.ts'], bundle: true, format: 'esm', outfile: '.test-build/reader-start.mjs' });
const { readerStartAllowed } = await import('../.test-build/reader-start.mjs');
const chapter = 'https://reader.test/read/chapter1001';
test('same-document page turns use the current route, not the initial document URL', () => {
    assert.equal(readerStartAllowed(`${chapter}/2`, chapter, `${chapter}/2`, 'https://reader.test'), true);
    assert.equal(readerStartAllowed(`${chapter}/2`, chapter, `${chapter}/3`, 'https://reader.test'), true);
    assert.equal(readerStartAllowed(`${chapter}?page=3`, chapter, `${chapter}?page=4`, 'https://reader.test'), true);
});
test('a current tab in another chapter cannot accept an old start', () => {
    assert.equal(readerStartAllowed(`${chapter}/2`, chapter, 'https://reader.test/read/chapter1002/1', 'https://reader.test'), false);
});
test('chapter claims and origin identity are checked independently', () => {
    assert.equal(readerStartAllowed(`${chapter}/2`, 'https://reader.test/read/chapter1002', `${chapter}/2`, 'https://reader.test'), false);
    assert.equal(readerStartAllowed(`${chapter}/2`, chapter, `${chapter}/2`, 'https://foreign.test'), false);
    assert.equal(readerStartAllowed('https://foreign.test/read/chapter1001/2', chapter, `${chapter}/2`, 'https://reader.test'), false);
    assert.equal(readerStartAllowed('invalid', chapter, 'chrome://extensions', 'null'), false);
});
