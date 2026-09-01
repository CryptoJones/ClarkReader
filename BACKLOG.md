# Backlog

This file and the GitHub **Issues tab** are two views of the same list and must stay
in sync. Every open item below gets a matching GitHub issue when the repo is published.

## Open

- [ ] **Highlight the sentence being read** — _feat_ — the player already knows the active chunk index; map chunks back to Range offsets in the original selection and paint them in the page.
- [ ] **Read-the-whole-article mode** — _feat_ — no selection means fall back to a readability extraction of the main content, so a long page can be read without selecting it by hand.
- [ ] **Chatterbox backend behind the same endpoints** — _feat_ — contained to the `Engine` class; needs the carrier-phrase fix for short chunks before it is usable here (79% misread at one word).
- [ ] **Chunk-level audio cache keyed by text+voice+speed** — _perf_ — re-reading the same paragraph currently re-synthesizes it; jobs are dropped after 64.
- [ ] **Pronunciation overrides** — _feat_ — a user dictionary for names and jargon Kokoro gets wrong, applied in `normalize()`.

## Done

- [x] **Test suites for both halves** — _test_ — 7 extension tests executing the real sources against stubbed WebExtension APIs, 21 server tests over normalization and splitting. Mutation-checked: reintroducing the content-script redeclaration bug and scrambling the Firefox script order each fail exactly one test. Found and fixed a dropped sentence period on "etc.".
- [x] **Firefox build** — _feat_ — shared `ClarkPlayer` runs in Chrome's offscreen document or Firefox's background page, selected by feature detection; two manifests assembled by `build.sh`. `web-ext lint` clean. Not yet exercised in a live Firefox — `web-ext run` could not reach the remote debugging port on this box.
- [x] **v1.0 — selection to speech, end to end** — _feat_ — warm Kokoro server (`/prepare` + `/chunk`) with sentence-level streaming, MV3 extension with context menu, three shortcuts, on-page player, and a settings popup. 92 ms to first audio.

---

*Proudly Made in Nebraska. Go Big Red! 🌽 <https://xkcd.com/2347/>*
