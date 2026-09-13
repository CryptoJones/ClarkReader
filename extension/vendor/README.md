# Vendored: Mozilla Readability 0.6.0

`Readability.js` is [mozilla/readability](https://github.com/mozilla/readability)
0.6.0 (`LICENSE.readability` is its Apache 2.0 license), with two local changes.
Both are recorded in `Readability.clarkreader.patch` so they can be reapplied to a
newer upstream copy with `patch -p1 < Readability.clarkreader.patch` from this directory.

Upstream assigns `innerHTML` in two places. Mozilla's `no-unsanitized` lint rule, which
`web-ext lint` and the addons.mozilla.org review pipeline enforce, flags both as
`UNSAFE_VAR_ASSIGNMENT`. Upstream silences the rule with eslint comments because the
markup comes from the document itself; a store submission cannot, so the assignments
are replaced with equivalents that build DOM nodes instead:

1. **`_grabArticle` retry cache.** The page body was saved as an HTML string and
   restored with `innerHTML` before each retry with different flags. It is now saved
   as a deep clone (`cloneNode(true)`) and restored by moving a fresh clone's children
   back into the page.
2. **`_unwrapNoscriptImages`.** The markup inside a `<noscript>` was parsed by
   assigning it to a scratch `<div>`'s `innerHTML`. It is now parsed with `DOMParser`,
   whose document is inert (scripts do not run, nothing is fetched), and the resulting
   nodes are adopted into the scratch `<div>`.

Both changes were checked against the unpatched file on the same inputs: identical
`title`, `content`, `textContent` and `excerpt`, including on a page that forces the
retry path and one whose `<noscript>` holds a lazy-loaded image.

The clone-based restore assumes a real DOM (`cloneNode`), as the extension always has.
Firefox's internal JSDOMParser path in this file is untouched but no longer exercised
by the restore.
