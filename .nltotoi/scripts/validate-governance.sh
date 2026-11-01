#!/usr/bin/env bash
# Read-only validation of the NLT-Pi repository governance baseline.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASS=0; FAIL=0
check_file() {
  if [[ -s "$ROOT/$1" ]]; then printf 'PASS  %s\n' "$1"; ((PASS+=1)); else printf 'FAIL  %s (missing or empty)\n' "$1"; ((FAIL+=1)); fi
}
check_contains() {
  if [[ -f "$ROOT/$1" ]] && grep -Fq -- "$2" "$ROOT/$1"; then printf 'PASS  %s contains %s\n' "$1" "$2"; ((PASS+=1)); else printf 'FAIL  %s missing marker %s\n' "$1" "$2"; ((FAIL+=1)); fi
}
required=(
  NLT-DEV-OTOI.md AGENTS.md CLAUDE.md REVIEW.md nltotoi.json
  docs/active-threads.md docs/agent-log/README.md docs/escalations/README.md
  templates/agent-registration.json templates/handoff-record.json
  templates/escalation.md templates/intent-log.md templates/review-record.md
  templates/commit-message.md .claude/README.md .claude/settings.json
  .claude/hooks/session-start.sh .nltotoi/index/governance-files.md
)
printf 'NLT-Pi Governance Validation\nRoot: %s\n\n' "$ROOT"
for f in "${required[@]}"; do check_file "$f"; done
check_contains NLT-DEV-OTOI.md NLT-PI-DEV-OTOI-1.0.0
check_contains NLT-DEV-OTOI.md 'Capability does not equal authority'
check_contains AGENTS.md 'ASFDK harness'
check_contains AGENTS.md 'ASFDK MCP'
check_contains nltotoi.json 'NeuroLift-Technologies/nlt-pi'
check_contains .claude/settings.json SessionStart
printf '\nResults: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
