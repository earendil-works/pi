#!/bin/sh
# Builds build/Pi.app from the Swift package: the binary, Info.plist, the icon, an ad-hoc signature (no Developer ID
# yet). CONFIG=release for an optimized build.
set -eu
cd "$(dirname "$0")/.."
config="${CONFIG:-debug}"
swift build -c "$config"
bin="$(swift build -c "$config" --show-bin-path)/P2Mac"
if [ ! -f build/AppIcon.icns ] || [ scripts/make-icon.swift -nt build/AppIcon.icns ]; then
	rm -rf build/AppIcon.iconset
	mkdir -p build
	swift scripts/make-icon.swift build/AppIcon.iconset
	iconutil -c icns build/AppIcon.iconset -o build/AppIcon.icns
fi
app=build/Pi.app
rm -rf "$app" build/P2.app
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
# SwiftPM records the deployment target (14.0) as the SDK the binary was built with, and AppKit then draws the
# window chrome of that release: small, closely spaced window buttons and a 52-point toolbar instead of the current
# ones. Record the real SDK.
vtool -set-build-version macos 14.0 "$(xcrun --sdk macosx --show-sdk-version)" -replace -output "$app/Contents/MacOS/Pi" "$bin" 2>/dev/null
cp Resources/Info.plist "$app/Contents/Info.plist"
cp build/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$app"
echo "$app"
