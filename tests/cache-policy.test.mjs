import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

await build({ entryPoints: ['src/cache/policy.ts'], bundle: true, format: 'esm', outfile: '.test-build/cache-policy-test.mjs' });
const { selectCachedPage, cacheEntryFresh, settingsFingerprint, PAGE_KEY_GEN, CLOUD_SPLIT_GEN } = await import('../.test-build/cache-policy-test.mjs');
const fp = settingsFingerprint({});
const full = (extra = {}) => ({ key: 'chapter#hash', fp, w: 4, h: 4, atime: 0,
    boxes: [{ x1: 0, y1: 0, x2: 3, y2: 3, conf: 1 }], panels: [], outputs: [{ index: 1, text: 'saved answer' }], extras: [],
    splitGen: CLOUD_SPLIT_GEN, mask: { w: 1, h: 1, data: new Uint8Array([255]).buffer }, ...extra });
const options = (extra = {}) => ({ hash: 'hash', fp, w: 4, h: 4, isCloud: true, verifyIdentity: () => false, ...extra });

test('exact pixels win over a stale or wrong page slot', () => {
    const bytes = full(), identity = full({ key: 'chapter@p0', keyGen: PAGE_KEY_GEN, splitGen: 0 });
    const result = selectCachedPage(options({ bytes, identity, verifyIdentity: () => { throw new Error('exact hits need no slot proof'); } }));
    assert.equal(result.entry, bytes);
    assert.equal(result.det.boxes, bytes.boxes);
});

test('another encoding reuses the translation only after pixel verification', () => {
    const identity = full({ key: 'chapter@p0', keyGen: PAGE_KEY_GEN, sourceHash: 'old-hash', patches: [{ png: new ArrayBuffer(1) }], patchesGen: 4 });
    assert.equal(selectCachedPage(options({ identity })), null);
    const result = selectCachedPage(options({ identity, verifyIdentity: () => true }));
    assert.equal(result.entry.outputs, identity.outputs);
    assert.equal(result.entry.patches, undefined);
});

test('verified proportional renditions scale boxes, clips and extras without another translation', () => {
    const identity = full({ key: 'chapter@p0', keyGen: PAGE_KEY_GEN,
        boxes: [{ x1: 0, y1: 0, x2: 3, y2: 3, conf: 1, clip: { x1: 1, y1: 1, x2: 3, y2: 3 }, cutAxis: 'x' }],
        extras: [{ x1: 1, y1: 1, x2: 2, y2: 3, source: 'extra', translation: 'saved extra' }] });
    assert.equal(selectCachedPage(options({ identity, w: 8, h: 8 })), null);
    const result = selectCachedPage(options({ identity, w: 8, h: 8, verifyIdentity: () => true }));
    assert.equal(result.entry.w, 8);
    assert.equal(result.entry.outputs, identity.outputs);
    assert.equal(result.det.boxes[0].x2, 6);
    assert.equal(result.det.boxes[0].clip.x1, 2);
    assert.equal(result.entry.extras[0].y2, 6);
    assert.equal(result.det.mask.data.byteLength, 64);
    assert.equal(identity.boxes[0].x2, 3);
    assert.equal(selectCachedPage(options({ identity, w: 8, h: 4, verifyIdentity: () => true })), null);
});

test('legacy, maskless, corrupt and empty-result rows fail safely', () => {
    for (const row of [full({ partial: true }), full({ mask: undefined }), full({ outputs: [] }), full({ boxes: undefined }),
        full({ mask: { w: 2, h: 2, data: new ArrayBuffer(1) } }), full({ splitGen: CLOUD_SPLIT_GEN - 1 })]) {
        assert.equal(cacheEntryFresh(row, fp, 4, 4, true), false);
        assert.equal(selectCachedPage(options({ bytes: row })), null);
    }
    assert.equal(selectCachedPage(options({ identity: full(), verifyIdentity: () => true })), null);
});

test('translation input changes invalidate the recipe, while presentation and scheduling reuse it', () => {
    for (const patch of [{ stylePrompt: 'Formal tone' }, { detMinSize: 30 }, { inferEngine: 'cloud' }, { ocrLangs: ['eng'] },
        { cropSize: 600 }, { vlmAssistedDetection: true }, { useCharacters: false }, { thinkingLevel: 'high' }, { mergePages: 2 }]) {
        assert.notEqual(settingsFingerprint(patch), fp);
    }
    for (const patch of [{ renderFont: 'custom' }, { minFont: 20 }, { textColor: '#ff0000' }, { inpaint: 'on' },
        { cacheMax: 20 }, { cacheEnabled: false }, { parallelLlm: 1 }, { prefetchN: 10 }]) {
        assert.equal(settingsFingerprint(patch), fp);
    }
});
