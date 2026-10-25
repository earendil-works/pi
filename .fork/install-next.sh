#!/usr/bin/env bash
# Install the newest release of the fork's `next` branch and point `pi` at it.
#
#   install-next.sh              download the latest next release, verify it, switch `pi` to it
#   install-next.sh --tag TAG    install a given release (next-<commit>) instead of the latest
#   install-next.sh --rollback   switch `pi` back to the previous release
#   install-next.sh --reinstall  download the release again even if it is installed
#
# Options (flags override the environment):
#   --root DIR       releases live here            PI_INSTALL_ROOT  default ~/.local/share/pi-fork
#   --repo OWNER/NAME  GitHub repository           PI_REPO          default JangMan-J/pi
#   --bin-dir DIR    where the `pi` symlink goes   PI_BIN_DIR       default ~/.local/bin
#
# The fork's workflow checks every next commit, packs it in the layout pi's own installer produces,
# and publishes it as the GitHub release next-<commit> with a SHA-256 file; this script only
# downloads, verifies, unpacks and switches. It needs curl, tar, sha256sum and Node 22.19 or newer.
# Layout: releases/<tag>/ per release; `current` and `previous` link to releases, and `pi` links
# through `current`, so a switch is one rename and running sessions keep their files. Releases other
# than current and previous are deleted after a switch.
set -euo pipefail

root="${PI_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/pi-fork}"
repo="${PI_REPO:-JangMan-J/pi}"
bin_dir="${PI_BIN_DIR:-$HOME/.local/bin}"
mode="install"
tag=""

while [[ $# -gt 0 ]]; do
	case "$1" in
		--root) root="$2"; shift 2 ;;
		--repo) repo="$2"; shift 2 ;;
		--bin-dir) bin_dir="$2"; shift 2 ;;
		--tag) tag="$2"; shift 2 ;;
		--rollback) mode="rollback"; shift ;;
		--reinstall) mode="reinstall"; shift ;;
		-h|--help) sed -n '2,20p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'install-next: %s\n' "$*" >&2; exit 1; }

for tool in curl tar sha256sum node; do
	command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' ||
	die "Node 22.19 or newer is required (found $(node --version))"

mkdir -p "$root/releases"
root="$(cd "$root" && pwd -P)"
cli_path="node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
asset="pi-next.tar.gz"

target_of() { readlink "$root/$1" 2>/dev/null || true; }
# Point `current` or `previous` at a release with one rename, so readers never see it missing.
point() {
	ln -sfn "$2" "$root/.$1.tmp"
	mv -T "$root/.$1.tmp" "$root/$1"
}
link_pi() {
	mkdir -p "$bin_dir"
	ln -sfn "$root/current/$cli_path" "$bin_dir/pi"
	case ":$PATH:" in
		*":$bin_dir:"*) ;;
		*) echo "note: $bin_dir is not on PATH" >&2 ;;
	esac
	printf '\npi %s from %s (%s)\n' "$(node "$root/current/$cli_path" --version)" \
		"$(basename "$(target_of current)")" "$bin_dir/pi"
}

if [[ "$mode" == "rollback" ]]; then
	current="$(target_of current)"
	previous="$(target_of previous)"
	[[ -n "$previous" && -f "$previous/.installed" && -f "$previous/$cli_path" ]] ||
		die "there is no previous release to roll back to"
	point current "$previous"
	point previous "$current"
	say "Rolled back to $(basename "$previous")"
	link_pi
	exit 0
fi

if [[ -z "$tag" ]]; then
	say "Finding the latest release of $repo"
	latest="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")" ||
		die "cannot reach https://github.com/$repo/releases/latest"
	tag="${latest##*/}"
fi
[[ "$tag" =~ ^next-[0-9a-f]{12}$ ]] || die "no next release found (latest is '$tag')"
release="$root/releases/$tag"

if [[ "$mode" == "install" && -f "$release/.installed" && "$(target_of current)" == "$release" ]]; then
	say "$tag is already the current release"
	link_pi
	exit 0
fi

if [[ "$mode" == "reinstall" || ! -f "$release/.installed" ]]; then
	[[ "$(target_of current)" != "$release" ]] ||
		die "cannot replace $tag while it is the current release; running sessions use it"
	download="$(mktemp -d)"
	trap 'rm -rf "$download"' EXIT
	say "Downloading $tag"
	base="https://github.com/$repo/releases/download/$tag"
	curl -fsSL --retry 3 -o "$download/$asset" "$base/$asset" || die "cannot download $base/$asset"
	curl -fsSL --retry 3 -o "$download/$asset.sha256" "$base/$asset.sha256" || die "cannot download $base/$asset.sha256"
	(cd "$download" && sha256sum --quiet -c "$asset.sha256") || die "$asset does not match its SHA-256; nothing was changed"
	rm -rf "$release"
	mkdir -p "$release"
	tar -xzf "$download/$asset" -C "$release"
	node "$release/$cli_path" --version >/dev/null || die "$tag does not start; pi is unchanged and the release stays at $release"
	touch "$release/.installed"
fi

current="$(target_of current)"
point current "$release"
# A release from the older source-build layout cannot be rolled back to; it is deleted below.
if [[ -n "$current" && "$current" != "$release" && -f "$current/$cli_path" ]]; then
	point previous "$current"
elif [[ -n "$current" && "$current" != "$release" ]]; then
	rm -f "$root/previous"
fi
say "Switched to $tag"
link_pi

keep_current="$(target_of current)"
keep_previous="$(target_of previous)"
for dir in "$root"/releases/*/; do
	dir="${dir%/}"
	[[ "$dir" == "$keep_current" || "$dir" == "$keep_previous" ]] || { rm -rf "$dir"; echo "removed old release $(basename "$dir")"; }
done
