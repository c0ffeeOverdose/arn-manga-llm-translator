# CPU and memory ownership

Translation caching avoids repeated detection, OCR and paid translation when a compatible
result exists. Painting, current font/layout settings, source verification and PNG encoding
still require work. A cache storage limit bounds saved payloads on disk; it does not bound
decoded images, model sessions or the browser's GPU/WASM allocations.

## Resource contracts

| Resource | Owner and release boundary |
| --- | --- |
| Prepared source bitmap | Queue job; closes after translation/paint, failure or cancellation, including preparation that settles later |
| Prepared source borrowed by a seam | Borrower retains the job until the seam finishes; cancellation cannot invalidate a borrowed image |
| Fetched seam source and stitched bitmap | Seam attempt; closes on success, fallback or error |
| Worker input/tile bitmap | Individual detection, panel, OCR or cleanup call; closes after its last pixel read even on failure |
| Decoded cleanup patch | Paint operation; disposes its image/bitmap and object URL in `finally`; batch failures also dispose late successes |
| Temporary synchronous PNG canvas | Encoder; zeroes owned canvas dimensions after success or error, preserving caller-owned canvases |
| Inpaint page readback | One mutable `ImageData`; no second full-page RGBA copy |
| Retained page mask | Exact binary pixels packed into bits; expands only for seam stitching, debug views or chapter seeds, without retaining the expanded copy |
| Inference iframe | Created on demand; released after 60 seconds without work, or when a chapter drains; setup, encoding and active RPCs retain it |
| Inference/fetch deadlines | Cleared when requests settle; timed-out inference destroys its computing context and rejects sibling requests |

Ownership is independent of cache invalidation and model generation. These changes preserve
pixel recipes, thresholds, model inputs, output order and current rendering settings.

## Why a page can be expensive

A 2,000 × 3,000 RGBA image occupies 24 MB before browser overhead. A full-resolution
float probability field and an int32 component label map each occupy another 24 MB;
byte masks and visited maps each occupy 6 MB. Detection, cleanup and painting have different
working buffers, in addition to decoded sources and model sessions. Several prepared pages
can coexist in a merged chapter request. The cleanup path now avoids one additional 24 MB
RGBA allocation for that example size.

Retained binary masks for 36 pages of that size take 27 MB instead of 216 MB. This is a
lossless in-memory representation, separate from the existing sampled disk-cache mask.
Non-binary masks keep an exact raw copy. Translation, clips and cleanup geometry are unchanged.

Cloud readers and cache-only reads no longer create a local ORT iframe during startup.
After local inference is idle, the iframe is removed, including its model runtime. The next
local request recreates it from the normal model cache; completed translations stay available.
This can add model startup time after a long pause. Removing an iframe does not guarantee that
Chromium immediately returns every native allocation to the OS; process RSS must be measured.

WebGPU does not remove CPU work: decoding, model preparation, mask processing, layout and
encoding still run locally. Check the effective worker engine before diagnosing a fallback.
Measure current CPU deltas; lifetime `%CPU` and process RSS alone do not establish a busy loop
or a leak. Compare repeated identical work after warmup, observe retained resources after
completion, and keep JS heap, external storage, process RSS and GPU allocations distinct.

## Verification and limits

`tests/prepared-job.test.mjs`, `tests/paint-patches.test.mjs`, `tests/worker-resources.test.mjs`
and `tests/encode.test.mjs` exercise production ownership code with failures, cancellation,
late completion, borrowed inputs and bitmap fallbacks. Worker tests execute the actual worker
function bodies with small inference fixtures so they do not load models during unit tests.
`tests/inference-host.test.mjs` exercises concurrent startup, stale readiness, encoding leases,
idle recreation and timeouts through the production detection client. Retained-mask tests
check pixel equality, independent ownership, non-binary fallback and full-size storage bounds.

The local `eval/resource-lifecycle.mjs` fixture uses an isolated profile, bundled CTD and the
real NVIDIA adapter, blocking HTTP(S). It checks decoded input/tile image counts and samples
memory after repeated serial detection, including a tiled strip. Its results do not cover
long chapter sessions, Baberu/cleanup model residency or every browser backend.

The local HTTPS Cloud fixture translates 36 synthetic 1200×1600 pages, then scrolls through
all of them. It verifies no local inference iframe and no added calls on revisits; a cached
chapter rerun also adds no detection, translation or cleanup calls. One diagnostic replay
measured reader RSS of 744 MiB after all pages attached, 704 MiB after JS GC, and 195 MiB after
an explicit critical memory-pressure notification. JS backing storage remained about 13 MiB.
The forced notification demonstrates reclaimable native/browser-cache memory; 195 MiB is
not a natural-idle result or a phone memory claim.

Further reductions should be measured separately: admission limits based on decoded page
bytes and eviction of inactive reader states. The existing parallel/group settings still
bound counts rather than bytes; this is not a hard total-RAM budget. A desktop Cloud fixture
also cannot establish a phone's decoded-image cache behavior or memory ceiling.
