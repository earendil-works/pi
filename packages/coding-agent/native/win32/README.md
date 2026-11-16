# Windows native prebuilds

`pi-job.exe` runs the bash and PowerShell tools' commands in a named job object, so pi can kill a command's whole process tree on abort or timeout, including background processes whose parent shell already exited (`taskkill /T` cannot find those). Background processes left when a command finishes keep running, as they do on Unix; a small holder process keeps their job alive until they exit. The holder runs from a copy in the temp directory (`%TEMP%\pi-job-holder-*.exe`), so it never keeps pi's installation in use. See the header of `src/pi-job.c` for the modes. Links to `kernel32` only, without the C runtime.

If the helper cannot run (for example blocked by security software) or cannot create a job, commands run as they did before, and pi falls back to `taskkill /T`.

## Building

The committed prebuilds are built with [zig](https://ziglang.org/download/) 0.17.1 (`zig cc`), which cross-compiles both architectures from any OS and links deterministically: rebuilding from the same source gives identical bytes. From the repository root:

```sh
npm --prefix packages/coding-agent run build:native:win32
```

zig is used when it is on `PATH` (or `ZIG=/path/to/zig` is set). Otherwise the script uses Visual Studio's "Desktop development with C++" workload on Windows, or MinGW-compatible compilers:

```sh
PI_WIN32_TOOLCHAIN=mingw \
CC_X64=/path/to/x86_64-w64-mingw32-clang \
CC_ARM64=/path/to/aarch64-w64-mingw32-clang \
npm --prefix packages/coding-agent run build:native:win32
```
