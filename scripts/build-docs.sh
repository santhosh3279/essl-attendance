#!/usr/bin/env bash
#
# Regenerates the PDF guide from docs/manual.html.
#
#   bash scripts/build-docs.sh
#
# Requires wkhtmltopdf (apt install wkhtmltopdf).

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$APP_DIR/docs/manual.html"
OUTPUT="$APP_DIR/docs/ESSL-Attendance-Guide.pdf"

command -v wkhtmltopdf >/dev/null || {
  echo "wkhtmltopdf is not installed — try: sudo apt install wkhtmltopdf" >&2
  exit 1
}
[[ -f "$SOURCE" ]] || { echo "missing $SOURCE" >&2; exit 1; }

# Note: the packaged wkhtmltopdf is built against unpatched Qt, which ignores
# every --footer-* switch. The footer is stamped on afterwards instead.
wkhtmltopdf \
  --quiet \
  --page-size A4 \
  --margin-top 18mm --margin-bottom 20mm --margin-left 16mm --margin-right 16mm \
  "$SOURCE" "$OUTPUT"

# Optional polish: page numbers. Needs pypdf and reportlab.
PYTHON="${PYTHON:-python3}"
if "$PYTHON" -c 'import pypdf, reportlab' 2>/dev/null; then
  "$PYTHON" "$APP_DIR/scripts/stamp-pages.py" "$OUTPUT"
else
  echo "note: pypdf/reportlab not installed — PDF built without page numbers."
  echo "      to add them: pip install pypdf reportlab && bash scripts/build-docs.sh"
fi

echo "built $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
