import { pages, elStates, retiredBlobs, stateFor, type PageRef, type PageState } from './state';
import { fetchBitmap, refKey, unscrambleTiles } from './page-io';
import { identifyBitmap, verifyBitmap, type ImageIdentity } from '../image-identity';

export interface PageSnapshot {
    source: string;
    token: string;
    bitmap: ImageBitmap;
    image: ImageIdentity;
    fromNetwork: boolean;
}
// Identity token for the element's current view. A reader can display a page THROUGH a
// multi-MB data: URL (save conversions), and embedding it verbatim makes every token
// comparison cost milliseconds — collapse long URLs to a bounded fingerprint (length + head +
// tail) that still changes whenever the displayed image changes. Pure.
function tokenUrl(u: string): string {
    return u.length > 4096 ? `${u.length}:${u.slice(0, 40)}:${u.slice(-40)}` : u;
}
export function viewToken(ref: PageRef): string {
    return ref.kind === 'img'
        ? JSON.stringify([tokenUrl(ref.el.src), tokenUrl(ref.el.currentSrc), ref.el.naturalWidth, ref.el.naturalHeight])
        : JSON.stringify([ref.pageSrc, ref.key, ref.el.width, ref.el.height]);
}
export function viewSource(ref: PageRef): string {
    if (ref.kind === 'canvas') return refKey(ref);
    const live = ref.el.currentSrc || ref.el.src;
    return pages.get(live)?.orig ?? retiredBlobs.get(live) ?? live;
}
function ownsDisplayedImage(ref: PageRef, state: PageState): boolean {
    if (ref.kind === 'canvas') return false;
    const live = ref.el.currentSrc || ref.el.src;
    return [state.origOwn, state.translated, state.debug, state.debugOrig].includes(live) || retiredBlobs.get(live) === state.orig;
}
export async function savedOriginal(state: PageState): Promise<ImageBitmap> {
    if (state.origBytes) return createImageBitmap(new Blob([state.origBytes]));
    if (state.origOwn) return createImageBitmap(await (await fetch(state.origOwn)).blob());
    if (/^https?:/.test(state.orig)) return (await fetchBitmap(state.orig)).bitmap;
    throw new Error('Original image is no longer available');
}

// Capture only the current source; an owned render is read through its saved original.
// No screenshot fallback here: a verification probe must not scroll or photograph our paint.
export async function readView(ref: PageRef): Promise<PageSnapshot> {
    if (!ref.el.isConnected || (ref.kind === 'img' && !ref.el.complete)) throw new Error('Image is not ready');
    const token = viewToken(ref), source = viewSource(ref);
    const state = stateFor(ref);
    let bitmap: ImageBitmap | undefined;
    let fromNetwork = false;
    try {
        if (state && ownsDisplayedImage(ref, state)) {
            fromNetwork = !state.origBytes && !state.origOwn && /^https?:/.test(state.orig);
            bitmap = await savedOriginal(state);
        }
        else {
            try {
                bitmap = await createImageBitmap(ref.el);
                const image = identifyBitmap(bitmap);
                if (ref.kind === 'canvas' && state?.paintedImage && verifyBitmap(bitmap, state.paintedImage) && state.origBytes) {
                    bitmap.close();
                    bitmap = await savedOriginal(state);
                } else if (ref.kind === 'canvas' && state?.paintedImage && state.image && !verifyBitmap(bitmap, state.image)) {
                    if (pages.get(source) === state) pages.delete(source);
                    elStates.delete(ref.el);
                }
            } catch (e) {
                bitmap?.close(); bitmap = undefined;
                if (!/^https?:/.test(source)) throw e;
                bitmap = (await fetchBitmap(source)).bitmap;
                fromNetwork = true;
                if (ref.kind === 'canvas' && ref.pageSrc) {
                    const fixed = await unscrambleTiles(bitmap);
                    if (fixed) { bitmap.close(); bitmap = fixed.bitmap; }
                }
            }
        }
        const image = identifyBitmap(bitmap);
        if (!ref.el.isConnected || viewToken(ref) !== token) throw new Error('Image changed while reading');
        return { token, source, bitmap, image, fromNetwork };
    } catch (e) { bitmap?.close(); throw e; }
}

// Element-local read only: same-origin and blob images decode with no network roundtrip. A
// cross-origin https image is not origin-clean, so its pixels are not readable here — the
// caller gets undefined and decides whether it can proceed without them (a positionally
// identified page can paint first and resolve pixel identity later) or needs the full read.
export async function readViewLocal(ref: PageRef): Promise<PageSnapshot | undefined> {
    if (!ref.el.isConnected || (ref.kind === 'img' && !ref.el.complete)) return undefined;
    const token = viewToken(ref);
    let bitmap: ImageBitmap | undefined;
    let keep = false;
    try {
        bitmap = await createImageBitmap(ref.el);
        if (!ref.el.isConnected || viewToken(ref) !== token) return undefined;
        const image = identifyBitmap(bitmap);
        keep = true;
        return { token, source: viewSource(ref), bitmap, image, fromNetwork: false };
    } catch {
        return undefined;
    } finally {
        if (bitmap && !keep) bitmap.close();
    }
}
export async function verifyView(ref: PageRef, snapshot: PageSnapshot, identity: ImageIdentity): Promise<boolean> {
    if (!ref.el.isConnected || viewToken(ref) !== snapshot.token) return false;
    let current: PageSnapshot | undefined;
    try {
        current = await readView(ref);
        const stable = current.image.exact === snapshot.image.exact
            || /^https?:/.test(snapshot.source) && (current.fromNetwork || snapshot.fromNetwork)
                && (ref.kind === 'img' || ref.pageSrc === snapshot.source);
        return current.token === snapshot.token && stable
            && verifyBitmap(current.bitmap, identity);
    } catch { return false; }
    finally { current?.bitmap.close(); }
}

// Attach-time verification: the reader may have minted a fresh blob for the SAME page while
// the artifact was in flight, so the recorded token is stale — but the pixels are still the
// authority. Re-read the current view and require the artifact's identity to match IT. A
// recycled element showing another page fails verifyBitmap and is still refused, so dropping
// the token-equality requirement costs no safety here (verifyView stays strict for callers
// that need "nothing moved at all").
export async function verifyViewFresh(ref: PageRef, identity: ImageIdentity): Promise<boolean> {
    if (!ref.el.isConnected) return false;
    let current: PageSnapshot | undefined;
    try {
        current = await readView(ref);
        return verifyBitmap(current.bitmap, identity);
    } catch { return false; }
    finally { current?.bitmap.close(); }
}
