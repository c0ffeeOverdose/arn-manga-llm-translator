# Developer documentation

English | [ภาษาไทย](th/README.md)

Architecture, subsystem references and development workflows for Arn Manga LLM
Translator. For installation and usage, see the [project README](../README.md).

English is the primary edition. Keep the [Thai guides](th/README.md) in sync or mark
them as outdated. Keep technical identifiers, commands and examples unchanged in translations.

## Reading order

| Guide | What it explains |
| --- | --- |
| 1. [Architecture](architecture.md) | Components, responsibilities, execution contexts and communication boundaries |
| 2. [Translation pipeline](translation-pipeline.md) | A page from user intent to readable output, including cache hits and cancellation |
| 3. [Reader integration](reader-integration.md) | Finding and reading img/canvas pages, preserving originals, DOM churn and Auto |
| 4. [Chapter translation](chapter-translation.md) | Discovery, broker/runner, rolling slots, merged requests, Stop/Resume and reader attachment |
| 5. [Inference and model lifecycle](inference.md) | Koharu/CTD, panels, OCR, cleanup, WebGPU/WASM and model storage |
| 6. [LLM, prompts and context](llm-and-context.md) | Payloads, provider adapters, retries, the character book and cross-page memory |
| 7. [Rendering and geometry](rendering.md) | Text/balloon/erase boundaries, reading order and Thai text placement |
| 8. [Data, settings and state](data-and-settings.md) | Storage, cache identities, generations, settings snapshots and stale-result guards |
| 9. [Cloud and security boundaries](cloud-and-security.md) | Python API, coordinate mapping, outbound data and security limitations |
| 10. [Development and troubleshooting](development.md) | Setup, build/test/debug workflows and where to start changing each system |

Start with architecture and the pipeline, then choose the relevant subsystem.

## Additional references (English)

- [Translation controls](translation-controls.md): Translate, Stop, Resume and settings scope
- [Translation cache](cache.md): policy, identity verification, transactions and retention
- [CPU and memory ownership](performance.md): bitmap/mask/model-host ownership and measurement limits
- [KoharuLayout](koharu-layout.md): supported artifact, export and installation
- [Model mirror](model-mirror/README.md): runtime weight publishing and attribution
- [Server setup](../server/README.md): running the optional endpoint
- [Contributing](../CONTRIBUTING.md), [Security policy](../SECURITY.md), [Privacy policy](../PRIVACY.md)

## Glossary

| Term | Meaning in this project |
| --- | --- |
| Reader | The website being read, not the extension's options or popup |
| PageRef | A reference to an `<img>` or `<canvas>` that supports pixel input/output |
| Region / box | A text group and its coordinates, not necessarily the entire balloon |
| Text mask | Pixels identified as lettering, not unconditional permission to erase them |
| Panel | A comic frame used for reading order, not a text region |
| Inference host | The extension-origin iframe running local models; despite `worker.ts`, this entry is a document |
| Chapter runner | A document independent of the reader tab, using another inference host when needed |
| Checkpoint | Saved intermediate work, such as detection/OCR, not a completed translation |
| Artifact | A chapter-run result containing a rendered image and data for reader attachment |
| Fold | Incorporating page results into context/book; internal terminology, not user-facing wording |
| Generation / revision | Values establishing whether a recipe, run, page attempt or async result remains authorized |

## Documentation baseline

Source baseline: 2026-10-15 · package 1.2.0 · revision `09dfec1`.

Versions from [package-lock.json](../package-lock.json):

| Dependency | Version |
| --- | --- |
| ONNX Runtime Web | 1.29.0 |
| Tesseract.js / core | 5.1.1 / 5.1.0 |
| TypeScript | 5.9.3 |
| esbuild | 0.24.2 |
| Playwright | 1.62.1 |
| fake-indexeddb | 6.2.5 |

CI uses Node.js 22. Python dependencies in `server/requirements.txt` are partly unpinned.

Diagrams use Mermaid; arrows show data and control flow.

## Maintaining the guides

1. Update the relevant guide and check related defaults, cache recipes and message contracts.
2. Keep implementation details, environment-specific test results and proposals distinct.
3. Keep API keys, real reader names/URLs and real content identifiers out of examples.
    Use `reader.test`, `gallery.example.org` and synthetic data.
4. Update the paired Thai guide and its synchronization date, or mark it as outdated.
   Keep code examples and diagrams aligned.
