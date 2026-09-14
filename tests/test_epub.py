"""The EPUB unpacker, against a small synthetic book.

A real EPUB is large and copyrighted; this builds one in a temp dir with the parts
that matter: an OPF with a spine, an NCX for titles, chapters in a subdirectory with
an image one level up, so the path relocation into book.html is exercised.
"""
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import read_epub  # noqa: E402

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

OPF = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title><dc:creator>A. Writer</dc:creator>
    <meta name="cover" content="cov"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cov" href="Images/cover.jpg" media-type="image/jpeg"/>
    <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="Text/notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3" linear="no"/>
  </spine>
</package>"""

NCX = """<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1"><navLabel><text>One: The Beginning</text></navLabel><content src="Text/ch1.xhtml"/></navPoint>
  </navMap>
</ncx>"""

CH1 = """<html xmlns="http://www.w3.org/1999/xhtml"><head><title>1</title></head>
<body><h1>Chapter One</h1><p>First words.</p><img src="../Images/fig.png"/><script>evil()</script></body></html>"""
CH2 = """<html xmlns="http://www.w3.org/1999/xhtml"><head><title>2</title></head>
<body><h2>Chapter &amp; Two</h2><p>Second words.</p></body></html>"""
NOTES = "<html><body><p>Not in the reading order.</p></body></html>"


@pytest.fixture
def epub(tmp_path):
    path = tmp_path / "test.epub"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr("META-INF/container.xml", CONTAINER)
        zf.writestr("OEBPS/content.opf", OPF)
        zf.writestr("OEBPS/toc.ncx", NCX)
        zf.writestr("OEBPS/Images/cover.jpg", b"jpg")
        zf.writestr("OEBPS/Images/fig.png", b"png")
        zf.writestr("OEBPS/Text/ch1.xhtml", CH1)
        zf.writestr("OEBPS/Text/ch2.xhtml", CH2)
        zf.writestr("OEBPS/Text/notes.xhtml", NOTES)
        zf.writestr("../escape.txt", "must not be written")
    return path


def test_spine_order_titles_and_cover(epub, tmp_path):
    book, index = read_epub.unpack(epub, tmp_path / "out")
    assert book.title == "Test Book" and book.author == "A. Writer"
    # Titles: the NCX names chapter 1; chapter 2 falls back to its heading, unescaped;
    # the non-linear notes file is not a chapter at all.
    assert [c.title for c in book.chapters] == ["One: The Beginning", "Chapter & Two"]
    assert book.cover == "OEBPS/Images/cover.jpg"
    assert index == tmp_path / "out" / "OEBPS" / "index.html"


def test_contents_page(epub, tmp_path):
    _, index = read_epub.unpack(epub, tmp_path / "out")
    page = index.read_text()
    assert 'href="Text/ch1.xhtml"' in page and "One: The Beginning" in page
    assert 'src="Images/cover.jpg"' in page
    assert 'href="book.html"' in page


def test_chapters_get_navigation(epub, tmp_path):
    read_epub.unpack(epub, tmp_path / "out")
    ch1 = (tmp_path / "out/OEBPS/Text/ch1.xhtml").read_text()
    ch2 = (tmp_path / "out/OEBPS/Text/ch2.xhtml").read_text()
    assert 'href="ch2.xhtml">Next' in ch1 and "Previous" not in ch1.split("clark-nav")[1].split("</nav>")[0].replace("<span></span>", "")
    assert 'href="ch1.xhtml">&#8592; Previous' in ch2
    assert 'href="../index.html">Contents' in ch1
    assert ch1.count("</body>") == 1, "the nav goes inside the body"


def test_nav_uses_xml_safe_entities(epub, tmp_path):
    # The nav is injected into the book's own .xhtml chapters, which Firefox parses
    # as strict XML. Named entities like &larr;/&rarr; are undefined there and abort
    # the parse; every generated chapter must stay well-formed XML.
    import xml.dom.minidom as minidom

    read_epub.unpack(epub, tmp_path / "out")
    for xhtml in (tmp_path / "out").rglob("*.xhtml"):
        minidom.parseString(xhtml.read_bytes())


def test_whole_book_relocates_paths_and_drops_scripts(epub, tmp_path):
    read_epub.unpack(epub, tmp_path / "out")
    book = (tmp_path / "out/OEBPS/book.html").read_text()
    assert book.index("First words.") < book.index("Second words.")
    assert "Not in the reading order" not in book
    # ../Images/fig.png from Text/ becomes Images/fig.png from OEBPS/.
    assert 'src="Images/fig.png"' in book
    assert "evil()" not in book
    assert "clark-nav" not in book, "chapter navigation does not belong on the one-page book"
    assert "<title>Test Book</title>" in book


def test_zip_entries_cannot_escape_the_output_directory(epub, tmp_path):
    read_epub.unpack(epub, tmp_path / "out")
    assert not (tmp_path / "escape.txt").exists()


def test_relocate_leaves_absolute_and_anchor_urls_alone():
    frag = '<a href="#note"></a><a href="https://x.test/p"></a><img src="data:image/png;base64,AA"/>'
    assert read_epub.relocate(frag, "OEBPS/Text", "OEBPS") == frag
    assert read_epub.relocate('<a href="ch2.xhtml#s2">', "OEBPS/Text", "OEBPS") == '<a href="Text/ch2.xhtml#s2">'


def test_title_falls_back_to_a_short_first_block(tmp_path):
    # Converted books often carry the chapter title as a bold paragraph, not a heading;
    # a file that opens with a full paragraph is a continuation and gets no title.
    path = tmp_path / "t.epub"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("META-INF/container.xml", CONTAINER)
        zf.writestr("OEBPS/content.opf", OPF.replace('<spine toc="ncx">', "<spine>"))
        zf.writestr("OEBPS/Text/ch1.xhtml",
                    '<html><body><br/><p class="x"><span class="bold">1 - The Smoke</span></p>'
                    "<p>The ghost was her father's parting gift.</p></body></html>")
        zf.writestr("OEBPS/Text/ch2.xhtml",
                    "<html><body><p>" + "A long opening paragraph that runs on. " * 4 + "</p></body></html>")
        zf.writestr("OEBPS/Text/notes.xhtml", NOTES)
    with zipfile.ZipFile(path) as zf:
        assert read_epub.first_heading(zf, "OEBPS/Text/ch1.xhtml") == "1 - The Smoke"
        assert read_epub.first_heading(zf, "OEBPS/Text/ch2.xhtml") == ""
