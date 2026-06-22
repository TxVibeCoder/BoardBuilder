#!/bin/sh
# BoardBuilder launcher (macOS). Installs dependencies on first run, starts the local
# dev server, and opens your browser. First run: right-click -> Open (Gatekeeper).
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required but was not found on PATH."
  echo "Install it from https://nodejs.org/ then run this again."
  read -r _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only, ~30s)..."
  npm install --no-fund --no-audit || { echo "Install failed."; read -r _; exit 1; }
fi

echo
echo "Starting BoardBuilder - a browser tab will open when it is ready."
echo "Leave this window open while you use it; Ctrl-C or close it to stop."
echo
npm run dev -- --open
