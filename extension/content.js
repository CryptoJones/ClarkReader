// The in-page player overlay.
//
// Injected on demand rather than declared over <all_urls>, so ClarkReader has no
// presence on pages you never ask it to read. executeScript re-runs this file on
// every invocation, hence the idempotence guard.

if (!window.__clarkReaderInjected) {
  window.__clarkReaderInjected = true;

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
        position: fixed; right: 20px; bottom: 20px; width: 320px;
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
      .head {
        display: flex; align-items: center; gap: 8px;
        font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
        color: #8b90a0; margin-bottom: 8px;
      }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #3ddc84; flex: none; }
      .dot.paused { background: #e2b33c; }
      .dot.error  { background: #e05d5d; }
      .count { margin-left: auto; font-variant-numeric: tabular-nums; }
      .text {
        min-height: 34px; max-height: 54px; overflow: hidden;
        color: #cfd2da; margin-bottom: 10px;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
      }
      .text.err { color: #f0a0a0; }
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
      }
    </style>
    <div class="card" part="card">
      <div class="head">
        <span class="dot"></span><span class="label">ClarkReader</span>
        <span class="count"></span>
      </div>
      <div class="text"></div>
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
    count: root.querySelector(".count"),
    text: root.querySelector(".text"),
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

  const send = (action) => chrome.runtime.sendMessage({ type: "cr-control", action });
  el.prev.addEventListener("click", () => send("prev"));
  el.next.addEventListener("click", () => send("next"));
  el.stop.addEventListener("click", () => send("stop"));
  el.toggle.addEventListener("click", () => send("toggle"));

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg?.type?.startsWith("cr-")) return;

    if (msg.type === "cr-status" && msg.state === "preparing") {
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
      el.label.textContent = msg.voice === "bf_emma" ? "Emma" : msg.voice;
      el.count.textContent = `1 / ${total}`;
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
      show();
      return;
    }

    if (msg.type === "cr-ended") {
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
      el.dot.className = "dot error";
      el.label.textContent = "ClarkReader";
      el.count.textContent = "";
      el.text.className = "text err";
      el.text.textContent = msg.message;
      setControlsEnabled(false);
      show();
      hideSoon(6000);
    }
  });
}
