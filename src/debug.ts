// Single debug flag (mtDebug): one toggle owns the overlay AND verbose console
// logs. Real errors/warnings stay always-on — only noise is gated.
// ponytail: one boolean, no levels — debug is either on or off.
let on = false;
let revision = 0;
let initializing: Promise<void> | undefined;
const listeners = new Set<(v: boolean) => void>();

export function isDebug(): boolean {
    return on;
}
export function setDebug(value: boolean): void {
    revision++;
    if (on === value) return;
    on = value;
    for (const listener of listeners) listener(on);
}

export async function initDebug(onFlip?: (v: boolean) => void): Promise<void> {
    if (onFlip) listeners.add(onFlip);
    if (initializing) return initializing;
    // A context may have no chrome.storage at all (a Chromium offscreen document has only
    // chrome.runtime) and no change events even when it does. This must never throw: the
    // iframe worker calls it with a TOP-LEVEL await, so an exception here aborts the whole
    // module — including the handshake token registration at its end.
    try {
        chrome.storage?.onChanged?.addListener((ch, area) => {
            if (area === 'local' && ch.mtDebug) {
                setDebug(ch.mtDebug.newValue === true);
            }
        });
    } catch { /* no storage events in this context — the flag stays as read */ }
    try {
        chrome.runtime?.onMessage?.addListener((msg, sender) => {
            if (sender.id !== chrome.runtime.id || msg?.type !== 'mt:debug-state' || typeof msg.on !== 'boolean') return;
            if (on === msg.on) return;
            setDebug(msg.on);
        });
    } catch { /* inference workers may have no extension runtime */ }
    const before = revision;
    initializing = (async () => {
        try {
            const { mtDebug } = await chrome.storage.local.get('mtDebug');
            if (revision === before) on = mtDebug === true;
        } catch { /* contexts without storage retain the default or forwarded flag */ }
    })();
    return initializing;
}
