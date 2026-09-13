// Executes the real extension sources against stubbed WebExtension APIs.
//
// This is not a substitute for loading the add-on, but it catches the class of bug
// that static checks miss and that only shows up on the second use: load-order
// mistakes, a name that exists in one browser's context and not the other's, and
// re-declaration errors from re-injected content scripts.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

const JOB = {
  id: "abc123def456",
  count: 2,
  voice: "bf_emma",
  speed: 0.88,
  chunks: [{ i: 0, text: "First sentence." }, { i: 1, text: "Second sentence." }],
};

const WORDS = {
  words: [{ t: "First", s: 0.3, e: 0.6 }, { t: "sentence.", s: 0.6, e: 1.0 }],
  duration: 1.1,
};

class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    FakeAudioContext.sources = [];
  }
  get destination() { return {}; }
  async resume() { this.state = "running"; }
  async suspend() { this.state = "suspended"; }
  async decodeAudioData() { return { duration: 1 }; }
  createBufferSource() {
    const s = { buffer: null, onended: null, started: false, stopped: false,
                connect() {}, disconnect() {}, start() { s.started = true; },
                stop() { s.stopped = true; } };
    FakeAudioContext.sources.push(s);
    return s;
  }
}

/** Records every call so tests can assert on the wiring rather than on internals. */
function makeStubs({ offscreen, selection = "Selected text." }) {
  const calls = { fetches: [], toTab: [], sent: [], executed: [], offscreenDocs: [] };
  const listeners = {};
  const store = { sync: {}, session: {}, local: {} };
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });

  const api = {
    runtime: {
      onInstalled: on("installed"),
      onMessage: on("message"),
      sendMessage: async (m) => { calls.sent.push(m); },
      getContexts: async () => calls.offscreenDocs,
      getURL: (p) => `ext://id/${p}`,
      getManifest: () => ({ version: "9.9.9" }),
    },
    contextMenus: { create: () => {}, onClicked: on("menu") },
    commands: { onCommand: on("command") },
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: async (tabId, m) => { calls.toTab.push({ tabId, ...m }); },
      create: async (o) => { calls.opened = [...(calls.opened ?? []), o.url]; },
    },
    scripting: {
      // Two functions get injected: the selection reader and the page extractor.
      // They are told apart by what they reference, the way the real page would.
      executeScript: async ({ files, func }) => {
        calls.executed.push(files ? files[0] : "func");
        if (!func) return [{ result: undefined }];
        if (String(func).includes("Readability")) {
          return [{ result: { title: "Page Title", text: "Page Title. Body of the page.",
                              key: "https://example.test/article" } }];
        }
        if (String(func).includes("location.origin")) return [{ result: "https://example.test/article" }];
        return [{ result: selection }];
      },
    },
    storage: {
      sync: { get: async (d) => ({ ...d, ...store.sync }), set: async (o) => Object.assign(store.sync, o) },
      session: { get: async (k) => ({ [k]: store.session[k] }), set: async (o) => Object.assign(store.session, o) },
      local: { get: async (k) => ({ [k]: store.local[k] }), set: async (o) => Object.assign(store.local, o) },
    },
  };
  if (offscreen) {
    api.offscreen = {
      createDocument: async () => { calls.offscreenDocs.push({ contextType: "OFFSCREEN_DOCUMENT" }); },
    };
  }

  const fetchStub = async (url, opts) => {
    calls.fetches.push({ url, opts });
    if (url.endsWith("/prepare")) return { ok: true, json: async () => JOB };
    if (url.includes("/words/")) return { ok: true, json: async () => WORDS };
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };

  return { api, calls, listeners, fetchStub, store };
}

/** Build a background context the way the given browser's manifest does. */
function loadBackground(browser, opts = {}) {
  const offscreen = browser === "chrome";
  const { api, calls, listeners, fetchStub, store } = makeStubs({ offscreen, ...opts });
  const sandbox = { console, fetch: fetchStub, AudioContext: FakeAudioContext, setTimeout, clearTimeout };
  let ctx;
  // Chrome exposes only `chrome` and pulls deps in with importScripts; Firefox exposes
  // `browser` and lists them in manifest.background.scripts.
  if (offscreen) {
    sandbox.chrome = api;
    sandbox.importScripts = (...files) => {
      for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
    };
  } else {
    sandbox.browser = api;
  }
  ctx = vm.createContext(sandbox);
  const files = offscreen ? ["background.js"]
                          : ["api.js", "config.js", "player.js", "background.js"];
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  return { ctx, calls, listeners, store };
}

const settle = () => new Promise((r) => setImmediate(r));

test("manifests agree with how each background actually loads", () => {
  const chrome = JSON.parse(read("manifest.json"));
  const firefox = JSON.parse(read("manifest.firefox.json"));

  assert.equal(chrome.background.service_worker, "background.js");
  assert.ok(chrome.permissions.includes("offscreen"), "Chrome needs the offscreen permission");
  assert.ok(!chrome.background.type, "service worker must be classic for importScripts");

  // Order matters: background.js references ClarkPlayer, getSettings and api.
  assert.deepEqual(firefox.background.scripts,
    ["api.js", "config.js", "player.js", "background.js"]);
  assert.ok(!firefox.permissions.includes("offscreen"), "Firefox has no offscreen API");
  assert.ok(firefox.browser_specific_settings.gecko.id, "Firefox needs an add-on id");

  // background.js handles one fixed set of commands; both manifests must declare it.
  assert.deepEqual(Object.keys(chrome.commands).sort(),
    ["read-selection", "stop-reading", "toggle-maximize", "toggle-pause"]);
  assert.deepEqual(chrome.commands, firefox.commands);
  assert.equal(chrome.version, firefox.version);

  // Store readiness: an old browser must be refused rather than installing a
  // broken extension, and a LAN server must be grantable without a new build.
  assert.equal(chrome.minimum_chrome_version, "116", "offscreen + getContexts need 116");
  assert.deepEqual(chrome.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.deepEqual(firefox.optional_host_permissions, chrome.optional_host_permissions);
  assert.match(chrome.homepage_url, /github\.com/);
  assert.ok(fs.existsSync(path.join(EXT, "welcome.html")), "the setup guide ships in the package");
});

test("both backgrounds load and pick the right playback path", () => {
  assert.equal(vm.runInContext("HAS_OFFSCREEN", loadBackground("firefox").ctx), false);
  assert.equal(vm.runInContext("HAS_OFFSCREEN", loadBackground("chrome").ctx), true);
});

test("Firefox reads a selection and plays it in-process", async () => {
  const { calls, listeners } = loadBackground("firefox");
  await listeners.command("read-selection");
  await settle();

  const prepare = calls.fetches.find((f) => f.url.endsWith("/prepare"));
  assert.ok(prepare, "should POST the selection to /prepare");
  assert.equal(JSON.parse(prepare.opts.body).text, "Selected text.");
  assert.equal(JSON.parse(prepare.opts.body).voice, "bf_emma");

  // No offscreen document exists, so the player must run here and fetch chunk 0.
  assert.ok(calls.fetches.some((f) => f.url.includes(`/chunk/${JOB.id}/0`)),
    "Firefox should fetch the first chunk itself");
  assert.ok(calls.toTab.some((m) => m.type === "cr-progress" && m.index === 0),
    "progress should reach the tab overlay");
});

test("Chrome hands playback to the offscreen document instead", async () => {
  const { calls, listeners } = loadBackground("chrome");
  await listeners.command("read-selection");
  await settle();

  assert.equal(calls.offscreenDocs.length, 1, "should create one offscreen document");
  const play = calls.sent.find((m) => m.type === "play");
  assert.ok(play, "should message the player");
  assert.equal(play.target, "offscreen");
  assert.ok(!calls.fetches.some((f) => f.url.includes("/chunk/")),
    "the service worker must not decode audio itself");
});

test("a stopped server is reported, not thrown", async () => {
  const { ctx, calls, listeners } = loadBackground("firefox");
  vm.runInContext("globalThis.fetch = async () => { throw new TypeError('failed'); }", ctx);
  await listeners.command("read-selection");
  await settle();
  const err = calls.toTab.find((m) => m.type === "cr-error");
  assert.ok(err, "should surface an error to the overlay");
  assert.match(err.message, /server/i);
});

test("content.js survives being injected twice into one page", () => {
  // executeScript re-runs the file in the same isolated world every invocation. A
  // top-level `const` here throws "already declared" on the second read.
  const listeners = [];
  const shadow = { innerHTML: "", querySelector: () => el() };
  function el() {
    return { id: "", style: { cssText: "" }, className: "", textContent: "",
             disabled: false, hidden: false, isConnected: false,
             addEventListener() {}, append() {}, appendChild() {},
             attachShadow: () => shadow, classList: { add() {}, remove() {} } };
  }
  const sandbox = {
    console, setTimeout, clearTimeout, requestAnimationFrame: (f) => f(),
    chrome: { runtime: { sendMessage() {}, onMessage: { addListener: (f) => listeners.push(f) } } },
    document: { createElement: el, body: el(), documentElement: el(), addEventListener() {} },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  const src = read("content.js");
  vm.runInContext(src, ctx, { filename: "content.js" });
  assert.doesNotThrow(() => vm.runInContext(src, ctx, { filename: "content.js" }),
    "second injection must be a no-op, not a redeclaration error");
  assert.equal(listeners.length, 1, "must not register a duplicate message listener");
});

test("player advances, skips and stops without stranding a source", async () => {
  const { api, fetchStub } = makeStubs({ offscreen: false });
  const ctx = vm.createContext({ console, fetch: fetchStub, AudioContext: FakeAudioContext, browser: api });
  vm.runInContext(read("api.js"), ctx, { filename: "api.js" });
  vm.runInContext(read("player.js"), ctx, { filename: "player.js" });

  const reports = [];
  ctx.report = (m) => reports.push(m);
  await vm.runInContext(
    `globalThis.p = new ClarkPlayer(report); p.start('http://s', ${JSON.stringify(JOB)})`, ctx);

  assert.equal(reports.at(-1).index, 0);
  assert.ok(FakeAudioContext.sources[0].started, "first sentence should be playing");

  // Finishing sentence 0 on its own should advance to sentence 1.
  await FakeAudioContext.sources[0].onended();
  await settle();
  assert.equal(reports.at(-1).index, 1, "should advance to the next sentence");

  // Finishing the last one ends the job rather than fetching past the end.
  await FakeAudioContext.sources[1].onended();
  await settle();
  assert.equal(reports.at(-1).type, "cr-ended");

  // A stop after the job ended must not report a second time.
  const before = reports.length;
  await vm.runInContext("p.stop()", ctx);
  assert.equal(reports.length, before, "stopping a finished job should be silent");
});

test("progress carries the server's word timings and where playback is", async () => {
  const { api, fetchStub } = makeStubs({ offscreen: false });
  const ctx = vm.createContext({ console, fetch: fetchStub, AudioContext: FakeAudioContext, browser: api, Date });
  vm.runInContext(read("api.js"), ctx, { filename: "api.js" });
  vm.runInContext(read("player.js"), ctx, { filename: "player.js" });

  const reports = [];
  ctx.report = (m) => reports.push(m);
  const before = Date.now();
  await vm.runInContext(
    `globalThis.p = new ClarkPlayer(report); p.start('http://s', ${JSON.stringify(JOB)})`, ctx);

  const first = reports.at(-1);
  assert.equal(first.type, "cr-progress");
  assert.deepEqual(first.words, WORDS.words, "words must be the server's timings");
  assert.equal(first.duration, 1, "duration comes from the decoded buffer");
  assert.equal(first.position, 0, "a fresh chunk starts at the beginning");
  assert.ok(first.at >= before, "the report is stamped with wall-clock time");

  // Pausing reports the frozen position, not a stale one.
  ctx.p.ctx.currentTime = 0.42;
  await vm.runInContext("p.toggle()", ctx);
  const paused = reports.at(-1);
  assert.equal(paused.state, "paused");
  assert.ok(Math.abs(paused.position - 0.42) < 1e-9);
});

test("a server without /words still gets a word per beat, spaced by length", async () => {
  const { api, fetchStub } = makeStubs({ offscreen: false });
  const oldServer = async (url, opts) =>
    url.includes("/words/") ? { ok: false, status: 404 } : fetchStub(url, opts);
  const ctx = vm.createContext({ console, fetch: oldServer, AudioContext: FakeAudioContext, browser: api, Date });
  vm.runInContext(read("api.js"), ctx, { filename: "api.js" });
  vm.runInContext(read("player.js"), ctx, { filename: "player.js" });

  const reports = [];
  ctx.report = (m) => reports.push(m);
  await vm.runInContext(
    `globalThis.p = new ClarkPlayer(report); p.start('http://s', ${JSON.stringify(JOB)})`, ctx);

  const words = reports.at(-1).words;
  assert.deepEqual(Array.from(words, (w) => w.t), ["First", "sentence."]);
  assert.equal(words[0].s, 0);
  assert.equal(words.at(-1).e, 1, "the estimate spans the whole buffer");
  assert.ok(words[1].e - words[1].s > words[0].e - words[0].s,
    "a longer word gets a longer slot");
});

/** A content-script sandbox whose shadow DOM hands out one stable element per
 *  selector, so a test can read back what the overlay wrote into it. */
function loadContent({ stored = {}, measure = null } = {}) {
  const listeners = [];
  const keydown = [];
  const nodes = new Map();
  function el() {
    const classes = new Set();
    const e = { id: "", style: {}, className: "", textContent: "", innerHTML: "", title: "",
                disabled: false, hidden: false, isConnected: false,
                handlers: {},
                addEventListener(type, fn) { e.handlers[type] = fn; },
                append() {}, appendChild() {},
                attachShadow: () => shadow,
                classList: {
                  add: (c) => classes.add(c), remove: (c) => classes.delete(c),
                  contains: (c) => classes.has(c),
                  toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
                } };
    return e;
  }
  const shadow = {
    innerHTML: "",
    querySelector: (sel) => {
      if (!nodes.has(sel)) nodes.set(sel, el());
      return nodes.get(sel);
    },
  };
  // A synchronous rAF would recurse forever inside the RSVP loop; defer it instead.
  const sandbox = {
    console, setTimeout, clearTimeout, Date,
    requestAnimationFrame: (f) => setTimeout(f, 0),
    cancelAnimationFrame: clearTimeout,
    chrome: {
      runtime: { sendMessage() {}, onMessage: { addListener: (f) => listeners.push(f) } },
      storage: { sync: { get: async (d) => ({ ...d, ...stored }),
                         set: async (o) => Object.assign(stored, o) } },
    },
    document: { createElement: el, body: el(), documentElement: el(),
                addEventListener: (type, fn) => { if (type === "keydown") keydown.push(fn); } },
  };
  // Optional text metrics: a `measure` of { box, fontPx, charPx } gives the word box a
  // width and makes every glyph the same width, so a test can check the fit maths.
  if (measure) {
    shadow.querySelector(".word").clientWidth = measure.box;
    sandbox.getComputedStyle = () => ({ fontSize: `${measure.fontPx}px` });
    sandbox.document.createRange = () => {
      let node = null;
      return { selectNodeContents(n) { node = n; },
               getBoundingClientRect: () => ({ width: node.textContent.length * measure.charPx }) };
    };
  }
  sandbox.window = sandbox;
  vm.runInContext(read("content.js"), vm.createContext(sandbox), { filename: "content.js" });
  const pressEscape = () => {
    const e = { key: "Escape", stopped: false, stopPropagation() { e.stopped = true; } };
    for (const fn of keydown) fn(e);
    return e;
  };
  return { nodes, stored, onMessage: listeners[0], pressEscape };
}

test("the RSVP window shows the word the voice is on, anchored on its pivot letter", async () => {
  const { nodes, onMessage } = loadContent();
  const q = (sel) => nodes.get(sel);
  onMessage({ type: "cr-start", count: 2, voice: "bf_emma", rsvp: true });

  const words = [
    { t: "Reading", s: 0.3, e: 0.7 }, { t: "isn't", s: 0.7, e: 0.95 },
    { t: "the", s: 0.95, e: 1.05 }, { t: "(roughly).", s: 1.05, e: 2.0 },
  ];
  const base = { type: "cr-progress", index: 0, total: 2, text: "", words, duration: 2.2 };

  // Reported 1.0 s ago from position 0 while playing -> the voice is on "the".
  onMessage({ ...base, state: "playing", position: 0, at: Date.now() - 1000 });
  assert.equal(q(".word .l").textContent + q(".word .p").textContent + q(".word .r").textContent, "the");
  assert.equal(q(".word .p").textContent, "h", "2-5 letter words pivot on the second letter");
  assert.equal(q(".wpm").textContent, "109 wpm");

  // The pivot skips leading punctuation: "(roughly)." anchors on the third letter
  // of "roughly", as a 6-9 letter word should, not on the bracket.
  onMessage({ ...base, state: "paused", position: 1.5, at: Date.now() });
  assert.equal(q(".word .p").textContent, "u");
  assert.equal(q(".word .l").textContent, "(ro");
  assert.equal(q(".word .r").textContent, "ghly).");

  // Paused: time passing must not move the word.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(q(".word .p").textContent, "u");

  // Before the first word has started, the first word is shown, not nothing.
  onMessage({ ...base, state: "paused", position: 0.1, at: Date.now() });
  assert.equal(q(".word .p").textContent, "a");
  assert.equal(q(".word .l").textContent, "Re");

  onMessage({ type: "cr-ended" });
  assert.equal(q(".bar > div").style.width, "100%");
});

test("a word too long for half the box is shrunk to fit rather than clipped", () => {
  // A 300px box at 30px with 20px glyphs: each half holds 150px, seven glyphs or so.
  const { nodes, onMessage } = loadContent({ measure: { box: 300, fontPx: 30, charPx: 20 } });
  const word = nodes.get(".word");
  onMessage({ type: "cr-start", count: 1, voice: "bf_emma", rsvp: true });
  const show = (t) => onMessage({ type: "cr-progress", index: 0, total: 1, text: "", duration: 1,
                                  words: [{ t, s: 0, e: 1 }], state: "paused", position: 0.5, at: Date.now() });

  show("Reading");
  assert.equal(word.style.fontSize, "", "a short word keeps the stylesheet's size");

  // Pivot on the fifth letter leaves a 13-glyph tail (260px) plus half the pivot (10px)
  // to fit in 150px with the pivot still pinned: 30px * 150 / 270, floored.
  show("characteristically");
  assert.equal(nodes.get(".word .r").textContent, "cteristically");
  assert.equal(word.style.fontSize, "16px");
  assert.ok(!word.classList.contains("wide"), "the pivot stays pinned");

  // A 19-glyph tail would need 11px pinned, too small to read: the pivot drifts and
  // the whole 24-glyph token (480px) is fitted to the full box, 30px * 300 / 480.
  show("CryptoJones/OSApplyTrack");
  assert.equal(word.style.fontSize, "18px");
  assert.ok(word.classList.contains("wide"));

  // Even a bare URL bottoms out at a readable floor rather than a smudge.
  show("https://github.com/CryptoJones/OSApplyTrack/releases/");
  assert.equal(word.style.fontSize, "10px");
  assert.ok(word.classList.contains("wide"));

  show("the");
  assert.equal(word.style.fontSize, "", "the next short word gets the full size back");
  assert.ok(!word.classList.contains("wide"), "and the pivot is pinned again");
});

test("the RSVP window can be switched off from the popup setting", () => {
  const { nodes, onMessage } = loadContent();
  onMessage({ type: "cr-start", count: 1, voice: "bf_emma", rsvp: false });
  assert.equal(nodes.get(".rsvp").hidden, true);
  onMessage({ type: "cr-start", count: 1, voice: "bf_emma", rsvp: true });
  assert.equal(nodes.get(".rsvp").hidden, false);
});

test("the reader can be maximized from the header, the shortcut, and back with Escape", async () => {
  const { nodes, stored, onMessage, pressEscape } = loadContent();
  await settle();
  const card = nodes.get(".card");
  const size = nodes.get(".size");
  assert.equal(card.classList.contains("max"), false);

  // Header button toggles and the choice is remembered.
  size.handlers.click();
  assert.equal(card.classList.contains("max"), true);
  assert.match(size.title, /Restore/);
  assert.equal(stored.maximized, true);

  // Escape restores only while the card is showing; a hidden overlay must not eat
  // the page's Escape.
  let e = pressEscape();
  assert.equal(card.classList.contains("max"), true, "hidden card ignores Escape");
  assert.equal(e.stopped, false);

  onMessage({ type: "cr-start", count: 1, voice: "bf_emma", rsvp: true });
  card.classList.add("show"); // show() defers this to a frame; we are the frame
  e = pressEscape();
  assert.equal(card.classList.contains("max"), false);
  assert.equal(e.stopped, true);
  assert.equal(stored.maximized, false);

  // Alt+M arrives from the background as a message.
  onMessage({ type: "cr-toggle-max" });
  assert.equal(card.classList.contains("max"), true);
});

test("a maximized reader comes back maximized on the next page", async () => {
  const { nodes } = loadContent({ stored: { maximized: true } });
  await settle();
  assert.equal(nodes.get(".card").classList.contains("max"), true);
});

test("Alt+M reaches the overlay in the active tab", async () => {
  const { calls, listeners } = loadBackground("firefox");
  await listeners.command("toggle-maximize");
  assert.deepEqual(calls.toTab.at(-1), { tabId: 7, type: "cr-toggle-max" });
});

test("with nothing selected, Alt+R reads the whole document instead of erroring", async () => {
  const { calls, listeners } = loadBackground("firefox", { selection: "" });
  await listeners.command("read-selection");
  await settle();

  assert.ok(calls.executed.includes("vendor/Readability.js"), "Readability must be injected");
  const prepare = calls.fetches.find((f) => f.url.endsWith("/prepare"));
  assert.equal(JSON.parse(prepare.opts.body).text, "Page Title. Body of the page.");
  const start = calls.toTab.find((m) => m.type === "cr-start");
  assert.equal(start.title, "Page Title", "the overlay is told what it is reading");
  assert.ok(!calls.toTab.some((m) => m.type === "cr-error"));
});

test("the page menu item and popup read the whole document even over a selection", async () => {
  const { calls, listeners } = loadBackground("firefox");
  await listeners.menu({ menuItemId: "clarkreader-read-page" }, { id: 7 });
  await settle();
  let prepare = calls.fetches.filter((f) => f.url.endsWith("/prepare")).at(-1);
  assert.equal(JSON.parse(prepare.opts.body).text, "Page Title. Body of the page.");

  await new Promise((resolve) =>
    listeners.message({ type: "cr-read-active", wholePage: true }, {}, resolve));
  await settle();
  prepare = calls.fetches.filter((f) => f.url.endsWith("/prepare")).at(-1);
  assert.equal(JSON.parse(prepare.opts.body).text, "Page Title. Body of the page.");

  // And the selection item still reads the selection.
  await listeners.menu({ menuItemId: "clarkreader-read-selection", selectionText: "x" }, { id: 7 });
  await settle();
  prepare = calls.fetches.filter((f) => f.url.endsWith("/prepare")).at(-1);
  assert.equal(JSON.parse(prepare.opts.body).text, "Selected text.");
});

test("a selection still wins over the page when both exist", async () => {
  const { calls, listeners } = loadBackground("chrome");
  await listeners.command("read-selection");
  await settle();
  assert.ok(!calls.executed.includes("vendor/Readability.js"));
  const prepare = calls.fetches.find((f) => f.url.endsWith("/prepare"));
  assert.equal(JSON.parse(prepare.opts.body).text, "Selected text.");
});

test("one sentence that fails to synthesize is skipped; a run of them stops playback", async () => {
  const { api, fetchStub } = makeStubs({ offscreen: false });
  const failing = new Set(["/chunk/abc123def456/0"]);
  const flaky = async (url, opts) => {
    if ([...failing].some((f) => url.endsWith(f))) return { ok: false, status: 500, statusText: "boom" };
    return fetchStub(url, opts);
  };
  const ctx = vm.createContext({ console, fetch: flaky, AudioContext: FakeAudioContext, browser: api, Date });
  vm.runInContext(read("api.js"), ctx, { filename: "api.js" });
  vm.runInContext(read("player.js"), ctx, { filename: "player.js" });
  const reports = [];
  ctx.report = (m) => reports.push(m);
  await vm.runInContext(
    `globalThis.p = new ClarkPlayer(report); p.start('http://s', ${JSON.stringify(JOB)})`, ctx);

  assert.ok(reports.some((m) => m.type === "cr-skipped" && m.index === 0));
  assert.equal(reports.at(-1).type, "cr-progress");
  assert.equal(reports.at(-1).index, 1, "playback continues with the next sentence");

  // Every remaining sentence failing is a dead server, not a bad sentence.
  failing.add("/chunk/abc123def456/1");
  await vm.runInContext(`p.start('http://s', ${JSON.stringify(JOB)})`, ctx);
  assert.equal(reports.at(-1).type, "cr-playback-error");
});

const KEY = "https://example.test/article";
const marks = (store) => store.local.crMarks ?? {};
const lastPlay = (calls) => calls.sent.filter((m) => m.type === "play").at(-1);

test("a stopped whole-document read leaves a bookmark and resumes from it", async () => {
  // Chrome: the offscreen player is stubbed out by message, so the background's own
  // report handler can be driven directly with what the player would have said.
  const { calls, listeners, store } = loadBackground("chrome", { selection: "" });
  await listeners.command("read-selection");
  await settle();
  assert.equal(lastPlay(calls).from, 0, "a fresh page starts at the top");

  // Sentence 1 of 2 is playing when the user stops.
  await listeners.message({ type: "cr-progress", index: 1, total: 2, state: "playing" });
  await settle();
  assert.deepEqual({ index: marks(store)[KEY].index, count: marks(store)[KEY].count }, { index: 1, count: 2 });
  await listeners.message({ type: "cr-stopped" });
  await settle();
  assert.ok(marks(store)[KEY], "stopping keeps the bookmark");

  // Reading the page again picks up at sentence 1, and the overlay is told so.
  await listeners.command("read-selection");
  await settle();
  assert.equal(lastPlay(calls).from, 1);
  assert.equal(calls.toTab.filter((m) => m.type === "cr-start").at(-1).from, 1);

  // Finishing clears it: the next read starts over.
  await listeners.message({ type: "cr-ended" });
  await settle();
  assert.equal(marks(store)[KEY], undefined, "finishing clears the bookmark");
  await listeners.command("read-selection");
  await settle();
  assert.equal(lastPlay(calls).from, 0);
});

test("the popup can start over, and a changed page does not resume", async () => {
  const { calls, listeners, store } = loadBackground("chrome", { selection: "" });
  store.local.crMarks = { [KEY]: { index: 1, count: 2, at: 1 } };

  await new Promise((resolve) =>
    listeners.message({ type: "cr-read-active", wholePage: true, restart: true }, {}, resolve));
  await settle();
  assert.equal(lastPlay(calls).from, 0, "restart ignores the bookmark");
  assert.equal(marks(store)[KEY], undefined, "and drops it");

  // A bookmark whose sentence count no longer matches the page is stale.
  store.local.crMarks = { [KEY]: { index: 1, count: 99, at: 1 } };
  await listeners.command("read-selection");
  await settle();
  assert.equal(lastPlay(calls).from, 0);
  assert.equal(marks(store)[KEY], undefined);
});

test("the popup is told where the active page would resume", async () => {
  const { listeners, store } = loadBackground("chrome");
  store.local.crMarks = { [KEY]: { index: 4, count: 10, title: "T", at: 1 } };
  const mark = await new Promise((resolve) =>
    listeners.message({ type: "cr-query-mark" }, {}, resolve));
  assert.equal(mark.index, 4);
  assert.equal(mark.count, 10);
  assert.equal(mark.key, KEY);
});

test("a selection read never writes a bookmark", async () => {
  const { listeners, store } = loadBackground("firefox");
  await listeners.command("read-selection");
  await settle();
  assert.deepEqual(marks(store), {});
});

test("the player starts where it is told", async () => {
  const { api, fetchStub } = makeStubs({ offscreen: false });
  const ctx = vm.createContext({ console, fetch: fetchStub, AudioContext: FakeAudioContext, browser: api, Date });
  vm.runInContext(read("api.js"), ctx, { filename: "api.js" });
  vm.runInContext(read("player.js"), ctx, { filename: "player.js" });
  const reports = [];
  ctx.report = (m) => reports.push(m);
  await vm.runInContext(
    `globalThis.p = new ClarkPlayer(report); p.start('http://s', ${JSON.stringify(JOB)}, 1)`, ctx);
  assert.equal(reports.at(-1).index, 1);
  // Out of range is clamped rather than reading past the end or before the start.
  await vm.runInContext(`p.start('http://s', ${JSON.stringify(JOB)}, 99)`, ctx);
  assert.equal(reports.at(-1).index, 1);
});

test("the setup guide opens on first install and from a server error, never on update", async () => {
  const { ctx, calls, listeners } = loadBackground("chrome");
  await listeners.installed({ reason: "update" });
  await settle();
  assert.equal(calls.opened, undefined, "an update must not pop a tab");
  await listeners.installed({ reason: "install" });
  await settle();
  assert.deepEqual(calls.opened, ["ext://id/welcome.html"]);

  // The overlay's "Open the setup guide" button and the popup link send one message.
  await listeners.message({ type: "cr-open-help" });
  await settle();
  assert.equal(calls.opened.length, 2);

  // A stopped server error carries the flag that shows that button.
  vm.runInContext("globalThis.fetch = async () => { throw new TypeError('failed'); }", ctx);
  await listeners.command("read-selection");
  await settle();
  const err = calls.toTab.find((m) => m.type === "cr-error");
  assert.equal(err.help, true);
  assert.doesNotMatch(err.message, /run\.sh/, "store users have no run.sh");
});

test("the overlay shows the setup button only for a reachable-server error", () => {
  const { nodes, onMessage } = loadContent();
  onMessage({ type: "cr-error", message: "Cannot reach the server.", help: true });
  assert.equal(nodes.get(".help").className, "help show");
  onMessage({ type: "cr-error", message: "Nothing to read on this page." });
  assert.equal(nodes.get(".help").className, "help");
});

test("the background reports its running version so a fresh popup can spot a stale one", async () => {
  const { listeners } = loadBackground("chrome");
  const v = await new Promise((resolve) => listeners.message({ type: "cr-version" }, {}, resolve));
  assert.equal(v, "9.9.9");
});
