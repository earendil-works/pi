# Darwin native prebuilds

Build both macOS architectures from the repository root:

```sh
npm --prefix packages/tui run build:native:darwin
```

The build uses macOS 11.0 as the arm64 deployment target and macOS 10.15 as the x86_64 deployment target. On macOS, `build.sh` finds Apple clang and the active macOS SDK through `xcrun`. Either an Intel or Apple Silicon host can build both outputs.

A non-macOS host needs a complete Darwin cross-toolchain, including a macOS SDK and a Mach-O linker. For example, an osxcross installation can be selected with `CC` and `SDKROOT`:

```sh
CC=/path/to/osxcross/clang SDKROOT=/path/to/MacOSX.sdk \
  npm --prefix packages/tui run build:native:darwin
```

The SDK must be obtained and used in accordance with Apple's license. Plain Linux or Windows clang is not enough because the addon includes and links CoreGraphics.

Zig is not used here because it does not provide the Apple SDK or CoreGraphics framework stubs. It therefore does not make this build SDK-independent, and its clang driver does not currently handle this Mach-O bundle recipe as a drop-in replacement for Apple clang.
