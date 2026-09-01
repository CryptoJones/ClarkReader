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

class FakeAudioContext {
  constructor() {
    this.state = "running";
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
function makeStubs({ offscreen }) {
  const calls = { fetches: [], toTab: [], sent: [], executed: [], offscreenDocs: [] };
  const listeners = {};
  const store = { sync: {}, session: {} };
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });

  const api = {
    runtime: {
      onInstalled: on("installed"),
      onMessage: on("message"),
      sendMessage: async (m) => { calls.sent.push(m); },
      getContexts: async () => calls.offscreenDocs,
    },
    contextMenus: { create: () => {}, onClicked: on("menu") },
    commands: { onCommand: on("command") },
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: async (tabId, m) => { calls.toTab.push({ tabId, ...m }); },
    },
    scripting: {
      executeScript: async ({ files, func }) => {
        calls.executed.push(files ? files[0] : "func");
        return func ? [{ result: "Selected text." }] : [{ result: undefined }];
      },
    },
    storage: {
      sync: { get: async (d) => ({ ...d, ...store.sync }), set: async (o) => Object.assign(store.sync, o) },
      session: { get: async (k) => ({ [k]: store.session[k] }), set: async (o) => Object.assign(store.session, o) },
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
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };

  return { api, calls, listeners, fetchStub };
}

/** Build a background context the way the given browser's manifest does. */
function loadBackground(browser) {
  const offscreen = browser === "chrome";
  const { api, calls, listeners, fetchStub } = makeStubs({ offscreen });
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
  return { ctx, calls, listeners };
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
    document: { createElement: el, body: el(), documentElement: el() },
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
