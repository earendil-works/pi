#!/bin/bash
# Satellite MCP Server - nohup startup script
#
# Usage:
#   ./start.sh [TOKEN] [PORT]
#
# Environment variables:
#   SATELLITE_TOKEN - Bearer token for authentication (required)
#   SATELLITE_PORT  - HTTP port (default: 29001)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="${SCRIPT_DIR}/satellite-server"

# Default values
TOKEN="${1:-${SATELLITE_TOKEN:-}}"
PORT="${2:-${SATELLITE_PORT:-29001}}"
PID_FILE="/tmp/satellite.pid"
LOG_FILE="/tmp/satellite.log"

if [ -z "$TOKEN" ]; then
  echo "Error: SATELLITE_TOKEN is required"
  echo "Usage: $0 <token> [port]"
  exit 1
fi

if [ ! -f "$BINARY" ]; then
  echo "Error: satellite-server binary not found at $BINARY"
  echo "Run: bun build --compile satellite-server.ts --outfile satellite-server"
  exit 1
fi

# Kill existing process if running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing satellite-server (PID: $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

# Start new process
echo "Starting satellite-server on port $PORT..."
SATELLITE_TOKEN="$TOKEN" SATELLITE_PORT="$PORT" nohup "$BINARY" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

echo "Satellite MCP Server started"
echo "  PID: $(cat "$PID_FILE")"
echo "  Port: $PORT"
echo "  Log: $LOG_FILE"
echo "  Health: http://localhost:$PORT/health"
