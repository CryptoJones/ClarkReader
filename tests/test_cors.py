"""Which origins the server will answer across origins.

The extension's origin is only knowable once it is installed, so the server reflects
it — but only if it is an extension. Reflecting any origin would let any web page a
user visits drive their local synthesizer.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
from clarkreader_server import allowed_origin  # noqa: E402


@pytest.mark.parametrize("origin", [
    "chrome-extension://jojjiejplcmhinckkiebfgghegocclak",
    "moz-extension://7a1c9b7e-0000-4000-8000-000000000000",
])
def test_extension_origins_are_reflected(origin):
    assert allowed_origin(origin) == origin


@pytest.mark.parametrize("origin", [
    "https://example.com",
    "http://127.0.0.1:8756",
    "null",
    "",
    None,
    "chrome-extension.evil.com://x",
])
def test_everything_else_is_refused(origin):
    assert allowed_origin(origin) is None
