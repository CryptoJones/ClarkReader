import { DEFAULTS, getSettings } from "./config.js";

const MENU_ID = "clarkreader-read-selection";

// The service worker is killed and restarted freely, so anything a later control
// command needs to know is mirrored into session storage rather than kept only here.
let state = { tabId: null, jobId: null, index: 0, count: 0, playing: false };

async function loadState() {
  const { crState } = await chrome.storage.session.get("crState");
  if (crState) state = crState;
  return state;
}
async function saveState(patch) {
  state = { ...state, ...patch };
  await chrome.storage.session.set({ crState: state });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Read aloud with Emma",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab?.id != null) {
    // info.selectionText is truncated by Chrome, so it is only the fallback.
    readSelection(tab.id, info.selectionText);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (command === "read-selection" && tab?.id != null) return readSelection(tab.id);
  if (command === "toggle-pause") return control("toggle");
  if (command === "stop-reading") return control("stop");
});

// ---------------------------------------------------------------- page plumbing

/** Inject the overlay script once per page. Re-injection is guarded inside it. */
async function ensureContent(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch (err) {
    // chrome:// pages, the Web Store, and PDFs refuse injection. Reading still works;
    // there is just nowhere to draw the player.
    console.warn("ClarkReader: no overlay on this page —", err.message);
    return false;
  }
}

/** Read the live selection out of the page, including inside frames. */
async function getSelectionText(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
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
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    /* overlay not present on this page; nothing to update */
  }
}

// ------------------------------------------------------------------- offscreen

// MV3 service workers have no DOM and cannot play audio, so playback lives in an
// offscreen document that the worker drives by message.
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Plays locally synthesized speech for the selected text.",
  });
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ ...msg, target: "offscreen" });
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
    const offline = err instanceof TypeError;
    await toTab(tabId, {
      type: "cr-error",
      message: offline
        ? "ClarkReader server is not running. Start it with server/run.sh"
        : `Could not prepare audio: ${err.message}`,
    });
    return;
  }

  await saveState({ jobId: job.id, count: job.count, index: 0, playing: true });
  await toOffscreen({ type: "play", server: settings.server, job });
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
  if (!state.jobId) return;
  await toOffscreen({ type: "control", action });
}

// ---------------------------------------------------------------------- routing

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === "offscreen") return; // not ours

  if (msg?.type === "cr-control") {
    control(msg.action);
    return;
  }

  // Progress reports coming back from the offscreen player.
  if (msg?.type === "cr-progress") {
    (async () => {
      await loadState();
      await saveState({ index: msg.index, playing: msg.state === "playing" });
      if (state.tabId != null) await toTab(state.tabId, msg);
    })();
    return;
  }

  if (msg?.type === "cr-ended" || msg?.type === "cr-stopped") {
    (async () => {
      await loadState();
      const tabId = state.tabId;
      await saveState({ jobId: null, playing: false, index: 0, count: 0 });
      if (tabId != null) await toTab(tabId, { type: "cr-ended" });
    })();
    return;
  }

  if (msg?.type === "cr-playback-error") {
    (async () => {
      await loadState();
      if (state.tabId != null) {
        await toTab(state.tabId, { type: "cr-error", message: msg.message });
      }
    })();
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
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) await readSelection(tab.id);
      sendResponse({ ok: true });
    })();
    return true;
  }
});

export { DEFAULTS };
