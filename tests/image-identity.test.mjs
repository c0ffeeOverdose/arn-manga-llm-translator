import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitmap, grayPage, installCanvas } from './helpers/image-fixture.mjs';

await build({ entryPoints: ['src/image-identity.ts'], bundle: true, format: 'esm', outfile: '.test-build/image-identity.mjs' });
const { identifyBitmap, imageCandidates, verifyBitmap, grayAgreement, hashDistance, signatureOf, verifyGrayIdentity } = await import('../.test-build/image-identity.mjs');
installCanvas();
const box = { x1: 100, y1: 200, x2: 500, y2: 300 };

test('image candidates follow pixels, not dimensions or chapter order', () => {
    const pages = [1, 2, 3, 4].map(order => ({ order, image: identifyBitmap(bitmap(grayPage(order))) }));
    const current = identifyBitmap(bitmap(grayPage(3)));
    assert.equal(imageCandidates(current, pages)[0].order, 3);
    assert.equal(verifyBitmap(bitmap(grayPage(4)), pages[2].image), false);
    assert.equal(verifyBitmap(bitmap(grayPage(3)), pages[2].image), true);
});
test('verification tolerates small encoder noise and proportional resolution changes', () => {
    const source = bitmap();
    const expected = identifyBitmap(source, [box]);
    const drift = a => Uint8Array.from(a, (v, i) => Math.min(255, Math.max(0, v + (i % 3) - 1)));
    const variant = bitmap(drift(source.gray), { width: 300, height: 400, region: drift(source.region) });
    assert.notEqual(identifyBitmap(variant).exact, expected.exact);
    assert.equal(verifyBitmap(variant, expected), true);
});
test('matching whole-page hashes cannot hide changed text in a region', () => {
    const source = bitmap();
    const expected = identifyBitmap(source, [box]);
    const changed = source.region.slice();
    for (let i = 0; i < 160; i++) changed[i] = 255 - changed[i];
    const differentText = bitmap(source.gray, { region: changed });
    assert.equal(identifyBitmap(differentText).phash, expected.phash);
    assert.equal(identifyBitmap(differentText).exact, expected.exact);
    assert.equal(imageCandidates(identifyBitmap(differentText), [{ image: expected }]).length, 1);
    assert.equal(verifyBitmap(differentText, expected), false);
});
test('a stored page-gray identity authorizes idle reuse and rejects another page', () => {
    const source = bitmap();
    const expected = identifyBitmap(source, [box]);
    const drift = a => Uint8Array.from(a, (v, i) => Math.min(255, Math.max(0, v + (i % 3) - 1)));
    const variant = bitmap(drift(source.gray), { width: 300, height: 400, region: drift(source.region) });
    assert.equal(verifyGrayIdentity(variant, signatureOf(expected), expected.gray), true, 'encoder noise keeps the page');
    assert.equal(verifyGrayIdentity(bitmap(grayPage(4)), signatureOf(expected), expected.gray), false, 'another page must not reuse the slot');
    assert.equal(verifyGrayIdentity(bitmap(), signatureOf(expected), ''), false, 'a row without stored evidence must not be trusted');
    assert.equal(verifyGrayIdentity(bitmap(), { ...signatureOf(expected), gen: 0 }, expected.gray), false, 'wrong generation fails closed');
});
test('a composite/spread is not accepted as one single page', () => {
    const expected = identifyBitmap(bitmap());
    assert.equal(verifyBitmap(bitmap(grayPage(), { width: 1200, height: 800 }), expected), false);
    assert.deepEqual(imageCandidates(identifyBitmap(bitmap(grayPage(), { width: 1200, height: 800 })), [{ image: expected }]), []);
});
test('featureless and malformed identities do not become fuzzy matches', () => {
    const white = bitmap(new Uint8Array(128 * 128).fill(255));
    const expected = identifyBitmap(white);
    assert.deepEqual(imageCandidates(expected, [{ image: expected }]), []);
    assert.equal(verifyBitmap(bitmap(), { ...identifyBitmap(bitmap()), gen: 0 }), false);
    assert.equal(verifyBitmap(bitmap(), { ...identifyBitmap(bitmap()), gray: 'invalid' }), false);
    assert.equal(hashDistance('invalid', '0000000000000000'), Infinity);
});
test('local differences cannot disappear in a page-wide average', () => {
    const a = new Uint8Array(128 * 128).fill(255), b = a.slice();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) b[y * 128 + x] = 0;
    assert.equal(grayAgreement(a, b, 128), false);
});
test('progress signatures contain no page or region pixel payload', () => {
    const identity = identifyBitmap(bitmap(), [box]);
    const summary = signatureOf(identity);
    assert.equal(summary.exact, identity.exact);
    assert.ok(!('gray' in summary));
    assert.ok(!('regions' in summary));
});
