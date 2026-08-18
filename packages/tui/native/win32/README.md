# Windows native prebuilds

Build both Windows architectures from the repository root:

```sh
npm --prefix packages/tui run build:native:win32
```

On Windows, the build uses the Microsoft C++ Build Tools from Visual Studio. `build.mjs` locates `VsDevCmd.bat`, initializes a developer environment for `amd64` and `arm64`, and builds the addon with `cl.exe`/`link.exe`.

Install the "Desktop development with C++" workload, or at minimum the MSVC toolset and Windows SDK components. No Node headers are required; the addon resolves N-API symbols from the host process.

For non-Windows cross-builds, or for custom Windows toolchains, set `PI_TUI_WIN32_TOOLCHAIN=mingw` and provide MinGW-compatible compilers:

```sh
PI_TUI_WIN32_TOOLCHAIN=mingw \
CC_X64=/path/to/x86_64-w64-mingw32-gcc \
CC_ARM64=/path/to/aarch64-w64-mingw32-gcc \
npm --prefix packages/tui run build:native:win32
```

The addon intentionally avoids the C runtime and links only against `kernel32`.
