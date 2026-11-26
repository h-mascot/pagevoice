#!/usr/bin/env bash
set -euo pipefail

echo "[ctrl] Running in mvp mode (chrome-extension)"
echo "[ctrl] Checking JavaScript syntax"
node --check background.js
node --check content.js
node --check offscreen.js
node --check popup.js
# Glob, not a hardcoded list: a new lib module must never skip the gate
# (lib/pv-transport.js was added in the round-2 wave and was not covered).
for f in lib/pv-*.js; do
  node --check "$f"
done
node --check scripts/verify-zip-contents.js

if [ -f kokoro_server.py ]; then
  echo "[ctrl] Checking Python syntax"
  python3 -m py_compile kokoro_server.py
fi

echo "[ctrl] Running unit tests"
npm test

echo "[ctrl] gate passed ✅"
