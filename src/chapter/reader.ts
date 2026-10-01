import { sameChapterDocument } from './discovery';

// A sender URL may name the document's initial route. The current top-frame URL and
// its origin/chapter are the authority; an unrelated route must never start this run.
export function readerStartAllowed(reader: string, chapter: string, current: string, senderOrigin: string): boolean {
    try {
        return new URL(current).origin === senderOrigin
            && sameChapterDocument(reader, current, chapter) && sameChapterDocument(current, current, chapter);
    } catch { return false; }
}
