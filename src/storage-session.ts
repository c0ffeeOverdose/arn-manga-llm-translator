// ponytail: total storage.session wrapper — Firefox exposes session to content
// scripts differently across versions (setAccessLevel support varies); fall back
// to memory so a missing/denied session area degrades (context restarts) instead
// of throwing mid-pipeline. Never throws.
type SessArea = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

function area(): SessArea | undefined {
    try {
        return (chrome.storage as unknown as { session?: SessArea }).session;
    } catch {
        return undefined;
    }
}

const mem = new Map<string, unknown>();

export async function sessGet(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const a = area();
    if (a) {
        try {
            return (await a.get(keys as string[])) as Record<string, unknown>;
        } catch {
            /* fall through to memory */
        }
    }
    if (keys === null) return Object.fromEntries(mem);
    const ks = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(ks.filter((k) => mem.has(k)).map((k) => [k, mem.get(k)]));
}

export async function sessSet(items: Record<string, unknown>): Promise<void> {
    const a = area();
    if (a) {
        try {
            await a.set(items);
            return;
        } catch {
            /* fall through to memory */
        }
    }
    for (const [k, v] of Object.entries(items)) mem.set(k, v);
}

export async function sessRemove(keys: string | string[]): Promise<void> {
    const a = area();
    if (a) {
        try {
            await a.remove(keys as string[]);
        } catch {
            /* still clear memory below */
        }
    }
    for (const k of Array.isArray(keys) ? keys : [keys]) mem.delete(k);
}
