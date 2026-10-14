export function checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Translation stopped', 'AbortError');
}

// Release the caller on Stop; the task keeps ownership of its resources until it settles.
export function cancellable<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return task;
    return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Translation stopped', 'AbortError'));
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        task.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        if (signal.aborted) { cleanup(); abort(); }
    });
}
