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
ssh "$REMOTE" bash -s << ENDSSH
set -eu

TOKEN="$TOKEN"
PORT="$PORT"
BINARY=~/satellite-server

# Kill old satellite process
OLD_PID=\$(pgrep -f "satellite-server" 2>/dev/null || true)
if [ -n "\$OLD_PID" ]; then
  echo "  Stopping old process (PID: \$OLD_PID)..."
  kill "\$OLD_PID" 2>/dev/null || true
  sleep 2
  # Force kill if still alive
  if kill -0 "\$OLD_PID" 2>/dev/null; then
    kill -9 "\$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

# Start new binary
# Inherit full HPC env (module, conda, PATH, LD_LIBRARY_PATH, etc.) from ~/satellite.env.
# ssh non-interactive sessions don't auto-source the user's .bashrc / .bash_profile,
# and rc-sourcing is unreliable (some HPC rcs hang on `module load` TTY prompts).
# The env file is a one-time dump from an interactive login session, MUST use -0
# (NUL separators) to preserve multi-line values like BASH_FUNC_module() body:
#   ssh login 'env -0 > ~/satellite.env'
# Re-run that command whenever modules / conda envs / PATH change, then redeploy.
if [ -f "\$HOME/satellite.env" ]; then
  # Read with NUL separators so multi-line values (e.g. exported shell functions)
  # are captured as a single KEY=VALUE entry, not split across lines.
  while IFS= read -r -d '' entry; do
    # BASH_FUNC_X()=() { body } entries have parens in the name which `export`
    # rejects. Strip the trailing `()` from the name (bash 5.x accepts both
    # forms when decoding on startup). All other entries export directly.
    case "$entry" in
      BASH_FUNC_*'()='*)
        cleaned="${entry/'()='/=}"
        export "$cleaned" 2>/dev/null || true
        ;;
      *)
        export "$entry" 2>/dev/null || true
        ;;
    esac
  done < "\$HOME/satellite.env"
fi

export SATELLITE_TOKEN="\$TOKEN"
export SATELLITE_PORT="\$PORT"
nohup "\$BINARY" > /tmp/satellite-stdout.log 2>&1 &

sleep 2

# Health check
if curl -sf "http://localhost:\$PORT/health" > /dev/null 2>&1; then
  echo "  Server started OK on port \$PORT"
else
  echo "  WARNING: health check failed, check /tmp/satellite.log"
fi
ENDSSH

echo ""
echo "=== Done ==="
