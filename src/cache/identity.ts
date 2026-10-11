import type { CachedPage } from './policy';
import { verifyBitmap, verifyGrayIdentity } from '../image-identity';

// A slot and matching dimensions are lookup hints. Image evidence authorizes reuse.
export function verifyCachedIdentity(bitmap: ImageBitmap, entry: CachedPage): boolean {
    if (!entry.idSig || !entry.idGray) return false;
    if (entry.idRegions) return verifyBitmap(bitmap, { ...entry.idSig, gray: entry.idGray, regions: entry.idRegions });
    return bitmap.width === entry.w && bitmap.height === entry.h && verifyGrayIdentity(bitmap, entry.idSig, entry.idGray);
}
