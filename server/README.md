# arn-manga server — optional cloud inference for the manga translator

Runs the same detection + OCR the extension runs on-device (CTD + Baberu,
recipes ported 1:1 from `src/iframe/worker.ts`) on a Modal T4 GPU, for phones
too slow to do it locally. The extension stays zero-server by default —
this is opt-in: deploy your own endpoint, paste URL + key into Options → Model.

## Normal-user setup (browser only, no terminal)

Open `cloud-setup.ipynb` in Google Colab → Runtime → Run all → paste the two
values it prints. (The notebook is generated from these sources by
`scripts/make-colab.py` — don't edit it by hand.)

## Deploy from terminal

```sh
modal secret create arn-manga-key ARN_API_KEY=<random>
modal deploy modal_app.py
```

## Local run

```sh
pip install -r requirements.txt
MODEL_DIR=/path/to/models uvicorn app:app --port 7860
curl -s -X POST --data-binary @page.jpg "http://localhost:7860/v1/page" | head -c 400
```

`MODEL_DIR` needs: `ctd.onnx`, `vision-int4.onnx`, `baberu-prefill.onnx`,
`baberu-step.onnx`, `vocab.json` (see `modal_app.py` for sources).
Local run has no auth; the Modal deploy adds Bearer auth (`ARN_API_KEY`).

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
