import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const compiled = await build({ entryPoints: ['src/content/attach-policy.ts'], bundle: true,
    format: 'esm', write: false });
const { artifactAuthorized, runPhaseActive } = await import('data:text/javascript;base64,'
    + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

test('an artifact paints when its settings match the reader, or when the active run owns it', () => {
    assert.equal(artifactAuthorized('sig-a', 'sig-a', false), true, 'matching settings always paint');
    assert.equal(artifactAuthorized('sig-a', 'sig-a', true), true);
    assert.equal(artifactAuthorized('sig-a', 'sig-b', true), true,
        'a mid-run settings change must not strand the run\'s own finished pages');
    assert.equal(artifactAuthorized('sig-a', 'sig-b', false), false,
        'after the run ends, changed settings refuse the old artifact again');
});

test('only a live run counts as active', () => {
    for (const phase of ['preparing', 'running', 'waiting', 'stopping']) {
        assert.equal(runPhaseActive(phase), true, phase);
    }
    for (const phase of ['stopped', 'complete', 'error', undefined]) {
        assert.equal(runPhaseActive(phase), false, String(phase));
    }
});
