# arn-manga server — optional cloud inference for the manga translator

Runs the same detection + OCR the extension runs on-device (CTD + Baberu,
recipes ported 1:1 from `src/iframe/worker.ts`), for phones or older machines
too slow to do it locally. The extension stays zero-server by default — this is
opt-in: run or deploy your own endpoint, paste URL + key into Options → Model.

Both notebooks are generated from these sources by `scripts/make-colab.py` —
don't edit them by hand.

## Run it in Colab (free GPU, Google sign-in only)

Open `colab-server.ipynb` in Google Colab → Runtime → Run all → paste the two
values it prints. The server runs inside the notebook's VM (T4 GPU if the
runtime has one) and is exposed through a Cloudflare quick tunnel. The URL is
new every session, and the VM dies after ~90 minutes without tab activity (12 h
max), so re-run the cells and paste the new URL when Colab disconnects.

Limits: free T4s come from a shared (unpublished) quota and are not guaranteed;
sessions have a hard ~12 h cap; the URL changes every session.

## Deploy to Modal (stable URL)

Open `cloud-setup.ipynb` in Google Colab → Runtime → Run all → paste the two
values it prints. Or from a terminal:

```sh
modal secret create arn-manga-key ARN_API_KEY=<random>
modal deploy modal_app.py
```

Limits: Modal Starter is free — $30/month of compute (~50 T4-hours), no card
needed to start. The endpoint scales to zero when idle, so the first request
after a break waits ~1-2 min (cold start + model load).

## Local run

```sh
pip install -r requirements.txt
MODEL_DIR=/path/to/models uvicorn app:app --port 7860          # no auth
MODEL_DIR=/path/to/models ARN_API_KEY=<random> python serve.py # Bearer auth
```

`serve.py` is the platform-neutral launcher: `ARN_API_KEY` set = auth on
(`/` and `/health` stay open for the extension's Test/warm probe), `PORT`
selects the port. Modal keeps its own wrapper for the same rule.

`MODEL_DIR` needs: `ctd.onnx`, `vision-int4.onnx`, `baberu-prefill.onnx`,
`baberu-step.onnx`, `vocab.json` (see `models_manifest.py` for sources).

## API

- `GET /health` → `{ok, device, panels, ep}` (no auth — liveness only)
- `POST /v1/page?conf_thr=0.35&min_size=12` — raw PNG/JPEG bytes in the body →
  `{ok, w, h, boxes:[{x1,y1,x2,y2,conf}], panels:[], panelSkipped, texts[],
  ms:{body,detect,ocr,total}}`. `texts[i]` belongs to `boxes[i]`; text is raw
  (the client collapses whitespace, same as the local path).

## Attribution

- CTD weights: `lemondouble/lemon-manga-translator` (upstream
  `dmMaze/comic-text-detector`, GPL-3.0) — downloaded at image build time.
- Baberu weights: `genshiai-daichi/baberu-ocr` (Apache-2.0).
- This server code follows the repo license (GPL-3.0-only, see `LICENSE`).
