// Small, document-local timing reports contain only durations and whitelisted metadata.
// They do not depend on visual debug, storage, page URLs, text or image payloads.
declare const __BUILD_ID__: string;

export const TIMING_LABELS = {
    read: 'Reading image', cache: 'Checking saved page', cacheWarm: 'Checking interrupted work', cacheHash: 'Hashing page image', cacheIdb: 'Reading saved pages',
    detect: 'Finding text', order: 'Ordering text',
    cloudEncode: 'Cloud image encoding', cloudRequest: 'Cloud round trip', cloudDecode: 'Cloud result decoding',
    translationPrep: 'Preparing translation', pixelRead: 'Reading image pixels', cropExpand: 'Expanding text crops',
    cropDraw: 'Drawing text crops', cropEncode: 'Encoding text crops', annotate: 'Preparing full-page image', llm: 'Translation round trip',
    renderBase: 'Preparing drawing canvas', cleanup: 'Text cleanup', cleanupMask: 'Preparing cleanup mask', cleanupEncode: 'Cleanup upload encoding',
    cleanupRequest: 'Cleanup round trip', patchDecode: 'Decoding cleaned regions', font: 'Loading font',
    renderRead: 'Reading pixels for drawing', paint: 'Drawing text', pngWait: 'Waiting to save image',
    png: 'Saving image', identity: 'Checking image identity', originalCopy: 'Keeping original image',
    debug: 'Preparing debug views', display: 'Applying image to reader', joined: 'Checking or processing joined images',
} as const;
export type TimingName = keyof typeof TIMING_LABELS;

export interface PageTimingMeta {
    page?: string;
    boxes?: number;
    engine?: string;
    textSource?: string;
    thinking?: string;
    debug?: boolean;
    cached?: boolean;
    joined?: boolean;
    images?: number;
    imageChars?: number;
    cleanupSource?: 'fill' | 'cache' | 'cloud-detect' | 'cloud-request' | 'local' | 'local-warm';
    provider?: string;
    model?: string;
    calls?: number;
    apiMs?: number;
    inTok?: number;
    outTok?: number;
    cloud?: { detect?: number; ocr?: number; inpaint?: number; total?: number; body?: number };
}
export interface PageTimingReport {
    schema: 1;
    build: string;
    userAgent: string;
    startedAt: number;
    elapsedMs: number;
    state: 'running' | 'done' | 'failed';
    stage: string;
    meta: PageTimingMeta;
    ms: Partial<Record<TimingName, number>>;
}

let latest: PageTimer | null = null;
export function lastPageTiming(): PageTimingReport | null { return latest?.report() ?? null; }

export class PageTimer {
    readonly startedAt = Date.now();
    readonly meta: PageTimingMeta = {};
    private readonly t0 = performance.now();
    private readonly ms: Partial<Record<TimingName, number>> = {};
    private state: PageTimingReport['state'] = 'running';
    private stage = 'Reading image';
    private endedAt?: number;

    activate(): void { latest = this; }
    setStage(stage: string): void { this.stage = stage; }
    add(name: TimingName, ms: number): void {
        if (Number.isFinite(ms) && ms >= 0) this.ms[name] = (this.ms[name] ?? 0) + ms;
    }
    measure<T>(name: TimingName, fn: () => T): T {
        const t0 = performance.now();
        try { return fn(); } finally { this.add(name, performance.now() - t0); }
    }
    async measureAsync<T>(name: TimingName, fn: () => Promise<T>): Promise<T> {
        const t0 = performance.now();
        try { return await fn(); } finally { this.add(name, performance.now() - t0); }
    }
    finish(state: 'done' | 'failed'): void {
        this.state = state;
        this.endedAt = performance.now();
        if (state === 'done') this.stage = 'Finished';
        this.activate();
    }
    report(): PageTimingReport {
        return {
            schema: 1,
            build: typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'development',
            userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent.slice(0, 512),
            startedAt: this.startedAt,
            elapsedMs: Math.round((this.endedAt ?? performance.now()) - this.t0),
            state: this.state, stage: this.stage,
            meta: safeMeta(this.meta),
            ms: Object.fromEntries(Object.entries(this.ms).map(([key, value]) => [key, Math.round(value)])),
        };
    }
}

// Copy a fixed set of fields, never an entire settings, response or page object.
function safeMeta(meta: PageTimingMeta): PageTimingMeta {
    const out: Record<string, unknown> = {};
    for (const key of ['page', 'engine', 'textSource', 'thinking', 'cleanupSource', 'provider', 'model'] as const) {
        if (typeof meta[key] === 'string') out[key] = meta[key].slice(0, 128);
    }
    for (const key of ['boxes', 'images', 'imageChars', 'calls', 'apiMs', 'inTok', 'outTok'] as const) {
        if (typeof meta[key] === 'number' && Number.isFinite(meta[key]) && meta[key] >= 0) out[key] = Math.round(meta[key]);
    }
    for (const key of ['debug', 'cached', 'joined'] as const) if (typeof meta[key] === 'boolean') out[key] = meta[key];
    if (meta.cloud) {
        const cloud: Record<string, number> = {};
        for (const key of ['detect', 'ocr', 'inpaint', 'total', 'body'] as const) {
            const value = meta.cloud[key];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) cloud[key] = Math.round(value);
        }
        out.cloud = cloud;
    }
    return out as PageTimingMeta;
}

export function timingSeconds(ms: number): string { return `${(ms / 1000).toFixed(2)}s`; }
export function formatPageTiming(report: PageTimingReport): string {
    const safe: PageTimingReport = {
        schema: 1, build: String(report.build).slice(0, 128), userAgent: String(report.userAgent).slice(0, 512),
        startedAt: report.startedAt, elapsedMs: report.elapsedMs, state: report.state,
        stage: String(report.stage).slice(0, 80), meta: safeMeta(report.meta), ms: {},
    };
    for (const name of Object.keys(TIMING_LABELS) as TimingName[]) {
        const value = report.ms[name];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) safe.ms[name] = value;
    }
    return 'Arn Manga page timing\n' + JSON.stringify(safe, null, 2)
        + '\nTimings can overlap. API time includes transport and successful retry calls; total ends after requesting the reader update, not after display decoding.\n';
}
