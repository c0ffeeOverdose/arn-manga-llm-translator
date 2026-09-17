# Pure box-splitting + OCR-crop expansion for the cloud server — ported
# 1:1 from src/content/detection.ts (splitMergedBoxes family) and
# src/content/render.ts (expandCropToInk). Standard library only, so
# unit tests import this without the server's third-party deps; app.py
# is the only runtime importer (Modal/Colab/Docker all colocate it).
import math


# ---- box splitting (ported 1:1 from src/content/detection.ts) ----
# The box head fuses stacked/kissing balloons into one box; the mask
# components are the evidence that splits them back apart. Same lanes, same
# constants, same decisions. Two JS-isms to preserve:
#   - Math.round rounds half UP on positives; Python round() is banker's, so
#     _r() is used everywhere the TS calls Math.round (inputs here are >= 0).
#   - medians are the UPPER middle (sorted[floor(n/2)]), same in _med().
# Boxes are dicts (x1/y1/x2/y2/conf, +clip/cutAxis on split children);
# comps are plain rect dicts (the SplitComp shape — no count/psum).
SPLIT_GEN = 4  # bump when this section's logic changes; /v1/page reports it
# and the client re-detects cache entries written by older servers.
# gen 2: OCR crops grow past edge-cut glyphs + /v1/page ships the packed CTD
# mask (gen 1 split without it — the client's box-filled stand-in mask forced
# white text on every leaked area).
# gen 3: pass-3 rescue — a merged comp killed only by the overlap gate is
# split and re-gated per piece (live /14: the merge chained the left はむ
# into a super-comp that box 5 swallowed whole).
# gen 4: lane-2 first-pair — a detached FIRST group of comparable size splits
# despite nesting (live /14 right group: 3-row hamu 34px above its EN block).
# Stragglers (small group under a big block, the dropped-line family) stay
# fused via the size ratio.
SPLIT_GAP_FACTOR = 2
SPLIT_GAP_RATIO = 0.8
SPLIT_PAD_CAP = 40
SPLIT2_FLOOR_RATIO = 0.5
SPLIT2_FLOOR_MIN = 8
SPLIT2_OVERLAP_MAX = 0.5
SPLIT2_STRONG_FACTOR = 2
SPLIT2_FIRST_GAP_MULT = 3
SPLIT2_FIRST_MIN_RATIO = 0.5
SPLIT_CLIP_SLACK = 12
SPLIT_CORE_LEASH = 16
TWIN_GUTTER_MIN = 4
TWIN_SIDE_MIN = 2
TWIN_SPAN_MIN = 48


def _r(x):
    return math.floor(x + 0.5)


def _med(xs):
    s = sorted(xs)
    return s[len(s) // 2]


def _bbox(rs):
    return {"x1": min(r["x1"] for r in rs), "y1": min(r["y1"] for r in rs),
            "x2": max(r["x2"] for r in rs), "y2": max(r["y2"] for r in rs)}


def split_merged_boxes(boxes, comps, same_block_gap, box_comps=None):
    if box_comps is None:
        box_comps = comps
    if len(comps) < 2:
        return list(boxes)

    def centered(c, b):
        return ((c["x1"] + c["x2"]) / 2 >= b["x1"]
                and (c["x1"] + c["x2"]) / 2 <= b["x2"]
                and (c["y1"] + c["y2"]) / 2 >= b["y1"]
                and (c["y1"] + c["y2"]) / 2 <= b["y2"])

    out = []
    for b in boxes:
        cs = [c for c in comps if centered(c, b)]
        bs = cs if box_comps is comps else [c for c in box_comps if centered(c, b)]
        parts = _split_box(b, cs, same_block_gap, bs)
        out.extend(parts if parts is not None else [b])
    return out


def _emit_split(box, groups, axis, loose, box_comps):
    lo = (lambda g: g["y1"]) if axis == "y" else (lambda g: g["x1"])
    hi = (lambda g: g["y2"]) if axis == "y" else (lambda g: g["x2"])

    def gap_before(i):
        if i <= 0 or i >= len(groups):
            return float("inf")
        return lo(groups[i]) - hi(groups[i - 1])

    cuts = []
    for i, g in enumerate(groups[1:]):
        gap = lo(g) - hi(groups[i])
        cuts.append({"at": (hi(groups[i]) + lo(g)) / 2,
                     "slack": min(SPLIT_CLIP_SLACK, max(4, math.floor(gap / 2)))})
    kids = []
    for i, g in enumerate(groups):
        def pad_to(gap):
            return min(SPLIT_PAD_CAP, math.floor(gap / 2)) \
                if gap > 0 and math.isfinite(gap) else 0

        pad_before = pad_to(gap_before(i))
        pad_after = pad_to(gap_before(i + 1))

        def in_group(c):
            return ((c["x1"] + c["x2"]) / 2 >= g["x1"]
                    and (c["x1"] + c["x2"]) / 2 <= g["x2"]
                    and (c["y1"] + c["y2"]) / 2 >= g["y1"]
                    and (c["y1"] + c["y2"]) / 2 <= g["y2"])

        own = [c for c in box_comps if in_group(c)]
        ext = dict(g)
        if own:
            core = _bbox(own)
            near = [c for c in loose if in_group(c)
                    and c["x1"] <= core["x2"] + SPLIT_CORE_LEASH
                    and c["x2"] >= core["x1"] - SPLIT_CORE_LEASH
                    and c["y1"] <= core["y2"] + SPLIT_CORE_LEASH
                    and c["y2"] >= core["y1"] - SPLIT_CORE_LEASH]
            if near:
                ext = _bbox(near)
        clip = {"x1": box["x1"], "y1": box["y1"], "x2": box["x2"], "y2": box["y2"]}
        before = cuts[i - 1] if i > 0 else None
        after = cuts[i] if i < len(groups) - 1 else None
        if axis == "y":
            if before:
                clip["y1"] = _r(before["at"] - before["slack"])
            if after:
                clip["y2"] = _r(after["at"] + after["slack"])
        else:
            if before:
                clip["x1"] = _r(before["at"] - before["slack"])
            if after:
                clip["x2"] = _r(after["at"] + after["slack"])
        if axis == "y":
            r = {"x1": max(box["x1"], ext["x1"]),
                 "y1": max(box["y1"], ext["y1"] - pad_before),
                 "x2": min(box["x2"], ext["x2"]),
                 "y2": min(box["y2"], ext["y2"] + pad_after)}
        else:
            r = {"x1": max(box["x1"], ext["x1"] - pad_before),
                 "y1": max(box["y1"], ext["y1"]),
                 "x2": min(box["x2"], ext["x2"] + pad_after),
                 "y2": min(box["y2"], ext["y2"])}
        if axis == "y":
            if before:
                r["y1"] = max(r["y1"], _r(before["at"]))
            if after:
                r["y2"] = min(r["y2"], _r(after["at"]))
        else:
            if before:
                r["x1"] = max(r["x1"], _r(before["at"]))
            if after:
                r["x2"] = min(r["x2"], _r(after["at"]))
        kid = dict(box)
        kid.update(r)
        kid["clip"] = clip
        kid["cutAxis"] = axis
        kids.append(kid)
    return kids


def _split_box(box, cs, same_block_gap, box_comps):
    if len(cs) < 2:
        return None
    return (_split_box_lane1(box, cs, same_block_gap, box_comps)
            or _split_box_lane2(box, cs, box_comps)
            or _split_twin_cut(box, cs, box_comps))


def _split_twin_cut(box, cs, box_comps):
    cl = [dict(c, x1=max(c["x1"], box["x1"]), x2=min(c["x2"], box["x2"])) for c in cs]
    edges = []
    for c in cl:
        if c["x2"] <= c["x1"]:
            continue
        edges.append((c["x1"], True))
        edges.append((c["x2"], False))
    # closes sort before opens at ties, so touching comps leave no avenue
    edges.sort(key=lambda e: (e[0], 1 if e[1] else 0))
    ivs = []
    depth, start = 0, box["x1"]
    for x, is_open in edges:
        if x < box["x1"] or x > box["x2"]:
            continue
        if is_open:
            if depth == 0 and x - start >= TWIN_GUTTER_MIN:
                ivs.append((start, x))
            depth += 1
        else:
            depth -= 1
            if depth == 0:
                start = x
    if depth == 0 and box["x2"] - start >= TWIN_GUTTER_MIN:
        ivs.append((start, box["x2"]))
    for a, b in ivs:
        mid = (a + b) / 2
        L = [c for c in cl if c["x2"] <= mid and c["x2"] - c["x1"] > c["y2"] - c["y1"]]
        R = [c for c in cl if c["x1"] >= mid and c["x2"] - c["x1"] > c["y2"] - c["y1"]]
        if len(L) < TWIN_SIDE_MIN or len(R) < TWIN_SIDE_MIN:
            continue
        span = (lambda ss: max(c["y2"] for c in ss) - min(c["y1"] for c in ss))
        if span(L) < TWIN_SPAN_MIN or span(R) < TWIN_SPAN_MIN:
            continue
        return _emit_split(box, [_bbox(L), _bbox(R)], "x", cs, box_comps)
    return None


def _split_box_lane1(box, cs, same_block_gap, box_comps):
    for axis in ("y", "x"):
        lo = (lambda c: c["y1"]) if axis == "y" else (lambda c: c["x1"])
        hi = (lambda c: c["y2"]) if axis == "y" else (lambda c: c["x2"])
        c_lo = (lambda c: c["x1"]) if axis == "y" else (lambda c: c["y1"])
        c_hi = (lambda c: c["x2"]) if axis == "y" else (lambda c: c["y2"])
        srt = sorted(cs, key=lo)
        thr = max(SPLIT_GAP_FACTOR * same_block_gap,
                  SPLIT_GAP_RATIO * _med([hi(c) - lo(c) for c in srt]))
        groups = []
        for c in srt:
            g = groups[-1] if groups else None
            gap = lo(c) - (g["y2"] if axis == "y" else g["x2"]) if g else 0
            if g and gap >= thr:
                groups.append(dict(c))
            elif g:
                g["x1"] = min(g["x1"], c["x1"])
                g["y1"] = min(g["y1"], c["y1"])
                g["x2"] = max(g["x2"], c["x2"])
                g["y2"] = max(g["y2"], c["y2"])
            else:
                groups.append(dict(c))
        if len(groups) < 2:
            continue
        while True:
            k = next((k for k in range(len(groups) - 1)
                      if min(c_hi(groups[k]), c_hi(groups[k + 1]))
                      > max(c_lo(groups[k]), c_lo(groups[k + 1]))), -1)
            if k < 0:
                break
            b = groups.pop(k + 1)
            groups[k] = {"x1": min(groups[k]["x1"], b["x1"]),
                         "y1": min(groups[k]["y1"], b["y1"]),
                         "x2": max(groups[k]["x2"], b["x2"]),
                         "y2": max(groups[k]["y2"], b["y2"])}
        if len(groups) < 2:
            continue
        return _emit_split(box, groups, axis, cs, box_comps)
    return None


def _split_box_lane2(box, cs, box_comps):
    if len(cs) < 2:
        return None
    unit = _med([min(c["x2"] - c["x1"], c["y2"] - c["y1"]) for c in cs])
    floor = max(SPLIT2_FLOOR_MIN, _r(SPLIT2_FLOOR_RATIO * unit))
    for axis in ("y", "x"):
        lo = (lambda g: g["y1"]) if axis == "y" else (lambda g: g["x1"])
        hi = (lambda g: g["y2"]) if axis == "y" else (lambda g: g["x2"])
        c_lo = (lambda g: g["x1"]) if axis == "y" else (lambda g: g["y1"])
        c_hi = (lambda g: g["x2"]) if axis == "y" else (lambda g: g["y2"])
        srt = sorted(cs, key=lo)
        groups = []
        for c in srt:
            g = groups[-1] if groups else None
            gap = lo(c) - hi(g) if g else 0
            if g and gap >= floor:
                groups.append(dict(c))
            elif g:
                g["x1"] = min(g["x1"], c["x1"])
                g["y1"] = min(g["y1"], c["y1"])
                g["x2"] = max(g["x2"], c["x2"])
                g["y2"] = max(g["y2"], c["y2"])
            else:
                groups.append(dict(c))
        if len(groups) < 2:
            continue
        merged = [groups[0]]
        for i in range(1, len(groups)):
            prev, g = merged[-1], groups[i]
            gap = lo(g) - hi(prev)
            ov = min(c_hi(prev), c_hi(g)) - max(c_lo(prev), c_lo(g))
            span = min(c_hi(prev) - c_lo(prev), c_hi(g) - c_lo(g))
            ratio = 0 if ov <= 0 else ov / span
            nested = ((c_lo(prev) >= c_lo(g) and c_hi(prev) <= c_hi(g))
                      or (c_lo(g) >= c_lo(prev) and c_hi(g) <= c_hi(prev)))
            first_pair = (axis == "y" and len(merged) == 1 and i == 1
                            and nested and gap >= SPLIT2_FIRST_GAP_MULT * floor
                            and hi(g) - lo(g) >= (hi(prev) - lo(prev)) * SPLIT2_FIRST_MIN_RATIO)
            if gap >= floor and (ratio < SPLIT2_OVERLAP_MAX
                                 or (gap >= SPLIT2_STRONG_FACTOR * floor and not nested)
                                 or first_pair):
                merged.append(g)
            else:
                prev["x1"] = min(prev["x1"], g["x1"])
                prev["y1"] = min(prev["y1"], g["y1"])
                prev["x2"] = max(prev["x2"], g["x2"])
                prev["y2"] = max(prev["y2"], g["y2"])
        if len(merged) >= 2:
            return _emit_split(box, merged, axis, cs, box_comps)
    return None

# ---- OCR-crop expansion (ported 1:1 from expandCropToInk in
# src/content/render.ts) ----
# A detection box can clip its own glyphs, so after padding any side whose
# edge still touches ink grows outward to the last ink plus a small margin,
# capped at half the box's smaller side. Split children stay inside their
# clip. Only the READ window grows: crops stay tight when nothing is cut.
# rgb is a full-page uint8 HxWx3 array; box holds the detection bounds (+clip
# on split children); rect is the padded crop {x,y,w,h}.
def _crop_expand_cap(box):
    return max(16, _r(min(box["x2"] - box["x1"], box["y2"] - box["y1"]) * 0.5))


def _interior_seed(rgb, box):
    H, W, _ = rgb.shape
    x1, y1 = max(0, math.floor(box["x1"])), max(0, math.floor(box["y1"]))
    x2, y2 = min(W - 1, math.ceil(box["x2"])), min(H - 1, math.ceil(box["y2"]))
    step_x = max(1, (x2 - x1) // 24)
    step_y = max(1, (y2 - y1) // 24)
    buckets = {}
    best = None
    for y in range(y1, y2 + 1, step_y):
        for x in range(x1, x2 + 1, step_x):
            r, g, b = (int(v) for v in rgb[y, x])
            key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
            bkt = buckets.get(key)
            if bkt is None:
                bkt = [0, 0, 0, 0]
                buckets[key] = bkt
            bkt[0] += 1
            bkt[1] += r
            bkt[2] += g
            bkt[3] += b
            if best is None or bkt[0] > best[0]:
                best = bkt
    if best is None:
        cx = max(0, min(W - 1, math.floor((box["x1"] + box["x2"]) / 2)))
        cy = max(0, min(H - 1, math.floor((box["y1"] + box["y2"]) / 2)))
        return [float(v) for v in rgb[cy, cx]]
    return [best[1] / best[0], best[2] / best[0], best[3] / best[0]]


def expand_crop_to_ink(rgb, box, rect):
    H, W, _ = rgb.shape
    seed = _interior_seed(rgb, box)
    seed_lum = 0.299 * seed[0] + 0.587 * seed[1] + 0.114 * seed[2]
    cap = _crop_expand_cap(box)
    clip = box.get("clip")
    x1 = max(0, math.floor(rect["x"]))
    y1 = max(0, math.floor(rect["y"]))
    x2 = min(W - 1, math.ceil(rect["x"] + rect["w"]))
    y2 = min(H - 1, math.ceil(rect["y"] + rect["h"]))

    def ink_at(x, y):
        if x < 0 or y < 0 or x >= W or y >= H:
            return False
        r, g, b = (float(v) for v in rgb[y, x])
        return abs(0.299 * r + 0.587 * g + 0.114 * b - seed_lum) >= 90

    def edge_ink(vertical, at, lo, hi):
        return [q for q in range(lo, hi + 1) if (ink_at(at, q) if vertical else ink_at(q, at))]

    def connected_mass(vertical, pts, at):
        lo_x, hi_x = max(0, x1 - cap), min(W - 1, x2 + cap)
        lo_y, hi_y = max(0, y1 - cap), min(H - 1, y2 + cap)
        ix1, iy1 = math.ceil(box["x1"]) + 2, math.ceil(box["y1"]) + 2
        ix2, iy2 = math.floor(box["x2"]) - 2, math.floor(box["y2"]) - 2
        seen = bytearray(W * H)
        dist = {}
        queue = []
        for q in pts:
            x, y = (at, q) if vertical else (q, at)
            if x < lo_x or x > hi_x or y < lo_y or y > hi_y or seen[y * W + x]:
                continue
            seen[y * W + x] = 1
            dist[x + y * W] = 0
            queue.append(x + y * W)
        reached = False
        bx1, by1, bx2, by2 = W, H, -1, -1
        head = 0
        while head < len(queue):
            p = queue[head]
            head += 1
            x, y = p % W, p // W
            if not ink_at(x, y):
                continue
            d = dist[p]
            bx1, by1 = min(bx1, x), min(by1, y)
            bx2, by2 = max(bx2, x), max(by2, y)
            if ix1 <= x <= ix2 and iy1 <= y <= iy2:
                reached = True
            if d + 1 > cap:
                continue
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if nx < lo_x or nx > hi_x or ny < lo_y or ny > hi_y:
                    continue
                np_ = nx + ny * W
                if not seen[np_]:
                    seen[np_] = 1
                    dist[np_] = d + 1
                    queue.append(np_)
        if reached and bx2 >= bx1:
            return {"x1": bx1, "y1": by1, "x2": bx2, "y2": by2}
        return None

    bounds = {"x1": x1, "y1": y1, "x2": x2, "y2": y2}

    def grow(side):
        vertical = side in ("l", "r")
        d = -1 if side in ("l", "t") else 1
        edge = bounds["x1"] if side == "l" else bounds["x2"] if side == "r" \
            else bounds["y1"] if side == "t" else bounds["y2"]
        lo, hi = (bounds["y1"], bounds["y2"]) if vertical else (bounds["x1"], bounds["x2"])
        if side == "l":
            bound = max(0, math.ceil(box["x1"]) - cap, math.ceil(clip["x1"]) if clip else 0)
        elif side == "r":
            bound = min(W - 1, math.floor(box["x2"]) + cap, math.floor(clip["x2"]) if clip else W - 1)
        elif side == "t":
            bound = max(0, math.ceil(box["y1"]) - cap, math.ceil(clip["y1"]) if clip else 0)
        else:
            bound = min(H - 1, math.floor(box["y2"]) + cap, math.floor(clip["y2"]) if clip else H - 1)
        touch = edge_ink(vertical, edge, lo, hi)
        if not touch or len(touch) >= (hi - lo + 1) * 0.6:
            return
        mass = connected_mass(vertical, touch, edge)
        if not mass:
            return
        grown = mass["x1"] - 4 if side == "l" else mass["x2"] + 4 if side == "r" \
            else mass["y1"] - 4 if side == "t" else mass["y2"] + 4
        limited = max(grown, edge - cap) if d < 0 else min(grown, edge + cap)
        if side == "l":
            bounds["x1"] = min(edge, max(limited, bound))
        elif side == "r":
            bounds["x2"] = max(edge, min(limited, bound))
        elif side == "t":
            bounds["y1"] = min(edge, max(limited, bound))
        else:
            bounds["y2"] = max(edge, min(limited, bound))

    for side in ("l", "r", "t", "b"):
        grow(side)
    return {"x": bounds["x1"], "y": bounds["y1"],
            "w": bounds["x2"] - bounds["x1"], "h": bounds["y2"] - bounds["y1"]}


# ---- mask packing (mirrors packMask in src/content/page-cache.ts) ----
# Block-max downscale of the binary text mask to <=256 on the long side;
# the client restores it with unpackMask. /v1/page ships this so cloud
# entries carry a REAL mask (text-color sampling, inpaint and the debug view
# all read it) instead of the client's old box-filled stand-in, which
# excluded every whole box from sampling and forced white text. Standard
# library only: flat is any row-major byte sequence (bytes, bytearray, or a
# ravelled numpy array).
def pack_mask(w, h, flat, max_side=256):
    step = max(1, max(w, h) // max_side)
    ow, oh = (w + step - 1) // step, (h + step - 1) // step
    out = bytearray(ow * oh)
    for y in range(oh):
        y0, y1 = y * step, min(y * step + step, h)
        for x in range(ow):
            x0, x1 = x * step, min(x * step + step, w)
            v = 0
            for yy in range(y0, y1):
                base = yy * w
                for xx in range(x0, x1):
                    if flat[base + xx] > v:
                        v = flat[base + xx]
                        if v > 127:
                            break
                if v > 127:
                    break
            out[y * ow + x] = 255 if v > 127 else 0
    return ow, oh, bytes(out)


# ---- pass-3 rescue (mirrors rescueSplitComp in src/content/detection.ts) ----
# A merged comp killed ONLY by the overlap gate may still hold a text group
# outside every kept box: split it with the lane machinery on the raw texty
# comps and re-gate each piece. count_in recounts the parent comp's labels
# inside a piece bbox; overlaps_box and box_conf are the caller's gates.
def rescue_split_comp(c, texty, strict, same_block_gap, page_area,
                      count_in, overlaps_box, box_conf):
    pieces = split_merged_boxes(
        [dict(c, conf=0.5)], texty, same_block_gap, strict)
    if len(pieces) < 2:
        return []
    out = []
    for pc in pieces:
        bw, bh = pc["x2"] - pc["x1"], pc["y2"] - pc["y1"]
        if bw < 14 or bh < 14 or bw * bh > 0.2 * page_area:
            continue
        count, psum = count_in(math.floor(pc["x1"]), math.floor(pc["y1"]),
                               math.ceil(pc["x2"]), math.ceil(pc["y2"]))
        if count / (bw * bh) < 0.02:
            continue
        m = {"x1": pc["x1"], "y1": pc["y1"], "x2": pc["x2"], "y2": pc["y2"]}
        if overlaps_box(m):
            continue
        if psum / count < 0.75 and box_conf(m) < 0.20:
            continue
        out.append({"x1": pc["x1"], "y1": pc["y1"], "x2": pc["x2"],
                    "y2": pc["y2"], "conf": 0.5})
    return out
