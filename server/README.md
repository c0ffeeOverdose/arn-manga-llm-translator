# Optional cloud inference server

[Documentation index](../docs/README.md) · [Cloud architecture and security boundaries](../docs/cloud-and-security.md)

Runs KoharuLayout detection by default, Baberu OCR and optional AI text cleanup outside the browser.
To use it, deploy an endpoint and paste its URL and key into Options → Model.
Local inference does not require this server.
It does not run translation LLM calls or the text renderer. Koharu returns panels
and balloon shapes for client-side ordering/layout. CTD remains selectable, with
text-position ordering instead of a separate panel model on the server.

Both notebooks are generated from these sources by `scripts/make-colab.py` —
don't edit them by hand.

## Run in Colab

Open `colab-server.ipynb` in Google Colab → Runtime → Run all → paste the two
values it prints. The server runs inside the notebook's VM through a Cloudflare
quick tunnel, using a GPU if available. The URL changes each session; rerun the
cells and update the endpoint after disconnection. GPU availability and session
limits vary.

## Deploy to Modal (stable URL)

Open `cloud-setup.ipynb` in Google Colab → Runtime → Run all → paste the two
values it prints. Or from a terminal:

```sh
modal secret create arn-manga-key ARN_API_KEY=<random>
modal deploy modal_app.py
```

The endpoint scales to zero when idle; the first request after a break includes
model startup time. Check your account's current compute quota and pricing.

## Local run

```sh
pip install -r requirements.txt
MODEL_DIR=/path/to/models uvicorn app:app --port 7860          # no auth
MODEL_DIR=/path/to/models ARN_API_KEY=<random> python serve.py # Bearer auth
```

`serve.py` is the platform-neutral launcher: `ARN_API_KEY` set = auth on
(`/` and `/health` stay open for the extension's Test/warm probe), `PORT`
selects the port. Modal keeps its own wrapper for the same rule.
Running `uvicorn app:app` directly does not enable that middleware, even with
`ARN_API_KEY` set. The Dockerfile also starts the bare app: add authentication/TLS
at the deployment boundary before exposing it publicly.

`MODEL_DIR` needs: `koharu-fp32-chunked.onnx`, `vision-int4.onnx`, `baberu-prefill.onnx`,
`baberu-step.onnx`, `vocab.json` (see `models_manifest.py` for sources).
`ctd.onnx` is optional for the legacy detector; `lama-manga-512-fp16w.onnx` is optional
for AI cleanup. Koharu's exact size and SHA-256 are verified before loading.
Regenerate/redeploy the server when updating the extension's Koharu model recipe;
an older or mismatched server reports an error rather than silently returning CTD.

## API

- `GET /health` → `{ok, device, layoutModel, layoutModels, layoutRecipe, modelSha256, panels, ep, splitGen}` (no auth — Koharu/OCR readiness,
  not proof that the key is accepted or the optional cleanup model is loaded)
- `POST /v1/page?layout_model=koharu&min_size=12` — raw PNG/JPEG bytes in the body →
  `{ok, layoutModel, layoutRecipe, modelSha256, w, h, boxes:[{x1,y1,x2,y2,conf}], panels, balloons, panelSkipped?, splitGen, mask:{w,h,b64}, texts[],
  ms:{body,detect,ocr,total}}`. `texts[i]` belongs to `boxes[i]`; text is raw
  (the client collapses whitespace, same as the local path). `splitGen` is the
  server's box-split generation (bump = client re-detects older cache entries);
  `mask` is the packed text/SFX mask (`packMask` codec — the client restores it
  with `unpackMask` for text-color sampling, inpaint and the debug view).
- Omitting `layout_model` selects Koharu. Its thresholds are `text_conf=0.25`,
  `sfx_conf=0.20`, `bubble_conf=0.50`, `panel_conf=0.50`. `layout_model=ctd` uses
  `conf_thr=0.35` and returns empty panels/balloons. Extreme strips use tiled text-position ordering.
  Balloon rows retain their source dimensions; they are layout metadata, never erase masks.
- `texts=0` skips server OCR for image-reading workflows. `inpaint=1` attempts
  cleanup in the same round trip and adds `patches`, `windows`, `ms.inpaint`.
  Patch `i` refers to the box index before the client reorders it.
- `POST /v1/inpaint` accepts JSON `{image, boxes, mask?}`: base64 page image,
  pixel-coordinate rectangles and optional base64 grayscale PNG erase mask.
  The mask must match the image dimensions. Returns PNG patches, window count
  and timings; returns 503 if the cleanup model is unavailable.

Detection uploads from the extension are capped at a 1600px long side, then
response geometry is restored to original-page coordinates. The separate cleanup
request currently sends the page and mask at matching full dimensions; it does not
share that cap. See the [Cloud guide](../docs/cloud-and-security.md) for the wire
contracts, deadlines, security limits and local/Cloud failure distinction.

## Attribution

- KoharuLayout weights: `mayocream/koharu-layout-rfdetr-seg-2xl-1152` — pinned FP32
  export from the project mirror; see [model details and license](../docs/koharu-layout.md).
- CTD weights: `lemondouble/lemon-manga-translator` (upstream
  `dmMaze/comic-text-detector`, GPL-3.0) — downloaded at image build time.
- Baberu weights: `genshiai-daichi/baberu-ocr` (Apache-2.0).
- This server code follows the repo license (GPL-3.0-only, see `LICENSE`).
