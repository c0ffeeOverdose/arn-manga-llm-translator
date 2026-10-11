import type { PaintPatch } from './pipeline';

interface EncodedPatch { x1: number; y1: number; x2: number; y2: number; png: ArrayBuffer }
export interface DecodedPatch extends PaintPatch { dispose(): void }

async function decodePatch(patch: EncodedPatch): Promise<DecodedPatch> {
    const image = new Image();
    const blob = new Blob([patch.png], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    let bitmap: ImageBitmap | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        bitmap?.close();
        image.removeAttribute('src');
        URL.revokeObjectURL(url);
    };
    try {
        image.src = url;
        const decoded = await Promise.race([
            image.decode().then(() => true, () => false),
            new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 2000); }),
        ]);
        if (!decoded) {
            image.removeAttribute('src');
            bitmap = await createImageBitmap(blob);
        }
        return { x1: patch.x1, y1: patch.y1, x2: patch.x2, y2: patch.y2, bmp: bitmap ?? image, dispose };
    } catch (error) {
        dispose();
        throw error;
    } finally { clearTimeout(timer); }
}

// The caller disposes successful decodes after painting; a failed batch releases late successes too.
export async function decodePaintPatches(patches: EncodedPatch[]): Promise<DecodedPatch[]> {
    const owned: DecodedPatch[] = [];
    let failed = false;
    try {
        return await Promise.all(patches.map(async patch => {
            const decoded = await decodePatch(patch);
            if (failed) decoded.dispose();
            else owned.push(decoded);
            return decoded;
        }));
    } catch (error) {
        failed = true;
        for (const patch of owned) patch.dispose();
        throw error;
    }
}
