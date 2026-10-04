// Synchronous canvas encoders. toDataURL completes in the renderer, while the async
// blob path (toBlob/convertToBlob) is idle-scheduled and can stall for seconds per
// call on Android builds up to Chromium 135 — see LESSONS.md "canvas encoding".

// JPEG payload (no data: prefix) for a canvas.
export function canvasJpegB64(canvas: HTMLCanvasElement, quality: number): string {
    const url = canvas.toDataURL('image/jpeg', quality);
    return url.slice(url.indexOf(',') + 1);
}

// PNG Blob for an OffscreenCanvas or HTMLCanvasElement — same sync encode, then a
// local base64 decode into the Blob object URLs need.
export async function canvasPngBlob(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
    let source: HTMLCanvasElement;
    if (typeof (canvas as HTMLCanvasElement).toDataURL === 'function') {
        source = canvas as HTMLCanvasElement;
    } else {
        source = document.createElement('canvas');
        source.width = canvas.width;
        source.height = canvas.height;
        source.getContext('2d', { willReadFrequently: true })!
            .drawImage(canvas as unknown as CanvasImageSource, 0, 0);
    }
    const url = source.toDataURL('image/png');
    const b64 = url.slice(url.indexOf(',') + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
}
