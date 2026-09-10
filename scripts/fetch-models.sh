#!/bin/sh
# One-shot: fetch every gitignored model so a fresh clone can build.
# Idempotent — existing files are skipped, re-run safely.
# Needs: curl, python3 + `pip install huggingface_hub onnx onnxruntime`
#        (+ torch/ultralytics only for the panel export step)
# Sources (all public, see attribution below):
#   CTD fp32  (77MB)  lemondouble/lemon-manga-translator (GPL-3.0)
#   CTD int8  (40MB)  quantized locally via scripts/quantize-ctd.py (bit-proven)
#   panel .pt         leoxs22/manga-panel-detector-yolo26n (Apache-2.0) -> ONNX via scripts/export-panel-onnx.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p models

if test -f models/ctd.onnx; then
  echo "have models/ctd.onnx"
else
  echo "downloading ctd.onnx (77MB)..."
  curl -fL -o models/ctd.onnx \
    "https://huggingface.co/lemondouble/lemon-manga-translator/resolve/main/onnx/comic-text-detector/ctd.onnx?download=true"
fi

python3 scripts/quantize-ctd.py

# panel needs torch+ultralytics (heavy) and is OPTIONAL (banding fallback) —
# failure here is a warning, not an error
sh scripts/export-panel-onnx.sh || echo "WARN: panel export failed (needs: pip install torch ultralytics onnx huggingface_hub) — continuing without it"

echo "models ready:"; ls -la models/
