#!/usr/bin/env bash
# scripts/install-agent-skills.sh
#
# Installs the canonical Agent Skills in .agents/skills/ onto the other agent
# surfaces in this repo (`.claude/skills/` for Claude Code and `.kilo/skills/`
# for Kilo) so every agent surface carries the same guidance.
#
# .agents/skills/ is the canonical source: it is committed to the repository and
# is Pi's documented project skill location. `.claude/` is gitignored (local
# only); `.kilo/skills/` is a committed mirror guarded by
# scripts/check-agent-skill-parity.mjs; `.cline/skills/` mirrors the same
# surface for Cline sessions.
#
# Idempotent: a skill is only rewritten when its SKILL.md differs from what is
# already installed, so re-running is safe and cheap.
#
# Usage:
#   ./scripts/install-agent-skills.sh          # install (write differences)
#   ./scripts/install-agent-skills.sh --check  # dry-run; exit 1 if any drift
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANONICAL="$ROOT/.agents/skills"
MIRRORS=("$ROOT/.claude/skills" "$ROOT/.kilo/skills" "$ROOT/.cline/skills")

PASS=0
FAIL=0
SKIP=0
CHANGED=0
DRIFT=0

check_mode=0
if [[ "${1:-}" == "--check" ]]; then
  check_mode=1
fi

if [[ ! -d "$CANONICAL" ]]; then
  printf 'FAIL  canonical skills directory %s does not exist\n' "$CANONICAL"
  exit 1
fi

copy_skill() {
  local name="$1"
  local src="$CANONICAL/$name/SKILL.md"
  local wrote=0
  local drifted=0

  for mirror in "${MIRRORS[@]}"; do
    local dest="$mirror/$name/SKILL.md"
    if [[ "$check_mode" -eq 1 ]]; then
      if [[ -f "$dest" ]] && cmp -s "$src" "$dest"; then
        : # matches
      else
        drifted=1
      fi
      continue
    fi

    if [[ -f "$dest" ]] && cmp -s "$src" "$dest"; then
      : # already identical, nothing to do
    else
      if ! mkdir -p "$mirror/$name"; then
        printf 'FAIL  %s: cannot create %s\n' "$name" "$mirror/$name"
        FAIL=$((FAIL + 1))
        return 1
      fi
      if ! cp "$src" "$dest"; then
        printf 'FAIL  %s: cannot write %s\n' "$name" "$dest"
        FAIL=$((FAIL + 1))
        return 1
      fi
      wrote=1
    fi
  done

  if [[ "$check_mode" -eq 1 ]]; then
    if [[ "$drifted" -eq 1 ]]; then
      printf 'FAIL  %s: drifted from canonical (mirrors out of sync)\n' "$name"
      DRIFT=$((DRIFT + 1))
      FAIL=$((FAIL + 1))
    else
      printf 'PASS  %s: in sync with canonical\n' "$name"
      PASS=$((PASS + 1))
    fi
    return 0
  fi

  if [[ "$wrote" -eq 1 ]]; then
    printf 'PASS  %s: installed to mirrors\n' "$name"
    PASS=$((PASS + 1))
    CHANGED=$((CHANGED + 1))
  else
    printf 'SKIP  %s: already installed\n' "$name"
    SKIP=$((SKIP + 1))
    PASS=$((PASS + 1))
  fi
}

# Process every skill directory in the canonical source, sorted for stable output.
shopt -s nullglob
skills=("$CANONICAL"/*/)
shopt -u nullglob

if [[ ${#skills[@]} -eq 0 ]]; then
  printf 'WARN  no skills found in %s\n' "$CANONICAL"
fi

for skill_dir in "${skills[@]}"; do
  name="$(basename "$skill_dir")"
  if [[ ! -f "$CANONICAL/$name/SKILL.md" ]]; then
    printf 'FAIL  %s: no SKILL.md\n' "$name"
    FAIL=$((FAIL + 1))
    continue
  fi
  copy_skill "$name"
done

printf '\nResults: %s passed, %s failed, %s skipped' "$PASS" "$FAIL" "$SKIP"
if [[ "$check_mode" -eq 1 ]]; then
  printf ', %s drift' "$DRIFT"
else
  printf ', %s changed' "$CHANGED"
fi
printf '\n'

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
exit 0
