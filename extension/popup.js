import { DEFAULTS, getSettings } from "./config.js";

const $ = (id) => document.getElementById(id);
const settings = await getSettings();

$("server").value = settings.server;
$("speed").value = settings.speed;
$("speedVal").textContent = Number(settings.speed).toFixed(2);

function save(patch) {
  Object.assign(settings, patch);
  chrome.storage.sync.set(patch);
}

/** Ping the server and populate the voice list from what it actually has cached. */
async function refresh() {
  const dot = $("dot");
  const text = $("statusText");
  const select = $("voice");
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
    select.value = voices.voices.includes(settings.voice)
      ? settings.voice
      : voices.default;
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
  await chrome.runtime.sendMessage({ type: "cr-read-active" });
  window.close();
});

await refresh();
