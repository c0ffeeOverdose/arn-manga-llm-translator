#!/usr/bin/env python3
"""Full detector comparison on MangaDex B&W pages + color page.

For each image: mean saturation (router threshold evidence) + 3 detectors,
each saved as a NUMBERED visualization so misses are visible to the eye.
"""
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(Path(__file__).parent))
from spike_onnx import letterbox, nms, run_ctd, run_lordtrilink

MODELS_DIR = Path(__file__).parent.parent / 'models'


def mean_saturation(img_bgr):
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    return float(hsv[..., 1].mean())


def draw_numbered(img, boxes, classes, masks, palette, out_path):
    """boxes: list of [x1,y1,x2,y2]; classes: list of label str or None;
    masks: list of 2D arrays (original size) or None per box."""
    out = img.copy()
    for i, (b, cls, m) in enumerate(zip(boxes, classes, masks)):
        color = palette.get(cls, (0, 255, 255))
        if m is not None:
            out[m > 0] = (out[m > 0] * 0.55 + np.array(color) * 0.45).astype(np.uint8)
        cv2.rectangle(out, (b[0], b[1]), (b[2], b[3]), color, 4)
        cv2.putText(out, str(i + 1), (b[0] + 10, b[1] + 55),
                    cv2.FONT_HERSHEY_SIMPLEX, 2.0, (0, 0, 255), 7)
    cv2.imwrite(str(out_path), out)


def run_shadowb(predict_fn, img):
    """ShadowB via ultralytics predict; returns boxes, classes, masks (orig size)."""
    r = predict_fn(img)[0]
    h, w = img.shape[:2]
    boxes, classes, masks = [], [], []
    if r.boxes is None or len(r.boxes) == 0:
        return boxes, classes, masks
    bb = r.boxes.xyxy.cpu().numpy().astype(int)
    cl = [r.names[int(c)] for c in r.boxes.cls.cpu().numpy()]
    ms = None
    if r.masks is not None:
        ms = [cv2.resize(m, (w, h), interpolation=cv2.INTER_NEAREST)
              for m in r.masks.data.cpu().numpy()]
    for i in range(len(bb)):
        boxes.append(np.clip(bb[i], 0, [w, h, w, h]))
        classes.append(cl[i])
        masks.append(ms[i] if ms else None)
    return boxes, classes, masks


def main():
    out_dir = Path(sys.argv[1])
    imgs = sys.argv[2:]
    out_dir.mkdir(parents=True, exist_ok=True)

    from ultralytics import YOLO
    shadowb = YOLO(str(MODELS_DIR / 'shadowb-yolo26s.pt'))
    ctd = ort.InferenceSession(str(MODELS_DIR / 'ctd.onnx'), providers=['CPUExecutionProvider'])
    lt = ort.InferenceSession(str(MODELS_DIR / 'lordtrilink-1024.onnx'), providers=['CPUExecutionProvider'])

    SHADOWB_PALETTE = {'frame': (255, 0, 0), 'text': (0, 255, 0), 'balloon': (0, 0, 255)}
    report = []
    for p in imgs:
        img = cv2.imread(p)
        name = Path(p).stem
        row = {'img': name, 'size': f'{img.shape[1]}x{img.shape[0]}',
               'mean_sat': round(mean_saturation(img), 1)}

        # ShadowB
        t0 = time.time()
        sb_boxes, sb_cls, sb_masks = run_shadowb(
            lambda im: shadowb.predict(im, imgsz=1280, conf=0.25, retina_masks=True,
                                       iou=0.7, verbose=False), img)
        row['shadowb'] = {'sec': round(time.time() - t0, 2),
                          'count': len(sb_boxes),
                          'classes': {c: sb_cls.count(c) for c in set(sb_cls)}}
        draw_numbered(img, sb_boxes, sb_cls, sb_masks, SHADOWB_PALETTE,
                      out_dir / f'{name}-shadowb.png')

        # CTD
        t0 = time.time()
        ctd_boxes, ctd_conf, ctd_cls, ctd_mask = run_ctd(ctd, img)
        row['ctd'] = {'sec': round(time.time() - t0, 2), 'count': len(ctd_boxes),
                      'conf': [round(float(c), 2) for c in ctd_conf]}
        draw_numbered(img, list(ctd_boxes), ['text'] * len(ctd_boxes),
                      [ctd_mask] * len(ctd_boxes), {'text': (0, 0, 255)},
                      out_dir / f'{name}-ctd.png')

        # lordtrilink
        t0 = time.time()
        lt_boxes, lt_conf = run_lordtrilink(lt, img)
        row['lordtrilink'] = {'sec': round(time.time() - t0, 2), 'count': len(lt_boxes),
                              'conf': [round(float(c), 2) for c in lt_conf]}
        draw_numbered(img, list(lt_boxes), [None] * len(lt_boxes),
                      [None] * len(lt_boxes), {}, out_dir / f'{name}-lt.png')

        report.append(row)
        print(json.dumps(row))

    (out_dir / 'comparison.json').write_text(json.dumps(report, indent=2))
    print('report ->', out_dir / 'comparison.json')


if __name__ == '__main__':
    main()
