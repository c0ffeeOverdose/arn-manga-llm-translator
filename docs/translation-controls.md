# Translation controls

**Translate this page** translates the visible page or spread. During processing it becomes
**Stop this page**; a queued page shows **Cancel this page**. The context menu targets the
image you clicked, while the popup follows your current reading position.

**Stop all translations** stops active work, removes queued work and pauses Auto in this tab.
Translations that already finished remain available. **Resume auto**, or a new Translate
command, releases the pause. Re-translate preserves a user-paused Auto loop.

**Translate to chapter end** starts from the page you are viewing. After stopping a run,
you can move to another page and use this button to choose a new starting point. Completed
translations remain available and are reused when available in the reader or cache.
**Resume chapter translation** is a separate button that continues the remaining pages of the
stopped run, including pages you cancelled individually.

For example, after starting at page 10 and stopping, go to page 3 and press **Translate to
chapter end** to translate page 3 onward. **Resume chapter translation** instead continues the
unfinished part of the run that began at page 10.

One chapter translation can run at a time. Starting one in another tab pauses the
previous chapter. Return to that tab and select **Translate to chapter end** to continue.

**Re-translate page** replaces the current page's translation. After a stopped chapter run it
processes just that page and leaves the remaining chapter paused. Re-translate during an
active chapter does not cancel the other pages you already requested.

Auto translates the visible spread plus the extra pages chosen with
**Pages ahead**.
Finishing those pages does not extend the window; moving forward does. Stop prevents new
requests and discards uncommitted late results. A provider may still finish a request it
already accepted.

The popup's **Context** choice reaches the chapter task and applies to the next work set.
Requests already started retain their captured context. Changing Pages ahead, cache size or
notifications leaves chapter work running. Changes that affect translation pause the run on
both Chrome and Firefox; starting chapter translation again uses the new settings.

Quality presets retain language, tone, selected font, OCR workflow, reading direction,
cleanup, batching and cache preferences. Font deletion updates only a deleted saved font
selection. Other edited settings remain drafts until **Save changes**, and **Discard changes**
restores their saved values.

Translation progress and errors appear in the reader's pill. The normal popup keeps the
translation controls and optional token usage; status details, recent errors, chapter logs
and timing reports appear only with **Debug mode** enabled in **Settings → Advanced → Troubleshooting**.
Model diagnostics in About also require Debug mode.

Chapter logs, error history and timing reports are recorded only while Debug is on.
Turning it off stops recording and hides the diagnostic tools immediately. Turning it on
during a chapter enables logging for subsequent work; it cannot reconstruct earlier events.
Previously recorded Debug logs remain available the next time Debug is enabled.
