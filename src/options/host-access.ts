// Host-access requests for provider origins.
//
// Contract: hostOriginPatterns() emits port-free `scheme://host/*` — Firefox match
// patterns that carry a port never match a URL, while port-free patterns cover every
// port in both browsers. requestHostAccess() must be the click handler's first awaited
// call: Firefox only allows permissions.request inside that task, and an earlier await
// throws before any prompt (already-granted origins resolve true silently).

export function hostOriginPatterns(urls: string[]): string[] {
    const patterns = new Set<string>();
    for (const raw of urls) {
        let u: URL;
        try { u = new URL(raw); } catch { continue; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        patterns.add(`${u.protocol}//${u.hostname}/*`);
    }
    return [...patterns];
}

export async function requestHostAccess(origins: string[]): Promise<void> {
    if (!origins.length) return;
    try {
        const granted = await chrome.permissions.request({ origins });
        if (!granted) throw new Error('permission denied');
    } catch (e) {
        throw new Error(`Needs access to ${origins.join(', ')} — approve the browser prompt (${(e as Error).message})`);
    }
}
