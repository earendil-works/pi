#!/usr/bin/env bash
# Read-only validation of the NLT-Pi repository governance baseline.
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

printf 'NLT-Pi Governance Validation\nRoot: %s\n\n' "$ROOT"
check_file "nltotoi.json"

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
  process.stdout.write(path + "\\n");
}
' "$ROOT/nltotoi.json")"; then
  printf 'FAIL  nltotoi.json has an invalid required_files inventory\n'
  ((FAIL+=1))
else
  while IFS= read -r required_path; do
    [[ -n "$required_path" ]] && check_file "$required_path"
  done <<< "$required_json"
fi

check_contains NLT-DEV-OTOI.md NLT-PI-DEV-OTOI-1.0.0
check_contains NLT-DEV-OTOI.md 'Capability does not equal authority'
check_contains AGENTS.md 'ASFDK harness'
check_contains AGENTS.md 'ASFDK MCP'
check_contains nltotoi.json 'NeuroLift-Technologies/nlt-pi'
check_contains .claude/settings.json SessionStart

printf '\\nResults: %s passed, %s failed\\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
