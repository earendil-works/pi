# Windows native prebuilds

`pi-job.exe` runs the bash and PowerShell tools' commands in a named job object, so pi can kill a command's whole process tree on abort or timeout, including background processes whose parent shell already exited (`taskkill /T` cannot find those). Background processes left when a command finishes keep running, as they do on Unix. See the header of `src/pi-job.c` for the modes. Links to `kernel32` only, without the C runtime.

## Building

On Windows, install Visual Studio's "Desktop development with C++" workload, then run from the repository root to build x64 and arm64:

```sh
npm --prefix packages/coding-agent run build:native:win32
```

For cross-builds or custom toolchains, provide MinGW-compatible compilers (for example [llvm-mingw](https://github.com/mstorsjo/llvm-mingw), which targets both):

```sh
PI_WIN32_TOOLCHAIN=mingw \
CC_X64=/path/to/x86_64-w64-mingw32-clang \
CC_ARM64=/path/to/aarch64-w64-mingw32-clang \
npm --prefix packages/coding-agent run build:native:win32
```
