#!/usr/bin/env python3
"""Generate the committed PDF fixtures used by lib/pv-pdf.test.js (issue #5).

Pure Python stdlib — hand-rolls the PDF object graph (catalog, page tree,
Helvetica text pages, one image-only page) with correct byte offsets in the
xref table, so pdf.js accepts the files as ordinary PDFs.

Fixtures (checked into the repo; regenerate with
`python3 scripts/make-pdf-fixtures.py` from the repo root):

  tests/fixtures/pdf-sample.pdf      3 pages of real selectable text
  tests/fixtures/pdf-image-only.pdf  1 page containing only an image XObject
                                     (the "scanned PDF" error path)

No encrypted fixture is generated: hand-rolled RC4+MD5 crypto is easy to get
subtly wrong, and the encrypted-PDF error path only depends on pdf.js
throwing PasswordException — the mapping is unit-tested with a synthetic
error instead.
"""
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "tests" / "fixtures"

PAGE_LINES = [
    [
        "PageVoice PDF import fixture.",
        "The quick brown fox jumps over the lazy dog.",
        "Pack my box with five dozen liquor jugs.",
        "How vexingly quick daft zebras jump!",
        "Bright vixens jump; dozy fowl quack.",
        "Sphinx of black quartz, judge my vow.",
    ],
    [
        "Second page of the sample document.",
        "Reading aloud is better with a real listening queue.",
        "Five jumping wizards hex quartz quickly.",
        "Amazingly few discotheques provide jukeboxes.",
        "The jay, pig, fox, zebra and my wolves quack.",
        "Sympathizing would fix Quaker goals.",
    ],
    [
        "Final page: clauses, commas, and periods.",
        "A phrase with a comma, a dash and a period.",
        "Questions work too, do they not?",
        "Numbers like 42 and dates like 1776 are fine.",
        "Spacing survives gaps between text runs.",
        "End of the fixture.",
    ],
]


def pdf_escape(s: str) -> str:
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def text_page_content(lines) -> bytes:
    """One Tj per line, each moved with Td — pdf.js yields one text item per
    line, with EOL semantics between them."""
    out = ["BT", "/F1 12 Tf", "72 720 Td"]
    for i, line in enumerate(lines):
        if i > 0:
            out.append("0 -18 Td")
        out.append(f"({pdf_escape(line)}) Tj")
    out.append("ET")
    return "\n".join(out).encode("latin-1")


def image_page_content() -> bytes:
    # 16x16 grayscale gradient drawn as a 200x200 box — no text operators.
    return b"q 200 0 0 200 200 500 cm /Im0 Do Q"


class PdfBuilder:
    """Minimal PDF writer: numbered objects, xref with real byte offsets."""

    def __init__(self):
        self.objects = {}  # num -> bytes (body between 'N 0 obj' and 'endobj')

    def add(self, num: int, body: bytes):
        self.objects[num] = body

    def add_stream(self, num: int, dict_extra: str, data: bytes):
        body = (f"<< {dict_extra} /Length {len(data)} >>\n"
                "stream\n").encode("latin-1") + data + b"\nendstream"
        self.add(num, body)

    def build(self) -> bytes:
        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = {}
        for num in sorted(self.objects):
            offsets[num] = len(out)
            out += f"{num} 0 obj\n".encode("latin-1")
            out += self.objects[num]
            out += b"\nendobj\n"
        xref_pos = len(out)
        size = max(self.objects) + 1
        out += f"xref\n0 {size}\n".encode("latin-1")
        out += b"0000000000 65535 f \n"
        for num in range(1, size):
            out += f"{offsets[num]:010d} 00000 n \n".encode("latin-1")
        out += (f"trailer\n<< /Size {size} /Root 1 0 R >>\n"
                f"startxref\n{xref_pos}\n%%EOF\n").encode("latin-1")
        return bytes(out)


def build_sample_pdf() -> bytes:
    """3 Helvetica text pages. Object layout:
    1 catalog, 2 pages, 3 font, then per page: page obj + content stream."""
    b = PdfBuilder()
    n_pages = len(PAGE_LINES)
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(n_pages))
    b.add(1, f"<< /Type /Catalog /Pages 2 0 R >>".encode("latin-1"))
    b.add(2, f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode("latin-1"))
    b.add(3, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    for i, lines in enumerate(PAGE_LINES):
        page_num = 4 + 2 * i
        content_num = page_num + 1
        b.add(page_num,
              (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
               f"/Resources << /Font << /F1 3 0 R >> >> "
               f"/Contents {content_num} 0 R >>").encode("latin-1"))
        b.add_stream(content_num, "", text_page_content(lines))
    return b.build()


def build_image_only_pdf() -> bytes:
    """1 page whose only content is an image XObject — no font, no text."""
    b = PdfBuilder()
    b.add(1, b"<< /Type /Catalog /Pages 2 0 R >>")
    b.add(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    b.add(3,
          (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
           b"/Resources << /XObject << /Im0 5 0 R >> >> "
           b"/Contents 4 0 R >>"))
    b.add_stream(4, "", image_page_content())
    image = bytes(range(256))  # 16x16 deterministic gray gradient
    b.add_stream(5,
                 "/Type /XObject /Subtype /Image /Width 16 /Height 16 "
                 "/ColorSpace /DeviceGray /BitsPerComponent 8",
                 image)
    return b.build()


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "pdf-sample.pdf").write_bytes(build_sample_pdf())
    (OUT_DIR / "pdf-image-only.pdf").write_bytes(build_image_only_pdf())
    for f in sorted(OUT_DIR.glob("*.pdf")):
        print(f"wrote {f} ({f.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
