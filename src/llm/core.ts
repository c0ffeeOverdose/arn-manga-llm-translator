// LLM prompt building + response parsing + character book merge.
// Pure logic — unit tested in tests/llm.test.mjs (node:test, no browser APIs).

// A row folded into another by coalesce or a user merge; kept so Split can restore it.
export interface AbsorbedRow { desc: string; name?: string; fullName?: string; gender: 'M' | 'F' | '?' }

export interface CharacterEntry {
    id?: string;           // stable roster id ("c3") — spk and <m> ops reference this row
    desc: string;          // visual/behavioral description ("twintail girl in school uniform")
    gender: 'M' | 'F' | '?' ;
    source: 'user' | 'vlm' | 'speech' | 'mention'; // priority for merges: user > vlm > speech = mention
    name?: string;         // short/display name ("ยามาดะ")
    fullName?: string;     // full name ONLY when a page states it — never assembled or guessed
    note?: string;         // page-stated social facts (relation, rank, how addressed) — never looks
    absorbed?: AbsorbedRow[]; // rows folded into this one; the panel's Split restores them
}

// A person NAMED in page dialogue/narration — page-level, unlike per-region spk.
// Text-based, works in every textSource mode including crops and OCR.
export interface Mention {
    id?: string;           // book op target: roster id, preferred over name matching
    name?: string;
    fullName?: string;
    gender: 'M' | 'F' | '?';
    desc: string;          // who this is in one short phrase (role/relation, not looks)
    sameAs?: string;       // book op: this entry IS the named book entry — merge them
    correct?: string;      // book op: field to fix ('gender'|'name'|'desc'|'full')
    now?: string;          // book op: replacement value for `correct`
    why?: string;          // book op: exact quote from THIS page proving it (required)
    note?: string;         // book op: one page-stated social fact appended to a listed row (needs why)
}

export interface BookOp {
    kind: 'merge' | 'correct';
    from: string;          // entry label before the op
    into?: string;         // merge target label
    field?: string;        // corrected field
    was?: string;
    now?: string;
}

// source, translation, and the roster id the speaker resolved to (absent for narration/unknown)
export type PairLine = [string, string, string?];

export interface ContextState {
    pairs: PairLine[];      // recent lines (source => translation; source is '' in vision modes)
    characters: CharacterEntry[];
}

export const EMPTY_CONTEXT: ContextState = { pairs: [], characters: [] };

export const MAX_PAIRS = 40;
export const MAX_CHARACTERS = 10;

export interface RegionInput {
    index: number;       // 1-based
    source: string;      // OCR/VLM-read source text (may be empty for vision mode)
}

export interface ExtraRegion {
    // pixel coords on the page (validated against pageW/pageH by the caller)
    x1: number; y1: number; x2: number; y2: number;
    source: string;
    translation: string;
}

export interface BuildOpts {
    vlmAssisted?: boolean;  // ask the model to report un-numbered text regions
    stylePrompt?: string;   // user tone instruction ('' = follow the original tone)
    targetLang?: string;    // translation target (default Thai)
    pageW?: number;
    pageH?: number;
    // merged request: the first `pageCount` images are full pages (badges stay global)
    pageCount?: number;
    textOnly?: boolean;     // crops mode: crops only, no full-page image
    ocr?: boolean;          // OCR mode: source text provided per region, no images
    chars?: boolean;        // character channel (default true): send known_characters
                            // + ask for spk/names. False = pairs-only context, and the
                            // model stops spending output tokens on speaker IDs.
    maxPairs?: number;      // recent-translation lines kept/sent (default MAX_PAIRS)
    transcribeSrc?: boolean; // model copies source text into src attr (vision-mode context)
    transcribeOnly?: boolean; // VLM-OCR stage: transcribe each region EXACTLY, no translation (SFX transcribed too — the translate stage decides keep)
    transcribeOne?: boolean;  // per-region VLM-OCR (single-image models): the request has ONE crop and must answer with ONE element (all lines joined)
    charLimit?: number;     // roster cap sent to the model (default MAX_CHARACTERS)
}

// Two roles: the fixed instructions ride `system`, the per-page data rides `user`.
// Providers cache a stable prefix, and the book/pairs/regions change every page —
// keeping them out of the system block keeps that segment reusable.
export interface BuiltPrompt { system: string; user: string; }

// Thai gets the full particle rule; every other language gets the generic gendered-speech rule.
// Completeness wins (renderer shrink-fits), so no size numbers go into the prompt.
const COMPLETENESS = 'Translate the COMPLETE meaning — never drop the subject, tense/aspect, or emphasis to save space; the renderer auto-fits the font size to the region, so completeness always wins over brevity.';
const LANG_RULES: Record<string, string> = {
    Thai: `Natural Thai. ${COMPLETENESS} Thai may drop pronouns in casual speech, but for a translation keep every meaning unit from the source unless it reads unnatural. Politeness particles ครับ/ค่ะ/คะ must match speaker gender (from character book or image, never honorifics) — but only USE them when the line is polite/formal; casual speech between close characters drops them or uses นะ/สิ/ดิ/วะ per the original tone. Keep -kun/-chan/-san as คุง/จัง/ซัง.`,
};
const GENERIC_RULE = (lang: string) =>
    `Natural ${lang}. ${COMPLETENESS} If ${lang} has gendered speech forms (adjectives, verbs, pronouns), they must match the speaker gender from the character book or image. Keep honorifics like -kun/-chan/-san in their usual ${lang} form. Match the original tone (casual stays casual, formal stays formal).`;

export function buildPrompt(
    regions: RegionInput[],
    ctx: ContextState,
    vision: boolean,
    opts: BuildOpts = {},
): BuiltPrompt {
    const lang = opts.targetLang?.trim() || 'Thai';
    const chars = opts.chars !== false;
    // roster up front: the example below must not reference an id that does not exist yet;
    // the full (uncapped) book also decides which pair speaker tags are safe to show
    const full = chars ? normalizeBook(ctx.characters) : [];
    const roster = full.slice(0, opts.charLimit ?? MAX_CHARACTERS);
    const bookIds = new Set(full.map(c => c.id).filter((id): id is string => typeof id === 'string'));
    // VLM-OCR stage: pure transcription, same <r> shape so caller reuses parseResponse.
    // No book/pairs/style: a read must not be biased.
    if (opts.transcribeOnly) {
        // per-region variant: one crop in, ONE element out — never split lines into numbered elements.
        if (opts.transcribeOne) {
            const system = `<task>Transcribe the text in this single manga region EXACTLY as written. Do NOT translate.</task>
<images>One image: the crop of the region.</images>
<output_format>Output EXACTLY one element — ALL lines of the region joined with a single space, nothing else:
<r n="1">exact transcription</r>
<r n="1" keep="true"/>

The second form (self-closing, keep="true", NO text inside) is ONLY for an image with no readable text (drawings, patterns, faces, objects, scenery). Transcribe everything readable INCLUDING stylized sound-effect lettering — do not judge, do not translate, do not clean up.
<example>
<r n="1">一緒に来てくれないか</r>
</example></output_format>
<rules>
- Exactly one element. Put every line into it, joined with a space — never split into multiple elements.
- Copy character-for-character — no paraphrase, no cleanup, no guessing unreadable glyphs (that is keep). Never translate.
</rules>
`;
            return { system, user: '<regions>\n1 (read from image)\n</regions>\n' };
        }
        let system = `<task>Transcribe the text in each numbered manga region EXACTLY as written. Do NOT translate.</task>\n`;
        if (vision && opts.textOnly) {
            system += `<images>Each image is the crop of region 1, 2, … in order — transcribe each region from its own crop. There is no full-page image.</images>\n`;
        } else if (vision) {
            system += `<images>First image = full page with red number badges; the following images are crops of region 1, 2, … in order. Transcribe each region from its crop; use the full page for context.</images>\n`;
        }
        system += `<output_format>Output EXACTLY this XML — one element per region, nothing else:
<r n="REGION">exact transcription</r>
<r n="REGION" keep="true"/>

The second form (self-closing, keep="true", NO text inside) is ONLY for regions with no readable text (drawings, patterns, faces, objects, scenery). Transcribe everything readable INCLUDING stylized sound-effect lettering — do not judge, do not translate, do not clean up.
<example>
<r n="1">一緒に来てくれないか</r>
<r n="2">ドン</r>
<r n="3" keep="true"/>
</example></output_format>\n`;
        system += `<rules>\n- Copy character-for-character — no paraphrase, no cleanup, no guessing unreadable glyphs (those regions are keep). Never translate.\n</rules>\n`;
        let user = '<regions>\n';
        for (const r of regions) user += `${r.index} (read from image)\n`;
        return { system, user: user + '</regions>\n' };
    }
    // XML-structured prompt: explicit tags keep instructions apart from data; output is XML too.
    let p = `<task>Translate the numbered manga regions into ${lang}.</task>\n`;
    if (vision && opts.textOnly) {
        p += `<images>Each image is the crop of region 1, 2, … in order — read each region from its own crop. There is no full-page image: you see only the text boxes, not the surrounding artwork.</images>\n`;
    } else if (vision && (opts.pageCount ?? 1) > 1) {
        p += `<images>The first ${opts.pageCount} images are full pages with red number badges, in page order — a badge number is that region's number in the list below. The following images are crops of region 1, 2, … in order. Read each region from its crop; use the full pages for context.</images>\n`;
    } else if (vision) {
        p += `<images>First image = full page with red number badges; the following images are crops of region 1, 2, … in order. Read each region from its crop; use the full page for context.</images>\n`;
    }
    const srcAttr = opts.transcribeSrc && !opts.ocr ? ' src="this region\'s original text, copied EXACTLY as written"' : '';
    p += `<output_format>Output EXACTLY this XML — one element per region, nothing else:
<r n="REGION"${srcAttr}${chars ? ' spk="c1|new" desc="short visual anchor (only with spk=new)" g="M|F|?" name="given name if the page states it"' : ''}>${lang} translation</r>
<r n="REGION" keep="true"/>

The second form (self-closing, keep="true", NO text inside) is for regions you do NOT translate:
- no readable text in the crop: drawings, patterns, faces, objects, scenery, a silent reaction panel
- SFX/onomatopoeia: stylized lettering drawn OVER the artwork (katakana like ドン/チッ, BOOM, DING DONG) — even if readable, even bubble-shaped
- signatures, watermarks
Never put a description, brackets, or invented dialogue in a keep element. Never leave a translation empty — if there is nothing to translate, it is a keep element.
${chars ? `
Speaker attributes:
- spk: an id from <known_characters> (c1, c2, …); [c2] on a recent line = that speaker; if unlisted use spk="new" desc="short visual anchor" (name="…" only when this page states it).
- Omit spk/desc/g/name for anything that is not a person speaking (narration, signs, labels, SFX); if you cannot tell who speaks, omit spk rather than guess.
- name: only when THIS page states the character's name, in ${lang} form; never repeat a name the book already lists.
<example>
<r n="1"${opts.transcribeSrc && !opts.ocr ? ' src="一緒に来てくれないか"' : ''} ${roster.length ? 'spk="c1" g="F"' : 'spk="new" desc="girl with red ribbon" g="F"'}>ไปด้วยกันไหมคะ</r>
<r n="2"${opts.transcribeSrc && !opts.ocr ? ' src="山田、やめてよね"' : ''} spk="new" desc="boy with spiky hair" g="M" name="ยามาดะ">ยามาดะ หยุดเถอะครับ</r>
<r n="3" keep="true"/>
</example>

After the regions, if anyone is NAMED in the dialogue or narration (the speaker, someone addressed, or someone talked about), append one block:
<names>
<m name="short name" full="full name ONLY if the page states it" g="M|F">role or relation ONLY when the page states one — omit the text otherwise</m>
</names>
Omit the whole block when no one is named. full: never assemble or guess a surname. g: only when the page makes it obvious (particles, pronouns, explicit words); otherwise leave it out. Never invent a person. Never describe where or how the name appeared (a name tag, someone mentioning them, the chapter title) — that is not a role.
Credits, bylines and copyright text (author/artist names on a cover or credits panel) are not story characters — never report them.
Two entries in <known_characters> are the same person: <m id="c4" sameAs="c2"/> or <m name="A" sameAs="B">…</m> (both must be in the book).
Book ops — no quote, no change; never touch "confirmed by user" rows: <m id="c2" correct="gender|name|desc|full" now="value" why="quote"/> · <m id="c2" name="name stated on this page"/> (attach on that row) · <m id="c2" note="page-stated relation/rank/addressing" why="quote"/>. Reference an entry by id or listed name.
` : ``}</output_format>\n`;
    p += `<rules>\n- ${LANG_RULES[lang] ?? GENERIC_RULE(lang)}\n`;
    if (chars && vision && !opts.textOnly && !opts.ocr) {
        const pages = (opts.pageCount ?? 1) > 1 ? 'full pages' : 'full page';
        p += `- Speaker — decide each region from the ${pages}, never from the crop alone. The balloon tail is the primary cue: its tip points at the speaker — when a bubble has a tail, THE TAIL DECIDES; an open mouth or a reacting face elsewhere is NOT the speaker. A thought cloud belongs to the thinker (keep their id). No tail (narration box, caption, floating text, off-panel voice, SFX): no spk — fall back to panel/address/continuity only when the artwork has no tails at all. Tag only when this makes the speaker clear; otherwise omit spk rather than guess.\n`;
    }
    if (chars && vision && opts.textOnly) {
        p += '- You see ONLY text crops, never faces or artwork: identify the speaker from the character book or the dialogue itself. If you cannot tell, omit spk and g rather than guess.\n';
    }
    if (opts.ocr) {
        p += `- No images are provided: each region's source text was read by local OCR and is given in the region list. OCR on stylized manga fonts is imperfect — fix obvious character confusions from context, and treat unreadable garbage as a keep region. ${chars ? 'Identify the speaker from the character book or the dialogue itself; if you cannot tell, omit spk and g rather than guess. ' : ''}If the source text is katakana-heavy onomatopoeia (ドン、ドキッ) or ALL-CAPS sound words (BOOM, DING DONG), it is SFX — make it a keep region.\n`;
    }
    // user tone instruction — ADDS to the rules above, never replaces them
    if (opts.stylePrompt?.trim()) {
        p += `- Style (applies to every region): ${opts.stylePrompt.trim()}\n`;
    }
    // transcribeSrc: model copies source into src for vision-mode pairs (OCR mode sends no images — flag ignored).
    if (opts.transcribeSrc && !opts.ocr) {
        p += `- Transcribe first: copy each region's original text EXACTLY into src, character-for-character — no paraphrase, no cleanup, no guessing unreadable glyphs (leave those regions keep). Then translate.\n`;
    }
    if (chars) p += '- Named people: report only names actually written on the page — never guess a surname or a gender from a name. <known_characters> is canonical — use its exact names and spellings.\n';
    if (opts.vlmAssisted && opts.pageW && opts.pageH && !(vision && opts.textOnly)) {
        p += `- Missed text (no badge): <extra n="new" x="x1,y1,x2,y2">${lang} translation</extra> (pixels on the ${opts.pageW}x${opts.pageH} first image). Dialogue only, no SFX.\n`;
    }
    p += `</rules>\n`;
    // a book polluted with legacy junk rows must not be taught back; user rows stay, they are the user's call
    let u = '';
    if (roster.length) {
        u += '<known_characters>\n';
        for (const c of roster) {
            u += `<c id="${c.id}" g="${c.gender}"${c.source === 'user' ? ' u="1"' : ''}>${rosterText(c)}</c>\n`;
        }
        u += '</known_characters>\n';
    }
    if (ctx.pairs.length) {
        const maxPairs = opts.maxPairs ?? MAX_PAIRS;
        u += '<recent_translations>\n';
        // the tag only names rows the model can still find in the roster; a merged/evicted id
        // would invite an spk reference that no longer exists
        for (const [s, t, spk] of ctx.pairs.slice(-maxPairs)) {
            const tag = spk && bookIds.has(spk) ? `[${spk}] ` : '';
            u += s ? `- ${tag}${s} => ${t}\n` : `- ${tag}(previous page) ${t}\n`;
        }
        u += '</recent_translations>\n';
    }
    if (opts.vlmAssisted && opts.pageW && opts.pageH && !(vision && opts.textOnly)) {
        // per-page dims live in the user message (the system block must stay cacheable)
        u += `<page w="${opts.pageW}" h="${opts.pageH}"/>\n`;
    }
    u += '<regions>\n';
    for (const r of regions) {
        // no size numbers by design (see COMPLETENESS) — renderer fits whatever comes back
        u += r.source ? `${r.index} ${r.source}\n` : `${r.index} (read from image)\n`;
    }
    u += '</regions>\n';
    return { system: p, user: u };
}

// Anthropic segment cache: the book changes far less often than pairs/regions, so splitting
// it off lets the static system segment stay cached when the book changes. Null when absent.
const BOOK_END_TAG = '</known_characters>';
export function splitUserForCache(user: string): { head: string; tail: string } | null {
    const i = user.indexOf(BOOK_END_TAG);
    if (i < 0) return null;
    const head = user.slice(0, i + BOOK_END_TAG.length);
    return { head, tail: user.slice(head.length).replace(/^\n/, '') };
}

export interface RegionOutput {
    index: number;
    source: string;
    translation: string;
    spk: { id?: string; desc: string; gender: 'M' | 'F' | '?'; name?: string } | null;
}

export interface ParsedResponse {
    regions: RegionOutput[];
    extras: ExtraRegion[];   // VLM-reported regions the detector missed
    mentions: Mention[];     // people named in dialogue/narration (any region)
}

function parseAttrs(s: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const m of s.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2];
    return attrs;
}

function normGender(g: string | undefined): 'M' | 'F' | '?' {
    return g === 'M' || g === 'm' || /male|ชาย|ผู้ชาย/i.test(g ?? '') ? 'M'
        : g === 'F' || g === 'f' || /female|หญิง|ผู้หญิง/i.test(g ?? '') ? 'F' : '?';
}

// XML output parser, tolerant of LLM slips: self-closing keeps, unclosed elements, preambles.
function parseXml(text: string, expected: number): ParsedResponse | null {
    if (!/<r[\s>]/i.test(text)) return null; // not XML at all → old-format path
    const regions: RegionOutput[] = [];
    const extras: ExtraRegion[] = [];
    const consume = /<r\b([^>]*?)\/>|<r\b([^>]*?)>([\s\S]*?)<\/r>|<r\b([^>]*?)>([^\n<]*)/gi;
    let m: RegExpExecArray | null;
    let any = false;
    while ((m = consume.exec(text))) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const attrStr = m[1] ?? m[2] ?? m[4];
        const content = (m[3] ?? m[5] ?? '').trim();
        const attrs = parseAttrs(attrStr);
        const n = parseInt(attrs.n ?? '', 10);
        if (!Number.isFinite(n) || n < 1 || n > expected) continue;
        any = true;
        // spk is a roster id ("c3") or "new" with a desc="…" anchor. Legacy free-text spk
        // still parses (desc), so a model regressing to the old wording loses no data.
        const spkRaw = attrs.spk?.trim();
        const ref = spkRaw ? /^(c\d+|new)$/i.exec(spkRaw) : null;
        const spk = spkRaw ? {
            id: ref && ref[1].toLowerCase() !== 'new' ? ref[1].toLowerCase() : undefined,
            desc: (ref ? (attrs.desc ?? '') : spkRaw).trim(),
            gender: normGender(attrs.g),
            name: attrs.name?.trim() || undefined,
        } : null;
        // keep: the attribute, the literal word, empty/degenerate content
        // (bare arrows/dashes), or a meta no-text note inside the element
        const srcOf = (attrs.src ?? '').trim();
        if (attrs.keep != null
            || /^(=>\s*)?keep\b/i.test(content)
            || !content
            || /^(?:=>|->|—|–|-|:|\/|\s)+$/.test(content)
            || isMetaNoText(content)) {
            regions.push({ index: n, source: srcOf, translation: 'keep', spk });
            continue;
        }
        regions.push({ index: n, source: srcOf, translation: content, spk });
    }
    for (const e of text.matchAll(/<extra\b([^>]*?)>([\s\S]*?)<\/extra\b[^>]*>|<extra\b([^>]*?)>([^\n<]*)/gi)) {
        const attrs = parseAttrs(e[1] ?? e[3] ?? '');
        const content = (e[2] ?? e[4] ?? '').trim();
        const coords = (attrs.x ?? '').split(',').map(v => +v.trim());
        if (coords.length === 4 && coords.every(Number.isFinite) && content) {
            extras.push({ x1: coords[0], y1: coords[1], x2: coords[2], y2: coords[3], source: '', translation: content });
        }
    }
    const mentions: Mention[] = [];
    for (const e of text.matchAll(/<m\b([^>]*?)\/>|<m\b([^>]*?)>([\s\S]*?)<\/m\s*>/gi)) {
        const attrs = parseAttrs(e[1] ?? e[2] ?? '');
        const name = attrs.name?.trim();
        const id = attrs.id?.trim() || undefined;
        if (!name && !id) continue; // nothing referenceable merges with nothing
        const full = attrs.full?.trim();
        mentions.push({
            id, name: name || undefined, fullName: full || undefined, gender: normGender(attrs.g),
            desc: (e[3] ?? '').trim().slice(0, 160),
            sameAs: attrs.sameas?.trim() || undefined, correct: attrs.correct?.trim().toLowerCase() || undefined,
            now: attrs.now?.trim() || undefined, why: attrs.why?.trim().slice(0, 160) || undefined,
            note: attrs.note?.trim().slice(0, 120) || undefined,
        });
    }
    return any || extras.length || mentions.length ? { regions, extras, mentions } : null;
}

// Parse the XML output format. Empty result triggers the caller's retry — never silent.
export function parseResponse(text: string, expected: number): ParsedResponse {
    return parseXml(text, expected) ?? { regions: [], extras: [], mentions: [] };
}

// Merge a retry's regions into an earlier answer, keeping the FIRST occurrence of each
// index (the earlier leg ran with the full context; the retry answers only what was
// missing). Sorted by index so downstream order/dedup stays stable. Pure — unit-tested.
export function mergeRegions<T extends { index: number }>(earlier: T[], later: T[]): T[] {
    const byIdx = new Map<number, T>();
    for (const r of earlier) if (!byIdx.has(r.index)) byIdx.set(r.index, r);
    for (const r of later) if (!byIdx.has(r.index)) byIdx.set(r.index, r);
    return [...byIdx.values()].sort((a, b) => a.index - b.index);
}

// Per-region transcribe: concatenate every element in order (models split multi-line regions).
// Bare-text drift is used over emptying the region; temperature 0 makes it rare.
const DESCRIBES_IMAGE = /この画像|画像には|画像です|写真です|イラストです|the image (shows|is|depicts)|this (image|picture) (is|shows)|a (photo|picture) of/i;
export function joinTranscription(text: string): string {
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
    const parsed = parseResponse(text, Number.MAX_SAFE_INTEGER);
    if (parsed.regions.length) {
        const joined = clean(parsed.regions
            .filter(r => r.translation && r.translation !== 'keep')
            .map(r => r.translation)
            .join(' '));
        return isMetaNoText(joined) || DESCRIBES_IMAGE.test(joined) ? '' : joined;
    }
    const bare = text
        .replace(/```[a-z]*\n?/gi, ' ')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !/^[<(]?\s*\/?r\b/i.test(l) && !/keep="true"/i.test(l))
        .join(' ');
    return isMetaNoText(bare) || DESCRIBES_IMAGE.test(bare) ? '' : clean(bare);
}

// OCR self-test: collapse whitespace (layout isn't error). Case-sensitive: flipped case is misreading.
export function transcriptionMatches(got: string, expected: string): boolean {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    return norm(expected).length > 0 && norm(got) === norm(expected);
}

// A model answer that DESCRIBES the crop instead of translating it. Checked against FINAL translation.
function isMetaNoText(t: string): boolean {
    const whole = t.trim();
    // explicit no-text phrasing anywhere (thai + english), spacing-tolerant
    return /ไม่มี\s*ข้อความ|ไม่มี\s*ตัวอักษร|ไม่มี\s*บทพูด|ไม่ใช่\s*ข้อความ|no\s+(readable\s+)?text|no dialogue|not text/i.test(whole);
}

// ---- character book ----
const PRIORITY: Record<CharacterEntry['source'], number> = { user: 3, vlm: 2, speech: 1, mention: 1 };

// Notes accumulate one short page-stated fact at a time; duplicates never stack.
const NOTE_MAX = 140;
function joinNote(a?: string, b?: string): string | undefined {
    const parts: string[] = [];
    for (const s of [a, b]) {
        const t = (s ?? '').trim();
        if (t && !parts.some(p => p.includes(t))) parts.push(t);
    }
    return parts.length ? parts.join(' · ').slice(0, NOTE_MAX) : undefined;
}

// Box types reported as speaker on person-less regions. Learning them burns the book and teaches spk forever.
const NON_PERSON_LABEL = /^(?:narration|narrator|caption|subtitle|subtitle text|sfx|sound effect|sound effects|onomatopoeia|sign|signage|shop sign|text|no text|translation note|tn|บรรยาย|บรรยายภาพ|คำบรรยาย|ผู้บรรยาย|ป้าย|ป้ายข้อความ|ข้อความ|เสียง|เสียงประกอบ|ไม่มีข้อความ)$/i;
const isNonPersonLabel = (s: string | undefined): boolean => !!s && NON_PERSON_LABEL.test(s.trim());

// Address suffixes are not part of a name — strip them or the book grows one row per form of address.
const HONORIFIC = /[-・\s]?(?:คุง|คุน|จัง|จัน|ซัง|ซามะ|เซ็นเซย์|senpai|sensei|kun|chan|san|sama)$/i;
function stripHonorific(s: string): string {
    const t = s.replace(HONORIFIC, '').trim();
    return t || s;
}

// Placeholders carry no identity ("spk=?" rows poisoned the book and the prompt):
// punctuation-only text and box-type labels are not a description of a person. A lone
// Latin letter/digit is box-label noise too ("B" rows rode the roster as fake people).
const JUNK_TEXT = /^[?？!！。．.\-–—~〜*＊_×xX\s]+$/;
const SINGLE_ALNUM = /^[A-Za-z0-9]$/;
function usableText(s: string | undefined): string {
    const t = (s ?? '').trim();
    return t && !JUNK_TEXT.test(t) && !SINGLE_ALNUM.test(t) && !isNonPersonLabel(t) ? t : '';
}

// Deterministic roster ids: existing ids are kept; missing ones get c<max+1> in row order.
// Every caller (prompt build, replay, live merge) derives the same ids from the same book.
export function ensureIds(book: CharacterEntry[]): CharacterEntry[] {
    let max = 0;
    for (const c of book) {
        const m = /^c(\d+)$/.exec(c.id ?? '');
        if (m) max = Math.max(max, +m[1]);
    }
    let changed = false;
    const out = book.map(c => {
        if (c.id) return c;
        changed = true;
        return { ...c, id: `c${++max}` };
    });
    return changed ? out : book;
}

// One hygiene pass: drop non-user rows with no usable identity (legacy "?" junk), fold rows
// that are one person, then give every remaining row an id. User rows survive even when
// malformed — their call, not ours.
export function normalizeBook(book: CharacterEntry[]): CharacterEntry[] {
    const kept = book.filter(c => c.source === 'user' || !!(c.name || c.fullName || usableText(c.desc)));
    return ensureIds(coalesceBook(kept));
}

// Roster line for the prompt: name — role; "(unnamed)" anchors are how a speaker without a
// name still gets matched across pages; note is the accumulated page-stated social fact.
function rosterText(c: CharacterEntry): string {
    const label = c.fullName && c.fullName !== c.name
        ? (c.name ? `${c.name} (${c.fullName})` : c.fullName)
        : c.name;
    // a user row shows exactly what the user typed; learned rows were filtered at admission
    const desc = c.source === 'user' ? (c.desc ?? '').trim() : usableText(c.desc);
    const line = label && desc && desc !== label ? `${label} — ${desc}`
        : label ? label
            : desc ? `(unnamed) ${desc}` : '(unnamed)';
    const note = (c.source === 'user' ? (c.note ?? '') : usableText(c.note)).trim().slice(0, 120);
    return note ? `${line} · ${note}` : line;
}

// Word-token overlap alone fails for scripts without spaces (Thai/Japanese/CJK read as one
// token), so one person re-described on the next page forked into two rows. Add character
// bigram Dice + containment of a long anchor; short distinct anchors (alpha1/alpha2) stay apart.
const normText = (s: string): string =>
    s.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').replace(/\s+/g, ' ').trim();
function wordSimilar(a: string, b: string): boolean {
    const wa = new Set(normText(a).split(' ').filter(w => w.length > 2));
    const wb = new Set(normText(b).split(' ').filter(w => w.length > 2));
    if (!wa.size || !wb.size) return false;
    let shared = 0;
    for (const w of wa) if (wb.has(w)) shared++;
    return shared / Math.min(wa.size, wb.size) >= 0.5;
}
function diceBigrams(a: string, b: string): number {
    const grams = (s: string): Set<string> => {
        const t = normText(s).replace(/ /g, '');
        const g = new Set<string>();
        if (t.length < 2) { if (t) g.add(t); return g; }
        for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
        return g;
    };
    const ga = grams(a), gb = grams(b);
    if (!ga.size || !gb.size) return 0;
    let shared = 0;
    for (const g of ga) if (gb.has(g)) shared++;
    return (2 * shared) / (ga.size + gb.size);
}
function similar(a: string, b: string): boolean {
    const na = normText(a), nb = normText(b);
    if (!na || !nb) return false;
    if (na === nb || wordSimilar(a, b)) return true;
    const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
    const sFlat = shorter.replace(/ /g, '');
    if (sFlat.length >= 10 && longer.replace(/ /g, '').includes(sFlat)) return true;
    // near-identical only: a reworded outfit ("ชุดสูท" vs "เสื้อยืด") measures 0.73
    return sFlat.length >= 12 && diceBigrams(a, b) >= 0.85;
}

// Thai long/short vowel pairs are the same vowel and models/OCR drop the length mark
// (ยูซุรุ vs ยุซุรุ); fold only those three pairs so มาลี/มาลา stay two people.
const foldThai = (s: string): string => s.replace(/ู/g, 'ุ').replace(/ี/g, 'ิ').replace(/ื/g, 'ึ');
const nameKey = (s: string): string => foldThai(stripHonorific(s).toLowerCase()).replace(/[^\p{L}\p{N}\p{M}]/gu, '');

// Two names = one person: exact match, vowel-length variance, or token subset. User override is the escape hatch.
function samePerson(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    const na = stripHonorific(a.toLowerCase().trim()), nb = stripHonorific(b.toLowerCase().trim());
    if (!na || !nb) return false;
    if (na === nb) return true;
    const ka = nameKey(na), kb = nameKey(nb);
    if (ka.length >= 3 && ka === kb) return true;
    const ta = new Set(na.split(/\s+/)), tb = new Set(nb.split(/\s+/));
    const [shorter, longer] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
    for (const t of shorter) if (!longer.has(t)) return false;
    return true;
}

// Eviction: unnamed non-user rows go first, then older lower-priority rows. Named and user
// rows survive while anything weaker exists; the cap yields only when every row is a user row.
function enforceCap(book: CharacterEntry[], max: number): CharacterEntry[] {
    if (book.length <= max) return book;
    const next = [...book];
    const rank = (c: CharacterEntry) => (c.name || c.fullName ? 10 : 0) + PRIORITY[c.source];
    while (next.length > max) {
        let victim = -1;
        for (let j = 0; j < next.length; j++) {
            if (next[j].source === 'user') continue;
            if (victim === -1 || rank(next[j]) < rank(next[victim])) victim = j;
        }
        if (victim === -1) break; // all user rows: never evict the user's own
        next.splice(victim, 1);
    }
    return next;
}

// A book forked by the old matcher (or a merge the model never ordered) heals here:
// rows with one name, an unnamed anchor that is just the other row's name, and two
// unnamed rows describing the same anchor fold. Conservative: a gender clash blocks the
// merge, and desc similarity alone never overrules a user row.
function canCoalesce(a: CharacterEntry, b: CharacterEntry): boolean {
    if (a.source === 'user' && b.source === 'user') return false; // two user rows: the user's call
    if (a.gender !== '?' && b.gender !== '?' && a.gender !== b.gender) return false;
    const an = a.name ?? a.fullName, bn = b.name ?? b.fullName;
    if (an && bn) return samePerson(an, bn);
    if (an || bn) return samePerson(an ?? bn, an ? b.desc : a.desc);
    if (a.source === 'user' || b.source === 'user') return false;
    return similar(a.desc, b.desc);
}

function absorbedSnap(c: CharacterEntry): AbsorbedRow {
    return { desc: c.desc, name: c.name, fullName: c.fullName, gender: c.gender };
}

// One row survives (a user row beats a learned one; otherwise the earlier row keeps its id);
// the dropped row is remembered in `absorbed` so the panel's Split can restore it.
function mergeRow(a: CharacterEntry, b: CharacterEntry): CharacterEntry {
    const keep = a.source === 'user' ? a : b.source === 'user' ? b : a;
    const drop = keep === a ? b : a;
    const sameText = drop.desc === keep.desc && drop.name === keep.name;
    return {
        ...keep,
        id: keep.id ?? drop.id,
        desc: keep.source === 'user' ? (keep.desc || drop.desc)
            : (drop.desc.length > keep.desc.length ? drop.desc : keep.desc),
        name: keep.name ?? drop.name,
        fullName: keep.fullName ?? drop.fullName,
        gender: keep.gender !== '?' ? keep.gender : drop.gender,
        source: PRIORITY[keep.source] >= PRIORITY[drop.source] ? keep.source : drop.source,
        note: joinNote(keep.note, drop.note),
        absorbed: sameText ? keep.absorbed
            : [...(keep.absorbed ?? []), absorbedSnap(drop), ...(drop.absorbed ?? [])].slice(-12),
    };
}

export function coalesceBook(book: CharacterEntry[]): CharacterEntry[] {
    const rows: CharacterEntry[] = [];
    for (const c of book) {
        const i = rows.findIndex(r => canCoalesce(r, c));
        if (i === -1) rows.push(c);
        else rows[i] = mergeRow(rows[i], c);
    }
    return rows;
}

// Panel/options row identity: the roster id once a row has one, else the desc (legacy rows).
export const charKey = (c: { id?: string; desc: string }): string => c.id ?? c.desc;

// User-driven row surgery. Merge keeps the target's id and never loses the dropped row —
// Split restores everything kept in `absorbed`.
export function mergeBookRows(book: CharacterEntry[], keepKey: string, dropKey: string): CharacterEntry[] {
    if (keepKey === dropKey) return book;
    const ki = book.findIndex(c => charKey(c) === keepKey);
    const di = book.findIndex(c => charKey(c) === dropKey);
    if (ki < 0 || di < 0) return book;
    const next = [...book];
    next[ki] = mergeRow(next[ki], next[di]);
    next.splice(di, 1);
    return next;
}

export function splitBookRow(book: CharacterEntry[], key: string): CharacterEntry[] {
    const i = book.findIndex(c => charKey(c) === key);
    if (i < 0 || !book[i].absorbed?.length) return book;
    const row = book[i];
    const restored: CharacterEntry[] = row.absorbed!.map(a => ({
        desc: a.desc, name: a.name, fullName: a.fullName,
        gender: a.gender !== '?' ? a.gender : row.gender,
        source: 'user' as const, // the split is the user's call: never re-fold it automatically
    }));
    const next = [...book];
    next.splice(i, 1, { ...row, absorbed: undefined }, ...restored);
    return next;
}

// Which row an observation belongs to: an exact id wins, otherwise name/desc similarity.
// mergeCharacter and the pair speaker tag share this so both derive the same identity.
function matchIndex(book: CharacterEntry[], obs: { id?: string; desc: string; name?: string; fullName?: string }): number {
    if (obs.id && book.some(c => c.id === obs.id)) return book.findIndex(c => c.id === obs.id);
    return book.findIndex(c =>
        similar(c.desc, obs.desc) ||
        samePerson(c.name, obs.name) ||
        samePerson(c.fullName, obs.fullName) ||
        samePerson(c.name, obs.fullName) ||
        samePerson(c.fullName, obs.name) ||
        // sourceless spk lands with name in desc — match against real names or they fragment
        samePerson(c.name, obs.desc) ||
        samePerson(obs.name, c.desc));
}

// Merge a new observation into the book. A known id is an exact identity match — no fuzzy
// guessing; otherwise names/descs fall back to similarity matching. User entries are never
// overwritten, and an unknown id never becomes an id (a fresh one is assigned instead).
export function mergeCharacter(book: CharacterEntry[], obs: CharacterEntry, maxChars = MAX_CHARACTERS): CharacterEntry[] {
    const norm = ensureIds(book);
    const i = matchIndex(norm, obs);
    if (i === -1) {
        const entry: CharacterEntry = { ...obs, id: undefined };
        return enforceCap(ensureIds([...norm, entry]), maxChars);
    }
    const cur = norm[i];
    const merged: CharacterEntry = {
        id: cur.id,
        desc: cur.desc.length >= obs.desc.length ? cur.desc : obs.desc,
        name: cur.name ?? obs.name,
        // fill unknown full name; two stated-but-different full names keep the first (user corrects in options)
        fullName: cur.fullName ?? obs.fullName,
        gender: cur.gender,
        source: cur.source,
        note: joinNote(cur.note, obs.note),
        absorbed: cur.absorbed,
    };
    // upgrade gender if current is unknown/lower-confidence
    if (obs.gender !== '?' && (cur.gender === '?' || PRIORITY[obs.source] > PRIORITY[cur.source])) {
        merged.gender = obs.gender;
        merged.source = PRIORITY[obs.source] >= PRIORITY[cur.source] ? obs.source : cur.source;
    }
    if (cur.source === 'user') {
        merged.gender = cur.gender; // user is law
        merged.source = 'user';
    }
    const next = [...norm];
    next[i] = merged;
    return next;
}

// Fold page outputs into context. 'keep' contributes nothing; mentions merge even when all regions are keep.
// learn=false: pairs still fold, characters don't. Vision outputs carry no source — translation alone still folds.
export interface ContextUpdate {
    ctx: ContextState;
    bookOps: BookOp[]; // merges/corrections the model ordered and validation approved
}

const bookLabel = (c: CharacterEntry): string => c.name || c.fullName || c.desc;

function findEntry(book: CharacterEntry[], ref: string, exclude = -1): number {
    const r = ref.trim();
    if (!r) return -1;
    if (/^c\d+$/i.test(r)) {
        const i = book.findIndex((c, j) => j !== exclude && c.id?.toLowerCase() === r.toLowerCase());
        if (i >= 0) return i;
    }
    return book.findIndex((c, i) => i !== exclude && (
        c.name === r || c.fullName === r || c.desc === r ||
        samePerson(c.name, r) || samePerson(c.fullName, r) || similar(c.desc, r)));
}

// Model-ordered book maintenance (sameAs/correct). Validates: both sides in sent book,
// no gender clash, user rows untouchable, corrections need a quote. Refs may be ids.
export function applyBookOps(book: CharacterEntry[], mentions: Mention[]): {
    characters: CharacterEntry[]; ops: BookOp[]; done: number[];
} {
    let characters = book;
    const ops: BookOp[] = [];
    const done: number[] = [];
    mentions.forEach((m, i) => {
        if ((!m.name && !m.id) || isNonPersonLabel(m.name) || (!m.sameAs && !m.correct && !m.note)) return;
        if (m.sameAs) {
            // resolve target first — main entry often matches BOTH refs, so source is searched outside target
            const si = findEntry(characters, m.sameAs);
            if (si < 0 || characters[si].source === 'user') return;
            const ti = m.id ? findEntry(characters, m.id, si) : findEntry(characters, m.name ?? '', si);
            if (ti < 0 || characters[ti].source === 'user') return;
            const t = characters[ti], s = characters[si];
            if (t.gender !== '?' && s.gender !== '?' && t.gender !== s.gender) return;
            const knownGender = t.gender !== '?' ? t.gender : s.gender;
            const merged: CharacterEntry = {
                // desc stays a visual anchor; the <m>'s role text is a social fact, not a look
                desc: t.desc.length >= s.desc.length ? t.desc : s.desc,
                // the <m>'s gender fills only a blank (priority 1 must not overrule vlm)
                gender: knownGender !== '?' ? knownGender : m.gender,
                source: PRIORITY[t.source] >= PRIORITY[s.source] ? t.source : s.source,
                name: t.name ?? s.name,
                fullName: t.fullName ?? s.fullName,
                id: t.id ?? s.id,
                note: joinNote(joinNote(t.note, s.note), usableText(m.desc)),
                absorbed: t.desc === s.desc && t.name === s.name ? t.absorbed
                    : [...(t.absorbed ?? []), absorbedSnap(s), ...(s.absorbed ?? [])].slice(-12),
            };
            const next = characters.filter((_, j) => j !== si);
            next[si < ti ? ti - 1 : ti] = merged;
            characters = next;
            ops.push({ kind: 'merge', from: bookLabel(s), into: bookLabel(t) });
            done.push(i);
        } else if (m.correct) {
            const now = m.now?.trim(), why = m.why?.trim();
            if (!now || !why) return; // no quote, no change
            const f = m.correct === 'g' || m.correct === 'gender' ? 'gender'
                : m.correct === 'name' ? 'name'
                : m.correct === 'desc' || m.correct === 'description' ? 'desc'
                : m.correct === 'full' || m.correct === 'fullname' ? 'fullName' : null;
            if (!f) return;
            const ci = m.id ? findEntry(characters, m.id) : findEntry(characters, m.name ?? '');
            if (ci < 0 || characters[ci].source === 'user') return;
            const t = characters[ci];
            const was = f === 'gender' ? t.gender : (t[f] ?? '');
            let val = now;
            if (f === 'gender') {
                if (normGender(now) === '?') return;
                val = normGender(now);
            }
            if (was === val) return;
            const nt: CharacterEntry = { ...t };
            if (f === 'gender') nt.gender = val as 'M' | 'F' | '?';
            else if (f === 'name') nt.name = val;
            else if (f === 'desc') nt.desc = val;
            else nt.fullName = val;
            const next = [...characters];
            next[ci] = nt;
            characters = next;
            ops.push({ kind: 'correct', from: bookLabel(t), field: f, was, now: val });
            done.push(i);
        } else if (m.note) {
            const val = usableText(m.note);
            if (!val || !m.why?.trim()) return; // no quote, no note
            const ci = m.id ? findEntry(characters, m.id) : findEntry(characters, m.name ?? '');
            if (ci < 0 || characters[ci].source === 'user') return;
            const t = characters[ci];
            const next = [...characters];
            next[ci] = { ...t, note: joinNote(t.note, val) };
            characters = next;
            ops.push({ kind: 'correct', from: bookLabel(t), field: 'note', was: t.note, now: val });
            done.push(i);
        }
    });
    return { characters, ops, done };
}

export function updateContext(
    ctx: ContextState,
    outputs: RegionOutput[],
    mentions: Mention[] = [],
    learn = true,
    maxPairs = MAX_PAIRS,
    maxChars = MAX_CHARACTERS,
): ContextUpdate {
    let characters = ctx.characters;
    let bookOps: BookOp[] = [];
    if (learn) {
        characters = normalizeBook(characters);
        for (const o of outputs) {
            if (!o.spk || o.translation === 'keep') continue;
            const desc = usableText(o.spk.desc);
            const name = usableText(o.spk.name);
            const knownId = o.spk.id ? characters.some(c => c.id === o.spk!.id) : false;
            // no anchor at all ("?", a box label, an empty description) → nothing to learn
            if (!desc && !name && !knownId) continue;
            characters = mergeCharacter(characters, {
                id: knownId ? o.spk.id : undefined,
                desc: desc || name,
                name: name || undefined,
                gender: o.spk.gender,
                source: (o.spk.desc ?? '').includes('guess') ? 'speech' : 'vlm',
            }, maxChars);
        }
        const applied = applyBookOps(characters, mentions);
        characters = applied.characters;
        bookOps = applied.ops;
        mentions.forEach((m, idx) => {
            const name = usableText(m.name);
            if (!name || applied.done.includes(idx) || isNonPersonLabel(m.desc)) return;
            characters = mergeCharacter(characters, {
                id: m.id, desc: '', name,
                fullName: usableText(m.fullName) || undefined, gender: m.gender, source: 'mention',
                // role/relation text is a social fact — it must not pollute the visual anchor
                note: joinNote(usableText(m.note), usableText(m.desc)),
            }, maxChars);
        });
    }
    // Recent lines carry the resolved speaker id: the next page keeps speaker continuity even
    // when its balloon has no tail. Resolution runs after learning, so a row born in this call
    // is tagged too; narration and unknown speakers keep the legacy two-element shape.
    const pairs = [...ctx.pairs];
    for (const o of outputs) {
        if (o.translation && o.translation !== 'keep') {
            const spk = speakerId(characters, o.spk);
            pairs.push(spk ? [o.source ?? '', o.translation, spk] : [o.source ?? '', o.translation]);
        }
    }
    return { ctx: { pairs: pairs.slice(-maxPairs), characters }, bookOps };
}

// The book row an output's speaker resolves to, for the speaker tag on recent translations.
// spk="new" resolves through the same match mergeCharacter used, so the tag names the row the
// model will see in the roster; a dead id or a non-person speaker resolves to nothing.
function speakerId(book: CharacterEntry[], spk: RegionOutput['spk']): string | undefined {
    if (!spk) return undefined;
    if (spk.id && book.some(c => c.id === spk.id)) return spk.id;
    const name = usableText(spk.name);
    const desc = usableText(spk.desc) || name;
    if (!desc) return undefined;
    const i = matchIndex(book, { desc, name: name || undefined });
    return i >= 0 ? book[i].id : undefined;
}

// A user edit on one roster row (options page / in-page panel). Keys are roster ids
// (charKey) with desc as the legacy fallback; every present field wins over learned data.
export interface CharOverride {
    gender: 'M' | 'F' | '?';
    name?: string;
    desc?: string;
    note?: string;
}

// Overrides are stored per book: ids restart at c1 in every story, so a bare id key leaked one
// manga's edit onto every other story that also had a c1. The scope prefix is the book key;
// a key without the separator is the legacy (unscoped) form and still resolves as a fallback.
const OV_SEP = '|';
export const overrideKey = (scope: string | undefined, key: string): string =>
    scope ? `${scope}${OV_SEP}${key}` : key;
export const bareKey = (k: string): string => {
    const i = k.lastIndexOf(OV_SEP);
    return i < 0 ? k : k.slice(i + 1);
};
// A book sees its own scoped keys plus the unscoped legacy ones; nothing from other books.
const ovBelongsTo = (k: string, scope: string | undefined): boolean => {
    const i = k.lastIndexOf(OV_SEP);
    if (i < 0) return true; // legacy/unscoped
    return scope !== undefined && k.slice(0, i) === scope;
};

// One-time claim: a legacy bare key matching a row of THIS book gets pinned to it before it
// can leak further. The claim can be no wronger than the unscoped behavior it replaces, and
// every book opened afterwards is clean.
export function claimLegacyOverrides(
    overrides: Record<string, CharOverride>,
    scope: string,
    keys: string[],
): { overrides: Record<string, CharOverride>; changed: boolean } {
    const next = { ...overrides };
    let changed = false;
    for (const k of keys) {
        if (!next[k]) continue;
        const scoped = overrideKey(scope, k);
        if (!next[scoped]) next[scoped] = next[k];
        delete next[k];
        changed = true;
    }
    return { overrides: next, changed };
}

// Move every override stored under one scope onto another (a chapter book promoted to a story
// book) so user edits survive the key change.
export function moveOverrides(
    overrides: Record<string, CharOverride>,
    from: string,
    to: string,
): { overrides: Record<string, CharOverride>; changed: boolean } {
    if (!from || from === to) return { overrides, changed: false };
    const next = { ...overrides };
    let changed = false;
    for (const k of Object.keys(next)) {
        if (!k.startsWith(from + OV_SEP)) continue;
        const target = to + k.slice(from.length);
        if (!next[target]) next[target] = next[k];
        delete next[k];
        changed = true;
    }
    return { overrides: next, changed };
}

// User overrides are law: fields forced, source promoted. Same-named entries collapse to one.
// The override key is a roster id when the row has one, otherwise the desc/name (legacy rows).
export function applyOverrides(
    ctx: ContextState,
    overrides: Record<string, CharOverride>,
    scope?: string,
): ContextState {
    if (!Object.keys(overrides).length) return ctx;
    const byName = new Map<string, CharOverride>();
    for (const [k, ov] of Object.entries(overrides)) {
        if (!ov.name || !ovBelongsTo(k, scope)) continue;
        const cur = byName.get(ov.name);
        // gender disagreement between same-named entries: keep the definite one
        if (!cur || ov.gender !== '?') byName.set(ov.name, ov);
    }
    const named = (c: CharacterEntry): CharOverride | undefined => {
        const key = charKey(c);
        const candidates: (CharOverride | undefined)[] = [
            scope ? overrides[overrideKey(scope, key)] : undefined,
            overrides[key],
        ];
        if (key !== c.desc) candidates.push(overrides[c.desc]);
        if (c.name) candidates.push(overrides[c.name], byName.get(c.name));
        return candidates.find(Boolean);
    };

    let collapsed: CharacterEntry[] = [];
    for (const c of ctx.characters) {
        const ov = named(c);
        const entry: CharacterEntry = ov
            ? {
                ...c,
                gender: ov.gender === '?' ? c.gender : ov.gender,
                source: 'user' as const,
                name: ov.name ?? c.name,
                desc: ov.desc ?? c.desc,
                note: ov.note ?? c.note,
            }
            : c;
        // same user name (or same desc) = same person: merge into one entry
        const i = collapsed.findIndex(e =>
            (entry.name && byName.has(entry.name) && e.name === entry.name) ||
            (entry.desc !== '' && e.desc === entry.desc));
        if (i === -1) { collapsed.push(entry); continue; }
        const cur = collapsed[i];
        collapsed[i] = {
            ...cur,
            // union the descriptions — more visual anchors for the model to match
            desc: cur.desc === entry.desc ? cur.desc : [cur.desc, entry.desc].filter(Boolean).join('; '),
            name: entry.name ?? cur.name,
            gender: entry.gender !== '?' ? entry.gender : cur.gender,
            note: joinNote(cur.note, entry.note),
        };
    }
    // overrides for characters not yet in the book (user knows better); a stale roster id
    // points at a row that no longer exists — nothing to attach it to
    const known = new Set(collapsed.map(c => c.desc));
    for (const [key, ov] of Object.entries(overrides)) {
        if (!ovBelongsTo(key, scope)) continue;
        const bare = bareKey(key);
        if (/^c\d+$/i.test(bare)) continue;
        const desc = ov.desc ?? bare;
        if (!known.has(desc) && !(ov.name && collapsed.some(c => c.name === ov.name))) {
            collapsed.push({ desc, gender: ov.gender, source: 'user', name: ov.name, note: ov.note });
        }
    }
    collapsed = ensureIds(collapsed).slice(0, MAX_CHARACTERS);
    return { ...ctx, characters: collapsed };
}
