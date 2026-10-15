import ts from 'typescript';
import { transform } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Row stamps must ride the prompt row number of their own request: the first
// attempt stamps 1..n, and a starvation split re-stamps its crops with the new
// chunk-local rows (the old images carry whole-request numbers the retry rows
// no longer use). A stale stamp would point the model at the wrong row.
const source = ts.createSourceFile('ocr.ts', readFileSync('src/content/ocr.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'translateRegions');
const compiled = await transform(fn.getText(source).replace(/^export\s+/, ''), { loader: 'ts' });

async function fixture() {
    const badges = [], posts = [];
    let calls = 0;
    const timers = new Set();
    const scope = {
        PageTimer: class {
            meta = {};
            setStage() {}
            add() {}
            measure(_key, run) { return run(); }
            measureAsync(_key, run) { return run(); }
        },
        pipeline: { textSource: 'crops', useOcrModel: false, useContext: false, useCharacters: false, grayscaleBw: false },
        context: {}, shareContext: false, EMPTY_CONTEXT: {}, llmChunkSize: null,
        cacheReady: async () => 'epoch', assertCacheCurrent() {},
        loadContext: async () => {}, bookKey: () => 'book', chapterKey: () => 'chapter:test',
        resolveMangaId: async () => null,
        pageImageData: async () => ({}),
        cropRegion: async (_bitmap, _box, _gs, _pageImg, _timing, badge) => { badges.push(badge); return `img${badge}`; },
        regionChunks: (regions, size) => size >= regions.length ? [regions] : [regions.slice(0, 3), regions.slice(3)],
        nextChunkSize: () => 3,
        requestImages: o => {
            if (o.crops.some(c => !c)) throw new Error('every region must own its crop image');
            return [...o.crops];
        },
        sourceExtras: extras => extras, recordChapterLog() {},
        liveRpcs: new Set(), isDebug: () => false, performance, Date,
        checkCancelled: signal => signal?.throwIfAborted(), DOMException,
        setInterval(fn) { timers.add(fn); return fn; }, clearInterval(id) { timers.delete(id); },
        setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(id) { timers.delete(id); },
        console: { warn() {}, log() {} },
        chrome: { runtime: { connect() {
            let reply;
            return { onMessage: { addListener(fn) { reply = fn; } }, onDisconnect: { addListener() {} }, disconnect() {},
                postMessage(payload) {
                    calls++;
                    posts.push({ rows: payload.regions.map(r => r.index), images: payload.imagesB64 });
                    if (calls === 1) {
                        reply({ ok: false, error: 'No usable text regions parsed', kind: 'parse' });
                    } else {
                        reply({ ok: true, outputs: payload.regions.map(r => ({ index: r.index, translation: `t${r.index}` })), extras: [], mentions: [] });
                    }
                } };
        } } },
    };
    runInNewContext(compiled.code, scope);
    const boxes = Array.from({ length: 6 }, (_, i) => ({ x1: 10 + i * 20, y1: 20, x2: 30 + i * 20, y2: 50 }));
    const result = await scope.translateRegions({ width: 600, height: 800 }, { boxes }, () => {},
        { fold: false, shareContext: false, cacheEpoch: 'epoch', valid: () => true });
    return { result, badges, posts, timers: timers.size };
}

test('starvation splits re-stamp crops with the new chunk-local rows', async () => {
    const f = await fixture();
    assert.deepEqual(f.badges, [1, 2, 3, 4, 5, 6, 1, 2, 3, 1, 2, 3],
        'first cut stamps whole-request rows, each split re-stamps 1..k');
    assert.deepEqual(f.posts[0].rows, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(f.posts[0].images, ['img1', 'img2', 'img3', 'img4', 'img5', 'img6']);
    // Both retries renumber rows 1..3 AND carry the re-stamped images — a stale
    // whole-request stamp would point every retry row at the wrong crop.
    for (const post of f.posts.slice(1)) {
        assert.deepEqual(post.rows, [1, 2, 3]);
        assert.deepEqual(post.images, ['img1', 'img2', 'img3']);
    }
    // Replies lift back to the page's own numbering for paint-by-index.
    // (Array.from: outputs arrive from the VM realm — compare as outer values.)
    assert.deepEqual(Array.from(f.result.outputs, o => [o.index, o.translation]),
        [[1, 't1'], [2, 't2'], [3, 't3'], [4, 't1'], [5, 't2'], [6, 't3']]);
    assert.equal(f.timers, 0);
});
