// LLM prompt building + response parsing + character book merge.
// Pure logic — unit tested in tests/llm.test.mjs (node:test, no browser APIs).

export interface CharacterEntry {
    desc: string;          // visual/behavioral description ("twintail girl in school uniform")
    gender: 'M' | 'F' | '?' ;
    source: 'user' | 'vlm' | 'speech' | 'mention'; // priority for merges: user > vlm > speech = mention
    name?: string;         // short/display name ("ยามาดะ")
    fullName?: string;     // full name ONLY when a page states it — never assembled or guessed
}

// A person NAMED in page dialogue/narration — page-level, unlike per-region spk.
// Text-based, works in every textSource mode including crops and OCR.
export interface Mention {
    name: string;
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
}

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
): string {
    const lang = opts.targetLang?.trim() || 'Thai';
    const chars = opts.chars !== false;
    // VLM-OCR stage: pure transcription, same <r> shape so caller reuses parseResponse.
    // No book/pairs/style: a read must not be biased.
    if (opts.transcribeOnly) {
        // per-region variant: one crop in, ONE element out — never split lines into numbered elements.
        if (opts.transcribeOne) {
            return `<task>Transcribe the text in this single manga region EXACTLY as written. Do NOT translate.</task>
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
<regions>
1 (read from image)
</regions>
`;
        }
        let t = `<task>Transcribe the text in each numbered manga region EXACTLY as written. Do NOT translate.</task>\n`;
        if (vision && opts.textOnly) {
            t += `<images>Each image is the crop of region 1, 2, … in order — transcribe each region from its own crop. There is no full-page image.</images>\n`;
        } else if (vision) {
            t += `<images>First image = full page with red number badges; the following images are crops of region 1, 2, … in order. Transcribe each region from its crop; use the full page for context.</images>\n`;
        }
        t += `<output_format>Output EXACTLY this XML — one element per region, nothing else:
<r n="REGION">exact transcription</r>
<r n="REGION" keep="true"/>

The second form (self-closing, keep="true", NO text inside) is ONLY for regions with no readable text (drawings, patterns, faces, objects, scenery). Transcribe everything readable INCLUDING stylized sound-effect lettering — do not judge, do not translate, do not clean up.
<example>
<r n="1">一緒に来てくれないか</r>
<r n="2">ドン</r>
<r n="3" keep="true"/>
</example></output_format>\n`;
        t += `<rules>\n- Copy character-for-character — no paraphrase, no cleanup, no guessing unreadable glyphs (those regions are keep). Never translate.\n</rules>\n`;
        t += '<regions>\n';
        for (const r of regions) t += `${r.index} (read from image)\n`;
        return t + '</regions>\n';
    }
    // XML-structured prompt: explicit tags keep instructions apart from data; output is XML too.
    let p = `<task>Translate the numbered manga regions into ${lang}.</task>\n`;
    if (vision && opts.textOnly) {
        p += `<images>Each image is the crop of region 1, 2, … in order — read each region from its own crop. There is no full-page image: you see only the text boxes, not the surrounding artwork.</images>\n`;
    } else if (vision) {
        p += `<images>First image = full page with red number badges; the following images are crops of region 1, 2, … in order. Read each region from its crop; use the full page for context.</images>\n`;
    }
    p += `<output_format>Output EXACTLY this XML — one element per region, nothing else:
<r n="REGION"${opts.transcribeSrc && !opts.ocr ? ' src="this region\'s original text, copied EXACTLY as written"' : ''}${chars ? ' spk="who is speaking (from the crop)" g="M|F|?" name="given name if the page states it"' : ''}>${lang} translation</r>
<r n="REGION" keep="true"/>

The second form (self-closing, keep="true", NO text inside) is for regions you do NOT translate:
- no readable text in the crop: drawings, patterns, faces, objects, scenery, a silent reaction panel
- SFX/onomatopoeia: stylized lettering drawn OVER the artwork (katakana like ドン/チッ, BOOM, DING DONG) — even if readable, even bubble-shaped
- signatures, watermarks
Never put a description, brackets, or invented dialogue in a keep element. Never leave a translation empty — if there is nothing to translate, it is a keep element.
${chars ? `
name is OPTIONAL: set it only when THIS page states the speaker's actual name (introduction, narration naming them, a name label) — write it in ${lang} form. Omit it when the page doesn't say.
spk is a PERSON only: for narration boxes, signs, labels, SFX and any text that is not a person speaking, omit spk/g/name entirely — never write a box type (narration, sign, caption, SFX) as spk.
` : ``}
<example>
<r n="1"${opts.transcribeSrc && !opts.ocr ? ' src="一緒に来てくれないか"' : ''}${chars ? ' spk="boy with spiky hair" g="M" name="ยามาดะ"' : ''}>ไปด้วยกันไหมครับ</r>
<r n="2"${opts.transcribeSrc && !opts.ocr ? ' src="山田、やめてよね"' : ''}${chars ? ' spk="twintail girl" g="F"' : ''}>ยามาดะ หยุดเถอะนะ</r>
<r n="3" keep="true"/>
</example>${chars ? `

After the regions, if anyone is NAMED in the dialogue or narration (the speaker, someone addressed, or someone talked about), append one block:
<names>
<m name="short name" full="full name ONLY if the page states it" g="M|F">who this is in one short phrase (role or relation, not looks)</m>
</names>
Omit the whole block when no one is named. full: never assemble or guess a surname — leave it out unless the page says the full name. g: only when the page makes it obvious (particles, pronouns, explicit words); otherwise leave it out. Never invent a person.
Credits, bylines and copyright text (author/artist names on a cover or credits panel) are not story characters — never report them.
Two entries in <known_characters> are the same person: <m name="A" sameAs="B">…</m> (both must be in the book).
The book is wrong and THIS page proves it: <m name="A" correct="gender|name|desc|full" now="new value" why="exact quote from this page">…</m> — no quote, no change. Never touch entries marked "confirmed by user".` : ``}</output_format>\n`;
    p += `<rules>\n- ${LANG_RULES[lang] ?? GENERIC_RULE(lang)}\n`;
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
    if (chars) p += '- Named people: report only names actually written on the page — never guess a surname or a gender from a name.\n';
    if (opts.vlmAssisted && opts.pageW && opts.pageH && !(vision && opts.textOnly)) {
        p += `- Missed text (no badge): <extra n="new" x="x1,y1,x2,y2">${lang} translation</extra> (pixels on the ${opts.pageW}x${opts.pageH} first image). Dialogue only, no SFX.\n`;
    }
    p += `</rules>\n`;
    // a book polluted with box-type rows must not teach them back — user rows stay, they are the user's call
    const book = chars ? ctx.characters.filter(c => c.source === 'user' || !isNonPersonLabel(c.name ?? c.desc)) : [];
    if (book.length) {
        p += '<known_characters>\n';
        for (const c of book) {
            const label = c.fullName && c.fullName !== c.name
                ? (c.name ? `${c.name} (${c.fullName})` : c.fullName)
                : c.name;
            p += `- ${label ? label + ': ' : ''}${c.desc} [gender: ${c.gender}${c.source === 'user' ? ', confirmed by user' : ''}] — always use this name for this character\n`;
        }
        p += '</known_characters>\n';
    }
    if (ctx.pairs.length) {
        const maxPairs = opts.maxPairs ?? MAX_PAIRS;
        p += '<recent_translations>\n';
        for (const [s, t] of ctx.pairs.slice(-maxPairs)) {
            p += s ? `- ${s} => ${t}\n` : `- (previous page) ${t}\n`;
        }
        p += '</recent_translations>\n';
    }
    p += '<regions>\n';
    for (const r of regions) {
        // no size numbers by design (see COMPLETENESS) — renderer fits whatever comes back
        p += r.source ? `${r.index} ${r.source}\n` : `${r.index} (read from image)\n`;
    }
    p += '</regions>\n';
    return p;
}

// Split at <regions>: everything before is stable across pages. Anthropic breakpoint goes here; null when missing.
export function splitStablePrefix(prompt: string): { stable: string; varying: string } | null {
    const i = prompt.indexOf('\n<regions>');
    if (i < 0) return null;
    return { stable: prompt.slice(0, i + 1), varying: prompt.slice(i + 1) };
}

export interface RegionOutput {
    index: number;
    source: string;
    translation: string;
    spk: { desc: string; gender: 'M' | 'F' | '?'; name?: string } | null;
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
        const spk = attrs.spk ? { desc: attrs.spk, gender: normGender(attrs.g), name: attrs.name?.trim() || undefined } : null;
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
        if (!name) continue; // a mention without a name merges with nothing
        const full = attrs.full?.trim();
        mentions.push({
            name, fullName: full || undefined, gender: normGender(attrs.g), desc: (e[3] ?? '').trim().slice(0, 160),
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

// Merge a new observation into the book. User entries are never overwritten.
export function mergeCharacter(book: CharacterEntry[], obs: CharacterEntry): CharacterEntry[] {
    const i = book.findIndex(c =>
        similar(c.desc, obs.desc) ||
        samePerson(c.name, obs.name) ||
        samePerson(c.fullName, obs.fullName) ||
        samePerson(c.name, obs.fullName) ||
        samePerson(c.fullName, obs.name) ||
        // sourceless spk lands with name in desc — match against real names or they fragment
        samePerson(c.name, obs.desc) ||
        samePerson(obs.name, c.desc));
    if (i === -1) {
        const next = [...book, obs];
        if (next.length > MAX_CHARACTERS) {
            // Evict OLDEST lowest-priority row (book is append-ordered). User rows never evict.
            while (next.length > MAX_CHARACTERS) {
                let victim = 0;
                for (let j = 1; j < next.length; j++) {
                    if (PRIORITY[next[j].source] < PRIORITY[next[victim].source]) victim = j;
                }
                next.splice(victim, 1);
            }
        }
        return next;
    }
    const cur = book[i];
    const merged: CharacterEntry = {
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
    const next = [...book];
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
    return book.findIndex((c, i) => i !== exclude && (
        c.name === r || c.fullName === r || c.desc === r ||
        samePerson(c.name, r) || samePerson(c.fullName, r) || similar(c.desc, r)));
}

// Model-ordered book maintenance (sameAs/correct). Validates: both sides in sent book,
// no gender clash, user rows untouchable, corrections need a quote.
export function applyBookOps(book: CharacterEntry[], mentions: Mention[]): {
    characters: CharacterEntry[]; ops: BookOp[]; done: number[];
} {
    let characters = book;
    const ops: BookOp[] = [];
    const done: number[] = [];
    mentions.forEach((m, i) => {
        if (!m.name || isNonPersonLabel(m.name) || (!m.sameAs && !m.correct)) return;
        if (m.sameAs) {
            // resolve target first — main entry often matches BOTH refs, so source is searched outside target
            const si = findEntry(characters, m.sameAs);
            if (si < 0 || characters[si].source === 'user') return;
            const ti = findEntry(characters, m.name, si);
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
            const ci = findEntry(characters, m.name);
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
): ContextUpdate {
    const pairs = [...ctx.pairs];
    for (const o of outputs) {
        if (o.translation && o.translation !== 'keep') pairs.push([o.source ?? '', o.translation]);
    }
    let characters = ctx.characters;
    let bookOps: BookOp[] = [];
    if (learn) {
        for (const o of outputs) {
            if (o.spk && o.spk.desc && o.translation !== 'keep'
                && !isNonPersonLabel(o.spk.desc) && !isNonPersonLabel(o.spk.name)) {
                characters = mergeCharacter(characters, { ...o.spk, source: o.spk.desc.includes('guess') ? 'speech' : 'vlm' });
            }
        }
        const applied = applyBookOps(characters, mentions);
        characters = applied.characters;
        bookOps = applied.ops;
        mentions.forEach((m, idx) => {
            if (!m.name || applied.done.includes(idx) || isNonPersonLabel(m.name) || isNonPersonLabel(m.desc)) return;
            characters = mergeCharacter(characters, {
                desc: m.desc || m.name, name: m.name, fullName: m.fullName, gender: m.gender, source: 'mention',
            });
        });
    }
    return { ctx: { pairs: pairs.slice(-maxPairs), characters }, bookOps };
}

// User overrides are law: gender forced, source promoted. Same-named entries collapse to one.
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
    const named = (desc: string, name?: string) =>
        overrides[desc] ?? (name ? overrides[name] : undefined) ?? (name ? byName.get(name) : undefined);

    const collapsed: CharacterEntry[] = [];
    for (const c of ctx.characters) {
        const ov = named(c.desc, c.name);
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
    return { ...ctx, characters: collapsed.slice(0, MAX_CHARACTERS) };
}
