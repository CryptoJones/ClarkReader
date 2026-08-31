"""ClarkReader TTS server — a warm, local Kokoro process the browser talks to.

Why a server and not a subprocess per request: importing kokoro and building the
pipeline costs ~7s, while synthesizing a sentence costs ~0.08s. Paying the 7s once
at startup is the whole difference between "instant" and "unusable" for a
read-my-selection tool.

Protocol
    GET  /health              -> {ok, voice, speed, backend, warm}
    GET  /voices              -> {voices: [...], default}
    POST /prepare {text,...}  -> {id, count, chunks:[{i,text}]}
    GET  /chunk/<id>/<i>      -> audio/wav for one sentence

The split into prepare + per-chunk fetch exists so playback can start after the
FIRST sentence is synthesized rather than the last. The extension queues chunks
through the Web Audio API and prefetches ahead, so a long article starts reading
in well under a second and never gaps between sentences.
"""
from __future__ import annotations

import argparse
import io
import json
import logging
import os
import re
import threading
import time
import uuid
import wave
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

SAMPLE_RATE = 24_000
DEFAULT_VOICE = "bf_emma"   # CryptoJones's house narration voice (UK female)
DEFAULT_SPEED = 0.88        # the house pace, matching the OCW/Math-for-ML catalogue

# Kokoro's text encoder tops out around 510 phonemes. Sentences longer than this many
# characters get split further at clause boundaries; past that, hard-wrapped on words.
MAX_CHARS = 320

# Jobs are held only long enough to be played. A reader who selects text every few
# seconds should not grow the process without bound.
MAX_JOBS = 64

log = logging.getLogger("clarkreader")


# --------------------------------------------------------------------------- text

# Abbreviations are expanded to words BEFORE sentence splitting rather than being
# protected during it. That kills two bugs at once: "Dr." no longer ends a sentence,
# and the initialism collapse below cannot turn "e.g." into "eg" (which Kokoro reads
# aloud as "egg").
_EXPANSIONS = [
    (r"\be\.g\.", "for example"),
    (r"\bi\.e\.", "that is"),
    (r"\betc\.", "et cetera"),
    (r"\bvs\.?(?=\s)", "versus"),
    (r"\bDr\.", "Doctor"),
    (r"\bProf\.", "Professor"),
    (r"\bMr\.", "Mister"),
    (r"\bMrs\.", "Missus"),
    (r"\bMs\.", "Miz"),
    (r"\bJr\.", "Junior"),
    (r"\bSr\.", "Senior"),
    (r"\bFig\.", "Figure"),
    (r"\bapprox\.", "approximately"),
]

# "St." genuinely needs context: "St. Louis" is Saint, "Main St." is Street. The word
# BEFORE it discriminates better than the word after — street names are capitalized
# proper nouns ("Elm St."), while Saint is preceded by a preposition or nothing at all
# ("in St. Louis"). Looking ahead instead cannot tell "St. Then" from "St. Thomas".
_ST_STREET = re.compile(r"\b([A-Z][a-z]+)\s+St\.")
_ST_SAINT = re.compile(r"\bSt\.")

# Remaining period-separated initialisms ("A.I.", "U.S.A.") make Kokoro pause between
# letters, so the periods come out. A trailing period is kept only when a capitalized
# word follows, which is the case where it was almost certainly ending a sentence.
_INITIALISM = re.compile(r"\b(?:[A-Za-z]\.){2,}")

# Safety net for anything the expansions missed. These lookbehinds include the period,
# because at the candidate split point the preceding characters are "r." — checking for
# "Dr" alone never matches and the guard silently does nothing.
_ABBREV = (r"(?<!\bMr\.)(?<!\bMrs\.)(?<!\bMs\.)(?<!\bDr\.)(?<!\bSt\.)"
           r"(?<!\bProf\.)(?<!\bInc\.)(?<!\bvs\.)(?<!\bNo\.)"
           r"(?<!\b\d\.)(?<!\b\d\d\.)")
_SENT_END = re.compile(_ABBREV + r"(?<=[.!?])[\"')\]]*\s+")
_CLAUSE = re.compile(r"(?<=[,;:])\s+")


def _keeps_period(m: re.Match) -> str:
    """A period survives when a capitalized word follows, or at the end of the text —
    both are cases where it was ending a sentence rather than marking an abbreviation.
    Dropping the final one costs the closing pause on the last thing read aloud."""
    tail = m.string[m.end():]
    return "." if (not tail.strip() or re.match(r"\s+[A-Z]", tail)) else ""


def _street(m: re.Match) -> str:
    return f"{m.group(1)} Street{_keeps_period(m)}"


def _collapse_initialism(m: re.Match) -> str:
    return m.group(0).replace(".", "") + _keeps_period(m)


def normalize(text: str) -> str:
    """Flatten selection whitespace and defuse the things Kokoro reads badly.

    Soft hyphens, zero-width characters and smart quotes come along with almost every
    web selection and turn into audible garbage if left in. Abbreviations are spoken
    out in full, which reads better aloud and keeps them from faking sentence ends.
    """
    text = text.replace("\u00ad", "").replace("\u200b", "").replace("\ufeff", "")
    text = text.replace("\u2019", "'").replace("\u2018", "'")
    text = text.replace("\u201c", '"').replace("\u201d", '"')
    text = text.replace("\u2014", " - ").replace("\u2013", "-")
    # Hyphenation left over from PDF/column layouts: "inter-\nnational" -> "international"
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    for pattern, replacement in _EXPANSIONS:
        text = re.sub(pattern, replacement, text)
    text = _ST_STREET.sub(_street, text)
    text = _ST_SAINT.sub("Saint", text)
    text = _INITIALISM.sub(_collapse_initialism, text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def split_sentences(text: str) -> list[str]:
    """Split into synthesis chunks: sentences, subdivided if they exceed MAX_CHARS."""
    out: list[str] = []
    for sent in _SENT_END.split(text):
        sent = sent.strip()
        if not sent:
            continue
        if len(sent) <= MAX_CHARS:
            out.append(sent)
            continue
        # Too long for one pass - rebuild from clauses, then from words if still long.
        buf = ""
        for piece in _CLAUSE.split(sent):
            if len(buf) + len(piece) + 1 <= MAX_CHARS:
                buf = f"{buf} {piece}".strip()
            else:
                if buf:
                    out.append(buf)
                while len(piece) > MAX_CHARS:
                    cut = piece.rfind(" ", 0, MAX_CHARS)
                    cut = cut if cut > 0 else MAX_CHARS
                    out.append(piece[:cut].strip())
                    piece = piece[cut:].strip()
                buf = piece
        if buf:
            out.append(buf)
    return [s for s in out if re.search(r"[A-Za-z0-9]", s)]


def to_wav(audio: np.ndarray) -> bytes:
    """Float32 [-1,1] -> 16-bit mono WAV bytes."""
    clipped = np.clip(audio, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# ------------------------------------------------------------------------- engine

class Engine:
    """One warm Kokoro pipeline per language code, guarded by a lock.

    Kokoro's pipeline is not documented as thread-safe and synthesis is fast enough
    that serializing it costs nothing real — the prefetching client is only ever a
    sentence or two ahead.
    """

    def __init__(self) -> None:
        self._pipelines: dict[str, object] = {}
        self._lock = threading.Lock()
        self.warm = False
        self.voices = self._discover_voices()

    @staticmethod
    def _discover_voices() -> list[str]:
        import glob
        found: set[str] = set()
        for d in glob.glob(os.path.expanduser(
                "~/.cache/huggingface/hub/models--hexgrad--Kokoro-82M/snapshots/*/voices")):
            for pt in glob.glob(os.path.join(d, "*.pt")):
                found.add(os.path.basename(pt)[:-3])
        return sorted(found) or [DEFAULT_VOICE]

    @staticmethod
    def lang_for(voice: str) -> str:
        """Kokoro voices are prefixed by language: a=American, b=British, etc.

        Loading a bf_* voice under lang_code 'a' does not error — it produces mangled
        pronunciation — so this mapping has to be right rather than merely present.
        """
        return voice[0] if voice and voice[0] in "abefhijpz" else "a"

    def _pipeline(self, lang: str):
        if lang not in self._pipelines:
            from kokoro import KPipeline
            log.info("loading Kokoro pipeline (lang_code=%r)", lang)
            t0 = time.time()
            self._pipelines[lang] = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M")
            log.info("pipeline ready in %.1fs", time.time() - t0)
        return self._pipelines[lang]

    def synth(self, text: str, voice: str, speed: float) -> bytes:
        with self._lock:
            pipe = self._pipeline(self.lang_for(voice))
            parts = [a for _, _, a in pipe(text, voice=voice, speed=speed)]
        if not parts:
            raise ValueError(f"no audio produced for {text!r}")
        audio = np.concatenate(parts) if len(parts) > 1 else parts[0]
        return to_wav(np.asarray(audio, dtype=np.float32))

    def warmup(self, voice: str, speed: float) -> None:
        """Pay the model load and the first-inference cost before any request lands."""
        try:
            t0 = time.time()
            self.synth("Ready.", voice, speed)
            self.warm = True
            log.info("warm in %.1fs — voice=%s speed=%s", time.time() - t0, voice, speed)
        except Exception:
            log.exception("warmup failed; first request will pay the load cost")


# --------------------------------------------------------------------------- jobs

class Job:
    __slots__ = ("id", "chunks", "voice", "speed", "audio", "lock", "created")

    def __init__(self, chunks: list[str], voice: str, speed: float) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.chunks = chunks
        self.voice = voice
        self.speed = speed
        self.audio: dict[int, bytes] = {}
        self.lock = threading.Lock()
        self.created = time.time()


class Jobs:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._lock = threading.Lock()

    def create(self, chunks: list[str], voice: str, speed: float) -> Job:
        job = Job(chunks, voice, speed)
        with self._lock:
            self._jobs[job.id] = job
            while len(self._jobs) > MAX_JOBS:
                self._jobs.popitem(last=False)
        return job

    def get(self, jid: str) -> Job | None:
        with self._lock:
            job = self._jobs.get(jid)
            if job is not None:
                self._jobs.move_to_end(jid)
            return job

    def audio(self, job: Job, i: int) -> bytes:
        """Synthesize chunk i, or return it if a prefetch already did.

        The per-job lock means a client that prefetches chunk 2 while the player also
        asks for chunk 2 waits for one synthesis rather than racing into two.
        """
        with job.lock:
            if i not in job.audio:
                job.audio[i] = self.engine.synth(job.chunks[i], job.voice, job.speed)
            return job.audio[i]


# ------------------------------------------------------------------------ handler

class Handler(BaseHTTPRequestHandler):
    server_version = "ClarkReader/1.0"
    protocol_version = "HTTP/1.1"

    engine: Engine
    jobs: Jobs
    voice: str
    speed: float

    def log_message(self, fmt: str, *args) -> None:
        log.debug("%s - %s", self.address_string(), fmt % args)

    # The extension's origin is chrome-extension://<id>, which is not knowable until
    # the unpacked extension is loaded, so the server reflects the origin. It binds
    # to loopback only, so the reachable surface is already this machine.
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: dict) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/health":
            return self._json(200, {
                "ok": True, "backend": "kokoro", "warm": self.engine.warm,
                "voice": self.voice, "speed": self.speed,
            })
        if path == "/voices":
            return self._json(200, {"voices": self.engine.voices, "default": self.voice})
        m = re.fullmatch(r"/chunk/([0-9a-f]{12})/(\d+)", path)
        if m:
            return self._chunk(m.group(1), int(m.group(2)))
        self._json(404, {"error": "not found"})

    def _chunk(self, jid: str, i: int) -> None:
        job = self.jobs.get(jid)
        if job is None:
            return self._json(404, {"error": "unknown or expired job"})
        if not 0 <= i < len(job.chunks):
            return self._json(404, {"error": "chunk out of range"})
        try:
            wav = self.jobs.audio(job, i)
        except Exception as exc:
            log.exception("synthesis failed for chunk %d of %s", i, jid)
            return self._json(500, {"error": str(exc)})
        self._send(200, wav, "audio/wav")

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/prepare":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            return self._json(400, {"error": f"bad request body: {exc}"})

        text = normalize(str(payload.get("text") or ""))
        if not text:
            return self._json(400, {"error": "no text"})

        voice = str(payload.get("voice") or self.voice)
        if voice not in self.engine.voices:
            return self._json(400, {"error": f"unknown voice {voice!r}"})
        try:
            speed = float(payload.get("speed") or self.speed)
        except (TypeError, ValueError):
            speed = self.speed
        speed = min(max(speed, 0.5), 2.0)

        chunks = split_sentences(text)
        if not chunks:
            return self._json(400, {"error": "nothing speakable in selection"})

        job = self.jobs.create(chunks, voice, speed)
        log.info("job %s: %d chunk(s), %d chars, voice=%s speed=%.2f",
                 job.id, len(chunks), len(text), voice, speed)
        self._json(200, {
            "id": job.id, "count": len(chunks), "voice": voice, "speed": speed,
            "chunks": [{"i": i, "text": c} for i, c in enumerate(chunks)],
        })


def main() -> None:
    ap = argparse.ArgumentParser(description="Local Kokoro TTS server for ClarkReader")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8756)
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--speed", type=float, default=DEFAULT_SPEED)
    ap.add_argument("--no-warmup", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    engine = Engine()
    if args.voice not in engine.voices:
        ap.error(f"voice {args.voice!r} not cached locally; have: {', '.join(engine.voices)}")

    Handler.engine = engine
    Handler.jobs = Jobs(engine)
    Handler.voice = args.voice
    Handler.speed = args.speed

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    log.info("ClarkReader listening on http://%s:%d", args.host, args.port)

    if not args.no_warmup:
        threading.Thread(target=engine.warmup, args=(args.voice, args.speed),
                         daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log.info("shutting down")
        httpd.shutdown()


if __name__ == "__main__":
    main()
