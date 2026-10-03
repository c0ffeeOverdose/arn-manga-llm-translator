// A page whose provider call never settles must cost exactly ONE page. The attempt lease used
// to call stop() on expiry, so a single hang ended the whole chapter — reported as
// "3 of 25 pages ready to read · Working on 3 pages" that never moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('/tmp/opencode', { recursive: true });
await build({ entryPoints: ['src/chapter/lifecycle.ts'], bundle: true, format: 'esm',
    outfile: '/tmp/opencode/chapter-lifecycle.mjs', logLevel: 'silent' });
const { Attempt } = await import('/tmp/opencode/chapter-lifecycle.mjs');

test('an expired attempt reports where it stopped and does not kill the run', async () => {
    let expired = null;
    const a = new Attempt({
        timeoutMs: 30,
        label: () => 'p7 translating',
        onExpire: info => { expired = info; },
    });
    assert.equal(a.valid(), true);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(a.valid(), false, 'an expired lease must revoke late results');
    assert.ok(expired, 'expiry must be surfaced, not silent');
    assert.equal(expired.label, 'p7 translating', 'the stage it died in must be named');
    assert.ok(expired.elapsedMs >= 25, 'elapsed time is reported for the log');
});

test('a finishing attempt never fires its expiry', async () => {
    let expired = false;
    const a = new Attempt({ timeoutMs: 40, onExpire: () => { expired = true; } });
    a.finish();
    await new Promise(r => setTimeout(r, 70));
    assert.equal(expired, false, 'a page that completed must not be marked stuck');
    assert.equal(a.valid(), true);
});

test('the runner expires one page, never the whole run', () => {
    const src = readFileSync(new URL('../src/chapter/page.ts', import.meta.url), 'utf8');
    const lease = src.slice(src.indexOf('const attempt = new Attempt({'), src.indexOf('attempts.add(attempt)'));
    assert.match(lease, /item\.phase = 'failed'/, 'expiry must fail that page only');
    assert.ok(!/stop\(/.test(lease), 'an expired page must never stop the run');
    // The stall is named for the log: an offscreen runner has no console to inspect.
    assert.match(lease, /stuck in/, 'the expired stage must be recorded');
    // A merged group that outlives its lease must say so and degrade to per-page calls.
    assert.match(src, /trying per-page/, 'a stalled group must name what held it');
});
