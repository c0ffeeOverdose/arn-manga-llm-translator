// Which page URL does a reader message belong to?
//
// `sender.url` is frozen at content-script injection. On an SPA reader (a client-side chapter
// switch) the document survives and `location` moves on, so the content script's cache keys
// name the NEW chapter while `sender.url` still names the old one — the background then refused
// the reader's own keys ("Saved page does not belong to this reader"). The tab's live URL is the
// authority; sender.url is only the fallback for a tab whose URL is unavailable.
//
// Pure: plain strings in, one URL out.
export function liveSenderUrl(senderUrl: string | undefined, tabUrl: string | undefined): string {
    return tabUrl || senderUrl || '';
}
