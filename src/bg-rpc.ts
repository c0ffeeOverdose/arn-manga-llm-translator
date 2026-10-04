// Background calls must never park a page forever: a suspended or wedged service worker
// (mobile) leaves sendMessage pending with no reply, and the awaiting page has no error and
// no recovery. Callers name their own deadline — long server-side work keeps its cap in the
// worker, so the client cap sits just above it. Retries are opt-in and only for calls that
// are safe to repeat (reads, idempotent bookkeeping).
export class BackgroundTimeoutError extends Error {
    constructor(label: string, timeoutMs: number) {
        super(`${label} — background did not respond within ${Math.round(timeoutMs / 1000)}s`);
        this.name = 'BackgroundTimeoutError';
    }
}

const RETRYABLE = /Could not establish connection|message port closed|Receiving end|background disconnected/i;

export interface SendOptions {
    timeoutMs?: number; // default 10s
    retries?: number;   // default 0
    label?: string;     // names the caller in the error; defaults to msg.type
}

export async function sendToBackground<T = unknown>(msg: unknown, opts: SendOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const retries = Math.max(0, opts.retries ?? 0);
    const label = opts.label ?? (msg as { type?: string })?.type ?? 'background call';
    for (let attempt = 0; ; attempt++) {
        try {
            const call = (chrome.runtime.sendMessage as (m: unknown) => Promise<unknown>)(msg);
            return await withTimeout(call as Promise<T>, timeoutMs, label);
        } catch (e) {
            const retryable = e instanceof BackgroundTimeoutError || RETRYABLE.test(String((e as Error)?.message ?? e));
            if (attempt >= retries || !retryable) throw e;
            await new Promise(r => setTimeout(r, 500));
        }
    }
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new BackgroundTimeoutError(label, timeoutMs)), timeoutMs);
        p.then(
            v => { clearTimeout(timer); resolve(v); },
            e => { clearTimeout(timer); reject(e); },
        );
    });
}
