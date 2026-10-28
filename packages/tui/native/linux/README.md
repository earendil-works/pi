# Linux clipboard helper

Provides asynchronous X11 text and image reads using `libxcb.so.1`. Prebuilds support x64 and arm64 on glibc and musl. Reads have bounded waits; if a native operation stalls, the helper remains unavailable until it finishes.

Coding-agent falls back to command-line tools when native reads are unavailable. Wayland reads use `wl-paste`; all Linux writes use the existing command-line or terminal clipboard paths.

## Building

Install a C compiler and XCB development headers, then run from the repository root on each supported Linux architecture:

```sh
npm --prefix packages/tui run build:native:linux
```

## Testing

Install the build dependencies plus `pkg-config`, `Xvfb`, and `xclip`, then run from `packages/tui`:

```sh
node --test test/native-clipboard-linux.test.ts
```

Tests use isolated X11 servers, not the desktop clipboard. They skip when dependencies are missing.
