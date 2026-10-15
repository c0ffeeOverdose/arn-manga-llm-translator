# KoharuLayout

KoharuLayout is the default model for on-device and Cloud detection. To change it, open
**Settings → Model → Layout model** and save your choice. Saved model choices are
retained. Cloud uses the same pinned Koharu export on your server; it does not run
local layout inference. CTD remains selectable with text-position ordering on Cloud.
Koharu finds text, sound effects, balloons and panels together. OCR, translation,
reading direction and text cleanup continue to use your existing settings.

The supported model is the FP32 1152px export with attention queries processed in
chunks of 256. It has been tested on an RTX 3060 Laptop with 6 GiB VRAM. Detection
quality varies with the page; this is an alternative to CTD, not an accuracy guarantee.

## Install once

Development builds include `models/koharu-fp32-chunked.onnx` when present. Store
builds contain no weights. Use **Download** to install the model from
[arn-manga-models](https://huggingface.co/c0ffeeOverdose/arn-manga-models), or let the
first on-device translation download it automatically. A progress bar tracks the
download. The extension checks the exact size and SHA-256 before saving the model
locally; subsequent translations work offline without downloading it again.

Once installed, the button becomes **Delete**, matching the OCR model manager.
Delete removes the downloaded file from the local model store and returns the button
to **Download**. To reinstall, delete it and then download a fresh copy from the mirror;
the download bypasses the browser's HTTP cache. CTD/Panel are managed together, and
the text cleanup model uses the same Delete/Download flow. Other models, OCR files
and saved translations are preserved. Development-bundled files remain part of the
extension package; Delete removes only the downloaded/imported copy.

Koharu checks saved bytes before loading. A wrong size or SHA-256 triggers one
replacement attempt from the development bundle or mirror. An invalid replacement
fails without looping and leaves the previous bytes untouched. Cryptography/runtime
errors do not trigger a replacement, and `noDownload: true` never repairs through
the network.

**Import model file** remains available for installing a local copy of the same
ONNX file. SafeTensors, FP16, INT8 and unbounded-attention ONNX exports are different
files and will be refused. Availability checks never download a model, and callers
using `noDownload: true` can only load cached or development-bundled files.

- File: `koharu-fp32-chunked.onnx`
- Size: 149,799,163 bytes (149.8 MB)
- SHA-256: `35d89289e92a6dba75b9ccd4ebd447a55aad69c993d0a8e439c57509d598dfd6`

The original weights and model card are at
[mayocream/KoharuLayout](https://huggingface.co/mayocream/koharu-layout-rfdetr-seg-2xl-1152),
revision `aed55fdb8ca953c6bec33cf6ed6dd52a9b72bfa2`. The model has custom/other
licensing and separate training-data terms; see that model card. The extension's
GPL license does not replace those terms. The mirror retains the upstream credits
and per-file license in its model card and `koharu-fp32-chunked.json`.

The [existing ShiniShiho ONNX export](https://huggingface.co/ShiniShiho/koharu-layout-rfdetr-seg-2xl-1152-onnx)
retains the original 1152px segmentation heads, but has a different graph and checksum.
It is not the extension's supported artifact. The browser-specific export preserves
FP32 weights and 1152px resolution while bounding attention allocations with 256-query
chunks. It avoids the repeated-inference GPU memory failures observed with straight
exports on the tested 6 GiB device. This result is scoped to the tested runtime and hardware.

## Reproduce the supported export

Use a separate Python 3.12 environment with the tested versions: RF-DETR 1.7.0,
PyTorch 2.10.0, torchvision 0.25.0, transformers 5.19.0, ONNX 1.23.2 and SafeTensors.
CPU-only PyTorch is sufficient. Download `model.safetensors` from the pinned source
revision, then run:

```sh
python scripts/export-koharu-onnx.py --weights /path/to/model.safetensors
node build.mjs
node build.mjs --firefox
```

The exporter verifies both the input and output checksums. A different output
checksum requires investigating the export environment before using the artifact;
do not bypass the extension's file check.

## Publish the runtime mirror

The model card and artifact manifest are maintained in `docs/model-mirror/`.
With `huggingface_hub` installed in a separate Python environment, verify the payload
before publishing the model, manifest, card and licensed exporter together:

```sh
python scripts/publish-koharu-model.py --dry-run
hf auth login
python scripts/publish-koharu-model.py
```

Publishing requires write access to `c0ffeeOverdose/arn-manga-models`. The script
verifies the model size and checksum, and uses the reviewed mirror revision as a
parent commit so newer model-card edits cannot be overwritten accidentally.
If the remote repository has changed, review the current card and update the payload
and `MIRROR_BASE_REVISION` before publishing.

## Settings and existing translations

Koharu has independent confidence settings under Advanced tuning. Its defaults
are text 0.25, sound effects 0.20 and panels 0.50. Balloon detection uses 0.50. Minimum region size
is shared with CTD. Only accepted text and sound-effect instance masks enter text
cleanup; balloon and panel masks never erase the page. The LLM still decides which
regions to translate or keep.

Accepted balloon instance masks also guide text placement. The extension matches
text-mask support to a balloon, measures its original background inside the model
outline, and wraps text against the resulting per-row shape. Shared balloon
instances divide their available space between text regions before placement.
The source text rectangle continues to own OCR and cleanup; it does not limit
the translation to that rectangle. Missing or uncertain model geometry uses the
existing image-based layout. Long translations can still need smaller lettering
when the actual balloon has little free space.

In debug views, solid red outlines the source text region. Dashed green bounds the
placement area; the orange dashed contour follows the per-row shape used for wrapping
and clipping. These areas are measured from the original page in both views. Text can
extend beyond red while staying inside the usable balloon shape.

Paragraph wrapping uses one shared center and includes glyph outlines and strokes in
its width measurement. It tries placement around the source text and the balloon's
center before reducing the font, so a changing contour can use the available height.

Changing quality presets preserves the selected model. New translation requests
and chapter runs use that choice. Active chapter runs retain their captured settings.
Saved results are matched to the selected model and its thresholds; existing legacy
CTD cache fingerprints are preserved. Use Re-translate to replace an already visible
translation with fresh detection from the newly selected model.

Koharu runs on-device or on your Cloud server. Update/redeploy the server to use
the same model recipe as the extension; mismatched servers report an error instead
of silently returning CTD results. Cloud needs no local model download. On-device
Auto tries WebGPU and can use CPU when WebGPU is unavailable; Force CPU uses WASM.
