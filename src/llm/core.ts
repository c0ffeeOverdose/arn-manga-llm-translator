// LLM prompt building + response parsing + character book merge.
// Pure logic — unit tested in tests/llm.test.mjs (node:test, no browser APIs).

export interface CharacterEntry {
    id?: string;           // stable roster id ("c3") — spk and <m> ops reference this row
    desc: string;          // visual/behavioral description ("twintail girl in school uniform")
    gender: 'M' | 'F' | '?' ;
    source: 'user' | 'vlm' | 'speech' | 'mention'; // priority for merges: user > vlm > speech = mention
    name?: string;         // short/display name ("ยามาดะ")
    fullName?: string;     // full name ONLY when a page states it — never assembled or guessed
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
}

export interface BookOp {
    kind: 'merge' | 'correct';
    from: string;          // entry label before the op
    into?: string;         // merge target label
    field?: string;        // corrected field
    was?: string;
    now?: string;
}

export interface ContextState {
    pairs: [string, string][];      // recent lines (source => translation; source is '' in vision modes)
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
    // roster up front: the example below must not reference an id that does not exist yet
    const roster = chars ? normalizeBook(ctx.characters).slice(0, opts.charLimit ?? MAX_CHARACTERS) : [];
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
- spk: a character id from <known_characters> (c1, c2, …); if the speaker is NOT listed use spk="new" with desc="short visual anchor" (name="…" only when this page states it).
- Omit spk/desc/g/name for anything that is not a person speaking (narration, signs, labels, SFX); if you cannot tell who speaks, omit spk rather than guess.
- name: only when THIS page states the character's name, in ${lang} form; never repeat a name the book already lists.
<example>
<r n="1"${opts.transcribeSrc && !opts.ocr ? ' src="一緒に来てくれないか"' : ''} ${roster.length ? 'spk="c1" g="F"' : 'spk="new" desc="girl with red ribbon" g="F"'}>ไปด้วยกันไหมครับ</r>
<r n="2"${opts.transcribeSrc && !opts.ocr ? ' src="山田、やめてよね"' : ''} spk="new" desc="boy with spiky hair" g="M" name="ยามาดะ">ยามาดะ หยุดเถอะนะ</r>
<r n="3" keep="true"/>
</example>

After the regions, if anyone is NAMED in the dialogue or narration (the speaker, someone addressed, or someone talked about), append one block:
<names>
<m name="short name" full="full name ONLY if the page states it" g="M|F">role or relation ONLY when the page states one — omit the text otherwise</m>
</names>
Omit the whole block when no one is named. full: never assemble or guess a surname. g: only when the page makes it obvious (particles, pronouns, explicit words); otherwise leave it out. Never invent a person. Never describe where or how the name appeared (a name tag, someone mentioning them, the chapter title) — that is not a role.
Credits, bylines and copyright text (author/artist names on a cover or credits panel) are not story characters — never report them.
Two entries in <known_characters> are the same person: <m id="c4" sameAs="c2"/> or <m name="A" sameAs="B">…</m> (both must be in the book).
The book is wrong and THIS page proves it: <m id="c2" correct="gender|name|desc|full" now="new value" why="exact quote from this page"/> — no quote, no change. Reference an entry by id or by its listed name. Never touch entries marked "confirmed by user".
` : ``}</output_format>\n`;
    p += `<rules>\n- ${LANG_RULES[lang] ?? GENERIC_RULE(lang)}\n`;
    if (chars && vision && !opts.textOnly && !opts.ocr) {
        p += '- Speaker: match each spoken region to a listed id — use the full page: bubble tail, who shares the panel, who the line addresses, continuity with earlier pages.\n';
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
        for (const [s, t] of ctx.pairs.slice(-maxPairs)) {
            u += s ? `- ${s} => ${t}\n` : `- (previous page) ${t}\n`;
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
// punctuation-only text and box-type labels are not a description of a person.
const JUNK_TEXT = /^[?？!！。．.\-–—~〜*＊_×xX\s]+$/;
function usableText(s: string | undefined): string {
    const t = (s ?? '').trim();
    return t && !JUNK_TEXT.test(t) && !isNonPersonLabel(t) ? t : '';
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

// One hygiene pass: drop non-user rows with no usable identity (legacy "?" junk), then give
// every remaining row an id. User rows survive even when malformed — their call, not ours.
export function normalizeBook(book: CharacterEntry[]): CharacterEntry[] {
    const kept = book.filter(c => c.source === 'user' || !!(c.name || c.fullName || usableText(c.desc)));
    return ensureIds(kept);
}

// Roster line for the prompt: name — role; "(unnamed)" anchors are how a speaker without a
// name still gets matched across pages.
function rosterText(c: CharacterEntry): string {
    const label = c.fullName && c.fullName !== c.name
        ? (c.name ? `${c.name} (${c.fullName})` : c.fullName)
        : c.name;
    // a user row shows exactly what the user typed; learned rows were filtered at admission
    const desc = c.source === 'user' ? (c.desc ?? '').trim() : usableText(c.desc);
    if (label && desc && desc !== label) return `${label} — ${desc}`;
    if (label) return label;
    return desc ? `(unnamed) ${desc}` : '(unnamed)';
}

function similar(a: string, b: string): boolean {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ก-๙ ]/g, ' ').replace(/\s+/g, ' ').trim();
    const wa = new Set(norm(a).split(' ').filter(w => w.length > 2));
    const wb = new Set(norm(b).split(' ').filter(w => w.length > 2));
    if (!wa.size || !wb.size) return false;
    let shared = 0;
    for (const w of wa) if (wb.has(w)) shared++;
    return shared / Math.min(wa.size, wb.size) >= 0.5;
}

// Two names = one person: exact match or token subset. User override is the escape hatch.
function samePerson(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    const na = stripHonorific(a.toLowerCase().trim()), nb = stripHonorific(b.toLowerCase().trim());
    if (!na || !nb) return false;
    if (na === nb) return true;
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

// Merge a new observation into the book. A known id is an exact identity match — no fuzzy
// guessing; otherwise names/descs fall back to similarity matching. User entries are never
// overwritten, and an unknown id never becomes an id (a fresh one is assigned instead).
export function mergeCharacter(book: CharacterEntry[], obs: CharacterEntry, maxChars = MAX_CHARACTERS): CharacterEntry[] {
    const norm = ensureIds(book);
    const knownId = obs.id ? norm.some(c => c.id === obs.id) : false;
    const i = knownId ? norm.findIndex(c => c.id === obs.id) : norm.findIndex(c =>
        similar(c.desc, obs.desc) ||
        samePerson(c.name, obs.name) ||
        samePerson(c.fullName, obs.fullName) ||
        samePerson(c.name, obs.fullName) ||
        samePerson(c.fullName, obs.name) ||
        // sourceless spk lands with name in desc — match against real names or they fragment
        samePerson(c.name, obs.desc) ||
        samePerson(obs.name, c.desc));
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
        if ((!m.name && !m.id) || isNonPersonLabel(m.name) || (!m.sameAs && !m.correct)) return;
        if (m.sameAs) {
            // resolve target first — main entry often matches BOTH refs, so source is searched outside target
            const si = findEntry(characters, m.sameAs);
            if (si < 0 || characters[si].source === 'user') return;
            const ti = m.id ? findEntry(characters, m.id, si) : findEntry(characters, m.name ?? '', si);
            if (ti < 0 || characters[ti].source === 'user') return;
            const t = characters[ti], s = characters[si];
            if (t.gender !== '?' && s.gender !== '?' && t.gender !== s.gender) return;
            const mdesc = m.desc ?? '';
            const knownGender = t.gender !== '?' ? t.gender : s.gender;
            const merged: CharacterEntry = {
                desc: mdesc.length > Math.max(t.desc.length, s.desc.length) ? mdesc : (t.desc.length >= s.desc.length ? t.desc : s.desc),
                // the <m>'s gender fills only a blank (priority 1 must not overrule vlm)
                gender: knownGender !== '?' ? knownGender : m.gender,
                source: PRIORITY[t.source] >= PRIORITY[s.source] ? t.source : s.source,
                name: t.name ?? s.name,
                fullName: t.fullName ?? s.fullName,
                id: t.id ?? s.id,
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
    const pairs = [...ctx.pairs];
    for (const o of outputs) {
        if (o.translation && o.translation !== 'keep') pairs.push([o.source ?? '', o.translation]);
    }
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
                id: m.id, desc: usableText(m.desc) || name, name,
                fullName: usableText(m.fullName) || undefined, gender: m.gender, source: 'mention',
            }, maxChars);
        });
    }
    return { ctx: { pairs: pairs.slice(-maxPairs), characters }, bookOps };
}

// User overrides are law: gender forced, source promoted. Same-named entries collapse to one.
// The override key is a roster id when the row has one, otherwise the desc/name (legacy rows).
export function applyOverrides(
    ctx: ContextState,
    overrides: Record<string, { gender: 'M' | 'F' | '?'; name?: string }>,
): ContextState {
    if (!Object.keys(overrides).length) return ctx;
    const byName = new Map<string, { gender: 'M' | 'F' | '?'; name?: string }>();
    for (const ov of Object.values(overrides)) {
        if (!ov.name) continue;
        const cur = byName.get(ov.name);
        // gender disagreement between same-named entries: keep the definite one
        if (!cur || ov.gender !== '?') byName.set(ov.name, ov);
    }
    const named = (c: CharacterEntry) =>
        (c.id ? overrides[c.id] : undefined) ?? overrides[c.desc] ?? (c.name ? overrides[c.name] : undefined) ?? (c.name ? byName.get(c.name) : undefined);

    let collapsed: CharacterEntry[] = [];
    for (const c of ctx.characters) {
        const ov = named(c);
        const entry: CharacterEntry = ov
            ? { ...c, gender: ov.gender === '?' ? c.gender : ov.gender, source: 'user' as const, name: ov.name ?? c.name }
            : c;
        // same user name (or same desc) = same person: merge into one entry
        const i = collapsed.findIndex(e =>
            (entry.name && byName.has(entry.name) && e.name === entry.name) || e.desc === entry.desc);
        if (i === -1) { collapsed.push(entry); continue; }
        const cur = collapsed[i];
        collapsed[i] = {
            ...cur,
            // union the descriptions — more visual anchors for the model to match
            desc: cur.desc === entry.desc ? cur.desc : `${cur.desc}; ${entry.desc}`,
            name: entry.name ?? cur.name,
            gender: entry.gender !== '?' ? entry.gender : cur.gender,
        };
    }
    // overrides for characters not yet in the book (user knows better)
    const known = new Set(collapsed.map(c => c.desc));
    for (const [desc, ov] of Object.entries(overrides)) {
        if (!known.has(desc) && !(ov.name && collapsed.some(c => c.name === ov.name))) {
            collapsed.push({ desc, gender: ov.gender, source: 'user', name: ov.name });
        }
    }
    collapsed = ensureIds(collapsed).slice(0, MAX_CHARACTERS);
    return { ...ctx, characters: collapsed };
}
