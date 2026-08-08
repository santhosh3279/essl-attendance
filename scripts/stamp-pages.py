"""
Adds a footer with page numbers to the generated guide.

The wkhtmltopdf on this machine is built against unpatched Qt, which silently
ignores every --footer-* switch, so the footer is stamped on afterwards instead.

    python3 scripts/stamp-pages.py docs/ESSL-Attendance-Guide.pdf

Needs pypdf and reportlab.
"""

import io
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

FOOTER_LEFT = "ESSL Attendance — Installation and User Guide"
GREY = (0.42, 0.45, 0.50)


def build_overlays(sizes: list[tuple[float, float]]) -> PdfReader:
    """
    All footers in ONE document. Building a separate canvas per page made
    reportlab embed the font once per page and inflated the file eightfold.
    """
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=sizes[0])
    total = len(sizes)

    for index, (width, height) in enumerate(sizes, start=1):
        pdf.setPageSize((width, height))
        # Page 1 is the cover: blank overlay, no footer.
        if index > 1:
            margin = 45
            baseline = 26
            pdf.setFont("Helvetica", 7.5)
            pdf.setFillColorRGB(*GREY)
            pdf.drawString(margin, baseline, FOOTER_LEFT)
            pdf.drawRightString(width - margin, baseline, f"Page {index} of {total}")

            pdf.setStrokeColorRGB(0.85, 0.87, 0.90)
            pdf.setLineWidth(0.4)
            pdf.line(margin, baseline + 9, width - margin, baseline + 9)
        pdf.showPage()

    pdf.save()
    buffer.seek(0)
    return PdfReader(buffer)


def main() -> int:
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/ESSL-Attendance-Guide.pdf")
    if not target.exists():
        print(f"missing {target}", file=sys.stderr)
        return 1

    reader = PdfReader(str(target))
    writer = PdfWriter()
    total = len(reader.pages)

    sizes = [(float(p.mediabox.width), float(p.mediabox.height)) for p in reader.pages]
    overlays = build_overlays(sizes)

    for index, page in enumerate(reader.pages, start=1):
        if index > 1:
            page.merge_page(overlays.pages[index - 1])
        writer.add_page(page)

    # Merging rewrites content streams uncompressed, which inflates the file
    # roughly eightfold. Re-deflate them — only possible once the pages belong
    # to the writer.
    for page in writer.pages:
        page.compress_content_streams()

    # Collapses resources the merge duplicates across pages.
    writer.compress_identical_objects()

    writer.add_metadata(
        {
            "/Title": "ESSL Attendance — Installation and User Guide",
            "/Subject": "Installing, configuring and using the ESSL attendance system",
            "/Keywords": "ESSL, ZKTeco, attendance, biometric, installation, manual",
            "/Creator": "scripts/build-docs.sh",
        }
    )

    with open(target, "wb") as handle:
        writer.write(handle)

    print(f"stamped {total} pages into {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
