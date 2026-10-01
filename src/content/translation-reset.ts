import { cacheGeneration, onCacheReset } from '../cache-generation';
import { uniquePages, stateFor, unregPage, regPage, clearPageBindings, setOverlayOn, setOverlayChoice, type PageState } from './state';
import { getPages, writePage } from './page-io';
import { clearQueue, haltAuto, failMarks } from './queue';
import { cancelLookahead, resetWarmedPages } from './auto';
import { abortLiveRpcs } from './ocr';
import { forgetSweep } from './sweep';
import { cacheClear } from './page-cache';
import { removeActivity, lastMsgSet, renderStatus } from './status-ui';

let reset: Promise<void> = Promise.resolve();
export function resetReaderTranslations(): Promise<void> {
    reset = reset.catch(() => {}).then(async () => {
        const token = cacheGeneration();
        haltAuto('cache'); clearQueue(); cancelLookahead(); resetWarmedPages(); abortLiveRpcs(); forgetSweep();
        setOverlayChoice('original'); setOverlayOn(false);
        const old = uniquePages();
        const unrestored = new Set<string>();
        for (const ref of getPages()) {
            const state = stateFor(ref);
            if (state) await writePage(ref, { ...state, cacheEpoch: token, debug: undefined, debugOrig: undefined });
            if (state && ref.kind === 'img' && ref.el.src !== (state.origOwn ?? state.orig)) unrestored.add(ref.el.src);
        }
        const originals: PageState[] = old.map(state => {
            const original: PageState = { cacheEpoch: token, orig: state.orig, translated: state.origOwn ?? state.orig,
                origOwn: state.origOwn, origBytes: state.origBytes, origBmp: state.origBmp,
                image: state.image, paintedImage: state.image };
            state.origOwn = undefined; state.origBmp = undefined;
            unregPage(state);
            if (state.translated !== state.orig && state.translated !== original.origOwn && !unrestored.has(state.translated)) URL.revokeObjectURL(state.translated);
            if (state.debug && !unrestored.has(state.debug)) URL.revokeObjectURL(state.debug);
            if (state.debugOrig && !unrestored.has(state.debugOrig)) URL.revokeObjectURL(state.debugOrig);
            return original;
        });
        clearPageBindings();
        for (const original of originals) regPage(original);
        await cacheClear();
        failMarks.clear(); removeActivity('lookahead'); lastMsgSet(null); renderStatus();
        if (unrestored.size) throw new Error('Translations were cleared, but an original image is unavailable — reload that reader');
    });
    return reset;
}
export function initTranslationReset(): void { onCacheReset(resetReaderTranslations); }
