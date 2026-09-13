// Chrome loads this as a classic service worker and pulls its dependencies in with
// importScripts. Firefox lists them ahead of this file in manifest.background.scripts,
// so they are already in scope and importScripts does not exist.
if (typeof importScripts === "function") importScripts("api.js", "config.js");

const MENU_ID = "clarkreader-read-selection";
const MENU_PAGE_ID = "clarkreader-read-page";

// A novel is 400-600k characters and reads in six to eight hours, and memory on both
// ends is bounded per sentence rather than per document, so the cap only needs to
// stop the pathological: a page that is a database dump, not something to listen to.
const MAX_PAGE_CHARS = 1_000_000;

// The service worker is killed and restarted freely, so anything a later control
// command needs to know is mirrored into session storage rather than kept only here.
let state = { tabId: null, jobId: null, index: 0, count: 0, playing: false,
              pageKey: null, title: "" };

// Bookmarks for whole-document reads, keyed by page URL without its fragment. Kept in
// local storage (sync's per-item quota is too small for a list of URLs) and capped, so
// a reader who samples a hundred pages does not accumulate a hundred stale marks.
const MAX_MARKS = 100;

async function getMarks() {
  const { crMarks } = await api.storage.local.get("crMarks");
  return crMarks ?? {};
}
async function setMark(key, mark) {
  const marks = await getMarks();
  marks[key] = { ...mark, at: Date.now() };
  const keys = Object.keys(marks).sort((a, b) => marks[b].at - marks[a].at);
  for (const k of keys.slice(MAX_MARKS)) delete marks[k];
  await api.storage.local.set({ crMarks: marks });
}
async function clearMark(key) {
  const marks = await getMarks();
  if (key in marks) {
    delete marks[key];
    await api.storage.local.set({ crMarks: marks });
  }
}

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

const HELP_URL = "welcome.html";

/** The setup guide, in its own tab. The extension is useless without the local
 *  server, so this opens on first install and from every "cannot reach it" error. */
async function openHelp() {
  try {
    await api.tabs.create({ url: api.runtime.getURL(HELP_URL) });
  } catch (err) {
    console.warn("ClarkReader: could not open the setup guide —", err.message);
  }
}

api.runtime.onInstalled.addListener((details) => {
  if (details?.reason === "install") openHelp();
  api.contextMenus.create({
    id: MENU_ID,
    title: "Read aloud with Emma",
    contexts: ["selection"],
  });
  api.contextMenus.create({
    id: MENU_PAGE_ID,
    title: "Read entire document with Emma",
    contexts: ["page", "selection"],
  });
});

api.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id == null) return;
  if (info.menuItemId === MENU_ID) {
    // info.selectionText is truncated by the browser, so it is only the fallback.
    readSelection(tab.id, info.selectionText);
  } else if (info.menuItemId === MENU_PAGE_ID) {
    readSelection(tab.id, "", { wholePage: true });
  }
});

api.commands.onCommand.addListener(async (command) => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (command === "read-selection" && tab?.id != null) return readSelection(tab.id);
  if (command === "toggle-pause") return control("toggle");
  if (command === "stop-reading") return control("stop");
  // The overlay owns its own size; the shortcut just reaches it in the active tab.
  if (command === "toggle-maximize" && tab?.id != null) return toTab(tab.id, { type: "cr-toggle-max" });
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

/** The page's main content, as Reader View would show it.
 *
 * Readability is injected on demand, like the overlay, and runs against a clone so
 * the page itself is untouched. It lands in the extension's isolated world, where
 * the extracting function that follows can see it. A page it cannot make sense of
 * (a search results page, a dashboard) falls back to the visible body text, which
 * is better than reading nothing. */
async function getPageText(tabId) {
  try {
    await api.scripting.executeScript({ target: { tabId }, files: ["vendor/Readability.js"] });
    const [hit] = await api.scripting.executeScript({
      target: { tabId },
      func: (limit) => {
        let title = document.title || "";
        let text = "";
        try {
          // Readability clones and walks the whole tree. On a page with tens of
          // thousands of nodes that is a memory spike a Chromebook cannot afford,
          // and such a page is not an article anyway: take the visible text as is.
          if (document.getElementsByTagName("*").length > 40_000) throw new Error("too large");
          const article = new Readability(document.cloneNode(true)).parse();
          if (article?.textContent?.trim()) {
            title = article.title || title;
            text = article.textContent;
          }
        } catch {
          /* fall through to the body text */
        }
        if (!text.trim()) text = document.body?.innerText ?? "";
        // Readability keeps paragraph breaks as newlines; the server flattens
        // whitespace, so only leading and trailing space and the hard cap matter.
        text = text.trim();
        if (title.trim()) text = `${title.trim()}. ${text}`;
        const key = location.origin + location.pathname + location.search;
        return { title, text: text.slice(0, limit), key };
      },
      args: [MAX_PAGE_CHARS],
    });
    return hit?.result ?? { title: "", text: "", key: null };
  } catch {
    return { title: "", text: "", key: null };
  }
}

/** Where a whole-document read of the active tab would resume, for the popup. */
async function markForTab(tabId) {
  try {
    const [hit] = await api.scripting.executeScript({
      target: { tabId },
      func: () => location.origin + location.pathname + location.search,
    });
    const key = hit?.result;
    const mark = key ? (await getMarks())[key] : null;
    return mark ? { key, ...mark } : null;
  } catch {
    return null;
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
  if (msg.type === "play") return player.start(msg.server, msg.job, msg.from);
  if (msg.type === "control") return player.control(msg.action);
}

// ---------------------------------------------------------------------- reading

/** Read the selection, or with `wholePage` (or no selection at all) the page's
 *  main content. Alt+R therefore reads whatever is selected, and the whole article
 *  when nothing is.
 *
 *  A whole document resumes from its bookmark unless `restart` is set: the mark is
 *  written after every sentence while it plays and cleared when it finishes, so a
 *  read that was stopped picks up where it left off and a finished one starts over. */
async function readSelection(tabId, fallbackText, { wholePage = false, restart = false } = {}) {
  const settings = await getSettings();
  const hasOverlay = await ensureContent(tabId);
  let text = wholePage ? "" : (await getSelectionText(tabId)) || (fallbackText ?? "").trim();
  let title = "";
  let pageKey = null;

  if (!text) {
    if (hasOverlay) await toTab(tabId, { type: "cr-status", state: "preparing" });
    ({ title, text, key: pageKey } = await getPageText(tabId));
  }
  if (!text) {
    if (hasOverlay) await toTab(tabId, { type: "cr-error", message: "Nothing to read on this page." });
    return;
  }

  await saveState({ tabId, playing: false, index: 0, count: 0, jobId: null, pageKey, title });
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
        ? "Cannot reach the ClarkReader server. It runs on your own machine and has to be started first."
        : `Could not prepare audio: ${err.message}`,
      help: offline,
    });
    return;
  }

  // Resume only if the page still splits into the same number of sentences; a
  // different count means the content changed and the old position is meaningless.
  let from = 0;
  if (pageKey) {
    const mark = restart ? null : (await getMarks())[pageKey];
    if (mark && mark.count === job.count && mark.index < job.count) from = mark.index;
    else await clearMark(pageKey);
  }

  await saveState({ jobId: job.id, count: job.count, index: from, playing: true });
  await toPlayer({ type: "play", server: settings.server, job, from });
  if (hasOverlay) {
    await toTab(tabId, {
      type: "cr-start",
      count: job.count,
      voice: job.voice,
      rsvp: settings.rsvp,
      title,
      from,
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
    if (state.pageKey) {
      await setMark(state.pageKey, { index: msg.index, count: msg.total, title: state.title });
    }
    if (state.tabId != null) await toTab(state.tabId, msg);
    return;
  }
  if (msg.type === "cr-ended" || msg.type === "cr-stopped") {
    await loadState();
    const { tabId, pageKey } = state;
    // Finishing clears the bookmark; stopping leaves it so the read can resume.
    if (msg.type === "cr-ended" && pageKey) await clearMark(pageKey);
    await saveState({ jobId: null, playing: false, index: 0, count: 0, pageKey: null, title: "" });
    if (tabId != null) await toTab(tabId, { type: "cr-ended" });
    return;
  }
  if (msg.type === "cr-skipped") {
    console.warn(`ClarkReader: skipped sentence ${msg.index}: ${msg.message}`);
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

  if (msg?.type === "cr-open-help") {
    openHelp();
    return;
  }

  if (msg?.type?.startsWith("cr-") && !["cr-query", "cr-query-mark", "cr-read-active"].includes(msg.type)) {
    handleReport(msg);
    return;
  }

  // The popup asks for current status to render its controls.
  if (msg?.type === "cr-query") {
    loadState().then((s) => sendResponse(s));
    return true;
  }

  // The popup can start a read on the active tab: the selection, or the whole page
  // (resuming from its bookmark, or from the top with `restart`).
  if (msg?.type === "cr-read-active") {
    (async () => {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) {
        await readSelection(tab.id, "", {
          wholePage: Boolean(msg.wholePage), restart: Boolean(msg.restart),
        });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  // The popup asks whether the active tab has a bookmark to offer resuming.
  if (msg?.type === "cr-query-mark") {
    (async () => {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      sendResponse(tab?.id != null ? await markForTab(tab.id) : null);
    })();
    return true;
  }
});
