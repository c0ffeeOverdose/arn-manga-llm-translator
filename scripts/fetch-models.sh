#!/bin/sh
# One-shot: fetch every gitignored model so a fresh clone can build. Idempotent — re-run safely.
# CTD fp32 (GPL-3.0) → int8 via quantize-ctd.py; panel (.pt, Apache-2.0) via export-panel-onnx.sh.
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

# panel export is OPTIONAL (banding fallback) — failure warns, never errors
sh scripts/export-panel-onnx.sh || echo "WARN: panel export failed (needs: pip install torch ultralytics onnx huggingface_hub) — continuing without it"

echo "models ready:"; ls -la models/
