import type { CachedPage } from './policy';

type Value = Omit<CachedPage, 'atime'> & { atime?: number };
export type CacheWire = Omit<Value, 'mask' | 'patches' | 'cpatches'> & {
    mask?: { w: number; h: number; data: string };
    patches?: (Omit<NonNullable<CachedPage['patches']>[number], 'png'> & { png: string })[];
    cpatches?: (Omit<NonNullable<CachedPage['cpatches']>[number], 'png'> & { png: string })[];
};

function encode(data: ArrayBuffer): string {
    const bytes = new Uint8Array(data);
    let raw = '';
    for (let i = 0; i < bytes.length; i += 32768) raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(raw);
}
function decode(data: string): ArrayBuffer {
    return Uint8Array.from(atob(data), char => char.charCodeAt(0)).buffer;
}

// Runtime messaging must survive both JSON serialization and structured cloning.
export function encodeCache(row: Value): CacheWire {
    return { ...row, mask: row.mask && { ...row.mask, data: encode(row.mask.data) },
        patches: row.patches?.map(patch => ({ ...patch, png: encode(patch.png) })),
        cpatches: row.cpatches?.map(patch => ({ ...patch, png: encode(patch.png) })) };
}
export function decodeCache(row: CacheWire): CachedPage {
    return { ...row, atime: row.atime ?? 0, mask: row.mask && { ...row.mask, data: decode(row.mask.data) },
        patches: row.patches?.map(patch => ({ ...patch, png: decode(patch.png) })),
        cpatches: row.cpatches?.map(patch => ({ ...patch, png: decode(patch.png) })) };
}
