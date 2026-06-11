#!/usr/bin/env bash
# Start the webui dev instance with vite HMR.
#
# Default behavior:
#   - cwd:    $HOME/.pi/agent  (override with PI_WEB_CWD=...)
#   - port:   8742              (override with PI_WEB_PORT=...)
#   - dev:    1                 (override with PI_WEB_DEV=0 to disable)
#
# The script is a thin wrapper around `tsx watch`. All it does is set
# the cwd so spawned pi subprocesses land in the user's project tree,
# inject the dev port, and forward SIGINT/SIGTERM to the child process
# so Ctrl-C tears the whole thing down cleanly.
#
# This instance is independent from the production webui (which lives at
# ~/.npm-global/.../server.bundle.js on port 8741) — it does not touch
# that process, its port, or its bundle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBUI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$WEBUI_DIR/../.." && pwd)"

export PI_WEB_CWD="${PI_WEB_CWD:-$HOME/.pi/agent}"
export PI_WEB_PORT="${PI_WEB_PORT:-8742}"
export PI_WEB_DEV="${PI_WEB_DEV:-1}"

if [[ ! -d "$PI_WEB_CWD" ]]; then
  echo "error: PI_WEB_CWD does not exist: $PI_WEB_CWD" >&2
  exit 1
fi

# Prefer the workspace tsx (resolved from the monorepo root) so we get
# the version the rest of the repo uses, not a global one.
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
  echo "error: tsx not found at $TSX_BIN — run 'npm install' from the repo root" >&2
  exit 1
fi

echo "[dev-webui]"
echo "  cwd:   $PI_WEB_CWD"
echo "  port:  $PI_WEB_PORT  (open http://127.0.0.1:$PI_WEB_PORT)"
echo "  vite:  $([ "$PI_WEB_DEV" = "1" ] && echo on || echo off)"
echo "  watch: off (web HMR only; server edits need Ctrl-C + rerun)"
echo "  (Ctrl-C to stop)"

# Run tsx (not tsx watch) — see the comment on PI_WEB_DEV below for why.
# Web changes get full HMR via vite (no restart needed). Server file edits
# require a manual Ctrl-C and re-run of this script, which is fine: the
# vast majority of dev iteration is on web/ source.
cd "$WEBUI_DIR/server"
exec "$TSX_BIN" \
  --tsconfig="$REPO_ROOT/tsconfig.json" \
  "$WEBUI_DIR/server/index.ts"
