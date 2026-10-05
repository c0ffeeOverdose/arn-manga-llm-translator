// Exported chapter diagnostics contain only fixed event codes, counters and safe settings.
// Reader URLs, credentials, model replies and image payloads never enter this schema.
export const CHAPTER_LOG_STAGES = {
    preparing: 'Preparing chapter translation', current: 'Finishing the current page', settings: 'Loading settings',
    warm: 'Waking the Cloud server', enumerate: 'Finding chapter pages', capture: 'Preparing page images',
    start: 'Starting the background task', boot: 'Starting the chapter runner', generation: 'Checking saved translations',
    debug: 'Loading diagnostic settings', config: 'Loading the chapter task', checkpoint: 'Restoring saved progress',
    fonts: 'Loading fonts', context: 'Loading character context', artifact: 'Checking saved chapter result',
    image: 'Reading page image', hash: 'Checking image identity', cache: 'Checking saved detection and translation',
    detect: 'Finding text', cloudEncode: 'Preparing Cloud image', cloudWait: 'Waiting for Cloud reply',
    order: 'Ordering text', ocr: 'Reading source text', translationPrep: 'Preparing translation images',
    llmWait: 'Waiting for translation reply', merge: 'Combining pages for translation', render: 'Drawing translation',
    result: 'Saving translated image', cacheWrite: 'Saving reusable page data', contextWrite: 'Saving character context',
    progress: 'Saving chapter progress', discovery: 'Finding more chapter pages', ready: 'Ready to read',
} as const;
export type ChapterLogStage = keyof typeof CHAPTER_LOG_STAGES;
export const CHAPTER_LOG_EVENTS = [
    'stage', 'progress', 'setup-ready', 'cache-hit', 'cache-miss', 'source-alternate', 'page-ready', 'page-failed', 'page-waiting',
    'cloud-sent', 'cloud-received', 'cloud-http-start', 'cloud-http-reply', 'cloud-response',
    'llm-sent', 'llm-received', 'llm-provider-start', 'llm-provider-reply', 'llm-response', 'retry',
    'stop', 'cancel', 'failure', 'runner-lost', 'reader-reloaded', 'reader-closed', 'background-woke',
    'context-received', 'context-response',
    'llm-provider-failed',
] as const;
export type ChapterLogEventKind = typeof CHAPTER_LOG_EVENTS[number];
export const CHAPTER_LOG_REASONS = [
    'unknown', 'background-timeout', 'disconnected', 'network', 'http', 'timeout', 'abort', 'storage',
    'auth', 'ratelimit', 'cloud', 'parse', 'source', 'ocr', 'server',
    'artifact', 'full-cache', 'checkpoint', 'absent', 'fingerprint', 'dims', 'mask', 'splitgen', 'partial', 'disabled',
    'empty-reply', 'smaller-batches', 'per-page-fallback', 'no-text', 'binding-missing', 'binding-present', 'cached-reply', 'shared-request',
] as const;
export type ChapterLogReason = typeof CHAPTER_LOG_REASONS[number];
export type ChapterLogPhase = 'preparing' | 'running' | 'stopping' | 'stopped' | 'complete' | 'waiting' | 'error';
export interface ChapterTrace { logId: string; pages?: number[]; request?: string }
export interface ChapterLogEvent {
    kind: ChapterLogEventKind;
    at: number;
    stage?: ChapterLogStage;
    pages?: number[];
    request?: string;
    reason?: ChapterLogReason;
    phase?: ChapterLogPhase;
    done?: number; total?: number; errors?: number; inflight?: number;
    ms?: number; status?: number; w?: number; h?: number; boxes?: number; calls?: number; bytes?: number; deadlineMs?: number;
    engine?: 'cloud' | 'local'; textSource?: 'page' | 'crops' | 'ocr';
    execution?: 'cloud' | 'local' | 'cache';
    runnerKind?: 'offscreen' | 'background';
    hasOffscreenApi?: boolean; hasContextsApi?: boolean; hasSessionStorage?: boolean;
    parallelLlm?: number; mergePages?: number; splitGen?: number; cached?: boolean;
}
export type ChapterLogInput = Omit<ChapterLogEvent, 'at'> & { at?: number };
export interface ChapterLogHead {
    id: string;
    build: string;
    userAgent: string;
    startedAt: number;
    updatedAt: number;
    endedAt?: number;
    phase: ChapterLogPhase;
    stage: ChapterLogStage;
    stageAt: number;
    done: number; total: number; errors: number; inflight: number;
    engine?: 'cloud' | 'local'; textSource?: 'page' | 'crops' | 'ocr'; parallelLlm?: number; mergePages?: number;
    runnerKind?: 'offscreen' | 'background';
    hasOffscreenApi?: boolean; hasContextsApi?: boolean; hasSessionStorage?: boolean;
    sequence: number;
    droppedEvents: number;
}
export interface ChapterLogRequest { request?: string; sentAt?: number; receivedAt?: number; httpAt?: number; repliedAt?: number;
    responseAt?: number; status?: number; clientDeadlineMs?: number; serverDeadlineMs?: number }
export interface ChapterLogPage {
    page: number;
    state: 'working' | 'ready' | 'failed' | 'waiting';
    stage: ChapterLogStage;
    stageAt: number;
    startedAt: number;
    updatedAt: number;
    endedAt?: number;
    ms: Partial<Record<ChapterLogStage, number>>;
    w?: number; h?: number; boxes?: number; splitGen?: number; cached?: boolean;
    execution?: 'cloud' | 'local' | 'cache';
    reason?: ChapterLogReason;
    cloud?: ChapterLogRequest;
    llm?: ChapterLogRequest;
}
export interface ChapterLogReport { schema: 1; capturedAt: number; head: ChapterLogHead; pages: ChapterLogPage[]; events: ChapterLogEvent[] }

const phases: ChapterLogPhase[] = ['preparing', 'running', 'stopping', 'stopped', 'complete', 'waiting', 'error'];
const safeNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e15;
export function sanitizeChapterEvent(raw: unknown, now = Date.now()): ChapterLogEvent | undefined {
    if (!raw || typeof raw !== 'object') return;
    const v = raw as Record<string, unknown>;
    if (!CHAPTER_LOG_EVENTS.includes(v.kind as ChapterLogEventKind)) return;
    const out: ChapterLogEvent = { kind: v.kind as ChapterLogEventKind, at: safeNumber(v.at) ? v.at : now };
    if (typeof v.stage === 'string' && Object.hasOwn(CHAPTER_LOG_STAGES, v.stage)) out.stage = v.stage as ChapterLogStage;
    if (Array.isArray(v.pages)) out.pages = [...new Set(v.pages.filter(n => safeNumber(n) && Number.isInteger(n) && n > 0 && n <= 100_000))].slice(0, 10);
    if (typeof v.request === 'string' && /^[0-9a-f-]{1,40}$/.test(v.request)) out.request = v.request;
    if (CHAPTER_LOG_REASONS.includes(v.reason as ChapterLogReason)) out.reason = v.reason as ChapterLogReason;
    if (phases.includes(v.phase as ChapterLogPhase)) out.phase = v.phase as ChapterLogPhase;
    for (const key of ['done', 'total', 'errors', 'inflight', 'ms', 'w', 'h', 'boxes', 'calls', 'bytes', 'parallelLlm', 'mergePages', 'splitGen', 'deadlineMs'] as const) {
        if (safeNumber(v[key])) out[key] = Math.round(v[key]);
    }
    if (safeNumber(v.status) && v.status >= 100 && v.status <= 599) out.status = v.status;
    if (v.engine === 'cloud' || v.engine === 'local') out.engine = v.engine;
    if (v.execution === 'cloud' || v.execution === 'local' || v.execution === 'cache') out.execution = v.execution;
    if (v.runnerKind === 'offscreen' || v.runnerKind === 'background') out.runnerKind = v.runnerKind;
    for (const key of ['hasOffscreenApi', 'hasContextsApi', 'hasSessionStorage'] as const) {
        if (typeof v[key] === 'boolean') out[key] = v[key];
    }
    if (v.textSource === 'page' || v.textSource === 'crops' || v.textSource === 'ocr') out.textSource = v.textSource;
    if (typeof v.cached === 'boolean') out.cached = v.cached;
    return out;
}

export function chapterLogError(error: unknown): Pick<ChapterLogEvent, 'reason' | 'status'> {
    const e = error as { kind?: string; name?: string; message?: string; status?: number } | undefined;
    let reason: ChapterLogReason = 'unknown';
    if (CHAPTER_LOG_REASONS.includes(e?.kind as ChapterLogReason)) reason = e!.kind as ChapterLogReason;
    else if (e?.name === 'BackgroundTimeoutError') reason = 'background-timeout';
    else if (e?.name === 'AbortError') reason = 'abort';
    else if (/disconnected|message port|receiving end|connection/i.test(e?.message ?? '')) reason = 'disconnected';
    else if (/timeout|timed out/i.test(e?.message ?? '')) reason = 'timeout';
    else if (/fetch|network/i.test(e?.message ?? '')) reason = 'network';
    else if (/indexeddb|storage/i.test(e?.message ?? '')) reason = 'storage';
    const status = e?.status ?? Number(e?.message?.match(/\bHTTP\s+(\d{3})\b/i)?.[1]);
    return { reason, ...(safeNumber(status) && status >= 100 && status <= 599 ? { status } : {}) };
}

export function updateChapterLogPage(previous: ChapterLogPage | undefined, page: number, event: ChapterLogEvent): ChapterLogPage {
    const p: ChapterLogPage = previous ? structuredClone(previous) : {
        page, state: 'working', stage: event.stage ?? 'context', startedAt: event.at, stageAt: event.at, updatedAt: event.at, ms: {},
    };
    if (event.stage && event.at >= p.stageAt && (event.stage !== p.stage || p.endedAt !== undefined)) {
        if (p.endedAt === undefined) p.ms[p.stage] = (p.ms[p.stage] ?? 0) + Math.max(0, event.at - p.stageAt);
        p.stage = event.stage; p.stageAt = event.at; p.endedAt = undefined;
        p.state = 'working';
    }
    if (event.kind === 'page-ready' || event.kind === 'page-failed' || event.kind === 'page-waiting') {
        if (p.endedAt === undefined) p.ms[p.stage] = (p.ms[p.stage] ?? 0) + Math.max(0, event.at - p.stageAt);
        p.state = event.kind === 'page-ready' ? 'ready' : event.kind === 'page-failed' ? 'failed' : 'waiting';
        p.endedAt = event.at;
        if (event.kind === 'page-ready') { p.stage = 'ready'; p.stageAt = event.at; }
    }
    for (const key of ['w', 'h', 'boxes', 'splitGen', 'cached', 'reason', 'execution'] as const) {
        if (event[key] !== undefined) Object.assign(p, { [key]: event[key] });
    }
    if (event.kind.startsWith('cloud-') || event.kind.startsWith('llm-')) {
        const field = event.kind.startsWith('cloud-') ? 'cloud' : 'llm';
        const request = p[field] ?? {};
        if (!request.request || !event.request || request.request === event.request || event.kind.endsWith('-sent')) {
            if (event.request && request.request !== event.request) p[field] = { request: event.request };
            else p[field] = request;
            const r = p[field]!;
            if (event.kind.endsWith('-sent')) r.sentAt = event.at;
            if (event.kind.endsWith('-sent') && event.deadlineMs !== undefined) r.clientDeadlineMs = event.deadlineMs;
            if (event.kind.endsWith('-received')) r.receivedAt = event.at;
            if (event.kind === 'cloud-http-start' || event.kind === 'llm-provider-start') r.httpAt = event.at;
            if (event.kind === 'cloud-http-start' && event.deadlineMs !== undefined) r.serverDeadlineMs = event.deadlineMs;
            if (event.kind === 'cloud-http-reply' || event.kind === 'llm-provider-reply') r.repliedAt = event.at;
            if (event.kind.endsWith('-response')) r.responseAt = event.at;
            if (event.status !== undefined) r.status = event.status;
        }
    }
    p.updatedAt = Math.max(p.updatedAt, event.at);
    return p;
}

const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
const limitText = (ms: number): string => {
    const m = Math.floor(ms / 60_000), s = Math.round((ms % 60_000) / 1000);
    return m ? (s ? `${m}m ${s}s` : `${m}m`) : `${s}s`;
};
export function chapterLogSummary(report: ChapterLogReport): string {
    const { head } = report;
    const phase = { preparing: 'Preparing', running: 'In progress', stopping: 'Stopping', stopped: 'Stopped',
        complete: 'Finished', waiting: 'Waiting for page images', error: 'Paused' }[head.phase];
    const lines = [head.total ? `${head.done} of ${head.total} pages ready to read · ${phase}` : 'Preparing chapter translation',
        `Started ${new Date(head.startedAt).toLocaleTimeString()}`, `Build ${head.build}`,
        `Last event ${seconds(report.capturedAt - head.updatedAt)} ago`];
    if (head.errors) lines.push(`${head.errors} pages could not be translated`);
    const active = report.pages.filter(p => p.state === 'working').slice(0, 6);
    for (const p of active) {
        const waited = (p.endedAt ?? head.endedAt ?? report.capturedAt) - p.stageAt;
        lines.push(`Page ${p.page}: ${CHAPTER_LOG_STAGES[p.stage]} · ${seconds(waited)}`);
        const r = p.stage === 'cloudWait' ? p.cloud : p.stage === 'llmWait' ? p.llm : undefined;
        if (r) lines.push(r.responseAt ? '  Background returned a result'
            : r.repliedAt ? `  Server replied${r.status ? ` (HTTP ${r.status})` : ''}; background result not yet recorded`
            : r.httpAt ? '  Background sent the request; no reply recorded yet'
            : r.receivedAt ? '  Background received the request; no server request recorded yet'
            : '  No background receipt recorded yet');
        if (r && !r.responseAt && r.clientDeadlineMs) {
            lines.push(waited > r.clientDeadlineMs
                ? `  Past the ${limitText(r.clientDeadlineMs)} client wait limit`
                : `  Client wait limit ${limitText(r.clientDeadlineMs)}`);
            if (r.serverDeadlineMs) lines.push(`  Server request cap ${limitText(r.serverDeadlineMs)}`);
        }
    }
    if (!active.length && head.phase === 'preparing') lines.push(`${CHAPTER_LOG_STAGES[head.stage]} · ${seconds(report.capturedAt - head.stageAt)}`);
    for (const p of report.pages.filter(p => p.state === 'failed').slice(-3)) {
        lines.push(`Page ${p.page}: stopped during ${CHAPTER_LOG_STAGES[p.stage].toLowerCase()} · ${p.reason ?? 'unknown error'}${p.cloud?.status ? ` (HTTP ${p.cloud.status})` : ''}`);
    }
    return lines.join('\n');
}
export function formatChapterLog(report: ChapterLogReport): string {
    return 'Arn Manga chapter translation log\n' + chapterLogSummary(report) + '\n\n' + JSON.stringify(report, null, 2)
        + '\nSaved across reader reloads. Events use fixed codes; no keys, URLs, page text or images. Missing receipts do not prove the server was contacted.\n';
}
