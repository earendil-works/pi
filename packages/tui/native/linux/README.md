# Linux clipboard helper

`linux-platform-x11.node` provides native X11 text and image reads, including `TARGETS` discovery and incremental (`INCR`) transfers. It links to the system `libxcb.so.1`. Coding-agent retains command fallbacks when the native helper or its dependencies are unavailable.

Clipboard operations use N-API async work through `../clipboard.h`, with at most one private thread performing X11 I/O. Event and reply polling share a two-second deadline. The N-API worker waits at most three seconds, allowing transfer errors to arrive before its own timeout. Concurrent requests return unavailable immediately, so at most one shared libuv worker waits, and only until that deadline.

Connection setup and flushing remain libxcb operations and cannot be forcibly cancelled. If the private thread stalls, reads return unavailable until it finishes; late results are freed and subsequent requests can retry. A stalled thread cannot delay process exit after the bounded N-API wait. The addon uses `NODELETE` so a thread can safely outlive the Node environment that loaded it. The helper does not fork or launch an executable.

The addon has no direct libc dependency, so the same architecture's prebuild can load on glibc and musl when libxcb is installed. The build uses the linker's default page alignment, including support for larger ARM64 system pages.

`getNativeClipboard()` loads the X11 addon when `DISPLAY` is set, without opening a display. Its `getText()` and `getImage()` methods return promises: `undefined` means unavailable, `null` means absent content, and a rejected promise means a transfer failure. Display availability is checked again on each operation.

Native Wayland support is deferred. Coding-agent retains `wl-paste` for Wayland text/image reads and `wl-copy` for writes. Linux writes also retain the existing xclip, xsel, Termux, and OSC 52 paths; the native helper does not own clipboard selections.

## Building

Install a C compiler and XCB development headers, then run on Linux:

```sh
npm --prefix packages/tui run build:native:linux
```

Build once on each supported architecture (`x64` and `arm64`). No Wayland development libraries or protocol generator are required.

## Testing

From `packages/tui`, run:

```sh
node --test test/native-clipboard-linux.test.ts
```

The tests require the build dependencies plus `pkg-config`, `Xvfb`, and `xclip`. They use isolated X11 servers and skip when dependencies are absent. Coverage includes Unicode, Latin-1, large incremental transfers, metadata validation, cleanup after failed transfers, transfer deadlines, and event-loop responsiveness during stalled connections and transfers. A controlled blocking callback separately verifies bounded admission, unrelated filesystem work, late-result cleanup, recovery, process exit, and Node Worker termination.
