interface PreparedJob { prep: Promise<{ bitmap: ImageBitmap } | null> }
interface Ownership { borrowers: number; finished: boolean; closed: boolean }
const ownership = new WeakMap<PreparedJob, Ownership>();

function stateOf(job: PreparedJob): Ownership {
    let state = ownership.get(job);
    if (!state) { state = { borrowers: 0, finished: false, closed: false }; ownership.set(job, state); }
    return state;
}

function release(job: PreparedJob, state: Ownership): void {
    if (!state.finished || state.borrowers || state.closed) return;
    state.closed = true;
    void job.prep.then(prep => prep?.bitmap.close()).catch(() => {});
}

// Borrowed seam inputs stay valid if their queued job finishes or is cancelled during the stitch.
export function retainPreparedJob(job: PreparedJob): () => void {
    const state = stateOf(job);
    if (state.closed) throw new Error('Prepared image already released');
    state.borrowers++;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        state.borrowers--;
        release(job, state);
    };
}

// A finished or discarded job releases its source, including preparation that resolves after cancellation.
export function disposePreparedJob(job: PreparedJob): void {
    const state = stateOf(job);
    state.finished = true;
    release(job, state);
}
