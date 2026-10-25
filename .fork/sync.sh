#!/usr/bin/env bash
# Keep this fork's integration branch `next` consistent with `main` and the branches in `branches`.
#
#   .fork/sync.sh --status             show where main, every branch and next stand; exit 1 if next is stale or
#                                      has stray commits, a branch is not on main, or main has commits upstream lacks
#   .fork/sync.sh --align              reset main, the branches and next to origin when nothing local would be lost
#   .fork/sync.sh --rebuild-only       rebuild next from the current branch tips (no fetch, no rebase)
#   .fork/sync.sh                      fetch upstream, fast-forward main, rebase every branch, rebuild next
#   .fork/sync.sh --upstream-rev REV   like the full sync but fast-forward main to REV instead of upstream/main
#   .fork/sync.sh --offline            full sync without fetching
#   .fork/sync.sh --no-check           skip .fork/check.sh focused after the rebuild
#   .fork/sync.sh --push               push main, next, the branches and the pre-sync tags with --force-with-lease
#
# Layout: `next` starts at the first branch in `branches` and merges each following branch with
# --no-ff, in file order. Nothing is ever committed directly on `next`; the rebuild refuses if it
# finds such commits (cherry-pick them onto the owning branch first). Signed pre-sync tags record
# every tip before anything moves. The script refuses to run on a dirty working tree.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# .fork/ is part of next (from fork/tooling), and a rebuild checks out branches without it, so the
# script runs from a copy of .fork/ and finds the checkout through FORK_SYNC_REPO.
if [[ -z "${FORK_SYNC_REPO:-}" ]]; then
	repo="$(cd "$here/.." && git rev-parse --show-toplevel)"
	copy="$(mktemp -d)"
	# Run the tooling as fork/tooling has it, not as the checked-out branch has it: after a change to
	# .fork/branches on fork/tooling, next still carries the old list until it is rebuilt. Commit .fork/
	# changes on fork/tooling before running them; without a local fork/tooling, use this copy.
	if git -C "$repo" rev-parse -q --verify refs/heads/fork/tooling >/dev/null; then
		git -C "$repo" archive refs/heads/fork/tooling .fork | tar -x -C "$copy" --strip-components=1
	else
		cp -R "$here/." "$copy/"
	fi
	FORK_SYNC_REPO="$repo" FORK_SYNC_COPY="$copy" exec bash "$copy/sync.sh" "$@"
fi
repo="$FORK_SYNC_REPO"
[[ "${FORK_SYNC_COPY:-}" != "$here" ]] || trap 'rm -rf "$here"' EXIT
cd "$repo"

mode="full"
upstream_rev="upstream/main"
fetch=1
check=1
push=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--status) mode="status"; shift ;;
		--rebuild-only) mode="rebuild"; shift ;;
		--align) mode="align"; shift ;;
		--upstream-rev) upstream_rev="$2"; shift 2 ;;
		--offline|--no-fetch) fetch=0; shift ;;
		--no-check) check=0; shift ;;
		--push) push=1; shift ;;
		-h|--help) sed -n '2,17p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

mapfile -t branches < <(grep -vE '^\s*(#|$)' "$here/branches")
[[ ${#branches[@]} -ge 1 ]] || { echo "no branches listed in $here/branches" >&2; exit 2; }

short() { git rev-parse --short "$1"; }
count() { git rev-list --count "$@"; }
is_ancestor() { git merge-base --is-ancestor "$1" "$2"; }

stray_on_next() {
	local excludes=(^main)
	for b in "${branches[@]}"; do excludes+=("^$b"); done
	count --no-merges next "${excludes[@]}"
}

missing_from_next() {
	local missing=()
	for b in "${branches[@]}"; do is_ancestor "$b" next || missing+=("$b"); done
	is_ancestor main next || missing+=("main")
	printf '%s\n' "${missing[@]:-}"
}

status() {
	local rc=0 current missing_local=()
	current="$(git branch --show-current || echo '(detached)')"
	echo "fork status ($repo)"
	for ref in main "${branches[@]}" next; do
		git rev-parse -q --verify "refs/heads/$ref" >/dev/null || missing_local+=("$ref")
	done
	if [[ ${#missing_local[@]} -gt 0 ]]; then
		echo "  missing local branches: ${missing_local[*]}"
		echo "  run .fork/sync.sh --align to create them from origin, then re-run --status"
		return 1
	fi
	if git rev-parse -q --verify upstream/main >/dev/null; then
		printf '  %-30s %s  upstream/main has %s commit(s) main lacks\n' main "$(short main)" "$(count main..upstream/main)"
		# main mirrors upstream: a commit upstream lacks would ride into next under every branch.
		local ahead
		ahead="$(count upstream/main..main)"
		if [[ "$ahead" -gt 0 ]]; then
			printf '  %-30s %s  NOT A MIRROR: %s commit(s) upstream lacks\n' main "$(short main)" "$ahead"
			rc=1
		fi
	else
		printf '  %-30s %s  (upstream not fetched; git fetch upstream)\n' main "$(short main)"
	fi
	for b in "${branches[@]}"; do
		local rel="no origin ref"
		if git rev-parse -q --verify "origin/$b" >/dev/null; then
			rel="ahead $(count "origin/$b..$b") behind $(count "$b..origin/$b") vs origin"
		fi
		local based="on main"
		is_ancestor main "$b" || { based="NOT rebased onto main"; rc=1; }
		printf '  %-30s %s  %s; %s\n' "$b" "$(short "$b")" "$rel" "$based"
	done
	local stray missing
	stray="$(stray_on_next)"
	missing="$(missing_from_next)"
	local verdict="current"
	if [[ -n "$missing" ]]; then verdict="STALE: missing $(echo "$missing" | tr '\n' ' ')"; rc=1; fi
	if [[ "$stray" -gt 0 ]]; then verdict="$verdict; STRAY: $stray commit(s) on next belong on a branch"; rc=1; fi
	printf '  %-30s %s  %s\n' next "$(short next)" "$verdict"
	if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then echo "  working tree: DIRTY (tracked changes)"; else echo "  working tree: clean"; fi
	case "$current" in
		next|main) echo "  you are on $current: do not commit here, switch to the owning branch (see .fork/AGENTS.md)" ;;
		*) echo "  you are on $current" ;;
	esac
	return $rc
}

require_clean() {
	# Untracked files (such as .fork/ before it is excluded, or CLAUDE.local.md) do not block branch operations.
	if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
		echo "working tree has uncommitted changes to tracked files; commit or stash first" >&2
		exit 1
	fi
}

tag_tips() {
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	for ref in "$@"; do
		git rev-parse -q --verify "refs/heads/$ref" >/dev/null || { echo "missing local branch $ref" >&2; exit 1; }
		git tag -m "state before sync $stamp" "pre-sync/$stamp/${ref//\//-}" "$ref"
	done
	echo "tagged current tips under pre-sync/$stamp/"
}

refuse_stray() {
	local stray
	stray="$(stray_on_next)"
	if [[ "$stray" -gt 0 ]]; then
		echo "next has $stray commit(s) that are on no branch; cherry-pick them onto the owning branch, then re-run:" >&2
		git log --no-merges --format='  %h %s' next ^main "${branches[@]/#/^}" >&2
		exit 1
	fi
}

# Caller must run refuse_stray first, before any rebase: after the branches move, the old next
# legitimately contains commits that are no longer on any branch tip.
rebuild_next() {
	git checkout -q -B next "${branches[0]}"
	for b in "${branches[@]:1}"; do
		git merge --no-ff --no-edit -m "Merge branch '$b' into next" "$b" >/dev/null
	done
	echo "next -> $(short next)"
}

align_refs() {
	local rc=0 ref local_sha wt
	git fetch -q --prune origin
	git remote get-url upstream >/dev/null 2>&1 && { git fetch -q --prune upstream || true; }
	git fetch -q origin '+refs/tags/*:refs/tags/*' 2>/dev/null || true
	for ref in main "${branches[@]}" next; do
		if ! git rev-parse -q --verify "refs/remotes/origin/$ref" >/dev/null; then
			echo "  $ref: no origin/$ref, skipped"; continue
		fi
		if ! git rev-parse -q --verify "refs/heads/$ref" >/dev/null; then
			git branch -q --track "$ref" "origin/$ref"; echo "  $ref: created at $(short "origin/$ref")"; continue
		fi
		local_sha="$(git rev-parse "$ref")"
		if [[ "$local_sha" == "$(git rev-parse "origin/$ref")" ]]; then echo "  $ref: already at origin"; continue; fi
		# Safe only when nothing would be lost: every non-merge commit of the local tip is on an origin
		# branch or tag. Merges carry no work of their own; an older next made only of merges qualifies.
		if [[ -n "$(git rev-list --no-merges "$local_sha" --not --remotes=origin --tags)" ]]; then
			echo "  $ref: local $(short "$ref") has commits on no origin branch or tag; push or tag them first, skipped" >&2
			rc=1; continue
		fi
		wt="$(git worktree list --porcelain | awk -v b="refs/heads/$ref" '$1=="worktree"{w=$2} $1=="branch"&&$2==b{print w}')"
		if [[ -n "$wt" && "$wt" != "$repo" ]]; then
			if [[ -n "$(git -C "$wt" status --porcelain)" ]]; then echo "  $ref: checked out with changes at $wt, skipped" >&2; rc=1; continue; fi
			git -C "$wt" reset -q --hard "origin/$ref"
		elif [[ "$wt" == "$repo" ]]; then
			git reset -q --hard "origin/$ref"
		else
			git branch -q -f "$ref" "origin/$ref"
		fi
		echo "  $ref: $(short "$local_sha") -> $(short "origin/$ref")"
	done
	return $rc
}

push_all() {
	git push --force-with-lease origin main next "${branches[@]}"
	git push origin "refs/tags/pre-sync/$stamp/*"
	echo "pushed main, next, ${#branches[@]} branches and pre-sync/$stamp tags"
}

case "$mode" in
	status)
		status
		;;
	align)
		require_clean
		align_refs
		;;
	rebuild)
		require_clean
		for ref in main "${branches[@]}"; do
			git rev-parse -q --verify "refs/heads/$ref" >/dev/null || { echo "missing local branch $ref; run .fork/sync.sh --align first" >&2; exit 1; }
		done
		if [[ -z "$(missing_from_next)" && "$(stray_on_next)" -eq 0 ]]; then
			echo "next $(short next) already contains every branch tip; nothing to rebuild"
		else
			refuse_stray
			tag_tips next
			rebuild_next
		fi
		[[ $check -eq 0 ]] || "$repo/.fork/check.sh" focused
		[[ $push -eq 0 ]] || { stamp="${stamp:-$(date -u +%Y%m%dT%H%M%SZ)}"; git push --force-with-lease origin next "${branches[@]}"; echo "pushed next and ${#branches[@]} branches"; }
		;;
	full)
		require_clean
		for ref in main "${branches[@]}" next; do
			git rev-parse -q --verify "refs/heads/$ref" >/dev/null || { echo "missing local branch $ref; run .fork/sync.sh --align first" >&2; exit 1; }
		done
		if [[ $fetch -eq 1 ]]; then
			git fetch --prune upstream
			git fetch --prune origin
		fi
		if [[ "$(git rev-parse main)" == "$(git rev-parse "$upstream_rev^{commit}")" && -z "$(missing_from_next)" && "$(stray_on_next)" -eq 0 ]]; then
			echo "main is already at $upstream_rev ($(short main)) and next $(short next) is current; nothing to do"
			exit 0
		fi
		refuse_stray
		tag_tips main next "${branches[@]}"
		git checkout -q main
		git merge --ff-only "$upstream_rev"
		echo "main -> $(short main)"
		for b in "${branches[@]}"; do
			git checkout -q "$b"
			if ! git rebase -q main; then
				echo "rebase of $b onto main failed; resolve it, 'git rebase --continue', then re-run with --offline" >&2
				exit 1
			fi
			echo "  $b -> $(short "$b") ($(count main..HEAD) commits)"
		done
		rebuild_next
		[[ $check -eq 0 ]] || "$repo/.fork/check.sh" focused
		[[ $push -eq 0 ]] || push_all
		;;
esac
