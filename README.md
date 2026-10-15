# arn-manga-llm-translator

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

A browser extension that translates manga, manhwa and webtoons onto the original
page using your chosen LLM. Detection, OCR and rendering can run locally.
Optional Cloud inference sends detection, OCR and cleanup to your own endpoint;
no developer-operated backend is required.

<p align="center">
  <img src="docs/images/hero.png" alt="Arn Manga LLM Translator — read manga, manhwa &amp; webtoons in your language" width="100%">
</p>

- **Languages:** Japanese, Korean, Chinese and English into languages supported by
  your LLM. Thai layout includes dictionary word breaking and shrink-to-fit text.
- **Providers:** OpenAI-compatible, OpenAI Responses, Anthropic, Gemini and
  Cloudflare Workers AI. Keys are stored in your browser and sent to the configured
  endpoints for authentication, alongside the images or text needed by each workflow.
- **Readers:** image and canvas layouts, including single-image readers with
  off-DOM preloading. No telemetry.

## How it works

1. **Detect** — KoharuLayout (the local and Cloud default) finds text, sound effects,
   balloons and panels. CTD is an alternative text detector with a separate
   panel model. Local models run in a hidden extension-origin iframe using
   WebGPU where supported, with WASM fallback for layout detection.
2. **Read** — a vision LLM reads image crops, or installed OCR extracts text. The
   Baberu OCR model handles JA/EN/ZH; Tesseract packs cover Japanese,
   English, Korean, and Chinese (simplified + traditional).
3. **Translate** — regions are sent to your LLM with a shared context window:
   a character book (names, genders, speech styles learned from the chapter)
   and recent translation pairs to help maintain pronouns and tone across pages.
   Supported providers can cache repeated prompt prefixes.
4. **Render** — original text is inpainted over and the translation is laid
   out to fit each bubble, with reading-order aware panel ordering.

Compatible translations are cached using page pixels and verified page identity,
so revisiting them avoids another paid translation. Rendering may still require work.

## Install

**Firefox (AMO):** https://addons.mozilla.org/en-US/firefox/addon/arn-manga-llm-translator/
(works on Firefox for Android, 142+)

### From source (any OS)

Prerequisites: Node.js 22 (the CI version), npm and a Chromium or Firefox browser.

```bash
git clone https://github.com/c0ffeeOverdose/arn-manga-llm-translator.git
cd arn-manga-llm-translator
npm ci
node build.mjs            # Chromium → dist/
node build.mjs --firefox  # Firefox → dist-firefox/
```

Then load it as an unpacked extension:

- **Chrome / Chromium:** `chrome://extensions` → enable Developer mode →
  *Load unpacked* → select `dist/`
- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary
  Add-on* → select any file inside `dist-firefox/`

KoharuLayout (~150 MB) downloads on first use and is cached in IndexedDB.
Optional OCR and cleanup models have separate downloads; install OCR files in
Settings before selecting that workflow. Release packages contain no model weights;
development builds can include local files from `models/`.

## Quick start

1. Open the extension options → **Model**: pick a provider, paste your API key,
   choose a model, press **Test connection**.
2. Choose **How the model reads text**: *Vision* (send the page image) or
   *OCR* (send recognized text only).
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

To run inference outside the browser, use one of the generated notebooks:

- **Colab** (`colab-server.ipynb`) runs inference in the notebook's VM through a
  Cloudflare quick tunnel. The URL changes each session; rerun the notebook and
  update the endpoint after disconnection. GPU availability and session limits vary.

  [![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/c0ffeeOverdose/arn-manga-llm-translator/blob/main/server/colab-server.ipynb)

- **Modal** (`cloud-setup.ipynb`) deploys to your Modal account with a stable URL.
  It scales to zero when idle, so the first request after a break includes model
  startup time. Check your account's current compute quota and pricing.

  [![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/c0ffeeOverdose/arn-manga-llm-translator/blob/main/server/cloud-setup.ipynb)

Run all, paste the printed endpoint + key into Options → Model. See
[server/README.md](server/README.md) for details.

## Repository layout

```
src/
  content/      page orchestration: queue, cache, rendering, status UI
  iframe/       ONNX runtime host: Koharu/CTD, panels, OCR and AI cleanup
  background/   LLM transport, privileged RPCs and cache/chapter brokers
  chapter/      independent chapter runner, scheduling, artifacts and context ledger
  cache/        translation policy, image verification, IndexedDB and wire codec
  llm/          prompt building, adapters, character book
  options/      settings UI (model, pipeline, character book, fonts)
  popup/        per-site control center
server/         optional cloud inference (run on Colab or deploy to Modal)
scripts/        model export/quantize utilities
tests/          unit tests (node --test)
docs/           architecture, subsystem guides and focused references
```

## Developer documentation

[English](docs/README.md) | [ภาษาไทย](docs/th/README.md)

Start with [architecture](docs/architecture.md) and the
[translation pipeline](docs/translation-pipeline.md). The index links to subsystem guides.

## Development

```bash
npx tsc --noEmit   # typecheck
node --test "tests/**/*.test.mjs" # unit tests
node build.mjs     # Chromium
node build.mjs --firefox # Firefox
```

Setup, focused tests, build/release boundaries and debugging:
[Development guide](docs/development.md).
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
