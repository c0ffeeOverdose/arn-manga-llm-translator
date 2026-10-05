import { hashPixels } from './content/page-cache';

export const IMAGE_ID_GEN = 1;
const PAGE_SAMPLE = 128;
const REGION_SAMPLE = 64;
const PHASH_SAMPLE = 32;

export interface ImageSignature {
    gen: number;
    w: number;
    h: number;
    exact: string;
    phash: string;
    contrast: number;
}
export interface ImageRegion {
    x1: number; y1: number; x2: number; y2: number;
    gray: string;
}
export interface ImageIdentity extends ImageSignature {
    gray: string;
    regions: ImageRegion[];
}
type Rect = { x1: number; y1: number; x2: number; y2: number };

// Hash distance retrieves candidates; source pixels and region evidence authorize reuse.
export function perceptualHash(gray: Uint8Array, side: number): string {
    const n = PHASH_SAMPLE;
    const pixels = new Float64Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const x1 = Math.floor(x * side / n), x2 = Math.floor((x + 1) * side / n);
        const y1 = Math.floor(y * side / n), y2 = Math.floor((y + 1) * side / n);
        let sum = 0;
        for (let sy = y1; sy < y2; sy++) for (let sx = x1; sx < x2; sx++) sum += gray[sy * side + sx];
        pixels[y * n + x] = sum / ((x2 - x1) * (y2 - y1));
    }
    const cos = Array.from({ length: 8 }, (_, k) =>
        Array.from({ length: n }, (_, i) => Math.cos(Math.PI * (2 * i + 1) * k / (2 * n))));
    const rows = new Float64Array(n * 8);
    for (let y = 0; y < n; y++) for (let k = 0; k < 8; k++) {
        for (let x = 0; x < n; x++) rows[y * 8 + k] += pixels[y * n + x] * cos[k][x];
    }
    const dct = new Float64Array(64);
    for (let ky = 0; ky < 8; ky++) for (let kx = 0; kx < 8; kx++) {
        for (let y = 0; y < n; y++) dct[ky * 8 + kx] += rows[y * 8 + kx] * cos[ky][y];
    }
    const sorted = [...dct].sort((a, b) => a - b);
    const median = (sorted[31] + sorted[32]) / 2;
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
        let nibble = 0;
        for (let j = 0; j < 4; j++) nibble = (nibble << 1) | Number(dct[i + j] > median);
        hex += nibble.toString(16);
    }
    return hex;
}
export function hashDistance(a: string, b: string): number {
    if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return Infinity;
    let distance = 0;
    for (let i = 0; i < a.length; i++) {
        let bits = parseInt(a[i], 16) ^ parseInt(b[i], 16);
        while (bits) { distance++; bits &= bits - 1; }
    }
    return distance;
}
export function imageSignature(gray: Uint8Array, w: number, h: number): ImageSignature {
    let sum = 0, squares = 0;
    for (const value of gray) { sum += value; squares += value * value; }
    const mean = sum / gray.length;
    return { gen: IMAGE_ID_GEN, w, h, exact: hashPixels(gray), phash: perceptualHash(gray, PAGE_SAMPLE),
        contrast: Math.sqrt(Math.max(0, squares / gray.length - mean * mean)) };
}
export function sameGeometry(a: ImageSignature, b: ImageSignature): boolean {
    return a.gen === IMAGE_ID_GEN && b.gen === IMAGE_ID_GEN && a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0
        && Math.abs((a.w / a.h) / (b.w / b.h) - 1) <= 0.005;
}
export function imageCandidates<T extends { image?: ImageSignature }>(image: ImageSignature, pages: T[]): T[] {
    if (image.contrast < 3) return [];
    return pages.filter(p => p.image && p.image.contrast >= 3 && sameGeometry(image, p.image)
        && (image.exact === p.image.exact || hashDistance(image.phash, p.image.phash) <= 8))
        .sort((a, b) => Number(b.image!.exact === image.exact) - Number(a.image!.exact === image.exact)
            || hashDistance(image.phash, a.image!.phash) - hashDistance(image.phash, b.image!.phash));
}

function encodeGray(gray: Uint8Array): string {
    let text = '';
    for (const value of gray) text += String.fromCharCode(value);
    return btoa(text);
}
function decodeGray(text: string, side: number): Uint8Array | undefined {
    try {
        const decoded = atob(text);
        return decoded.length === side * side ? Uint8Array.from(decoded, c => c.charCodeAt(0)) : undefined;
    } catch { return undefined; }
}
export function sampleGray(bitmap: ImageBitmap | HTMLCanvasElement, side: number, rect?: Rect): Uint8Array {
    const canvas = new OffscreenCanvas(side, side);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, side, side);
    if (rect) ctx.drawImage(bitmap, rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1, 0, 0, side, side);
    else ctx.drawImage(bitmap, 0, 0, side, side);
    const rgba = ctx.getImageData(0, 0, side, side).data;
    const gray = new Uint8Array(side * side);
    for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
    return gray;
}
export function identifyBitmap(bitmap: ImageBitmap | HTMLCanvasElement, boxes: Rect[] = []): ImageIdentity {
    const gray = sampleGray(bitmap, PAGE_SAMPLE);
    const regions = boxes.filter(b => b.x2 > b.x1 && b.y2 > b.y1).map(b => ({
        x1: b.x1 / bitmap.width, y1: b.y1 / bitmap.height, x2: b.x2 / bitmap.width, y2: b.y2 / bitmap.height,
        gray: encodeGray(sampleGray(bitmap, REGION_SAMPLE, b)),
    }));
    return { ...imageSignature(gray, bitmap.width, bitmap.height), gray: encodeGray(gray), regions };
}
export function signatureOf(image: ImageSignature): ImageSignature {
    const { gen, w, h, exact, phash, contrast } = image;
    return { gen, w, h, exact, phash, contrast };
}

// A page-wide average cannot hide a changed balloon: compare tiles and each text crop.
export function grayAgreement(a: Uint8Array, b: Uint8Array, side: number, region = false): boolean {
    if (a.length !== side * side || b.length !== a.length) return false;
    if (region) { a = smoothGray(a, side); b = smoothGray(b, side); }
    let total = 0, changed = 0;
    for (let y = 0; y < side; y += 8) for (let x = 0; x < side; x += 8) {
        let tile = 0;
        for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) {
            const i = (y + dy) * side + x + dx;
            const difference = Math.abs(a[i] - b[i]);
            tile += difference;
            if (difference > 24) changed++;
        }
        if (tile / 64 > (region ? 10 : 8)) return false;
        total += tile;
    }
    return total / a.length <= (region ? 3 : 2) && changed / a.length <= (region ? 0.015 : 0.01);
}
function smoothGray(gray: Uint8Array, side: number): Uint8Array {
    let current = gray;
    for (let pass = 0; pass < 2; pass++) {
        const next = new Uint8Array(current.length);
        for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
            let sum = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const sy = Math.max(0, Math.min(side - 1, y + dy)), sx = Math.max(0, Math.min(side - 1, x + dx));
                sum += current[sy * side + sx] * (dy ? 1 : 2) * (dx ? 1 : 2);
            }
            next[y * side + x] = Math.round(sum / 16);
        }
        current = next;
    }
    return current;
}
export function verifyBitmap(bitmap: ImageBitmap | HTMLCanvasElement, expected: ImageIdentity): boolean {
    if (!Array.isArray(expected.regions)) return false;
    const gray = sampleGray(bitmap, PAGE_SAMPLE);
    const signature = imageSignature(gray, bitmap.width, bitmap.height);
    if (!sameGeometry(signature, expected)) return false;
    if (signature.contrast < 3 && signature.exact !== expected.exact) return false;
    const original = decodeGray(expected.gray, PAGE_SAMPLE);
    if (!original || !grayAgreement(gray, original, PAGE_SAMPLE)) return false;
    for (const region of expected.regions) {
        const reference = decodeGray(region.gray, REGION_SAMPLE);
        const current = sampleGray(bitmap, REGION_SAMPLE, {
            x1: region.x1 * bitmap.width, y1: region.y1 * bitmap.height,
            x2: region.x2 * bitmap.width, y2: region.y2 * bitmap.height,
        });
        if (!reference || !grayAgreement(current, reference, REGION_SAMPLE, true)) return false;
    }
    return true;
}

// Page-level verification for a stored page identity (`idSig` + `idGray` on a cache row):
// proves the pixels are this page before an idle slot is trusted. Dims and fingerprints
// cannot reject a wrong page of equal size; the page-wide gray comparison can. Text-region
// evidence is not stored with cache rows, so a changed digit inside one page is not detected
// here — callers must use full verifyBitmap where region evidence exists.
export function verifyGrayIdentity(bitmap: ImageBitmap | HTMLCanvasElement, expected: ImageSignature, grayB64: string): boolean {
    if (!expected || typeof grayB64 !== 'string' || !grayB64) return false;
    const gray = sampleGray(bitmap, PAGE_SAMPLE);
    const signature = imageSignature(gray, bitmap.width, bitmap.height);
    if (!sameGeometry(signature, expected)) return false;
    if (signature.contrast < 3 && signature.exact !== expected.exact) return false;
    const original = decodeGray(grayB64, PAGE_SAMPLE);
    return !!original && grayAgreement(gray, original, PAGE_SAMPLE);
}
