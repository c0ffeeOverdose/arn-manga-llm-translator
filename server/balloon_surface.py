import math

import cv2
import numpy as np


def _contains(surface, box):
    if box["y1"] < surface["y1"] or box["y2"] > surface["y2"]:
        return False
    start = math.floor(box["y1"]) - surface["y1"]
    end = math.ceil(box["y2"]) - surface["y1"]
    return start >= 0 and end <= len(surface["left"]) and bool(
        np.all(surface["left"][start:end] <= box["x1"])
        and np.all(surface["right"][start:end] >= box["x2"]))


def _internal_divider(rgb, surface, box, mask):
    y1, y2 = surface["y1"], surface["y2"]
    for x in range(surface["x1"], surface["x2"]):
        if box["x1"] <= x < box["x2"]:
            continue
        inside = (surface["left"] <= x) & (surface["right"] > x)
        contrast = np.abs(rgb[y1:y2, x].astype(np.int16) - surface["seed"]).sum(axis=1) >= 60
        if np.count_nonzero(inside & contrast & ~mask[y1:y2, x]) >= (y2 - y1) * 0.4:
            return True
    return False


def balloon_surface(rgb, box, mask, cache, search=None):
    """Mirror the browser's bounded physical background component, independent of split clips."""
    h, w = rgb.shape[:2]
    if box["x2"] <= box["x1"] or box["y2"] <= box["y1"]:
        return None
    for surface in cache:
        if _contains(surface, box) and not _internal_divider(rgb, surface, box, mask):
            return surface
    search = search or box
    bw, bh = search["x2"] - search["x1"], search["y2"] - search["y1"]
    gx, gy = max(24, bw * 1.2, bh * 0.7), max(24, bh * 0.6, bw * 0.7)
    lx, hx = max(0, math.floor(search["x1"] - gx)), min(w - 1, math.ceil(search["x2"] + gx))
    ly, hy = max(0, math.floor(search["y1"] - gy)), min(h - 1, math.ceil(search["y2"] + gy))
    rw, rh = hx - lx + 1, hy - ly + 1
    if rw <= 0 or rh <= 0 or rw * rh > 1_500_000:
        return None
    cx, cy = math.floor((box["x1"] + box["x2"]) / 2), math.floor((box["y1"] + box["y2"]) / 2)
    probes = [(math.floor(box["x1"]) - 3, cy), (math.ceil(box["x2"]) + 3, cy),
              (cx, math.floor(box["y1"]) - 3), (cx, math.ceil(box["y2"]) + 3),
              (math.floor(box["x1"]), math.floor(box["y1"])),
              (math.ceil(box["x2"]), math.ceil(box["y2"])), (cx, cy)]
    tones = set()
    roi = rgb[ly:hy + 1, lx:hx + 1].astype(np.int16)
    for sx, sy in probes:
        if sx <= lx or sx >= hx or sy <= ly or sy >= hy or mask[sy, sx]:
            continue
        seed = rgb[sy, sx].astype(np.int16)
        key = tuple(int(c) >> 4 for c in seed)
        if key in tones:
            continue
        tones.add(key)
        background = (np.abs(roi - seed).sum(axis=2) < 60).astype(np.uint8)
        _, labels = cv2.connectedComponents(background, connectivity=4)
        label = labels[sy - ly, sx - lx]
        region = labels == label
        if region[0].any() or region[-1].any() or region[:, 0].any() or region[:, -1].any():
            continue
        yy, xx = np.nonzero(region)
        if len(xx) < max(64, (box["x2"] - box["x1"]) * (box["y2"] - box["y1"]) * 0.25):
            continue
        min_x, max_x, min_y, max_y = int(xx.min()), int(xx.max()), int(yy.min()), int(yy.max())
        left = np.full(rh, w, dtype=np.int32)
        right = np.full(rh, -1, dtype=np.int32)
        np.minimum.at(left, yy, xx + lx)
        np.maximum.at(right, yy, xx + lx + 1)
        surface = {"x1": lx + min_x, "y1": ly + min_y, "x2": lx + max_x + 1, "y2": ly + max_y + 1,
                   "left": left[min_y:max_y + 1], "right": right[min_y:max_y + 1], "seed": seed, "count": len(xx)}
        if not _contains(surface, box) or _internal_divider(rgb, surface, box, mask):
            continue

        def outlined(x, y, direction):
            n = 0
            light = float(np.dot(seed, [0.299, 0.587, 0.114])) >= 128
            for k in range(16):
                if x < 0 or x >= w:
                    return False
                lum = float(np.dot(rgb[y, x], [0.299, 0.587, 0.114]))
                if np.abs(rgb[y, x].astype(np.int16) - seed).sum() >= 60 and (lum < 100 if light else lum > 155):
                    n += 1
                elif n > 0 or k >= 2:
                    return n > 0
                x += direction
            return False

        rows, enclosed = 0, 0
        for y in range(math.floor(box["y1"]), math.ceil(box["y2"])):
            k = y - surface["y1"]
            if surface["right"][k] <= surface["left"][k]:
                continue
            rows += 1
            if outlined(int(surface["left"][k]) - 1, y, -1) and outlined(int(surface["right"][k]), y, 1):
                enclosed += 1
        if not rows or enclosed < rows * 0.5:
            continue
        if len(cache) < 64:
            cache.append(surface)
        return surface
    return None


def _text_comp_linked(a, b):
    """Shared neighbourhood predicate (cluster grammar + lettering extraction). Mirrors TS."""
    unit = min(a["y2"] - a["y1"], b["y2"] - b["y1"])
    x_gap = max(a["x1"] - b["x2"], b["x1"] - a["x2"], 0)
    y_gap = max(a["y1"] - b["y2"], b["y1"] - a["y2"], 0)
    x_overlap = min(a["x2"], b["x2"]) - max(a["x1"], b["x1"])
    same_row = abs((a["y1"] + a["y2"]) - (b["y1"] + b["y2"])) <= 1.2 * unit and x_gap <= 0.9 * unit
    stacked = x_gap == 0 and x_overlap >= 0.5 * min(a["x2"] - a["x1"], b["x2"] - b["x1"]) and y_gap <= 0.6 * unit
    return same_row or stacked


def _cluster_text_components(comps):
    """Words on one row and lines stacked with real cross overlap join; a corridor between
    side-by-side blocks (a lobe neck) never does. Mirrors clusterTextComponents() in TS."""
    parent = list(range(len(comps)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(comps)):
        for j in range(i + 1, len(comps)):
            if _text_comp_linked(comps[i], comps[j]):
                parent[find(j)] = find(i)
    groups = {}
    for i, comp in enumerate(comps):
        groups.setdefault(find(i), []).append(comp)
    return list(groups.values())


def _attach_orphans(clusters, median_h):
    """A stray fragment or short dot run must not veto a split or become its own region:
    blocks that cannot stand alone attach to the nearest full block when close;
    display-lettering scale components stand alone. Mirrors attachOrphans() in TS."""
    def height(cs):
        return max(c["y2"] for c in cs) - min(c["y1"] for c in cs)

    out = [cs for cs in clusters if len(cs) > 1 and height(cs) >= 1.8 * median_h]
    for cs in clusters:
        if any(cs is t for t in out):
            continue
        if len(cs) == 1 and cs[0]["y2"] - cs[0]["y1"] >= 2.5 * median_h:
            out.append(cs)
            continue
        # Dust (a sliver far below glyph scale) attaches from farther out: a 4px speck
        # floating between blocks must not veto the split.
        dusty = any(c["y2"] - c["y1"] <= 0.5 * median_h for c in cs)
        bound = (3 if dusty else 1.2) * median_h
        best, best_d = None, math.inf
        for target in out:
            d = math.inf
            for c in cs:
                for o in target:
                    dx = max(0, max(c["x1"] - o["x2"], o["x1"] - c["x2"]))
                    dy = max(0, max(c["y1"] - o["y2"], o["y1"] - c["y2"]))
                    d = min(d, math.hypot(dx, dy))
            if d < best_d:
                best_d, best = d, target
        if best is not None and best_d <= bound:
            best.extend(cs)
        else:
            out.append(cs)
    return out


def split_connected_clusters(comps, parent, w, h, accept=None):
    """Connected multi-lobe balloon: several text blocks share one interior. Cut the box at
    the block seams with frame-clamped children (clip without cutAxis clamps every side), so
    a shared surface can never leak a sibling glyph into this child. None = not splittable.
    Mirrors splitConnectedClusters() in TS."""
    if len(comps) < 2:
        return None
    heights = sorted(c["y2"] - c["y1"] for c in comps)
    median_h = heights[len(heights) // 2]
    clusters = _attach_orphans(_cluster_text_components(comps), median_h)

    # Display lettering (SFX scale) glued to a dialogue block is its own region: the big
    # components split out whenever the rest still holds a real block, taking ornament
    # components that hang off the lettering alone. Mirrors TS.
    split = []
    for cs in clusters:
        big = [c for c in cs if c["y2"] - c["y1"] >= 2.5 * median_h]
        if not big or len(cs) - len(big) < 2:
            split.append(cs)
            continue
        rest = [c for c in cs if not any(c is b for b in big)]

        def near_big(c):
            def d(b):
                dx = max(0, max(c["x1"] - b["x2"], b["x1"] - c["x2"]))
                dy = max(0, max(c["y1"] - b["y2"], b["y1"] - c["y2"]))
                return math.hypot(dx, dy)
            return any(d(b) <= 0.5 * median_h for b in big)

        stray = [c for c in rest
                 if all(o is c or not _text_comp_linked(o, c) for o in rest)
                 and (any(_text_comp_linked(b, c) for b in big) or near_big(c))]
        for c in stray:
            big.append(c)
            rest.remove(c)
        split.append(big)
        split.append(rest)
    if len(split) < 2 or len(split) > 8 or any(not cs for cs in split):
        return None
    if accept is not None and not accept(split):
        return None
    boxes = [{"x1": min(c["x1"] for c in cs), "y1": min(c["y1"] for c in cs),
              "x2": max(c["x2"] for c in cs), "y2": max(c["y2"] for c in cs), "conf": parent["conf"]} for cs in split]

    # A lone component never becomes its own region — unless it is OVERSIZED display lettering
    # (SFX scale, several times the block's glyphs): keeping it in the box would erase it with
    # the neighbours' cleanup, so it splits off as its own (keep-path) region. Mirrors TS.
    def _oversized(cs):
        return len(cs) == 1 and cs[0]["y2"] - cs[0]["y1"] >= 2.5 * median_h

    if any((not _oversized(cs)) if len(cs) < 2 else (b["y2"] - b["y1"] < 1.8 * median_h)
           for cs, b in zip(split, boxes)):
        return None
    # A mid-column seam is not a block boundary: two substantial blocks that share almost the
    # same x-range and sit about a line apart are rows of one column of text. Lettering pieces
    # exempt themselves by size, real block stacks by their gap.
    for i in range(len(split)):
        for j in range(i + 1, len(split)):
            if len(split[i]) < 3 or len(split[j]) < 3:
                continue
            overlap = min(boxes[i]["x2"], boxes[j]["x2"]) - max(boxes[i]["x1"], boxes[j]["x1"])
            gap = max(boxes[i]["y1"] - boxes[j]["y2"], boxes[j]["y1"] - boxes[i]["y2"], 0)
            if (overlap > 0.6 * min(boxes[i]["x2"] - boxes[i]["x1"], boxes[j]["x2"] - boxes[j]["x1"])
                    and gap <= 1.2 * median_h):
                return None

    def soft(clearance):
        return 14 if clearance == math.inf else max(0, min(14, int((clearance - 2) // 2)))

    def frame_for(i):
        b = boxes[i]
        others = [c for j, cs in enumerate(split) if j != i for c in cs]
        band_y = [o for o in others if o["y1"] < b["y2"] and o["y2"] > b["y1"]]
        band_x = [o for o in others if o["x1"] < b["x2"] and o["x2"] > b["x1"]]
        left = b["x1"] - max(o["x2"] for o in band_y) if band_y else math.inf
        right = min(o["x1"] for o in band_y) - b["x2"] if band_y else math.inf
        top = b["y1"] - max(o["y2"] for o in band_x) if band_x else math.inf
        bottom = min(o["y1"] for o in band_x) - b["y2"] if band_x else math.inf
        return {"x1": max(0, b["x1"] - soft(left)), "y1": max(0, b["y1"] - soft(top)),
                "x2": min(w, b["x2"] + soft(right)), "y2": min(h, b["y2"] + soft(bottom))}

    # Frames are repaired, not vetoed: a sibling component that intrudes into a child's
    # erase reach shrinks that side of the frame (never below its own ink, 1px leash for
    # exclusive edges and float worker clips) instead of aborting the whole split. As a
    # last resort a sliver budget lets interlocking blocks still split. Mirrors TS.
    def within_coverage(f, b):
        return math.ceil(f["x1"]) <= b["x1"] + 1 and math.ceil(f["y1"]) <= b["y1"] + 1 \
            and math.ceil(f["x2"]) >= b["x2"] - 1 and math.ceil(f["y2"]) >= b["y2"] - 1

    def intrudes(f, c, slack):
        ix1, ix2 = max(c["x1"], f["x1"]), min(c["x2"] - 1, f["x2"] - 1)
        iy1, iy2 = max(c["y1"], f["y1"]), min(c["y2"] - 1, f["y2"] - 1)
        if ix2 < ix1 or iy2 < iy1:
            return False
        return (ix2 - ix1 + 1) * (iy2 - iy1 + 1) > slack

    SLIVER_REACH = 384  # px² of interlock the sliver fallback tolerates

    def repair_frames(start, slack):
        frames = [dict(f) for f in start]
        if parent.get("clip"):
            clip = parent["clip"]
            frames = [{"x1": max(f["x1"], clip["x1"]), "y1": max(f["y1"], clip["y1"]),
                       "x2": min(f["x2"], clip["x2"]), "y2": min(f["y2"], clip["y2"])} for f in frames]
        if any(not within_coverage(f, b) for f, b in zip(frames, boxes)):
            return None
        for _guard in range(128):
            moved = False
            for i, _b in enumerate(frames):
                b = boxes[i]
                for j, cs in enumerate(split):
                    if j == i:
                        continue
                    for c in cs:
                        f = frames[i]
                        if not intrudes(f, c, slack):
                            continue
                        ix1, ix2 = max(c["x1"], f["x1"]), min(c["x2"] - 1, f["x2"] - 1)
                        iy1, iy2 = max(c["y1"], f["y1"]), min(c["y2"] - 1, f["y2"] - 1)
                        options = (("x1", ix2 + 1), ("x2", ix1), ("y1", iy2 + 1), ("y2", iy1))
                        best_f, best_d = None, math.inf
                        for k, v in options:
                            if v == f[k]:
                                continue
                            nf = dict(f, **{k: v})
                            if nf["x1"] >= nf["x2"] or nf["y1"] >= nf["y2"] or not within_coverage(nf, b):
                                continue
                            d = abs(v - f[k])
                            if d < best_d:
                                best_d, best_f = d, nf
                        if best_f is None:
                            return None
                        frames[i] = best_f
                        moved = True
                        break
                    if moved:
                        break
                if moved:
                    break
            if not moved:
                return frames
        return None

    soft_frames = []
    for i, b in enumerate(boxes):
        f = frame_for(i)
        soft_frames.append(f if f is not None else {"x1": b["x1"], "y1": b["y1"], "x2": b["x2"], "y2": b["y2"]})
    bare_frames = [{"x1": b["x1"], "y1": b["y1"], "x2": b["x2"], "y2": b["y2"]} for b in boxes]
    frames = repair_frames(soft_frames, 0)
    if frames is None:
        frames = repair_frames(bare_frames, 0)
    if frames is None:
        frames = repair_frames(soft_frames, SLIVER_REACH)
    if frames is None:
        frames = repair_frames(bare_frames, SLIVER_REACH)
    if frames is None:
        return None
    return [dict(b, clip=frames[i]) for i, b in enumerate(boxes)]


def split_cut_family(rgb, mask, boxes, family, cache):
    """A detector cut's children (shared sib) are re-decided from their union: the cut's seam
    evidence may not survive the physical-surface measurement (one lobe's sentence can sit on
    both sides of the cut). One measured enclosure that yields >=2 text blocks is the only
    green light; every other outcome keeps the cut's children. Mirrors splitCutFamily() in TS.
    """
    members = [boxes[i] for i in family]
    if any("clip" not in b for b in members):
        return None
    union = {"x1": min(b["x1"] for b in members), "y1": min(b["y1"] for b in members),
             "x2": max(b["x2"] for b in members), "y2": max(b["y2"] for b in members),
             "conf": min(b["conf"] for b in members),
             # the members' clips share the cut's slack, so their union still owns the seam strip
             "clip": {"x1": min(b["clip"]["x1"] for b in members), "y1": min(b["clip"]["y1"] for b in members),
                      "x2": max(b["clip"]["x2"] for b in members), "y2": max(b["clip"]["y2"] for b in members)}}
    h, w = rgb.shape[:2]
    x0, y0 = max(0, math.floor(union["x1"])), max(0, math.floor(union["y1"]))
    x2, y2 = min(w, math.ceil(union["x2"])), min(h, math.ceil(union["y2"]))
    if x2 <= x0 or y2 <= y0:
        return None
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask[y0:y2, x0:x2].astype(np.uint8), connectivity=4)
    comps = []
    for lab in range(1, n):
        x, y, cw, ch, count = (int(v) for v in stats[lab])
        if count >= 4:
            comps.append({"x1": x + x0, "y1": y + y0, "x2": x + x0 + cw, "y2": y + y0 + ch, "conf": union["conf"]})
    if len(comps) < 2 or len(comps) > 400:
        return None
    surface = balloon_surface(rgb, comps[0], mask, cache, union)
    if surface is None:
        return None
    for comp in comps[1:]:
        if balloon_surface(rgb, comp, mask, cache, union) is not surface:
            return None
    # A member carrying a full multi-line block (>= 6 components) is a settled block: the
    # cut's seam is real for it, and no union cluster may merge two such members — that is
    # how two touching balloons separated by a gutter come back fused. Fragment-like members
    # (an outlier line or two) may still join another member's block.
    def member_comp_count(member):
        x0, y0 = max(0, math.floor(member["x1"])), max(0, math.floor(member["y1"]))
        x2, y2 = min(w, math.ceil(member["x2"])), min(h, math.ceil(member["y2"]))
        if x2 <= x0 or y2 <= y0:
            return 0
        n, _, stats, _ = cv2.connectedComponentsWithStats(mask[y0:y2, x0:x2].astype(np.uint8), connectivity=4)
        return sum(1 for lab in range(1, n) if int(stats[lab][4]) >= 4)

    major = [member_comp_count(member) >= 6 for member in members]
    owner_of = {}
    for c in comps:
        cx, cy = (c["x1"] + c["x2"]) / 2, (c["y1"] + c["y2"]) / 2
        for k, member in enumerate(members):
            if member["x1"] <= cx <= member["x2"] and member["y1"] <= cy <= member["y2"]:
                owner_of[id(c)] = k
                break

    def accept(clusters):
        for cs in clusters:
            involved = {owner_of[id(c)] for c in cs if id(c) in owner_of and major[owner_of[id(c)]]}
            if len(involved) > 1:
                return False
        return True

    return split_connected_clusters(comps, union, w, h, accept)


def refine_balloon_boxes(rgb, boxes, mask):
    """Preserve uncertain proposals; physical surfaces split boxes and corroborate line groups before OCR."""
    h, w = rgb.shape[:2]
    if mask.shape != (h, w) or not mask.any():
        return boxes
    mask = mask.astype(bool)
    cache, split = [], []
    # Children of one detector cut (shared sib) are grouped first and decided as a unit
    # (mirror of the client's family pass in splitBalloonSurfaces).
    families = {}
    for i, b in enumerate(boxes):
        if b.get("sib") is not None:
            families.setdefault(b["sib"], []).append(i)
    decided, dropped = {}, set()
    for family in families.values():
        if len(family) < 2:
            continue
        pieces = split_cut_family(rgb, mask, boxes, family, cache)
        if pieces is None:
            continue
        decided[family[0]] = pieces
        dropped.update(family[1:])
    for i, box in enumerate(boxes):
        if i in dropped:
            continue
        if i in decided:
            split.extend(decided[i])
            continue
        x0, y0 = max(0, math.floor(box["x1"])), max(0, math.floor(box["y1"]))
        x2, y2 = min(w, math.ceil(box["x2"])), min(h, math.ceil(box["y2"]))
        if x2 <= x0 or y2 <= y0:
            split.append(box)
            continue
        n, _, stats, _ = cv2.connectedComponentsWithStats(mask[y0:y2, x0:x2].astype(np.uint8), connectivity=4)
        comps = []
        for lab in range(1, n):
            x, y, cw, ch, count = (int(v) for v in stats[lab])
            if count >= 4:
                comps.append({"x1": x + x0, "y1": y + y0, "x2": x + x0 + cw, "y2": y + y0 + ch, "conf": box["conf"]})
        if len(comps) < 2 or len(comps) > 400:
            split.append(box)
            continue
        groups, unresolved = {}, False
        for comp in comps:
            surface = balloon_surface(rgb, comp, mask, cache, box)
            if surface is None:
                unresolved = True
                continue
            groups.setdefault(id(surface), (surface, []))[1].append(comp)
        if len(groups) >= 2 and not unresolved:
            pieces = []
            for surface, cs in groups.values():
                x1, y1 = min(c["x1"] for c in cs), min(c["y1"] for c in cs)
                x2, y2 = max(c["x2"] for c in cs), max(c["y2"] for c in cs)
                if x2 - x1 < 8 or y2 - y1 < 8:
                    pieces = None
                    break
                pad = max(2, min(6, min(x2 - x1, y2 - y1) * 0.15))
                bounds = box.get("clip", {"x1": 0, "y1": 0, "x2": w, "y2": h})
                clip = {"x1": max(surface["x1"], bounds["x1"]), "y1": max(surface["y1"], bounds["y1"]),
                        "x2": min(surface["x2"], bounds["x2"]), "y2": min(surface["y2"], bounds["y2"])}
                if x1 < clip["x1"] or y1 < clip["y1"] or x2 > clip["x2"] or y2 > clip["y2"]:
                    pieces = None
                    break
                pieces.append({"x1": max(box["x1"], clip["x1"], x1 - pad), "y1": max(box["y1"], clip["y1"], y1 - pad),
                               "x2": min(box["x2"], clip["x2"], x2 + pad), "y2": min(box["y2"], clip["y2"], y2 + pad),
                               "conf": box["conf"], "clip": clip})
            if pieces is not None:
                split.extend(pieces)
                continue
        # A shared interior, or ink the surface measurement could not resolve (fragments near
        # a lobe edge): frame-clamped seam splitting needs no per-component surface.
        pieces = split_connected_clusters(comps, box, w, h)
        split.extend(pieces if pieces is not None else [box])
    parent = list(range(len(split)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, a in enumerate(split):
        for j in range(i + 1, len(split)):
            b = split[j]
            ah, bh = a["y2"] - a["y1"], b["y2"] - b["y1"]
            if a.get("clip") or b.get("clip"):
                continue  # frame-owned children never re-merge
            if a["x2"] - a["x1"] < 1.5 * ah or b["x2"] - b["x1"] < 1.5 * bh or max(ah, bh) > 1.5 * min(ah, bh):
                continue
            gap = max(a["y1"], b["y1"]) - min(a["y2"], b["y2"])
            span = min(a["x2"], b["x2"]) - max(a["x1"], b["x1"])
            if gap < 0 or gap > 0.6 * min(ah, bh) or span < 0.8 * min(a["x2"] - a["x1"], b["x2"] - b["x1"]):
                continue
            parent[find(j)] = find(i)
    groups = {}
    for i in range(len(split)):
        groups.setdefault(find(i), []).append(i)
    replacements, removed = {}, set()
    for indices in groups.values():
        if len(indices) < 2:
            continue
        rows = sorted((split[i] for i in indices), key=lambda b: b["y1"])
        if any(np.count_nonzero(mask[max(0, math.floor(b["y1"])):min(h, math.ceil(b["y2"])),
                                     max(0, math.floor(b["x1"])):min(w, math.ceil(b["x2"]))]) < 4 for b in rows):
            continue
        pitches = [(b["y1"] + b["y2"] - a["y1"] - a["y2"]) / 2 for a, b in zip(rows, rows[1:])]
        if max(pitches) > 1.2 * min(pitches):
            continue
        union = {"x1": min(b["x1"] for b in rows), "y1": min(b["y1"] for b in rows),
                 "x2": max(b["x2"] for b in rows), "y2": max(b["y2"] for b in rows), "conf": min(b["conf"] for b in rows)}
        if balloon_surface(rgb, union, mask, cache) is None:
            continue
        replacements[indices[0]] = union
        removed.update(indices[1:])
    return [replacements.get(i, b) for i, b in enumerate(split) if i not in removed]
