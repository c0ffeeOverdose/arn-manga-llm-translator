# Contributing

## Getting set up

```bash
npm ci
node build.mjs             # Chromium build → dist/
node build.mjs --firefox   # Firefox build → dist-firefox/
```

## Before you open a PR

Use Node.js 22, as CI does. Run typecheck, tests and both build targets:

```bash
npx tsc --noEmit     # typecheck (strict mode)
node --test "tests/**/*.test.mjs"   # unit tests (keep the glob quoted)
node build.mjs && node build.mjs --firefox   # both targets must build
```

Fork and branch from `main`. Keep each PR to one logical change and describe what
you verified. Include before/after screenshots for visual changes.

## Understanding the code

Start with the [developer documentation index](docs/README.md), then
[architecture](docs/architecture.md) and the [page pipeline](docs/translation-pipeline.md).
See the [development guide](docs/development.md) for tests, debugging and release
packaging. Update the relevant guide when changing a workflow, contract or setting.

English under `docs/` is primary. Update the paired [Thai guide](docs/th/README.md)
and its translation date, or mark it as outdated. Keep examples and diagrams aligned.

## Reporting a bug

Open an issue with:

- the site and chapter URL, and what you expected vs. what happened
- browser, OS, and whether you used *Vision* or *OCR* text source
- the status pill text at the time of the failure

Enable **Debug mode** (Options → Pipeline) first, then copy the
`[mt] page result` line from the page console into the issue.

## Ground rules

- Use strict TypeScript and match the surrounding style. Keep comments to short
  contracts or constraints; keep incident histories in `LESSONS.md`.
- **No site-specific hacks in the pipeline.** Reader adaptations must be
  generic, named mechanisms, never keyed to a particular site or title.
- **Never commit models, profiles, or keys** — `models/`, `.test-local/`,
  and `eval/` are gitignored on purpose.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you agree to uphold its terms.
