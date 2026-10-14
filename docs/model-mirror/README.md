---
license: other
license_name: per-file-licenses
license_link: https://huggingface.co/c0ffeeOverdose/arn-manga-models/blob/main/README.md#licenses
base_model:
  - lemondouble/lemon-manga-translator
  - dreMaz/AnimeMangaInpainting
  - leoxs22/manga-panel-detector-yolo26n
  - mayocream/koharu-layout-rfdetr-seg-2xl-1152
tags:
  - onnx
  - int8
  - fp16
  - manga
  - comic
  - text-detection
  - image-segmentation
  - inpainting
  - webgpu
---

# arn-manga-models (unofficial runtime mirror)

Ready-to-download inference weights for the
[Arn Manga LLM Translator](https://github.com/c0ffeeOverdose/arn-manga-llm-translator)
browser extension. This repo is a CDN bucket for runtime conversions of upstream
weights. Credit for the source models belongs to their original authors; this
mirror does not imply their endorsement.

## Files

| file | source | conversion | license |
|---|---|---|---|
| `ctd-int8.onnx` (40MB, md5 `ade48ae332291ef6cdbcd4257810c3ec`) | `lemondouble/lemon-manga-translator` → `onnx/comic-text-detector/ctd.onnx` (upstream: `dmMaze/comic-text-detector`) | `quantize_dynamic(WeightType.QUInt8)`, no pre-processing (see `scripts/quantize-ctd.py`) | GPL-3.0 |
| `lama-manga-512-fp16w.onnx` (107MB, md5 `8abe1d2e8e66d59d165e21cbf4a99a27`) | `dreMaz/AnimeMangaInpainting` → `lama_large_512px.ckpt` (big-lama fine-tuned on 300k manga/anime pages) | fp16 weight-only + FFT-as-matmuls (ORT-web WebGPU has no DFT kernel; see `scripts/export-inpaint-onnx.py`) | MIT (model) / Apache-2.0 (architecture) |
| `panel-yolo26n.onnx` (10MB, md5 `21a14eb8206d44db688b575670023097`) | `leoxs22/manga-panel-detector-yolo26n` → `manga_panel_detector_fp32.pt` (trained on Manga109-s) | `YOLO(pt).export(format='onnx', imgsz=640, opset=17, dynamic=False, simplify=True)` (see `scripts/export-panel-onnx.sh`) | AGPL-3.0 (weights) |
| `koharu-fp32-chunked.onnx` (149.8 MB) | [mayocream/KoharuLayout](https://huggingface.co/mayocream/koharu-layout-rfdetr-seg-2xl-1152) → `model.safetensors` | FP32, 1152px, opset 17, attention query chunks of 256 (see `scripts/export-koharu-onnx.py`) | Upstream custom/other; Manga109 training-data terms |

## KoharuLayout FP32

This export retains the source model's FP32 weights, 1152 × 1152 input resolution,
and text, onomatopoeia, bubble and panel segmentation heads. Only attention query
evaluation is divided into chunks of 256 to bound intermediate allocations.
It is the browser extension's supported Koharu artifact; other ONNX conversions
and quantizations have different checksums and cannot replace it directly.

- Size: 149,799,163 bytes.
- SHA-256: `35d89289e92a6dba75b9ccd4ebd447a55aad69c993d0a8e439c57509d598dfd6`.
- Source revision: `aed55fdb8ca953c6bec33cf6ed6dd52a9b72bfa2`.
- Source weights SHA-256: `9bf6d2cbd7793c956d8c857bb1672a396eb7f100eb0682f86830d05e31168efb`.
- Tensor, preprocessing and export details: [`koharu-fp32-chunked.json`](koharu-fp32-chunked.json).
- Reproducible exporter: [`export_koharu_onnx.py`](export_koharu_onnx.py), using the versions recorded in the manifest.

The model detects page layout. It does not perform OCR, translation or reading-order
prediction. Only text and onomatopoeia masks are used for lettering cleanup by the
extension; bubble and panel masks describe layout. Detection quality depends on
the page and is not guaranteed by this conversion.

## Licenses

Each artifact retains its own upstream license. The repository metadata uses
`other` because this collection includes several licenses and Koharu's custom
terms; it does not relicense any model. The extension's GPL-3.0 license does not
replace the model licenses.

The included export script uses the extension project's
[GPL-3.0-only license](LICENSE-export).

Koharu's [source model card and terms](https://huggingface.co/mayocream/koharu-layout-rfdetr-seg-2xl-1152/blob/aed55fdb8ca953c6bec33cf6ed6dd52a9b72bfa2/README.md)
designate the weights as custom/`other`. RF-DETR software is Apache-2.0. The source
model was fine-tuned on Manga109 images, distributed separately under Manga109's
academic-use terms. This mirror contains no Manga109 images and grants no rights
to those images or third-party comic content. Users remain responsible for the
upstream terms and applicable rights.

The panel weights use AGPL-3.0, as stated in the [upstream license correction](https://huggingface.co/leoxs22/manga-panel-detector-yolo26n#license).
Manga109-s training-data terms and dataset attribution apply separately.
