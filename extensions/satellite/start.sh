#!/bin/bash
# Satellite MCP Server - nohup startup script
#
# Usage:
#   ./start.sh [TOKEN] [PORT]
#
# Environment variables:
#   SATELLITE_TOKEN              - Bearer token for authentication (required)
#   SATELLITE_PORT               - HTTP port (default: 29001)
#   SATELLITE_LOG_FILE           - main server log path
#                                  (default: $SCRIPT_DIR/logs/satellite.log)
#   SATELLITE_BASH_LOG_DIR       - directory for per-bash spill logs
#                                  (default: $SCRIPT_DIR/logs)
#
# All satellite state (binary, env, logs) is colocated under SCRIPT_DIR.
# PID file stays in /tmp (OS convention for ephemeral runtime state).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="${SCRIPT_DIR}/satellite-server"

# Default values
TOKEN="${1:-${SATELLITE_TOKEN:-}}"
PORT="${2:-${SATELLITE_PORT:-29001}}"
PID_FILE="/tmp/satellite.pid"
LOGS_DIR="${SCRIPT_DIR}/logs"
LOG_FILE="${SATELLITE_LOG_FILE:-${LOGS_DIR}/satellite.log}"
BASH_LOG_DIR="${SATELLITE_BASH_LOG_DIR:-$LOGS_DIR}"

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

mkdir -p "$LOGS_DIR"

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
SATELLITE_TOKEN="$TOKEN" \
SATELLITE_PORT="$PORT" \
SATELLITE_LOG_FILE="$LOG_FILE" \
SATELLITE_BASH_LOG_DIR="$BASH_LOG_DIR" \
  nohup "$BINARY" > "${LOGS_DIR}/satellite-stdout.log" 2>&1 &
echo $! > "$PID_FILE"

echo "Satellite MCP Server started"
echo "  PID: $(cat "$PID_FILE")"
echo "  Port: $PORT"
echo "  Log: $LOG_FILE"
echo "  Bash spill dir: $BASH_LOG_DIR"
echo "  Stdout/stderr: ${LOGS_DIR}/satellite-stdout.log"
echo "  Health: http://localhost:$PORT/health"
