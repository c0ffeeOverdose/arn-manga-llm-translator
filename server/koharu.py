import hashlib
import math

import numpy as np

from models_manifest import KOHARU_BYTES, KOHARU_SHA256

INPUT_SIZE = 1152
THRESHOLDS = {"text": 0.25, "sfx": 0.20, "bubble": 0.50, "panel": 0.50}


def validate_model(path):
    with open(path, "rb") as source:
        if source.seek(0, 2) != KOHARU_BYTES:
            raise RuntimeError("KoharuLayout model size mismatch; download the supported FP32 model")
        source.seek(0)
        if hashlib.file_digest(source, "sha256").hexdigest() != KOHARU_SHA256:
            raise RuntimeError("KoharuLayout model checksum mismatch; download the supported FP32 model")
    return path


def _samples(source, target):
    scale = np.float32(source / target)
    support = max(1.0, float(scale))
    inverse = np.float32(1 / support)
    result = []
    for i in range(target):
        center = np.float32((i + 0.5) * float(scale))
        start = max(0, math.floor(float(np.float32(center - support)) + 0.5))
        end = min(source, math.floor(float(np.float32(center + support)) + 0.5))
        weights, total = [], np.float32(0)
        for j in range(start, end):
            distance = np.float32((float(np.float32(j - float(center))) + 0.5) * float(inverse))
            weight = np.float32(max(0, float(np.float32(1 - abs(distance)))))
            weights.append(weight)
            total = np.float32(total + weight)
        result.append((start, np.asarray(weights, np.float32) / total))
    return result


def image_input(pil, size=INPUT_SIZE):
    """Mirror the worker's FP32 antialiased RGB resize and ImageNet NCHW normalization."""
    w, h = pil.size
    if w < 1 or h < 1 or size < 1:
        raise ValueError("Invalid Koharu image dimensions")
    rgb = np.asarray(pil.convert("RGB"), np.float32) / np.float32(255)
    horizontal = np.zeros((h, size, 3), np.float32)
    for x, (start, weights) in enumerate(_samples(w, size)):
        for j, weight in enumerate(weights):
            horizontal[:, x] += rgb[:, start + j] * weight
    resized = np.zeros((size, size, 3), np.float32)
    for y, (start, weights) in enumerate(_samples(h, size)):
        for j, weight in enumerate(weights):
            resized[y] += horizontal[start + j] * weight
    resized -= np.asarray([0.485, 0.456, 0.406], np.float32)
    resized /= np.asarray([0.229, 0.224, 0.225], np.float32)
    return np.ascontiguousarray(resized.transpose(2, 0, 1)[None])


def _instance_mask(logits, w, h, x0=0, y0=0, x2=None, y2=None):
    x2, y2 = w if x2 is None else x2, h if y2 is None else y2
    xs = (np.arange(x0, x2, dtype=np.float64) + 0.5) * 288 / w - 0.5
    ys = (np.arange(y0, y2, dtype=np.float64) + 0.5) * 288 / h - 0.5
    xl, yl = np.floor(xs).astype(int), np.floor(ys).astype(int)
    fx, fy = xs - xl, (ys - yl)[:, None]
    a = logits[np.maximum(yl, 0)[:, None], np.maximum(xl, 0)]
    b = logits[np.maximum(yl, 0)[:, None], np.minimum(xl + 1, 287)]
    c = logits[np.minimum(yl + 1, 287)[:, None], np.maximum(xl, 0)]
    d = logits[np.minimum(yl + 1, 287)[:, None], np.minimum(xl + 1, 287)]
    return ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy) > 0


def decode(output, w, h, thresholds=None, min_size=1):
    """Named outputs yield text/SFX-only erase pixels and independent panel/balloon geometry."""
    for name, shape in [("dets", (1, 300, 4)), ("labels", (1, 300, 5)),
                        ("masks", (1, 300, 288, 288))]:
        value = output.get(name)
        if not isinstance(value, np.ndarray) or value.shape != shape:
            raise RuntimeError("Koharu model outputs do not match the installed FP32 model")
        if not np.isfinite(value).all():
            raise RuntimeError("Koharu returned invalid values")
    limits = {**THRESHOLDS, **(thresholds or {})}
    limits = [limits[k] for k in ["text", "sfx", "bubble", "panel"]]
    dets, labels, masks = output["dets"][0], output["labels"][0], output["masks"][0]
    with np.errstate(over="ignore"):
        confs = 1 / (1 + np.exp(-labels.astype(np.float64).ravel()))
    choices = np.argsort(-confs, kind="stable")[:160]
    boxes, panels, bubbles, ink_queries, bubble_queries = [], [], [], set(), []
    for choice in choices:
        query, cls = divmod(int(choice), 5)
        if cls >= 4:
            continue
        conf = float(confs[choice])
        cx, cy, bw, bh = (float(v) for v in dets[query])
        box = {"x1": max(0, (cx - bw / 2) * w), "y1": max(0, (cy - bh / 2) * h),
               "x2": min(w, (cx + bw / 2) * w), "y2": min(h, (cy + bh / 2) * h), "conf": conf}
        if box["x2"] <= box["x1"] or box["y2"] <= box["y1"] or conf < limits[cls]:
            continue
        if cls < 2:
            if box["x2"] - box["x1"] <= min_size or box["y2"] - box["y1"] <= min_size:
                continue
            boxes.append(box)
            ink_queries.add(query)
        elif cls == 2:
            bubbles.append(box)
            bubble_queries.append((query, box))
        else:
            panels.append(box)
    mask = np.zeros((h, w), bool)
    for query in ink_queries:
        mask |= _instance_mask(masks[query], w, h)
    balloons = []
    for query, box in bubble_queries:
        x0, y0 = max(0, math.floor(box["x1"])), max(0, math.floor(box["y1"]))
        x2, y2 = min(w, math.ceil(box["x2"])), min(h, math.ceil(box["y2"]))
        instance = _instance_mask(masks[query], w, h, x0, y0, x2, y2)
        rows = []
        for row in instance:
            edges = np.flatnonzero(np.diff(np.r_[False, row, False].astype(np.int8)))
            rows.append((edges + x0).tolist())
        occupied = [i for i, row in enumerate(rows) if row]
        if occupied:
            first, last = occupied[0], occupied[-1]
            rows = rows[first:last + 1]
            balloons.append({"width": w, "height": h, "x1": min(row[0] for row in rows if row),
                             "y1": y0 + first, "x2": max(row[-1] for row in rows if row),
                             "y2": y0 + last + 1, "conf": box["conf"], "rows": rows})
    return {"boxes": boxes, "panels": panels, "bubbles": bubbles, "balloons": balloons, "mask": mask}
