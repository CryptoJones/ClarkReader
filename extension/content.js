// The in-page player overlay.
//
// Injected on demand rather than declared over <all_urls>, so ClarkReader has no
// presence on pages you never ask it to read. executeScript re-runs this file on
// every invocation, hence the idempotence guard.
//
// Besides the transport controls, the card carries an RSVP window (rapid serial
// visual presentation): each word is shown alone, at a fixed spot, with one letter
// in red as the anchor for the eye — the Spritz technique. Here it is driven by the
// audio rather than by a words-per-minute dial: the player reports where each word
// falls in the chunk being spoken and how far in playback is, and a local animation
// loop shows whichever word the voice is on.

if (!window.__clarkReaderInjected) {
  window.__clarkReaderInjected = true;

  // Injected standalone, so it carries its own copy of the namespace shim rather than
  // depending on api.js being loaded alongside it. It has to live INSIDE the guard:
  // executeScript re-runs this file in the same isolated world every time, and a
  // top-level `const` would throw "already been declared" on the second read.
  const api = globalThis.browser ?? globalThis.chrome;

  const HIDE_AFTER_MS = 2500;

  // Everything lives behind a shadow root: the host page cannot restyle the player,
  // and the player cannot leak styles into the page.
  const host = document.createElement("div");
  host.id = "clarkreader-root";
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        position: fixed; right: 20px; bottom: 20px; width: 340px;
        font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
        background: #16181d; color: #e8e8ea;
        border: 1px solid #2c2f36; border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.45);
        padding: 12px 14px; box-sizing: border-box;
        opacity: 0; transform: translateY(8px);
        transition: opacity .18s ease, transform .18s ease;
        pointer-events: none;
      }
      .card.show { opacity: 1; transform: none; pointer-events: auto; }

      /* Maximized: the whole viewport, nothing but the word. RSVP works by holding
         the eye on one spot; on a full screen there is nothing else to look at. */
      .card.max {
        inset: 0; width: auto; right: 0; bottom: 0; border-radius: 0; border: 0;
        background: #0b0b0d; padding: 24px 32px 28px;
        display: flex; flex-direction: column;
      }
      .card.max .head { font-size: 12px; }
      .card.max .rsvp {
        flex: 1; display: flex; flex-direction: column; justify-content: center;
        width: min(100%, 780px); margin: 0 auto;
      }
      .card.max .rsvp[hidden] { display: none; }
      .card.max .guide::after { height: 12px; }
      .card.max .guide.top::after { top: -12px; }
      .card.max .guide.bottom::after { bottom: -12px; }
      .card.max .word {
        height: auto; line-height: 1.25; padding: 28px 0;
        font-size: clamp(44px, 8vw, 112px);
      }
      .card.max .word.long { font-size: clamp(30px, 5.5vw, 72px); }
      .card.max .bar { margin-top: 24px; }
      .card.max .text {
        font-size: 16px; max-height: 48px; text-align: center; -webkit-line-clamp: 2;
        width: min(100%, 780px); margin: 0 auto 18px;
      }
      .card.max .row { width: min(100%, 420px); margin: 0 auto; }
      .head {
        display: flex; align-items: center; gap: 8px;
        font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
        color: #8b90a0; margin-bottom: 8px;
      }
      .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #3ddc84; flex: none; }
      .dot.paused { background: #e2b33c; }
      .dot.error  { background: #e05d5d; }
      .wpm { margin-left: auto; font-variant-numeric: tabular-nums; }
      .wpm:empty { display: none; }
      .wpm:empty + .count { margin-left: auto; }
      .count { font-variant-numeric: tabular-nums; }
      .size {
        flex: none; appearance: none; cursor: pointer; margin-left: 10px;
        background: transparent; color: #8b90a0; border: 0; padding: 0 2px;
        font-size: 14px; line-height: 1; font-family: inherit;
      }
      .size:hover { color: #e8e8ea; background: transparent; }

      /* The RSVP window. Guide lines above and below with a tick at the pivot
         column, the way readrrr and Spritz draw it, so the eye has somewhere to
         rest before the first word arrives. */
      .rsvp { margin: 2px 0 10px; }
      .rsvp[hidden] { display: none; }
      .guide { position: relative; height: 1px; background: #2c2f36; }
      .guide::after {
        content: ""; position: absolute; left: 50%; width: 1px; height: 7px;
        background: #4a4f5c; transform: translateX(-.5px);
      }
      .guide.top::after { top: -7px; }
      .guide.bottom::after { bottom: -7px; }
      .word {
        display: flex; align-items: baseline; height: 58px; overflow: hidden;
        font: 700 30px/58px Georgia, "Times New Roman", Times, serif;
        color: #f4f4f6; white-space: pre;
      }
      .word.long { font-size: 22px; }
      .word .l { flex: 1 1 0; min-width: 0; text-align: right; }
      .word .p { flex: none; color: #ff2d2d; }
      .word .r { flex: 1 1 0; min-width: 0; text-align: left; }
      .word.wide { justify-content: center; }
      .word.wide .l, .word.wide .r { flex: 0 0 auto; }
      .bar { height: 2px; background: #2c2f36; border-radius: 1px; margin-top: 8px; overflow: hidden; }
      .bar > div { height: 100%; width: 0; background: #e8e8ea; transition: width .12s linear; }

      .text {
        min-height: 20px; max-height: 40px; overflow: hidden; font-size: 12px;
        color: #8b90a0; margin-bottom: 10px;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      }
      .text.err { color: #f0a0a0; font-size: 13px; }
      .help { display: none; margin: -4px 0 10px; }
      .help.show { display: block; }
      .help button { width: 100%; }
      .row { display: flex; gap: 6px; align-items: center; }
      button {
        flex: 1; appearance: none; cursor: pointer;
        background: #23262e; color: #e8e8ea;
        border: 1px solid #333741; border-radius: 7px;
        padding: 6px 0; font-size: 13px; line-height: 1;
        font-family: inherit; transition: background .12s ease;
      }
      button:hover { background: #2e323c; }
      button:disabled { opacity: .38; cursor: default; background: #23262e; }
      button.primary { flex: 1.6; background: #2f6fed; border-color: #2f6fed; }
      button.primary:hover { background: #3d7bf5; }
      @media (prefers-reduced-motion: reduce) {
        .card { transition: none; }
        .bar > div { transition: none; }
      }
    </style>
    <div class="card" part="card">
      <div class="head">
        <span class="dot"></span><span class="label">ClarkReader</span>
        <span class="wpm"></span><span class="count"></span>
        <button class="size" title="Maximize (Alt+M)">&#x2922;</button>
      </div>
      <div class="rsvp">
        <div class="guide top"></div>
        <div class="word"><span class="l"></span><span class="p"></span><span class="r"></span></div>
        <div class="guide bottom"></div>
        <div class="bar"><div></div></div>
      </div>
      <div class="text"></div>
      <div class="help"><button class="helpBtn">Open the setup guide</button></div>
      <div class="row">
        <button class="prev"  title="Previous sentence">&#9668;&#9668;</button>
        <button class="primary toggle" title="Pause or resume (Alt+P)">Pause</button>
        <button class="next"  title="Next sentence">&#9658;&#9658;</button>
        <button class="stop"  title="Stop (Alt+S)">&#9632;</button>
      </div>
    </div>`;

  const el = {
    card: root.querySelector(".card"),
    dot: root.querySelector(".dot"),
    label: root.querySelector(".label"),
    wpm: root.querySelector(".wpm"),
    count: root.querySelector(".count"),
    size: root.querySelector(".size"),
    rsvp: root.querySelector(".rsvp"),
    word: root.querySelector(".word"),
    left: root.querySelector(".word .l"),
    pivot: root.querySelector(".word .p"),
    right: root.querySelector(".word .r"),
    bar: root.querySelector(".bar > div"),
    text: root.querySelector(".text"),
    help: root.querySelector(".help"),
    helpBtn: root.querySelector(".helpBtn"),
    prev: root.querySelector(".prev"),
    next: root.querySelector(".next"),
    toggle: root.querySelector(".toggle"),
    stop: root.querySelector(".stop"),
  };

  let hideTimer = null;
  let total = 0;

  function mount() {
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
  }
  function show() {
    mount();
    clearTimeout(hideTimer);
    requestAnimationFrame(() => el.card.classList.add("show"));
  }
  function hideSoon(ms = HIDE_AFTER_MS) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => el.card.classList.remove("show"), ms);
  }

  function setControlsEnabled(on) {
    for (const b of [el.prev, el.next, el.toggle, el.stop]) b.disabled = !on;
  }

  // ------------------------------------------------------------- maximize

  let maximized = false;

  function applySize() {
    el.card.classList.toggle("max", maximized);
    el.size.textContent = maximized ? "\u2923" : "\u2922";
    el.size.title = maximized ? "Restore (Esc)" : "Maximize (Alt+M)";
  }

  function setMaximized(on, { persist = true } = {}) {
    maximized = Boolean(on);
    applySize();
    // Remembered across reads, in the same store as the popup's settings. Content
    // scripts get chrome.storage directly; the guard is for the test sandbox.
    if (persist) {
      try {
        api.storage?.sync?.set({ maximized });
      } catch {
        /* storage unavailable; the choice lasts for this page only */
      }
    }
  }

  try {
    api.storage?.sync?.get({ maximized: false })
      ?.then?.((v) => setMaximized(v.maximized, { persist: false }));
  } catch {
    /* as above */
  }

  el.size.addEventListener("click", () => setMaximized(!maximized));
  // Escape restores the small card, but only while it is actually up: a full-screen
  // reader must not swallow the page's own Escape when it is hidden.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && maximized && el.card.classList.contains("show")) {
      setMaximized(false);
      e.stopPropagation();
    }
  }, true);

  // ------------------------------------------------------------------ RSVP

  /** Index of the letter the eye should land on: Spritz's optimal recognition point,
   *  a little left of centre and further left the longer the word. Leading
   *  punctuation is skipped so "(roughly)" pivots on a letter, not the bracket. */
  function pivotIndex(word) {
    const lead = (word.match(/^[^\p{L}\p{N}]*/u) ?? [""])[0].length;
    const core = word.slice(lead).replace(/[^\p{L}\p{N}]+$/u, "");
    const n = core.length;
    if (n === 0) return 0;
    return lead + (n <= 1 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4);
  }

  /** The word being spoken at `pos` seconds into the chunk: the last one that has
   *  started, or the first while the voice is still drawing breath. */
  function wordAt(words, pos) {
    let hit = words[0];
    for (const w of words) {
      if (w.s <= pos) hit = w;
      else break;
    }
    return hit;
  }

  // What the player last told us, plus the wall-clock moment it was true. From that,
  // the position at any later instant is a subtraction — no per-word messages.
  let clock = null;
  let frame = 0;
  let shown = null;

  function positionNow() {
    if (!clock) return 0;
    const drift = clock.playing ? (Date.now() - clock.at) / 1000 : 0;
    return Math.min(clock.position + drift, clock.duration || Infinity);
  }

  function renderWord(word) {
    if (word === shown) return;
    shown = word;
    const k = pivotIndex(word);
    el.left.textContent = word.slice(0, k);
    el.pivot.textContent = word.charAt(k);
    el.right.textContent = word.slice(k + 1);
    el.word.className = word.length > 14 ? "word long" : "word";
    fitWord();
  }

  /** Shrink the word until both halves fit. The pivot letter is pinned to the
   *  centre, so each half gets half the box, and a word with a long tail past its
   *  pivot ("CryptoJones/OSApplyTrack" pivots on its fifth letter) would otherwise
   *  run off the edge and be clipped. Text width scales with font size, so a single
   *  measurement at the stylesheet's size gives the size that fits. */
  function fitWord() {
    el.word.style.fontSize = "";
    el.word.classList.remove("wide");
    const box = el.word.clientWidth;
    if (!box || typeof document.createRange !== "function" ||
        typeof getComputedStyle !== "function") return;
    const width = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().width;
    };
    const left = width(el.left), pivot = width(el.pivot), right = width(el.right);
    const need = Math.max(left, right) + pivot / 2;
    if (need <= box / 2) return;
    const base = parseFloat(getComputedStyle(el.word).fontSize);
    let size = Math.floor((base * box) / 2 / need);
    if (size < 12) {
      // Too far gone for a pinned pivot (a bare URL, say): let the pivot drift and
      // fit the whole token to the full box instead of shrinking it to a smudge.
      el.word.classList.add("wide");
      size = Math.max(10, Math.floor((base * box) / (left + pivot + right)));
    }
    el.word.style.fontSize = `${size}px`;
  }

  // The box changes width on maximize and on window resize; refit the word shown.
  // Only width matters: a refit changes the height, and reacting to that would loop.
  if (typeof ResizeObserver === "function") {
    let lastWidth = 0;
    new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w === lastWidth) return;
      lastWidth = w;
      if (shown !== null) fitWord();
    }).observe(el.word);
  }

  function clearWord() {
    shown = null;
    el.left.textContent = el.pivot.textContent = el.right.textContent = "";
    el.bar.style.width = "0%";
    el.wpm.textContent = "";
  }

  function tick() {
    frame = 0;
    if (!clock) return;
    const pos = positionNow();
    if (clock.words.length) renderWord(wordAt(clock.words, pos).t);
    if (total > 0) {
      const within = clock.duration ? Math.min(pos / clock.duration, 1) : 0;
      el.bar.style.width = `${((clock.index + within) / total) * 100}%`;
    }
    if (clock.playing) frame = requestAnimationFrame(tick);
  }

  function setClock(msg) {
    clock = {
      words: msg.words ?? [],
      duration: msg.duration ?? 0,
      position: msg.position ?? 0,
      at: msg.at ?? Date.now(),
      playing: msg.state === "playing",
      index: msg.index,
    };
    if (clock.words.length && clock.duration) {
      el.wpm.textContent = `${Math.round((clock.words.length / clock.duration) * 60)} wpm`;
    }
    if (frame) cancelAnimationFrame(frame);
    tick();
  }

  function stopClock() {
    clock = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  // -------------------------------------------------------------- messages

  const send = (action) => api.runtime.sendMessage({ type: "cr-control", action });
  el.prev.addEventListener("click", () => send("prev"));
  el.next.addEventListener("click", () => send("next"));
  el.stop.addEventListener("click", () => send("stop"));
  el.toggle.addEventListener("click", () => send("toggle"));
  el.helpBtn.addEventListener("click", () => api.runtime.sendMessage({ type: "cr-open-help" }));

  api.runtime.onMessage.addListener((msg) => {
    if (!msg?.type?.startsWith("cr-")) return;

    if (msg.type === "cr-toggle-max") {
      setMaximized(!maximized);
      return;
    }

    if (msg.type === "cr-status" && msg.state === "preparing") {
      stopClock();
      clearWord();
      el.help.className = "help";
      el.dot.className = "dot";
      el.label.textContent = "ClarkReader";
      el.count.textContent = "";
      el.text.className = "text";
      el.text.textContent = "Preparing audio…";
      setControlsEnabled(false);
      show();
      return;
    }

    if (msg.type === "cr-start") {
      total = msg.count;
      el.rsvp.hidden = msg.rsvp === false;
      const voice = msg.voice === "bf_emma" ? "Emma" : msg.voice;
      // A whole document names itself in the header; a selection is just the voice.
      el.label.textContent = msg.title ? `${voice} · ${msg.title}` : voice;
      el.count.textContent = `${(msg.from ?? 0) + 1} / ${total}`;
      setControlsEnabled(true);
      show();
      return;
    }

    if (msg.type === "cr-progress") {
      total = msg.total ?? total;
      const paused = msg.state !== "playing";
      el.dot.className = paused ? "dot paused" : "dot";
      el.count.textContent = `${msg.index + 1} / ${total}`;
      el.text.className = "text";
      el.text.textContent = msg.text || "";
      el.toggle.textContent = paused ? "Resume" : "Pause";
      el.prev.disabled = msg.index === 0;
      el.next.disabled = msg.index >= total - 1;
      setClock(msg);
      show();
      return;
    }

    if (msg.type === "cr-ended") {
      stopClock();
      el.bar.style.width = "100%";
      el.dot.className = "dot";
      el.count.textContent = "";
      el.text.textContent = "Finished.";
      el.toggle.textContent = "Pause";
      setControlsEnabled(false);
      show();
      hideSoon();
      return;
    }

    if (msg.type === "cr-error") {
      stopClock();
      clearWord();
      el.help.className = msg.help ? "help show" : "help";
      el.dot.className = "dot error";
      el.label.textContent = "ClarkReader";
      el.count.textContent = "";
      el.text.className = "text err";
      el.text.textContent = msg.message;
      setControlsEnabled(false);
      show();
      // An error with a way forward stays up long enough to take it.
      hideSoon(msg.help ? 20000 : 6000);
    }
  });
}
