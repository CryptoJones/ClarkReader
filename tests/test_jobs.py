"""Job memory: audio is cached only around the chunk being played.

A whole document is hours of audio. Holding every synthesized sentence for the life
of the job would cost hundreds of megabytes; the window here is what makes a long
read safe on a small machine.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
from clarkreader_server import KEEP_BEHIND, Jobs  # noqa: E402


class FakeEngine:
    def __init__(self):
        self.calls = 0

    def synth(self, text, voice, speed):
        self.calls += 1
        return text.encode(), [{"t": text, "s": 0.0, "e": 1.0}]


def test_audio_behind_the_playhead_is_evicted():
    engine = FakeEngine()
    jobs = Jobs(engine)
    job = jobs.create([f"s{i}" for i in range(10)], "bf_emma", 0.88)
    for i in range(10):
        jobs.render(job, i)
    assert set(job.audio) == set(range(10 - KEEP_BEHIND - 1, 10))
    assert set(job.words) == set(job.audio)


def test_skip_back_re_synthesizes_instead_of_failing():
    engine = FakeEngine()
    jobs = Jobs(engine)
    job = jobs.create([f"s{i}" for i in range(10)], "bf_emma", 0.88)
    for i in range(10):
        jobs.render(job, i)
    wav, words = jobs.render(job, 0)
    assert wav == b"s0" and words[0]["t"] == "s0"
    assert engine.calls == 11


def test_prefetch_ahead_is_kept():
    # The client asks for i, i+1 and i+2 together; none of those may be evicted.
    jobs = Jobs(FakeEngine())
    job = jobs.create([f"s{i}" for i in range(10)], "bf_emma", 0.88)
    for i in (5, 6, 7):
        jobs.render(job, i)
    assert {5, 6, 7} <= set(job.audio)
