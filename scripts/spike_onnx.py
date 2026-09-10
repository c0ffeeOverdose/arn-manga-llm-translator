#!/usr/bin/env python3
"""Spike round 2: run CTD ONNX + lordtrilink ONNX with pure onnxruntime + numpy.

No torch, no ultralytics — this is exactly the code shape that will port to ORT Web.

CTD (lemondouble export):
  in  : image [1,3,1024,1024] (letterbox, pad right/bottom, /255)
  out : bbox_preds [1,64512,7] = [x,y,w,h,obj,eng,ja] (xywh abs px in 1024 space)
        mask [1,1,1024,1024]   = text mask (letterboxed space)
lordtrilink YOLO11:
  in  : images [1,3,1024,1024] (centered letterbox, /255)
  out : output0 [1,6,21504] = [x,y,w,h,conf,cls]
"""
import sys
import json
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort


def letterbox(img, size, center=False):
    h, w = img.shape[:2]
    s = size / max(h, w)
    nw, nh = round(w * s), round(h * s)
    r = cv2.resize(img, (nw, nh))
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    dw, dh = size - nw, size - nh
    y0, x0 = (dh // 2, dw // 2) if center else (0, 0)
    canvas[y0:y0 + nh, x0:x0 + nw] = r
    return canvas, s, x0, y0


def nms(boxes, scores, iou_thr):
    keep = []
    idx = np.argsort(scores)[::-1]
    while idx.size:
        i = idx[0]
        keep.append(i)
        xx1 = np.maximum(boxes[i, 0], boxes[idx[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[idx[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[idx[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[idx[1:], 3])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        a = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
        b = (boxes[idx[1:], 2] - boxes[idx[1:], 0]) * (boxes[idx[1:], 3] - boxes[idx[1:], 1])
        iou = inter / (a + b - inter + 1e-9)
        idx = idx[1:][iou < iou_thr]
    return keep


def run_ctd(sess, img):
    h, w = img.shape[:2]
    lb, s, x0, y0 = letterbox(img, 1024, center=False)
    x = lb[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    boxes_raw, mask = sess.run(None, {'image': x})
    boxes_raw = boxes_raw[0]  # (64512, 7)
    conf = boxes_raw[:, 4:5] * boxes_raw[:, 5:].max(1, keepdims=True)
    cls = boxes_raw[:, 5:].argmax(1)
    sel = conf[:, 0] > 0.35
    b = boxes_raw[sel, :4].copy()
    # xywh -> xyxy, undo letterbox (scale + no center pad)
    b[:, 0] = (b[:, 0] - b[:, 2] / 2) / s
    b[:, 1] = (b[:, 1] - b[:, 3] / 2) / s
    b[:, 2] = b[:, 0] + b[:, 2] / s
    b[:, 3] = b[:, 1] + b[:, 3] / s
    c = conf[sel, 0]
    k = nms(b, c, 0.35)
    boxes = np.clip(b[k], 0, [w, h, w, h]).astype(int)
    # text mask: crop letterbox content, resize to original
    m = (mask[0, 0] > 0.3).astype(np.uint8) * 255
    mh, mw = round(h * s), round(w * s)
    m = cv2.resize(m[:mh, :mw], (w, h), interpolation=cv2.INTER_NEAREST)
    return boxes, c[k], cls[sel][k], m


def run_lordtrilink(sess, img):
    h, w = img.shape[:2]
    lb, s, x0, y0 = letterbox(img, 1024, center=True)
    x = lb[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    out = sess.run(None, {'images': x})[0][0]  # (6, 21504)
    out = out.T  # (21504, 6)
    sel = out[:, 4] > 0.25
    b = out[sel, :4].copy()
    # xywh (centered letterbox) -> xyxy original
    b[:, 0] = (b[:, 0] - b[:, 2] / 2 - x0) / s
    b[:, 1] = (b[:, 1] - b[:, 3] / 2 - y0) / s
    b[:, 2] = b[:, 0] + b[:, 2] / s
    b[:, 3] = b[:, 1] + b[:, 3] / s
    c = out[sel, 4]
    k = nms(b, c, 0.7)
    return np.clip(b[k], 0, [w, h, w, h]).astype(int), c[k]


def draw(img, boxes, mask=None, color=(0, 255, 0)):
    out = img.copy()
    if mask is not None:
        out[mask > 0] = (out[mask > 0] * 0.5 + np.array((0, 0, 255)) * 0.5).astype(np.uint8)
    for b in boxes:
        cv2.rectangle(out, (b[0], b[1]), (b[2], b[3]), color, 3)
    return out


def main():
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(exist_ok=True, parents=True)
    imgs = sys.argv[2:]
    report = []
    ctd = ort.InferenceSession('/tmp/opencode/ctd.onnx', providers=['CPUExecutionProvider'])
    lt = ort.InferenceSession('/tmp/opencode/lordtrilink-1024.onnx', providers=['CPUExecutionProvider'])
    for p in imgs:
        img = cv2.imread(p)
        row = {'img': p}
        t0 = time.time()
        ctd_boxes, ctd_conf, ctd_cls, ctd_mask = run_ctd(ctd, img)
        t_ctd = time.time() - t0
        t0 = time.time()
        lt_boxes, lt_conf = run_lordtrilink(lt, img)
        t_lt = time.time() - t0
        cv2.imwrite(str(out_dir / (Path(p).stem + '-ctd.png')),
                    draw(img, ctd_boxes, ctd_mask, (0, 255, 0)))
        cv2.imwrite(str(out_dir / (Path(p).stem + '-lt.png')),
                    draw(img, lt_boxes, None, (0, 200, 255)))
        row.update({'ctd': {'boxes': len(ctd_boxes), 'conf': [round(float(c), 2) for c in ctd_conf],
                            'mask_px': int((ctd_mask > 0).sum()), 'sec': round(t_ctd, 2)},
                    'lordtrilink': {'boxes': len(lt_boxes), 'conf': [round(float(c), 2) for c in lt_conf],
                                    'sec': round(t_lt, 2)}})
        report.append(row)
        print(row)
    (out_dir / 'onnx-report.json').write_text(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
