#!/usr/bin/env python3
"""Spike: prove ShadowB YOLO26s works for our use case.

Steps:
  1. Load best.pt (ultralytics), export ONNX (opset 12, imgsz 1280) for ORT Web.
  2. Predict on test images (JA + EN), retina masks, conf 0.25.
  3. Save visualization (per-class colors) + JSON stats per image.
  4. Sanity: load the exported ONNX with onnxruntime CPU and run it directly.

Usage: spike_shadowb.py <model.pt> <out_dir> <img1> [img2 ...]
"""
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

CLASSES = {0: 'frame', 1: 'text', 2: 'balloon'}
COLORS = {'frame': (255, 0, 0), 'text': (0, 255, 0), 'balloon': (0, 0, 255)}


def visualize(img_bgr, result, out_path):
    overlay = img_bgr.copy()
    stats = {c: 0 for c in CLASSES.values()}
    if result.masks is not None:
        masks = result.masks.data.cpu().numpy()  # (N, H, W)
        names = [result.names[int(c)] for c in result.boxes.cls.cpu().numpy()]
        confs = result.boxes.conf.cpu().numpy()
        # letterbox back to original size if needed
        for m, name, conf in zip(masks, names, confs):
            stats[name] = stats.get(name, 0) + 1
            m_resized = cv2.resize(m, (img_bgr.shape[1], img_bgr.shape[0]),
                                   interpolation=cv2.INTER_NEAREST)
            color = COLORS.get(name, (255, 255, 0))
            overlay[m_resized > 0.5] = (overlay[m_resized > 0.5] * 0.55
                                        + np.array(color) * 0.45).astype(np.uint8)
    cv2.imwrite(str(out_path), overlay)
    return stats


def main():
    model_path, out_dir = sys.argv[1], Path(sys.argv[2])
    imgs = sys.argv[3:]
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {'model': model_path, 'images': []}

    from ultralytics import YOLO
    model = YOLO(model_path)

    # 1) export ONNX
    t0 = time.time()
    onnx_path = model.export(format='onnx', imgsz=1280, opset=12, dynamic=False)
    print(f'[export] {onnx_path} in {time.time()-t0:.1f}s')
    report['onnx_export'] = str(onnx_path)

    for img_path in imgs:
        t0 = time.time()
        result = model.predict(img_path, imgsz=1280, conf=0.25, retina_masks=True,
                               iou=0.7, verbose=False)[0]
        dt = time.time() - t0
        img = cv2.imread(img_path)
        vis = out_dir / (Path(img_path).stem + '-spike.png')
        stats = visualize(img, result, vis)
        report['images'].append({'img': img_path, 'seconds': round(dt, 2),
                                 'regions': stats, 'vis': str(vis)})
        print(f'[{Path(img_path).name}] {dt:.2f}s {stats} -> {vis}')

    # 4) ONNX sanity via onnxruntime
    import onnxruntime as ort
    sess = ort.InferenceSession(str(onnx_path), providers=['CPUExecutionProvider'])
    dummy = np.zeros((1, 3, 1280, 1280), dtype=np.float32)
    out = sess.run(None, {sess.get_inputs()[0].name: dummy})
    report['ort_ok'] = True
    report['ort_outputs'] = [o.shape for o in out if hasattr(o, 'shape')]
    print('[onnxruntime] outputs:', report['ort_outputs'])

    (out_dir / 'spike-report.json').write_text(json.dumps(report, indent=2))
    print('[done]', out_dir / 'spike-report.json')


if __name__ == '__main__':
    main()
