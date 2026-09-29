// Static guards for the "Stop does nothing" incident.
//
// Symptoms: after pressing Stop during a chapter sweep the pill sat on
// "Stopping…" for minutes; a hung translator RPC ran out its full 240s adapter
// timeout because nothing could reach it, and the priority phase committed a page
// after the user had already cancelled. A later reload was required to clear the
// stuck detector iframe. These read the source because background/sweep cannot be
// unit-tested (chrome ports, DOM, ORT) — pinning the contract is the next best thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const sweep = read('content/sweep.ts');
const ocr = read('content/ocr.ts');
const detection = read('content/detection.ts');

test('cancelSweep aborts in-flight translate RPCs', () => {
  const body = sweep.slice(sweep.indexOf('export function cancelSweep'));
  const end = body.indexOf('\n}');
  assert.ok(body.slice(0, end).includes('abortLiveRpcs()'),
    'cancelSweep must call abortLiveRpcs() — a hung RPC otherwise holds Stop for its full timeout');
});

test('translate RPC registers an abort handle and honours it', () => {
  assert.match(ocr, /const liveRpcs = new Set<LiveRpc>\(\)/);
  assert.match(ocr, /export function abortLiveRpcs\(\)/);
  assert.match(ocr, /stop\.abort = \(\) =>/, 'the port must expose an abort that disconnects + rejects');
  assert.match(ocr, /aborted/, 'a user abort must not be reported as a generic disconnect');
});

test('priority phase re-checks cancel after the awaited page and never commits behind Stop', () => {
  // the check must sit AFTER the workPage await, before ready.set/commitPage
  const phase = sweep.slice(sweep.indexOf('const priorityPhase = async'));
  const afterAwait = phase.indexOf('res = await workPage');
  const cancelCheck = phase.indexOf('sweep.cancel || sweep.dead');
  const marker = phase.indexOf('ready.set(k, { i: k, url: job.url, pre: true });', afterAwait);
  assert.ok(afterAwait > 0 && cancelCheck > afterAwait, 'cancel must be re-checked after the awaited page');
  assert.ok(marker > cancelCheck, 'the pre marker must not be written for a cancelled page');
});

test('priority phase is bounded by a deadline', () => {
  assert.match(sweep, /PRIORITY_PHASE_MAX_MS/);
  const phase = sweep.slice(sweep.indexOf('const priorityPhase = async'));
  assert.match(phase, /PRIORITY_PHASE_MAX_MS/, 'the serial phase needs a total-time cap');
});

test('a timed-out detector iframe is torn down so the next call can rebuild', () => {
  const fn = detection.slice(detection.indexOf('function ensureIframe'));
  const timeout = fn.slice(fn.indexOf('setTimeout('));
  assert.match(timeout, /iframe\.remove\(\)/, 'the dead iframe must be removed');
  assert.match(timeout, /iframe = null/, 'the module must forget the dead element');
  assert.match(timeout, /ready = false/, 'readiness must be cleared so ensureIframe rebuilds');
});
