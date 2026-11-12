#!/usr/bin/env bash
# Regression tests for sync.sh's public command-line behavior.
set -euo pipefail

# A focused check can run inside an outer sync; the fixture must use its own temporary repository.
unset FORK_SYNC_REPO FORK_SYNC_COPY

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

git init -q --bare "$tmp/origin.git"
git init -q "$tmp/seed"
cd "$tmp/seed"
git config user.name "Fork sync test"
git config user.email "fork-sync-test@example.com"
git config commit.gpgsign false
git config tag.gpgsign false
git config core.hooksPath /dev/null
git checkout -q -b main
printf 'base a\n' > a.txt
printf 'base b\n' > b.txt
git add a.txt b.txt
git commit -q -m "base"

git checkout -q -b feat/a
printf 'fork a\n' > a.txt
git add a.txt
git commit -q -m "change a"

git checkout -q -b feat/b main
printf 'fork b\n' > b.txt
git add b.txt
git commit -q -m "change b"

git checkout -q -b fork/tooling main
mkdir .fork
cp "$here/sync.sh" .fork/sync.sh
printf 'feat/a\nfeat/b\nfork/tooling\n' > .fork/branches
chmod +x .fork/sync.sh
git add .fork/branches .fork/sync.sh
git commit -q -m "add fork tooling"

git checkout -q -b next feat/a
git merge -q --no-ff --no-edit feat/b
git merge -q --no-ff --no-edit fork/tooling
git remote add origin "$tmp/origin.git"
git push -q origin main feat/a feat/b fork/tooling next

# Upstream conflicts with both feature branches.
git checkout -q main
printf 'upstream a\n' > a.txt
printf 'upstream b\n' > b.txt
git add a.txt b.txt
git commit -q -m "upstream conflicts"

# A local branch commit makes the old implementation rebuild and push next despite the conflicts.
git clone -q --branch next "$tmp/origin.git" "$tmp/work"
cd "$tmp/work"
git config user.name "Fork sync test"
git config user.email "fork-sync-test@example.com"
git config commit.gpgsign false
git config tag.gpgsign false
git config core.hooksPath /dev/null
for ref in main feat/a feat/b fork/tooling; do git branch -q "$ref" "origin/$ref"; done
git remote add upstream "$tmp/seed"
git fetch -q upstream main
git checkout -q feat/b
printf 'local only\n' > local.txt
git add local.txt
git commit -q -m "local branch work"
git checkout -q next

refs=(main next feat/a feat/b fork/tooling)
declare -A before
for ref in "${refs[@]}"; do before["$ref"]="$(git rev-parse "$ref")"; done
origin_next_before="$(git --git-dir="$tmp/origin.git" rev-parse refs/heads/next)"

set +e
output="$(GITHUB_ACTIONS=true GITHUB_STEP_SUMMARY="$tmp/summary.md" .fork/sync.sh --hold-on-conflict --no-check --push 2>&1)"
rc=$?
set -e
printf '%s\n' "$output"
[[ $rc -ne 0 ]] || fail "a sync with rebase conflicts exited successfully"
for branch in feat/a feat/b; do
	[[ "$output" == *"$branch:"* ]] || fail "conflict report omitted $branch"
done
for ref in "${refs[@]}"; do
	[[ "$(git rev-parse "$ref")" == "${before[$ref]}" ]] || fail "conflicting sync moved local $ref"
done
[[ "$(git --git-dir="$tmp/origin.git" rev-parse refs/heads/next)" == "$origin_next_before" ]] ||
	fail "conflicting sync pushed a partial next"

set +e
status_output="$(.fork/sync.sh --status 2>&1)"
status_rc=$?
set -e
printf '%s\n' "$status_output"
[[ $status_rc -ne 0 ]] || fail "status succeeded while main was behind upstream"

echo "PASS: conflicts fail before refs move or next is pushed, and status rejects a held main"
