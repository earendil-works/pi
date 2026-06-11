#!/usr/bin/env bash
# Restart the production webui (port 8741) so it picks up the bundle
# currently in coding-agent/dist/webui/. Idempotent: a no-op if the
# production webui is not running.
#
#   - finds the running server.bundle.js process bound to 8741
#   - sends SIGTERM (the bundle installs a clean shutdown handler)
#   - waits up to 3s for the port to free
#   - spawns `pi --web` detached, logs to /tmp/prod-webui.log
#
# Why detached: opencode's tool call returns once the command returns.
# If we ran `pi --web` in the foreground the tool would never return.
# `nohup ... & disown` makes the child survive the parent shell exit.
set -euo pipefail

PROD_PORT="${PI_WEB_PORT:-8741}"
PROD_LOG="${PI_WEB_LOG:-/tmp/prod-webui.log}"

# Find the running production webui process. The bundle is loaded as a
# child of `pi --web`; we look for the bundle process directly (the
# child), not the `pi --web` parent (the parent forwards exit code).
EXISTING_PID=$(ss -tlnp 2>/dev/null \
  | awk -v port=":$PROD_PORT" '$4 ~ port { print $0 }' \
  | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)

if [[ -n "${EXISTING_PID:-}" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
  echo "stopping existing prod webui (pid $EXISTING_PID on :$PROD_PORT)..."
  kill "$EXISTING_PID" 2>/dev/null || true
  for _ in 1 2 3 4 5 6; do
    sleep 0.5
    if ! kill -0 "$EXISTING_PID" 2>/dev/null; then
      break
    fi
  done
  if kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "warning: pid $EXISTING_PID still alive after 3s, sending SIGKILL" >&2
    kill -9 "$EXISTING_PID" 2>/dev/null || true
  fi
fi

if ! command -v pi >/dev/null 2>&1; then
  echo "error: \`pi\` not on PATH — install the coding-agent package globally first" >&2
  exit 1
fi

echo "starting prod webui (port $PROD_PORT, log $PROD_LOG)..."
: > "$PROD_LOG"
nohup pi --web > "$PROD_LOG" 2>&1 &
disown 2>/dev/null || true

# Wait for the port to come up (max 5s).
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ss -tln 2>/dev/null | awk '{print $4}' | grep -q ":$PROD_PORT\$"; then
    echo "ready: http://127.0.0.1:$PROD_PORT"
    exit 0
  fi
  sleep 0.5
done

echo "error: webui did not start within 5s. last log lines:" >&2
tail -20 "$PROD_LOG" >&2 || true
exit 1
