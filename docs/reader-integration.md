# Reader integration and Auto

English | [ภาษาไทย](th/reader-integration.md)

[Index](README.md) · [Previous: Translation pipeline](translation-pipeline.md) · [Next: Chapter translation](chapter-translation.md)

## 1. Page types

The extension supports image columns, horizontal spreads, single-image page turns,
virtualized canvases, lazy loading and blob URLs. Reader adaptations detect these
mechanisms rather than matching a hardcoded list of sites.

[PageRef](../src/content/state.ts) has only two variants:

```ts
type PageRef =
    | { kind: 'img'; el: HTMLImageElement }
    | { kind: 'canvas'; el: HTMLCanvasElement; key: string; pageSrc?: string };
```

Canvas `pageSrc` identifies an original source found in a manifest, if available.
`key` identifies a canvas that does not have an image URL.

## 2. Finding page candidates

`getPages` in [page-io.ts](../src/content/page-io.ts) filters by suitable image
dimensions/context and excludes UI/declared skip elements. Not every `<img>` is a
comic page. Current-page selection uses viewport overlap, not DOM order alone.

Chapter/off-DOM prefetch can use additional evidence:

| Source | Applicable when | Limitation |
| --- | --- | --- |
| Episode/canvas manifest | Reader declares image order | Some slots may still lack sources/pixels |
| Paged chapter API | API supplies the chapter file list | Preserve order and per-page alternate encodings |
| Embedded gallery manifest | DOM holds only the current page | Anchor must match the viewed image |
| Hash-file manifest plus routing data | Images use CDN shards/builds | Parse data, never execute remote script |
| DOM and lazy-image attributes | No usable manifest | Does not establish that the entire chapter is known |
| Same-chapter document discovery | Pagination exposes more documents | Stay inside origin/chapter; stop on repetition/end |

Helpers live in [page-cache.ts](../src/content/page-cache.ts) and
[chapter/discovery.ts](../src/chapter/discovery.ts). MangaDex has a direct API/host-gated
integration; other adaptations are named for generic mechanisms.

## 3. Reading images: original pixels first

`readPage` is not simply `fetch(img.src)`: `src` may be our translated image or a
revoked blob URL.

### Image readers

1. Use an extension-owned original copy when it matches current state.
2. For an original blob still displayed by the element, try decoding the element;
   decoded pixels may survive URL revocation.
3. Ordinary URLs use `fetchBitmap`: direct fetch → background proxy → bounded
   hotlink retry when applicable.
4. Only then try a screenshot as a last resort with permission and a visible tab.

If the element no longer shows the original blob, do not decode its current pixels
instead. An expired original without a copy must fail with `noScreenshot`, rather
than photographing our translation and feeding it back into OCR.

### Canvas readers

1. Re-translate uses stashed original bytes when identity confirms the same page.
2. A manifest source is fetched and passed through the discontinuity-gated `unscrambleTiles` path.
3. Otherwise read `toDataURL`; a tainted canvas may require screenshot fallback.
4. Uniform/blank placeholders must not create translations or misleading completed cache entries.

`unscrambleTiles` applies a deterministic mapping only when its discontinuity gate
finds improved tile boundaries. It is not a general permutation solver for every reader.

### Screenshot permissions

Screenshots require user-gesture `activeTab` access and a background check that the sender
is the active tab of the captured window. Content must not be hidden, and cropping
accounts for device pixel ratio. A screenshot contains visible pixels, not necessarily
full-resolution source data, and cannot be assumed available to every Auto job.

Inside `readPage`'s try/catch, use `return await fetchBitmap(...)`. A bare `return`
lets a rejected promise bypass the catch that implements screenshot fallback.

## 4. Single-writer image output

`writePage` owns reader write-back:

- img: select translated/original/debug `src` and bind the element to state.
- `<picture>`: stash and clear sibling `<source srcset>` values, or the browser may prefer them over `img.src`.
- Show original: restore srcsets and use an owned original copy when the source blob expired.
- canvas: draw onto the same canvas, guarding before/after async decode against a new page or display choice.

[overlays.ts](../src/content/overlays.ts) replaces pixels inside existing elements.
A periodic sweep reapplies results after reader redraws or element replacements.

## 5. Identity has several levels

| Identity | Question it answers | What it does not establish |
| --- | --- | --- |
| URL/path | Which source the reader declared | CDN/encoding can change; the same URL can return a new image |
| DOM binding | Which state an element previously showed | A virtualizer may recycle it for another page |
| 48×48 content hash | Whether decoded pixels match a rendition | Not a cryptographic proof or chapter page number |
| ImageIdentity / region evidence | Whether a resized/re-encoded image represents the same content | Dimensions alone are insufficient |
| Manifest page order | Logical page position | Does not authorize painting without confirming current pixels |

`pages`, `elStates` and `hashStates` in [state.ts](../src/content/state.ts), together
with [page-identity.ts](../src/content/page-identity.ts), reuse state across URL/node
changes. Verify an unknown source before aliasing; release the old binding when
the reader recycles an element for different content.

Extension-owned originals for blob readers have a pixel-size cap. Returning the
original of an expired giant-strip blob is therefore not guaranteed.

## 6. Auto reading window

[auto.ts](../src/content/auto.ts) considers visible pages and `prefetchN` pages ahead:

1. Check per-site configuration and halt state.
2. Select the visible spread plus lookahead through [auto-window.ts](../src/content/auto-window.ts).
3. Remove queued Auto work outside that window without dropping manual intent.
4. Enqueue untranslated pages not owned by chapter/paint work.
5. Once the mounted window is exhausted, try manifest-based off-DOM lookahead.

The window advances with the reading position, not when translations finish.
Auto yields while a chapter runner is active to avoid duplicate translation requests.

Off-DOM lookahead has no element to paint. Results go to translation cache/context;
the arriving page later takes the cache/arrival-render path. It requires readable
manifest sources rather than scrolling indefinitely on the user's behalf to create DOM.

## 7. Pause, cooldown and stale work

- Disabling Auto drops queued Auto/lookahead work; manual/in-flight page work has its own scope.
- Stop all revokes active/queued work and pauses Auto in that tab without deleting completed pages.
- Auth/429 and shared inference faults halt fan-out pending explicit intent, not a 429 retry loop.
- Page-local failures have cooldown/attempt bounds rather than re-enqueueing every tick.
- Auto drops detached or changed-image jobs before sending a translation request.
- SPA chapter changes reset chapter context and revoke old work; state must not cross into another story.

Consumers use revision/generation guards against late results reviving old UI.
A URL check only at job start is insufficient during OCR/network waits.

## 8. Adding a reader adaptation

1. Identify the different mechanism: manifest, canvas, blob lifecycle, pagination or routing.
2. Add a pure parser/identity rule with synthetic-domain fixtures.
3. Check manual, Auto, chapter discovery and attachment when they share the mechanism.
4. Preserve original-source precedence, `writePage` ownership and chapter boundaries.
5. Do not specialize the pipeline by real site/title or language-specific content rules.

Starting tests: [page-io](../tests/page-io.test.mjs), [image-identity](../tests/image-identity.test.mjs),
[reader-start](../tests/reader-start.test.mjs), [hash-reader-source](../tests/hash-reader-source.test.mjs),
[hash-reader-manifest](../tests/hash-reader-manifest.test.mjs) and [ux-flow](../tests/ux-flow.test.mjs).
