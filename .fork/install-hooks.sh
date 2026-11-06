#!/usr/bin/env bash
# Install the fork's git hooks in every worktree of this checkout: pre-push refuses pushes of next and main.
#
#   .fork/install-hooks.sh     run from any worktree of the fork checkout; safe to re-run
#
# The checkout's hooks run through husky (core.hooksPath=.husky/_, relative, so each worktree has its own):
# husky's stub runs .husky/<hook> when that file exists. The hook is copied there, kept out of git through
# info/exclude, and also into the common hooks directory for a worktree without husky.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
common="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)"

exclude="$common/info/exclude"
mkdir -p "$common/info" "$common/hooks"
grep -qx '.husky/pre-push' "$exclude" 2>/dev/null || echo '.husky/pre-push' >> "$exclude"
install -m 755 "$here/pre-push" "$common/hooks/pre-push"
echo "installed $common/hooks/pre-push"

git -C "$here" worktree list --porcelain | awk '$1 == "worktree" { print substr($0, 10) }' | while IFS= read -r wt; do
	[[ -d "$wt/.husky" ]] || continue
	install -m 755 "$here/pre-push" "$wt/.husky/pre-push"
	echo "installed $wt/.husky/pre-push"
done
