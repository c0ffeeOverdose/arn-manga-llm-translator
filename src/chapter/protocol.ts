import type { ChapterStart, ChapterProgress } from './model';
import type { CachedPage } from '../content/page-cache';
import { IMAGE_ID_GEN, type ImageIdentity } from '../image-identity';
import { RENDER_GEN } from '../content/render';
import type { PipelineSettings } from '../llm/pipeline-settings';

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
    identity?: ImageIdentity;
    hash?: string;
}
export interface HostCheckpoint { config: HostConfig; progress: ChapterProgress }
export const runnerHtml = () => chrome.runtime.getURL('chapter/page.html');
export const artifactKey = (id: string, page: string) => `result:${id}:${page}`;
export const chapterSignature = (pipeline: PipelineSettings) => `${JSON.stringify(pipeline)}:${RENDER_GEN}:image${IMAGE_ID_GEN}`;
