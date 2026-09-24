<p align="center"><em>Proudly Made in Nebraska. Go Big Red! 🌽 <a href="https://xkcd.com/2347/">https://xkcd.com/2347/</a></em></p>

# ClarkReader

Select text anywhere in the browser, press <kbd>Alt</kbd>+<kbd>R</kbd>, and hear it read
back in the Emma voice while each word flashes up on screen as she says it. Select
nothing and the whole article is read instead.

Everything is synthesized on this machine by [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M).
No API key, no per-character billing, and nothing you select is sent anywhere — which is
the point when the selection is a private document or an internal wiki.

The voice is `bf_emma` at 0.88, the house narration voice used across the OpenCourseWare
courses and the Math-for-ML video, so a page read aloud sounds like the rest of the catalogue.

## How it fits together

```
selection ──▶ extension ──▶ POST /prepare ──▶ sentence split
                              │
                              ├──▶ GET /chunk/<job>/0 ──▶ plays immediately (~90 ms)
                              ├──▶ GET /words/<job>/0 ──▶ where each word falls in it
                              └──▶ GET /chunk/<job>/1..n  prefetched while 0 plays
```

Two pieces, because the model costs ~7 s to load and ~0.08 s to run:

- **`server/`** — a warm local Kokoro process on `127.0.0.1:8756`. It holds the model in
  memory so a selection never pays the load cost.
- **`extension/`** — an MV3 extension (Chrome and Firefox) that captures the selection,
  asks the server for audio a sentence at a time, and plays it with an on-page player.

Splitting into sentences is what makes it feel instant: playback starts after the *first*
sentence is synthesized rather than the last, and the next one is always decoded and
waiting, so there is no gap at the join.

## Install

Installing from a store gives you the extension only; the server below still has to be
set up once. The extension opens a setup guide on first install, and again from the
popup or from any "cannot reach the server" message.

### 1. The server

One script per platform does the whole setup: it finds a Python Kokoro supports,
builds `.venv`, installs the requirements, builds the extension into `dist/`, and starts
the server at login.

```bash
git clone https://github.com/CryptoJones/ClarkReader.git
cd ClarkReader
./install.sh                     # Linux and macOS
```

`install.sh` uses a systemd user service on Linux and a launchd agent on macOS. Kokoro
installs on Python 3.10 to 3.12 only, so if none is on the machine it offers to install
[uv](https://astral.sh/uv) into `~/.local/bin` to fetch 3.12 (set
`CLARKREADER_INSTALL_UV=y` to say yes without a prompt). It is per-user, needs no root,
and is safe to re-run; `./install.sh --no-autostart` removes the login service.

The rest of this section is what the scripts do, for running it by hand.

`run.sh` reuses [NarratorTool's](https://github.com/CryptoJones/NarratorTool) venv if it is
on the machine, since Kokoro's dependency is torch and there is no reason to install it twice.

```bash
server/run.sh                    # http://127.0.0.1:8756
```

If you would rather it had its own:

```bash
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
server/run.sh
```

Or point it at any Python that has `kokoro`:

```bash
CLARKREADER_PYTHON=/path/to/venv/bin/python server/run.sh
```

Kokoro installs on Python 3.10 to 3.12 only; 3.13 and newer fail to resolve it, so use one
of those for the venv.

On Windows, where `run.sh` cannot run, `install.ps1` is the equivalent:

```powershell
git clone https://github.com/CryptoJones/ClarkReader.git C:\ClarkReader
cd C:\ClarkReader
powershell -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` finds Python 3.12, 3.11 or 3.10 (`py -3` would pick the newest, and Kokoro
does not install on 3.13+), builds `.venv`, installs the requirements, builds the
extension into `dist\` (`build.ps1`, the Windows counterpart of `build.sh`), registers
a scheduled task (`ClarkReaderServer`) that runs the server in the background at login
with no window and restarts it if it crashes, and starts it now. The log is
`%LOCALAPPDATA%\ClarkReader\server.log`. It is per-user, needs no admin rights, and is
safe to re-run; `-NoAutoStart` removes the task. It pins spaCy to 3.8.7 on Windows:
Smart App Control blocks the newer 3.8.16 build's compiled modules. Clone to a short path: PyTorch's file paths are deep, and from a deeply nested
folder the install fails with a "long path" error unless Windows long paths are enabled.
The first start takes a couple of minutes on a CPU, because besides the model it
downloads a small spaCy language model.

To keep it warm across reboots on Linux without `install.sh`, there is a user unit
(edit the `ExecStart` path in it to match where you cloned the repo):

```bash
mkdir -p ~/.config/systemd/user
cp server/clarkreader.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now clarkreader
```

### Hardware and platforms

The server runs Kokoro through PyTorch. If PyTorch can see a CUDA GPU the model goes
there; otherwise it runs on the CPU. Nothing needs configuring. There is no Apple GPU
(MPS) path in Kokoro's pipeline, so on a Mac it runs on the CPU. Measured on an
i7-13700HX with an RTX 4060 Laptop GPU, warm pipeline, `bf_emma`, best of three:

| Sentence | Audio produced | CPU | CUDA |
|---|---|---|---|
| 3 words | 1.9 s | 0.75 s | 0.33 s |
| 12 words | 4.0 s | 2.3 s | 0.61 s |
| 24 words | 7.5 s | 4.1 s | 1.6 s |

Both are faster than real time, and the server synthesizes ahead of playback a sentence
at a time, so a CPU is enough to keep the voice going. The GPU mostly shortens the pause
before the first sentence and after a skip. The model takes about 2 GB of disk.

What has been tested, all on CPU with Python 3.12, using the install scripts above:

| Platform | Server and install script | Extension |
|---|---|---|
| Linux (Ubuntu 26.04 under WSL) | install, systemd service, audio from `/chunk` | not tried in a browser |
| macOS 26, Apple silicon | install (uv fetched Python), launchd agent, audio from `/chunk` | works in Chrome |
| Windows 11 (Smart App Control on) | install, background scheduled task, `/health` | not tried in a browser |

Firefox on macOS and Windows, and other distributions, are untried. Reports welcome.

### 2. The extension

```bash
./build.sh          # -> dist/chrome and dist/firefox
```

The install scripts already ran this. On Windows, to rebuild alone, run
`powershell -ExecutionPolicy Bypass -File build.ps1`. The store zips need `zip`; without
it `build.sh` skips them and the unpacked directories are unaffected.

**Chrome** — `chrome://extensions` → **Developer mode** → **Load unpacked** → `dist/chrome`

**Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
pick `dist/firefox/manifest.json`. Firefox treats MV3 host permissions as opt-in, so the
first time, open the toolbar popup and click **Allow access to the server**.

Firefox keeps a temporary add-on for one session only, and refuses to install the zip
permanently because Mozilla has not signed it. To keep it installed, sign it as an
*unlisted* add-on, which is free, creates no public listing, and comes back within
minutes as an `.xpi` that installs once and stays:

```bash
export WEB_EXT_API_KEY='user:…'      # https://addons.mozilla.org/developers/addon/api/key/
export WEB_EXT_API_SECRET='…'
./sign.sh                            # builds, signs, prints the .xpi path
```

Open the `.xpi` in Firefox to install it. Every version needs signing again, so this
is the release step for Firefox; `./sign.sh --listed` submits to the public listing
instead, taking the license, listing text and reviewer notes from
`store/amo-metadata.json` (Mozilla requires those for a listed version). Listed
versions wait for Mozilla's review, so web-ext stops waiting long before the signed
file exists; the listing page shows the status. The credentials are read from the environment by web-ext and never printed.
The add-on id in the manifest is bound to the first account that signs it, so use the
one you mean to publish under.

The two builds differ only in the manifest. Chrome's background is a service worker with
no DOM, so playback goes in an offscreen document; Firefox's background is an event page
that has one, so the same player class runs directly in it. That is also why nothing here
is an ES module — classic scripts are the one form both background contexts accept without
a bundler.

## Use

| | |
|---|---|
| <kbd>Alt</kbd>+<kbd>R</kbd> | read the selection, or the whole document if nothing is selected |
| <kbd>Alt</kbd>+<kbd>P</kbd> | pause / resume |
| <kbd>Alt</kbd>+<kbd>S</kbd> | stop |
| <kbd>Alt</kbd>+<kbd>M</kbd> | maximize / restore the reader window |
| right-click a selection | **Read aloud with Emma** |
| right-click anywhere | **Read entire document with Emma** |

A small player appears at the bottom right with skip-back and skip-forward by sentence.
The toolbar popup switches voice and speed, and tells you whether the server is up.

### Reading a whole document

With nothing selected, <kbd>Alt</kbd>+<kbd>R</kbd>, the page context menu, or the
popup's **Read entire document** reads the page's main content: the article without
its navigation, sidebars, cookie banners and comment threads. The extraction is
[Mozilla's Readability](https://github.com/mozilla/readability), the library behind
Firefox's Reader View, vendored under `extension/vendor/` (Apache 2.0) and injected on
demand like the overlay. It runs against a clone of the document, so the page is
untouched. The article title is spoken first and shown in the player's header. A page
Readability cannot make sense of falls back to the visible body text, and the text is
capped at a million characters, which is longer than most novels.

A whole document keeps a bookmark. The sentence being read is saved against the page's
URL after every sentence, so stopping partway and coming back later, even after a
restart, picks up where the voice left off: <kbd>Alt</kbd>+<kbd>R</kbd> and the context
menu resume, and the popup offers **Resume reading document · 137 / 400** next to
**Read entire document**, which starts from the top. Finishing the document clears the
bookmark, as does a page whose text has changed since it was set. The last hundred
pages' bookmarks are kept.

Long reads are built not to grow: the server keeps synthesized audio only for the two
sentences behind the one playing plus whatever the player has prefetched ahead, so a
three-hour document costs the same memory as a paragraph (skipping back re-synthesizes
in 80 ms). The player drops decoded audio once it has been played, a page with more
than 40,000 DOM nodes skips Readability's tree walk and takes the visible text as is,
and a sentence that fails to synthesize is skipped rather than ending the read; only
three failures in a row, which means the server is gone, stop it.

PDFs are not read. Chrome's PDF viewer refuses script injection, so there is no way to
reach the text from a content script; that would need the file fetched and parsed by
pdf.js in the extension, which is a separate piece of work.

### EPUBs

Chrome has no EPUB renderer. `tools/read_epub.py` turns one into pages it can open:

```bash
tools/read_epub.py "Mona Lisa Overdrive.epub"      # unpacks next to the file and opens it
tools/read_epub.py book.epub --out ~/Books/mlo --no-open
```

It writes a contents page with the cover and chapter list, adds previous/next links to
each of the book's own chapter files, and builds `book.html` with every chapter in
reading order for **Read entire document** and its bookmark. Standard library only,
so it works wherever the repo was cloned. Chapter titles come from the EPUB 3 nav
document or the EPUB 2 NCX, falling back to each chapter's first heading.

Chrome keeps extensions off local files until told otherwise, once: in
`chrome://extensions`, ClarkReader → **Details** → **Allow access to file URLs**.

### The word window

The player shows the word being spoken, one at a time, at a fixed spot — the way
[Spritz](https://en.wikipedia.org/wiki/Rapid_serial_visual_presentation)-style readers
such as readrrr do it. One letter a little left of centre is red: the *optimal recognition
point*, where the eye lands to take in the whole word without moving. Guide lines above
and below with a tick at that column give the eye somewhere to rest, a progress bar
tracks the selection, and the effective words per minute is shown in the header.

The difference from a speed-reading app is what sets the pace. There is no WPM dial:
the word changes when the voice reaches it. Kokoro reports where each token starts and
ends in the audio it produced, the server merges those into words (gluing `problem` and
`.` back into `problem.`), and the extension hands the list to the overlay with the
playback position and the wall-clock moment that was true. The overlay runs its own
clock from there, so there is no message per word crossing from the player to the tab,
and pausing freezes the word where the voice stopped.

Voices whose G2P reports no timings — anything outside Kokoro's English — get words
spaced across the sentence in proportion to their length instead. The popup can switch
the window off if you only want the audio.

The ⤢ button in the card's header (or <kbd>Alt</kbd>+<kbd>M</kbd>) maximizes the
reader: the card fills the tab, black, with nothing on it but the word, its guide lines,
the progress bar and the controls. RSVP works by holding the eye on one spot, and on a
full screen there is nothing else to look at. <kbd>Esc</kbd> or the button brings the
small card back, and the choice is remembered for the next read.

## Why Kokoro here and not Chatterbox

NarratorTool defaults to Chatterbox because it holds a voice steady across thousands of
chunks — over an audiobook, the thing a listener notices is whether chapter nine sounds
like chapter one. That advantage does not apply to reading a selection: every utterance is
independent and nobody hears two of them back to back.

What *does* apply is the rest of the comparison, and it goes the other way:

- **Short selections.** Chatterbox misreads short inputs as entirely different words —
  79% of the time at one word, 51% at two, 33% at three. Selection-reading is full of short
  selections: a term, a heading, a table cell.
- **Latency.** 82M synthesizes a short sentence in about a third of a second on a laptop
  GPU and under a second on its CPU (measured under **Hardware and platforms**). A 0.5B
  model is an order of magnitude slower, which is the difference between "instant" and
  "waiting".
- **The voice is already Kokoro's.** `bf_emma` is a native Kokoro voice; Chatterbox's
  `house` voice is that same voice cloned from a banked clip. Both roads reach Emma, and
  this is the short one.

The server is a single `Engine` class behind `/prepare` and `/chunk`, so pointing it at
Chatterbox instead is a contained change if a use case ever wants it.

## Text handling

Web selections carry things that sound wrong read aloud, so the server normalizes before
splitting:

- Abbreviations are spoken in full — `Dr.` → "Doctor", `e.g.` → "for example". This is done
  *before* sentence splitting, so `Dr.` cannot end a sentence and `e.g.` cannot collapse to
  "eg" (which reads aloud as "egg").
- `St.` resolves by the word before it: a capitalized proper noun means Street (`Elm St.`),
  otherwise Saint (`St. Louis`).
- Initialisms lose their periods — `A.I.` → `AI` — because Kokoro otherwise pauses between
  the letters.
- Soft hyphens, zero-width characters, smart quotes and PDF line-break hyphenation are
  stripped; they arrive with almost every web selection.

Sentences longer than 320 characters are split again at clauses, since Kokoro's text
encoder tops out around 510 phonemes.

## Tests

```bash
node --test tests/extension.test.mjs                       # extension wiring and the word window
~/Source/repos/NarratorTool/.venv/bin/python -m pytest tests/   # server text handling
```

The extension tests execute the real source files in a sandbox with stubbed
WebExtension APIs, loading them exactly the way each browser's manifest does — Chrome
through `importScripts`, Firefox through ordered background scripts. That is what
catches the failures static checks miss: a name that resolves in one browser and not
the other, and the re-declaration error a re-injected content script throws on the
*second* read rather than the first. The overlay is exercised the same way: a progress
report stamped a second in the past must land on the word the voice is on by now, and
a paused one must stay put.

## Permissions

Everything the extension asks for, and why. This is also the text on the store listing.

| Permission | Used for |
|---|---|
| `activeTab`, `scripting` | reading the selection out of the page you invoked it on, injecting the player overlay and, for a whole-document read, the Readability extractor. Only on the tab you acted on, only when you act. |
| `contextMenus` | the two right-click items. |
| `storage` | voice, speed, the word-window and maximize preferences (synced), and bookmarks for documents read whole (local). |
| `offscreen` (Chrome) | a service worker cannot play audio; the player runs in an offscreen document. |
| `http://127.0.0.1:8756/*` | the local synthesis server. |
| optional `http://*/*`, `https://*/*` | a server on another machine, granted only for the one address you type into the popup, and only when you click **Allow access to the server**. |

No remote code: everything that runs ships in the package, Readability included.

## Privacy

ClarkReader sends the text you ask it to read to the server address configured in the
popup, which by default is your own machine (`127.0.0.1`), and receives audio and word
timings back. It stores, in your browser's extension storage, the voice and speed you
chose, whether the word window and maximized view are on, and for documents read whole,
the URL and the sentence where you stopped so the read can resume. It collects no
usage data, has no analytics, and makes no network connections other than to the
server you configured. Nothing is shared with the developer or anyone else. The server
is open source in this repository and, once the model is cached, makes no network
connections at all.

## Notes

- The server binds to loopback and has no authentication. It holds nothing secret, but it
  will synthesize speech for anything on this machine that can reach the port. It answers
  cross-origin requests only from extension origins (`chrome-extension://`,
  `moz-extension://`), so a web page cannot drive it from inside the browser.
- Once the model and the chosen voice are in the Hugging Face cache, the server sets
  `HF_HUB_OFFLINE=1` for itself and makes no network calls at all — not even the hub's
  update check. A first run still downloads the weights.
- Browsers refuse script injection on their own internal pages (`chrome://`, `about:`) and
  on extension galleries, so the on-page player cannot appear there. Reading still works.
- The Firefox build sets a floor of Firefox 142, which is where
  `data_collection_permissions` landed. It declares `"none"`, which is accurate: nothing is
  collected and nothing is transmitted.
