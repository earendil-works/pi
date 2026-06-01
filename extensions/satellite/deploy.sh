#!/bin/bash
# One-click deploy: build binary, upload, restart satellite server on remote HPC
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE="login"
TOKEN="satellite-token-2024"
PORT=29001

echo "=== Building binary ==="
cd "$SCRIPT_DIR"
bun build --compile satellite-server.ts --outfile satellite-server 2>&1

echo ""
echo "=== Uploading binary ==="
scp "$SCRIPT_DIR/satellite-server" "$REMOTE:~/satellite-server"

echo ""
echo "=== Restarting satellite server ==="
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
