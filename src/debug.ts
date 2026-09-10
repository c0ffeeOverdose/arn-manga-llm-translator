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
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.mtDebug) {
            on = ch.mtDebug.newValue === true;
            onFlip?.(on);
        }
    });
}
