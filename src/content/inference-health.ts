export class InferenceRpcTimeoutError extends Error {
    constructor() { super('iframe rpc timeout'); this.name = 'InferenceRpcTimeoutError'; }
}

let probing: Promise<boolean> | null = null;

// Only a missing browser-wide response is a GPU stall; a null adapter or quick rejection
// is still a response. Concurrent timed-out RPCs share one bounded, inference-free probe.
async function gpuResponds(): Promise<boolean> {
    const gpu = typeof navigator === 'undefined' ? undefined
        : (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return true;
    if (!probing) probing = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                Promise.resolve().then(() => gpu.requestAdapter()).then(() => true, () => true),
                new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 10_000); }),
            ]);
        } finally { clearTimeout(timer); }
    })().finally(() => { probing = null; });
    return probing;
}

export async function diagnoseInferenceError(error: unknown): Promise<never> {
    if (error instanceof InferenceRpcTimeoutError && !(await gpuResponds())) {
        throw Object.assign(new Error('Graphics processing stopped responding — restart your browser, then try again'), {
            kind: 'inference',
            hint: 'Close and reopen the browser, then start translation again. Saved translations and downloaded models are kept.',
        });
    }
    throw error;
}
