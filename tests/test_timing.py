"""Word timings: merging Kokoro's tokens into the words the RSVP window shows.

Kokoro reports where each token starts and ends in the audio it produced, but its
tokens are finer than words on screen: "problem." is "problem" plus ".", joined by an
empty whitespace on the first. These tests pin down how those runs are glued back
together and what happens to the tokens the model gives no timing at all.
"""
import sys
from pathlib import Path
from types import SimpleNamespace as T

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
from clarkreader_server import word_timings  # noqa: E402


def tok(text, whitespace=" ", start=None, end=None):
    return T(text=text, whitespace=whitespace, start_ts=start, end_ts=end)


def test_punctuation_glues_to_its_word():
    words = word_timings([
        tok("Reading", " ", 0.325, 0.7),
        tok("problem", "", 1.05, 1.925),
        tok(".", " ", 1.925, 2.025),
    ])
    assert words == [
        {"t": "Reading", "s": 0.325, "e": 0.7},
        {"t": "problem.", "s": 1.05, "e": 2.025},
    ]


def test_bracketed_word_is_one_word_spanning_all_its_parts():
    words = word_timings([
        tok("(", "", 6.85, 6.9),
        tok("roughly", "", 6.9, 8.05),
        tok(")", "", 8.05, 8.125),
        tok(".", "", None, None),
    ])
    assert words == [{"t": "(roughly).", "s": 6.85, "e": 8.125}]


def test_untimed_runs_are_dropped_not_shown_for_zero_time():
    # A bare dash gets no frames from the model; flashing it would be a blank blink.
    words = word_timings([
        tok("wander", " ", 4.75, 5.075),
        tok("-", " ", None, None),
        tok("3.5", " ", 5.125, 5.95),
    ])
    assert [w["t"] for w in words] == ["wander", "3.5"]


def test_offset_shifts_a_second_pass():
    words = word_timings([tok("later", " ", 0.1, 0.4)], offset=8.275)
    assert words == [{"t": "later", "s": 8.375, "e": 8.675}]


def test_no_tokens_means_no_timings():
    # Languages whose G2P reports nothing; the extension spaces words evenly instead.
    assert word_timings(None) == []
    assert word_timings([]) == []
