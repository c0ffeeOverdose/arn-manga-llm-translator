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
python -m pip install modal==1.5.5
modal deploy modal_app.py
modal workspace proxy-tokens create
```

Run these commands from `server/`. Paste the combined `wk-….ws-…` value from the
printed Authorization header into the extension's existing API key field, without
the `Bearer ` prefix. Do not use the `ak-`/`as-` deployment login credentials.
On workspaces with RBAC, allow the token in the deployment environment:
`modal workspace proxy-tokens allow wk-<token-id> <environment>`.
Without RBAC tokens are workspace-wide and `allow` reports `Token is not
environment-scoped` — nothing else is needed. The notebook handles both cases
automatically. Modal shows a token secret only once; if it is lost, delete that
token and create another.

Every path, including `/` and `/health`, requires [Modal proxy authentication](https://modal.com/docs/guide/webhook-proxy-auth)
before reaching the GPU function. There is no separate `ARN_API_KEY` secret on
Modal. The extension uses the same single Bearer key for Test, warm, detection
and cleanup; standalone/Colab keys still work with those deployments.

The endpoint scales to zero when idle; the first authorized request after a break
includes model startup time. **Test/prewarm and the notebook's authenticated test
wake the GPU and consume compute even without translating a page.** Reserved
resources during the warm idle window are also billed. At most one GPU container
runs; this limits concurrent allocations, not total spending. Check your account's
current compute quota and pricing. Do not attach an unauthenticated uptime monitor
to the GPU endpoint.

### Updating an existing Modal deployment

Redeploy the updated server and replace the old random `ARN_API_KEY` in the
extension with a Proxy Token. Updating only the extension does not protect an
already-deployed endpoint. The old `arn-manga-key` secret is no longer used.

Notebook reruns create new Proxy Tokens; previously created Proxy Tokens remain
valid until deleted in Modal Settings → Proxy Auth Tokens, or with
`modal workspace proxy-tokens delete wk-<token-id>`. Stop an exposed deployment
while migrating. Stopping/redeploying the app does not revoke Proxy Tokens.
Tokens can access other protected apps in their workspace (or allowed environments
with RBAC), so keep them private and remove unused tokens.

## Local run

```sh
pip install -r requirements.txt
MODEL_DIR=/path/to/models uvicorn app:app --port 7860          # no auth
MODEL_DIR=/path/to/models ARN_API_KEY=<random> python serve.py # Bearer auth
```

`serve.py` is the platform-neutral launcher: `ARN_API_KEY` set = auth on
(`/` and `/health` stay open for the extension's Test/warm probe), `PORT`
selects the port. Modal instead protects every path at its proxy.
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

- `GET /health` → `{ok, device, layoutModel, layoutModels, layoutRecipe, modelSha256, panels, ep, splitGen}` (Koharu/OCR readiness,
  not proof that the optional cleanup model is loaded). Modal requires proxy auth;
  standalone/Colab health is public and does not validate the key.
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
