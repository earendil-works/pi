#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compiler="${CC:-cc}"

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "Linux native helpers must be built on Linux" >&2
    exit 1
fi

case "$(uname -m)" in
    x86_64)
        arch="x64"
        ;;
    aarch64|arm64)
        arch="arm64"
        ;;
    *)
        echo "Unsupported Linux architecture: $(uname -m)" >&2
        exit 1
        ;;
esac

if ! command -v "$compiler" >/dev/null 2>&1; then
    echo "Linux C compiler not found: $compiler" >&2
    exit 1
fi
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-tui-linux.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT

common_flags=(
    -std=c11
    -D_POSIX_C_SOURCE=200809L
    -Wall
    -Wextra
    -Werror
    -Os
    -flto
    -fPIC
    -pthread
    -fvisibility=hidden
    -fno-stack-protector
    -shared
    -nostdlib
    -Wl,--unresolved-symbols=ignore-all
    -Wl,--no-as-needed
    -Wl,-O2
    -Wl,--gc-sections
    # A timed-out private thread may outlive the Node environment that loaded us.
    -Wl,-z,nodelete
    -Wl,-s
)

x11_output="$build_dir/linux-platform-x11.node"
"$compiler" "${common_flags[@]}" \
    "$script_dir/src/linux-platform-x11.c" \
    -lxcb \
    -o "$x11_output"

output_dir="$script_dir/prebuilds/linux-$arch"
mkdir -p "$output_dir"
install -m 755 "$x11_output" "$output_dir/linux-platform-x11.node"
printf 'Built %s\n' "$output_dir/linux-platform-x11.node"
