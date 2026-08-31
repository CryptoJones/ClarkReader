<p align="center"><em>Proudly Made in Nebraska. Go Big Red! 🌽 <a href="https://xkcd.com/2347/">https://xkcd.com/2347/</a></em></p>

# ClarkReader

Select text anywhere in the browser, press <kbd>Alt</kbd>+<kbd>R</kbd>, and hear it read
back in the Emma voice.

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
                              └──▶ GET /chunk/<job>/1..n  prefetched while 0 plays
```

Two pieces, because the model costs ~7 s to load and ~0.08 s to run:

- **`server/`** — a warm local Kokoro process on `127.0.0.1:8756`. It holds the model in
  memory so a selection never pays the load cost.
- **`extension/`** — a Chrome MV3 extension that captures the selection, asks the server
  for audio a sentence at a time, and plays it with an on-page player.

Splitting into sentences is what makes it feel instant: playback starts after the *first*
sentence is synthesized rather than the last, and the next one is always decoded and
waiting, so there is no gap at the join.

## Install

### 1. The server

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

To keep it warm across reboots, there is a user unit:

```bash
mkdir -p ~/.config/systemd/user
cp server/clarkreader.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now clarkreader
```

### 2. The extension

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select the `extension/` directory

## Use

| | |
|---|---|
| <kbd>Alt</kbd>+<kbd>R</kbd> | read the selection |
| <kbd>Alt</kbd>+<kbd>P</kbd> | pause / resume |
| <kbd>Alt</kbd>+<kbd>S</kbd> | stop |
| right-click a selection | **Read aloud with Emma** |

A small player appears at the bottom right showing the sentence being spoken and the
position in the selection, with skip-back and skip-forward by sentence. The toolbar popup
switches voice and speed, and tells you whether the server is up.

## Why Kokoro here and not Chatterbox

NarratorTool defaults to Chatterbox because it holds a voice steady across thousands of
chunks — over an audiobook, the thing a listener notices is whether chapter nine sounds
like chapter one. That advantage does not apply to reading a selection: every utterance is
independent and nobody hears two of them back to back.

What *does* apply is the rest of the comparison, and it goes the other way:

- **Short selections.** Chatterbox misreads short inputs as entirely different words —
  79% of the time at one word, 51% at two, 33% at three. Selection-reading is full of short
  selections: a term, a heading, a table cell.
- **Latency.** 82M on CPU synthesizes a sentence in ~80 ms. A 0.5B model on the GPU is an
  order of magnitude slower, which is the difference between "instant" and "waiting".
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

## Notes

- The server binds to loopback and has no authentication. It holds nothing secret, but it
  will synthesize speech for anything on this machine that can reach the port.
- Chrome refuses script injection on `chrome://` pages and the Web Store, so the on-page
  player cannot appear there.
- Firefox would need the playback moved out of `offscreen.html`, which is Chrome-only, into
  a background page — the server and the rest of the extension are unchanged.
