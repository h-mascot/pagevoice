#!/usr/bin/env bash
# Build the Chrome Web Store upload zip from the runtime file set.
# Usage: bash scripts/package-zip.sh [output.zip]
#
# Contains ONLY runtime files — no tests, dev tooling, or docs (those stay
# in the repo). The extension has no build step; this just packages the
# exact files Chrome loads. Run from a clean checkout of the release tag.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./manifest.json').version")"
OUT="${1:-dist/pagevoice-${VERSION}.zip}"

# Runtime file set (must match manifest.json + all script tags / importScripts):
#  - manifest + extension pages/scripts/styles + icons
#  - lib/pv-*.js pure modules (loaded by background, offscreen, content, popup)
#  - vendored pdf.js build files (lazy-loaded by offscreen on PDF import)
RUNTIME_FILES=(
  manifest.json
  background.js
  offscreen.html offscreen.js
  popup.html popup.js popup.css
  content.js content-player.css
)

# Every lib/pv-*.js pure module except colocated tests. Globbed on purpose:
# v2.2.2's first build shipped a zip missing lib/pv-transport.js while
# offscreen.html and the manifest referenced it, so the extension would have
# loaded with a broken PDF import. A glob can't forget a new module.
for f in lib/pv-*.js; do
  case "$f" in
    *.test.js) ;;
    *) RUNTIME_FILES+=("$f") ;;
  esac
done

RUNTIME_FILES+=(
  vendor/pdfjs/legacy/build/pdf.min.js
  vendor/pdfjs/legacy/build/pdf.worker.min.js
  vendor/pdfjs/LICENSE
  icon-16.png icon-48.png icon-128.png
  LICENSE PRIVACY.md
)

# Fail loudly before zipping if anything is missing.
for f in "${RUNTIME_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "package-zip: missing runtime file: $f" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
zip -q -X "$OUT" "${RUNTIME_FILES[@]}"

# Report + sanity check: manifest version inside the zip must match.
echo "package-zip: wrote $OUT"
unzip -p "$OUT" manifest.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version"
echo "package-zip: ${#RUNTIME_FILES[@]} files, $(unzip -l "$OUT" | tail -1 | awk '{print $1}') bytes"

# Guard: every script/style the runtime references must be inside the zip.
node scripts/verify-zip-contents.js "$OUT"
