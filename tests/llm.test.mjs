// Unit tests for LLM core (pure logic). Run: npm test
// (builds core.ts to ESM first — node:test can't load TS directly)
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';

mkdirSync('.test-build', { recursive: true });
await build({
  entryPoints: ['src/llm/core.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/core.mjs', sourcemap: 'inline',
});
await build({
  entryPoints: ['src/llm/adapters.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/adapters.mjs', sourcemap: 'inline',
});
await build({
  entryPoints: ['src/llm/ocr-models.ts'],
  bundle: true, format: 'esm', outfile: '.test-build/ocr-models.mjs', sourcemap: 'inline',
});

const { buildPrompt, parseResponse, mergeCharacter, updateContext, applyBookOps, EMPTY_CONTEXT, splitStablePrefix, transcriptionMatches, joinTranscription } =
  await import(new URL('../.test-build/core.mjs', import.meta.url).href);
const { toMtError, LlmHttpError, MtError, translateRequestParts, translateRequestId, callLLM, cfRunUrl, cfBody, cfParse, cfError, cfImageCapHint, isImageCapError, isCfAiBase } =
  await import(new URL('../.test-build/adapters.mjs', import.meta.url).href);
const { langOk, fetchWithProgress } =
  await import(new URL('../.test-build/ocr-models.mjs', import.meta.url).href);

// ---- parseResponse: XML (primary format) ----

test('parse XML: name attr flows into spk; blank name is dropped', () => {
  const r = parseResponse(
    '<r n="1" spk="schoolboy with glasses" g="M" name="ยามาดะ">สวัสดีครับ</r>\n' +
    '<r n="2" spk="twintail girl" g="F" name="">หยุดเถอะ</r>\n' +
    '<r n="3" spk="boy" g="M">โอเค</r>', 3);
  assert.equal(r.regions[0].spk.name, 'ยามาดะ');
  assert.equal(r.regions[1].spk.name, undefined);
  assert.equal(r.regions[2].spk.name, undefined);
});

test('updateContext: named speaker merges name into the book (first wins)', () => {
  const ctx1 = updateContext(EMPTY_CONTEXT, [
    { index: 1, source: '', translation: 'สวัสดี', spk: { desc: 'boy with spiky hair', gender: 'M', name: 'ยามาดะ' } },
  ]).ctx;
  assert.equal(ctx1.characters[0].name, 'ยามาดะ');
  // later observation of the same character must not rename him
  const ctx2 = updateContext(ctx1, [
    { index: 1, source: '', translation: 'โอเค', spk: { desc: 'spiky hair boy', gender: 'M', name: 'ทาโร่' } },
  ]).ctx;
  assert.equal(ctx2.characters.length, 1);
  assert.equal(ctx2.characters[0].name, 'ยามาดะ');
});

test('parse XML: translation + keep + spk attrs', () => {
  const r = parseResponse(
    'Here you go:\n' +
    '<r n="1" spk="schoolboy with glasses" g="M">ไปด้วยกันไหมครับ</r>\n' +
    '<r n="2" spk="twintail girl" g="F">ไปสิ!</r>\n' +
    '<r n="3" keep="true"/>', 3);
  assert.equal(r.regions.length, 3);
  assert.equal(r.regions[0].translation, 'ไปด้วยกันไหมครับ');
  assert.equal(r.regions[0].spk.gender, 'M');
  assert.equal(r.regions[0].spk.desc, 'schoolboy with glasses');
  assert.equal(r.regions[1].spk.gender, 'F');
  assert.equal(r.regions[2].translation, 'keep');
  assert.equal(r.regions[2].spk, null);
});

test('parse XML: unclosed tag tolerantly reads to end of line', () => {
  const r = parseResponse(
    '<r n="1" spk="boy" g="M">สวัสดีครับ\n' +
    '<r n="2" keep="true"/>', 2);
  assert.equal(r.regions.length, 2);
  assert.equal(r.regions[0].translation, 'สวัสดีครับ');
  assert.equal(r.regions[1].translation, 'keep');
});

test('parse XML: empty element and literal keep content are both keep', () => {
  const r = parseResponse(
    '<r n="1" keep="true"></r>\n' +
    '<r n="2">keep</r>\n' +
    '<r n="3">...</r>', 3);
  assert.equal(r.regions[0].translation, 'keep');
  assert.equal(r.regions[1].translation, 'keep');
  assert.equal(r.regions[2].translation, '...'); // ellipsis = real text
});

test('parse XML: degenerate and meta no-text content map to keep', () => {
  const r = parseResponse(
    '<r n="1" spk="girl, no dialogue" g="F">=></r>\n' +
    '<r n="2" spk="shocked girl" g="F">(ไม่มีข้อความ)</r>\n' +
    '<r n="3" spk="boy" g="M">!!</r>', 3);
  assert.equal(r.regions[0].translation, 'keep');
  assert.equal(r.regions[0].spk.gender, 'F');
  assert.equal(r.regions[1].translation, 'keep');
  assert.equal(r.regions[2].translation, '!!'); // punctuation = real text
});

// suspected live leak (couldn't reproduce, hardened by normalization):
// trailing punctuation after the bracket / Thai word spacing variants.
// Bracket guard removed — wrapped notes render now; only explicit no-text
// phrasing still keeps.
test('meta no-text: explicit phrasing keeps, bare brackets render', () => {
  const r = parseResponse(
    '<r n="16" spk="girl shocked" g="F">(ไม่มีข้อความ - สีหน้าเงียบ).</r>\n' +
    '<r n="2" spk="girl" g="F">(ไม่มี ข้อความ)</r>\n' +
    '<r n="3" spk="girl" g="F">(...)</r>\n' +
    '<r n="4" spk="boy" g="M">ตึก! (เสียงประตู)</r>', 16);
  assert.equal(r.regions[0].translation, 'keep'); // explicit ไม่มีข้อความ
  assert.equal(r.regions[1].translation, 'keep'); // explicit ไม่มีข้อความ
  assert.equal(r.regions[2].translation, '(...)'); // bare brackets render now
  assert.equal(r.regions[3].translation, 'ตึก! (เสียงประตู)'); // real text w/ paren stays
});

test('parse XML: thai gender words in g attr', () => {
  const r = parseResponse('<r n="1" spk="ผู้หญิงผมยาว" g="หญิง">อะไร</r>', 1);
  assert.equal(r.regions[0].spk.gender, 'F');
});

test('parse XML: extra regions with coords', () => {
  const r = parseResponse(
    '<r n="1">ก</r>\n' +
    '<extra x="120,340,560,420">ป้ายที่เด็กถือ</extra>\n' +
    '<extra x="900,1000,1300,1080">เสียงเอฟเฟกต์</extra>', 1);
  assert.equal(r.regions.length, 1);
  assert.equal(r.extras.length, 2);
  assert.deepEqual([r.extras[0].x1, r.extras[0].y1, r.extras[0].x2, r.extras[0].y2], [120, 340, 560, 420]);
});

test('parse XML: filters out-of-range and attrless elements', () => {
  const r = parseResponse('<r n="1">ก</r>\n<r n="99">ฮ</r>\n<r>no attrs</r>', 1);
  assert.equal(r.regions.length, 1);
});

// ---- legacy line format is GONE (XML-only parser) ----

test('non-XML output parses to empty (caller retries, never silent)', () => {
  const r = parseResponse(
    '<|1|> 行く？ => ไปด้วยกันไหมครับ || spk: schoolboy with glasses, M\n' +
    '<|2|> うん！ => ไปสิ!', 2);
  assert.equal(r.regions.length, 0);
  assert.equal(r.extras.length, 0);
});

// ---- character book merge ----

test('similar descriptions merge, richer desc wins', () => {
  let book = [{ desc: 'twintail girl in school uniform', gender: 'F', source: 'vlm' }];
  book = mergeCharacter(book, { desc: 'twintail girl', gender: 'F', source: 'vlm' });
  assert.equal(book.length, 1);
  assert.equal(book[0].desc, 'twintail girl in school uniform');
});

test('gender upgrade from unknown', () => {
  let book = [{ desc: 'person at the window', gender: '?', source: 'speech' }];
  book = mergeCharacter(book, { desc: 'person at the window', gender: 'F', source: 'vlm' });
  assert.equal(book[0].gender, 'F');
});

test('user entry is never overwritten', () => {
  let book = [{ desc: 'the class president', gender: 'F', source: 'user' }];
  book = mergeCharacter(book, { desc: 'the class president', gender: 'M', source: 'vlm' });
  assert.equal(book[0].gender, 'F');
  assert.equal(book[0].source, 'user');
});

test('book capped at MAX_CHARACTERS', () => {
  let book = [];
  for (let i = 0; i < 15; i++) {
    book = mergeCharacter(book, { desc: `unique character number ${i}`, gender: '?', source: 'speech' });
  }
  assert.ok(book.length <= 10);
});

// ---- updateContext ----

test('context accumulates pairs and characters, respects caps', () => {
  let ctx = EMPTY_CONTEXT;
  for (let page = 0; page < 5; page++) {
    ctx = updateContext(ctx, [
      { index: 1, source: `src${page}`, translation: `th${page}`, spk: { desc: 'hero girl', gender: 'F' } },
    ]).ctx;
  }
  assert.equal(ctx.pairs.length, 5);
  assert.equal(ctx.characters.length, 1);
  assert.equal(ctx.characters[0].gender, 'F');
});

// ---- buildPrompt ----

test('splitStablePrefix: everything before <regions> is stable; no boundary → null', () => {
  const p = buildPrompt([{ index: 1, source: 'こんにちは' }], EMPTY_CONTEXT, false, { ocr: true });
  const s = splitStablePrefix(p);
  assert.ok(s, 'boundary exists in a normal prompt');
  assert.ok(s.stable.includes('<rules>'));
  assert.ok(!s.stable.includes('<regions>'));
  assert.ok(s.varying.startsWith('<regions>'));
  assert.equal(s.stable + s.varying, p, 'roundtrip: parts reassemble to the original');
  // two pages of the same manga share the same stable prefix
  const q = buildPrompt([{ index: 1, source: 'ちがう台詞' }], EMPTY_CONTEXT, false, { ocr: true });
  assert.equal(splitStablePrefix(q).stable, s.stable);
  assert.equal(splitStablePrefix('no boundary here'), null);
});

test('text-only vision mode: crops-only images section + no-guess spk rule; extras rule dropped', () => {
  const p = buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, {
    textOnly: true, vlmAssisted: true, pageW: 907, pageH: 1280,
  });
  assert.ok(p.includes('There is no full-page image'));
  assert.ok(p.includes('omit spk and g rather than guess'));
  assert.ok(!p.includes('<extra'));
  // page mode keeps the full-page wording and (when asked) the extras rule
  const q = buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, {
    vlmAssisted: true, pageW: 907, pageH: 1280,
  });
  assert.ok(q.includes('full page with red number badges'));
  assert.ok(q.includes('<extra'));
});

test('OCR mode: no images section, source text inline, SFX + no-guess rules', () => {
  const p = buildPrompt(
    [{ index: 1, source: 'こんにちは、先輩！' }, { index: 2, source: 'ドン' }],
    EMPTY_CONTEXT, false, { ocr: true },
  );
  assert.ok(!p.includes('<images>'));
  assert.ok(p.includes('read by local OCR'));
  assert.ok(p.includes('こんにちは、先輩！'));
  assert.ok(p.includes('katakana-heavy'));
  assert.ok(p.includes('omit spk and g rather than guess'));
});

test('prompt includes regions, book, honorific rule — and no size numbers', () => {
  const p = buildPrompt(
    [{ index: 1, source: 'こんにちは' }],
    { pairs: [['こんにちは', 'สวัสดี']], characters: [{ desc: 'hero girl', gender: 'F', source: 'vlm' }] },
    true,
  );
  assert.ok(p.includes('honorifics'));
  assert.ok(p.includes('hero girl'));
  assert.ok(p.includes('こんにちは'));
  // no char-budget hints anywhere: numeric anchors shorten translations even
  // next to "translate fully" — the renderer fits whatever comes back
  assert.ok(!p.includes('box fits'));
  assert.ok(!p.includes('auto-shrunk'));
  assert.ok(!/\d+ chars/.test(p));
  // completeness rule — the anti-elision fix
  assert.ok(p.includes('never drop the subject, tense/aspect, or emphasis'));
  assert.ok(p.includes('สวัสดี'));
  // XML output format with the keep form as a distinct structural element
  assert.ok(p.includes('<r n="REGION" keep="true"/>'));
  assert.ok(p.includes('r n="1" spk="boy with spiky hair" g="M" name="ยามาดะ">ไปด้วยกันไหมครับ</r>'));
});

test('style prompt appended as a rule; absent when empty', () => {
  const regions = [{ index: 1, source: '' }];
  const withStyle = buildPrompt(regions, EMPTY_CONTEXT, true, { stylePrompt: 'Casual tone — drop polite endings' });
  assert.ok(withStyle.includes('Style (applies to every region): Casual tone'));
  const noStyle = buildPrompt(regions, EMPTY_CONTEXT, true, { stylePrompt: '   ' });
  assert.ok(!noStyle.includes('Style'));
});

test('named character marked as canonical in the book section', () => {
  const p = buildPrompt(
    [{ index: 1, source: '' }],
    { pairs: [], characters: [{ desc: 'spiky guy', gender: 'M', source: 'user', name: 'Kirisame' }] },
    true,
  );
  assert.ok(p.includes('Kirisame: spiky guy'));
  assert.ok(p.includes('always use this name'));
});

test('target language parameterizes the prompt; Thai keeps particle rule, others get the generic rule', () => {
  const regions = [{ index: 1, source: '' }];
  const th = buildPrompt(regions, EMPTY_CONTEXT, true, { targetLang: 'Thai' });
  assert.ok(th.includes('into Thai'));
  assert.ok(th.includes('ครับ/ค่ะ/คะ'));
  assert.ok(th.includes('Thai translation</r>'));

  const en = buildPrompt(regions, EMPTY_CONTEXT, true, { targetLang: 'English' });
  assert.ok(en.includes('into English'));
  assert.ok(en.includes('English translation</r>'));
  assert.ok(!en.includes('ครับ/ค่ะ/คะ'));
  assert.ok(en.includes('gendered speech forms'));

  // default (no targetLang) = Thai
  const dflt = buildPrompt(regions, EMPTY_CONTEXT, true);
  assert.ok(dflt.includes('into Thai'));
});

// ---- applyOverrides (user gender overrides are law) ----
const { applyOverrides } = await import(new URL('../.test-build/core.mjs', import.meta.url).href);

test('override forces gender and promotes to user source', () => {
  const ctx = { pairs: [], characters: [{ desc: 'hero girl', gender: 'M', source: 'vlm' }] };
  const out = applyOverrides(ctx, { 'hero girl': { gender: 'F' } });
  assert.equal(out.characters[0].gender, 'F');
  assert.equal(out.characters[0].source, 'user');
});

test('override for unknown character adds it to the book', () => {
  const out = applyOverrides(EMPTY_CONTEXT, { 'the detective': { gender: 'M' } });
  assert.equal(out.characters.length, 1);
  assert.equal(out.characters[0].source, 'user');
});

test('no overrides = context untouched', () => {
  const ctx = { pairs: [['a', 'b']], characters: [{ desc: 'x', gender: 'F', source: 'vlm' }] };
  assert.deepEqual(applyOverrides(ctx, {}), ctx);
});

test('same user name collapses fragmented entries into one character', () => {
  // the model fragmented one person into two descs across pages
  const ctx = {
    pairs: [],
    characters: [
      { desc: 'spiky-haired guy', gender: '?', source: 'vlm' },
      { desc: 'inspector with spiky hair', gender: 'M', source: 'vlm' },
    ],
  };
  const out = applyOverrides(ctx, {
    'spiky-haired guy': { gender: 'M', name: 'Kirisame' },
    'inspector with spiky hair': { gender: 'M', name: 'Kirisame' },
  });
  assert.equal(out.characters.length, 1);
  assert.equal(out.characters[0].name, 'Kirisame');
  assert.equal(out.characters[0].gender, 'M');
  // union desc keeps both visual anchors for the model to match
  assert.ok(out.characters[0].desc.includes('spiky-haired guy'));
  assert.ok(out.characters[0].desc.includes('inspector'));
});

test('keep directive parsed and preserved', () => {
  const r = parseResponse('<r n="1" keep="true"/>\n<r n="2">สวัสดี</r>', 2);
  assert.equal(r.regions[0].translation, 'keep');
  assert.equal(r.regions[1].translation, 'สวัสดี');
});

test('keep regions contribute nothing to context', () => {
  const ctx = updateContext(EMPTY_CONTEXT, [
    { index: 1, source: 'チッ', translation: 'keep', spk: { desc: 'someone', gender: 'M' } },
    { index: 2, source: 'hi', translation: 'หวัดดีครับ', spk: null },
  ]).ctx;
  assert.equal(ctx.pairs.length, 1);
  assert.equal(ctx.characters.length, 0);
});

// literal keep word inside an element maps to keep, never renders
{
  const r = parseResponse('<r n="1">keep</r>\n<r n="2">keep (SFX)</r>\n<r n="3">=> keep</r>', 3);
  assert.equal(r.regions[0].translation, 'keep');
  assert.equal(r.regions[1].translation, 'keep');
  assert.equal(r.regions[2].translation, 'keep');
}

// models describe a textless crop in prose/brackets inside the element —
// seen live through the old format; the hardening must hold in XML too
test('meta no-text descriptions map to keep (XML content)', () => {
  const r = parseResponse(
    '<r n="1">[ขอบสันห่วงสมุดสเก็ตช์ ไม่มีข้อความ]</r>\n' +
    '<r n="2">(no readable text, just a flower drawing)</r>\n' +
    '<r n="3">no text — spiral binding</r>\n' +
    '<r n="4" spk="short black bob girl shocked face silent" g="F">(เงียบ ไม่มีบทพูด)</r>\n' +
    '<r n="5" spk="ผู้ชายผมตั้ง" g="M">เงียบสงัดไปทั้งห้อง</r>', 5);
  assert.equal(r.regions[0].translation, 'keep');
  assert.equal(r.regions[1].translation, 'keep');
  assert.equal(r.regions[2].translation, 'keep');
  assert.equal(r.regions[3].translation, 'keep');
  assert.equal(r.regions[3].spk.gender, 'F');
  // real dialogue containing เงียบ must NOT be cut
  assert.equal(r.regions[4].translation, 'เงียบสงัดไปทั้งห้อง');
});

test('real translations never trip the meta filter', () => {
  const r = parseResponse('<r n="1">มีข้อความอยู่นะ</r>', 1);
  assert.equal(r.regions[0].translation, 'มีข้อความอยู่นะ');
});

// model emitted a bare "=>" / leading arrow inside an element (seen live)
test('leading arrow before a meta answer still maps to keep', () => {
  const r = parseResponse(
    '<r n="16" spk="shocked girl" g="F">=> (ไม่มีข้อความ - ภาพเงียบของเด็กสาวถือสมุดสเก็ตช์)</r>\n' +
    '<r n="2">=> keep</r>', 16);
  assert.equal(r.regions[0].translation, 'keep');
  assert.equal(r.regions[0].spk.gender, 'F');
  assert.equal(r.regions[1].translation, 'keep');
});

test('bare arrow / empty answers map to keep, ellipsis stays a translation', () => {
  const r = parseResponse(
    '<r n="1" spk="short black bob girl close-up" g="F">=></r>\n' +
    '<r n="2">-></r>\n' +
    '<r n="3">...</r>\n' +
    '<r n="4">สวัสดี</r>', 4);
  assert.equal(r.regions[0].translation, 'keep');
  assert.equal(r.regions[0].spk.gender, 'F');
  assert.equal(r.regions[1].translation, 'keep');
  assert.equal(r.regions[2].translation, '...'); // silent bubble = real text
  assert.equal(r.regions[3].translation, 'สวัสดี');
});

// whole-answer brackets = meta note, whatever the words — the model keeps
// finding new ways to describe a textless crop instead of saying keep
// ("[เงียบ - ทำตาโตด้วยความตกใจ]" seen live)
test('fully-bracketed answers render (bracket guard removed); partial brackets stay', () => {
  const r = parseResponse(
    '<r n="1" spk="shocked girl" g="F">[เงียบ - ทำตาโตด้วยความตกใจ]</r>\n' +
    '<r n="2">(ตกใจ)</r>\n' +
    '<r n="3">[ขอบสมุด ไม่มีข้อความ]</r>\n' +
    '<r n="4">สวัสดี (กระซิบ)</r>', 4);
  // bracket guard removed (it ate faithful system-message translations):
  // wrapped answers render; only explicit no-text phrasing still keeps
  assert.equal(r.regions[0].translation, '[เงียบ - ทำตาโตด้วยความตกใจ]');
  assert.equal(r.regions[0].spk.gender, 'F');
  assert.equal(r.regions[1].translation, '(ตกใจ)');
  assert.equal(r.regions[2].translation, 'keep'); // explicit ไม่มีข้อความ rule
  // real translation with parenthetical detail must survive
  assert.equal(r.regions[3].translation, 'สวัสดี (กระซิบ)');
});

// ---- toMtError: 400s that reject image input point at Local OCR ----
// (live shape: Console Go via Responses API — "invalid base64 in data URI
// at input[0].content[1]". The old options-page regex missed it because the
// message contains neither "image" nor "input_image".)

test('toMtError: 400 data-URI/base64 rejection gets the OCR hint', () => {
  const m = toMtError(new LlmHttpError(400,
    'LLM API 400: {"model":"muse-spark-1.3-contributor","error":{"type":"invalid_request_error",' +
    '"message":"Error from provider (Console Go): Upstream request failed: [invalid_request_error] ' +
    'invalid base64 in data URI at input[0].content[1]: Data URIs must use valid base64 encoding."}}'));
  assert.equal(m.kind, 'parse');
  assert.match(m.hint ?? '', /Local OCR/);
});

test('toMtError: plain 400 without image keywords gets no hint', () => {
  const m = toMtError(new LlmHttpError(400, 'LLM API 400: {"error":"unknown field foo"}'));
  assert.equal(m.hint, undefined);
});

// live: Cloudflare Workers AI 403 for un-agreed Meta models — the generic
// "API key is wrong" hint sent the user to re-check a working token
test('toMtError: CF license 403 gets the agree hint, other 403s keep the key hint', () => {
  const license = toMtError(new LlmHttpError(403,
    'LLM API 403: {"errors":[{"message":"AiError: Model Agreement: Prior to using this model, you must submit the prompt \'agree\'. ' +
    'By submitting \'agree\', you hereby agree to the llama-3.2-11b-vision-instruct Community License …"}]}'));
  assert.equal(license.kind, 'auth');
  assert.match(license.hint ?? '', /agree/);
  assert.doesNotMatch(license.hint ?? '', /API key is wrong/);
  const plain = toMtError(new LlmHttpError(403, 'LLM API 403: {"errors":[{"message":"Authentication error"}]}'));
  assert.match(plain.hint ?? '', /API key is wrong/);
});

// ---- Cloudflare Workers AI native run (live-probed shapes) ----

test('cfRunUrl: model in the URL, /ai and /ai/v1 bases both accepted', () => {
  assert.equal(cfRunUrl('https://api.cloudflare.com/client/v4/accounts/abc/ai', '@cf/meta/x'),
    'https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/meta/x');
  assert.equal(cfRunUrl('https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/', '@cf/meta/x'),
    'https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/meta/x');
});

test('isCfAiBase: the account AI base (with/without /v1) routes, deeper paths do not', () => {
  assert.equal(isCfAiBase('https://api.cloudflare.com/client/v4/accounts/abc/ai'), true);
  assert.equal(isCfAiBase('https://api.cloudflare.com/client/v4/accounts/abc/ai/v1'), true);
  assert.equal(isCfAiBase('https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/ '), true);
  assert.equal(isCfAiBase('https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/meta/x'), false);
  assert.equal(isCfAiBase('https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/chat/completions'), false);
  assert.equal(isCfAiBase('https://api.cloudflare.com/client/v4/accounts/abc'), false);
  assert.equal(isCfAiBase('https://api.openai.com/v1'), false);
  assert.equal(isCfAiBase(''), false);
});

test('dispatch: openai provider + CF base sends image calls to the native run endpoint', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return {
      ok: true, status: 200,
      async text() { return JSON.stringify({ result: { response: 'ok', usage: { prompt_tokens: 1, completion_tokens: 2 } }, success: true }); },
    };
  };
  const s = { provider: 'openai', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1', model: '@cf/meta/llama-3.2-11b-vision-instruct', apiKey: 'k' };
  try {
    const withImg = await callLLM(s, 'p', ['QUJD']);
    assert.equal(seen[0].url, 'https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/meta/llama-3.2-11b-vision-instruct');
    assert.equal(seen[0].body.model, undefined, 'native carries the model in the URL');
    assert.equal(withImg.text, 'ok');
    await callLLM(s, 'p');
    assert.equal(seen[1].url, 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/chat/completions');
    assert.equal(seen[1].body.model, s.model, 'text-only stays on the OpenAI-compatible path');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('temperature: each protocol carries it where legal; off = parameter not sent', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return {
      ok: true, status: 200,
      async text() {
        if (String(url).includes('/v1/messages')) return JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: {} });
        if (String(url).includes(':generateContent')) return JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
        return JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    };
  };
  const openai = { provider: 'openai', baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' };
  const anthropic = { provider: 'anthropic', baseUrl: 'https://a.test', model: 'm', apiKey: 'k' };
  const gemini = { provider: 'gemini', baseUrl: 'https://g.test/v1beta', model: 'm', apiKey: 'k' };
  try {
    await callLLM(openai, 'p', undefined, 'auto', undefined, 0.25);
    assert.equal(seen.at(-1).body.temperature, 0.25);
    await callLLM(openai, 'p');
    assert.equal(seen.at(-1).body.temperature, undefined, 'off = parameter not sent (provider default)');
    await callLLM(anthropic, 'p', undefined, 'auto', undefined, 0.25);
    assert.equal(seen.at(-1).body.temperature, 0.25);
    await callLLM(anthropic, 'p', undefined, 'low', undefined, 0.25);
    assert.equal(seen.at(-1).body.temperature, undefined, 'Anthropic forbids temperature together with thinking');
    await callLLM(gemini, 'p', undefined, 'auto', undefined, 0.25);
    assert.equal(seen.at(-1).body.generationConfig.temperature, 0.25);
    await callLLM(gemini, 'p', undefined, 'high', undefined, null);
    assert.equal(seen.at(-1).body.generationConfig.temperature, undefined);
    assert.ok(seen.at(-1).body.generationConfig.thinkingConfig, 'thinking config survives without a temperature');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('isImageCapError: compat "Unable to add image" is NOT an image-count cap (single image fails too)', () => {
  const e = new MtError('parse', 'AiError: AiError: Unable to add image when there are no user-supplied nor system-supplied messages. (uuid)', undefined);
  assert.equal(isImageCapError(e), false, 'the message is not a cap — the endpoint rejects this model\'s images entirely');
});


test('cfBody: explicit max_tokens, images as data-URL parts, no model field', () => {
  const b = cfBody('hi', ['QUJD'], null);
  assert.equal(b.max_tokens, 4096, 'native default is 256 — must be explicit');
  assert.equal(b.model, undefined, 'model lives in the URL');
  const content = b.messages[0].content;
  assert.deepEqual(content[0], { type: 'text', text: 'hi' });
  assert.deepEqual(content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } });
  assert.equal(cfBody('x').messages[0].content.length, 1, 'text-only request carries no image parts');
  assert.equal(cfBody('x', ['a'], 'low').reasoning_effort, 'low');
  assert.equal(cfBody('x', ['a'], 'none').reasoning_effort, undefined, 'CF rejects the literal "none" — omit it');
  assert.equal(cfBody('x', ['a'], null).reasoning_effort, undefined);
});

test('cfParse: result.response and result.choices both parse; usage maps', () => {
  assert.deepEqual(
    cfParse({ result: { response: 'abc', usage: { prompt_tokens: 7, completion_tokens: 3 } } }),
    { text: 'abc', usage: { inTok: 7, outTok: 3 } });
  assert.equal(cfParse({ result: { choices: [{ message: { content: 'def' } }] } }).text, 'def');
  assert.equal(cfParse({ result: {} }).text, '');
  assert.equal(cfParse(null).text, '');
});

test('cfError: errors[] → LlmHttpError (covers HTTP 200 + success:false) with providerCode', () => {
  assert.equal(cfError({ errors: [] }, 200), null);
  assert.equal(cfError(null, 200), null);
  const e = cfError({ errors: [{ message: 'Model Agreement: …agree…' }] }, 403);
  assert.ok(e instanceof LlmHttpError);
  assert.equal(e.status, 403);
  assert.equal(e.providerCode, undefined);
  assert.match(e.message, /agree/);
  const img = cfError({ errors: [{ message: 'AiError: Internal Server Error', code: 3030 }] }, 400);
  assert.equal(img.providerCode, 3030);
});

test('cfImageCapHint: only CF 3030 with 2+ images (no model-name table)', () => {
  assert.match(cfImageCapHint(3030, 3) ?? '', /OCR text/, 'multi-image rejection gets the actionable hint');
  assert.equal(cfImageCapHint(3030, 1), undefined, 'single-image request: 3030 is not a cap problem');
  assert.equal(cfImageCapHint(5001, 3), undefined, 'other codes stay unmapped');
  assert.equal(cfImageCapHint(undefined, 3), undefined);
});

// ---- split-OCR auto-detect: image-count vs image-support classification ----

test('isImageCapError: tagged CF cap, keyword caps, and NOT "cannot read images"', () => {
  // tagged by cloudflareChat (CF 3030 + 2+ images)
  assert.equal(isImageCapError(new MtError('parse', 'AiError: Internal Server Error', undefined, true)), true);
  // keyword shapes from OpenAI-compatible providers
  assert.equal(isImageCapError(new MtError('parse', 'You uploaded 5 images but this model supports a maximum of 1 image per request')), true);
  assert.equal(isImageCapError(new MtError('parse', 'too many images: this model accepts only one image per message')), true);
  // "cannot read images at all" must NOT route to per-region calls
  assert.equal(isImageCapError(new MtError('parse', 'this model does not support images', 'switch to Local OCR')), false);
  assert.equal(isImageCapError(new MtError('parse', 'invalid base64 in data URI at content[1]')), false);
  // unrelated / non-MtError
  assert.equal(isImageCapError(new MtError('auth', 'API key is wrong')), false);
  assert.equal(isImageCapError(new Error('image cap')), false);
  assert.equal(isImageCapError(undefined), false);
});

test('joinTranscription: multi-element answers join in order, keep/empty drop out', () => {
  assert.equal(joinTranscription('<r n="1">ネクスト</r>\n<r n="2">ヒロイン</r>\n<r n="3" keep="true"/>'),
    'ネクスト ヒロイン', 'line-splitting models keep every line');
  assert.equal(joinTranscription('<r n="1">I\'M SORRY!</r>'), 'I\'M SORRY!');
  assert.equal(joinTranscription('<r n="1" keep="true"/>'), '', 'keep-only → empty source');
});

test('joinTranscription: bare text (format drift) is used, not thrown away', () => {
  assert.equal(joinTranscription('CLEAR!.'), 'CLEAR!.', 'live: CF llama-3.2 drifts to bare text ~1/3 of the time');
  assert.equal(joinTranscription('I CLEARED IT WITH AN S RANK!\n\n(r n="1" keep="true")'),
    'I CLEARED IT WITH AN S RANK!', 'dangling keep tag line dropped');
  assert.equal(joinTranscription('```\nWOW!.\n```'), 'WOW!.', 'code fences stripped');
  assert.equal(joinTranscription('no readable text in this crop'), '', 'refusal prose stays empty');
  assert.equal(joinTranscription('(r n="1" keep="true")'), '', 'tag-only fallback → empty');
  assert.equal(joinTranscription('この画像は、ワインのブドウの画像です。'), '',
    'description of a text-less crop must not become a source (live-probed leak)');
  assert.equal(joinTranscription('<r n="1">この画像は、ワインのブドウの画像です。</r>'), '',
    'descriptions wrapped in the XML element are rejected too');
  assert.equal(joinTranscription('<r n="1">写真を撮ってよ</r>'), '写真を撮ってよ',
    'a real line that merely contains 写真 survives');
});

test('cfBody pins temperature 0 (CF default 0.6 drifts the XML format)', () => {
  assert.equal(cfBody('x', ['a']).temperature, 0);
  assert.equal(cfBody('x', ['a'], null, 0.3).temperature, 0.3, 'a user pin overrides the CF default');
});

test('transcribeOne prompt: one element, all lines joined, no multi-image wording', () => {
  const p = buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, { textOnly: true, transcribeOnly: true, transcribeOne: true, chars: false });
  assert.match(p, /single manga region/);
  assert.match(p, /Exactly one element/);
  assert.doesNotMatch(p, /following images/, 'no crop-list wording — the request carries one image');
  assert.doesNotMatch(p, /Translate the numbered/, 'pure transcription, no translation task');
});

// live: bracketed system message translated with brackets kept must render
// (box 7 on a strip: "[WELCOME...]" -> "[ยินดีต้อนรับ...]" was parsed as keep)
test('bracketed system message renders', () => {
  const r = parseResponse(
    '<r n="7" spk="system message" g="?">[ยินดีต้อนรับสู่ชุมชนรวมแห่งทวีป!]</r>', 7);
  assert.equal(r.regions[0].translation, '[ยินดีต้อนรับสู่ชุมชนรวมแห่งทวีป!]');
});

// ---- mentions: people named in dialogue/narration ----

test('parse XML: names block yields mentions; nameless m dropped, g normalized', () => {
  const r = parseResponse(
    '<r n="1" spk="boy" g="M">ยามาดะ หยุดเถอะนะ</r>\n' +
    '<names>\n' +
    '<m name="ยามาดะ" full="ยามาดะ ทาโร่" g="M">the boy being shouted at</m>\n' +
    '<m name="ซากุระ">a girl mentioned once</m>\n' +
    '<m g="F">no name merges with nothing</m>\n' +
    '</names>', 1);
  assert.equal(r.mentions.length, 2);
  assert.equal(r.mentions[0].name, 'ยามาดะ');
  assert.equal(r.mentions[0].fullName, 'ยามาดะ ทาโร่');
  assert.equal(r.mentions[0].gender, 'M');
  assert.equal(r.mentions[1].fullName, undefined);
  assert.equal(r.mentions[1].gender, '?');
});

test('updateContext: mention adds name + full name to the book', () => {
  const ctx = updateContext(EMPTY_CONTEXT, [],
    [{ name: 'ยามาดะ', fullName: 'ยามาดะ ทาโร่', gender: 'M', desc: 'the boy they shout at' }]).ctx;
  assert.equal(ctx.characters.length, 1);
  assert.equal(ctx.characters[0].name, 'ยามาดะ');
  assert.equal(ctx.characters[0].fullName, 'ยามาดะ ทาโร่');
  assert.equal(ctx.characters[0].source, 'mention');
});

test('mentions: token-subset names merge across pages ("ยามาดะ" ~ "ยามาดะ ทาโร่")', () => {
  let book = mergeCharacter([], { desc: 'a boy', gender: '?', name: 'ยามาดะ', source: 'mention' });
  book = mergeCharacter(book, { desc: 'a boy', gender: 'M', name: 'ยามาดะ ทาโร่', source: 'mention' });
  assert.equal(book.length, 1);
  assert.equal(book[0].gender, 'M'); // unknown upgraded from any source
  assert.equal(book[0].fullName, undefined); // obs had name only, no full
});

test('mentions: full name fills when stated; conflict keeps first', () => {
  let book = mergeCharacter([], { desc: 'a boy', gender: 'M', name: 'ยามาดะ', source: 'mention' });
  book = mergeCharacter(book, { desc: 'a boy', gender: 'M', name: 'ยามาดะ', fullName: 'ยามาดะ ทาโร่', source: 'vlm' });
  assert.equal(book[0].fullName, 'ยามาดะ ทาโร่');
  book = mergeCharacter(book, { desc: 'a boy', gender: 'M', name: 'ยามาดะ', fullName: 'ยามาดะ จิโร่', source: 'vlm' });
  assert.equal(book[0].fullName, 'ยามาดะ ทาโร่');
});

test('mentions: never override an established gender (priority 1)', () => {
  let book = mergeCharacter([], { desc: 'spiky boy', gender: 'F', source: 'vlm' });
  book = mergeCharacter(book, { desc: 'spiky boy', gender: 'M', source: 'mention' });
  assert.equal(book[0].gender, 'F');
});

test('mentions: speaker name and mention of the same person collapse', () => {
  const ctx = updateContext(EMPTY_CONTEXT,
    [{ index: 1, source: '', translation: 'ไปด้วยกันไหม', spk: { desc: 'boy with spiky hair', gender: 'M', name: 'ยามาดะ' } }],
    [{ name: 'ยามาดะ ทาโร่', gender: 'M', desc: 'addressed by name' }]).ctx;
  assert.equal(ctx.characters.length, 1);
  assert.equal(ctx.characters[0].name, 'ยามาดะ');
});

test('buildPrompt: known_characters shows full name once', () => {
  const p = buildPrompt([{ index: 1, source: '' }],
    { pairs: [], characters: [{ desc: 'a boy', gender: 'M', name: 'ยามาดะ', fullName: 'ยามาดะ ทาโร่', source: 'mention' }] },
    true, {});
  assert.match(p, /ยามาดะ \(ยามาดะ ทาโร่\):/);
});

// ---- useCharacters off: pairs-only context ----

test('buildPrompt chars=false: no spk request, no names block, no known_characters', () => {
  const p = buildPrompt([{ index: 1, source: '' }],
    { pairs: [['สวัสดี', 'hello']], characters: [{ desc: 'a boy', gender: 'M', name: 'ยามาดะ', source: 'mention' }] },
    true, { chars: false });
  assert.ok(!p.includes('spk='), 'must not request spk attrs');
  assert.ok(!p.includes('<names>'), 'must not request names block');
  assert.ok(!p.includes('<known_characters>'), 'must not send the book');
  assert.ok(!p.includes('Named people'), 'must not include the names rule');
  assert.ok(p.includes('<recent_translations>'), 'pairs still sent');
  assert.ok(p.includes('<r n="REGION">'), 'bare region element');
});

test('buildPrompt chars default: unchanged (spk + names + book)', () => {
  const p = buildPrompt([{ index: 1, source: '' }],
    { pairs: [], characters: [{ desc: 'a boy', gender: 'M', source: 'vlm' }] },
    true, {});
  assert.ok(p.includes('spk="who is speaking'), 'spk requested');
  assert.ok(p.includes('<names>'), 'names block requested');
  assert.ok(p.includes('<known_characters>'), 'book sent');
});

test('updateContext learn=false: pairs fold, spk + mentions dropped, old book untouched', () => {
  const old = [{ desc: 'a boy', gender: 'M', name: 'ยามาดะ', source: 'mention' }];
  const ctx = updateContext({ pairs: [], characters: old },
    [{ index: 1, source: 'สวัสดี', translation: 'hello', spk: { desc: 'a girl', gender: 'F' } }],
    [{ name: 'ซากุระ', gender: 'F', desc: 'mentioned' }],
    false).ctx;
  assert.deepEqual(ctx.pairs, [['สวัสดี', 'hello']]);
  assert.deepEqual(ctx.characters, old);
});

// ---- B: translation-only pairs (vision modes) + configurable depth ----

test('updateContext: sourceless outputs still fold pairs', () => {
  const { ctx } = updateContext(EMPTY_CONTEXT, [
    { index: 1, source: '', translation: 'นั่นมันภาพวาดอะไรกันเนี่ย!?' },
    { index: 2, source: '', translation: 'keep' },
  ]);
  assert.deepEqual(ctx.pairs, [['', 'นั่นมันภาพวาดอะไรกันเนี่ย!?']]);
});

test('buildPrompt: sourceless pairs render as (previous page)', () => {
  const p = buildPrompt([{ index: 1, source: '' }],
    { pairs: [['src', 'th'], ['', 'prev page line']], characters: [] }, true, {});
  assert.ok(p.includes('- src => th'), 'sourced pair keeps arrow form');
  assert.ok(p.includes('- (previous page) prev page line'), 'sourceless pair labelled');
  assert.ok(!p.includes('=> prev'), 'no dangling arrow');
});

test('maxPairs caps both fold and send', () => {
  const outs = [1, 2, 3].map(i => ({ index: i, source: `s${i}`, translation: `t${i}` }));
  const { ctx } = updateContext(EMPTY_CONTEXT, outs, [], true, 2);
  assert.equal(ctx.pairs.length, 2);
  assert.deepEqual(ctx.pairs[0], ['s2', 't2']);
  const p = buildPrompt([{ index: 1, source: '' }],
    { pairs: [['a', '1'], ['b', '2'], ['c', '3']], characters: [] }, true, { maxPairs: 1 });
  assert.ok(!p.includes('- a => 1') && p.includes('- c => 3'), 'only the newest pair sent');
});

// ---- C+: model-ordered book ops ----

test('parse <m>: sameAs/correct/now/why attrs', () => {
  const r = parseResponse(
    '<r n="1">x</r>\n<names>\n<m name="เอย์จิ" sameAs="คิริซาเมะ เอย์จิ">cop</m>\n' +
    '<m name="คุจินาชิ" correct="g" now="F" why="「私…かしら」">guest</m>\n</names>', 1);
  assert.equal(r.mentions[0].sameAs, 'คิริซาเมะ เอย์จิ');
  assert.equal(r.mentions[1].correct, 'g');
  assert.equal(r.mentions[1].now, 'F');
  assert.equal(r.mentions[1].why, '「私…かしら」');
});

test('sameAs merges two entries and logs the op', () => {
  const book = [
    { desc: '40-year-old cop', gender: 'M', name: 'เอย์จิ', fullName: 'คิริซาเมะ เอย์จิ', source: 'vlm' },
    { desc: 'เอย์จิ', gender: 'M', source: 'mention' },
  ];
  const { ctx, bookOps } = updateContext({ pairs: [], characters: book }, [],
    [{ name: 'เอย์จิ', gender: 'M', desc: 'cop', sameAs: 'คิริซาเมะ เอย์จิ' }]);
  assert.equal(ctx.characters.length, 1);
  assert.equal(ctx.characters[0].fullName, 'คิริซาเมะ เอย์จิ');
  assert.deepEqual(bookOps, [{ kind: 'merge', from: 'เอย์จิ', into: 'เอย์จิ' }]);
});

test('sameAs rejected: M/F clash, unknown target, user rows', () => {
  const book = [
    { desc: 'cop', gender: 'M', name: 'เอย์จิ', source: 'vlm' },
    { desc: 'girl', gender: 'F', name: 'สึคุเมะ', source: 'mention' },
    { desc: 'mine', gender: '?', name: 'บอส', source: 'user' },
    { desc: 'boss man', gender: 'M', name: 'หัวหน้า', source: 'vlm' },
  ];
  const { ctx, bookOps } = updateContext({ pairs: [], characters: book }, [], [
    { name: 'เอย์จิ', gender: 'M', desc: '', sameAs: 'สึคุเมะ' },       // clash
    { name: 'ผี', gender: '?', desc: '', sameAs: 'เอย์จิ' },            // unknown target
    { name: 'บอส', gender: 'M', desc: '', sameAs: 'หัวหน้า' },          // user row
  ]);
  assert.equal(bookOps.length, 0);
  assert.equal(ctx.characters.length, 5); // only the unknown 'ผี' is added; the rest matched existing entries
  assert.ok(ctx.characters.some(c => c.name === 'ผี' || c.desc === 'ผี'));
});

test('correct applies with quote; rejected without quote / on user rows / unknown field', () => {
  const book = [
    { desc: 'guest', gender: '?', name: 'คุจินาชิ', source: 'mention' },
    { desc: 'mine', gender: 'M', name: 'บอส', source: 'user' },
  ];
  const { ctx, bookOps } = updateContext({ pairs: [], characters: book }, [], [
    { name: 'คุจินาชิ', gender: 'F', desc: '', correct: 'g', now: 'F', why: '「私…かしら」' },
    { name: 'คุจินาชิ', gender: '?', desc: '', correct: 'g', now: 'M' },          // no quote
    { name: 'บอส', gender: 'F', desc: '', correct: 'gender', now: 'F', why: 'x' }, // user row
    { name: 'คุจินาชิ', gender: '?', desc: '', correct: 'age', now: '20', why: 'x' }, // unknown field
  ]);
  assert.equal(ctx.characters.find(c => c.name === 'คุจินาชิ').gender, 'F');
  assert.equal(ctx.characters.find(c => c.name === 'บอส').gender, 'M');
  assert.deepEqual(bookOps, [{ kind: 'correct', from: 'คุจินาชิ', field: 'gender', was: '?', now: 'F' }]);
});

test('mergeCharacter: sourceless spk name matches a real name (deterministic C)', () => {
  const book = mergeCharacter(
    [{ desc: '40-year-old cop', gender: 'M', name: 'เอย์จิ', source: 'vlm' }],
    { desc: 'เอย์จิ', gender: 'M', source: 'mention' });
  assert.equal(book.length, 1);
  assert.equal(book[0].name, 'เอย์จิ');
});

test('buildPrompt: names block documents sameAs/correct', () => {
  const p = buildPrompt([{ index: 1, source: '' }], { pairs: [], characters: [] }, true, {});
  assert.ok(p.includes('sameAs'), 'merge op documented');
  assert.ok(p.includes('confirmed by user'), 'user rows off-limits in the contract');
});

test('parse <r>: src attr captured as source', () => {
  const r = parseResponse('<r n="1" src="一緒に来て">ไปด้วยกัน</r>\n<r n="2" keep="true"/>', 2);
  assert.equal(r.regions[0].source, '一緒に来て');
  assert.equal(r.regions[0].translation, 'ไปด้วยกัน');
});

test('buildPrompt transcribeSrc: src requested + verbatim rule, ocr exempt, default off', () => {
  const p = buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, { transcribeSrc: true });
  assert.ok(p.includes('src="this region\'s original text'), 'element requests src');
  assert.ok(p.includes('Transcribe first'), 'verbatim rule present');
  const po = buildPrompt([{ index: 1, source: 'x' }], EMPTY_CONTEXT, false, { transcribeSrc: true, ocr: true });
  assert.ok(!po.includes('Transcribe first') && !po.includes('src="this region'), 'ocr mode exempt');
  const pn = buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, {});
  assert.ok(!pn.includes('src="this region'), 'default off');
});

test('buildPrompt transcribeOnly: transcribe task, no translate/book/pairs', () => {
  const p = buildPrompt([{ index: 1, source: '' }, { index: 2, source: '' }], EMPTY_CONTEXT, true, { transcribeOnly: true, chars: false });
  assert.ok(p.includes('Transcribe the text'), 'transcribe task');
  assert.ok(!p.includes('Translate the numbered'), 'no translate task');
  assert.ok(p.includes('Do NOT translate') || p.includes('Never translate'), 'never-translate rule');
  assert.ok(p.includes('sound-effect'), 'SFX transcribed, not kept');
  assert.ok(!p.includes('<names>') && !p.includes('known_characters') && !p.includes('recent_translations'), 'no book/pairs');
  const pc = buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, { transcribeOnly: true, chars: false, textOnly: true });
  assert.ok(pc.includes('There is no full-page image'), 'crops-only variant');
  // same XML shape: translation field carries the transcription
  const r = parseResponse('<r n="1">一緒に来て</r>\n<r n="2" keep="true"/>', 2);
  assert.equal(r.regions[0].translation, '一緒に来て');
  assert.equal(r.regions[1].translation, 'keep');
});

test('transcriptionMatches: whitespace-blind, case-strict, empty-expected never matches', () => {
  assert.ok(transcriptionMatches('The quick brown fox', 'The quick brown fox'));
  assert.ok(transcriptionMatches('The quick\nbrown   fox ', ' The quick brown fox'));
  assert.ok(!transcriptionMatches('the quick brown fox', 'The quick brown fox'));
  assert.ok(!transcriptionMatches('The quick brown cat', 'The quick brown fox'));
  assert.ok(!transcriptionMatches('', ''));
  assert.ok(!transcriptionMatches('anything', ''));
});

test('langOk: real tessdata codes pass, URL-steering values fail', () => {
  for (const l of ['jpn', 'eng', 'chi_sim', 'chi_tra', 'kor', 'vie']) assert.equal(langOk(l), true);
  for (const l of ['../osui', 'jpn/../../x', 'a@evil.com', 'JPN', '', 'javascript:alert(1)', 'a'.repeat(20)]) {
    assert.equal(langOk(l), false, `expected reject: ${l}`);
  }
});

test('fetchWithProgress: retries transient failures, then succeeds', async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    if (++calls < 3) throw new Error('Error in input stream');
    return { ok: true, headers: { get: () => '3' }, async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; } };
  };
  try {
    const buf = await fetchWithProgress('https://example.com/x');
    assert.equal(calls, 3);
    assert.deepEqual([...new Uint8Array(buf)], [1, 2, 3]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchWithProgress: throws after 3 attempts', async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('boom'); };
  try {
    await assert.rejects(fetchWithProgress('https://example.com/x'), /boom/);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

const ADOPT_REQ = {
  cacheKey: 'manga-1', imagesB64: ['aGVsbG8='],
  regions: [{ index: 1, source: 'Hello' }],
  context: { pairs: [['a', 'b']], characters: [] },
  vision: false, textOnly: true, ocr: true, split: false, pageW: 100, pageH: 100,
};
const ADOPT_ST = {
  provider: 'openai', model: 'm', baseUrl: '', ocrModel: '',
  thinkingLevel: 'low', ocrThinking: 'none',
  temperature: null,
  useOcrModel: false, stylePrompt: '', targetLang: 'Thai',
  useCharacters: true, contextPairs: 40, transcribeSrc: false, vlmAssisted: false,
};

test('translateRequestId: stable 64-hex, sensitive to every output-shaping input', async () => {
  const id = await translateRequestId(translateRequestParts(ADOPT_REQ, ADOPT_ST));
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(await translateRequestId(translateRequestParts(ADOPT_REQ, ADOPT_ST)), id);
  // each of these changes what the model returns → must re-key (fresh call, never a wrong share)
  const variants = [
    [{ ...ADOPT_REQ, imagesB64: ['d29ybGQ='] }, ADOPT_ST, 'pixels'],
    [{ ...ADOPT_REQ, regions: [{ index: 1, source: 'Bye' }] }, ADOPT_ST, 'regions'],
    [{ ...ADOPT_REQ, context: { pairs: [], characters: [] } }, ADOPT_ST, 'context'],
    [{ ...ADOPT_REQ, cacheKey: 'manga-2' }, ADOPT_ST, 'manga scope'],
    [ADOPT_REQ, { ...ADOPT_ST, model: 'm2' }, 'model'],
    [ADOPT_REQ, { ...ADOPT_ST, thinkingLevel: 'high' }, 'thinking'],
    [ADOPT_REQ, { ...ADOPT_ST, temperature: 0.3 }, 'temperature'],
    [ADOPT_REQ, { ...ADOPT_ST, targetLang: 'English' }, 'target lang'],
    [ADOPT_REQ, { ...ADOPT_ST, useCharacters: false }, 'chars flag'],
    [{ ...ADOPT_REQ, split: true }, ADOPT_ST, 'split mode'],
  ];
  for (const [r, s, why] of variants) {
    assert.notEqual(await translateRequestId(translateRequestParts(r, s)), id, `must re-key on ${why}`);
  }
});
