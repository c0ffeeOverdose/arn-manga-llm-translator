export type LayoutModel = 'ctd' | 'koharu';

export const KOHARU_MODEL = {
    key: 'koharu-fp32-q256-35d89289e92a6dba',
    file: 'koharu-fp32-chunked.onnx',
    bytes: 149799163,
    sha256: '35d89289e92a6dba75b9ccd4ebd447a55aad69c993d0a8e439c57509d598dfd6',
    recipe: 'koharu-fp32-q256-v2',
} as const;

export interface KoharuThresholds {
    text: number;
    sfx: number;
    bubble: number;
    panel: number;
}

export const KOHARU_THRESHOLDS: KoharuThresholds = { text: 0.25, sfx: 0.20, bubble: 0.50, panel: 0.50 };

export function koharuThresholds(value?: Partial<KoharuThresholds>): KoharuThresholds {
    const result = { ...KOHARU_THRESHOLDS };
    for (const k of ['text', 'sfx', 'bubble', 'panel'] as const) {
        const v = value?.[k];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0.05 && v <= 1) result[k] = v;
    }
    return result;
}
