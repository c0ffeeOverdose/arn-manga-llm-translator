// LLM prompt building + response parsing + character book merge.
// Pure logic — unit tested in tests/llm.test.mjs (node:test, no browser APIs).

export interface CharacterEntry {
    desc: string;          // visual/behavioral description ("twintail girl in school uniform")
    gender: 'M' | 'F' | '?' ;
    source: 'user' | 'vlm' | 'speech' | 'mention'; // priority for merges: user > vlm > speech = mention
    name?: string;         // short/display name ("ยามาดะ")
    fullName?: string;     // full name ONLY when a page states it — never assembled or guessed
}

// A person NAMED in the page's dialogue/narration (speaker, addressee, or
// talked-about) — page-level, unlike spk which is per-region. Text-based, so
// this channel works in every textSource mode including crops and OCR.
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
}

// Language-specific translation rules. Thai gets the full particle rule;
// every other language gets the generic gendered-speech rule (the model
// knows Spanish/French/etc. agreement on its own).
// Completeness over brevity, always: the renderer shrink-to-fits the font,
// so the rules push for complete meaning (an old char-budget hint made the
// model elide subjects/aspect — "WE STARTED LIVING TOGETHER" → "เริ่มอยู่ด้วยกัน" —
// and numeric hints anchor even next to "translate fully", so no size numbers
// go into the prompt at all).
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
    // XML-structured prompt (prompt-engineering standard): every section is
    // an explicit tag so the model can't confuse instructions with data —
    // rules never bleed into region lists, character notes never read as
    // dialogue. The output format is XML too (keep is a structurally
    // different element, ending the "=> (ไม่มีข้อความ)" compromise drift).
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
    // transcribeSrc toggle: the model copies source text into src so vision
    // modes get full (source => translation) context pairs (OCR mode sends no
    // images — nothing to transcribe, so the flag is ignored there)
    if (opts.transcribeSrc && !opts.ocr) {
        p += `- Transcribe first: copy each region's original text EXACTLY into src, character-for-character — no paraphrase, no cleanup, no guessing unreadable glyphs (leave those regions keep). Then translate.\n`;
    }
    if (chars) p += '- Named people: report only names actually written on the page — never guess a surname or a gender from a name.\n';
    if (opts.vlmAssisted && opts.pageW && opts.pageH && !(vision && opts.textOnly)) {
        p += `- Missed text (no badge): <extra n="new" x="x1,y1,x2,y2">${lang} translation</extra> (pixels on the ${opts.pageW}x${opts.pageH} first image). Dialogue only, no SFX.\n`;
    }
    p += `</rules>\n`;
    if (chars && ctx.characters.length) {
        p += '<known_characters>\n';
        for (const c of ctx.characters) {
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
        // no size numbers here by design (see COMPLETENESS above) — just the
        // index and the source; the renderer fits whatever comes back
        p += r.source ? `${r.index} ${r.source}\n` : `${r.index} (read from image)\n`;
    }
    p += '</regions>\n';
    return p;
}

// Split a buildPrompt output at <regions> — everything before it (task, rules,
// character book, recent translations) is stable across pages of the same
// manga; the region list (and any images sent after it) changes every page.
// Used by the Anthropic adapter to place its cache_control breakpoint on the
// stable prefix. Null when the boundary is missing (degenerate prompt).
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

// XML output parser — the primary format. Tolerant of the usual LLM slips:
// self-closing keeps, paired elements, UNCLOSED elements (content runs to
// the next tag or end of line), extra whitespace/preambles.
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

// Parse the XML output format. If the model ignored the format entirely,
// an empty result triggers the caller's retry (status says so — never silent).
export function parseResponse(text: string, expected: number): ParsedResponse {
    return parseXml(text, expected) ?? { regions: [], extras: [], mentions: [] };
}

// A model answer that DESCRIBES the crop instead of translating it — almost
// always "this is not text" said in prose. Checked against the FINAL
// translation (after spk/arrow extraction) so a trailing "|| spk: girl, F"
// doesn't break matching.
// NOTE: there used to be a whole-wrapped-bracket rule here ("[...]" = meta).
// Removed: it ate faithful bracketed translations (live: a system message
// "[WELCOME...]" → "[ยินดีต้อนรับ...]" parsed as keep). Bracket-styled leaks
// ([ตกใจ], "(no readable text)") now render — re-add a narrower guard only
// if one is seen live again.
function isMetaNoText(t: string): boolean {
    const whole = t.trim();
    // explicit no-text phrasing anywhere (thai + english), spacing-tolerant
    return /ไม่มี\s*ข้อความ|ไม่มี\s*ตัวอักษร|ไม่มี\s*บทพูด|ไม่ใช่\s*ข้อความ|no\s+(readable\s+)?text|no dialogue|not text/i.test(whole);
}

// ---- character book ----
const PRIORITY: Record<CharacterEntry['source'], number> = { user: 3, vlm: 2, speech: 1, mention: 1 };

function similar(a: string, b: string): boolean {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ก-๙ ]/g, ' ').replace(/\s+/g, ' ').trim();
    const wa = new Set(norm(a).split(' ').filter(w => w.length > 2));
    const wb = new Set(norm(b).split(' ').filter(w => w.length > 2));
    if (!wa.size || !wb.size) return false;
    let shared = 0;
    for (const w of wa) if (wb.has(w)) shared++;
    return shared / Math.min(wa.size, wb.size) >= 0.5;
}

// Two name strings = one person: exact match, or one's tokens are a subset
// of the other's ("ยามาดะ" ~ "ยามาดะ ทาโร่"). Same-surname collisions across
// different characters are possible; the user override is the escape hatch.
function samePerson(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    const na = a.toLowerCase().trim(), nb = b.toLowerCase().trim();
    if (!na || !nb || na === nb) return na === nb;
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
        // sourceless spk observations land with the name in desc ("เอย์จิ" with
        // name '') — match them against real names or they fragment forever
        samePerson(c.name, obs.desc) ||
        samePerson(obs.name, c.desc));
    if (i === -1) {
        const next = [...book, obs];
        if (next.length > MAX_CHARACTERS) {
            // evict lowest-priority, oldest
            next.sort((a, b) => PRIORITY[b.source] - PRIORITY[a.source]);
            next.length = MAX_CHARACTERS;
        }
        return next;
    }
    const cur = book[i];
    const merged: CharacterEntry = {
        desc: cur.desc.length >= obs.desc.length ? cur.desc : obs.desc,
        name: cur.name ?? obs.name,
        // fill an unknown full name; two stated-but-different full names keep the
        // first (first-wins naming — the user corrects it in options)
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

// Fold a page's outputs into the context state. 'keep' regions contribute
// nothing (no pair, no character). mentions are page-level (named people from
// dialogue/narration) and merge even when every region is keep — the model
// only emits the block when the page actually names someone.
// learn=false (useCharacters off): pairs still fold, characters don't.
// In vision modes outputs carry no source — the translation alone still
// folds (source '') so later pages keep dialogue continuity.
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

// Model-ordered book maintenance (sameAs/correct on <m>). The model proposes,
// this validates: both sides must be in the sent book, genders must not
// clash, user rows are untouchable, corrections need a quote. Returns which
// mention indices were consumed so the caller still learns the rest normally.
export function applyBookOps(book: CharacterEntry[], mentions: Mention[]): {
    characters: CharacterEntry[]; ops: BookOp[]; done: number[];
} {
    let characters = book;
    const ops: BookOp[] = [];
    const done: number[] = [];
    mentions.forEach((m, i) => {
        if (!m.name || (!m.sameAs && !m.correct)) return;
        if (m.sameAs) {
            // resolve the target first — the main entry often matches BOTH refs
            // (name + fullName), so the source is searched outside the target
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
                // the <m>'s own gender fills only a blank (priority 1 must not
                // overrule what vlm already established on either side)
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
            if (o.spk && o.spk.desc && o.translation !== 'keep') {
                characters = mergeCharacter(characters, { ...o.spk, source: o.spk.desc.includes('guess') ? 'speech' : 'vlm' });
            }
        }
        const applied = applyBookOps(characters, mentions);
        characters = applied.characters;
        bookOps = applied.ops;
        mentions.forEach((m, idx) => {
            if (!m.name || applied.done.includes(idx)) return;
            characters = mergeCharacter(characters, {
                desc: m.desc || m.name, name: m.name, fullName: m.fullName, gender: m.gender, source: 'mention',
            });
        });
    }
    return { ctx: { pairs: pairs.slice(-maxPairs), characters }, bookOps };
}

// Apply user overrides (from the options page) on top of the learned book.
// User entries are law: gender forced, source promoted to 'user'.
// Entries the user gave the SAME name are one person — collapse them so the
// model-fragmented book ("spiky-haired guy" + "inspector with spiky hair")
// presents a single canonical character with the user's name.
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
