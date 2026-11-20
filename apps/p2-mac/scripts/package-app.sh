#!/usr/bin/env bash
# Packages Pi.app as a release that needs nothing installed: this commit's p2 with its production dependencies and
# the Node it runs on go into Contents/Resources (ServerConfig.bundled finds them there). Then it signs the app,
# checks that the signed server starts, builds a DMG, notarizes it and signs it for Sparkle. Output in build/dist:
# the DMG and build.json, the fields pkg.earendil.com's app upload takes.
#
#   ./scripts/package-app.sh          ad-hoc signed, no notarization, no updater: a local test of the bundle
#
# Environment (all optional; CI sets them, .github/workflows/p2-mac-nightly.yml):
#   SIGN_IDENTITY                             codesign identity, e.g. "Developer ID Application: … (TEAMID)"
#   NOTARY_KEY, NOTARY_KEY_ID, NOTARY_ISSUER  App Store Connect API key (.p8 file) for notarytool
#   SPARKLE_PUBLIC_KEY                        Sparkle's EdDSA public key: the app gets the feed and updates itself
#   SPARKLE_KEY_FILE                          its private key file, to sign the DMG for Sparkle
#   FEED_URL                                  the appcast; default: pkg.earendil.com's nightly channel
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(cd ../.. && pwd)"

NODE_VERSION=v26.13.1
NODE_SHA256=af6202f5370a3a5209e85dc543758dfd9f44c8726626a236730cd603a67a8559
MINIMUM_SYSTEM_VERSION=14.0
FEED_URL="${FEED_URL:-https://pkg.earendil.com/-/apps/pi-mac/nightly/appcast.xml}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"

work=build/package
app=build/Pi.app
dist=build/dist
rm -rf "$work" "$dist"
mkdir -p "$work" "$dist" build/cache

# Versions come from the commit: Sparkle orders builds by CFBundleVersion (the commit's UTC minute), people read the
# short version (its day).
sha="$(git -C "$root" rev-parse HEAD)"
version="$(TZ=UTC git -C "$root" log -1 --format=%cd --date=format-local:%Y%m%d%H%M)"
short_version="$(TZ=UTC git -C "$root" log -1 --format=%cd --date=format-local:%Y.%m.%d)"
echo "packaging $sha as $short_version ($version)"

# Node: the official build, checked against its pinned hash.
node_archive="build/cache/node-$NODE_VERSION-darwin-arm64.tar.xz"
if [ ! -f "$node_archive" ] || ! echo "$NODE_SHA256  $node_archive" | shasum -a 256 -c - >/dev/null 2>&1; then
	curl -fsSL -o "$node_archive" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-arm64.tar.xz"
	echo "$NODE_SHA256  $node_archive" | shasum -a 256 -c -
fi
tar -xf "$node_archive" -C "$work"
node_dir="$PWD/$work/node-$NODE_VERSION-darwin-arm64"

# p2: a clean copy of the commit (uncommitted changes stay out), with p2's production dependencies, installed and
# hydrated by the Node it will run on.
src="$work/src"
mkdir -p "$src"
git -C "$root" archive HEAD | tar -x -C "$src"
(
	cd "$src"
	export PATH="$node_dir/bin:$PATH"
	npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w apps/p2
	npm run hydrate:model-data >/dev/null
)

CONFIG=release ./scripts/build-app.sh
resources="$app/Contents/Resources"
mkdir -p "$resources/node/bin" "$resources/p2/apps"
cp "$node_dir/bin/node" "$resources/node/bin/node"
cp "$node_dir/LICENSE" "$resources/node/LICENSE"
# The source resolver (apps/p2/src/source-resolver.ts) reads the root tsconfig's paths; packages resolve through it.
cp "$src/package.json" "$src/tsconfig.json" "$src/tsconfig.base.json" "$resources/p2/"
cp -R "$src/node_modules" "$resources/p2/node_modules"
# The workspace packages p2 uses are the ones npm linked: node_modules/@earendil-works/x -> ../../packages/x.
for link in "$src"/node_modules/@earendil-works/*; do
	[ -L "$link" ] || continue
	package="$(readlink "$link")"
	package="${package#../../}"
	mkdir -p "$resources/p2/$package"
	for part in package.json src node_modules; do
		if [ -e "$src/$package/$part" ]; then cp -R "$src/$package/$part" "$resources/p2/$package/"; fi
	done
done
rsync -a --exclude /p2/test --exclude /p2/docs "$src/apps/p2" "$resources/p2/apps/"
# Links to workspaces left out (none today) would break the signature.
find "$resources/p2" -type l ! -exec test -e {} \; -print -delete

plist="$app/Contents/Info.plist"
set_plist() { /usr/libexec/PlistBuddy -c "Delete :$1" "$plist" >/dev/null 2>&1 || true; /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$plist"; }
set_plist CFBundleVersion string "$version"
set_plist CFBundleShortVersionString string "$short_version"
set_plist LSMinimumSystemVersion string "$MINIMUM_SYSTEM_VERSION"
set_plist PiCommit string "$sha"
if [ -n "${SPARKLE_PUBLIC_KEY:-}" ]; then
	set_plist SUFeedURL string "$FEED_URL"
	set_plist SUPublicEDKey string "$SPARKLE_PUBLIC_KEY"
	set_plist SUEnableAutomaticChecks bool true
	# Downloads in the background and installs when Pi quits.
	set_plist SUAutomaticallyUpdate bool true
fi

# Signing, inside out: every Mach-O file in the resources (Node, esbuild, native addons), Sparkle's helpers, the app.
# Notarization needs the hardened runtime and a secure timestamp on all of them. An ad-hoc build goes without the
# hardened runtime: its library validation needs a Team ID, which ad-hoc signatures lack, so Sparkle would not load.
sign=(codesign --force --sign "$SIGN_IDENTITY")
if [ "$SIGN_IDENTITY" != "-" ]; then sign+=(--options runtime --timestamp); fi
find "$resources" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' \) -print0 |
	while IFS= read -r -d '' file; do
		if file -b "$file" | grep -q '^Mach-O'; then
			if [ "$file" = "$resources/node/bin/node" ]; then
				"${sign[@]}" --entitlements scripts/node.entitlements "$file"
			else
				"${sign[@]}" "$file"
			fi
		fi
	done
sparkle="$app/Contents/Frameworks/Sparkle.framework/Versions/B"
"${sign[@]}" "$sparkle/XPCServices/Installer.xpc"
"${sign[@]}" --preserve-metadata=entitlements "$sparkle/XPCServices/Downloader.xpc"
"${sign[@]}" "$sparkle/Autoupdate"
"${sign[@]}" "$sparkle/Updater.app"
"${sign[@]}" "$app/Contents/Frameworks/Sparkle.framework"
"${sign[@]}" --entitlements scripts/app.entitlements "$app"
codesign --verify --deep --strict "$app"

./scripts/smoke-app.sh "$app"

file="Pi-$short_version-$version.dmg"
dmg="$dist/$file"
staging="$work/dmg"
mkdir -p "$staging"
ditto "$app" "$staging/Pi.app"
ln -s /Applications "$staging/Applications"
# HFS+: an APFS image of the same app compresses to more than twice the size.
hdiutil create -quiet -volname Pi -srcfolder "$staging" -fs HFS+ -format ULMO -ov "$dmg"
if [ "$SIGN_IDENTITY" != "-" ]; then codesign --force --sign "$SIGN_IDENTITY" --timestamp "$dmg"; fi

if [ -n "${NOTARY_KEY:-}" ]; then
	xcrun notarytool submit "$dmg" --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait
	xcrun stapler staple "$dmg"
fi

# Sparkle signs the final bytes, so after stapling.
ed_signature=""
if [ -n "${SPARKLE_KEY_FILE:-}" ]; then
	ed_signature="$(.build/artifacts/sparkle/Sparkle/bin/sign_update -p --ed-key-file "$SPARKLE_KEY_FILE" "$dmg")"
fi

cat >"$dist/build.json" <<EOF
{
	"sha": "$sha",
	"file": "$file",
	"version": "$version",
	"shortVersion": "$short_version",
	"minimumSystemVersion": "$MINIMUM_SYSTEM_VERSION",
	"edSignature": "$ed_signature"
}
EOF
du -h "$dmg"
cat "$dist/build.json"
