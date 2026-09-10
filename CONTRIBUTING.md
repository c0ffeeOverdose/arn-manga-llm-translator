# Contributing

Thanks for your interest in improving this project.

## Getting set up

```bash
npm install
node build.mjs             # Chromium build → dist/
node build.mjs --firefox   # Firefox build → dist-firefox/
```

## Before you open a PR

Run all three checks — they take seconds:

```bash
npx tsc --noEmit     # typecheck (strict mode)
node --test tests/   # unit tests
node build.mjs && node build.mjs --firefox   # both targets must build
```

PR flow: fork → branch from `main` → one logical change per PR → short
description plus what you verified. Visual changes deserve a screenshot
before/after.

## Reporting a bug

Open an issue with:

- the site and chapter URL, and what you expected vs. what happened
- browser, OS, and whether you used *Vision* or *OCR* text source
- the status pill text at the time of the failure

Enable **Debug mode** (Options → Pipeline) first, then copy the
`[mt] page result` line from the page console into the issue — it makes most
failures diagnosable in one message.

## Ground rules

- **Strict TypeScript, minimal comments** — a comment only earns its place
  when it carries information the code can't (a "why", a proven gotcha, a
  non-obvious constraint). Read neighboring code and mimic its style.
- **No site-specific hacks in the pipeline.** Reader adaptations must be
  generic, named mechanisms, never keyed to a particular site or title.
- **Never commit models, profiles, or keys** — `models/`, `.test-local/`,
  and `eval/` are gitignored on purpose.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you agree to uphold its terms.
