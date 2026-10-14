// User-facing line for an auto halt (see queue.haltAuto / autoHalted). Every halt kind gets
// its own branch: a catch-all once printed "Auth/quota error" after a cache clear. Pure —
// unit tested; the wording is human, internal terms (chunk/sweep/fold) never reach the pill.
export interface AutoHalt { kind: string; until: number }

export function haltMessage(halted: AutoHalt, now = Date.now()): string {
    if (halted.kind === 'user') return 'Auto-translate paused. Select Resume auto to continue.';
    if (halted.kind === 'chapter') return 'Chapter translation paused. Select Resume chapter translation to continue.';
    if (halted.kind === 'cache') return 'Saved translations cleared. Select Translate this page to start again.';
    if (halted.kind === 'inference') return 'Graphics processing stopped responding. Restart your browser, then try translating again.';
    if (halted.kind === 'ratelimit') {
        const left = halted.until > now ? ` (${Math.ceil((halted.until - now) / 1000)}s)` : '';
        return `Provider request limit reached${left}. Wait, then try translating again.`;
    }
    // auth and anything unknown: the actionable provider hint is the safer default
    return 'Check your API key and provider balance, then try translating again.';
}
