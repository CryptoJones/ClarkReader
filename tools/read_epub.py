#!/usr/bin/env python3
"""Open an EPUB in the browser so ClarkReader can read it.

Chrome has no EPUB renderer, but an EPUB is a zip of XHTML chapters, so this unpacks
one next to itself and writes three things it can open:

    index.html        cover, title, author and a chapter list
    <chapter>.xhtml   the book's own chapter files, each with prev/next links added
    book.html         every chapter in reading order on one page, for "Read entire
                      document" and its bookmark

Standard library only, so it works wherever the repo was cloned. Usage:

    tools/read_epub.py "Mona Lisa Overdrive.epub"            # unpack and open
    tools/read_epub.py book.epub --out ~/Books/mlo --no-open

Chrome blocks extensions from file:// pages until you allow it once: in
chrome://extensions, ClarkReader > Details > "Allow access to file URLs".
"""
from __future__ import annotations

import argparse
import html
import os
import posixpath
import re
import sys
import webbrowser
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET

NS = {
    "c": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
    "ncx": "http://www.daisy.org/z3986/2005/ncx/",
    "x": "http://www.w3.org/1999/xhtml",
    "epub": "http://www.idpf.org/2007/ops",
}

NAV_CSS = """
<style>
  .clark-nav { display:flex; justify-content:space-between; gap:1em; margin:3em 0 1em;
               padding-top:1em; border-top:1px solid #8884; font:14px system-ui,sans-serif; }
  .clark-nav a { color:inherit; text-decoration:none; opacity:.7 } .clark-nav a:hover { opacity:1 }
</style>"""


@dataclass
class Chapter:
    href: str            # path inside the zip, relative to the zip root
    title: str
    order: int


@dataclass
class Book:
    title: str
    author: str
    opf_dir: str         # directory of the OPF inside the zip ("" or "OEBPS")
    chapters: list[Chapter]
    cover: str | None = None   # zip path of the cover image
    manifest: dict[str, tuple[str, str, str]] = field(default_factory=dict)  # id -> (href, type, props)


# ------------------------------------------------------------------- parsing

def _join(base_dir: str, href: str) -> str:
    """Resolve a manifest href (relative to the OPF's directory) to a zip path."""
    href = unquote(urlsplit(href).path)
    return posixpath.normpath(posixpath.join(base_dir, href)) if base_dir else posixpath.normpath(href)


def parse(zf: zipfile.ZipFile) -> Book:
    container = ET.fromstring(zf.read("META-INF/container.xml"))
    opf_path = container.find(".//c:rootfile", NS).get("full-path")
    opf_dir = posixpath.dirname(opf_path)
    opf = ET.fromstring(zf.read(opf_path))

    def dc(tag: str) -> str:
        el = opf.find(f".//dc:{tag}", NS)
        return (el.text or "").strip() if el is not None else ""

    manifest: dict[str, tuple[str, str, str]] = {}
    for item in opf.findall(".//opf:manifest/opf:item", NS):
        manifest[item.get("id")] = (
            _join(opf_dir, item.get("href")), item.get("media-type", ""), item.get("properties", ""))

    titles = toc_titles(zf, opf, opf_dir, manifest)

    chapters: list[Chapter] = []
    for i, ref in enumerate(opf.findall(".//opf:spine/opf:itemref", NS)):
        if ref.get("linear", "yes") == "no":
            continue
        entry = manifest.get(ref.get("idref"))
        if not entry or "html" not in entry[1]:
            continue
        href = entry[0]
        title = titles.get(href) or first_heading(zf, href) or f"Section {len(chapters) + 1}"
        chapters.append(Chapter(href, title, i))

    cover = None
    for href, mtype, props in manifest.values():
        if "cover-image" in props.split():
            cover = href
    if cover is None:
        meta = opf.find(".//opf:meta[@name='cover']", NS)
        if meta is not None and meta.get("content") in manifest:
            cover = manifest[meta.get("content")][0]

    return Book(dc("title") or "Untitled", dc("creator"), opf_dir, chapters, cover, manifest)


def toc_titles(zf: zipfile.ZipFile, opf: ET.Element, opf_dir: str,
               manifest: dict[str, tuple[str, str, str]]) -> dict[str, str]:
    """Chapter titles from the EPUB 3 nav document, else the EPUB 2 NCX."""
    titles: dict[str, str] = {}
    for href, _, props in manifest.values():
        if "nav" in props.split():
            try:
                nav = ET.fromstring(zf.read(href))
            except (KeyError, ET.ParseError):
                continue
            base = posixpath.dirname(href)
            for a in nav.iter(f"{{{NS['x']}}}a"):
                target = a.get("href")
                text = "".join(a.itertext()).strip()
                if target and text:
                    titles.setdefault(_join(base, target), text)
    if titles:
        return titles
    spine = opf.find(".//opf:spine", NS)
    ncx_id = spine.get("toc") if spine is not None else None
    if ncx_id and ncx_id in manifest:
        try:
            ncx = ET.fromstring(zf.read(manifest[ncx_id][0]))
            base = posixpath.dirname(manifest[ncx_id][0])
            for point in ncx.iter(f"{{{NS['ncx']}}}navPoint"):
                label = point.find("ncx:navLabel/ncx:text", NS)
                content = point.find("ncx:content", NS)
                if label is not None and content is not None and content.get("src"):
                    titles.setdefault(_join(base, content.get("src")), (label.text or "").strip())
        except (KeyError, ET.ParseError):
            pass
    return titles


_HEADING = re.compile(r"<h[1-3][^>]*>(.*?)</h[1-3]>", re.S | re.I)
_BLOCK = re.compile(r"<(?:p|div)\b[^>]*>(.*?)</(?:p|div)>", re.S | re.I)
_TAGS = re.compile(r"<[^>]+>")
MAX_TITLE_CHARS = 60


def first_heading(zf: zipfile.ZipFile, href: str) -> str:
    """A chapter's title from its own markup, when the table of contents has none.

    A real heading wins. Failing that, the first short block of text: converted
    books often carry the chapter title as a bold paragraph ("1 - The Smoke"), and a
    file that opens with a full paragraph is a continuation, which gets no title."""
    try:
        text = zf.read(href).decode("utf-8", "replace")
    except KeyError:
        return ""
    m = _HEADING.search(text)
    if m:
        return html.unescape(_TAGS.sub("", m.group(1))).strip()
    body = _BODY.search(text)
    for block in _BLOCK.finditer(body.group(1) if body else text):
        words = " ".join(html.unescape(_TAGS.sub(" ", block.group(1))).split())
        if not words:
            continue
        return words if len(words) <= MAX_TITLE_CHARS else ""
    return ""


# ------------------------------------------------------------------- writing

_BODY = re.compile(r"<body[^>]*>(.*)</body>", re.S | re.I)
_SCRIPT = re.compile(r"<script\b.*?</script>", re.S | re.I)
_URL_ATTR = re.compile(r"""\b(src|href|xlink:href)=(["'])([^"']*)\2""", re.I)


def body_of(document: str) -> str:
    m = _BODY.search(document)
    inner = m.group(1) if m else document
    return _SCRIPT.sub("", inner)


def relocate(fragment: str, from_dir: str, to_dir: str) -> str:
    """Rewrite relative URLs in a chapter fragment so they resolve from `to_dir`.

    Chapters live wherever the publisher put them (`OEBPS/Text/ch1.xhtml` with images
    at `../Images/`); the whole-book page lives in one place and needs every image
    and stylesheet path recomputed against it. Anchors, absolute and data URLs are
    left alone."""
    def fix(m: re.Match) -> str:
        attr, quote, url = m.groups()
        if not url or url.startswith(("#", "data:", "/")) or "://" in url:
            return m.group(0)
        path, frag = url.split("#", 1) if "#" in url else (url, "")
        resolved = posixpath.normpath(posixpath.join(from_dir, path)) if from_dir else posixpath.normpath(path)
        rel = posixpath.relpath(resolved, to_dir or ".")
        return f"{attr}={quote}{rel}{'#' + frag if frag else ''}{quote}"
    return _URL_ATTR.sub(fix, fragment)


def nav_html(prev: Chapter | None, nxt: Chapter | None, here_dir: str, index_href: str) -> str:
    def link(ch: Chapter | None, label: str) -> str:
        if ch is None:
            return "<span></span>"
        rel = posixpath.relpath(ch.href, here_dir or ".")
        return f'<a href="{html.escape(rel)}">{label}</a>'
    idx = posixpath.relpath(index_href, here_dir or ".")
    return (f'{NAV_CSS}\n<nav class="clark-nav">{link(prev, "&larr; Previous")}'
            f'<a href="{html.escape(idx)}">Contents</a>{link(nxt, "Next &rarr;")}</nav>')


def unpack(epub: Path, out: Path) -> tuple[Book, Path]:
    """Unpack `epub` into `out`, add navigation, write index.html and book.html.

    Returns the book and the path of index.html."""
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(epub) as zf:
        book = parse(zf)
        # Everything in the zip, so stylesheets, fonts and images resolve as published.
        for info in zf.infolist():
            target = out / info.filename
            if info.is_dir() or not _safe(out, target):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(info))

    index_href = posixpath.join(book.opf_dir, "index.html") if book.opf_dir else "index.html"
    book_href = posixpath.join(book.opf_dir, "book.html") if book.opf_dir else "book.html"

    # Chapter files get prev/next/contents links appended, and nothing else changes.
    for i, ch in enumerate(book.chapters):
        path = out / ch.href
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            continue
        prev = book.chapters[i - 1] if i > 0 else None
        nxt = book.chapters[i + 1] if i + 1 < len(book.chapters) else None
        nav = nav_html(prev, nxt, posixpath.dirname(ch.href), index_href)
        text = re.sub(r"</body>", lambda m: nav + "\n</body>", text, count=1, flags=re.I) \
            if re.search(r"</body>", text, re.I) else text + nav
        path.write_text(text, encoding="utf-8")

    # The whole book on one page, every chapter's body in spine order.
    parts = []
    for ch in book.chapters:
        try:
            doc = (out / ch.href).read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            continue
        fragment = relocate(body_of(doc), posixpath.dirname(ch.href), book.opf_dir)
        fragment = re.sub(r"<nav class=\"clark-nav\">.*?</nav>", "", fragment, flags=re.S)
        fragment = fragment.replace(NAV_CSS, "")
        parts.append(f'<section class="clark-chapter" id="ch{ch.order}">\n{fragment}\n</section>')
    heading = html.escape(book.title) + (f" — {html.escape(book.author)}" if book.author else "")
    (out / book_href).write_text(
        "<!doctype html>\n<meta charset=\"utf-8\">\n"
        f"<title>{html.escape(book.title)}</title>\n"
        "<style>body{max-width:42em;margin:2em auto;padding:0 1em;font:18px/1.6 Georgia,serif}"
        ".clark-chapter{margin-bottom:4em}</style>\n"
        f"<h1>{heading}</h1>\n" + "\n".join(parts) + "\n", encoding="utf-8")

    # The contents page.
    items = "\n".join(
        f'<li><a href="{html.escape(posixpath.relpath(ch.href, book.opf_dir or "."))}">'
        f"{html.escape(ch.title)}</a></li>" for ch in book.chapters)
    cover = ""
    if book.cover:
        cover = (f'<img class="cover" src="{html.escape(posixpath.relpath(book.cover, book.opf_dir or "."))}"'
                 f' alt="Cover of {html.escape(book.title)}">')
    (out / index_href).write_text(f"""<!doctype html>
<meta charset="utf-8">
<title>{html.escape(book.title)}</title>
<style>
  body {{ max-width: 42em; margin: 2em auto; padding: 0 1em; font: 17px/1.6 Georgia, serif; }}
  .cover {{ max-width: 240px; float: right; margin: 0 0 1em 2em; box-shadow: 0 6px 20px #0004; }}
  h1 {{ margin-bottom: .2em; }} .by {{ color: #666; margin-top: 0; }}
  .whole {{ display: inline-block; margin: 1em 0; padding: .5em 1em; border: 1px solid #8886;
           border-radius: 8px; color: inherit; text-decoration: none; }}
  ol {{ padding-left: 1.5em; }} li {{ margin: .3em 0; }} a {{ color: inherit; }}
  .hint {{ clear: both; font: 14px system-ui, sans-serif; color: #666; margin-top: 3em; }}
  kbd {{ border: 1px solid #8886; border-radius: 4px; padding: 0 .4em; font: 13px ui-monospace, monospace; }}
</style>
{cover}
<h1>{html.escape(book.title)}</h1>
<p class="by">{html.escape(book.author)}</p>
<a class="whole" href="book.html">Read the whole book on one page</a>
<ol>
{items}
</ol>
<p class="hint">Open a chapter, or the whole book, and press <kbd>Alt</kbd>+<kbd>R</kbd> with nothing
selected to have ClarkReader read it. Stop anywhere; reading the same page again resumes there.</p>
""", encoding="utf-8")
    return book, out / index_href


def _safe(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False  # a zip entry trying to escape the output directory


# ---------------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Unpack an EPUB into pages the browser can open.")
    ap.add_argument("epub", type=Path)
    ap.add_argument("--out", type=Path, help="output directory (default: next to the EPUB)")
    ap.add_argument("--no-open", action="store_true", help="do not open the browser")
    args = ap.parse_args(argv)

    if not args.epub.is_file():
        ap.error(f"{args.epub} is not a file")
    out = args.out or args.epub.with_suffix("")
    try:
        book, index = unpack(args.epub, out)
    except (zipfile.BadZipFile, KeyError, ET.ParseError) as exc:
        ap.error(f"{args.epub.name} does not look like an EPUB: {exc}")

    print(f"{book.title}" + (f" — {book.author}" if book.author else ""))
    print(f"{len(book.chapters)} chapters in {out}")
    print(f"contents: {index}")
    print("Chrome needs one setting to read local files: chrome://extensions > ClarkReader >"
          " Details > \"Allow access to file URLs\".")
    if not args.no_open:
        webbrowser.open(index.resolve().as_uri())
    return 0


if __name__ == "__main__":
    sys.exit(main())
