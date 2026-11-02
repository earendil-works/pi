#!/usr/bin/env bash
# Decides what a CI push run publishes to pkg.earendil.com, for .github/workflows/preview-packages.yml. Prints the
# `preview-packages.mjs publish` arguments, one per line: `--ref main` for main, `--tag <tag>` and `--ref latest` for a
# release tag (`--tag` only for a pre-release), nothing for any other name. Fails when the run must not publish.
#
# A tag push's head_branch is the tag's name, and a branch or tag can carry its own copy of CI. So a tag named `main`
# or `v1.2.3` on an unreviewed commit would pass a name check: every push run must also be for a commit on main, and a
# release tag must point at that commit.
#
# Environment: GITHUB_REPOSITORY, HEAD_SHA and HEAD_BRANCH of the CI run, RELEASE_TAG (the release tag pattern),
# GH_TOKEN for `gh api`.

set -euo pipefail

repo="repos/$GITHUB_REPOSITORY"

# main is resolved as the branch: in compare, a tag named `main` would win over a bare `main`.
require_on_main() {
	local main status
	main=$(gh api "$repo/git/ref/heads/main" --jq .object.sha)
	status=$(gh api "$repo/compare/$main...$HEAD_SHA" --jq .status)
	if [ "$status" != behind ] && [ "$status" != identical ]; then
		echo "::error::$HEAD_SHA is not on main; compare status: $status" >&2
		exit 1
	fi
}

# The commit a tag points at. Annotated tags point at a tag object, which can point at another tag.
tag_commit() {
	local ref type target
	ref=$(gh api "$repo/git/ref/tags/$1" --jq '"\(.object.type) \(.object.sha)"')
	read -r type target <<< "$ref"
	for _ in 1 2 3 4 5; do
		[ "$type" = tag ] || break
		ref=$(gh api "$repo/git/tags/$target" --jq '"\(.object.type) \(.object.sha)"')
		read -r type target <<< "$ref"
	done
	if [ "$type" != commit ]; then
		echo "::error::$1 does not resolve to a commit" >&2
		exit 1
	fi
	echo "$target"
}

if [ "$HEAD_BRANCH" = main ]; then
	require_on_main
	printf '%s\n' --ref main
	exit 0
fi

if ! [[ "$HEAD_BRANCH" =~ $RELEASE_TAG ]]; then
	echo "::notice::$HEAD_BRANCH is not a release tag; nothing to publish" >&2
	exit 0
fi
require_on_main
target=$(tag_commit "$HEAD_BRANCH")
if [ "$target" != "$HEAD_SHA" ]; then
	echo "::error::$HEAD_BRANCH points at $target, not $HEAD_SHA" >&2
	exit 1
fi
printf '%s\n' --tag "$HEAD_BRANCH"
# A pre-release is kept under its tag, but `latest` stays on the newest release.
if [[ "$HEAD_BRANCH" != *-* ]]; then printf '%s\n' --ref latest; fi
