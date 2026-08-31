// Chrome loads this as a classic service worker and pulls its dependencies in with
// importScripts. Firefox lists them ahead of this file in manifest.background.scripts,
// so they are already in scope and importScripts does not exist.
if (typeof importScripts === "function") importScripts("api.js", "config.js");

const MENU_ID = "clarkreader-read-selection";

// The service worker is killed and restarted freely, so anything a later control
// command needs to know is mirrored into session storage rather than kept only here.
let state = { tabId: null, jobId: null, index: 0, count: 0, playing: false };

// Firefox only: with no offscreen document, the player runs right here.
let localPlayer = null;

async function loadState() {
  const { crState } = await api.storage.session.get("crState");
  if (crState) state = crState;
  return state;
}
async function saveState(patch) {
  state = { ...state, ...patch };
  await api.storage.session.set({ crState: state });
}

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.create({
    id: MENU_ID,
    title: "Read aloud with Emma",
    contexts: ["selection"],
  });
});

api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab?.id != null) {
    // info.selectionText is truncated by the browser, so it is only the fallback.
    readSelection(tab.id, info.selectionText);
  }
});

api.commands.onCommand.addListener(async (command) => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (command === "read-selection" && tab?.id != null) return readSelection(tab.id);
  if (command === "toggle-pause") return control("toggle");
  if (command === "stop-reading") return control("stop");
});

// ---------------------------------------------------------------- page plumbing

/** Inject the overlay script once per page. Re-injection is guarded inside it. */
async function ensureContent(tabId) {
  try {
    await api.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch (err) {
    // Browser-internal pages, extension galleries and PDFs refuse injection. Reading
    // still works; there is just nowhere to draw the player.
    console.warn("ClarkReader: no overlay on this page —", err.message);
    return false;
  }
}

/** Read the live selection out of the page, including inside frames. */
async function getSelectionText(tabId) {
  try {
    const results = await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (window.getSelection()?.toString() ?? "").trim(),
    });
    const hit = results.map((r) => r.result).find((t) => t && t.length);
    return hit ?? "";
  } catch {
    return "";
  }
}

async function toTab(tabId, msg) {
  try {
    await api.tabs.sendMessage(tabId, msg);
  } catch {
    /* overlay not present on this page; nothing to update */
  }
}

// ---------------------------------------------------------------------- playback

// Chrome: an offscreen document, because a service worker has no DOM.
// Firefox: the background page itself, which does.
async function ensureOffscreen() {
  const existing = await api.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length) return;
  await api.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Plays locally synthesized speech for the selected text.",
  });
}

function getLocalPlayer() {
  if (!localPlayer) localPlayer = new ClarkPlayer((msg) => handleReport(msg));
  return localPlayer;
}

async function toPlayer(msg) {
  if (HAS_OFFSCREEN) {
    await ensureOffscreen();
    return api.runtime.sendMessage({ ...msg, target: "offscreen" });
  }
  const player = getLocalPlayer();
  if (msg.type === "play") return player.start(msg.server, msg.job);
  if (msg.type === "control") return player.control(msg.action);
}

// ---------------------------------------------------------------------- reading

async function readSelection(tabId, fallbackText) {
  const settings = await getSettings();
  const hasOverlay = await ensureContent(tabId);
  const text = (await getSelectionText(tabId)) || (fallbackText ?? "").trim();

  if (!text) {
    if (hasOverlay) await toTab(tabId, { type: "cr-error", message: "Nothing selected." });
    return;
  }

  await saveState({ tabId, playing: false, index: 0, count: 0, jobId: null });
  if (hasOverlay) await toTab(tabId, { type: "cr-status", state: "preparing" });

  let job;
  try {
    const res = await fetch(`${settings.server}/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: settings.voice, speed: settings.speed }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    job = await res.json();
  } catch (err) {
    // A blocked host permission and a stopped server both surface as a TypeError, and
    // on Firefox the permission is the likelier of the two.
    const offline = err instanceof TypeError;
    await toTab(tabId, {
      type: "cr-error",
      message: offline
        ? "Cannot reach the ClarkReader server. Start it with server/run.sh, and on Firefox allow access to 127.0.0.1 from the toolbar popup."
        : `Could not prepare audio: ${err.message}`,
    });
    return;
  }

  await saveState({ jobId: job.id, count: job.count, index: 0, playing: true });
  await toPlayer({ type: "play", server: settings.server, job });
  if (hasOverlay) {
    await toTab(tabId, {
      type: "cr-start",
      count: job.count,
      chunks: job.chunks,
      voice: job.voice,
    });
  }
}

async function control(action) {
  await loadState();
  if (!state.jobId && HAS_OFFSCREEN) return;
  await toPlayer({ type: "control", action });
}

// ---------------------------------------------------------------------- routing

/** Player progress, however it arrived — by message from Chrome's offscreen document
 *  or by direct callback from Firefox's in-process player. */
async function handleReport(msg) {
  if (msg.type === "cr-progress") {
    await loadState();
    await saveState({ index: msg.index, playing: msg.state === "playing" });
    if (state.tabId != null) await toTab(state.tabId, msg);
    return;
  }
  if (msg.type === "cr-ended" || msg.type === "cr-stopped") {
    await loadState();
    const tabId = state.tabId;
    await saveState({ jobId: null, playing: false, index: 0, count: 0 });
    if (tabId != null) await toTab(tabId, { type: "cr-ended" });
    return;
  }
  if (msg.type === "cr-playback-error") {
    await loadState();
    if (state.tabId != null) {
      await toTab(state.tabId, { type: "cr-error", message: msg.message });
    }
  }
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === "offscreen") return; // bound for the player, not for us

  if (msg?.type === "cr-control") {
    control(msg.action);
    return;
  }

  if (msg?.type?.startsWith("cr-") && msg.type !== "cr-query" && msg.type !== "cr-read-active") {
    handleReport(msg);
    return;
  }

  // The popup asks for current status to render its controls.
  if (msg?.type === "cr-query") {
    loadState().then((s) => sendResponse(s));
    return true;
  }

  // The popup can start a read on the active tab.
  if (msg?.type === "cr-read-active") {
    (async () => {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) await readSelection(tab.id);
      sendResponse({ ok: true });
    })();
    return true;
  }
});
