# libghostty-vt

`ghostty-vt.wasm` is [Ghostty](https://github.com/ghostty-org/ghostty)'s terminal library (VT parser, terminal state,
render state, key encoding, formatter) built for WebAssembly. The page draws terminals with it
(`plugins/terminals/ghostty-screen.tsx`), loaded through `plugins/terminals/ghostty.ts` when a terminal is shown. The
server keeps no copy: it forwards a terminal's raw output (decision 133).

- Version: libghostty-vt 1.0.1, tag `vt-1.0.1` (ghostty-org/ghostty `108cacb17ed8990840cd14abfce43d8ed8503ca1`)
- File: the official release build `ghostty-vt-1.0.1-small.wasm` (ReleaseSmall, then `wasm-opt -O3`; needs WebAssembly
  SIMD) from <https://release.files.ghostty.org/libghostty-vt/1.0.1/>, its minisign signature checked against the key in
  Ghostty's `PACKAGING.md` (`RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV`); the same file as p2's
  (`apps/p2/plugins/terminals/vendor/ghostty/`)
- SHA-256: `e226900d2126faab515668e5400b69fc78ba3d99aaf9525b325f79707b29bf01` (as in the release's `SHA256SUMS`;
  `test/ghostty.test.ts` checks it)
- License: MIT, see [LICENSE](LICENSE).

Struct layouts come from `ghostty_type_json()` at runtime; enum values and function signatures are hardcoded in
`ghostty.ts`. libghostty-vt keeps its C ABI stable within a major version, so a 1.x update only needs the new file and
this README.
