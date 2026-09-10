#!/usr/bin/env python3
"""Reproduce models/ctd-int8.onnx from models/ctd.onnx (dynamic int8 quant).

Needs: pip install onnx onnxruntime
Idempotent: skips if the output exists (delete it to re-run).

Recipe: plain quantize_dynamic(WeightType.QUInt8), NO pre-processing.
Bit-proven: reproduces the shipped ctd-int8.onnx md5-identically
(ade48ae3…). Do NOT "improve" it — QInt8 and pre-processed variants both
change detections (lemondouble also rejected dynamic-QInt8 for NMS drift;
QUInt8 is the variant that matches).
Validate with:
  python3 scripts/quantize-ctd.py --check <sample-page.png>
which runs fp32 + int8 and reports raw-output max diff + decoded box count.
The committed extension tolerates ±2px box drift (spike-proven vs Python).
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'models' / 'ctd.onnx'
DST = ROOT / 'models' / 'ctd-int8.onnx'


def quantize() -> None:
    from onnxruntime.quantization import quantize_dynamic, QuantType
    import onnx

    if DST.exists():
        print(f'{DST} exists — delete it to re-quantize')
        return
    if not SRC.exists():
        sys.exit(f'missing {SRC} — run scripts/fetch-models.sh first')
    fp32 = onnx.load(str(SRC))
    print(f'fp32: {SRC.stat().st_size / 1000000:.1f}MB, {len(fp32.graph.node)} nodes')
    quantize_dynamic(str(SRC), str(DST), weight_type=QuantType.QUInt8)
    q = onnx.load(str(DST))
    print(f'int8: {DST.stat().st_size / 1000000:.1f}MB, {len(q.graph.node)} nodes')


def check(img_path: str) -> None:
    import cv2
    import numpy as np
    import onnxruntime as ort

    for p in (SRC, DST):
        if not p.exists():
            sys.exit(f'missing {p}')
    img = cv2.imread(img_path)
    if img is None:
        sys.exit(f'cannot read {img_path}')
    h, w = img.shape[:2]
    s = 1024 / max(h, w)
    canvas = np.full((1024, 1024, 3), 114, dtype=np.uint8)
    canvas[0:round(h * s), 0:round(w * s)] = cv2.resize(img, (round(w * s), round(h * s)))
    x = (canvas[:, :, ::-1].transpose(2, 0, 1)[None] / 255).astype(np.float32)
    outs = []
    for p in (SRC, DST):
        sess = ort.InferenceSession(str(p), providers=['CPUExecutionProvider'])
        outs.append(sess.run(None, {sess.get_inputs()[0].name: x}))
    names = [o.name for o in ort.InferenceSession(str(SRC), providers=['CPUExecutionProvider']).get_outputs()]
    for n, a, b in zip(names, *outs):
        d = float(np.abs(a.astype(np.float64) - b.astype(np.float64)).max())
        print(f'{n}: max-abs-diff int8-vs-fp32 = {d:.4g}')
    # raw diffs are large by nature (abs-px space) — decoded box COUNT is the
    # real signal; reuse the spike's own decode
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from spike_onnx import run_ctd
        for label, p in (('fp32', SRC), ('int8', DST)):
            sess = ort.InferenceSession(str(p), providers=['CPUExecutionProvider'])
            boxes, _, _, _ = run_ctd(sess, img)
            print(f'{label}: {len(boxes)} boxes')
    except ImportError:
        pass


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--check':
        check(sys.argv[2])
    elif len(sys.argv) == 1:
        quantize()
    else:
        sys.exit('usage: quantize-ctd.py [--check <sample-page.png>]')
