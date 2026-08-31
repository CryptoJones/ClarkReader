// Sentence-queue audio playback, shared by both browsers.
//
// Chunks are fetched and decoded through the Web Audio API rather than handed to an
// <audio> element pointed at a streaming URL. That costs a little more code and buys
// three things: playback starts as soon as the FIRST sentence is synthesized, the
// join between sentences has no gap because the next buffer is already decoded, and
// the player always knows which sentence is being spoken so the overlay can show it.
//
// Where this runs differs by browser — an offscreen document in Chrome, the
// background page in Firefox — so the constructor takes the reporting function
// instead of reaching for a messaging API itself.

const PREFETCH = 2; // sentences kept decoded ahead of the one playing

class ClarkPlayer {
  constructor(report) {
    this.report = report;
    this.ctx = null;
    this.job = null;
    this.server = "";
    this.buffers = new Map();
    this.source = null;
    this.index = 0;
    // Bumped on every stop/restart so callbacks from an abandoned job can tell that
    // they are stale and decline to advance the new one.
    this.token = 0;
  }

  get count() {
    return this.job ? this.job.count : 0;
  }

  async start(server, job) {
    this.stop({ silent: true });
    this.token += 1;
    this.server = server;
    this.job = job;
    this.buffers.clear();
    this.index = 0;
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    await this.playFrom(0, this.token);
  }

  async fetchChunk(i, token) {
    if (this.buffers.has(i)) return this.buffers.get(i);
    const res = await fetch(`${this.server}/chunk/${this.job.id}/${i}`);
    if (!res.ok) throw new Error(`chunk ${i}: ${res.status} ${res.statusText}`);
    const bytes = await res.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(bytes);
    if (token === this.token) this.buffers.set(i, buf);
    return buf;
  }

  prefetch(from, token) {
    for (let i = from; i < Math.min(from + PREFETCH, this.count); i += 1) {
      this.fetchChunk(i, token).catch(() => {});
    }
  }

  async playFrom(i, token) {
    if (token !== this.token || !this.job) return;
    if (i >= this.count) {
      this.teardown();
      this.report({ type: "cr-ended" });
      return;
    }

    this.index = i;
    let buf;
    try {
      buf = await this.fetchChunk(i, token);
    } catch (err) {
      this.teardown();
      this.report({ type: "cr-playback-error", message: err.message });
      return;
    }
    if (token !== this.token) return;

    this.prefetch(i + 1, token);

    const source = this.ctx.createBufferSource();
    source.buffer = buf;
    source.connect(this.ctx.destination);
    source.onended = () => {
      // A source stopped by skip/stop clears its own handler first, so reaching here
      // means this sentence finished on its own.
      if (token === this.token) this.playFrom(i + 1, token);
    };
    this.source = source;
    source.start();

    // Buffers already played are dropped so a long article does not accumulate
    // decoded audio for the whole selection.
    for (const key of this.buffers.keys()) {
      if (key < i) this.buffers.delete(key);
    }

    this.emit(i);
  }

  emit(i) {
    this.report({
      type: "cr-progress",
      index: i,
      total: this.count,
      text: this.job?.chunks[i]?.text ?? "",
      state: this.ctx?.state === "running" ? "playing" : "paused",
    });
  }

  /** Detach the current source without letting its onended advance the queue. */
  cutSource() {
    if (!this.source) return;
    this.source.onended = null;
    try {
      this.source.stop();
    } catch {
      /* already stopped */
    }
    this.source.disconnect();
    this.source = null;
  }

  teardown() {
    this.cutSource();
    this.job = null;
    this.buffers.clear();
    this.index = 0;
  }

  stop({ silent = false } = {}) {
    this.token += 1;
    const had = Boolean(this.job);
    this.teardown();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    if (had && !silent) this.report({ type: "cr-stopped" });
  }

  async toggle() {
    if (!this.ctx || !this.job) return;
    if (this.ctx.state === "running") await this.ctx.suspend();
    else await this.ctx.resume();
    this.emit(this.index);
  }

  async skip(delta) {
    if (!this.job) return;
    const next = this.index + delta;
    if (next < 0 || next >= this.count) return;
    this.cutSource();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    await this.playFrom(next, this.token);
  }

  /** Route a control message. Shared by both browsers' entry points. */
  control(action) {
    if (action === "toggle") return this.toggle();
    if (action === "stop") return this.stop();
    if (action === "next") return this.skip(1);
    if (action === "prev") return this.skip(-1);
  }
}
