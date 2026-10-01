export function grayPage(seed = 1, side = 128) {
    return Uint8Array.from({ length: side * side }, (_, i) => {
        const x = i % side, y = Math.floor(i / side);
        const ink = (x * (seed + 3) + y * (seed * 3 + 5)) % 97 < 12;
        return ink ? 20 + seed * 2 : 235;
    });
}
export function bitmap(gray = grayPage(), { width = 600, height = 800, region = grayPage(3, 64), clean = true } = {}) {
    return { width, height, gray, region, clean, closed: false,
        close() { this.closed = true; } };
}
export class TestCanvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
        const canvas = this;
        return {
            fillRect() {},
            drawImage(source, ...args) { canvas.source = source; canvas.region = args.length === 8; },
            getImageData() {
                const source = canvas.source;
                if (source?.clean === false) throw new Error('SecurityError');
                const gray = canvas.region ? source.region : source.gray;
                const side = Math.sqrt(gray.length);
                const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
                for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
                    const sample = gray[Math.floor(y * side / canvas.height) * side + Math.floor(x * side / canvas.width)];
                    const i = (y * canvas.width + x) * 4;
                    data.set([sample, sample, sample, 255], i);
                }
                return { data };
            },
        };
    }
}
export function imageRef(source, pixels) {
    return { kind: 'img', el: { src: source, currentSrc: source, complete: true, isConnected: true,
        naturalWidth: pixels.width, naturalHeight: pixels.height, pixels } };
}
export function installCanvas() {
    globalThis.OffscreenCanvas = TestCanvas;
    globalThis.createImageBitmap = async source => {
        const pixels = source.pixels ?? source;
        return bitmap(pixels.gray, { ...pixels });
    };
}
