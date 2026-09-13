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
//
// Word timing rides along with each chunk. The server reports where every word
// starts and ends in the audio, and each progress report carries that list plus how
// far into the chunk playback is and the wall-clock moment that was true. The
// overlay runs its own clock from there, so the word being spoken is shown without
// a message per word crossing two process boundaries.

const PREFETCH = 2; // sentences kept decoded ahead of the one playing
const MAX_FAILURES = 3; // consecutive bad sentences tolerated before giving up

/** Even spacing for a server that reports no timings (a non-English voice, or an
 *  older build). Each word takes a share of the chunk proportional to its length,
 *  which tracks speech far better than one slot per word: "a" is not "extraordinary". */
function estimateWords(text, duration) {
  const parts = (text || "").split(/\s+/).filter(Boolean);
  const weights = parts.map((w) => w.length + 1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  return parts.map((w, i) => {
    const s = t;
    t += (weights[i] / total) * duration;
    return { t: w, s: Math.round(s * 1000) / 1000, e: Math.round(t * 1000) / 1000 };
  });
}

class ClarkPlayer {
  constructor(report) {
    this.report = report;
    this.ctx = null;
    this.job = null;
    this.server = "";
    this.buffers = new Map();
    this.source = null;
    this.index = 0;
    // AudioContext time at which the current chunk's source started; the context
    // clock freezes while suspended, so currentTime minus this is always the
    // position inside the chunk, paused or not.
    this.startedAt = 0;
    // Consecutive sentences that failed to synthesize or decode. One bad sentence in
    // a long document is skipped; a run of them means the server is gone.
    this.failures = 0;
    // Bumped on every stop/restart so callbacks from an abandoned job can tell that
    // they are stale and decline to advance the new one.
    this.token = 0;
  }

  get count() {
    return this.job ? this.job.count : 0;
  }

  /** Play `job` from sentence `from`: 0 for a fresh read, a bookmark to resume. */
  async start(server, job, from = 0) {
    this.stop({ silent: true });
    this.token += 1;
    this.server = server;
    this.job = job;
    this.buffers.clear();
    this.index = 0;
    this.failures = 0;
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const first = Math.min(Math.max(0, from | 0), Math.max(0, this.count - 1));
    await this.playFrom(first, this.token);
  }

  async fetchChunk(i, token) {
    if (this.buffers.has(i)) return this.buffers.get(i);
    const tail = `/${this.job.id}/${i}`;
    // Timings are optional: a failure here degrades to even spacing, never to silence.
    const wordsReq = fetch(`${this.server}/words${tail}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const res = await fetch(`${this.server}/chunk${tail}`);
    if (!res.ok) throw new Error(`chunk ${i}: ${res.status} ${res.statusText}`);
    const bytes = await res.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(bytes);
    const timing = await wordsReq;
    const words = timing?.words?.length
      ? timing.words
      : estimateWords(this.job.chunks[i]?.text, buf.duration);
    const chunk = { buf, words };
    if (token === this.token) this.buffers.set(i, chunk);
    return chunk;
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
    let chunk;
    try {
      chunk = await this.fetchChunk(i, token);
    } catch (err) {
      if (token !== this.token) return;
      this.failures += 1;
      if (this.failures <= MAX_FAILURES && i + 1 < this.count) {
        this.report({ type: "cr-skipped", index: i, message: err.message });
        return this.playFrom(i + 1, token);
      }
      this.teardown();
      this.report({ type: "cr-playback-error", message: err.message });
      return;
    }
    if (token !== this.token) return;
    this.failures = 0;

    this.prefetch(i + 1, token);

    const source = this.ctx.createBufferSource();
    source.buffer = chunk.buf;
    source.connect(this.ctx.destination);
    source.onended = () => {
      // A source stopped by skip/stop clears its own handler first, so reaching here
      // means this sentence finished on its own.
      if (token === this.token) this.playFrom(i + 1, token);
    };
    this.source = source;
    source.start();
    this.startedAt = this.ctx.currentTime;

    // Buffers already played are dropped so a long article does not accumulate
    // decoded audio for the whole selection.
    for (const key of this.buffers.keys()) {
      if (key < i) this.buffers.delete(key);
    }

    this.emit(i);
  }

  emit(i) {
    const chunk = this.buffers.get(i);
    this.report({
      type: "cr-progress",
      index: i,
      total: this.count,
      text: this.job?.chunks[i]?.text ?? "",
      state: this.ctx?.state === "running" ? "playing" : "paused",
      words: chunk?.words ?? [],
      duration: chunk?.buf?.duration ?? 0,
      position: this.ctx ? Math.max(0, this.ctx.currentTime - this.startedAt) : 0,
      at: Date.now(),
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
