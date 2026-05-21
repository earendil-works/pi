#!/usr/bin/env bash
#
# Build lyla binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-deps] [--platform <platform>]
#
# Options:
#   --skip-deps         Skip installing cross-platform dependencies
#   --platform <name>   Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
#
# Output:
#   packages/coding-agent/binaries/
#     lyla-darwin-arm64.tar.gz
#     lyla-darwin-x64.tar.gz
#     lyla-linux-x64.tar.gz
#     lyla-linux-arm64.tar.gz
#     lyla-windows-x64.zip
#     lyla-windows-arm64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_DEPS=false
PLATFORM=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

echo "==> Installing dependencies..."
npm ci --ignore-scripts

if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Installing cross-platform native bindings..."
    # npm ci only installs optional deps for the current platform
    # We need all platform bindings for bun cross-compilation
    # Use --force to bypass platform checks (os/cpu restrictions in package.json)
    # Install all in one command to avoid npm removing packages from previous installs
    npm install --no-save --package-lock=false --force --ignore-scripts \
        @mariozechner/clipboard-darwin-arm64@0.3.2 \
        @mariozechner/clipboard-darwin-x64@0.3.2 \
        @mariozechner/clipboard-linux-x64-gnu@0.3.2 \
        @mariozechner/clipboard-linux-arm64-gnu@0.3.2 \
        @mariozechner/clipboard-win32-x64-msvc@0.3.2 \
        @mariozechner/clipboard-win32-arm64-msvc@0.3.2 \
        @img/sharp-darwin-arm64@0.34.5 \
        @img/sharp-darwin-x64@0.34.5 \
        @img/sharp-linux-x64@0.34.5 \
        @img/sharp-linux-arm64@0.34.5 \
        @img/sharp-win32-x64@0.34.5 \
        @img/sharp-win32-arm64@0.34.5 \
        @img/sharp-libvips-darwin-arm64@1.2.4 \
        @img/sharp-libvips-darwin-x64@1.2.4 \
        @img/sharp-libvips-linux-x64@1.2.4 \
        @img/sharp-libvips-linux-arm64@1.2.4
else
    echo "==> Skipping cross-platform native bindings (--skip-deps)"
fi

echo "==> Building all packages..."
npm run build

echo "==> Building binaries..."
cd packages/coding-agent

# Clean previous builds
rm -rf binaries
mkdir -p binaries/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    if [[ "$platform" == windows-* ]]; then
        bun build --compile --target=bun-$platform ./dist/bun/cli.js --outfile binaries/$platform/lyla.exe
    else
        bun build --compile --target=bun-$platform ./dist/bun/cli.js --outfile binaries/$platform/lyla
    fi
done

echo "==> Creating release archives..."

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json binaries/$platform/
    cp README.md binaries/$platform/
    cp CHANGELOG.md binaries/$platform/
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm binaries/$platform/
    mkdir -p binaries/$platform/theme
    cp dist/modes/interactive/theme/*.json binaries/$platform/theme/
    mkdir -p binaries/$platform/assets
    cp dist/modes/interactive/assets/* binaries/$platform/assets/
    cp -r dist/core/export-html binaries/$platform/
    cp -r docs binaries/$platform/
    cp -r examples binaries/$platform/

    # Copy Windows VT input native helper next to compiled Windows binaries.
    if [[ "$platform" == windows-* ]]; then
        if [[ "$platform" == "windows-arm64" ]]; then
            win32_arch_dir="win32-arm64"
        else
            win32_arch_dir="win32-x64"
        fi
        mkdir -p binaries/$platform/native/win32/prebuilds/$win32_arch_dir
        cp ../tui/native/win32/prebuilds/$win32_arch_dir/win32-console-mode.node binaries/$platform/native/win32/prebuilds/$win32_arch_dir/
    fi
done

# Create archives
cd binaries

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        # Windows (zip)
        echo "Creating lyla-$platform.zip..."
        (cd $platform && zip -r ../lyla-$platform.zip .)
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating lyla-$platform.tar.gz..."
        mv $platform lyla && tar -czf lyla-$platform.tar.gz lyla && mv lyla $platform
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf $platform
    if [[ "$platform" == windows-* ]]; then
        mkdir -p $platform && (cd $platform && unzip -q ../lyla-$platform.zip)
    else
        tar -xzf lyla-$platform.tar.gz && mv lyla $platform
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in packages/coding-agent/binaries/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "  binaries/$platform/lyla.exe"
    else
        echo "  binaries/$platform/lyla"
    fi
done
