#!/usr/bin/env bash
# Informational NLT-Pi session-start hook. Does not grant permissions or block startup.
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
VERSION="${NLT_OTOI_VERSION:-NLT-PI-DEV-OTOI-1.0.1}"
printf '\n=== NLT-Pi Coding Agent Governance ===\nContract: %s\nAuthority: %s\n\n' "$VERSION" "${NLT_AUTHORITY:-Joshua W. Dorsey, Sr.}"
printf 'Read before substantive work:\n'
for f in NLT-DEV-OTOI.md AGENTS.md CLAUDE.md REVIEW.md docs/active-threads.md nltotoi.json; do
  if [[ -s "$ROOT/$f" ]]; then printf '  [OK] %s\n' "$f"; else printf '  [MISSING] %s\n' "$f"; fi
done
printf '\nGovernance layers: development / ASFDK foundation / ASFDK harness / ASFDK MCP\n'
printf 'Remember: capability does not equal authority. Escalate, do not guess.\n'
printf 'Validation: bash .nltotoi/scripts/validate-governance.sh\n\n'
exit 0
