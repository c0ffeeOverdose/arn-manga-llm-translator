#!/bin/sh
# One-time: export leoxs22/manga-panel-detector-yolo26n (.pt, Apache-2.0) to
# ONNX for ORT-Web. Needs: pip install torch ultralytics onnx huggingface_hub
# Output goes to models/panel-yolo26n.onnx (gitignored, like ctd-int8.onnx).
# Attribution: model by Leandro Narosky, trained on Manga109-s (condition 5
# allows commercial use of results with dataset attribution).
set -e
cd "$(dirname "$0")/.."
test -f models/panel-yolo26n.onnx && { echo "models/panel-yolo26n.onnx exists — delete it to re-export"; exit 0; }
PT=$(python3 -c "from huggingface_hub import hf_hub_download; print(hf_hub_download('leoxs22/manga-panel-detector-yolo26n', 'manga_panel_detector_fp32.pt'))")
ONNX="${PT%.pt}.onnx"
python3 -c "from ultralytics import YOLO; YOLO('$PT').export(format='onnx', imgsz=640, opset=17, dynamic=False, simplify=True)"
mv "$ONNX" models/panel-yolo26n.onnx
ls -la models/panel-yolo26n.onnx
