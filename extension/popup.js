(async () => {
  const $ = (id) => document.getElementById(id);
  const settings = await getSettings();

  $("server").value = settings.server;
  $("speed").value = settings.speed;
  $("speedVal").textContent = Number(settings.speed).toFixed(2);

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
    } catch {
      dot.className = "dot bad";
      text.textContent = "server not running — see server/run.sh";
      select.innerHTML = "<option>unavailable</option>";
      select.disabled = true;
      $("read").disabled = true;
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

  await refresh();
})();
