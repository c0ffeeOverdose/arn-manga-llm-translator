// User-facing line for an auto halt (see queue.haltAuto / autoHalted). Every halt kind gets
// its own branch: a catch-all once printed "Auth/quota error" after a cache clear. Pure —
// unit tested; the wording is human, internal terms (chunk/sweep/fold) never reach the pill.
export interface AutoHalt { kind: string; until: number }

export function haltMessage(halted: AutoHalt, now = Date.now()): string {
    if (halted.kind === 'chapter') return 'Chapter translation paused — start chapter translation to continue';
    if (halted.kind === 'cache') return 'Cache cleared — press Translate to translate again';
    if (halted.kind === 'ratelimit') {
        const left = halted.until > now ? ` (${Math.ceil((halted.until - now) / 1000)}s)` : '';
        return `Rate limited${left} — stopped; press Translate to resume`;
    }
    // auth and anything unknown: the actionable provider hint is the safer default
    return 'Auth/quota error — fix the key, then press Translate';
}
