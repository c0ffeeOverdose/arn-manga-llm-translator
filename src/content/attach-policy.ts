// When may a chapter artifact paint over the reader's page?
//
// The artifact's signature carries the settings of the run that produced it. Normally it must
// equal the reader's current settings — a changed setting means the translation no longer
// matches what the user wants. The exception: while that run is still active, its own finished
// pages are authoritative — the run translated them with the settings it captured at start, and
// a mid-run settings change must not strand work the user already paid for.
//
// Pure: no DOM, no settings objects.
export function artifactAuthorized(artifactSignature: string, pipelineSignature: string, activeRunOwns: boolean): boolean {
    return activeRunOwns || artifactSignature === pipelineSignature;
}

// A run is "active" while it may still produce or paint pages of its own.
export function runPhaseActive(phase: string | undefined): boolean {
    return phase === 'preparing' || phase === 'running' || phase === 'waiting' || phase === 'stopping';
}
