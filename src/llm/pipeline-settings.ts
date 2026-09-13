// Central pipeline settings: schema, tuned defaults (validated via E2E),
// quality presets, and defensive load/merge.
// Pure logic — unit tested in tests/settings.test.mjs.

export interface PipelineSettings {
    preset: string;            // 'balanced' | 'fast' | 'best' | 'custom'
    // detection
    detConf: number;           // CTD confidence threshold
    detMinSize: number;        // min region side in px (kills texture false positives)
    panelConf: number;         // YOLO panel confidence (bleed panels need ~0.2)
    deferLabels: boolean;      // small clustered labels read after balloon dialogue
    transcribeSrc: boolean;    // vision modes: model also transcribes source text (options toggle, ~2x output tokens)
    inferEngine: 'local' | 'cloud'; // where panel+detect+OCR run (cloud = your Modal endpoint, opt-in)
    detEp: 'auto' | 'wasm';     // CTD execution provider: auto = webgpu (wasm fallback), wasm = force CPU (broken GPU drivers, ~10x slower)
    cacheEnabled: boolean;     // reuse translations when reopening pages (read + write)
    cacheMax: number;          // stored-page cap (LRU oldest-first, 10-1000)
    // image → LLM
    fullPageSize: number;      // annotated page long side px
    cropSize: number;          // region crop long side px
    jpegQuality: number;
    grayscaleBw: boolean;      // strip color for B&W pages (≈3x smaller)
    // translation
    // how text reaches the LLM — the ONE axis (replaces useVision/visionMode/ocrModel):
    // 'page'  = VLM reads: annotated full page + region crops (best; needs image support)
    // 'crops' = VLM reads: region crops only (artwork never sent — safety-filter dodge)
    // 'ocr'   = Tesseract reads locally, LLM gets text only (works with text-only models)
    textSource: 'page' | 'crops' | 'ocr';
    useOcrModel: boolean;      // split pipeline: a separate VLM transcribes (page/crops images), the main model translates text-only
    readingDir: 'rtl' | 'ltr';   // region numbering order: manga vs manhwa/western
    ocrEngine: 'tesseract' | 'baberu'; // recognition engine when textSource='ocr'
    ocrLangs: string[];         // traineddata languages to load for OCR (must be downloaded first)
    targetLang: string;           // translation target language (English name or native)
    vlmAssistedDetection: boolean; // model reports un-numbered text regions
    useContext: boolean;           // send recent dialogue pairs to the LLM
    useCharacters: boolean;        // send/learn the character book
    crossChapter: boolean;         // character book persists across chapters of the same manga
    stylePrompt: string;           // extra tone instruction appended to the prompt ('' = follow the original tone)
    contextPairs: number;          // cross-page memory depth
    charLimit: number;         // character book cap
    thinkingLevel: string; // preset (see THINKING_LEVELS), custom text, or a numeric token budget — mapped per provider at send time
    ocrThinking: string; // thinking level for the separate VLM reader's transcribe call (default 'none' — copying glyphs needs no reasoning)
    parallelLlm: number;        // concurrent LLM calls when context is OFF (1 = serial)
    prefetchN: number;         // auto pre-translate window: queued pages ahead (1-30)
    // rendering
    renderFont: string;         // 'default' = bundled Sriracha/system per language; else a font-store id
    minFont: number;
    letterSpacing: number;     // fraction of font size
    verticalThreshold: number; // box h/w ratio that switches to vertical layout
    preferHorizontal: boolean; // tall boxes try horizontal first, rotate only on overflow
    textColor: string;         // 'auto' (contrast vs background) or '#rrggbb'
    strokeColor: string;       // 'auto' (opposite of resolved text) or '#rrggbb'
    textStroke: number;        // stroke width as fraction of font size (0 = off)
    showToasts: boolean;       // in-page done/error popups (status pill + popup log stay)
}

export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = {
    preset: 'balanced',
    detConf: 0.35,
    detMinSize: 12,
    panelConf: 0.20,
    deferLabels: true,
    transcribeSrc: false,
    inferEngine: 'local',
    detEp: 'auto',
    cacheEnabled: true,
    cacheMax: 200,
    fullPageSize: 1280,
    cropSize: 420,
    jpegQuality: 0.85,
    grayscaleBw: true,
    textSource: 'crops',
    useOcrModel: false,
    readingDir: 'rtl',
    ocrEngine: 'baberu',
    ocrLangs: ['jpn', 'eng'],
    targetLang: 'Thai',
    // OFF by default: the model's extra-region coordinates are ~20-45% off too
    // often — renders land on wrong ink (floating text over art) or miss the
    // ink entirely. Turn on to experiment; bubble translation is unaffected.
    vlmAssistedDetection: false,
    useContext: true,
    useCharacters: true,
    crossChapter: true,
    stylePrompt: '',
    contextPairs: 40,
    charLimit: 10,
    thinkingLevel: 'auto',
    ocrThinking: 'none',
    parallelLlm: 3,
    prefetchN: 3,
    minFont: 12,
    renderFont: 'default',
    letterSpacing: 0.10,
    verticalThreshold: 2.2,
    preferHorizontal: true,
    textColor: 'auto',
    strokeColor: 'auto',
    textStroke: 0.1,
    showToasts: true,
};

// Searchable target-language list for the options-page combobox.
// `en` is the value sent to the LLM; `native` is display-only.
// Free-text outside this list still works (the prompt uses GENERIC_RULE).
export interface TargetLang { en: string; native?: string }

export const TARGET_LANGS: TargetLang[] = [
    { en: 'English', native: 'English' },
    { en: 'Thai', native: 'ไทย' },
    { en: 'Spanish', native: 'Español' },
    { en: 'Portuguese', native: 'Português' },
    { en: 'French', native: 'Français' },
    { en: 'Indonesian', native: 'Bahasa Indonesia' },
    { en: 'Vietnamese', native: 'Tiếng Việt' },
    { en: 'Chinese', native: '中文' },
    { en: 'Chinese (Simplified)', native: '简体中文' },
    { en: 'Chinese (Traditional)', native: '繁體中文' },
    { en: 'Japanese', native: '日本語' },
    { en: 'Korean', native: '한국어' },
    { en: 'German', native: 'Deutsch' },
    { en: 'Italian', native: 'Italiano' },
    { en: 'Russian', native: 'Русский' },
    { en: 'Arabic', native: 'العربية' },
    { en: 'Hindi', native: 'हिन्दी' },
    { en: 'Bengali', native: 'বাংলা' },
    { en: 'Urdu', native: 'اردو' },
    { en: 'Turkish', native: 'Türkçe' },
    { en: 'Polish', native: 'Polski' },
    { en: 'Dutch', native: 'Nederlands' },
    { en: 'Malay', native: 'Bahasa Melayu' },
    { en: 'Filipino' },
    { en: 'Tamil', native: 'தமிழ்' },
    { en: 'Nepali', native: 'नेपाली' },
    { en: 'Khmer', native: 'ខ្មែរ' },
    { en: 'Lao', native: 'ລາວ' },
    { en: 'Burmese', native: 'မြန်မာ' },
    { en: 'Swedish', native: 'Svenska' },
];

// ponytail: substring match on both names, English-first ordering —
// extracted pure so options.ts stays thin and unit-testable
export function filterTargetLangs(query: string): TargetLang[] {
    const q = query.trim().toLowerCase();
    if (!q) return TARGET_LANGS;
    const starts: TargetLang[] = [];
    const contains: TargetLang[] = [];
    for (const l of TARGET_LANGS) {
        const en = l.en.toLowerCase();
        const nat = (l.native ?? '').toLowerCase();
        if (en.startsWith(q) || (nat && nat.startsWith(q))) starts.push(l);
        else if (en.includes(q) || (nat && nat.includes(q))) contains.push(l);
    }
    return [...starts, ...contains];
}

export const PRESETS: Record<string, Partial<PipelineSettings>> = {
    balanced: {},
    fast: {
        cropSize: 360,
        contextPairs: 15,
        jpegQuality: 0.8,
    },
    best: {
        cropSize: 560,
        jpegQuality: 0.9,
        contextPairs: 60,
    },
};

// Preset thinking levels (custom text/numbers pass through untouched).
const KNOWN_THINKING = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];

export function applyPreset(name: string): PipelineSettings {
    return { ...DEFAULT_PIPELINE_SETTINGS, ...(PRESETS[name] ?? {}), preset: name };
}

// Merge stored (possibly old/partial) settings over defaults: missing keys are
// filled, unknown keys dropped, wrong types reset to default. Old-format keys
// (useVision/visionMode/ocrModel) migrate onto the unified textSource axis.
export function loadPipelineSettings(stored: unknown): PipelineSettings {
    if (!stored || typeof stored !== 'object') return { ...DEFAULT_PIPELINE_SETTINGS };
    const s = stored as Record<string, unknown>;
    const out: Record<string, unknown> = { ...DEFAULT_PIPELINE_SETTINGS };
    for (const [k, def] of Object.entries(DEFAULT_PIPELINE_SETTINGS)) {
        const v = s[k];
        if (typeof v === typeof def || (k === 'ocrLangs' && Array.isArray(v))) out[k] = v;
    }
    // ---- migration: thinking presets (minimal was dropped; custom values pass through) ----
    {
        let t = String(out.thinkingLevel ?? '').trim();
        if (!t) t = 'auto';
        else if (t === 'minimal') t = 'low';
        else {
            const l = t.toLowerCase();
            if (l !== t && KNOWN_THINKING.includes(l)) t = l;
        }
        out.thinkingLevel = t;
    }
    // VLM-reader thinking: same normalization, default 'none' (transcribe needs no reasoning)
    {
        let t = String(out.ocrThinking ?? '').trim();
        if (!t) t = 'none';
        else if (t === 'minimal') t = 'low';
        else {
            const l = t.toLowerCase();
            if (l !== t && KNOWN_THINKING.includes(l)) t = l;
        }
        out.ocrThinking = t;
    }
    // ---- migration: pre-textSource settings ----
    if (!s.textSource) {
        if (s.ocrModel === 'tesseract') out.textSource = 'ocr';
        else if (s.visionMode === 'text' || s.useVision === false) out.textSource = 'crops';
        // legacy users who explicitly had vision on keep 'page'; fresh installs
        // (no legacy keys at all) fall through to the current default
        else if (s.visionMode != null || s.useVision != null || s.ocrModel != null) out.textSource = 'page';
    }
    if (out.readingDir !== 'rtl' && out.readingDir !== 'ltr') out.readingDir = 'rtl';
    if (typeof out.detConf !== 'number' || !(out.detConf >= 0 && out.detConf <= 1)) out.detConf = 0.35;
    if (typeof out.detMinSize !== 'number' || !(out.detMinSize >= 1 && out.detMinSize <= 200)) out.detMinSize = 12;
    else out.detMinSize = Math.round(out.detMinSize);
    if (typeof out.panelConf !== 'number' || !(out.panelConf >= 0.05 && out.panelConf <= 1)) out.panelConf = 0.20;
    for (const k of ['textColor', 'strokeColor'] as const) {
        if (out[k] !== 'auto' && (typeof out[k] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(out[k]))) out[k] = 'auto';
    }
    if (typeof out.textStroke !== 'number' || !(out.textStroke >= 0 && out.textStroke <= 0.5)) out.textStroke = 0.1;
    if (typeof out.deferLabels !== 'boolean') out.deferLabels = true;
    if (typeof out.showToasts !== 'boolean') out.showToasts = true;
    if (typeof out.transcribeSrc !== 'boolean') out.transcribeSrc = false;
    if (typeof out.useOcrModel !== 'boolean') out.useOcrModel = false;
    if (out.inferEngine !== 'local' && out.inferEngine !== 'cloud') out.inferEngine = 'local';
    if (out.detEp !== 'auto' && out.detEp !== 'wasm') out.detEp = 'auto';
    if (typeof out.prefetchN !== 'number' || !(out.prefetchN >= 1 && out.prefetchN <= 30)) out.prefetchN = 3;
    else out.prefetchN = Math.round(out.prefetchN);
    if (typeof out.cacheEnabled !== 'boolean') out.cacheEnabled = true;
    if (typeof out.preferHorizontal !== 'boolean') out.preferHorizontal = true;
    if (typeof out.cacheMax !== 'number' || !(out.cacheMax >= 10 && out.cacheMax <= 2000)) out.cacheMax = 200;
    else out.cacheMax = Math.round(out.cacheMax);
    if (typeof out.contextPairs !== 'number' || !(out.contextPairs >= 0 && out.contextPairs <= 200)) out.contextPairs = 40;
    else out.contextPairs = Math.round(out.contextPairs);
    return out as unknown as PipelineSettings;
}

// Keys owned by other surfaces (popup's Pages-ahead slider owns prefetchN) —
// options renders no control for these, so its in-memory copy is stale by
// design. Saves start from fresh storage and overlay everything EXCEPT
// these, otherwise Save silently reverts the popup's value (seen live:
// prefetchN 3 → 10 the moment options saved).
const PRESERVE_KEYS: readonly string[] = ['prefetchN'];

export function mergePipeline(fresh: unknown, local: PipelineSettings): PipelineSettings {
    const base = loadPipelineSettings(fresh);
    const out = base as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(local)) {
        if (PRESERVE_KEYS.includes(k)) continue;
        out[k] = v;
    }
    return loadPipelineSettings(out);
}

// Which preset matches this settings object (for showing "Custom" in the UI)?
export function matchingPreset(s: PipelineSettings): string {
    for (const [name, patch] of Object.entries(PRESETS)) {
        const full = applyPreset(name);
        let same = true;
        for (const k of Object.keys(DEFAULT_PIPELINE_SETTINGS)) {
            if (k === 'preset' || k === 'prefetchN' || k === 'cacheMax' || k === 'inferEngine' || k === 'detEp' || k === 'showToasts' || k === 'useOcrModel' || k === 'ocrThinking') continue; // behavior knobs, not quality
            if ((full as any)[k] !== (s as any)[k]) { same = false; break; }
        }
        if (same) return name;
    }
    return 'custom';
}

// ---- per-site auto-translate ----
// Auto follows the reader per website, not globally: ad redirects and other
// sites never inherit it. Stored as origins (mtAutoSites); the legacy global
// flag (mtAutoTranslate) means "everywhere" only when no site list exists
// (upgrades keep their old behavior until the first toggle writes the list).
export function isAutoSite(origin: string, sites: unknown, legacyAll: boolean): boolean {
    if (Array.isArray(sites)) return (sites as unknown[]).some((s) => typeof s === 'string' && s === origin);
    return legacyAll;
}

// Origin of a tab URL, or null where the content script can't run (chrome://,
// about:, extension pages, garbage). Pure so the popup + tests share it.
export function autoSiteOf(url: string | undefined): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
    } catch {
        return null;
    }
}

// Site-list management (options page owns the list UI, popup owns the toggle —
// one implementation so the two can't disagree). Stored raw, sanitized here.
export function autoSiteList(stored: unknown): string[] {
    if (!Array.isArray(stored)) return [];
    const out: string[] = [];
    for (const s of stored) if (typeof s === 'string' && s && !out.includes(s)) out.push(s);
    return out;
}
export function autoSiteAdd(list: string[], origin: string): string[] {
    return autoSiteList([...list, origin]);
}
export function autoSiteRemove(list: string[], origin: string): string[] {
    return autoSiteList(list.filter((s) => s !== origin));
}
