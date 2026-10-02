// The inference worker registers its handshake token with the background right before it
// signals "ready"; the content side reads that token back under the worker's public nonce.
// A service worker caught mid-wake can still miss the read, and the token then stays null —
// every inference call in the document fails until a manual reload. Ask a few times before
// treating the handshake as lost. Pure control flow (the asker is injected for tests).
export async function fetchWorkerToken(
    nonce: unknown,
    tries = 3,
    delayMs = 250,
    ask: (nonce: string) => Promise<{ token?: string } | undefined> = n =>
        chrome.runtime.sendMessage({ type: 'mt:get-worker-token', nonce: n }) as Promise<{ token?: string } | undefined>,
): Promise<string | null> {
    if (typeof nonce !== 'string' || !nonce) return null;
    for (let i = 0; i < Math.max(1, tries); i++) {
        try {
            const t = (await ask(nonce))?.token ?? null;
            if (t) return t;
        } catch { /* transient — the next try may catch a woken background */ }
        if (i + 1 < Math.max(1, tries)) await new Promise(r => setTimeout(r, delayMs));
    }
    return null;
}
