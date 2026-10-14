import { loadPipelineSettings } from '../llm/pipeline-settings';

interface Change { oldValue?: unknown; newValue?: unknown }
const LIVE_KEYS = new Set(['prefetchN', 'cacheMax', 'showToasts']);

export function chapterSettingsChanged(changes: Record<string, Change>): boolean {
    for (const key of ['mtSettings', 'mtOcrSettings']) {
        const change = changes[key];
        if (change && JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue)) return true;
    }
    const change = changes.mtPipeline;
    if (!change) return false;
    const before = loadPipelineSettings(change.oldValue);
    const after = loadPipelineSettings(change.newValue);
    return (Object.keys(after) as (keyof typeof after)[]).some(key =>
        key !== 'preset' && !LIVE_KEYS.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
