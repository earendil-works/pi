#!/bin/bash
# One-click deploy: build binary, upload, restart satellite server on remote HPC
#
# Usage:
#   ./deploy.sh                  # build + scp + restart (full cycle)
#   ./deploy.sh --restart-only   # skip build + scp, just restart with current binary
#                                # (useful after editing deploy.sh itself, or after
#                                # updating $REMOTE_DIR/satellite.env on the remote)
#   ./deploy.sh --rollback       # restore $REMOTE_DIR/satellite-server.prev, then restart
#
# Remote layout (everything colocated under REMOTE_DIR):
#   $REMOTE_DIR/satellite-server          (binary)
#   $REMOTE_DIR/satellite-server.prev     (rollback of previous binary)
#   $REMOTE_DIR/satellite.env             (env dump from interactive login)
#   $REMOTE_DIR/logs/satellite.log        (main server log)
#   $REMOTE_DIR/logs/satellite-bash-*.log (per-bash spill logs)
#   $REMOTE_DIR/logs/satellite-stdout.log (nohup stdout/stderr capture)
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE="login"
TOKEN="satellite-token-2024"
PORT=29001
REMOTE_DIR="/TJPROJ13/GB_MICRO/USER/qujiahao/workspace/project-code/satellite"
LOGS_DIR="${REMOTE_DIR}/logs"
LOG_FILE="${LOGS_DIR}/satellite.log"
BASH_LOG_DIR="${LOGS_DIR}"
STDOUT_LOG="${LOGS_DIR}/satellite-stdout.log"
RESTART_ONLY=0
ROLLBACK=0

for arg in "$@"; do
  case "$arg" in
    --restart-only) RESTART_ONLY=1 ;;
    --rollback) ROLLBACK=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

REMOTE_PATH="${REMOTE}:${REMOTE_DIR}"
# Resolve the remote $HOME explicitly. scp/ssh don't expand ~ in some
# configs, and we don't want $HOME in the local env (different user) to
# leak into the remote command. Used to locate the legacy satellite.env
# so we can migrate it to the new colocated path.
REMOTE_HOME=$(ssh "$REMOTE" 'echo $HOME' </dev/null 2>/dev/null)

# Always make sure the remote dirs exist; harmless to re-run.
ssh "$REMOTE" "mkdir -p '$LOGS_DIR'" </dev/null

if [ "$ROLLBACK" -eq 1 ]; then
  echo "=== Rolling back binary ==="
  ssh "$REMOTE" "test -f '$REMOTE_DIR/satellite-server.prev' || (echo 'No .prev binary to roll back to' && exit 1)
                 rm -f '$REMOTE_DIR/satellite-server'
                 mv '$REMOTE_DIR/satellite-server.prev' '$REMOTE_DIR/satellite-server'
                 echo 'Rolled back to previous binary'"
  RESTART_ONLY=1
fi

if [ "$RESTART_ONLY" -eq 0 ]; then
  echo "=== Building binary ==="
  cd "$SCRIPT_DIR"
  bun build --compile satellite-server.ts --outfile satellite-server 2>&1

  echo ""
  echo "=== Uploading binary to $REMOTE_PATH ==="
  # Upload to /tmp first then rm+mv to REMOTE_DIR, since `mv -f` over a
  # same-owner file on this HPC filesystem doesn't bypass the no-overwrite
  # restriction. Back up the existing binary as .prev first, so a failed
  # new binary can be rolled back with --rollback.
  ssh "$REMOTE" "[ -f '$REMOTE_DIR/satellite-server' ] && cp -f '$REMOTE_DIR/satellite-server' '$REMOTE_DIR/satellite-server.prev' || true" </dev/null
  scp "$SCRIPT_DIR/satellite-server" "$REMOTE:/tmp/satellite-server.new"
  ssh "$REMOTE" "rm -f '$REMOTE_DIR/satellite-server' && mv /tmp/satellite-server.new '$REMOTE_DIR/satellite-server'" </dev/null

  # If a legacy ~/satellite.env exists from the pre-migration layout,
  # move it into the new colocated path. Idempotent.
  ssh "$REMOTE" "[ -f '$REMOTE_HOME/satellite.env' ] && [ ! -f '$REMOTE_DIR/satellite.env' ] && mv '$REMOTE_HOME/satellite.env' '$REMOTE_DIR/satellite.env' || true" </dev/null

  echo ""
fi

echo "=== Restarting satellite server (binary at $REMOTE_DIR) ==="
# Pass TOKEN/PORT as positional args to the remote bash. SSH doesn't forward
# arbitrary env vars by default, and the quoted heredoc body is literal, so
# we can't rely on local-variable expansion.
ssh "$REMOTE" bash -s -- "$TOKEN" "$PORT" "$REMOTE_DIR" "$LOGS_DIR" "$LOG_FILE" "$BASH_LOG_DIR" "$STDOUT_LOG" << 'ENDSSH'
set -eu

TOKEN="$1"
PORT="$2"
REMOTE_DIR="$3"
LOGS_DIR="$4"
LOG_FILE="$5"
BASH_LOG_DIR="$6"
STDOUT_LOG="$7"
BINARY="${REMOTE_DIR}/satellite-server"

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

mkdir -p "$LOGS_DIR"

# Start new binary
# Inherit full HPC env (module, conda, PATH, LD_LIBRARY_PATH, etc.) from satellite.env
# colocated with the binary. ssh non-interactive sessions don't auto-source
# the user's .bashrc / .bash_profile, and rc-sourcing is unreliable (some
# HPC rcs hang on `module load` TTY prompts). The env file is a one-time
# dump from an interactive login session, MUST use -0 (NUL separators) to
# preserve multi-line values like BASH_FUNC_module() body:
#   ssh login 'env -0 > ~/satellite.env'
# Re-run that command whenever modules / conda envs / PATH change, then redeploy.
#
# Implementation: pipe NUL-separated KEY=VALUE pairs from the file directly into
# the `env` command as arguments. `env` accepts names with `()` (unlike bash's
# `export` builtin), so BASH_FUNC_module() is preserved as-is and any spawned
# bash child will decode it on startup.
ENV_FILE="${REMOTE_DIR}/satellite.env"
if [ -f "$ENV_FILE" ]; then
  nohup bash -c '
    set -a
    while IFS= read -r -d "" entry; do
      # BASH_FUNC_X()=() {} — strip () from name so `export` accepts it
      case "$entry" in
        BASH_FUNC_*"()="*) export "${entry/"()="/=}" 2>/dev/null || true ;;
        *) export "$entry" 2>/dev/null || true ;;
      esac
    done < "$1"
    set +a
    exec env SATELLITE_TOKEN="$2" SATELLITE_PORT="$3" \
        SATELLITE_LOG_FILE="$4" SATELLITE_BASH_LOG_DIR="$5" \
        "$6"
  ' bash "$ENV_FILE" "$TOKEN" "$PORT" "$LOG_FILE" "$BASH_LOG_DIR" "$BINARY" > "$STDOUT_LOG" 2>&1 &
else
  # Fallback: launch with minimal env (just satellite config vars)
  nohup env SATELLITE_TOKEN="$TOKEN" SATELLITE_PORT="$PORT" \
      SATELLITE_LOG_FILE="$LOG_FILE" SATELLITE_BASH_LOG_DIR="$BASH_LOG_DIR" \
      "$BINARY" > "$STDOUT_LOG" 2>&1 &
fi

sleep 2

# Health check
if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
  echo "  Server started OK on port $PORT"
  echo "  Logs at: $LOGS_DIR"
else
  echo "  WARNING: health check failed, check $LOG_FILE"
fi
ENDSSH

echo ""
echo "=== Done ==="
