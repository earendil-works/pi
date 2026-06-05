#!/usr/bin/env bash
# Rebuild the webui and install it to the global `pi --web` slot.
#
# This is the single command for "I changed something in the webui and
# want the change live on http://127.0.0.1:8741". It runs:
#
#   1. npm run build         in packages/webui
#        - vite build        → webui/web/dist/   (frontend)
#        - esbuild           → webui/dist/server.bundle.js
#
#   2. npm run build         in packages/coding-agent
#        - copies webui/dist/server.bundle.js → coding-agent/dist/webui/
#        - copies webui/web/dist/             → coding-agent/dist/webui/web/
#
#   3. npm install -g .      in packages/coding-agent
#        - symlinks ~/.npm-global/.../coding-agent → ../../workspace/.../coding-agent
#        - so the global `pi` binary picks up new dist/ on next spawn
#
#   4. restart:web           in packages/coding-agent
#        - SIGTERM the running production webui (port 8741)
#        - spawn a new `pi --web` detached, log to /tmp/prod-webui.log
#
# Frontend-only edits (anything under web/) are picked up by vite HMR on
# the dev instance (port 8742) without going through this script — see
# packages/webui/README.md "Development" section.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODING_AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CODING_AGENT_DIR/../.." && pwd)"
WEBUI_DIR="$REPO_ROOT/packages/webui"

if [[ ! -d "$WEBUI_DIR" ]]; then
  echo "error: expected $WEBUI_DIR to exist" >&2
  exit 1
fi

echo "[1/3] building webui (vite + esbuild)..."
(cd "$WEBUI_DIR" && npm run build)

echo ""
echo "[2/3] building coding-agent (copies webui artifacts)..."
(cd "$CODING_AGENT_DIR" && npm run build)

echo ""
echo "[3/3] installing to global and restarting prod..."
(cd "$CODING_AGENT_DIR" && npm run restart:web)

echo ""
echo "done. prod webui: http://127.0.0.1:8741"
echo "      dev webui:  http://127.0.0.1:8742  (if running)"
