# addons.mozilla.org listing text

Paste these into the listing form at
https://addons.mozilla.org/developers/addon/3071294/edit. Fields not listed here
(icon, screenshots) come from `extension/icons/128.png` and the PNGs in this directory.

## Name

ClarkReader

## Summary (250 characters max)

Reads selected text, or a whole page, aloud in a natural local voice while showing each word as it is spoken. Needs the free ClarkReader server from GitHub running on your machine; nothing you read leaves it.

## Description

**Requires the free local server from https://github.com/CryptoJones/ClarkReader. Install that first; the extension opens the setup guide after installing.**

Select text on any page and press Alt+R to hear it read in Emma, a natural English voice synthesized on your own computer by Kokoro. As she speaks, the player flashes each word at a fixed point with one letter marked in red, the way speed-reading apps do, but paced by the voice instead of a dial. Select nothing and the whole article is read.

- Read a selection or the entire page. Right-click for both.
- Word window synced to the audio, with a maximized full-tab view (Alt+M).
- Stop partway through a long document and resume later from the same sentence.
- Skip back and forward by sentence, pause and resume, change voice and speed.
- Read EPUBs: a small script in the repository turns one into pages the browser can open.

Privacy: the text you ask to read goes to the server address you configure, which by default is your own machine (127.0.0.1), and audio comes back. The extension stores only your settings and where you stopped in documents. No analytics, no accounts, no other network connections. Once the model is cached the server itself makes no network connections at all.

The server needs Python 3.10 or newer and about 2 GB of disk for the model. It has been tested on Linux; macOS and Windows use the same Python and torch stack but have not been tried yet. It can run on another machine on your network; grant the extension access to that address from the toolbar popup.

## Categories

Other

## Tags

text to speech, read aloud, speed reading, rsvp, accessibility, privacy

## Support

- Support website: https://github.com/CryptoJones/ClarkReader/issues
- Homepage: https://github.com/CryptoJones/ClarkReader

## License

MIT License

## Privacy policy

ClarkReader sends the text you ask it to read to the server address configured in the popup, which by default is your own machine (127.0.0.1), and receives audio and word timings back. It stores, in your browser's extension storage, the voice and speed you chose, whether the word window and maximized view are on, and for documents read whole, the URL and the sentence where you stopped so the read can resume. It collects no usage data, has no analytics, and makes no network connections other than to the server you configured. Nothing is shared with the developer or anyone else. The server is open source at https://github.com/CryptoJones/ClarkReader and, once the model is cached, makes no network connections at all.

## Notes to reviewer

The extension talks only to a local synthesis server the user runs themselves (source in the linked repository). vendor/Readability.js is unmodified Mozilla Readability 0.6.0; the two innerHTML lint warnings are inside it. There is no remote code and no minified code.
