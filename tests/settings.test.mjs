// Unit tests for pipeline settings. Run: npm test
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/llm/pipeline-settings.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/settings.mjs', sourcemap: 'inline',
});

const { DEFAULT_PIPELINE_SETTINGS, applyPreset, loadPipelineSettings, mergePipeline, matchingPreset, TARGET_LANGS, filterTargetLangs, isAutoSite, autoSiteOf, autoSiteList, autoSiteAdd, autoSiteRemove } =
  await import(new URL('../.test-build/settings.mjs', import.meta.url).href);

test('defaults are balanced preset', () => {
  assert.equal(matchingPreset(DEFAULT_PIPELINE_SETTINGS), 'balanced');
});

test('fast preset changes tuning values', () => {
  const fast = applyPreset('fast');
  assert.equal(fast.cropSize, 360);
  assert.equal(fast.contextPairs, 15);
  assert.equal(fast.textSource, 'crops'); // unchanged from default
  assert.equal(matchingPreset(fast), 'fast');
});

test('best preset', () => {
  const best = applyPreset('best');
  assert.equal(best.cropSize, 560);
  assert.equal(best.jpegQuality, 0.9);
});

test('load fills missing keys, drops unknown, resets wrong types', () => {
  const merged = loadPipelineSettings({
    cropSize: 500,
    bogusKey: 'x',
    detConf: 'not a number',
    ocrLangs: ['jpn', 'eng'],
  });
  assert.equal(merged.cropSize, 500);
  assert.deepEqual(merged.ocrLangs, ['jpn', 'eng']);
  assert.equal(merged.detConf, DEFAULT_PIPELINE_SETTINGS.detConf); // type reset
  assert.equal(merged.bogusKey, undefined);
});

test('temperature: null = provider default; numbers clamp to 0-1; junk resets', () => {
  assert.equal(DEFAULT_PIPELINE_SETTINGS.temperature, null);
  assert.equal(loadPipelineSettings({ temperature: 0.3 }).temperature, 0.3);
  assert.equal(loadPipelineSettings({ temperature: 0 }).temperature, 0);
  for (const bad of [2, -1, NaN, Infinity, '0.3', true, {}]) {
    assert.equal(loadPipelineSettings({ temperature: bad }).temperature, null, String(bad));
  }
  // pinned temperature is a quality knob: presets read as "custom"
  assert.equal(matchingPreset(loadPipelineSettings({ temperature: 0.3 })), 'custom');
});

test('migration: old useVision/visionMode/ocrModel map onto textSource', () => {
  // visionMode 'text' → crops
  assert.equal(loadPipelineSettings({ visionMode: 'text' }).textSource, 'crops');
  // useVision false (old broken text-only) → crops (nearest working mode)
  assert.equal(loadPipelineSettings({ useVision: false }).textSource, 'crops');
  // tesseract selected → ocr
  assert.equal(loadPipelineSettings({ ocrModel: 'tesseract' }).textSource, 'ocr');
  // default/old vision on → page
  assert.equal(loadPipelineSettings({ useVision: true, visionMode: 'auto' }).textSource, 'page');
  // fresh installs (no keys at all) follow the current default
  assert.equal(loadPipelineSettings({}).textSource, DEFAULT_PIPELINE_SETTINGS.textSource);
  assert.equal(DEFAULT_PIPELINE_SETTINGS.textSource, 'crops');
  // explicit new value wins — no migration
  assert.equal(loadPipelineSettings({ textSource: 'ocr' }).textSource, 'ocr');
});

test('load handles garbage and empties', () => {
  assert.deepEqual(loadPipelineSettings(null), DEFAULT_PIPELINE_SETTINGS);
  assert.deepEqual(loadPipelineSettings('junk'), DEFAULT_PIPELINE_SETTINGS);
  assert.deepEqual(loadPipelineSettings({}), DEFAULT_PIPELINE_SETTINGS);
});

test('custom detection when values diverge from every preset', () => {
  const custom = { ...DEFAULT_PIPELINE_SETTINGS, minFont: 18 };
  assert.equal(matchingPreset(custom), 'custom');
});

test('filterTargetLangs: empty returns all, query matches en+native, starts-first', () => {
  assert.ok(TARGET_LANGS.length >= 30);
  assert.equal(filterTargetLangs('')[0].en, 'English');
  assert.equal(filterTargetLangs('')[1].en, 'Thai');
  const vi = filterTargetLangs('vi').map(l => l.en);
  assert.ok(vi.includes('Vietnamese'));
  assert.equal(filterTargetLangs('ไทย')[0].en, 'Thai');
  assert.equal(filterTargetLangs('viet')[0].en, 'Vietnamese');
});

test('thinkingLevel migration: minimal→low, blank→auto, case-folded, custom kept', () => {
  assert.equal(loadPipelineSettings({ thinkingLevel: 'minimal' }).thinkingLevel, 'low');
  assert.equal(loadPipelineSettings({ thinkingLevel: '' }).thinkingLevel, 'auto');
  assert.equal(loadPipelineSettings({ thinkingLevel: 'High' }).thinkingLevel, 'high');
  assert.equal(loadPipelineSettings({ thinkingLevel: 'turbo' }).thinkingLevel, 'turbo');
  assert.equal(loadPipelineSettings({ thinkingLevel: '12000' }).thinkingLevel, '12000');
  assert.equal(loadPipelineSettings({ thinkingLevel: '  high  ' }).thinkingLevel, 'high');
});

test('readingDir defaults to rtl and resets garbage', () => {
  assert.equal(loadPipelineSettings({}).readingDir, 'rtl');
  assert.equal(loadPipelineSettings({ readingDir: 'ltr' }).readingDir, 'ltr');
  assert.equal(loadPipelineSettings({ readingDir: 'vertical' }).readingDir, 'rtl');
});

test('panelConf clamps to 0.05-1, deferLabels resets non-boolean', () => {
  assert.equal(loadPipelineSettings({}).panelConf, 0.20);
  assert.equal(loadPipelineSettings({ panelConf: 0.15 }).panelConf, 0.15);
  assert.equal(loadPipelineSettings({ panelConf: 0.8 }).panelConf, 0.8);
  assert.equal(loadPipelineSettings({ panelConf: 1.5 }).panelConf, 0.20);
  assert.equal(loadPipelineSettings({ panelConf: 'high' }).panelConf, 0.20);
  assert.equal(loadPipelineSettings({}).deferLabels, true);
  assert.equal(loadPipelineSettings({ deferLabels: false }).deferLabels, false);
  assert.equal(loadPipelineSettings({ deferLabels: 'yes' }).deferLabels, true);
  assert.equal(loadPipelineSettings({}).cacheEnabled, true);
  assert.equal(loadPipelineSettings({ cacheEnabled: false }).cacheEnabled, false);
  assert.equal(loadPipelineSettings({ cacheEnabled: 'yes' }).cacheEnabled, true);
});

test('text/stroke colors: hex kept, garbage resets to auto, stroke clamps', () => {  assert.equal(loadPipelineSettings({ textColor: '#ff0000' }).textColor, '#ff0000');
  assert.equal(loadPipelineSettings({ strokeColor: '#00ff00' }).strokeColor, '#00ff00');
  assert.equal(loadPipelineSettings({ textColor: 'red' }).textColor, 'auto');
  assert.equal(loadPipelineSettings({ textColor: '#fff' }).textColor, 'auto'); // 6-digit only
  assert.equal(loadPipelineSettings({ strokeColor: 123 }).strokeColor, 'auto');
  assert.equal(loadPipelineSettings({ textStroke: 0 }).textStroke, 0); // off is valid
  assert.equal(loadPipelineSettings({ textStroke: 0.2 }).textStroke, 0.2);
  assert.equal(loadPipelineSettings({ textStroke: 9 }).textStroke, 0.1);
  assert.equal(loadPipelineSettings({ textStroke: 'big' }).textStroke, 0.1);
});

test('prefetchN: default 3, int 1-30, out-of-range resets, preset display ignores it', () => {
  assert.equal(loadPipelineSettings({}).prefetchN, 3);
  assert.equal(loadPipelineSettings({ prefetchN: 7 }).prefetchN, 7);
  assert.equal(loadPipelineSettings({ prefetchN: 30 }).prefetchN, 30);
  assert.equal(loadPipelineSettings({ prefetchN: 2.7 }).prefetchN, 3);
  assert.equal(loadPipelineSettings({ prefetchN: 0 }).prefetchN, 3);
  assert.equal(loadPipelineSettings({ prefetchN: 99 }).prefetchN, 3);
  assert.equal(loadPipelineSettings({ prefetchN: 'many' }).prefetchN, 3);
  assert.equal(matchingPreset({ ...DEFAULT_PIPELINE_SETTINGS, prefetchN: 9 }), 'balanced');
});

test('cacheMax: default 200, int 10-2000, out-of-range resets, preset display ignores it', () => {
  assert.equal(loadPipelineSettings({}).cacheMax, 200);
  assert.equal(loadPipelineSettings({ cacheMax: 500 }).cacheMax, 500);
  assert.equal(loadPipelineSettings({ cacheMax: 1500 }).cacheMax, 1500);
  assert.equal(loadPipelineSettings({ cacheMax: 42.7 }).cacheMax, 43);
  assert.equal(loadPipelineSettings({ cacheMax: 5 }).cacheMax, 200);
  assert.equal(loadPipelineSettings({ cacheMax: 5000 }).cacheMax, 200);
  assert.equal(loadPipelineSettings({ cacheMax: 'lots' }).cacheMax, 200);
  assert.equal(matchingPreset({ ...DEFAULT_PIPELINE_SETTINGS, cacheMax: 50 }), 'balanced');
});

test('inferEngine: default local, cloud kept, garbage resets, preset display ignores it', () => {
  assert.equal(loadPipelineSettings({}).inferEngine, 'local');
  assert.equal(loadPipelineSettings({ inferEngine: 'cloud' }).inferEngine, 'cloud');
  assert.equal(loadPipelineSettings({ inferEngine: 'gpu' }).inferEngine, 'local');
  assert.equal(loadPipelineSettings({ inferEngine: 1 }).inferEngine, 'local');
  assert.equal(matchingPreset({ ...DEFAULT_PIPELINE_SETTINGS, inferEngine: 'cloud' }), 'balanced');
});

test('detEp: default auto, wasm kept, garbage resets, preset display ignores it', () => {
  assert.equal(loadPipelineSettings({}).detEp, 'auto');
  assert.equal(loadPipelineSettings({ detEp: 'wasm' }).detEp, 'wasm');
  assert.equal(loadPipelineSettings({ detEp: 'webgpu' }).detEp, 'auto');
  assert.equal(loadPipelineSettings({ detEp: 1 }).detEp, 'auto');
  assert.equal(matchingPreset({ ...DEFAULT_PIPELINE_SETTINGS, detEp: 'wasm' }), 'balanced');
});

// ---- per-site auto-translate ----

test('isAutoSite: list hit/miss; legacy flag only when no list', () => {
  const sites = ['https://reader-a.example', 'https://reader-b.example'];
  assert.equal(isAutoSite('https://reader-a.example', sites, false), true);
  assert.equal(isAutoSite('https://ads.example.com', sites, false), false);
  assert.equal(isAutoSite('https://anything.example', undefined, true), true);
  assert.equal(isAutoSite('https://anything.example', undefined, false), false);
  assert.equal(isAutoSite('https://anything.example', null, true), true);
});

test('isAutoSite: malformed list entries never match', () => {
  assert.equal(isAutoSite('https://mangadex.org', ['https://mangadex.org ', 42, null], false), false);
  assert.equal(isAutoSite('https://mangadex.org', [], true), false); // explicit empty list beats legacy
});

test('autoSiteOf: http(s) origins pass, chrome/about/garbage do not', () => {
  assert.equal(autoSiteOf('https://mangadex.org/title/abc/chapter/1'), 'https://mangadex.org');
  assert.equal(autoSiteOf('http://localhost:3000/x'), 'http://localhost:3000');
  assert.equal(autoSiteOf('chrome://extensions/'), null);
  assert.equal(autoSiteOf('about:addons'), null);
  assert.equal(autoSiteOf(undefined), null);
  assert.equal(autoSiteOf('not a url'), null);
});

test('autoSiteList sanitizes; add/remove are idempotent', () => {
  assert.deepEqual(autoSiteList(undefined), []);
  assert.deepEqual(autoSiteList(['https://a.org', 'https://a.org', 42, '', null]), ['https://a.org']);
  assert.deepEqual(autoSiteAdd(['https://a.org'], 'https://b.org'), ['https://a.org', 'https://b.org']);
  assert.deepEqual(autoSiteAdd(['https://a.org'], 'https://a.org'), ['https://a.org']);
  assert.deepEqual(autoSiteRemove(['https://a.org', 'https://b.org'], 'https://a.org'), ['https://b.org']);
  assert.deepEqual(autoSiteRemove(['https://a.org'], 'https://x.org'), ['https://a.org']);
});

test('contextPairs validated 0-200, rounded, default 40', () => {
  assert.equal(loadPipelineSettings({ contextPairs: 80 }).contextPairs, 80);
  assert.equal(loadPipelineSettings({ contextPairs: 200 }).contextPairs, 200);
  assert.equal(loadPipelineSettings({ contextPairs: 201 }).contextPairs, 40);
  assert.equal(loadPipelineSettings({ contextPairs: -1 }).contextPairs, 40);
  assert.equal(loadPipelineSettings({ contextPairs: 67.7 }).contextPairs, 68);
  assert.equal(loadPipelineSettings({}).contextPairs, 40);
});

test('detConf clamps to 0-1, showToasts defaults true, wrong types reset', () => {
  assert.equal(loadPipelineSettings({}).detConf, 0.35);
  assert.equal(loadPipelineSettings({ detConf: 0.9 }).detConf, 0.9);
  assert.equal(loadPipelineSettings({ detConf: 5 }).detConf, 0.35);
  assert.equal(loadPipelineSettings({}).showToasts, true);
  assert.equal(loadPipelineSettings({ showToasts: false }).showToasts, false);
  assert.equal(loadPipelineSettings({ showToasts: 'no' }).showToasts, true);
  assert.equal(matchingPreset({ ...DEFAULT_PIPELINE_SETTINGS, showToasts: false }), 'balanced');
});

test('transcribeSrc defaults false, wrong types reset', () => {
  assert.equal(loadPipelineSettings({}).transcribeSrc, false);
  assert.equal(loadPipelineSettings({ transcribeSrc: true }).transcribeSrc, true);
  assert.equal(loadPipelineSettings({ transcribeSrc: 'yes' }).transcribeSrc, false);
});

test('useOcrModel defaults false, wrong types reset, never marks Custom', () => {
  assert.equal(loadPipelineSettings({}).useOcrModel, false);
  assert.equal(loadPipelineSettings({ useOcrModel: true }).useOcrModel, true);
  assert.equal(loadPipelineSettings({ useOcrModel: 'yes' }).useOcrModel, false);
  assert.equal(matchingPreset({ ...DEFAULT_PIPELINE_SETTINGS, useOcrModel: true }), 'balanced');
});

test('ocrThinking defaults none, normalizes like thinkingLevel, never marks Custom', () => {
  assert.equal(loadPipelineSettings({}).ocrThinking, 'none');
  assert.equal(loadPipelineSettings({ ocrThinking: 'high' }).ocrThinking, 'high');
  assert.equal(loadPipelineSettings({ ocrThinking: '' }).ocrThinking, 'none');
  assert.equal(loadPipelineSettings({ ocrThinking: 'minimal' }).ocrThinking, 'low');
  assert.equal(loadPipelineSettings({ ocrThinking: 'HIGH' }).ocrThinking, 'high');
  assert.equal(loadPipelineSettings({ ocrThinking: 'turbo' }).ocrThinking, 'turbo'); // custom passes through
  assert.equal(matchingPreset({ ...DEFAULT_PIPELINE_SETTINGS, ocrThinking: 'high' }), 'balanced');
});

test('mergePipeline: popup-owned keys survive an options save', () => {
  const fresh = loadPipelineSettings({ prefetchN: 3, targetLang: 'Thai' });
  const staleLocal = loadPipelineSettings({ prefetchN: 10, targetLang: 'English' });
  const merged = mergePipeline(fresh, staleLocal);
  assert.equal(merged.prefetchN, 3); // popup's value kept
  assert.equal(merged.targetLang, 'English'); // options' edit applied
  assert.equal(mergePipeline(undefined, staleLocal).prefetchN, 3); // missing storage = default, still not stale
});
