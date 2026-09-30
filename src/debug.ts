// Single debug flag (mtDebug): one toggle owns the overlay AND verbose console
// logs. Real errors/warnings stay always-on — only noise is gated.
// ponytail: one boolean, no levels — debug is either on or off.
let on = false;

export function isDebug(): boolean {
    return on;
}

export async function initDebug(onFlip?: (v: boolean) => void): Promise<void> {
    try {
        const { mtDebug } = await chrome.storage.local.get('mtDebug');
        on = mtDebug === true;
    } catch {
        on = false;
    }
    // A context may have no chrome.storage at all (a Chromium offscreen document has only
    // chrome.runtime) and no change events even when it does. This must never throw: the
    // iframe worker calls it with a TOP-LEVEL await, so an exception here aborts the whole
    // module — including the handshake token registration at its end.
    try {
        chrome.storage?.onChanged?.addListener((ch, area) => {
            if (area === 'local' && ch.mtDebug) {
                on = ch.mtDebug.newValue === true;
                onFlip?.(on);
            }
        });
    } catch { /* no storage events in this context — the flag stays as read */ }
}
