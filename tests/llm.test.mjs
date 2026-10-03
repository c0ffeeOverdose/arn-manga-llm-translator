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

const { buildPrompt, parseResponse, mergeRegions, mergeCharacter, updateContext, applyBookOps, EMPTY_CONTEXT, splitUserForCache, normalizeBook, transcriptionMatches, joinTranscription, coalesceBook, charKey, mergeBookRows, splitBookRow, claimLegacyOverrides, overrideKey, bareKey, moveOverrides } =
  await import(new URL('../.test-build/core.mjs', import.meta.url).href);
const { toMtError, LlmHttpError, MtError, translateRequestParts, translateRequestId, callLLM, cfRunUrl, cfBody, cfParse, cfError, cfImageCapHint, isImageCapError, sessionKey } =
  await import(new URL('../.test-build/adapters.mjs', import.meta.url).href);

// buildPrompt returns {system, user} (rules vs page data); tests assert against both as one text.
const all = (p) => p.system + '\n' + p.user;
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

test('system/user split: rules live in system, page data in user; two pages share one system', () => {
  const p = buildPrompt([{ index: 1, source: 'こんにちは' }], EMPTY_CONTEXT, false, { ocr: true });
  const s = p.system;
  assert.ok(s.includes('<rules>'));
  assert.ok(!s.includes('<regions>'), 'regions never ride the cached system block');
  assert.ok(!s.includes('こんにちは'), 'page text never rides the cached system block');
  assert.ok(p.user.startsWith('<regions>'), 'user ends with the page data');
  assert.ok(p.user.includes('こんにちは'));
  // two pages of the same manga share the same system block (cacheable), user differs
  const q = buildPrompt([{ index: 1, source: 'ちがう台詞' }], EMPTY_CONTEXT, false, { ocr: true });
  assert.equal(q.system, s);
  assert.notEqual(q.user, p.user);
});

test('splitUserForCache: head ends at the book, tail is the volatile remainder; null without a book', () => {
  const p = buildPrompt([{ index: 1, source: '' }],
    { pairs: [['a', 'b']], characters: [{ desc: 'hero girl', gender: 'F', source: 'vlm' }] }, true, {});
  const seg = splitUserForCache(p.user);
  assert.ok(seg, 'book block exists');
  assert.ok(seg.head.endsWith('</known_characters>'), 'head carries exactly the book');
  assert.ok(seg.tail.includes('<recent_translations>') && seg.tail.includes('<regions>'));
  const noBook = buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, {});
  assert.equal(splitUserForCache(noBook.user), null);
});

test('text-only vision mode: crops-only images section + no-guess spk rule; extras rule dropped', () => {
  const p = all(buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, {
    textOnly: true, vlmAssisted: true, pageW: 907, pageH: 1280,
  }));
  assert.ok(p.includes('There is no full-page image'));
  assert.ok(p.includes('omit spk and g rather than guess'));
  assert.ok(!p.includes('<extra'));
  // page mode keeps the full-page wording and (when asked) the extras rule
  const q = all(buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, {
    vlmAssisted: true, pageW: 907, pageH: 1280,
  }));
  assert.ok(q.includes('full page with red number badges'));
  assert.ok(q.includes('<extra'));
});

test('merged page request: every full page is named, badges stay global, speaker rule follows', () => {
  const p = all(buildPrompt([{ index: 1, source: '' }, { index: 2, source: '' }], EMPTY_CONTEXT, true, {
    pageCount: 3, chars: true,
  }));
  assert.ok(p.includes('The first 3 images are full pages with red number badges'));
  assert.ok(p.includes('a badge number is that region\'s number in the list below'));
  assert.ok(p.includes('use the full pages for context'));
  assert.ok(p.includes('decide each region from the full pages, never from the crop alone'));
  assert.ok(p.includes('THE TAIL DECIDES'));
  // single-page wording is untouched (cacheable prompt stability)
  const one = all(buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, { chars: true }));
  assert.ok(one.includes('First image = full page with red number badges'));
  assert.ok(one.includes('decide each region from the full page, never from the crop alone'));
  assert.ok(!one.includes('full pages'));
});

test('OCR mode: no images section, source text inline, SFX + no-guess rules', () => {
  const p = all(buildPrompt(
    [{ index: 1, source: 'こんにちは、先輩！' }, { index: 2, source: 'ドン' }],
    EMPTY_CONTEXT, false, { ocr: true },
  ));
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
  const t = all(p);
  assert.ok(t.includes('honorifics'));
  assert.ok(t.includes('hero girl'));
  assert.ok(t.includes('こんにちは'));
  // no char-budget hints anywhere: numeric anchors shorten translations even
  // next to "translate fully" — the renderer fits whatever comes back
  assert.ok(!t.includes('box fits'));
  assert.ok(!t.includes('auto-shrunk'));
  assert.ok(!/\d+ chars/.test(t));
  // completeness rule — the anti-elision fix
  assert.ok(t.includes('never drop the subject, tense/aspect, or emphasis'));
  assert.ok(t.includes('สวัสดี'));
  // XML output format with the keep form as a distinct structural element
  assert.ok(t.includes('<r n="REGION" keep="true"/>'));
  assert.ok(t.includes('<r n="1" spk="c1" g="F">ไปด้วยกันไหมคะ</r>'), 'example pairs g=F with คะ');
  assert.ok(t.includes('g="M" name="ยามาดะ">ยามาดะ หยุดเถอะครับ</r>'), 'example pairs g=M with ครับ');
  // the book is canonical and referenced by id
  assert.ok(t.includes('<c id="c1" g="F">(unnamed) hero girl</c>'), 'compact roster row');
});

test('style prompt appended as a rule; absent when empty', () => {
  const regions = [{ index: 1, source: '' }];
  const withStyle = all(buildPrompt(regions, EMPTY_CONTEXT, true, { stylePrompt: 'Casual tone — drop polite endings' }));
  assert.ok(withStyle.includes('Style (applies to every region): Casual tone'));
  const noStyle = all(buildPrompt(regions, EMPTY_CONTEXT, true, { stylePrompt: '   ' }));
  assert.ok(!noStyle.includes('Style'));
});

test('named character marked as canonical in the book section', () => {
  const p = all(buildPrompt(
    [{ index: 1, source: '' }],
    { pairs: [], characters: [{ desc: 'spiky guy', gender: 'M', source: 'user', name: 'Kirisame' }] },
    true,
  ));
  assert.ok(p.includes('<c id="c1" g="M" u="1">Kirisame — spiky guy</c>'), 'user row carries the confirmed marker');
  assert.ok(p.includes('use its exact names and spellings'), 'canonical rule present');
});

test('target language parameterizes the prompt; Thai keeps particle rule, others get the generic rule', () => {
  const regions = [{ index: 1, source: '' }];
  const th = all(buildPrompt(regions, EMPTY_CONTEXT, true, { targetLang: 'Thai' }));
  assert.ok(th.includes('into Thai'));
  assert.ok(th.includes('ครับ/ค่ะ/คะ'));
  assert.ok(th.includes('Thai translation</r>'));

  const en = all(buildPrompt(regions, EMPTY_CONTEXT, true, { targetLang: 'English' }));
  assert.ok(en.includes('into English'));
  assert.ok(en.includes('English translation</r>'));
  assert.ok(!en.includes('ครับ/ค่ะ/คะ'));
  assert.ok(en.includes('gendered speech forms'));

  // default (no targetLang) = Thai
  const dflt = all(buildPrompt(regions, EMPTY_CONTEXT, true));
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

// ---- overrides are scoped per book (2026-10-03) ----

test('overrides are scoped per book; another book cannot leak in', () => {
  const ctx = { pairs: [], characters: [{ id: 'c1', desc: 'hero girl', gender: '?', source: 'vlm' }] };
  const ov = {
    [overrideKey('mtBook:A', 'c1')]: { gender: 'F', name: 'เรื่อง A' },
    [overrideKey('mtBook:B', 'c1')]: { gender: 'M', name: 'เรื่อง B' },
  };
  assert.equal(applyOverrides(ctx, ov, 'mtBook:A').characters[0].name, 'เรื่อง A');
  assert.equal(applyOverrides(ctx, ov, 'mtBook:B').characters[0].name, 'เรื่อง B');
  assert.equal(applyOverrides(ctx, ov, 'mtBook:C').characters[0].name, undefined, 'other books stay clean');
  assert.equal(applyOverrides(ctx, ov).characters[0].source, 'vlm', 'no scope = legacy keys only');
  assert.equal(bareKey(overrideKey('mtBook:A', 'หญิงผมสั้น')), 'หญิงผมสั้น');
});

test('legacy bare overrides still apply; a stale scoped id adds no row', () => {
  const ctx = { pairs: [], characters: [{ id: 'c1', desc: 'hero girl', gender: '?', source: 'vlm' }] };
  assert.equal(applyOverrides(ctx, { c1: { gender: 'F' } }, 'mtBook:A').characters[0].gender, 'F');
  const out = applyOverrides(EMPTY_CONTEXT, { [overrideKey('mtBook:A', 'c9')]: { gender: 'M', name: 'ผี' } }, 'mtBook:A');
  assert.equal(out.characters.length, 0, 'a scoped id for a missing row is not a new character');
});

test('claimLegacyOverrides pins a bare key to the book showing the row', () => {
  const { overrides, changed } = claimLegacyOverrides({ c1: { gender: 'F', name: 'อากิ' }, c9: { gender: 'M' } }, 'mtBook:A', ['c1']);
  assert.equal(changed, true);
  assert.ok(overrides[overrideKey('mtBook:A', 'c1')], 'row key claimed');
  assert.ok(!overrides.c1, 'bare key removed');
  assert.ok(overrides.c9, 'unrelated bare keys stay for their own book');
});

test('moveOverrides: a chapter book promoted to a story book keeps its edits', () => {
  const { overrides, changed } = moveOverrides(
    { [overrideKey('mtCtx:https://reader.test/series/abc/chapter/1', 'c1')]: { gender: 'F', name: 'อากิ' }, c9: { gender: 'M' } },
    'mtCtx:https://reader.test/series/abc/chapter/1',
    'mtBook:https://reader.test/series/abc',
  );
  assert.equal(changed, true);
  assert.equal(overrides[overrideKey('mtBook:https://reader.test/series/abc', 'c1')]?.name, 'อากิ');
  assert.ok(!overrides[overrideKey('mtCtx:https://reader.test/series/abc/chapter/1', 'c1')], 'old scope cleared');
  assert.ok(overrides.c9, 'other keys untouched');
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

test('dispatch: the OpenAI provider never reroutes — a Cloudflare base still posts to chat/completions', async () => {
  // provider choice is explicit: users pick "Cloudflare Workers AI" for the
  // native run endpoint; the OpenAI slot must not secretly switch endpoints
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return {
      ok: true, status: 200,
      async text() { return JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }); },
    };
  };
  const s = { provider: 'openai', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1', model: '@cf/meta/llama-3.2-11b-vision-instruct', apiKey: 'k' };
  try {
    await callLLM(s, 'p', ['QUJD']);
    assert.equal(seen[0].url, 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/chat/completions');
    assert.equal(seen[0].body.model, s.model);
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

test('callLLM: a rejected temperature is retried without it and reported (tempDropped)', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false, status: 400,
        async text() { return JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0 with this model" } }); },
      };
    }
    return {
      ok: true, status: 200,
      async text() { return JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }); },
    };
  };
  try {
    const r = await callLLM({ provider: 'openai', baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' }, 'p', undefined, 'auto', undefined, 0.25);
    assert.equal(calls, 2, 'rejected request + clean retry');
    assert.equal(r.text, 'ok');
    assert.equal(r.tempDropped, true, 'the caller can memoize the rejection');
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }); } };
    };
    const r2 = await callLLM({ provider: 'openai', baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' }, 'p', undefined, 'auto', undefined, 0.25);
    assert.equal(calls, 1);
    assert.equal(r2.tempDropped, undefined, 'accepted temperature reports nothing');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('maxTokens: transcribe caps reach every protocol, default stays 4096', async () => {
  assert.equal(cfBody('x', ['a']).max_tokens, 4096);
  assert.equal(cfBody('x', ['a'], null, 0, 512).max_tokens, 512);
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers ?? {} });
    return {
      ok: true, status: 200,
      async text() {
        if (String(url).includes('/v1/messages')) return JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: {} });
        if (String(url).includes(':generateContent')) return JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
        if (String(url).includes('/responses')) return JSON.stringify({ output: [], usage: {} });
        if (String(url).includes('/ai/run/')) return JSON.stringify({ result: { response: 'ok', usage: {} }, success: true });
        return JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} });
      },
    };
  };
  try {
    await callLLM({ provider: 'openai', baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' }, 'p', ['QUJD'], 'auto', undefined, null, 512);
    assert.equal(seen.at(-1).body.max_tokens, 512);
    await callLLM({ provider: 'cloudflare', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/a/ai', model: '@cf/meta/x', apiKey: 'k' }, 'p', ['QUJD'], 'auto', 'manga-7', null, 512);
    assert.match(seen.at(-1).url, /\/ai\/run\//);
    assert.equal(seen.at(-1).body.max_tokens, 512);
    assert.equal(seen.at(-1).headers['x-session-affinity'], 'manga-7', 'prefix-cache affinity rides the conversation key');
    await callLLM({ provider: 'anthropic', baseUrl: 'https://a.test', model: 'm', apiKey: 'k' }, 'p', undefined, 'auto', undefined, null, 512);
    assert.equal(seen.at(-1).body.max_tokens, 512);
    await callLLM({ provider: 'gemini', baseUrl: 'https://g.test/v1beta', model: 'm', apiKey: 'k' }, 'p', undefined, 'auto', undefined, null, 512);
    assert.equal(seen.at(-1).body.generationConfig.maxOutputTokens, 512);
    await callLLM({ provider: 'responses', baseUrl: 'https://r.test/v1', model: 'm', apiKey: 'k' }, 'p', undefined, 'auto', undefined, null, 512);
    assert.equal(seen.at(-1).body.max_output_tokens, 512);
    await callLLM({ provider: 'openai', baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' }, 'p');
    assert.equal(seen.at(-1).body.max_tokens, 4096, 'no cap passed = previous default');
    assert.equal(seen.at(-1).headers['x-session-affinity'], undefined, 'affinity is a CF-only header');
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

test('cfParse: result.response and result.choices both parse; usage + cached tokens map', () => {
  assert.deepEqual(
    cfParse({ result: { response: 'abc', usage: { prompt_tokens: 7, completion_tokens: 3 } } }),
    { text: 'abc', finishReason: undefined, usage: { inTok: 7, outTok: 3, cachedInTok: undefined, reasonTok: undefined } });
  assert.equal(cfParse({ result: { choices: [{ message: { content: 'def' } }] } }).text, 'def');
  assert.equal(cfParse({ result: {} }).text, '');
  assert.equal(cfParse(null).text, '');
  // Workers AI surfaces prefix-cache hits here; the dump's cachedInTok reads it
  const hit = cfParse({ result: { response: 'x', usage: { prompt_tokens: 2000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 1536 } } } });
  assert.equal(hit.usage.cachedInTok, 1536);
  // a starved reasoning reply names itself: finish_reason + reasoning token count
  const starved = cfParse({ result: { choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } } } });
  assert.equal(starved.finishReason, 'length');
  assert.equal(starved.usage.reasonTok, 4096);
});

test('callLLM surfaces finishReason + reasoning tokens (a 200 with no content names its cause)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    async text() {
      return JSON.stringify({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 4768, completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } },
      });
    },
  });
  try {
    const r = await callLLM({ provider: 'openai', baseUrl: 'https://fin-reason.test/v1', model: 'm', apiKey: 'k' }, 'p');
    assert.equal(r.text, '');
    assert.equal(r.finishReason, 'length');
    assert.equal(r.usage.reasonTok, 4096);
  } finally {
    globalThis.fetch = realFetch;
  }
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
  const p = all(buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, { textOnly: true, transcribeOnly: true, transcribeOne: true, chars: false }));
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
  const p = all(buildPrompt([{ index: 1, source: '' }],
    { pairs: [], characters: [{ desc: 'a boy', gender: 'M', name: 'ยามาดะ', fullName: 'ยามาดะ ทาโร่', source: 'mention' }] },
    true, {}));
  assert.match(p, /<c id="c1" g="M">ยามาดะ \(ยามาดะ ทาโร่\) — a boy<\/c>/);
});

// ---- useCharacters off: pairs-only context ----

test('buildPrompt chars=false: no spk request, no names block, no known_characters', () => {
  const p = all(buildPrompt([{ index: 1, source: '' }],
    { pairs: [['สวัสดี', 'hello']], characters: [{ desc: 'a boy', gender: 'M', name: 'ยามาดะ', source: 'mention' }] },
    true, { chars: false }));
  assert.ok(!p.includes('spk='), 'must not request spk attrs');
  assert.ok(!p.includes('<names>'), 'must not request names block');
  assert.ok(!p.includes('<known_characters>'), 'must not send the book');
  assert.ok(!p.includes('Named people'), 'must not include the names rule');
  assert.ok(p.includes('<recent_translations>'), 'pairs still sent');
  assert.ok(p.includes('<r n="REGION">'), 'bare region element');
});

test('buildPrompt chars default: unchanged (spk + names + book)', () => {
  const p = all(buildPrompt([{ index: 1, source: '' }],
    { pairs: [], characters: [{ desc: 'a boy', gender: 'M', source: 'vlm' }] },
    true, {}));
  assert.ok(p.includes('spk="c1|new"'), 'id-based spk requested');
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

// ---- book hygiene: box-type labels, honorific dedupe, eviction order ----

test('book hygiene: box-type spk labels are never learned', () => {
  const ctx = updateContext(EMPTY_CONTEXT, [
    { index: 1, source: '', translation: 'ห้องนั่งเล่น', spk: { desc: 'ป้าย', gender: '?' } },
    { index: 2, source: '', translation: '...และแล้ว', spk: { desc: 'narration', gender: 'M' } },
    { index: 3, source: '', translation: 'ไปด้วยกันไหม', spk: { desc: 'boy with spiky hair', gender: 'M' } },
  ]).ctx;
  assert.equal(ctx.characters.length, 1, 'only the real speaker enters the book');
  assert.equal(ctx.characters[0].desc, 'boy with spiky hair');
});

test('book hygiene: box-type mentions never enter the book', () => {
  const ctx = updateContext(EMPTY_CONTEXT, [], [
    { name: 'sign', gender: '?', desc: 'the room label' },
    { name: 'ซากุระ', gender: 'F', desc: 'mentioned once' },
  ]).ctx;
  assert.equal(ctx.characters.length, 1);
  assert.equal(ctx.characters[0].name, 'ซากุระ');
});

test('book hygiene: applyBookOps ignores label mentions even with ops attached', () => {
  const book = [{ desc: 'hero girl', gender: 'F', name: 'ยามาดะ', source: 'vlm' }];
  const { characters, ops } = applyBookOps(book, [{ name: 'narration', sameAs: 'ยามาดะ', gender: 'M', desc: 'x' }]);
  assert.equal(ops.length, 0);
  assert.deepEqual(characters, book);
});

test('book hygiene: polluted label rows are not sent; user rows survive the filter', () => {
  const p = buildPrompt([{ index: 1, source: '' }],
    { pairs: [], characters: [
      { desc: 'narration', gender: 'M', source: 'vlm' },
      { desc: 'sign', gender: '?', source: 'user' },
      { desc: 'hero girl', gender: 'F', name: 'ยามาดะ', source: 'vlm' },
    ] }, true, {});
  const roster = p.user.slice(p.user.indexOf('<known_characters>'), p.user.indexOf('</known_characters>'));
  assert.ok(roster.includes('hero girl'), 'real character sent');
  assert.ok(!roster.includes('narration'), 'learned label row not sent');
  assert.ok(roster.includes('sign'), "user-added row is the user's call");
});

test('book hygiene: honorific forms of one name merge (คุจินาชิคุง / ฮิมุโระ-ซัง / Kuchinashi-kun)', () => {
  let book = mergeCharacter([], { desc: 'a', gender: 'F', name: 'ฮิมุโระ', source: 'vlm' });
  book = mergeCharacter(book, { desc: 'b', gender: '?', name: 'ฮิมุโระ-ซัง', source: 'vlm' });
  assert.equal(book.length, 1, 'Thai honorific suffix is not a new person');
  let en = mergeCharacter([], { desc: 'c', gender: 'M', name: 'Kuchinashi', source: 'vlm' });
  en = mergeCharacter(en, { desc: 'd', gender: '?', name: 'Kuchinashi-kun', source: 'vlm' });
  assert.equal(en.length, 1, 'romaji honorific suffix is not a new person');
});

test('book hygiene: cap evicts the oldest low-priority row — the new character stays', () => {
  let book = [];
  for (let i = 0; i < 10; i++) book = mergeCharacter(book, { desc: `alpha${i}`, gender: '?', source: 'speech' });
  assert.equal(book.length, 10);
  book = mergeCharacter(book, { desc: 'brand new person', gender: 'F', source: 'vlm' });
  assert.equal(book.length, 10);
  assert.ok(book.some(c => c.desc === 'brand new person'), 'the new row survives');
  assert.ok(!book.some(c => c.desc === 'alpha0'), 'the oldest row was evicted');
  // user rows are never the victim
  let u = [{ desc: 'the user entry', gender: 'F', source: 'user' }];
  for (let i = 0; i < 10; i++) u = mergeCharacter(u, { desc: `beta${i}`, gender: '?', source: 'vlm' });
  assert.ok(u.some(c => c.source === 'user'), 'user row protected');
});

test('buildPrompt: box-type spk rule + credits rule ride the prompt', () => {
  const p = all(buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, {}));
  assert.ok(p.includes('not a person speaking'), 'speaker-only rule present');
  assert.ok(p.includes('Credits, bylines'), 'credits rule present');
});

// ---- session id hashing: the reader URL must not reach a provider field ----

test('sessionKey: opaque base36, no URL characters, deterministic', () => {
  const raw = 'https://reader.test/chapter/abc?token=secret';
  const k = sessionKey(raw);
  assert.match(k, /^[0-9a-z]{8,16}$/, 'short base36 id');
  assert.equal(k, sessionKey(raw), 'deterministic');
  assert.ok(!/[\/:?&=]/.test(k), 'no URL characters survive');
  assert.notEqual(k, sessionKey('https://reader.test/chapter/abc?token=other'));
});

test('sessionKey: per-install salt changes the id, same salt keeps it', () => {
  const raw = 'https://reader.test/chapter/abc';
  assert.equal(sessionKey(raw, 7), sessionKey(raw, 7));
  assert.notEqual(sessionKey(raw, 7), sessionKey(raw, 8));
  assert.notEqual(sessionKey(raw, 0), sessionKey(raw, 1), 'salt participates in the digest');
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
  const p = all(buildPrompt([{ index: 1, source: '' }],
    { pairs: [['src', 'th'], ['', 'prev page line']], characters: [] }, true, {}));
  assert.ok(p.includes('- src => th'), 'sourced pair keeps arrow form');
  assert.ok(p.includes('- (previous page) prev page line'), 'sourceless pair labelled');
  assert.ok(!p.includes('=> prev'), 'no dangling arrow');
});

// ---- speaker tags on recent lines (2026-10-03) ----

test('updateContext: recent lines carry the resolved speaker id', () => {
  const { ctx } = updateContext(EMPTY_CONTEXT, [
    { index: 1, source: 'A', translation: 'หนึ่ง', spk: { desc: 'girl with red ribbon', gender: 'F', name: 'อากิ' } },
    { index: 2, source: 'B', translation: 'สอง', spk: null },
  ]);
  assert.equal(ctx.pairs[0][2], 'c1', 'a row born in this call is tagged');
  assert.equal(ctx.pairs[1].length, 2, 'narration gets no tag');
  // a later spk="new" that folds into the same row resolves to the same id
  const { ctx: next } = updateContext(ctx, [
    { index: 1, source: 'C', translation: 'สาม', spk: { desc: 'red ribbon girl', gender: 'F' } },
  ]);
  assert.equal(next.characters.length, 1, 'the anchors folded');
  assert.equal(next.pairs.at(-1)[2], 'c1');
  // an id echoed straight back stays the tag
  const { ctx: byId } = updateContext(next, [
    { index: 1, source: 'D', translation: 'สี่', spk: { id: 'c1', desc: '', gender: 'F' } },
  ]);
  assert.equal(byId.pairs.at(-1)[2], 'c1');
});

test('buildPrompt: recent translations tag the speaker id; dead ids and chars-off get none', () => {
  const characters = [{ id: 'c1', desc: 'girl', gender: 'F', source: 'vlm' }];
  const p = buildPrompt([{ index: 1, source: '' }],
    { pairs: [['A', 'หนึ่ง', 'c1'], ['B', 'สอง', 'c9'], ['', 'prev', 'c1']], characters }, true, {});
  assert.ok(p.user.includes('- [c1] A => หนึ่ง'), 'live id tagged');
  assert.ok(p.user.includes('- B => สอง'), 'dead id renders untagged');
  assert.ok(p.user.includes('- [c1] (previous page) prev'), 'sourceless pair keeps its tag');
  const off = buildPrompt([{ index: 1, source: '' }],
    { pairs: [['A', 'หนึ่ง', 'c1']], characters }, true, { chars: false });
  assert.ok(!off.user.includes('[c1]'), 'no tags when the character channel is off');
});

test('buildPrompt: page mode explains balloon shapes; crops mode stays crops-only', () => {
  const page = all(buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, {}));
  assert.ok(page.includes('The balloon tail is the primary cue'), 'tail rule present');
  assert.ok(page.includes('THE TAIL DECIDES'), 'tail outranks other cues');
  assert.ok(page.includes('thought cloud'), 'thought-cloud rule present');
  const crops = all(buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, { textOnly: true }));
  assert.ok(crops.includes('You see ONLY text crops'), 'crops mode keeps its own rule');
  assert.ok(!crops.includes('THE TAIL DECIDES'), 'no page-shape advice without the page');
});

test('buildPrompt: crops and OCR modes still tag recent lines', () => {
  // The tag is text, not artwork: it is the only cross-page continuity signal these modes have,
  // so it must render exactly like in page mode.
  const characters = [{ id: 'c1', desc: 'girl', gender: 'F', source: 'vlm' }];
  const pairs = [['A', 'หนึ่ง', 'c1'], ['B', 'สอง']];
  const crops = buildPrompt([{ index: 1, source: '' }], { pairs, characters }, true, { textOnly: true });
  assert.ok(crops.user.includes('- [c1] A => หนึ่ง'));
  assert.ok(crops.user.includes('- B => สอง'));
  const ocr = buildPrompt([{ index: 1, source: '' }], { pairs, characters }, true, { ocr: true });
  assert.ok(ocr.user.includes('- [c1] A => หนึ่ง'));
});

test('maxPairs caps both fold and send', () => {
  const outs = [1, 2, 3].map(i => ({ index: i, source: `s${i}`, translation: `t${i}` }));
  const { ctx } = updateContext(EMPTY_CONTEXT, outs, [], true, 2);
  assert.equal(ctx.pairs.length, 2);
  assert.deepEqual(ctx.pairs[0], ['s2', 't2']);
  const p = all(buildPrompt([{ index: 1, source: '' }],
    { pairs: [['a', '1'], ['b', '2'], ['c', '3']], characters: [] }, true, { maxPairs: 1 }));
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
  // not string-matchable (a nickname the model resolved), so only the op can merge them
  const book = [
    { desc: '40-year-old cop', gender: 'M', name: 'คิริซาเมะ', fullName: 'คิริซาเมะ เอย์จิ', source: 'vlm' },
    { desc: 'the scarred man', gender: 'M', name: 'เอย์จิ', source: 'mention' },
  ];
  const { ctx, bookOps } = updateContext({ pairs: [], characters: book }, [],
    [{ name: 'เอย์จิ', gender: 'M', desc: 'cop', sameAs: 'คิริซาเมะ' }]);
  assert.equal(ctx.characters.length, 1);
  assert.equal(ctx.characters[0].fullName, 'คิริซาเมะ เอย์จิ');
  assert.deepEqual(bookOps, [{ kind: 'merge', from: 'คิริซาเมะ', into: 'เอย์จิ' }]);
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
  const p = all(buildPrompt([{ index: 1, source: '' }], { pairs: [], characters: [] }, true, {}));
  assert.ok(p.includes('sameAs'), 'merge op documented');
  assert.ok(p.includes('confirmed by user'), 'user rows off-limits in the contract');
});

test('parse <r>: src attr captured as source', () => {
  const r = parseResponse('<r n="1" src="一緒に来て">ไปด้วยกัน</r>\n<r n="2" keep="true"/>', 2);
  assert.equal(r.regions[0].source, '一緒に来て');
  assert.equal(r.regions[0].translation, 'ไปด้วยกัน');
});

test('buildPrompt transcribeSrc: src requested + verbatim rule, ocr exempt, default off', () => {
  const p = all(buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, { transcribeSrc: true }));
  assert.ok(p.includes('src="this region\'s original text'), 'element requests src');
  assert.ok(p.includes('Transcribe first'), 'verbatim rule present');
  const po = all(buildPrompt([{ index: 1, source: 'x' }], EMPTY_CONTEXT, false, { transcribeSrc: true, ocr: true }));
  assert.ok(!po.includes('Transcribe first') && !po.includes('src="this region'), 'ocr mode exempt');
  const pn = all(buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, {}));
  assert.ok(!pn.includes('src="this region'), 'default off');
});

test('buildPrompt transcribeOnly: transcribe task, no translate/book/pairs', () => {
  const p = all(buildPrompt([{ index: 1, source: '' }, { index: 2, source: '' }], EMPTY_CONTEXT, true, { transcribeOnly: true, chars: false }));
  assert.ok(p.includes('Transcribe the text'), 'transcribe task');
  assert.ok(!p.includes('Translate the numbered'), 'no translate task');
  assert.ok(p.includes('Do NOT translate') || p.includes('Never translate'), 'never-translate rule');
  assert.ok(p.includes('sound-effect'), 'SFX transcribed, not kept');
  assert.ok(!p.includes('<names>') && !p.includes('known_characters') && !p.includes('recent_translations'), 'no book/pairs');
  const pc = all(buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, { transcribeOnly: true, chars: false, textOnly: true }));
  assert.ok(pc.includes('There is no full-page image'), 'crops-only variant');
  // same XML shape: translation field carries the transcription
  const r = parseResponse('<r n="1">一緒に来て</r>\n<r n="2" keep="true"/>', 2);
  assert.equal(r.regions[0].translation, '一緒に来て');
  assert.equal(r.regions[1].translation, 'keep');
});

test('transcribe split: instructions in system, only the region list in user (unbiased read)', () => {
  const p = buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, { transcribeOnly: true, chars: false });
  assert.ok(p.system.includes('Transcribe the text') && p.system.includes('Do NOT translate'));
  assert.ok(!p.system.includes('<regions>'), 'regions are data, not instructions');
  assert.equal(p.user, '<regions>\n1 (read from image)\n</regions>\n');
  assert.ok(!p.user.includes('<known_characters>') && !p.user.includes('<recent_translations>'));
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
  ocrTemperature: 0,
  useOcrModel: false, stylePrompt: '', targetLang: 'Thai',
  useCharacters: true, contextPairs: 40, transcribeSrc: false, vlmAssisted: false,
};

test('flight adoption: the request key ignores the page argument, so two different pages never share one call', async () => {
  // Regression: pageW/pageH used to be part of the key. Two different page IMAGES at the
  // same dimensions therefore hashed identically when the images were not sent (OCR mode),
  // and the second page silently received the first page's translation.
  const a = await translateRequestId(translateRequestParts(
    { ...ADOPT_REQ, imagesB64: [], pageW: 600, pageH: 800 }, ADOPT_ST));
  const b = await translateRequestId(translateRequestParts(
    { ...ADOPT_REQ, imagesB64: [], pageW: 600, pageH: 800, regions: [{ index: 1, source: 'Bye' }] }, ADOPT_ST));
  assert.notEqual(a, b, 'different page content must never adopt another page flight');
});

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
    [ADOPT_REQ, { ...ADOPT_ST, ocrTemperature: 0.6 }, 'ocr temperature'],
    [ADOPT_REQ, { ...ADOPT_ST, targetLang: 'English' }, 'target lang'],
    [ADOPT_REQ, { ...ADOPT_ST, useCharacters: false }, 'chars flag'],
    [{ ...ADOPT_REQ, split: true }, ADOPT_ST, 'split mode'],
  ];
  for (const [r, s, why] of variants) {
    assert.notEqual(await translateRequestId(translateRequestParts(r, s)), id, `must re-key on ${why}`);
  }
});

test('fresh translation intents separate completed answers but transport retries still adopt', async () => {
  const normal = await translateRequestId(translateRequestParts(ADOPT_REQ, ADOPT_ST));
  const first = { ...ADOPT_REQ, requestNonce: '11111111-1111-4111-8111-111111111111' };
  const second = { ...ADOPT_REQ, requestNonce: '22222222-2222-4222-8222-222222222222' };
  const fresh = await translateRequestId(translateRequestParts(first, ADOPT_ST));
  assert.notEqual(fresh, normal);
  assert.notEqual(await translateRequestId(translateRequestParts(second, ADOPT_ST)), fresh);
  assert.equal(await translateRequestId(translateRequestParts(structuredClone(first), ADOPT_ST)), fresh);
  assert.equal(await translateRequestId(translateRequestParts({ ...ADOPT_REQ, requestNonce: 'invalid' }, ADOPT_ST)), normal);
});

// ---- provider rate-limit breaker: a 429 is a refusal, not a hiccup ----
// Live case (OpenRouter free VLM): per-call retries x page cooldown x
// sweep/lookahead workers turned one 429 into 24 identical requests in 3min.

test('429: no retry, one request only, and Retry-After arms the window', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: false, status: 429,
      headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? '2' : null) },
      async text() { return JSON.stringify({ error: { message: 'rate limited, slow down' } }); },
    };
  };
  const s = { provider: 'openai', baseUrl: 'https://rl-a.test/v1', model: 'm', apiKey: 'k' };
  try {
    let first;
    try { await callLLM(s, 'p'); } catch (e) { first = e; }
    assert.equal(calls, 1, 'a refusal is not retried (the breaker owns the wait)');
    const m = toMtError(first);
    assert.equal(m.kind, 'ratelimit');
    assert.equal(m.retryAfterMs, 2000, 'window follows the Retry-After header');
    // inside the window: refused locally, no request goes out
    let second;
    try { await callLLM(s, 'p'); } catch (e) { second = e; }
    assert.equal(calls, 1, 'no request while the provider is refusing');
    assert.equal(second.kind, 'ratelimit');
    assert.ok(second.retryAfterMs > 0 && second.retryAfterMs <= 2000, 'remaining time is reported');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('429 without Retry-After: the default cooldown still blocks the retry', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 429, async text() { return '{}'; } };
  };
  const s = { provider: 'openai', baseUrl: 'https://rl-b.test/v1', model: 'm', apiKey: 'k' };
  try {
    await callLLM(s, 'p').catch(() => {});
    await callLLM(s, 'p').catch(() => {});
    assert.equal(calls, 1, 'default window (45s) blocks the second call too');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('429: the window is per provider|baseUrl and expires', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const realFetch = globalThis.fetch;
  let limited = 0, other = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('rl-c.test')) {
      limited++;
      return {
        ok: false, status: 429,
        headers: { get: () => '2' },
        async text() { return '{}'; },
      };
    }
    other++;
    return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: 'ok' } }] }); } };
  };
  const a = { provider: 'openai', baseUrl: 'https://rl-c.test/v1', model: 'm', apiKey: 'k' };
  const b = { provider: 'openai', baseUrl: 'https://rl-d.test/v1', model: 'm', apiKey: 'k' };
  try {
    await callLLM(a, 'p').catch(() => {});
    assert.equal(limited, 1);
    // another provider keeps working — a 429 on a free OCR model must not
    // block the (separate) translation provider
    await callLLM(b, 'p');
    assert.equal(other, 1, 'separate provider unaffected');
    // window still open → blocked; after it expires → request goes out again
    await callLLM(a, 'p').catch(() => {});
    assert.equal(limited, 1);
    t.mock.timers.tick(2100);
    await callLLM(a, 'p').catch(() => {});
    assert.equal(limited, 2, 'window expired — the next call is allowed through');
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = realFetch;
  }
});

// ---- mergeRegions: partial-accept across the retry ladder ----
// Incident: r1 answered 3/14 regions, the missing-region retry and the full-page
// retry both came back empty/partial, and the old code REPLACED the answer with the
// last leg's output — discarding paid translations and failing the whole page.

test('mergeRegions: keeps the earlier answer per index, later only fills gaps', () => {
  const r1 = [{ index: 1, t: 'a' }, { index: 2, t: 'b' }];
  const r3 = [{ index: 2, t: 'B-replaced?' }, { index: 3, t: 'c' }];
  assert.deepEqual(mergeRegions(r1, r3), [
    { index: 1, t: 'a' },
    { index: 2, t: 'b' }, // first occurrence wins — r1 ran with the full context
    { index: 3, t: 'c' },
  ]);
});

test('mergeRegions: empty later leg preserves the earlier partial answer', () => {
  const r1 = [{ index: 4 }, { index: 5 }];
  assert.deepEqual(mergeRegions(r1, []), r1);
});

test('mergeRegions: output is index-sorted so order/dedup stays stable', () => {
  const merged = mergeRegions([{ index: 9 }, { index: 2 }], [{ index: 5 }]);
  assert.deepEqual(merged.map(r => r.index), [2, 5, 9]);
});

// ---- Phase 1: roster ids, admission, eviction, role split ----

test('roster ids: placeholder spk ("?", "...") learns nothing and never reaches the prompt', () => {
  let ctx = updateContext(EMPTY_CONTEXT, [
    { index: 1, source: '', translation: 'สวัสดี', spk: { desc: '?', gender: '?' } },
    { index: 2, source: '', translation: '…', spk: { desc: '...', gender: 'F' } },
    { index: 3, source: '', translation: '!', spk: { desc: 'sign', gender: '?' } },
  ]).ctx;
  assert.equal(ctx.characters.length, 0, 'no identity = no row');
  ctx = updateContext(ctx, [
    { index: 1, source: '', translation: 'สวัสดี', spk: { desc: 'girl with red ribbon', gender: 'F' } },
  ]).ctx;
  assert.equal(ctx.characters.length, 1);
  assert.equal(ctx.characters[0].id, 'c1');
  const bp = buildPrompt([{ index: 1, source: '' }], ctx, true, {});
  const roster = bp.user.slice(bp.user.indexOf('<known_characters>'), bp.user.indexOf('</known_characters>'));
  assert.ok(roster.includes('<c id="c1" g="F">(unnamed) girl with red ribbon</c>'));
  assert.ok(!roster.includes('?'), 'no junk row in the roster');
});

test('roster ids: same speaker over 3 pages keeps one id and one row', () => {
  let ctx = EMPTY_CONTEXT;
  for (let page = 0; page < 3; page++) {
    ctx = updateContext(ctx, [
      { index: 1, source: '', translation: `t${page}`, spk: { id: page === 0 ? undefined : 'c1', desc: page === 0 ? 'twintail girl' : '', gender: 'F' } },
    ]).ctx;
    assert.equal(ctx.characters.length, 1, `page ${page}: one row`);
    assert.equal(ctx.characters[0].id, 'c1');
  }
  assert.equal(ctx.characters[0].desc, 'twintail girl', 'id-matched observations never re-describe');
});

test('roster ids: an unknown id with no anchor is dropped; a valid id upgrades gender in place', () => {
  const book = [{ id: 'c1', desc: 'hero girl', gender: '?', source: 'vlm' }];
  const dropped = updateContext({ pairs: [], characters: book }, [
    { index: 1, source: '', translation: 'x', spk: { id: 'c9', desc: '', gender: 'M' } },
  ]).ctx;
  assert.equal(dropped.characters.length, 1);
  assert.equal(dropped.characters[0].gender, '?', 'unknown id never retargets an entry');
  const upgraded = updateContext({ pairs: [], characters: book }, [
    { index: 1, source: '', translation: 'x', spk: { id: 'c1', desc: '', gender: 'F' } },
  ]).ctx;
  assert.equal(upgraded.characters.length, 1);
  assert.equal(upgraded.characters[0].gender, 'F');
});

test('eviction: unnamed rows go first; named rows survive a full book', () => {
  let book = [{ id: 'c1', desc: 'named hero', gender: 'M', name: 'ยามาดะ', source: 'vlm' }];
  for (let i = 0; i < 9; i++) book = mergeCharacter(book, { desc: `unnamed${i}`, gender: '?', source: 'vlm' });
  assert.equal(book.length, 10);
  book = mergeCharacter(book, { desc: 'brand new face', gender: 'F', source: 'vlm' });
  assert.equal(book.length, 10);
  assert.ok(book.some(c => c.name === 'ยามาดะ'), 'named row protected');
  assert.ok(book.some(c => c.desc === 'brand new face'), 'the new row survives');
  assert.ok(!book.some(c => c.desc === 'unnamed0'), 'oldest unnamed evicted');
});

test('prompt: mention desc is optional and provenance descriptions are banned', () => {
  const p = all(buildPrompt([{ index: 1, source: '' }], EMPTY_CONTEXT, true, {}));
  assert.ok(p.includes('role or relation ONLY when the page states one'));
  assert.ok(p.includes('Never describe where or how the name appeared'));
});

test('prompt budget: rules + roster + pairs stay compact', () => {
  const regions = Array.from({ length: 8 }, (_, i) => ({ index: i + 1, source: '' }));
  const characters = Array.from({ length: 6 }, (_, i) => ({
    id: `c${i + 1}`, desc: `character description number ${i}`, gender: 'F', name: `ชื่อตัวละคร${i}`, source: 'vlm',
  }));
  const pairs = Array.from({ length: 15 }, (_, i) => ['', `บทพูดหน้า ${i + 1}: ประโยคแปลตัวอย่างที่มีความยาวระดับหนึ่ง`]);
  const p = buildPrompt(regions, { pairs, characters }, true, { textOnly: true, targetLang: 'Thai', maxPairs: 15 });
  // Same config on the pre-id prompt measured 5,483 chars (verbose roster) — the speaker
  // contract adds instructions while the compact roster shrinks each entry ~77%; a full
  // 10-character book is where the new format actually saves.
  assert.ok(all(p).length < 5700, `prompt grew past the budget: ${all(p).length}`);
});

test('provider roles: system block rides each protocol with its cache hint', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return {
      ok: true, status: 200,
      async text() {
        if (String(url).includes('/v1/messages')) return JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: {} });
        if (String(url).includes(':generateContent')) return JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
        if (String(url).includes('/responses')) return JSON.stringify({ output: [], usage: {} });
        return JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} });
      },
    };
  };
  const bp = buildPrompt([{ index: 1, source: '' }],
    { pairs: [], characters: [{ id: 'c1', desc: 'hero girl', gender: 'F', source: 'vlm' }] }, true, {});
  try {
    const openai = { provider: 'openai', baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' };
    await callLLM(openai, bp);
    assert.equal(seen.at(-1).body.messages[0].role, 'system');
    assert.equal(seen.at(-1).body.messages[0].content, bp.system);
    assert.deepEqual(seen.at(-1).body.messages[1].content[0], { type: 'text', text: bp.user });

    const anthropic = { provider: 'anthropic', baseUrl: 'https://a.test', model: 'm', apiKey: 'k' };
    await callLLM(anthropic, bp);
    const ab = seen.at(-1).body;
    assert.equal(ab.system[0].text, bp.system);
    assert.deepEqual(ab.system[0].cache_control, { type: 'ephemeral' });
    assert.ok(ab.messages[0].content[0].cache_control, 'book segment carries its own breakpoint');
    assert.ok(ab.messages[0].content[0].text.includes('<known_characters>'));
    assert.ok(!ab.messages[0].content[1].cache_control, 'volatile tail stays uncached');

    const gemini = { provider: 'gemini', baseUrl: 'https://g.test/v1beta', model: 'm', apiKey: 'k' };
    await callLLM(gemini, bp);
    assert.equal(seen.at(-1).body.systemInstruction.parts[0].text, bp.system);

    const responses = { provider: 'responses', baseUrl: 'https://r.test/v1', model: 'm', apiKey: 'k' };
    await callLLM(responses, bp);
    assert.equal(seen.at(-1).body.instructions, bp.system);

    const cf = cfBody(bp);
    assert.equal(cf.messages[0].role, 'system');
    assert.equal(cf.messages[0].content, bp.system);
    assert.equal(cf.messages[1].role, 'user');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('provider roles: a rejected system role retries once as a single user message', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    calls++;
    bodies.push(JSON.parse(String(init?.body)));
    if (calls === 1) {
      return { ok: false, status: 400, async text() { return JSON.stringify({ error: { message: 'system role is not supported by this model' } }); } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }); } };
  };
  try {
    const s = { provider: 'openai', baseUrl: 'https://sys-role.test/v1', model: 'm', apiKey: 'k' };
    const bp = { system: 'RULES', user: 'DATA' };
    const r = await callLLM(s, bp);
    assert.equal(calls, 2, 'rejected request + one merge retry');
    assert.equal(r.systemDropped, true);
    assert.equal(bodies[1].messages.length, 1, 'retry has no system role');
    assert.equal(bodies[1].messages[0].role, 'user');
    assert.ok(bodies[1].messages[0].content[0].text.includes('RULES'));
    assert.ok(bodies[1].messages[0].content[0].text.includes('DATA'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- character identity: script-agnostic matching, folds, notes (2026-10-03) ----

test('identity: Thai re-descriptions fold when they share the anchor; a different outfit does not', () => {
  // containment of a long anchor = the same person re-described
  let book = mergeCharacter([], { desc: 'ชายหนุ่มผมดำสวมชุดสูทโอบกอดหญิงสาวจากด้านหลัง', gender: 'M', source: 'vlm' });
  book = mergeCharacter(book, { desc: 'ชายหนุ่มผมดำสวมชุดสูท', gender: 'M', source: 'vlm' });
  assert.equal(book.length, 1, 'contained Thai anchor folds');
  // suit vs t-shirt: no containment and ~0.73 bigram dice — two different anchors
  book = mergeCharacter([], { desc: 'ชายหนุ่มผมดำสวมชุดสูท', gender: 'M', source: 'vlm' });
  book = mergeCharacter(book, { desc: 'ชายหนุ่มผมดำสวมเสื้อยืด', gender: 'M', source: 'vlm' });
  assert.equal(book.length, 2, 'a different outfit is not the same person');
});

test('identity: short near-identical anchors stay apart (alpha1 vs alpha2)', () => {
  let book = mergeCharacter([], { desc: 'alpha1', gender: '?', source: 'speech' });
  book = mergeCharacter(book, { desc: 'alpha2', gender: '?', source: 'speech' });
  assert.equal(book.length, 2);
});

test('identity: vowel-length spelling variance folds one name, unrelated vowels stay apart', () => {
  let book = mergeCharacter([], { desc: 'เด็กสาว', gender: 'F', name: 'ยูซุรุ', source: 'vlm' });
  book = mergeCharacter(book, { desc: 'เด็กสาวผมสั้น', gender: 'F', name: 'ยุซุรุ', source: 'vlm' });
  assert.equal(book.length, 1, 'ยูซุรุ / ยุซุรุ is one person');
  let two = mergeCharacter([], { desc: 'a', gender: 'F', name: 'มาลี', source: 'vlm' });
  two = mergeCharacter(two, { desc: 'b', gender: 'F', name: 'มาลา', source: 'vlm' });
  assert.equal(two.length, 2, 'different vowels are different people');
});

test('identity: junk anchors are rejected (single letter/digit, box label)', () => {
  const ctx = updateContext(EMPTY_CONTEXT, [
    { index: 1, source: '', translation: 'x', spk: { desc: 'B', gender: '?' } },
    { index: 2, source: '', translation: 'y', spk: { desc: '7', gender: '?' } },
    { index: 3, source: '', translation: 'z', spk: { desc: 'sign', gender: '?' } },
    { index: 4, source: '', translation: 'w', spk: { desc: 'girl with short black hair', gender: 'F' } },
  ]).ctx;
  assert.equal(ctx.characters.length, 1);
  assert.equal(ctx.characters[0].desc, 'girl with short black hair');
});

test('normalizeBook heals a book forked by the old matcher', () => {
  const rows = normalizeBook([
    { desc: 'ชายหนุ่มผมดำสวมชุดสูทโอบกอดหญิงสาวจากด้านหลัง', gender: 'M', source: 'vlm' },
    { desc: 'ชายหนุ่มผมดำสวมชุดสูท', gender: 'M', source: 'vlm' },
    { desc: 'ยูซุรุ', gender: '?', name: 'ยูซุรุ', source: 'vlm' },
    { desc: 'เด็กสาว', gender: '?', name: 'ยุซุรุ', source: 'vlm' },
  ]);
  assert.equal(rows.length, 2, 'one man + one ยูซุรุ');
});

test('normalizeBook folds an unnamed anchor that is just the named row, never two user rows', () => {
  const rows = normalizeBook([
    { desc: 'ชายหนุ่มผมดำ', gender: 'M', source: 'vlm' },
    { desc: 'เพื่อนของนางเอก', gender: 'M', name: 'ชายหนุ่มผมดำ', source: 'mention' },
  ]);
  assert.equal(rows.length, 1, 'a desc that repeats the name is not a second person');
  const users = normalizeBook([
    { desc: 'หญิงผมสั้น', gender: 'F', source: 'user' },
    { desc: 'หญิงผมสั้นผมยาว', gender: 'F', source: 'user' },
  ]);
  assert.equal(users.length, 2, 'two user rows are never auto-merged');
});

test('note op: quote-gated, appends to the listed row, user rows untouched', () => {
  const book = [
    { id: 'c1', desc: 'หญิงผมสั้นถือสมุด', gender: 'F', source: 'vlm' },
    { id: 'c2', desc: 'mine', gender: 'M', source: 'user' },
  ];
  const { ctx, bookOps } = updateContext({ pairs: [], characters: book }, [], [
    { id: 'c1', note: 'คิริซาเมะเรียกเธอว่า โทริ', gender: '?', desc: '', why: '「トーリ」' },
    { id: 'c1', note: 'ไม่มี quote', gender: '?', desc: '' },
    { id: 'c2', note: 'x', gender: '?', desc: '', why: 'y' },
  ]);
  assert.equal(ctx.characters.find(c => c.id === 'c1').note, 'คิริซาเมะเรียกเธอว่า โทริ');
  assert.equal(ctx.characters.find(c => c.id === 'c2').note, undefined);
  assert.equal(bookOps.length, 1);
  assert.equal(bookOps[0].field, 'note');
});

test('parse <m>: note attr captured', () => {
  const r = parseResponse('<r n="1">x</r>\n<names>\n<m id="c2" note="พี่ชายของนางเอก" why="お兄ちゃん"/>\n</names>', 1);
  assert.equal(r.mentions[0].note, 'พี่ชายของนางเอก');
  assert.equal(r.mentions[0].id, 'c2');
});

test('mentions: role text lands in note, not the visual desc', () => {
  const ctx = updateContext(EMPTY_CONTEXT, [
    { index: 1, source: '', translation: '...', spk: { desc: 'girl with red ribbon', gender: 'F', name: 'อากิ' } },
  ], [{ name: 'อากิ', gender: 'F', desc: 'เพื่อนร่วมชั้นของพระเอก' }]).ctx;
  const c = ctx.characters[0];
  assert.equal(c.note, 'เพื่อนร่วมชั้นของพระเอก');
  assert.equal(c.desc, 'girl with red ribbon');
});

test('roster carries the note on the compact line', () => {
  const p = buildPrompt([{ index: 1, source: '' }],
    { pairs: [], characters: [{ id: 'c1', desc: 'girl', gender: 'F', name: 'อากิ', note: 'พี่สาวของยูซุรุ', source: 'vlm' }] }, true, {});
  assert.ok(p.user.includes('<c id="c1" g="F">อากิ — girl · พี่สาวของยูซุรุ</c>'));
});

test('overrides: desc/note win and mark the row user; a stale roster id adds nothing', () => {
  const ctx = { pairs: [], characters: [{ id: 'c1', desc: 'old anchor', gender: 'F', source: 'vlm' }] };
  const out = applyOverrides(ctx, { c1: { gender: 'F', desc: 'หญิงผมสั้นถือสมุด', note: 'คู่หมั้นของคิริซาเมะ' } });
  assert.equal(out.characters[0].desc, 'หญิงผมสั้นถือสมุด');
  assert.equal(out.characters[0].note, 'คู่หมั้นของคิริซาเมะ');
  assert.equal(out.characters[0].source, 'user');
  assert.equal(applyOverrides(EMPTY_CONTEXT, { c9: { gender: 'M', name: 'ผี' } }).characters.length, 0);
});

test('merge/split round-trip: absorbed rows come back as user rows', () => {
  let book = [
    { id: 'c1', desc: 'ชายหนุ่มผมดำสวมชุดสูท', gender: 'M', source: 'vlm' },
    { id: 'c2', desc: 'หนุ่มผมดำใส่แว่น', gender: 'M', source: 'vlm' },
  ];
  book = mergeBookRows(book, 'c1', 'c2');
  assert.equal(book.length, 1);
  assert.equal(book[0].id, 'c1');
  assert.equal(book[0].absorbed.length, 1);
  assert.equal(charKey(book[0]), 'c1');
  book = splitBookRow(book, 'c1');
  assert.equal(book.length, 2);
  assert.equal(book[1].desc, 'หนุ่มผมดำใส่แว่น');
  assert.equal(book[1].source, 'user');
});
