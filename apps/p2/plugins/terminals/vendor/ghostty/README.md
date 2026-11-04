# libghostty-vt

`ghostty-vt.wasm` is [Ghostty](https://github.com/ghostty-org/ghostty)'s terminal library (VT parser, terminal state,
render state, key encoding, formatter) built for WebAssembly. The browser renders terminals with it
(`plugins/terminals/Terminal.tsx`), and the terminal host keeps a headless copy of every terminal for reconnecting browsers
(`plugins/terminals/main.ts`). Both load it through `plugins/terminals/ghostty.ts`.

- Source: ghostty-org/ghostty at `2de5e7d38e1354759211722a8687c0815d2cf02c`
- Built with Zig 0.16.0:
  `zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall`
- SHA-256: `ba4dfb2cdb5dfb1c9924552983e04af18d36a9b98de41a6aef74bed6d0202db2`
- License: MIT, see [LICENSE](LICENSE).

Struct layouts come from `ghostty_type_json()` at runtime, so a rebuild from a newer commit keeps working unless the
API itself changes.
