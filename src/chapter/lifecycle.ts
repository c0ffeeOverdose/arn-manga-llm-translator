// Each attempt has a lease; Stop and deadlines revoke it before any late result can commit.
export class Attempt {
    private active = true;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private release!: () => void;
    readonly cancelled = new Promise<void>(resolve => { this.release = resolve; });
    constructor(timeoutMs: number, private readonly expired: () => void = () => {}) {
        this.timer = setTimeout(() => { this.cancel(); this.expired(); }, timeoutMs);
    }
    valid(): boolean { return this.active; }
    cancel(): void {
        if (!this.active) return;
        this.active = false;
        clearTimeout(this.timer);
        this.release();
    }
    finish(): void { clearTimeout(this.timer); }
}
