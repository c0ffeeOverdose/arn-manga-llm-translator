# Security Policy

## Supported Versions

Only the latest release on `main` receives security fixes.

| Version | Supported |
| ------- | --------- |
| latest `main` | ✅ |
| older releases | ❌ |

## Reporting a Vulnerability

Please use GitHub's **private vulnerability reporting**: go to the
repository's *Security* tab → *Report a vulnerability*. This keeps reports
private by default and lets us discuss fixes in a tracked advisory.

Alternatively, email arn-manga@c0ffeeoverdose.com with details and a
reproduction.

Please do not open a public issue for anything exploitable.

## Scope

**In scope:**

- The extension itself: content script, background service worker, the
  extension-origin iframe and its RPC channel, options and popup pages
- The optional cloud server in `server/`

**Out of scope (by design):**

- Page images and text being sent to the LLM or cloud endpoint the user
  configures — that is the feature, not a leak
- Vulnerabilities in third-party models (CTD, Baberu OCR) — report upstream
- Bugs in the browser or the sites being translated

**Please include in your report:** reproduction steps, the extension build
stamp (`[mt] build …` from the page console), browser and OS, and the
impact you see.