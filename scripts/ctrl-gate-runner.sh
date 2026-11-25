#!/usr/bin/env bash
set -euo pipefail

echo "[ctrl] Running in mvp mode (chrome-extension)"
echo "[ctrl] Checking JavaScript syntax"
node --check background.js
node --check content.js
node --check offscreen.js
node --check popup.js
node --check lib/pv-utils.js

if [ -f kokoro_server.py ]; then
  echo "[ctrl] Checking Python syntax"
  python3 -m py_compile kokoro_server.py
fi

echo "[ctrl] Running unit tests"
npm test

echo "[ctrl] gate passed ✅"
