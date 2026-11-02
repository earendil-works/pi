#!/usr/bin/env bash
# Read-only validation of the NLT-Pi repository governance baseline and local adaptations.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASS=0
FAIL=0

check_file() {
  if [[ -s "$ROOT/$1" ]]; then
    printf 'PASS  %s\n' "$1"
    ((PASS+=1))
  else
    printf 'FAIL  %s (missing or empty)\n' "$1"
    ((FAIL+=1))
  fi
}

check_contains() {
  if [[ -f "$ROOT/$1" ]] && grep -Fq -- "$2" "$ROOT/$1"; then
    printf 'PASS  %s contains %s\n' "$1" "$2"
    ((PASS+=1))
  else
    printf 'FAIL  %s missing marker %s\n' "$1" "$2"
    ((FAIL+=1))
  fi
}

check_not_contains() {
  if [[ -f "$ROOT/$1" ]] && ! grep -Fq -- "$2" "$ROOT/$1"; then
    printf 'PASS  %s does not contain %s\n' "$1" "$2"
    ((PASS+=1))
  else
    printf 'FAIL  %s contains obsolete marker %s\n' "$1" "$2"
    ((FAIL+=1))
  fi
}

printf 'NLT-Pi Governance Validation\nRoot: %s\n\n' "$ROOT"
check_file "nltotoi.json"
check_file "GOVERNANCE.md"
check_file "governance.yaml"
check_file "governance.json"

# The manifest is the single source of truth for required repository artifacts.
if ! required_json="$(node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const required = manifest.required_files;
if (!Array.isArray(required) || required.length === 0) {
  throw new Error("manifest required_files must be a non-empty array");
}
for (const path of required) {
  if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error("invalid required_files entry: " + JSON.stringify(path));
  }
  process.stdout.write(path + "\n");
}
' "$ROOT/nltotoi.json")"; then
  printf 'FAIL  nltotoi.json has an invalid required_files inventory\n'
  ((FAIL+=1))
else
  while IFS= read -r required_path; do
    [[ -n "$required_path" ]] && check_file "$required_path"
  done <<< "$required_json"
fi

# Validate manifest provenance and the machine-readable local baseline.
if node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const metadata = manifest.metadata || {};
if (metadata.source_templates !== "NeuroLift-Technologies/.github") {
  throw new Error("metadata.source_templates must identify the public .github repository");
}
if (metadata.source_baseline !== "ORG-DEV-OTOI-1.0.4") {
  throw new Error("metadata.source_baseline must identify ORG-DEV-OTOI-1.0.4");
}
if (manifest.repository?.visibility !== "public") {
  throw new Error("repository.visibility must be public");
}
if (manifest.governance_contract !== "NLT-PI-DEV-OTOI-1.0.1") {
  throw new Error("governance_contract must match the current local OTOI version");
}
' "$ROOT/nltotoi.json"; then
  printf 'PASS  nltotoi.json public template provenance and local contract version\n'
  ((PASS+=1))
else
  printf 'FAIL  nltotoi.json public template provenance and local contract version\n'
  ((FAIL+=1))
fi

check_contains NLT-DEV-OTOI.md NLT-PI-DEV-OTOI-1.0.1
check_contains NLT-DEV-OTOI.md 'Capability does not equal authority'
check_contains NLT-DEV-OTOI.md 'NeuroLift-Technologies/.github'
check_contains AGENTS.md 'ASFDK harness'
check_contains AGENTS.md 'ASFDK MCP'
check_contains AGENTS.md '[AGENT_NAME] type(scope): imperative description'
check_contains AGENTS.md 'Agent Escalation'
check_contains CLAUDE.md 'governance.yaml'
check_contains CLAUDE.md 'governance.json'
check_contains GOVERNANCE.md 'ORG-DEV-OTOI-1.0.4'
check_contains governance.yaml 'organizational_baseline: ORG-DEV-OTOI-1.0.4'
check_contains governance.json '"organizational_baseline": "ORG-DEV-OTOI-1.0.4"'
check_contains nltotoi.json 'NeuroLift-Technologies/nlt-pi'
check_contains .claude/settings.json SessionStart
check_contains templates/agent-registration.json '"acknowledged_otoi": false'
check_contains templates/agent-registration.json 'NLT-PI-DEV-OTOI-1.0.1'
check_contains templates/handoff-record.json '"test_result": "not_run"'
check_contains templates/handoff-record.json 'NLT-PI-DEV-OTOI-1.0.1'
check_contains templates/intent-log.md 'NLT-PI-DEV-OTOI-1.0.1'
check_contains REVIEW.md 'NLT-PI-DEV-OTOI-1.0.1'
check_contains PULL_REQUEST_TEMPLATE.md '[AGENT_NAME] type(scope): imperative description'

# Public issue templates must not retain upstream contribution gates or links.
for issue_template in .github/ISSUE_TEMPLATE/bug.yml .github/ISSUE_TEMPLATE/contribution.yml .github/ISSUE_TEMPLATE/package-report.yml; do
  check_not_contains "$issue_template" 'earendil-works/pi'
  check_not_contains "$issue_template" 'auto-closed'
  check_not_contains "$issue_template" 'auto-close'
done

# Internal-only source references must not leak into this public repository's local governance.
for governance_file in NLT-DEV-OTOI.md SOPs/repo-governance-setup.md nltotoi.json .nltotoi/index/governance-files.md; do
  check_not_contains "$governance_file" '.github-private'
done

printf '\nResults: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
