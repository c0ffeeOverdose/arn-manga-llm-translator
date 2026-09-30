// Each attempt has a lease; Stop and deadlines revoke it before any late result can commit.
// A lease that expires must cost exactly ONE page: the run continues with the rest.
export interface AttemptOptions {
    timeoutMs: number;
    // Named so an expired lease can report WHERE it stopped. A run that dies silently is
    // indistinguishable from a run that is merely slow.
    label?: () => string;
    onExpire?: (info: { label: string; elapsedMs: number }) => void;
}
export class Attempt {
    private active = true;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private release!: () => void;
    private readonly startedAt = Date.now();
    readonly cancelled = new Promise<void>(resolve => { this.release = resolve; });
    readonly timeoutMs: number;
    constructor(opts: AttemptOptions);
    constructor(timeoutMs: number, expired?: () => void);
    constructor(opts: AttemptOptions | number, expired?: () => void) {
        const o: AttemptOptions = typeof opts === 'number' ? { timeoutMs: opts, onExpire: expired } : opts;
        this.timeoutMs = o.timeoutMs;
        this.timer = setTimeout(() => {
            const info = { label: o.label?.() ?? 'page', elapsedMs: Date.now() - this.startedAt };
            this.cancel();
            o.onExpire?.(info);
        }, o.timeoutMs);
    }
    valid(): boolean { return this.active; }
    cancel(): void {
        if (!this.active) return;
        this.active = false;
        clearTimeout(this.timer);
        this.release();
    }
    finish(): void { clearTimeout(this.timer); }
    elapsedMs(): number { return Date.now() - this.startedAt; }
}
