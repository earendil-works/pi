#!/usr/bin/env bash
# Start the issue triage server. Environment variables are documented in README.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node --conditions=source --import ./scripts/issues/register.mjs scripts/issues/main.ts
