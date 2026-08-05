#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_file="$script_dir/src/darwin-modifiers.c"

if [[ -n "${CC:-}" ]]; then
    compiler="$CC"
elif [[ "$(uname -s)" == "Darwin" ]] && command -v xcrun >/dev/null 2>&1; then
    compiler="$(xcrun --find clang)"
else
    compiler="clang"
fi

if ! command -v "$compiler" >/dev/null 2>&1; then
    echo "Darwin C compiler not found: $compiler" >&2
    exit 1
fi

sdk_flags=()
if [[ -n "${SDKROOT:-}" ]]; then
    if [[ ! -d "$SDKROOT" ]]; then
        echo "SDKROOT does not exist: $SDKROOT" >&2
        exit 1
    fi
    sdk_flags=(-isysroot "$SDKROOT" "-F$SDKROOT/System/Library/Frameworks")
elif [[ "$(uname -s)" == "Darwin" ]]; then
    sdkroot="$(xcrun --sdk macosx --show-sdk-path)"
    sdk_flags=(-isysroot "$sdkroot" "-F$sdkroot/System/Library/Frameworks")
fi

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-tui-darwin.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT

build() {
    local arch="$1"
    local target="$2"
    local output_dir="$script_dir/prebuilds/darwin-$arch"
    local temporary_output="$temporary_dir/darwin-$arch/darwin-modifiers.node"

    mkdir -p "$(dirname "$temporary_output")"
    "$compiler" \
        -std=c11 \
        -Wall \
        -Wextra \
        -O2 \
        "--target=$target" \
        "${sdk_flags[@]}" \
        -bundle \
        -undefined dynamic_lookup \
        -framework CoreGraphics \
        "$source_file" \
        -o "$temporary_output"

    mkdir -p "$output_dir"
    install -m 755 "$temporary_output" "$output_dir/darwin-modifiers.node"
    echo "Built $output_dir/darwin-modifiers.node"
}

build arm64 arm64-apple-macos11.0
build x64 x86_64-apple-macos10.15
