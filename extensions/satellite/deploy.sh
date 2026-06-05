#!/bin/bash
# One-click deploy: build binary, upload, restart satellite server on remote HPC
#
# Usage:
#   ./deploy.sh                  # build + scp + restart (full cycle)
#   ./deploy.sh --restart-only   # skip build + scp, just restart with current binary
#                                # (useful after editing deploy.sh itself, or after
#                                # updating ~/satellite.env on the remote)
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE="login"
TOKEN="satellite-token-2024"
PORT=29001
RESTART_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --restart-only) RESTART_ONLY=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

if [ "$RESTART_ONLY" -eq 0 ]; then
  echo "=== Building binary ==="
  cd "$SCRIPT_DIR"
  bun build --compile satellite-server.ts --outfile satellite-server 2>&1

  echo ""
  echo "=== Uploading binary ==="
  scp "$SCRIPT_DIR/satellite-server" "$REMOTE:~/satellite-server"
  echo ""
fi

echo "=== Restarting satellite server (binary already on remote) ==="
# Pass TOKEN/PORT as positional args to the remote bash. SSH doesn't forward
# arbitrary env vars by default, and the quoted heredoc body is literal, so
# we can't rely on local-variable expansion.
ssh "$REMOTE" bash -s -- "$TOKEN" "$PORT" << 'ENDSSH'
set -eu

TOKEN="$1"
PORT="$2"
BINARY=~/satellite-server

# Kill old satellite process(es). pgrep may return multiple PIDs (e.g. an
# `xargs` wrapper from a previous deploy attempt + the binary itself), so
# iterate explicitly — `kill "$OLD_PID"` with a newline-separated value
# treats the whole blob as one (invalid) PID and silently does nothing.
OLD_PIDS=$(pgrep -f "satellite-server" 2>/dev/null || true)
if [ -n "$OLD_PIDS" ]; then
  echo "  Stopping old process(es) (PIDs: $(echo $OLD_PIDS | tr '\n' ' '))..."
  for p in $OLD_PIDS; do
    kill "$p" 2>/dev/null || true
  done
  sleep 2
  # Force kill any stragglers
  for p in $OLD_PIDS; do
    if kill -0 "$p" 2>/dev/null; then
      kill -9 "$p" 2>/dev/null || true
    fi
  done
  sleep 1
fi

# Start new binary
# Inherit full HPC env (module, conda, PATH, LD_LIBRARY_PATH, etc.) from ~/satellite.env.
# ssh non-interactive sessions don't auto-source the user's .bashrc / .bash_profile,
# and rc-sourcing is unreliable (some HPC rcs hang on `module load` TTY prompts).
# The env file is a one-time dump from an interactive login session, MUST use -0
# (NUL separators) to preserve multi-line values like BASH_FUNC_module() body:
#   ssh login 'env -0 > ~/satellite.env'
# Re-run that command whenever modules / conda envs / PATH change, then redeploy.
#
# Implementation: pipe NUL-separated KEY=VALUE pairs from the file directly into
# the `env` command as arguments. `env` accepts names with `()` (unlike bash's
# `export` builtin), so BASH_FUNC_module() is preserved as-is and any spawned
# bash child will decode it on startup.
if [ -f "$HOME/satellite.env" ]; then
  # Wrap the binary launch in a subshell that loads the env file first.
  # The `exec` at the end replaces the subshell with the binary, so the
  # env is preserved and the process tree stays clean. Using a subshell
  # (vs xargs+env) avoids command-line size limits and correctly handles
  # multi-line BASH_FUNC_*() entries via `read -d ''`.
  nohup bash -c '
    set -a
    while IFS= read -r -d "" entry; do
      # BASH_FUNC_X()=() {} — strip () from name so `export` accepts it
      case "$entry" in
        BASH_FUNC_*"()="*) export "${entry/"()="/=}" 2>/dev/null || true ;;
        *) export "$entry" 2>/dev/null || true ;;
      esac
    done < "$HOME/satellite.env"
    set +a
    exec env SATELLITE_TOKEN="$1" SATELLITE_PORT="$2" "$3"
  ' bash "$TOKEN" "$PORT" "$BINARY" > /tmp/satellite-stdout.log 2>&1 &
else
  # Fallback: launch with minimal env (just satellite config vars)
  export SATELLITE_TOKEN="$TOKEN"
  export SATELLITE_PORT="$PORT"
  nohup "$BINARY" > /tmp/satellite-stdout.log 2>&1 &
fi

sleep 2

# Health check
if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
  echo "  Server started OK on port $PORT"
else
  echo "  WARNING: health check failed, check /tmp/satellite.log"
fi
ENDSSH

echo ""
echo "=== Done ==="
