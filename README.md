# arn-manga-llm-translator

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

A zero-server browser extension that machine-translates manga, manhwa and webtoons in your browser.
Original text is detected, read by OCR (or a vision model), translated by an LLM
**you** choose, and rendered back onto the page — everything except the LLM call
runs locally on your machine.

<p align="center">
  <img src="docs/images/hero.png" alt="Arn Manga LLM Translator — read manga, manhwa &amp; webtoons in your language" width="100%">
</p>

- **Source languages:** Japanese, Korean, Chinese and English — into any
  language your LLM can write (Thai rendering is battle-tested, including
  ICU dictionary word breaking and shrink-to-fit text layout).
- **Your keys, your models:** bring your own API key (OpenAI-compatible,
  OpenAI Responses, Anthropic, Gemini, Cloudflare Workers AI). Keys never leave
  your browser's local storage, and page images are sent only to the endpoint
  you configure.
- **All detection and OCR run in-browser** — no server, no telemetry. Works on
  most manga reader sites (image-based and canvas-based readers, including
  single-image readers with off-DOM preloading).

## How it works

1. **Detect** — a comic-text-detector model (ONNX, int8) finds speech bubbles
   and text regions on the page, running in a hidden extension-origin iframe
   (WebGPU with a silent wasm fallback).
2. **Read** — text is extracted either by a vision LLM (no language pack
   needed — it reads whatever text is on the page) or by OCR. The bundled
   Baberu OCR model handles JA/EN/ZH well; Tesseract packs cover Japanese,
   English, Korean, and Chinese (simplified + traditional).
3. **Translate** — regions are sent to your LLM with a shared context window:
   a character book (names, genders, speech styles learned from the chapter)
   and recent translation pairs, so pronouns and tone stay consistent page to
   page. Provider-side prompt caching keeps repeat cost down.
4. **Render** — original text is inpainted over and the translation is laid
   out to fit each bubble, with reading-order aware panel ordering.

Results are cached per page (content-hashed, not URL-keyed), so revisiting a
page is instant and free.

## Install

**Firefox (AMO):** https://addons.mozilla.org/en-US/firefox/addon/arn-manga-llm-translator/
(works on Firefox for Android, 142+)

### From source (any OS)

Prerequisites: Node.js 20+ and a Chromium or Firefox browser.

```bash
git clone https://github.com/c0ffeeOverdose/arn-manga-llm-translator.git
cd arn-manga-llm-translator
npm install
node build.mjs            # Chromium → dist/
node build.mjs --firefox  # Firefox → dist-firefox/
```

Then load it as an unpacked extension:

- **Chrome / Chromium:** `chrome://extensions` → enable Developer mode →
  *Load unpacked* → select `dist/`
- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary
  Add-on* → select any file inside `dist-firefox/`

KoharuLayout is the default on-device layout model. Saved model choices are kept.

Models (~150 MB) download automatically on first use and are cached in
IndexedDB — no bundling, nothing shipped in the repo.

## Quick start

1. Open the extension options → **Model**: pick a provider, paste your API key,
   choose a model, press **Test connection**.
2. Choose **How the model reads text**: *Vision* (send the page image) or
   *OCR* (send recognized text only — cheaper).
3. Open any manga chapter, right-click the page → **Translate this page**.
   Use the popup to enable auto-translate, pre-translation ahead of your
   reading position, memory depth, and fonts.

The popup has **Stop this page**, **Stop all translations**, **Resume auto** and
**Resume chapter translation** controls. Translate to chapter end starts from the page you are
viewing; Re-translate affects the current page. See
[translation controls](docs/translation-controls.md) for scope and settings behavior.

Progress and errors appear in the reader's pill. Enable **Options → Advanced → Debug mode**
to record and view chapter logs, error history, timing reports and model diagnostics.

## Optional: cloud inference

If your machine can't run detection comfortably (older laptops, phones), the
extension can send pages to an endpoint you run yourself. Two generated
notebooks cover the options:

- **Run it in Colab** (`colab-server.ipynb`) — uses Colab's free T4 GPU
  directly and exposes it through a Cloudflare quick tunnel. Nothing beyond a
  Google sign-in; the URL is new every session and the VM dies after ~90 min
  idle / 12 h, so re-run and paste again when it disconnects.

  [![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/c0ffeeOverdose/arn-manga-llm-translator/blob/main/server/colab-server.ipynb)

- **Deploy to Modal** (`cloud-setup.ipynb`) — one-click deploy of the same
  detection+OCR pipeline to your own Modal account; stable URL. Starter is
  free ($30/month of compute, no card to start) and scales to zero, so the
  first page after a break waits ~1-2 min.

  [![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/c0ffeeOverdose/arn-manga-llm-translator/blob/main/server/cloud-setup.ipynb)

Run all, paste the printed endpoint + key into Options → Model. See
[server/README.md](server/README.md) for details.

## Repository layout

```
src/
  content/      page orchestration: queue, cache, rendering, status UI
  iframe/       ONNX runtime host (extension-origin iframe): CTD + OCR + panel model
  background/   service worker: LLM calls (5 protocols)
  llm/          prompt building, adapters, character book
  options/      settings UI (model, pipeline, character book, fonts)
  popup/        per-site control center
server/         optional cloud inference (run on Colab or deploy to Modal)
scripts/        model export/quantize utilities
tests/          unit tests (node --test)
```

## Development

```bash
npx tsc --noEmit   # typecheck
node --test "tests/**/*.test.mjs" # unit tests
node build.mjs     # build both targets, see above
```

Contribution guidelines: [CONTRIBUTING.md](CONTRIBUTING.md).
Security policy: [SECURITY.md](SECURITY.md).

## License

The extension is licensed under GPL-3.0-only — see [LICENSE](LICENSE). Models,
libraries and fonts keep their own licenses. Attribution and model terms are in
[NOTICE](NOTICE); bundled license texts are in [licenses](licenses/README.md).

## Acknowledgements

- [comic-text-detector](https://github.com/dmMaze/comic-text-detector) — text
  detection (ONNX export via
  [lemon-manga-translator](https://github.com/lemondouble/lemon-manga-translator))
- [KoharuLayout](https://huggingface.co/mayocream/koharu-layout-rfdetr-seg-2xl-1152) —
  layout detection by mayocream (custom model and Manga109 terms)
- [Baberu OCR](https://huggingface.co/genshiai-daichi/baberu-ocr) —
  Japanese/English/Chinese OCR
- [manga-panel-detector-yolo26n](https://huggingface.co/leoxs22/manga-panel-detector-yolo26n) —
  panel detection by Leandro Narosky, trained on Manga109-s (AGPL-3.0)
- [AnimeMangaInpainting](https://huggingface.co/dreMaz/AnimeMangaInpainting) —
  text cleanup by dreMaz, based on [LaMa](https://github.com/advimman/lama)
- [Sriracha](https://fonts.google.com/specimen/Sriracha) —
  default Thai font by Suppakit Chalermlarp; Cadson Demak and Pablo Impallari
- [onnxruntime-web](https://github.com/microsoft/onnxruntime),
  [Tesseract.js](https://github.com/naptha/tesseract.js)
