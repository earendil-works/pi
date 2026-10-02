# Changelog

## [Unreleased]

## [1.0.0] - 2026-10-01

### Added

- Added `renderToolOutputType()`, the type a tool call resolves to.

### Changed

- Reading a member of `tools` or of a global namespace that does not exist now throws an error naming the close matches, instead of returning `undefined`. Use `"name" in tools` to check for a tool. `store()` size errors explain what the store is for.

## [0.99.2] - 2026-09-30

### Changed

- Allowed `CodemodeSandbox.workerUrl` to be a string, as required for embedded worker entrypoints in Bun compiled executables ([#10204](https://github.com/earendil-works/pi/issues/10204)).

### Fixed

- Fixed `image()` accepting malformed base64 data and unsupported image types. It now throws a `TypeError` unless the data is valid base64 of a PNG, JPEG, GIF, or WebP image, derives the MIME type from the image signature instead of the declared type, and strips line breaks from wrapped base64 ([#10215](https://github.com/earendil-works/pi/issues/10215)).

## [0.99.1] - 2026-09-29

## [0.99.0] - 2026-09-29

### Added

- Initial spike: `CodemodeSandbox` runs model-written JavaScript in a worker thread and exposes injected tools as `tools.<name>(args)` async functions.
