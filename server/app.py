# Cloud inference for the manga translator: CTD text detection + Baberu OCR
# over HTTP, CPU-only (fits the HuggingFace free tier).
#
# Recipes ported 1:1 from src/iframe/worker.ts — same thresholds, same gates,
# same decode loop. Resize uses bilinear like canvas drawImage; exact pixels
# may differ from the browser path, so parity is VERIFIED (not assumed) by
# comparing boxes/texts against the local pipeline on real pages.
#
# Panels: v1 returns [] — the client falls back to banding ordering, the same
# path it takes when the panel model file is missing. No fidelity risk.
# Splits: run_detect runs the same splitMergedBoxes family as the on-device
# worker (lane 1/2, twin-balloon cut, short-first, 10px split-input floor),
# and OCR crops grow past edge-cut glyphs like the client's expandCropToInk.
# /v1/page reports SPLIT_GEN so the client re-detects entries from older
# servers instead of rendering their fused boxes from cache.
import asyncio
import base64
import io
import json
import math
import os
import re
import time

import cv2
import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse
from PIL import Image

MODEL_DIR = os.environ.get("MODEL_DIR", "/models")
# EP chain: local default CPU; Modal sets "CUDAExecutionProvider,CPUExecutionProvider"
ORT_PROVIDERS = os.environ.get("ORT_PROVIDERS", "CPUExecutionProvider").split(",")

# ---- tunables: mirror src/iframe/worker.ts exactly ----
CTD_INPUT = 1024
CONF_THR = 0.35
NMS_THR = 0.35
MASK_THR = 0.3
MIN_SIZE = 12
LETTERBOX = (113, 113, 113)  # #717171
STRIP_ASPECT = 3
TILE_SIZE = 1200
TILE_OVERLAP = 180
COMP_GAP = 28

BABERU_MEAN = (0.485, 0.456, 0.406)
BABERU_STD = (0.229, 0.224, 0.225)
PAST_IN = [f"past_k{i}" for i in range(6)] + [f"past_v{i}" for i in range(6)]
PRESENT_OUT = [f"present_k{i}" for i in range(6)] + [f"present_v{i}" for i in range(6)]

app = FastAPI(title="arn-manga")
lock = asyncio.Lock()  # one inference at a time (2 vCPU, no oversubscription)
ctd = None
baberu = None  # {vis, pre, stp, bos, eos, id2ch, contentIds}
inpaint = None  # manga-LaMa fp16w; missing file only disables POST /v1/inpaint
EPS = {}  # session -> provider chain (proves GPU placement in prod logs)


def _load(path):
    if not os.path.isfile(path):
        raise RuntimeError(f"model file missing: {path}")
    return path


OPTS = ort.SessionOptions()


def _sess(path, providers):
    t = time.perf_counter()
    s = ort.InferenceSession(_load(path), OPTS, providers=providers)
    print(f"session {os.path.basename(path)}: {(time.perf_counter()-t)*1000:.0f}ms",
          flush=True)
    return s


def load_models():
    global ctd, baberu, inpaint
    print("onnxruntime:", ort.__version__,
          "available:", ort.get_available_providers(), flush=True)
    t_all = time.perf_counter()
    ctd = _sess(f"{MODEL_DIR}/ctd.onnx", ORT_PROVIDERS)
    vis = _sess(f"{MODEL_DIR}/vision-int4.onnx", ORT_PROVIDERS)
    pre = _sess(f"{MODEL_DIR}/baberu-prefill.onnx", ORT_PROVIDERS)
    stp = _sess(f"{MODEL_DIR}/baberu-step.onnx", ORT_PROVIDERS)
    print(f"all sessions: {(time.perf_counter()-t_all)*1000:.0f}ms", flush=True)
    with open(_load(f"{MODEL_DIR}/vocab.json"), encoding="utf-8") as f:
        charset = json.load(f)
    id2ch, content = {}, set()
    for i, ch in enumerate(charset):
        id2ch[i + 4] = ch
        # pass 1 like baberuParseVocab: single alnum, minus the long-dash set
        if len(ch) == 1 and ch not in "ーｰ〜~" and re.match(r"[A-Za-z0-9]", ch):
            content.add(i + 4)
    # pass 2 like the isContentChar extension (reference unicodedata approx)
    for i, ch in id2ch.items():
        cp = ord(ch[0]) if ch else 0
        if (re.match(r"[A-Za-z0-9]", ch) or 0x3040 <= cp <= 0x30FF
                or 0x3400 <= cp <= 0x9FFF or 0xF900 <= cp <= 0xFAFF
                or 0xFF66 <= cp <= 0xFF9D):
            content.add(i)
    baberu = {"vis": vis, "pre": pre, "stp": stp, "bos": 1, "eos": 2,
              "id2ch": id2ch, "contentIds": content}
    # optionally loadable: a server without the 112MB cleanup model still
    # serves detection/OCR, /v1/inpaint answers 503
    try:
        inpaint = _sess(f"{MODEL_DIR}/lama-manga-512-fp16w.onnx", ORT_PROVIDERS)
    except Exception as e:
        inpaint = None
        print(f"inpaint model not loaded: {e}", flush=True)
    EPS.update({n: s.get_providers() for n, s in
                {"ctd": ctd, "vis": vis, "pre": pre, "stp": stp}.items()
                if n != "inpaint"})
    if inpaint is not None:
        EPS["inpaint"] = inpaint.get_providers()
    print("ORT providers:", EPS, flush=True)


@app.on_event("startup")
def _startup():
    load_models()


@app.get("/health")
def health():
    # splitGen is here (not just /v1/page) so a remote client can verify the
    # server runs the split/mask logic its cache gate expects — a stale Colab
    # process otherwise fails silently back to fused boxes.
    return {"ok": bool(ctd and baberu), "device": os.environ.get("ORT_DEVICE", "cpu"),
            "panels": "client-fallback", "ep": EPS or None, "splitGen": SPLIT_GEN}


@app.get("/")
def root():
    return {"service": "arn-manga",
            "endpoints": ["/health", "POST /v1/page", "POST /v1/inpaint"]}


def nms(boxes, confs):
    idx = sorted(range(len(boxes)), key=lambda i: -confs[i])
    keep = []
    while idx:
        i = idx.pop(0)
        keep.append(i)
        a = boxes[i]
        rest = []
        for j in idx:
            b = boxes[j]
            ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
            iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
            inter = ix * iy
            union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
            if not (union > 0 and inter / union > NMS_THR):
                rest.append(j)
        idx = rest
    return keep


def split_tiles(w, h):
    vertical = h >= w
    long, short = (h, w) if vertical else (w, h)
    if long / short <= STRIP_ASPECT:
        return []
    step = TILE_SIZE - TILE_OVERLAP
    n = max(2, -(-(long - TILE_OVERLAP) // step))  # ceil
    ln = (long + (n - 1) * TILE_OVERLAP) / n
    out = []
    for i in range(n):
        o = round(i * (ln - TILE_OVERLAP))
        out.append((0, o, w, round(ln)) if vertical else (o, 0, round(ln), h))
    return out


def merge_tile_boxes(tiled):
    allb = [(b[0] + t[0], b[1] + t[1], b[2] + t[0], b[3] + t[1], b[4], ti)
            for ti, (t, bs) in enumerate(tiled) for b in bs]
    changed = True
    while changed:
        changed = False
        for i in range(len(allb)):
            for j in range(i + 1, len(allb)):
                a, b = allb[i], allb[j]
                if a[5] == b[5]:
                    continue
                gx = max(0, min(a[2], b[2]) - max(a[0], b[0]))
                gy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
                gapx = max(a[0] - b[2], b[0] - a[2], 0)
                gapy = max(a[1] - b[3], b[1] - a[3], 0)
                if not ((gx > 0 or gapx <= 8) and (gy > 0 or gapy <= 8)):
                    continue
                minside = min(a[2] - a[0], a[3] - a[1], b[2] - b[0], b[3] - b[1])
                if max(gx, gy) < 0.5 * minside:
                    continue
                allb[i] = (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]),
                           max(a[3], b[3]), max(a[4], b[4]), a[5])
                del allb[j]
                changed = True
                break
            if changed:
                break
    return [(x1, y1, x2, y2, c) for x1, y1, x2, y2, c, _ in allb]


from split import (SPLIT_GEN, expand_crop_to_ink, pack_mask, rescue_split_comp,
                   split_merged_boxes)
def infer_once(pil, conf_thr):
    w, h = pil.size
    s = CTD_INPUT / max(w, h)
    nw, nh = round(w * s), round(h * s)
    canvas = Image.new("RGB", (CTD_INPUT, CTD_INPUT), LETTERBOX)
    canvas.paste(pil.resize((nw, nh), Image.BILINEAR), (0, 0))
    x = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
    t0 = time.perf_counter()
    names = [o.name for o in ctd.get_outputs()]
    out = dict(zip(names, ctd.run(None, {"image": x})))
    infer_ms = (time.perf_counter() - t0) * 1000
    raw = out["bbox_preds"].reshape(-1, 7)
    boxes, confs, low_boxes, low_confs = [], [], [], []
    for cx, cy, bw, bh, c4, c5, c6 in raw:
        conf = float(c4 * max(c5, c6))
        if conf < 0.05:
            continue
        bx = [(cx - bw / 2) / s, (cy - bh / 2) / s,
              (cx + bw / 2) / s, (cy + bh / 2) / s]
        low_boxes.append(bx)
        low_confs.append(conf)
        if conf < conf_thr:
            continue
        boxes.append(bx)
        confs.append(conf)
    # mask: top-left nw×nh of the 1024 field, upscaled to page size
    m = out["mask"].reshape(CTD_INPUT, CTD_INPUT)[:nh, :nw]
    prob = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR).astype(np.float32)
    return boxes, confs, low_boxes, low_confs, prob, infer_ms


def run_detect(pil, conf_thr, min_size):
    w, h = pil.size
    tiles = split_tiles(w, h)
    infer_ms = 0.0
    if not tiles:
        boxes, confs, low_boxes, low_confs, prob, infer_ms = infer_once(pil, conf_thr)
    else:
        per = []
        prob = np.zeros((h, w), np.float32)
        for (x0, y0, tw, th) in tiles:
            b, c, lb, lc, p, ms = infer_once(
                pil.crop((x0, y0, x0 + tw, y0 + th)), conf_thr)
            per.append(((x0, y0), b, c, lb, lc, p))
            infer_ms += ms
        merged = merge_tile_boxes(
            [((x0, y0), [(*bb[:4], cc) for bb, cc in zip(b, c)])
             for (x0, y0), b, c, _, _, _ in per])
        boxes = [[x1, y1, x2, y2] for x1, y1, x2, y2, _ in merged]
        confs = [c for _, _, _, _, c in merged]
        low_boxes, low_confs = [], []
        for (x0, y0), _, _, lb, lc, _ in per:
            for l, c in zip(lb, lc):
                low_boxes.append([l[0] + x0, l[1] + y0, l[2] + x0, l[3] + y0])
                low_confs.append(c)
        for (x0, y0), _, _, _, _, p in per:
            th, tw = p.shape
            np.maximum(prob[y0:y0 + th, x0:x0 + tw], p,
                       out=prob[y0:y0 + th, x0:x0 + tw])
    keep = [i for i in nms(boxes, confs)
            if boxes[i][2] - boxes[i][0] > min_size and boxes[i][3] - boxes[i][1] > min_size]
    # containment gate: ≥80% inside another → drop the lower-confidence one
    contained = set()
    for a in range(len(keep)):
        for b in range(len(keep)):
            if a == b or a in contained or b in contained:
                continue
            A, B = boxes[keep[a]], boxes[keep[b]]
            ix = max(0, min(A[2], B[2]) - max(A[0], B[0]))
            iy = max(0, min(A[3], B[3]) - max(A[1], B[1]))
            inter = ix * iy
            if not inter:
                continue
            aA = (A[2] - A[0]) * (A[3] - A[1])
            aB = (B[2] - B[0]) * (B[3] - B[1])
            if inter > 0.8 * aA:
                contained.add(a if confs[keep[a]] <= confs[keep[b]] else b)
            elif inter > 0.8 * aB:
                contained.add(b if confs[keep[b]] < confs[keep[a]] else a)
    out_boxes = [
        {"x1": max(0.0, boxes[i][0]), "y1": max(0.0, boxes[i][1]),
         "x2": min(float(w), boxes[i][2]), "y2": min(float(h), boxes[i][3]),
         "conf": confs[i]}
        for i in keep if i not in contained
    ]

    def overlaps(c):
        for o in out_boxes:
            ix = max(0, min(o["x2"], c[2]) - max(o["x1"], c[0]))
            iy = max(0, min(o["y2"], c[3]) - max(o["y1"], c[1]))
            inter = ix * iy
            if inter > 0.05 * (c[2] - c[0]) * (c[3] - c[1]) or \
               inter > 0.15 * (o["x2"] - o["x1"]) * (o["y2"] - o["y1"]):
                return True
        return False

    # Same text-likelihood definition everywhere a mask component must claim
    # to be text: mean raw mask prob, corroborated by any low-confidence
    # box-head prediction overlapping it.
    def comp_box_conf(c):
        box_conf = 0.0
        c_area = (c["x2"] - c["x1"]) * (c["y2"] - c["y1"])
        for bx, bc in zip(low_boxes, low_confs):
            ix = max(0, min(bx[2], c["x2"]) - max(bx[0], c["x1"]))
            iy = max(0, min(bx[3], c["y2"]) - max(bx[1], c["y1"]))
            if ix * iy > 0.1 * c_area and bc > box_conf:
                box_conf = bc
        return box_conf

    # mask components (4-connectivity like the browser BFS)
    packed = (prob > MASK_THR).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(packed, connectivity=4)
    prob_sum = np.bincount(labels.ravel(), weights=prob.ravel(), minlength=n)
    comps = []
    for lab in range(1, min(n, 401)):
        x, y, bw, bh, area = (int(stats[lab, i]) for i in range(5))
        if bw >= 8 and bh >= 8:
            comps.append({"x1": x, "y1": y, "x2": x + bw, "y2": y + bh,
                          "count": int(area), "psum": float(prob_sum[lab]),
                          "labs": {lab}})
    # Split-input comps: raw text clusters snapshotted BEFORE the merge below
    # (a merged bbox would hide the gap between two balloons) and filtered by
    # the same text-likelihood gate pass 3 uses — mirrors worker.ts, including
    # the 10px split-evidence floor (pass 3 keeps its own >=14 floor, so no
    # new junk regions are created by this). box_comps is the stricter set the
    # child BOXES are measured from (mean prob >= 0.75).
    texty_comps, box_comps = [], []
    for c in comps:
        bw, bh = c["x2"] - c["x1"], c["y2"] - c["y1"]
        if bw < 10 or bh < 10:
            continue
        if c["count"] / (bw * bh) < 0.02:
            continue
        mean = c["psum"] / c["count"]
        if mean < 0.75 and comp_box_conf(c) < 0.20:
            continue
        r = {"x1": c["x1"], "y1": c["y1"], "x2": c["x2"], "y2": c["y2"]}
        texty_comps.append(r)
        if mean >= 0.75:
            box_comps.append(r)
    # merge touching-when-padded components
    changed = True
    while changed:
        changed = False
        for i in range(len(comps)):
            for j in range(i + 1, len(comps)):
                a, b = comps[i], comps[j]
                if not (a["x1"] - COMP_GAP > b["x2"] or b["x1"] - COMP_GAP > a["x2"]
                        or a["y1"] - COMP_GAP > b["y2"] or b["y1"] - COMP_GAP > a["y2"]):
                    comps[i] = {"x1": min(a["x1"], b["x1"]), "y1": min(a["y1"], b["y1"]),
                                "x2": max(a["x2"], b["x2"]), "y2": max(a["y2"], b["y2"]),
                                "count": a["count"] + b["count"], "psum": a["psum"] + b["psum"],
                                "labs": a["labs"] | b["labs"]}
                    del comps[j]
                    changed = True
                    break
            if changed:
                break
    page_area = w * h
    mask_boxes = []

    def overlaps_rect(r):
        for o in out_boxes:
            ix = max(0, min(o["x2"], r["x2"]) - max(o["x1"], r["x1"]))
            iy = max(0, min(o["y2"], r["y2"]) - max(o["y1"], r["y1"]))
            inter = ix * iy
            if inter > 0.05 * (r["x2"] - r["x1"]) * (r["y2"] - r["y1"]) or \
               inter > 0.15 * (o["x2"] - o["x1"]) * (o["y2"] - o["y1"]):
                return True
        return False

    for c in comps:
        if len(mask_boxes) >= 16:
            break
        x1, y1, x2, y2 = c["x1"], c["y1"], c["x2"], c["y2"]
        bw, bh = x2 - x1, y2 - y1
        fill = c["count"] / (bw * bh)
        if bw < 14 or bh < 14 or fill < 0.02 or fill > 0.6:
            continue
        if bw * bh > 0.2 * page_area:
            continue
        mask_prob = c["psum"] / c["count"]
        if mask_prob < 0.75 and comp_box_conf(c) < 0.20:
            continue
        if not overlaps((x1, y1, x2, y2)):
            mask_boxes.append({"x1": float(x1), "y1": float(y1),
                               "x2": float(x2), "y2": float(y2), "conf": 0.5})
            continue
        # sole killer was the overlap gate — second chance via split: pieces
        # outside all boxes survive as their own regions (see rescue_split_comp)
        labs = c["labs"]

        def count_in(rx1, ry1, rx2, ry2, _labs=labs):
            win_lab = labels[max(0, ry1):min(h, ry2), max(0, rx1):min(w, rx2)]
            win_pr = prob[max(0, ry1):min(h, ry2), max(0, rx1):min(w, rx2)]
            m = np.isin(win_lab, list(_labs))
            return int(m.sum()), float(win_pr[m].sum())

        for r in rescue_split_comp(
                {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                texty_comps, box_comps, COMP_GAP, page_area,
                count_in, overlaps_rect, comp_box_conf):
            if len(mask_boxes) >= 16:
                break
            mask_boxes.append({"x1": float(r["x1"]), "y1": float(r["y1"]),
                               "x2": float(r["x2"]), "y2": float(r["y2"]),
                               "conf": 0.5})
    # split AFTER the mask-only pass: a merged box's generous coverage must
    # still suppress mask clusters it swallowed (pre-split list feeds the
    # overlap gate), and only then does each balloon become its own box —
    # mirrors worker.ts.
    boxes = split_merged_boxes(out_boxes + mask_boxes, texty_comps, COMP_GAP, box_comps)
    # packed is 0/1 — packMask mirrors the client's byte mask (0/255)
    mw, mh, mbytes = pack_mask(w, h, (packed * 255).ravel())
    return boxes, infer_ms, {"w": mw, "h": mh,
                             "b64": base64.b64encode(mbytes).decode("ascii")}


def run_baberu(crop):
    B = baberu
    x = np.asarray(crop.resize((224, 224), Image.BICUBIC),
                   dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
    mean = np.array(BABERU_MEAN, np.float32).reshape(1, 3, 1, 1)
    std = np.array(BABERU_STD, np.float32).reshape(1, 3, 1, 1)
    t0 = time.perf_counter()
    (embeds,) = B["vis"].run(["vision_embeds"], {"pixel_values": x})
    if not all(np.isfinite(embeds.flat[:16])):
        raise RuntimeError("baberu vision produced non-finite embeds")
    out = B["pre"].run(None, {
        "vision_embeds": embeds,
        "input_ids": np.array([[B["bos"]]], dtype=np.int64)})
    names = [o.name for o in B["pre"].get_outputs()]

    def last_logits(vals):
        lg, shape = vals[names.index("logits")], B["pre"].get_outputs()[names.index("logits")].shape
        return lg.reshape(-1, shape[-1])[-1].astype(np.float64)

    logits = last_logits(out)
    present = [out[names.index(n)] for n in PRESENT_OUT]
    seq, toks = [B["bos"]], []
    pos = embeds.shape[1] + 1
    for _ in range(128):
        for tid in set(seq):
            s = logits[tid]
            logits[tid] = s * 1.2 if s < 0 else s / 1.2
        if toks and toks[-1] in B["contentIds"]:
            last, run = toks[-1], 0
            for t in reversed(toks):
                if t != last:
                    break
                run += 1
            if run >= 12:
                logits[last] = -np.inf
        nxt = int(np.argmax(logits[1:]) + 1)
        if nxt == B["eos"]:
            break
        toks.append(nxt)
        seq.append(nxt)
        if len(toks) >= 128:
            break
        feed = {"input_ids": np.array([[nxt]], dtype=np.int64),
                "position_ids": np.array([[pos]], dtype=np.int64)}
        for nm, p in zip(PAST_IN, present):
            feed[nm] = p
        out = B["stp"].run(None, feed)
        snames = [o.name for o in B["stp"].get_outputs()]
        lg = out[snames.index("logits")]
        v = B["stp"].get_outputs()[snames.index("logits")].shape[-1]
        logits = lg.reshape(-1, v)[-1].astype(np.float64)
        present = [out[snames.index(n)] for n in PRESENT_OUT]
        pos += 1
    ms = (time.perf_counter() - t0) * 1000
    return "".join(B["id2ch"].get(t, "") for t in toks), ms


def baberu_crop(pil, rgb, b):
    pad = max(4, (b["y2"] - b["y1"]) * 0.10)
    rect = {"x": max(0, math.floor(b["x1"] - pad)), "y": max(0, math.floor(b["y1"] - pad)),
            "w": math.ceil(b["x2"] - b["x1"] + 2 * pad), "h": math.ceil(b["y2"] - b["y1"] + 2 * pad)}
    r = expand_crop_to_ink(rgb, b, rect)
    x = max(0, math.floor(r["x"]))
    y = max(0, math.floor(r["y"]))
    w = min(pil.width - x, math.ceil(r["w"]))
    h = min(pil.height - y, math.ceil(r["h"]))
    return pil.crop((x, y, x + w, y + h))


INPAINT_SIZE = 512
INPAINT_PAD_RATIO = 0.5


def inpaint_dilate_radius(w, h):
    """Mirror of aiCleanupDilate() in src/content/inpaint.ts — big scans have
    bigger glyph gaps, and a tight mask makes the model paint the leftover white
    glyphs over the whole window."""
    return min(10, max(4, round(4 * max(w, h) / 1600)))


def run_inpaint(pil, boxes, pad_ratio, mask=None):
    """Erase the given boxes with the manga-LaMa model (fp16 weights, 512x512).

    The client sends the prepared binary erase mask (restricted to the erase
    boxes and dilated — thin glyph strokes and the gaps between them drop out of
    the 512px window resize and the model then paints the leftover white glyphs'
    background over the whole window). Without one the mask is rebuilt from CTD
    here, restricted to the boxes and dilated with the same recipe. Windows are
    cut from the original image, edge-padded to a square, run at 512x512, and
    composited back only where the mask says text was. Returns per-box PNG
    patches (the same shape the on-device worker produces).
    """
    det_ms = 0.0
    if mask is None:
        _, _, _, _, prob, det_ms = infer_once(pil, CONF_THR)
        raw = prob > MASK_THR
        mask = np.zeros_like(raw)
        for b in boxes:
            x1 = max(0, int(np.floor(b["x1"]))); y1 = max(0, int(np.floor(b["y1"])))
            x2 = min(pil.width, int(np.ceil(b["x2"]))); y2 = min(pil.height, int(np.ceil(b["y2"])))
            mask[y1:y2, x1:x2] = raw[y1:y2, x1:x2]
        mask = cv2.dilate(mask.astype(np.uint8), np.ones((3, 3), np.uint8),
                          iterations=inpaint_dilate_radius(pil.width, pil.height)) > 0
    rgb = np.asarray(pil.convert("RGB"), dtype=np.uint8)
    H, W = rgb.shape[:2]
    out = rgb.copy()
    t0 = time.perf_counter()
    windows = 0
    for b in boxes:
        x1 = max(0, min(W - 1, int(np.floor(b["x1"]))))
        y1 = max(0, min(H - 1, int(np.floor(b["y1"]))))
        x2 = max(x1 + 1, min(W, int(np.ceil(b["x2"]))))
        y2 = max(y1 + 1, min(H, int(np.ceil(b["y2"]))))
        bw, bh = x2 - x1, y2 - y1
        pad = max(8, round(max(bw, bh) * pad_ratio))
        side = round(max(bw, bh) + 2 * pad)
        sx = round(x1 + bw / 2 - side / 2)
        sy = round(y1 + bh / 2 - side / 2)
        cx1, cy1 = max(0, sx), max(0, sy)
        cx2, cy2 = min(W, sx + side), min(H, sy + side)
        top, left = cy1 - sy, cx1 - sx
        bottom = side - (cy2 - cy1) - top
        right = side - (cx2 - cx1) - left
        crop = rgb[cy1:cy2, cx1:cx2]
        mcrop = mask[cy1:cy2, cx1:cx2].astype(np.uint8) * 255
        # edge padding (not reflect): always valid however wide the margin is
        crop_sq = np.pad(crop, ((top, bottom), (left, right), (0, 0)), mode="edge")
        mask_sq = np.pad(mcrop, ((top, bottom), (left, right)), mode="edge")
        img512 = np.asarray(Image.fromarray(crop_sq).resize(
            (INPAINT_SIZE, INPAINT_SIZE), Image.LANCZOS), dtype=np.float32) / 255.0
        m512 = np.asarray(Image.fromarray(mask_sq).resize(
            (INPAINT_SIZE, INPAINT_SIZE), Image.NEAREST)) > 127
        inp = np.concatenate([img512 * (1 - m512[..., None]),
                              m512[..., None].astype(np.float32)], axis=2)
        pred = inpaint.run(None, {"input": np.transpose(inp, (2, 0, 1))[None].astype(np.float32)})[0][0]
        pred = np.transpose(np.clip(pred, 0.0, 1.0), (1, 2, 0))
        win = np.asarray(Image.fromarray((pred * 255).astype(np.uint8)).resize(
            (side, side), Image.LANCZOS))
        mwin = np.asarray(Image.fromarray(mask_sq).resize(
            (side, side), Image.NEAREST)) > 127
        ox, oy = max(0, -sx), max(0, -sy)
        sub_out = out[cy1:cy2, cx1:cx2]
        sub_win = win[oy:oy + (cy2 - cy1), ox:ox + (cx2 - cx1)]
        sub_mask = mwin[oy:oy + (cy2 - cy1), ox:ox + (cx2 - cx1)]
        sub_out[sub_mask] = sub_win[sub_mask]
        windows += 1
    patches = []
    for b in boxes:
        px1 = max(0, int(np.floor(b["x1"])) - 4)
        py1 = max(0, int(np.floor(b["y1"])) - 4)
        px2 = min(W, int(np.ceil(b["x2"])) + 4)
        py2 = min(H, int(np.ceil(b["y2"])) + 4)
        crop = out[py1:py2, px1:px2]
        if crop.size == 0:
            continue
        buf = io.BytesIO()
        Image.fromarray(crop).save(buf, format="PNG")
        patches.append({"x1": px1, "y1": py1, "x2": px2, "y2": py2,
                        "png": base64.b64encode(buf.getvalue()).decode("ascii")})
    ms = (time.perf_counter() - t0) * 1000
    return patches, windows, ms, det_ms


@app.post("/v1/inpaint")
async def inpaint_page(req: Request, pad_ratio: float = Query(INPAINT_PAD_RATIO)):
    if inpaint is None:
        return JSONResponse({"ok": False, "error": "inpaint model not loaded on the server"}, 503)
    t0 = time.perf_counter()
    mask = None
    try:
        body = await req.json()
        raw = base64.b64decode(body.get("image") or "")
        boxes = body.get("boxes") or []
        pil = Image.open(io.BytesIO(raw)).convert("RGB")
        mask_b64 = body.get("mask")
        if mask_b64:
            m = Image.open(io.BytesIO(base64.b64decode(mask_b64))).convert("L")
            if m.size != pil.size:
                return JSONResponse({"ok": False, "error": f"mask size {m.size} != image {pil.size}"}, 400)
            mask = np.asarray(m) > 127
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"bad request: {e}"}, 400)
    async with lock:
        try:
            patches, windows, ms, det_ms = run_inpaint(pil, boxes, pad_ratio, mask)
        except Exception as e:
            return JSONResponse({"ok": False, "error": f"inpaint failed: {e}"}, 500)
    return {"ok": True, "patches": patches, "windows": windows,
            "ms": {"detect": round(det_ms, 1), "inpaint": round(ms, 1),
                   "total": round((time.perf_counter() - t0) * 1000, 1)}}


@app.post("/v1/page")
async def page(req: Request,
               conf_thr: float = Query(CONF_THR), min_size: int = Query(MIN_SIZE)):
    t0 = time.perf_counter()
    raw = await req.body()
    body_ms = (time.perf_counter() - t0) * 1000
    try:
        pil = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"bad image: {e} (got {len(raw)} bytes head={raw[:8].hex()})"}, 400)
    async with lock:
        boxes, det_ms, mask = run_detect(pil, conf_thr, min_size)
        rgb = np.asarray(pil.convert("RGB"), dtype=np.uint8)
        texts, ocr_ms = [], 0.0
        for b in boxes:
            try:
                t, ms = run_baberu(baberu_crop(pil, rgb, b))
            except Exception:
                t, ms = "", 0.0
            texts.append(t)
            ocr_ms += ms
    total = (time.perf_counter() - t0) * 1000
    return {
        "ok": True,
        "w": pil.width, "h": pil.height,
        "boxes": [{"x1": round(float(b["x1"]), 1), "y1": round(float(b["y1"]), 1),
                   "x2": round(float(b["x2"]), 1), "y2": round(float(b["y2"]), 1),
                   "conf": round(float(b["conf"]), 4)} for b in boxes],
        "panels": [],
        "panelSkipped": "cloud-v1: panel runs client-side, banding fallback applies",
        "splitGen": SPLIT_GEN,
        "mask": mask,
        "texts": texts,
        "ms": {"body": round(body_ms, 1), "detect": round(det_ms, 1),
               "ocr": round(ocr_ms, 1), "total": round(total, 1)},
    }
