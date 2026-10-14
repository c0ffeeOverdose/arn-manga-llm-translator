import type { DetBox, DetectResult, InpaintPatch } from '../content/detection';
import type { RegionOutput, ExtraRegion, Mention } from '../llm/core';
import type { ImageSignature, ImageRegion } from '../image-identity';
import { DEFAULT_PIPELINE_SETTINGS, type PipelineSettings } from '../llm/pipeline-settings';
import { KOHARU_MODEL } from '../layout-model';

export const CACHE_MAX = 200;

export interface CachedPage {
    cacheEpoch?: string;
    key: string;      // chapter#hash or chapter@pN
    fp: string;       // settings fingerprint at translate time
    w: number; h: number; // full-page dims — must still match (cheap second gate)
    atime: number;    // last hit, for LRU
    boxes: DetBox[];
    panels: DetBox[];
    outputs: RegionOutput[];
    extras: ExtraRegion[];
    mentions?: Mention[]; // page-level named people — absent on entries written before mentions existed
    mask?: { w: number; h: number; data: ArrayBuffer };
    partial?: true;
    texts?: string[];
    ep?: string;
    splitGen?: number;
    patches?: { x1: number; y1: number; x2: number; y2: number; png: ArrayBuffer }[];
    patchesGen?: number;
    cpatches?: InpaintPatch[];
    order?: number;
    keyGen?: number;
    idSig?: ImageSignature;
    idGray?: string;
    idRegions?: ImageRegion[];
    sourceHash?: string;
}

export const INPAINT_PATCH_GEN = 5;

export const CLOUD_SPLIT_GEN = 18;
export function cloudSplitFresh(hit: { ep?: string; splitGen?: number } | undefined, isCloud: boolean): boolean {
    return !isCloud || (hit?.splitGen ?? 0) >= CLOUD_SPLIT_GEN;
}

export function packMask(
    mask: { width: number; height: number; data: ArrayBuffer }, maxSide = 256,
): { w: number; h: number; data: ArrayBuffer } {
    const { width: W, height: H } = mask;
    const step = Math.max(1, Math.floor(Math.max(W, H) / maxSide));
    const w = Math.ceil(W / step), h = Math.ceil(H / step);
    const src = new Uint8Array(mask.data);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let v = 0;
            const y1 = Math.min(y * step + step, H), x1 = Math.min(x * step + step, W);
            for (let yy = y * step; yy < y1; yy++)
                for (let xx = x * step; xx < x1; xx++) {
                    const p = src[yy * W + xx];
                    if (p > v) v = p;
                }
            out[y * w + x] = v > 127 ? 255 : 0;
        }
    }
    return { w, h, data: out.buffer as ArrayBuffer };
}

export function unpackMask(
    packed: { w: number; h: number; data: ArrayBuffer }, W: number, H: number,
): ArrayBuffer {
    const src = new Uint8Array(packed.data);
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        const sy = Math.min(packed.h - 1, Math.floor(y * packed.h / H));
        for (let x = 0; x < W; x++) {
            const sx = Math.min(packed.w - 1, Math.floor(x * packed.w / W));
            out[y * W + x] = src[sy * packed.w + sx];
        }
    }
    return out.buffer as ArrayBuffer;
}

export function isResumable(hit: CachedPage | undefined, fp: string, w: number, h: number, isCloud: boolean): hit is CachedPage {
    return !!hit && hit.partial === true && hit.fp === fp
        && hit.w === w && hit.h === h && Array.isArray(hit.boxes) && hit.boxes.length > 0 && validMask(hit.mask)
        && cloudSplitFresh(hit, isCloud);
}

export interface PageKeyDecision {
    usable: boolean;
    dropPatches: boolean;
    reason: 'ok' | 'no-entry' | 'legacy' | 'fingerprint' | 'dims' | 'partial';
}
export function pageEntryDecision(
    hit: CachedPage | undefined, hash: string, fp: string, w: number, h: number,
): PageKeyDecision {
    if (!hit) return { usable: false, dropPatches: false, reason: 'no-entry' };
    if (hit.keyGen !== PAGE_KEY_GEN) return { usable: false, dropPatches: false, reason: 'legacy' };
    if (hit.fp !== fp) return { usable: false, dropPatches: false, reason: 'fingerprint' };
    if (hit.w !== w || hit.h !== h) return { usable: false, dropPatches: false, reason: 'dims' };
    if (hit.partial === true) return { usable: false, dropPatches: false, reason: 'partial' };
    const sameBytes = !!hash && hit.sourceHash === hash;
    return { usable: true, dropPatches: !sameBytes, reason: 'ok' };
}

export function bytesCrops(hit: CachedPage | undefined, fp: string, w: number, h: number):
{ patches: NonNullable<CachedPage['patches']>; patchesGen: number } | null {
    if (!hit || hit.partial || !hit.patches?.length || hit.patchesGen !== INPAINT_PATCH_GEN) return null;
    if (hit.fp !== fp || hit.w !== w || hit.h !== h) return null;
    return { patches: hit.patches, patchesGen: hit.patchesGen };
}

export function sameCachedPlan(a: CachedPage, b: CachedPage): boolean {
    if (a.fp !== b.fp || a.w !== b.w || a.h !== b.h || a.splitGen !== b.splitGen
        || JSON.stringify([a.boxes, a.outputs, a.extras]) !== JSON.stringify([b.boxes, b.outputs, b.extras])
        || !validMask(a.mask) || !validMask(b.mask) || a.mask.w !== b.mask.w || a.mask.h !== b.mask.h) return false;
    const x = new Uint8Array(a.mask.data), y = new Uint8Array(b.mask.data);
    return x.every((value, index) => value === y[index]);
}

export function detFromPartial(hit: CachedPage, w: number, h: number): DetectResult | null {
    if (!validMask(hit.mask)) return null;
    return {
        boxes: hit.boxes, panels: hit.panels ?? [],
        mask: { width: w, height: h, data: unpackMask(hit.mask, w, h) },
        inferMs: 0, ep: hit.ep ?? 'cache', dropped: [], panelDropped: [],
        ...(hit.texts?.length ? { cloudTexts: hit.texts } : null),
        ...(hit.cpatches?.length ? { cloudPatches: hit.cpatches } : null),
        ...(hit.splitGen != null ? { splitGen: hit.splitGen } : null),
    };
}

export function detFromCacheEntry(
    hit: CachedPage | undefined, fp: string, w: number, h: number, isCloud: boolean,
): DetectResult | null {
    if (!cacheEntryFresh(hit, fp, w, h, isCloud)) return null;
    return {
        boxes: hit.boxes, panels: hit.panels,
        mask: { width: w, height: h, data: unpackMask(hit.mask!, w, h) },
        inferMs: 0, ep: 'cache', dropped: [], panelDropped: [],
        ...(hit.splitGen != null ? { splitGen: hit.splitGen } : null),
    };
}

export function cacheEntryFresh(
    hit: CachedPage | undefined, fp: string, w: number, h: number, isCloud: boolean,
): hit is CachedPage {
    return cacheMissReason(hit, fp, w, h, isCloud) === undefined;
}

export function cacheMissReason(
    hit: CachedPage | undefined, fp: string, w: number, h: number, isCloud: boolean,
): 'absent' | 'fingerprint' | 'dims' | 'splitgen' | 'mask' | 'partial' | undefined {
    if (!hit) return 'absent';
    if (hit.fp !== fp) return 'fingerprint';
    if (hit.w !== w || hit.h !== h || !(w > 0 && h > 0)) return 'dims';
    if (!cloudSplitFresh(hit, isCloud)) return 'splitgen';
    if (!validMask(hit.mask)) return 'mask';
    if (hit.partial || !Array.isArray(hit.boxes) || !Array.isArray(hit.panels) || !Array.isArray(hit.outputs)
        || !Array.isArray(hit.extras) || (hit.boxes.length > 0 && !hit.outputs.length)) return 'partial';
    return undefined;
}

function validMask(mask: CachedPage['mask']): mask is NonNullable<CachedPage['mask']> {
    return !!mask && Number.isInteger(mask.w) && mask.w > 0 && Number.isInteger(mask.h) && mask.h > 0
        && mask.data instanceof ArrayBuffer && mask.data.byteLength === mask.w * mask.h;
}

export function selectCachedPage(o: {
    bytes?: CachedPage; identity?: CachedPage; hash: string; fp: string; w: number; h: number; isCloud: boolean;
    verifyIdentity: (entry: CachedPage) => boolean;
}): { entry: CachedPage; det: DetectResult } | null {
    const exact = detFromCacheEntry(o.bytes, o.fp, o.w, o.h, o.isCloud);
    if (exact) return { entry: o.bytes!, det: exact };
    const hit = o.identity;
    if (!hit || hit.keyGen !== PAGE_KEY_GEN || !cacheEntryFresh(hit, o.fp, hit.w, hit.h, o.isCloud)) return null;
    const adapted = resizeCachedPage(hit, o.w, o.h);
    if (!adapted || !o.verifyIdentity(hit)) return null;
    const det = detFromCacheEntry(adapted, o.fp, o.w, o.h, o.isCloud);
    if (!det) return null;
    const crops = bytesCrops(o.bytes, o.fp, o.w, o.h);
    const samePlan = crops && sameCachedPlan(o.bytes!, adapted);
    const entry = { ...adapted, patches: undefined, patchesGen: undefined,
        ...(samePlan ? crops : null) };
    return { entry, det };
}

// Geometry follows proportional renditions; callers must verify source pixels before using this result.
export function resizeCachedPage(hit: CachedPage, w: number, h: number): CachedPage | null {
    if (!(hit.w > 0 && hit.h > 0 && w > 0 && h > 0) || Math.abs((w / h) / (hit.w / hit.h) - 1) > 0.005) return null;
    if (hit.w === w && hit.h === h) return hit;
    const sx = w / hit.w, sy = h / hit.h;
    const scale = <T extends { x1: number; y1: number; x2: number; y2: number }>(b: T): T => ({
        ...b, x1: b.x1 * sx, y1: b.y1 * sy, x2: b.x2 * sx, y2: b.y2 * sy,
    });
    const box = (b: DetBox): DetBox => ({ ...scale(b), ...(b.clip ? { clip: scale(b.clip) } : null) });
    return { ...hit, w, h, boxes: hit.boxes.map(box), panels: hit.panels.map(box), extras: hit.extras.map(scale),
        patches: undefined, patchesGen: undefined };
}

export function withSources<T extends { source: string }>(regions: T[], texts: string[]): T[] {
    return regions.map((r, i) => ({ ...r, source: texts[i] ?? r.source }));
}

export function partialEntry(key: string, fp: string, det: DetectResult, w: number, h: number): Omit<CachedPage, 'atime'> {
    return {
        key, fp, w, h,
        boxes: det.boxes, panels: det.panels ?? [],
        outputs: [], extras: [],
        texts: det.cloudTexts ?? [],
        ...(det.cloudPatches?.length ? { cpatches: det.cloudPatches } : null),
        ep: det.ep,
        splitGen: det.splitGen ?? 0,
        mask: packMask(det.mask),
        partial: true as const,
    };
}

export function cacheKey(chapter: string, hash: string): string {
    return `${chapter}#${hash}`;
}

export function pageKey(chapter: string, order: number): string {
    return `${chapter}@p${order}`;
}

export const PAGE_KEY_GEN = 1;

export type FingerprintOpts = Partial<PipelineSettings>;

// Paid results follow input and prompt settings; presentation and pool sizing reuse them.
export function settingsFingerprint(o: FingerprintOpts): string {
    const s = { ...DEFAULT_PIPELINE_SETTINGS, ...o };
    return JSON.stringify([s.targetLang, s.textSource, s.ocrEngine, s.readingDir,
        s.detConf, s.detMinSize, s.panelConf, s.deferLabels, s.transcribeSrc, s.useOcrModel,
        s.ocrPerRegion, s.temperature, s.ocrTemperature, s.inferEngine, s.ocrLangs,
        s.stylePrompt, s.vlmAssistedDetection, s.fullPageSize, s.cropSize, s.jpegQuality,
        s.grayscaleBw, s.useContext, s.useCharacters, s.crossChapter, s.contextPairs,
        s.charLimit, s.thinkingLevel, s.ocrThinking, s.mergePages, 'tile40',
        ...(s.layoutModel === 'koharu' ? [KOHARU_MODEL.recipe, KOHARU_MODEL.sha256,
            s.koharuTextConf, s.koharuSfxConf, s.koharuPanelConf] : [])]);
}
