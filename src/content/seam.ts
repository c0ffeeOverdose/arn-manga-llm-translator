// Seam chains: one scene sliced into consecutive same-width images.
// A cut bubble (gate: seamLinked in page-cache) translates as fragments when
// each slice runs solo. The owner job stitches the chain into ONE logical
// page — detect/OCR/LLM once on the stitch, paint whole, slice write-back —
// so the sentence flows across the cut like the original. Serial-only: pump
// passes allowSeam=false for parallel batches (no shared book to order, and
// concurrent owners could interleave slice writes). Any failure → null → the
// caller falls back to the solo path; members render solo as if seamless.

import { pageHashFromBitmap, cacheKey, settingsFingerprint, cachePut, packMask, seamLinked, seamInkLinked, seamTruncated, boxIoU, bandSpan, seamRowsMatch } from './page-cache';
import { ensureFont, renderTuning, RENDER_GEN } from './render';
import { updateContext, type Mention, type RegionOutput } from '../llm/core';
import { isDebug } from '../debug';
import { type DetectResult, type DetBox, type MtOnStatus } from './detection';
import { pipeline, context, shareContext, chapterKey, pages, regPage, unregPage, debugOn, sessionUsage, setLastPageUsage, saveContext, type PageRef, type PageState } from './state';
import { getPages, fetchBitmap, writePage } from './page-io';
import { detectPage, orderDetection, paintRegions, paintExtras, type Prep } from './pipeline';
import { translateRegions, renderDebugView, panelRanks } from './ocr';
import { rewindContextBefore, replayPagesAfter, pageKeyOf, enqueue, dequeue, queueFind, activeKeyGet, activePrepGet } from './queue';

interface SeamMember { ref: PageRef; key: string; srcUrl: string; bitmap: ImageBitmap; hash: string; det: DetectResult }
export const SEAM_MAX = 4; // owner + 3 — bounds the stitch canvas + pulled jobs

export interface Job { ref: PageRef; force: boolean; prep: Promise<Prep | null>; key: string; auto: boolean }

// edge-row pixels for the continuity guard: bottom row of the upper bitmap,
// top row of the lower one. Crop + readback, ms-scale. Null on any failure
// (caller treats null as reject — fail closed).
async function seamEdgeRow(bmp: ImageBitmap, edge: 'bottom' | 'top'): Promise<Uint8ClampedArray | null> {
    try {
        const c = new OffscreenCanvas(bmp.width, 1);
        const x = c.getContext('2d', { willReadFrequently: true })!;
        x.drawImage(bmp, 0, edge === 'bottom' ? bmp.height - 1 : 0, bmp.width, 1, 0, 0, bmp.width, 1);
        return x.getImageData(0, 0, bmp.width, 1).data;
    } catch { return null; }
}

async function seamPixels(u: ImageBitmap, l: ImageBitmap): Promise<boolean> {
    if (!u.width || u.width !== l.width) return false;
    const [a, b] = await Promise.all([seamEdgeRow(u, 'bottom'), seamEdgeRow(l, 'top')]);
    return !!a && !!b && seamRowsMatch(a, b, u.width);
}

// Band verification (suspicion second stage): stack the upper page's bottom
// quarter over the lower page's top quarter and detect on the band. The band
// shows CTD the whole local bubble where slices show fragments, so a box
// spanning the band seam confirms the cut near-deterministically. Small image,
// ~1s, no LLM — a wrong suspicion costs only that.
async function bandConfirms(u: SeamMember, l: SeamMember): Promise<boolean> {
    try {
        const Bu = Math.max(64, Math.floor(u.bitmap.height * 0.25));
        const Bl = Math.max(64, Math.floor(l.bitmap.height * 0.25));
        const W = Math.max(u.bitmap.width, l.bitmap.width);
        const band = new OffscreenCanvas(W, Bu + Bl);
        const bctx = band.getContext('2d', { willReadFrequently: true })!;
        bctx.drawImage(u.bitmap, 0, u.bitmap.height - Bu, u.bitmap.width, Bu, 0, 0, W, Bu);
        bctx.drawImage(l.bitmap, 0, 0, l.bitmap.width, Bl, 0, Bu, W, Bl);
        const det = await detectPage(await createImageBitmap(band), () => {});
        return bandSpan(det.boxes, Bu);
    } catch { return false; }
}

export async function trySeam(job: Job, prep: Prep, onStatus: MtOnStatus): Promise<PageState | null> {
    // trace helper: every bailout logs its reason (debug-gated — the gate has
    // three silent stages and blind tuning wastes whole E2E runs)
    const trace = (why: string, extra?: object) => {
        if (isDebug()) console.log('[mt] seam?', JSON.stringify({ page: prep.bitmap.width + 'x' + prep.bitmap.height, why, ...(extra ?? {}) }));
    };
    // prune helper (declared here so the catch below can also reach it):
    // pulled members outside the final chain return to the pool (autoTick
    // picks them up in-window later) instead of soloing immediately.
    const pulled: PageRef[] = [];
    const chainKeys = new Set<string>();
    const prune = () => {
        for (const ref of pulled) {
            if (!chainKeys.has(pageKeyOf(ref))) dequeue(ref);
        }
        pulled.length = 0;
    };
    try {
        // contiguous img run around the job with matching width (±2px); canvases
        // and undecodable imgs break the run (solo fallback this round — autoTick
        // retries once decoded). Key match, not element: the reader may have
        // swapped elements since enqueue (same src = same page).
        const refs = getPages();
        const at = refs.findIndex(r => pageKeyOf(r) === job.key);
        if (at === -1) { trace('ref-gone'); return null; }
        const w0 = job.ref.kind === 'img' ? job.ref.el.naturalWidth : 0;
        if (!w0) { trace('undecoded'); return null; }
        // balanced expansion (up AND down, 3 each — up-first starved file 6 out
        // of file 5's run); the chain cap below re-trims around the owner
        const run: PageRef[] = [refs[at]];
        for (let i = at - 1, n = 0; i >= 0 && n < SEAM_MAX - 1; i--, n++) {
            const r = refs[i];
            if (r.kind !== 'img' || Math.abs(r.el.naturalWidth - w0) > 2) break;
            run.unshift(r);
        }
        for (let i = at + 1, n = 0; i < refs.length && n < SEAM_MAX - 1; i++, n++) {
            const r = refs[i];
            if (r.kind !== 'img' || Math.abs(r.el.naturalWidth - w0) > 2) break;
            run.push(r);
        }
        if (run.length < 2) { trace('lone-width', { run: run.length }); return null; }
        // resolve pixels + solo boxes per member: queued/active preps first (no
        // re-detect), rendered states next (backward case: the old slice gets
        // overwritten whole), auto-pulled enqueue last (manual never expands
        // scope — no surprise LLM spend). Unresolvable members become HOLES that
        // split the run (a missing neighbor vetoes nothing — the owner's
        // contiguous block still links); a block of <2 means solo.
        const members: (SeamMember | null)[] = [];
        // concurrent resolution (was sequential awaits — 6 members × ~10s
        // fetch+detect stalled the owner for a minute): pulls enqueue upfront so
        // all member preps overlap, then one join. Order kept via placeholders.
        // (pulled/chainKeys/prune live at trySeam top for catch visibility.)
        const pend: Promise<{ idx: number; m: SeamMember | null }>[] = [];
        for (const ref of run) {
            const key = pageKeyOf(ref);
            if (key === job.key) {
                members.push({ ref, key, srcUrl: prep.srcUrl, bitmap: prep.bitmap, hash: prep.hash, det: prep.det });
                continue;
            }
            members.push(null); // placeholder — filled by the join below, order kept
            pend.push((async () => {
                const idx = members.length - 1;
                const q = queueFind(key);
                let mp: Prep | null = null;
                try {
                    if (q) mp = await q.prep;
                    else if (key === activeKeyGet() && activePrepGet()) mp = await activePrepGet();
                    else if (job.auto || job.force) {
                        const r = enqueue(ref, false, true);
                        const jq = (r === 'queued' || r === 'dup') ? queueFind(key) : undefined;
                        if (jq) pulled.push(ref);
                        mp = jq ? await jq.prep : (key === activeKeyGet() && activePrepGet() ? await activePrepGet() : null);
                    }
                } catch (e) { trace('member-prep-fail', { member: key.slice(-16), err: String((e as Error)?.message ?? e).slice(0, 80) }); mp = null; }
                const st = pages.get(key);
                // NOTE: cached member preps are FIRST-class stitch inputs (fresh pixels
                // in bitmap, valid page-local det for the gate) — excluding them holed
                // every warm-cache run. Their own jobs twin-skip later (owner registers
                // states first), so no double render.
                if (mp) {
                    return { idx, m: { ref, key, srcUrl: mp.srcUrl, bitmap: mp.bitmap, hash: mp.hash, det: mp.det } };
                } else if (st) {
                    // rendered before (solo fragments or cache hit): re-derive pixels and
                    // re-detect on the stitch — the detector sees the whole bubble, the
                    // old slice gets overwritten whole
                    try {
                        const { bitmap } = await fetchBitmap(st.orig);
                        return { idx, m: { ref, key, srcUrl: st.orig, bitmap, hash: pageHashFromBitmap(bitmap), det: st.det ?? prep.det } };
                    } catch { return { idx, m: null }; }
                }
                trace('hole', { member: key.slice(-24) });
                return { idx, m: null };
            })());
        }
        for (const { idx, m } of await Promise.all(pend)) members[idx] = m;
        // owner's contiguous block only
        const me = members.findIndex(m => m?.key === job.key);
        let blo = me, bhi = me;
        while (blo > 0 && members[blo - 1]) blo--;
        while (bhi + 1 < members.length && members[bhi + 1]) bhi++;
        const block = members.slice(blo, bhi + 1) as SeamMember[];
        if (block.length < 2) { trace('lone-block'); prune(); return null; }
        // gate every adjacent pair on solo boxes; shrink to the maximal linked
        // sub-run containing the job (a mid-run miss = two independent scenes)
        const linked = [true];
        for (let i = 1; i < block.length; i++) {
            const u = block[i - 1], l = block[i];
            // box gate first (cheap); ink gate catches cut text with zero boxes
            // (CTD drops truncated edge fragments — the mask still flags them);
            // truncation gate catches unboxed glyph bottoms running into the cut
            // single-sided (the stitch decides truth either way)
            linked.push(
                seamLinked(u.det.boxes, u.bitmap.height, l.det.boxes, l.bitmap.height) ||
                seamInkLinked(u.det.mask, l.det.mask) ||
                seamTruncated(u.det.boxes, u.det.mask, u.bitmap.height, 'bottom') ||
                seamTruncated(l.det.boxes, l.det.mask, l.bitmap.height, 'top'),
            );
        }
        // shrink + cap around the owner (maximal linked sub-run; ties and excess
        // trim the end farther from the owner, reading flows down). Never drops
        // the owner: pop runs only when the bottom end is strictly farther.
        const shrink = (): SeamMember[] => {
            let a = block.findIndex(m => m.key === job.key);
            let b = a;
            while (a > 0 && linked[a]) a--;
            while (b + 1 < block.length && linked[b + 1]) b++;
            const c = block.slice(a, b + 1);
            while (c.length > SEAM_MAX) {
                const meAt = c.findIndex(m => m.key === job.key);
                const topDist = meAt, botDist = c.length - 1 - meAt;
                if (topDist > 0 && topDist >= botDist) c.shift();
                else c.pop();
            }
            return c;
        };
        let chain = shrink();
        if (chain.length < 2) {
            // second stage: single-sided suspicion — a WIDE box near either edge
            // (the other side may be CTD-blind) + band verification. Wide-only
            // keeps small edge labels out; a wrong suspicion costs one ~1s band
            // detect, nothing else. Local-only: cloud skips the extra POST.
            if (pipeline.inferEngine !== 'cloud') {
                for (let i = 1; i < block.length; i++) {
                    if (linked[i]) continue;
                    const u = block[i - 1], l = block[i];
                    const susp = u.det.boxes.some(b => u.bitmap.height - b.y2 <= 48 && b.x2 - b.x1 >= 150) ||
                        l.det.boxes.some(b => b.y1 <= 48 && b.x2 - b.x1 >= 150);
                    if (!susp) continue;
                    onStatus('Verifying seam…');
                    linked[i] = await bandConfirms(u, l);
                    trace('band-verify', { ok: linked[i] });
                }
                chain = shrink();
            }
        }
        if (chain.length < 2) {
            trace('gate-miss', {
                pairs: linked.slice(1).map((v, i) => v ? undefined : [
                    block[i].det.boxes.map(b => [Math.round(b.x1), Math.round(b.y1), Math.round(b.x2), Math.round(b.y2)]),
                    block[i + 1].det.boxes.map(b => [Math.round(b.x1), Math.round(b.y1), Math.round(b.x2), Math.round(b.y2)]),
                ]).filter(Boolean),
            });
            prune();
            return null;
        }
        // pixel-continuity: every remaining pair must continue row-exact (kills
        // wrong-pair stitches from lazy-load DOM gaps regardless of filenames —
        // live: files 8+10 linked across an unloaded 9). ms-scale, no LLM.
        for (let i = 1; i < chain.length; i++) {
            const u = chain[i - 1], l = chain[i];
            const bi = block.findIndex(m => m.key === l.key);
            if (u.bitmap.width !== l.bitmap.width || !(await seamPixels(u.bitmap, l.bitmap))) {
                linked[bi] = false;
                trace('pixel-reject', { members: [u.srcUrl.slice(-16), l.srcUrl.slice(-16)] });
            }
        }
        chain = shrink();
        if (chain.length < 2) {
            trace('gate-miss', {
                pairs: linked.slice(1).map((v, i) => v ? undefined : [
                    block[i].det.boxes.map(b => [Math.round(b.x1), Math.round(b.y1), Math.round(b.x2), Math.round(b.y2)]),
                    block[i + 1].det.boxes.map(b => [Math.round(b.x1), Math.round(b.y1), Math.round(b.x2), Math.round(b.y2)]),
                ]).filter(Boolean),
            });
            prune();
            return null;
        }
        for (const m of chain) chainKeys.add(m.key);
        prune();
        // rebuild the keep-set from the FINAL chain (pixel-rejected members
        // return to the pool with everything else unlinked)
        chainKeys.clear();
        for (const m of chain) chainKeys.add(m.key);
        prune();
        trace('linked', { n: chain.length, members: chain.map(m => m.srcUrl.slice(-16)) });
        // stitch: exact concatenation (slices are cut, not overlapped — proven
        // pixel-identical rows at the seam, residual = independent webp ringing)
        onStatus(`Stitching ${chain.length} pages…`);
        const W = Math.max(...chain.map(m => m.bitmap.width));
        const H = chain.reduce((n, m) => n + m.bitmap.height, 0);
        const stitch = new OffscreenCanvas(W, H);
        const sctx = stitch.getContext('2d', { willReadFrequently: true })!;
        const y0: number[] = [];
        let y = 0;
        for (const m of chain) { y0.push(y); sctx.drawImage(m.bitmap, 0, y); y += m.bitmap.height; }
        const stitchBmp = await createImageBitmap(stitch);
        const det = await detectPage(stitchBmp, onStatus);
        // safety net: stitch context can drop a marginal edge line the solo pass
        // caught (live: "BLOOD...!" scored 0.51 solo, vanished on the stitch).
        // Re-add solo boxes the stitch missed — EXCEPT fragments of a bubble the
        // stitch already found whole (IoU≥0.3, or >50% inside a stitch box:
        // repainting those double-paints Thai-on-Thai in the overlap zone).
        // Added BEFORE ordering, so panels/banding/cloud-texts treat them
        // uniformly (cloud appended texts ride as '' — the server never saw them).
        chain.forEach((m, mi) => {
            for (const b of m.det.boxes) {
                const sb: DetBox = { ...b, y1: b.y1 + y0[mi], y2: b.y2 + y0[mi] };
                const area = (sb.x2 - sb.x1) * (sb.y2 - sb.y1);
                const dup = det.boxes.some(s => {
                    if (boxIoU(s, sb) >= 0.3) return true;
                    const ix = Math.max(0, Math.min(s.x2, sb.x2) - Math.max(s.x1, sb.x1));
                    const iy = Math.max(0, Math.min(s.y2, sb.y2) - Math.max(s.y1, sb.y1));
                    return ix * iy > area * 0.5;
                });
                if (!dup) {
                    det.boxes.push(sb);
                    if (det.cloudTexts) det.cloudTexts.push('');
                }
            }
        });
        if (!det.boxes.length) { prune(); return null; }
        await orderDetection(det, stitchBmp);
        if (det.mask.data.byteLength !== W * H) { prune(); return null; } // slice math needs row-major W×H
        // rewind one book for the whole chain (members rendered solo before get
        // their fragment contribution rewound, like the solo twin path)
        if (shareContext) {
            const olds = chain.map(m => pages.get(m.key)).filter((s): s is PageState => !!s);
            if (olds.length) await rewindContextBefore(...olds);
        }
        const outcome = await translateRegions(stitchBmp, det, onStatus);
        if (outcome.error) { prune(); return null; } // members fall back to solo (parked normally)
        const { outputs, extras, mentions, bookOps, usedLLM, usage, llmCalls, llmMs, ocrStatus, ocrMs } = outcome;
        const annWCache = outcome.annW, annHCache = outcome.annH;
        const rawLLM = outcome.raw;
        await ensureFont();
        const frame = sctx.getImageData(0, 0, W, H);
        const layouts = paintRegions(stitch, frame, det, outputs);
        paintExtras(stitch, frame, det, extras);
        if (isDebug()) console.log('[mt] page result', JSON.stringify({
            page: `${W}x${H}`, seam: chain.length,
            minFont: renderTuning.minFont, gen: RENDER_GEN, detConf: pipeline.detConf,
            usedLLM,
            det: { ep: det.ep, ms: Math.round(det.inferMs), initMs: det.initMs ?? null, panelMs: det.panelMs ?? null },
            llm: usage || llmCalls ? { calls: llmCalls ?? 1, ms: llmMs, inTok: usage?.inTok ?? null, outTok: usage?.outTok ?? null, cachedInTok: usage?.cachedInTok ?? null } : null,
            ocr: ocrStatus ? { ok: ocrStatus.filter(s => s === 'ok').length, empty: ocrStatus.filter(s => s === 'empty').length, ms: ocrMs ?? null } : null,
            boxes: det.boxes.map(b => ({ x1: Math.round(b.x1), y1: Math.round(b.y1), x2: Math.round(b.x2), y2: Math.round(b.y2), conf: +b.conf.toFixed(2) })),
            ...(bookOps?.length ? { bookOps } : null),
        }));
        if (rawLLM == null) console.warn('[mt] llm raw unavailable — stale service worker? reload the extension');
        // commit per member: slice pixels, local-coords det/outputs, own cache
        // entry (revisit = solo cache hits, no stitch needed), own write-back.
        // A box SPANNING the seam belongs to its center member ONLY, clipped to
        // that range — painting the whole translation on both halves duplicates
        // it on revisit (live-proven). The other half keeps its art (plus any
        // safety-net line of its own); the owner stitch render stays perfect.
        let top: PageState | null = null;
        for (let i = 0; i < chain.length; i++) {
            const m = chain[i];
            const my0 = y0[i], mh = m.bitmap.height;
            const slice = await createImageBitmap(stitch, 0, my0, W, mh);
            const sc = new OffscreenCanvas(W, mh);
            sc.getContext('2d')!.drawImage(slice, 0, 0);
            const blob = await sc.convertToBlob({ type: 'image/png' });
            const spans = (b: DetBox) => b.y1 < my0 || b.y2 > my0 + mh;
            const inRange = (b: DetBox) => b.y2 > my0 && b.y1 < my0 + mh;
            const remap = new Map<number, number>();
            det.boxes.forEach((b, bi) => {
                if (!inRange(b)) return;
                // spanning → center member only; contained → the intersected member
                if (!spans(b) || (b.y1 + b.y2) / 2 >= my0 && (b.y1 + b.y2) / 2 < my0 + mh) {
                    remap.set(bi + 1, remap.size + 1);
                }
            });
            const clip = (b: DetBox): DetBox => ({
                ...b, y1: Math.max(b.y1, my0) - my0, y2: Math.min(b.y2, my0 + mh) - my0,
            });
            const boxes: DetBox[] = [];
            det.boxes.forEach((b, bi) => { if (remap.has(bi + 1)) boxes.push(clip(b)); });
            const memberOutputs = outputs.filter(o => remap.has(o.index)).map(o => ({ ...o, index: remap.get(o.index)! }));
            const memberExtras = extras.filter(e => e.y2 > my0 && e.y1 < my0 + mh)
                .map(e => ({ ...e, y1: e.y1 - my0, y2: e.y2 - my0 }));
            const memberPanels = (det.panels ?? []).filter(inRange).map(p => ({ ...p, y1: p.y1 - my0, y2: p.y2 - my0 }));
            const maskRows = det.mask.data.slice(my0 * W, (my0 + mh) * W);
            const localDet: DetectResult = {
                ...det, boxes, panels: memberPanels,
                mask: { width: W, height: mh, data: maskRows },
            };
            const state: PageState = {
                orig: m.srcUrl,
                translated: URL.createObjectURL(blob),
                det: localDet,
                outputs: memberOutputs,
                mentions: i === 0 ? mentions : [], // page-level list — top member only, folds once
                hash: m.hash,
            };
            if (debugOn && boxes.length) {
                state.debugOrig = await renderDebugView(m.bitmap, boxes, memberPanels, panelRanks(memberPanels), det.dropped ?? [], det.panelDropped ?? []);
                state.debug = await renderDebugView(await createImageBitmap(sc), boxes, memberPanels, panelRanks(memberPanels), det.dropped ?? [], det.panelDropped ?? []);
            }
            const existing = pages.get(m.key);
            if (existing) {
                unregPage(existing);
                URL.revokeObjectURL(existing.translated);
                if (existing.debug) URL.revokeObjectURL(existing.debug);
                if (existing.debugOrig) URL.revokeObjectURL(existing.debugOrig);
            }
            regPage(state);
            if (pipeline.cacheEnabled) {
                void cachePut({
                    key: cacheKey(chapterKey(), m.hash),
                    fp: settingsFingerprint(pipeline),
                    w: m.bitmap.width, h: m.bitmap.height,
                    boxes, panels: memberPanels,
                    outputs: memberOutputs, extras: memberExtras, mentions: state.mentions ?? [],
                    mask: packMask(localDet.mask),
                }, pipeline.cacheMax);
            }
            writePage(m.ref, state);
            if (!top) top = state;
        }
        if (usage) {
            sessionUsage.pages++;
            sessionUsage.inTok += usage.inTok ?? 0;
            sessionUsage.outTok += usage.outTok ?? 0;
            sessionUsage.cachedInTok += usage.cachedInTok ?? 0;
        }
        setLastPageUsage({ inTok: usage?.inTok, outTok: usage?.outTok, cachedInTok: usage?.cachedInTok, ms: llmMs, calls: llmCalls });
        if (job.force && shareContext && top) {
            replayPagesAfter(top);
            await saveContext();
        }
        return top;
    } catch (e) {
        // no chain was committed (or it was partial — members re-queue cleanly):
        // release every pull so nothing solo-translates-and-pulls-further
        chainKeys.clear();
        try { prune(); } catch { /* prune is best-effort */ }
        console.warn('[mt] seam failed, solo fallback:', (e as Error)?.message ?? e);
        return null;
    }
}
