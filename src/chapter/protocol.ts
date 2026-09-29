import type { ChapterStart, ChapterProgress } from './model';
import type { CachedPage } from '../content/page-cache';

// Retranslate is per page: the runner redoes exactly those pages and keeps the rest.
export interface HostConfig extends ChapterStart {
    id: string;
    readerTab: number;
    // Chromium offscreen documents are addressed by URL, Firefox by the background page.
    kind: 'offscreen' | 'background';
    force?: Set<string>;
}
export interface ChapterArtifact {
    blob: Blob;
    entry: Omit<CachedPage, 'atime'>;
    at: number;
    signature: string;
}
export interface HostCheckpoint { config: HostConfig; progress: ChapterProgress }
export const runnerHtml = () => chrome.runtime.getURL('chapter/page.html');
export const artifactKey = (id: string, page: string) => `result:${id}:${page}`;
