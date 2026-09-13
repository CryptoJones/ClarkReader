/** Reload the extension if its background is older than the files on disk.
 *
 *  Chrome reads a popup fresh from disk every time it opens, but keeps running the
 *  background worker it loaded at startup — an unpacked extension whose files were
 *  updated is then a new popup talking to an old worker, and the buttons it shows
 *  do things the worker has never heard of. The manifest fetched here comes from
 *  disk; the version the background reports comes from memory. If they differ (or
 *  the background does not answer at all, which an older one cannot), reload, which
 *  re-reads everything. Store installs update atomically and never hit this. */
async function ensureFreshBackground() {
  try {
    const onDisk = (await (await fetch(api.runtime.getURL("manifest.json"))).json()).version;
    const running = await api.runtime.sendMessage({ type: "cr-version" }).catch(() => undefined);
    if (running !== onDisk) {
      document.getElementById("statusText").textContent = "updating ClarkReader…";
      api.runtime.reload();
      return false;
    }
  } catch {
    /* cannot tell; carry on with what we have */
  }
  return true;
}

(async () => {
  const $ = (id) => document.getElementById(id);
  if (!(await ensureFreshBackground())) return;
  const settings = await getSettings();

  $("server").value = settings.server;
  $("speed").value = settings.speed;
  $("speedVal").textContent = Number(settings.speed).toFixed(2);
  $("rsvp").checked = settings.rsvp !== false;

  function save(patch) {
    Object.assign(settings, patch);
    api.storage.sync.set(patch);
  }

  const origin = () => `${settings.server}/*`;

  /** Firefox treats host_permissions under MV3 as opt-in, so a fresh install cannot
   *  reach the server until the user grants it. Chrome grants them at install time,
   *  where this check simply always passes. */
  async function hasHostPermission() {
    try {
      return await api.permissions.contains({ origins: [origin()] });
    } catch {
      return true; // no permissions API to consult; let the fetch be the judge
    }
  }

  async function refresh() {
    const dot = $("dot");
    const text = $("statusText");
    const select = $("voice");

    if (!(await hasHostPermission())) {
      dot.className = "dot bad";
      text.textContent = "needs permission to reach the server";
      $("grant").hidden = false;
      $("read").disabled = true;
      $("readPage").disabled = true;
      $("resume").disabled = true;
      select.disabled = true;
      return;
    }
    $("grant").hidden = true;

    try {
      const [health, voices] = await Promise.all([
        fetch(`${settings.server}/health`).then((r) => r.json()),
        fetch(`${settings.server}/voices`).then((r) => r.json()),
      ]);
      dot.className = "dot ok";
      text.textContent = health.warm
        ? `${health.backend} ready`
        : `${health.backend} loading model…`;

      select.innerHTML = "";
      for (const v of voices.voices) {
        const opt = document.createElement("option");
        opt.value = v;
        // bf_emma is the house voice; naming it plainly beats making the user decode
        // Kokoro's language/gender prefixes to find the one they already chose.
        opt.textContent = v === "bf_emma" ? "Emma (UK female) — house voice" : v;
        select.append(opt);
      }
      select.value = voices.voices.includes(settings.voice) ? settings.voice : voices.default;
      select.disabled = false;
      $("read").disabled = false;
      $("readPage").disabled = false;
      $("resume").disabled = false;
    } catch {
      dot.className = "dot bad";
      text.textContent = "server not running — see the setup guide below";
      select.innerHTML = "<option>unavailable</option>";
      select.disabled = true;
      $("read").disabled = true;
      $("readPage").disabled = true;
      $("resume").disabled = true;
    }
  }

  // permissions.request must be called from inside a user gesture, hence the button.
  $("grant").addEventListener("click", async () => {
    try {
      if (await api.permissions.request({ origins: [origin()] })) await refresh();
    } catch (err) {
      $("statusText").textContent = `permission refused: ${err.message}`;
    }
  });

  $("voice").addEventListener("change", (e) => save({ voice: e.target.value }));
  $("rsvp").addEventListener("change", (e) => save({ rsvp: e.target.checked }));
  $("speed").addEventListener("input", (e) => {
    $("speedVal").textContent = Number(e.target.value).toFixed(2);
    save({ speed: Number(e.target.value) });
  });
  $("server").addEventListener("change", (e) => {
    save({ server: e.target.value.trim().replace(/\/+$/, "") || DEFAULTS.server });
    $("server").value = settings.server;
    refresh();
  });
  $("read").addEventListener("click", async () => {
    await api.runtime.sendMessage({ type: "cr-read-active" });
    window.close();
  });
  // "Read entire document" always starts at the top; "Resume" appears only when the
  // page has a bookmark, and names the sentence it would pick up from.
  $("readPage").addEventListener("click", async () => {
    await api.runtime.sendMessage({ type: "cr-read-active", wholePage: true, restart: true });
    window.close();
  });
  $("resume").addEventListener("click", async () => {
    await api.runtime.sendMessage({ type: "cr-read-active", wholePage: true });
    window.close();
  });
  api.runtime.sendMessage({ type: "cr-query-mark" }).then((mark) => {
    if (!mark) return;
    $("resume").textContent = `Resume reading document · ${mark.index + 1} / ${mark.count}`;
    $("resume").hidden = false;
  }).catch(() => {});

  $("help").addEventListener("click", (e) => {
    e.preventDefault();
    api.runtime.sendMessage({ type: "cr-open-help" });
    window.close();
  });

  await refresh();
})();
