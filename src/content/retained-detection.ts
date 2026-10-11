import type { DetectResult } from './detection';

export type RetainedDetection = Omit<DetectResult, 'mask'> & {
    mask: { width: number; height: number; encoding: 'bits' | 'raw'; bytes: ArrayBuffer };
};

// Page state keeps exact mask pixels in compact storage. Only an operation that needs
// pixels expands them; no decoded copy is attached to the retained state.
export function retainDetection(det: DetectResult): RetainedDetection {
    const { width, height, data } = det.mask;
    const src = new Uint8Array(data);
    const bits = new Uint8Array(Math.ceil(width * height / 8));
    for (let i = 0; i < src.length; i++) {
        if (src[i] !== 0 && src[i] !== 255) return { ...det,
            mask: { width, height, encoding: 'raw', bytes: data.slice(0) } };
        if (src[i]) bits[i >> 3] |= 1 << (i & 7);
    }
    return { ...det, mask: { width, height, encoding: 'bits', bytes: bits.buffer } };
}

export function restoreDetection(det: RetainedDetection): DetectResult {
    const { width, height, encoding, bytes } = det.mask;
    let data: ArrayBuffer;
    if (encoding === 'raw') data = bytes.slice(0);
    else {
        const bits = new Uint8Array(bytes), out = new Uint8Array(width * height);
        for (let i = 0; i < out.length; i++) out[i] = bits[i >> 3] & (1 << (i & 7)) ? 255 : 0;
        data = out.buffer;
    }
    return { ...det, mask: { width, height, data } };
}
