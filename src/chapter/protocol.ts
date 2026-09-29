import type { ChapterStart, ChapterProgress } from './model';
import type { CachedPage } from '../content/page-cache';

// Retranslate is per page: the host redoes exactly those pages and keeps the rest.
export interface HostConfig extends ChapterStart { id: string; readerTab: number; hostTab?: number; force?: Set<string> }
export interface ChapterArtifact {
    blob: Blob;
    entry: Omit<CachedPage, 'atime'>;
    at: number;
    signature: string;
}
export interface HostCheckpoint { config: HostConfig; progress: ChapterProgress }
export const hostUrl = () => chrome.runtime.getURL('chapter/host.html');
export const artifactKey = (id: string, page: string) => `result:${id}:${page}`;
