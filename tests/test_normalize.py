"""Text normalization and sentence splitting.

These are the rules that decide what Kokoro actually says, and every one of them
exists because a real selection came out wrong without it.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
from clarkreader_server import MAX_CHARS, normalize, split_sentences  # noqa: E402


@pytest.mark.parametrize("raw,expected", [
    # Abbreviations become words, so they cannot masquerade as sentence ends.
    ("Dr. Case waited.", "Doctor Case waited."),
    ("Prof. Ashpool and Mr. Riviera.", "Professor Ashpool and Mister Riviera."),
    # "e.g." must not collapse to "eg", which Kokoro reads aloud as "egg".
    ("Cheap, e.g. free.", "Cheap, for example free."),
    ("Slow, i.e. patient.", "Slow, that is patient."),
    ("Cats, dogs, etc.", "Cats, dogs, et cetera."),
    ("Tokyo vs. Chiba.", "Tokyo versus Chiba."),
    # Period-separated initialisms make Kokoro pause between the letters.
    ("The A.I. waited.", "The AI waited."),
    ("Born in the U.S.A.", "Born in the USA."),
])
def test_expansions(raw, expected):
    assert normalize(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    # A capitalized word before "St." means a street name; otherwise a saint.
    ("42 Main St. is nice.", "42 Main Street is nice."),
    ("Turn onto Elm St. Then stop.", "Turn onto Elm Street. Then stop."),
    ("St. Peter waited.", "Saint Peter waited."),
    # The hard one: the first is a street, the second a saint.
    ("Meet at 42 Main St. St. Louis is far.",
     "Meet at 42 Main Street. Saint Louis is far."),
])
def test_street_versus_saint(raw, expected):
    assert normalize(raw) == expected


def test_strips_web_selection_debris():
    raw = "The­sky “above” the​ port — tuned to it’s channel"
    out = normalize(raw)
    for junk in ("­", "​", "“", "”", "’", "—"):
        assert junk not in out
    assert "it's" in out


def test_rejoins_pdf_hyphenation():
    assert "international" in normalize("an inter-\nnational treaty")


@pytest.mark.parametrize("raw,count", [
    ("One. Two. Three.", 3),
    # A decimal is not a sentence end.
    ("It costs 3.50 today.", 1),
    # Neither is a numbered heading.
    ("Section 1. Overview", 1),
    # Nor an abbreviation, which by now is a word anyway.
    ("Dr. Case walked in. He said nothing.", 2),
])
def test_sentence_counts(raw, count):
    assert len(split_sentences(normalize(raw))) == count


def test_long_sentence_is_subdivided():
    # Kokoro's encoder tops out near 510 phonemes, so nothing may exceed MAX_CHARS.
    clause = "a stretch of words that keeps going and going without stopping"
    raw = ", ".join([clause] * 12) + "."
    chunks = split_sentences(normalize(raw))
    assert len(chunks) > 1
    assert all(len(c) <= MAX_CHARS for c in chunks)


def test_drops_unspeakable_chunks():
    # Punctuation-only fragments would otherwise become silent or garbled chunks.
    assert split_sentences(normalize("Hello. ... !!! Goodbye.")) == ["Hello.", "Goodbye."]


def test_empty_selection_yields_nothing():
    assert split_sentences(normalize("   \n\t  ")) == []
