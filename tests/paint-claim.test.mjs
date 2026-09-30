// Regression: two paths must never render the same page at once. Observed as the AI-cleanup
// model running twice for one page (2.5s each) while both overwrote the same cache entry.
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const queue = strip(readFileSync(new URL('../src/content/queue.ts', import.meta.url), 'utf8'));
const overlays = strip(readFileSync(new URL('../src/content/overlays.ts', import.meta.url), 'utf8'));

test('the paint reservation is shared, not private to the paint lane', () => {
    // paintHas must consult the reservation set, or arrival paints are invisible to enqueue.
    const fn = queue.slice(queue.indexOf('export function paintHas'));
    assert.match(fn.slice(0, fn.indexOf('}')), /painting\.has\(key\)/,
        'paintHas must see reservation claims from out-of-band painters');
});

test('an out-of-band painter claims before its first await and releases in finally', () => {
    const fn = overlays.slice(overlays.indexOf('async function arrivalPaint'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const claim = body.indexOf('claimPaint(key)');
    const firstAwait = body.indexOf('await ');
    const release = body.indexOf('releasePaint(key)');
    assert.ok(claim > 0, 'arrival paint must claim the page');
    assert.ok(claim < firstAwait, 'the claim must happen before any await, or a queued job slips in');
    assert.ok(release > claim, 'the claim must be released');
    assert.match(body.slice(release - 60, release + 40), /finally/,
        'release must live in finally — a throw would otherwise strand the reservation');
});

test('the paint lane releases its claim on every exit path', () => {
    const fn = queue.slice(queue.indexOf('function pumpPaint'));
    assert.match(fn, /claimPaint\(job\.key\)/);
    assert.match(fn.slice(fn.indexOf('finally')), /releasePaint\(job\.key\)/);
});
