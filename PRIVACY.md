# Privacy Policy — Arn Manga LLM Translator

Last updated: 2026-09-09. Contact: arn-manga@c0ffeeoverdose.com

## The short version

Detection, OCR, and drawing run **on your device**. The only thing that ever
leaves your device is what translation inherently requires: **page images and
text, sent to the AI provider or cloud endpoint _you_ configured, with _your_
key**. There is no developer server, no analytics, no accounts, no ads, and we
(the developers) never see any of your data.

## What runs on-device

- Text detection (CTD model), panel ordering, OCR (Baberu/Tesseract), image
  redrawing, translation cache, character book — all local.
- Model weights (~50 MB) download once from a public mirror and are cached in
  your browser's IndexedDB.

## What leaves your device, and to whom

| Data | Destination | When |
|---|---|---|
| Page image + detected text | The LLM provider **you chose** in Settings (OpenAI / Anthropic / Google / OpenCode Zen / a custom base URL — always with **your** API key) | Only when you translate (manually or auto-translate you enabled) |
| Page image (+ OCR text, if that mode is on) | The cloud endpoint **you pasted** in Settings (optional, off by default) | Only in cloud inference mode |
| Model weight / font / OCR-data files | Public mirrors (`huggingface.co`, `cdn.jsdelivr.net`, `raw.githubusercontent.com`) | One-time downloads, cached locally |
| Chapter ID only (no images, no text) | `api.mangadex.org` | Only on MangaDex, to resolve the manga title for the character book |

Your API keys are stored only in your browser (`chrome.storage.local`) and are
sent only to the provider endpoints above, over HTTPS. Nothing is sold, shared
with advertisers, or used to train models by us — we have no access to it at all.

## Permissions — why each one is needed

- Read page images on manga sites (`https://*/*`): the extension's single
  purpose — it must see manga pages on any reader site to translate them.
- Optional `http://*/*`: plain-http reader sites, allowed per site only when
  you press Allow (localhost/loopback readers are not supported).
- `activeTab` + tab screenshot: fallback pixel source when a site blocks direct
  image download (only after you click Translate).
- `declarativeNetRequest`: attach a `Referer` header so sites that hotlink-guard
  their images load for translation (session-only rule, no blocking/logging).
- `storage`, `contextMenus`: settings/keys and the right-click Translate menu.

## Retention and control

- Translation cache and character book live in your browser; clear them anytime
  (popup → Clear, or options → Advanced).
- Uninstalling the extension removes everything stored locally.

## Changes

If this policy ever changes in a way that affects what leaves your device, the
extension will show you the change in the popup before translating again. The
current version is always at
`https://github.com/c0ffeeOverdose/arn-manga-llm-translator/blob/main/PRIVACY.md`.
