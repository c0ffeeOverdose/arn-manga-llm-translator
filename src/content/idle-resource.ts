// Calls retain the host through asynchronous setup and work. Disposal waits for the last
// borrower; a new idle-to-busy transition cancels pending disposal.
export class IdleResource {
    private users = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private eager = false;

    constructor(private readonly dispose: () => void, private readonly delayMs = 60_000) {}

    retain(): () => void {
        this.cancelTimer();
        if (!this.users) this.eager = false;
        this.users++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (--this.users) return;
            if (this.eager) this.release();
            else this.timer = setTimeout(() => this.release(), this.delayMs);
        };
    }

    release(): void {
        this.cancelTimer();
        this.eager = true;
        if (!this.users) this.dispose();
    }

    private cancelTimer(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
    }
}
