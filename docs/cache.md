# Translation cache

[Documentation index](README.md) · [Data and settings](data-and-settings.md) · [ภาษาไทย](th/data-and-settings.md)

Normal Translate reuses a saved result for the same source and translation settings.
Retranslate explicitly requests new detection and a new answer. Loading a reader alone
does not authorize translation or reveal cached pages; automatic translation and chapter
commands retain their own scope.

## Boundaries

| Module | Responsibility |
| --- | --- |
| `src/cache/policy.ts` | Cache types, keys, recipe fingerprint, compatibility, masks and proportional geometry |
| `src/cache/identity.ts` | Verify a candidate page against original pixels and text-region samples |
| `src/cache/store.ts` | IndexedDB transactions, logical page counts, eviction and size limits |
| `src/cache/wire.ts` | Portable binary serialization for Chromium and Firefox runtime messages |
| `src/background/cache-broker.ts` | Reader access to the shared store, scoped to the sender's chapter |
| `src/cache-generation.ts` | Reject work started before a system-wide clear |
| Content/chapter producers | Supply original pixels, captured settings and generation; render or translate the selected result |

`src/content/page-cache.ts` re-exports these APIs for existing callers. Its remaining
reader, queue and scheduling helpers are outside the storage implementation.

## Identity and reuse

* `chapter#hash` describes a particular rendition's decoded pixels. Cleanup crops belong here.
* `chapter@pN` locates a chapter page. It is a candidate for reuse, not proof of which image is displayed.

`selectCachedPage` tries the exact-pixel entry first. A slot entry must match the recipe,
carry usable detection data, and pass image verification. New slot rows retain both a page
sample and normalized text-region samples, so similar artwork with changed text is rejected.
Legacy page-only evidence is accepted only at its original dimensions.
An inferred URL slot is saved only for a sole visible page. A spread uses explicit chapter
mapping or separate pixel keys, so two visible pages cannot collapse into one cache group.

Verified proportional renditions reuse the translation and scale boxes, clips, panels and
extra regions together. Their packed masks expand into the live page dimensions. Cleanup
crops from another rendition are dropped; they are generated once for the new pixels and
saved under that rendition's hash. Dimensions alone never authorize a slot hit.

All full-entry consumers share `cacheEntryFresh`/`detFromCacheEntry`. Incomplete outputs,
corrupt masks, wrong dimensions and stale cloud splitting generations fail safely.
Headless resolution returns the actual cached snapshot, avoiding a second lookup that could
lose its row to eviction between reads.

## Recipes and checkpoints

The fingerprint covers detection, OCR, image-input, target-language and prompt settings.
Font, color, text size, cleanup mode, concurrency and cache capacity do not invalidate a cached
translation. The renderer applies current presentation settings when it displays the result.
Dynamic character/context contents do not invalidate previously translated pages as the book
grows. Changing the selected provider/model preserves saved answers; Retranslate
is the explicit command for replacing it.

Detection/OCR checkpoints are recoverable in-flight work. They are read and written even
when translation caching is disabled. A completed job with caching disabled removes its
checkpoint. Checkpoints are never reported as translated pages and never overwrite a full
result with the same recipe and dimensions. An older detection-only checkpoint cannot remove
OCR text from a richer checkpoint.

## Transactions and retention

The extension-origin `mt-cache` database is authoritative for manual and chapter translation.
Content scripts access it through a bounded runtime request; chapter workers access it directly.
The database uses schema version 2:

* `pages` contains the payloads, retaining the version-1 key format.
* `metadata` contains only key, logical page identity, access time, generation, stage and estimated bytes.

Upgrading builds metadata one row at a time and preserves existing payloads. The expanded
recipe fingerprint rejects rows whose original translation settings cannot be established;
those rows are replaced when that page is translated again. A blocked upgrade keeps only one
pending open request and recovers when the old document closes. Failed opens can be retried.

Readers update access time only in metadata. They never write a previously read payload back
over a newer translation. Full results, aliases and metadata writes complete in one transaction;
request success alone is not treated as a committed write. A transaction abort rolls back the
whole batch. Matching write-through results retain already-generated cleanup crops.

Capacity counts **logical completed pages**, grouping the page slot and its rendition aliases.
Eviction removes an entire least-recently-used page group. Checkpoints have a separate allowance
of 200 entries. Payloads also share an estimated 256 MiB storage allowance; the older groups
are removed when this limit is exceeded. This is a disk retention bound, not a guarantee about
browser RAM. Counts and eviction scan small metadata rows, never all image payloads.

Writes remain best effort: the current translation can still be shown, and a failed
transaction must never leave half of its aliases committed. Reader transport failure is an
error rather than a cache miss that would trigger another LLM request. The cache retains no
in-memory collection of page payloads. Decoded originals created by cache arrival and failed
preparation are closed by their owners.

## Transport and clear

The broker derives chapter scope from the browser-attested sender URL. A reader cannot read,
write or delete another chapter's rows. Masks and PNG crops use base64 on the wire because
Chromium runtime messaging uses JSON; raw ArrayBuffers would lose their contents. They are
decoded only for the requested page, and runtime requests have a deadline and bounded retries.

Older reader-origin databases are no longer consulted. Their translations may need a fresh
translation once; the shared store then serves both manual and chapter commands across reloads.
The extension coordinates Clear by persisting a new generation, stopping the chapter runner,
clearing its artifacts and the shared cache, and notifying readers. Each producer retains its
start generation; stale replies cannot repopulate the current cache. Readers opened later also reject old-generation rows.
Original copies, model downloads, credentials and character data remain independent.

## Verification

`tests/cache-store.test.mjs` runs the production store against IndexedDB semantics, including
version-1 upgrade, interleaved reads/writes, late checkpoints, crop preservation, grouped LRU,
checkpoint and byte limits, transaction rollback and generation resets.
`tests/cache-policy.test.mjs` covers source precedence, verified rendition reuse, proportional
geometry, corrupt entries and recipe boundaries. `tests/cache-transport.test.mjs` exercises
separate reader/background contexts through real JSON serialization, including binary crops,
chapter scoping and transport failures. Browser fixtures additionally check provider call counts,
reload/browser-restart behavior, chapter/manual reuse, delayed answers after Clear and rendered pixels.
