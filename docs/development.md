# Development and troubleshooting

English | [ภาษาไทย](th/development.md)

[Index](README.md) · [Previous: Cloud and security](cloud-and-security.md)

## 1. Setup

Use Node.js 22, matching [CI](../.github/workflows/ci.yml), and npm. The project
uses strict TypeScript, ESM and 4-space indentation. See [Contributing](../CONTRIBUTING.md)
and read `LESSONS.md` before changing a subsystem.

```bash
npm ci
node build.mjs
node build.mjs --firefox
```

`npm ci` installs from the committed lockfile. `models/` is untracked; missing local
weights may produce build warnings without failing. Cloud-only workflows do not need them.

Load the build:

- Chromium: `chrome://extensions` → Developer mode → Load unpacked → `dist/`.
- Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → manifest in `dist-firefox/`.

After rebuilding, reload the extension and reader, then confirm the `[mt] build` stamp.

## 2. Build graph

| Entry | Output / format |
| --- | --- |
| `src/content/content.ts` | `content.js`, IIFE/classic script |
| `src/background/background.ts` | `background.js`, ESM |
| `src/iframe/worker.ts` | `iframe/iframe-worker.js`, ESM; ORT unbundled |
| `src/chapter/page.ts` | `chapter/page.js`, ESM; classic shim first |
| `src/options/options.ts` | `options/options.js`, ESM |
| `src/popup/popup.ts` | `popup/popup.js`, ESM |

[build.mjs](../build.mjs) cleans its target, copies HTML/icons/fonts/notices and
packaged ORT/Tesseract assets, plus optional dev weights. Chromium and Firefox
require separate commands; `node build.mjs` alone does not build both.

`npm run watch` / `--watch` does a one-shot build with inline sourcemaps
in configured bundles, not a watcher. Rebuild explicitly after edits.

Firefox derives its manifest from `src/manifest.json`, replacing service worker
configuration with event-page scripts. Build minimums are desktop 140 and Android
142; esbuild targets `chrome120`. Runtime API and model support must be checked separately.

## 3. Verification commands

```bash
# Required code checks
npx tsc --noEmit
npm test
node build.mjs
node build.mjs --firefox

# Focused examples
node --test "tests/cache-*.test.mjs"
node --test "tests/chapter-*.test.mjs"
node --test "tests/render*.test.mjs"

# Optional Python subsystem checks: requires its Python dependencies
python3 -m unittest discover -s server -p 'test_*.py'
```

Quote globs as the package script does, letting Node 22 expand them. Put Node
options **before the glob** when bounding concurrency:

```bash
node --test --test-concurrency=1 "tests/**/*.test.mjs"
```

CI order is typecheck → Node tests → Chromium build → Firefox build → addons-linter 10:

```bash
npx --yes addons-linter@10 dist-firefox/ --self-hosted
```

This may download the linter if unavailable locally. Large dev ONNX files can
exceed scanner limits: lint an isolated model-free copy of the same code/assets,
or a separately staged release package. Do not delete weights from an active dev
build merely to make lint succeed.

Unit tests use fake IndexedDB/inference fixtures. Check browser APIs, model execution
and visible output in a browser.

## 4. Where to start changing a subsystem

| Task | Starting point | Follow through |
| --- | --- | --- |
| Wrong Translate/Stop target | `content/commands.ts` | Viewport, chapter ownership, popup state |
| Image/original unavailable | `content/page-io.ts` | Source precedence, blob/canvas, picture srcsets, screenshot permission |
| Auto exceeds scope | `content/auto.ts`, `auto-window.ts` | Reading window, queued Auto, lookahead cancellation |
| Chapter stalls/skips | `chapter/page.ts`, `content/sweep.ts` | Setup readiness, slots, leases, discovery, attachment |
| Session/tab ownership conflict | `background/chapter-broker.ts` | Active binding, serialized lifecycle, late publications |
| New model/recipe | `iframe/worker.ts`, `layout-model.ts` | Preprocessing, outputs, locks, storage, fingerprint |
| New prompt/provider | `llm/core.ts`, `adapters.ts` | Mapping, retries, parser, usage, settings UI |
| Inconsistent names/pronouns | `llm/core.ts`, `chapter/context.ts` | Scope, snapshot, contribution replacement, user edits |
| Wrong erasure/placement | `render.ts`, `balloon-surface.ts`, `model-balloon.ts`, `inpaint.ts` | Separate erase/layout geometry and generations |
| Cache misses/duplicate charges | `cache/policy.ts`, `identity.ts`, `store.ts`, `wire.ts` | Evidence, fingerprint/dimensions/generation, transactions/transport |
| Settings differ from saved values | `options/model.ts`, `pipeline-section.ts`, `content/state.ts` | Draft/save, migration, async revisions, chapter stale state |

## 5. Debugging

Enable Settings → Advanced → Troubleshooting → Debug mode. Normal operation still
shows progress/errors; detailed logs/timing/model diagnostics are recorded/displayed
only with Debug enabled. Enabling it mid-run cannot reconstruct earlier unrecorded events.

### Confirm build and execution context

1. Check content `[mt] build`, loaded extension manifest and target.
2. Separate reader, background, inference-document and runner consoles.
3. Chromium offscreen documents are not normal Playwright pages or `context.pages()` entries.
4. Read chapter logs from popup/extension IDB when the runner console is unavailable.
5. Use `#mt-ui-text` for pill text; its state comes from the activity registry.

### Identify the slow stage

[page-timing.ts](../src/page-timing.ts) separates read/cache/detect/OCR/payload/LLM/
cleanup/render/encode/display. `[mt] page result` includes effective provider,
layouts, boxes, cache reason and generation. Total elapsed time containing lock
wait/network/encoding is not isolated model execution time.

Chapter logs distinguish caller/background/server receipts. “Sent, not received”
suggests a different path than “HTTP started, no reply”. Inspect **request caps**
and **caller waits** together.

## 6. Troubleshooting by symptom

| Symptom | Check |
| --- | --- |
| 0/N, no inflight work | Runner setup/ready checkpoint and storage bridge |
| Done, original still visible | Artifact existence and attachment identity/signature/revision |
| Every page RPC times out | Iframe lifecycle and bounded GPU response probe |
| WebGPU API exists, execution slow | Effective EP, adapter, canvas pixel round-trip |
| Cache hit remains expensive | Source verification, fonts, cleanup, paint/PNG/display |
| Revisits send new LLM requests | Hash/fingerprint/dimensions/splitgen/identity, broker transport |
| HTTP 200, no translation | Raw length, finish reason, usage/reasoning, parse result |
| Some regions unchanged | keep/missing/unsafe placement, actual glyph fit |
| Firefox settings save fails | Click-task permission request and port-free host pattern |
| High RSS after completion | Sessions, decoded originals, native/GPU allocations and idle deltas |

The GPU probe treats a null/rejected adapter as a response. Only bounded
non-response after an inference timeout becomes a shared GPU fault. Devices without
WebGPU must not be misclassified as browser-wide hangs.

## 7. Browser and E2E tests

- Use isolated profiles and synthetic routed fixtures, not the owner's reading session.
- Chapter E2E must use mocks, never paid real-provider requests.
- Confirm the running build/manifest; clear stale extension targets when reloading.
- Exercise relevant manual, Auto, chapter and cache-hit paths separately.
- Check Stop during setup, OCR, LLM wait, merged fallback and before attachment as applicable.
- Reader reload, SPA chapter change, tab handoff/closure and rendition changes are distinct cases.
- Wait for actual image attachment/decoding before screenshots, not just completion status.
- Do not compete for the owner's GPU with heavy real-model fixtures during their chapter run.

`eval/` and `.test-local/` are ignored local tooling/artifacts, potentially absent
from public checkouts. Unit tests do not require every local harness. Follow local
harness rules when present; never commit profiles/keys/models.

Benchmarks must distinguish cold/warm, headed/headless, effective provider, source
pixels and recipe. Desktop results do not establish phone latency/VRAM. A correct
GPU vendor does not prove correct canvas pixels. Read [Performance](performance.md)
before using process RSS as an acceptance criterion.

## 8. Release packaging

```bash
node build.mjs --release
node build.mjs --release --firefox
```

These commands create or overwrite release archives.

- Package version must match `v<version>`.
- Release marker is version+commit without a clock.
- Development ONNX weights are omitted.
- Fixed mtimes and `zip -X` support byte-identical archives.
- CI builds twice and compares SHA-256 before attaching artifacts.
- Do not upload moving-version development builds to stores.

The source manifest's literal version initializes the build process; it is not
necessarily the release version.
