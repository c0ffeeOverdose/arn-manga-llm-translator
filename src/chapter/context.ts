import { updateContext, type ContextState, type CharacterEntry } from '../llm/core';
import type { Contribution } from './model';

export interface ContextLedger {
    base: ContextState;
    entries: Contribution[];
    edits: { key: string; value: CharacterEntry | null }[];
    maxChars?: number; // roster cap the replay was recorded under (undefined = module default)
}
// Ids are the stable identity: a user edit keyed by id survives a desc rewrite from later pages.
const keyOf = (c: CharacterEntry) => c.id || c.fullName || c.name || c.desc;

// User edits are replayed after page contributions, including explicit removals.
export function recordEdits(ledger: ContextLedger, before: ContextState, after: ContextState): void {
    const old = new Map(before.characters.map(c => [keyOf(c), c]));
    const next = new Map(after.characters.map(c => [keyOf(c), c]));
    for (const key of new Set([...old.keys(), ...next.keys()])) {
        if (JSON.stringify(old.get(key)) === JSON.stringify(next.get(key))) continue;
        ledger.edits = ledger.edits.filter(e => e.key !== key);
        ledger.edits.push({ key, value: next.get(key) ?? null });
    }
}
export function replayLedger(ledger: ContextLedger, learn: boolean, maxPairs: number, beforeOrder = Infinity, maxChars?: number): ContextState {
    let ctx = structuredClone(ledger.base);
    for (const e of [...ledger.entries].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
        if (e.order >= beforeOrder) continue;
        ctx = updateContext(ctx, e.outputs, e.mentions, learn, maxPairs, maxChars ?? ledger.maxChars).ctx;
    }
    for (const edit of ledger.edits) {
        ctx.characters = ctx.characters.filter(c => keyOf(c) !== edit.key);
        if (edit.value) ctx.characters.push(structuredClone(edit.value));
    }
    return ctx;
}
export function replaceContribution(ledger: ContextLedger, entry: Contribution): void {
    ledger.entries = ledger.entries.filter(e => e.id !== entry.id);
    ledger.entries.push(structuredClone(entry));
}
