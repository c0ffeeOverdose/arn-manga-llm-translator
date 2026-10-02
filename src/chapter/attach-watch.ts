// A start whose runner never attaches is invisible: the broker would hold a session the reader
// can never see progress for. This watch records the runner's host-config request and lets
// start() bound its wait before retrying or reporting an honest failure.
export class AttachWatch {
    private hitIds = new Set<string>();
    private waiters = new Map<string, Set<(ok: boolean) => void>>();

    hit(id: string): void {
        this.hitIds.add(id);
        const waiters = this.waiters.get(id);
        if (!waiters) return;
        this.waiters.delete(id);
        for (const resolve of waiters) resolve(true);
    }

    wait(id: string, timeoutMs: number): Promise<boolean> {
        if (this.hitIds.has(id)) return Promise.resolve(true);
        return new Promise(resolve => {
            const set = this.waiters.get(id) ?? new Set<(ok: boolean) => void>();
            this.waiters.set(id, set);
            let timer: ReturnType<typeof setTimeout> | undefined;
            const done = (ok: boolean): void => {
                if (timer !== undefined) clearTimeout(timer);
                set.delete(done);
                if (!set.size) this.waiters.delete(id);
                resolve(ok);
            };
            set.add(done);
            timer = setTimeout(() => done(false), timeoutMs);
        });
    }
}
