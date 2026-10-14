import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileBoundary, boundary, evaluate, elements } from './helpers/ux-fixture.mjs';

const settings = evaluate(await compileBoundary('src/llm/pipeline-settings.ts'), {});
const sectionCode = await compileBoundary('src/options/pipeline-section.ts', { real: ['../llm/pipeline-settings'] });
const modelCode = await compileBoundary('src/options/model.ts', { real: ['../llm/pipeline-settings'] });

function sectionFixture() {
    const dom = elements();
    dom.$('stylePreset').options = [];
    const section = evaluate(sectionCode, boundary({ $: dom.$ }), {
        document: dom.document, chrome: { tabs: { query: async () => [] } },
    });
    return { section, dom };
}

for (const name of ['fast', 'balanced', 'best']) {
    test(`reopening Settings recognizes the saved ${name} preset`, () => {
        const { section, dom } = sectionFixture();
        const saved = settings.applyPreset(name, { targetLang: 'English', renderFont: 'selected', readingDir: 'ltr' });
        section.loadStoredPipeline(JSON.parse(JSON.stringify(saved)));
        section.syncAdvancedUI();
        assert.equal(dom.$('preset').value, name);
        assert.equal(dom.$('cropSizeNum').value, String(saved.cropSize));
        assert.equal(dom.$('contextPairsNum').value, String(saved.contextPairs));
    });
}

test('loading custom tuning does not trust an outdated saved preset name', () => {
    const { section, dom } = sectionFixture();
    section.loadStoredPipeline({ ...settings.applyPreset('fast'), cropSize: 500 });
    section.syncAdvancedUI();
    assert.equal(dom.$('preset').value, 'custom');
    assert.equal(dom.$('cropSizeNum').value, '500');
});

for (const [id, event] of [['preset', 'change'], ['resetAdv', 'click']]) {
    test(`${id} refreshes model tuning controls after applying its settings`, () => {
        const dom = elements(), listeners = new Map();
        const $ = id => {
            const el = dom.$(id);
            el.addEventListener = (event, listener) => listeners.set(id + ':' + event, listener);
            return el;
        };
        const pipeline = settings.loadPipelineSettings({ inferEngine: 'cloud', inpaint: 'off',
            thinkingLevel: 'high', temperature: 0.7, ocrTemperature: 0.7 });
        const model = evaluate(modelCode, boundary({ $, pipeline,
            DEFAULT_BASES: { openai: 'https://provider.test/v1' },
            THINKING_LEVELS: { openai: ['auto', 'none', 'high'] }, THINKING_HINTS: { auto: 'Auto', high: 'High' },
        }), { document: dom.document });
        const credentials = { provider: 'openai', model: 'fixture', apiKey: 'mock' };
        model.fillModelFields(credentials);
        model.fillOcrFields(credentials);
        assert.equal($('thinking').value, 'high');
        assert.equal($('temperatureNum').value, '0.7');
        assert.equal($('ocrTemperatureNum').value, '0.7');
        Object.assign(pipeline, settings.applyPreset(id === 'preset' ? 'fast' : 'balanced', pipeline));
        listeners.get(id + ':' + event)();
        assert.equal($('thinking').value, pipeline.thinkingLevel);
        assert.equal($('temperatureAuto').checked, true);
        assert.equal($('ocrTemperatureAuto').checked, false);
        assert.equal($('ocrTemperatureNum').value, String(pipeline.ocrTemperature));
    });
}
