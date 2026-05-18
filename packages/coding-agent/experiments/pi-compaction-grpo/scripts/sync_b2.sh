#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v b2 >/dev/null 2>&1; then
  echo "b2 CLI not found" >&2
  exit 1
fi

b2 account authorize >/dev/null
export SSL_CERT_FILE="${SSL_CERT_FILE:-/etc/ssl/certs/ca-certificates.crt}"
export REQUESTS_CA_BUNDLE="${REQUESTS_CA_BUNDLE:-$SSL_CERT_FILE}"
b2 sync . b2://clouderic/pi-compaction-grpo/ \
  --exclude-regex '(.*/)?\.git(/.*)?|(.*/)?__pycache__(/.*)?|(.*/)?\.pytest_cache(/.*)?|(.*/)?trajectories\.db'
