# Changelog

## [Unreleased]

## [1.4.0] - 2026-10-21

## [1.3.0] - 2026-10-15

### Breaking Changes

- Worker-backed results and `close()` now settle after requesting shutdown, not after worker exit. Hosts that require actual exit must track `onWorkerStarted(exited)` or retain capacity through `acquireWorker()`'s release callback

### Added

- Added `CodemodeSandbox`'s `onWorkerStarted(exited)` callback so hosts can count a worker against concurrency limits until it actually exits, independently of its script result
- Added `CodemodeSandbox`'s `acquireWorker()` hook to reserve shared capacity before starting a worker and release it only on actual exit or constructor failure

### Fixed

- Fixed aborts, timeouts, and `close()` waiting for worker termination on Bun while a non-interruptible built-in runs; shutdown now requests termination without waiting for exit ([#10748](https://github.com/earendil-works/pi/issues/10748))

## [1.2.0] - 2026-10-12

### Breaking Changes

- Removed `MCP_TYPESCRIPT_PREAMBLE` and `mcpStructuredContentSchema()`. `renderToolOutputType()` and the declarations built on it render every output schema as its own type and no longer turn MCP `CallToolResult` schemas into `CallToolResult<T>`; describe MCP results in the output schema instead

### Added

- Added `RemoteCodemodeSandbox`, which runs each script's VM in another isolate while tools run in the caller. `CodemodeSandboxDurableObject` from the new `@earendil-works/pi-codemode/cloudflare` entry is its remote end, deployed as its own Cloudflare Worker. `examples/cloudflare` shows the setup
- Added `InlineCodemodeSandbox`, which runs the VM on the calling thread for runtimes without worker threads. Its `interruptBudget` limits scripts that compute without awaiting a tool
- Added the `@earendil-works/pi-codemode/portable` entry, which has no Node imports, and `CodemodeSandboxBase`, the API all three sandboxes share
- Added `sandbox.start()`, a deterministic run whose calls the host answers itself (`onCall`, `run.deliver()`), so a host can replay a script after a restart: a virtual clock from `startedAt`, randomness from `seed`, UTC, no `WeakRef`/`FinalizationRegistry`, results applied in the order the host numbers them, the VM's fingerprint (`onStarted`), the calls issued after each result (`onIdle`), and whether the run has its outcome (`run.finished`). Works with every sandbox; `execute()` is unchanged

### Changed

- `schemaToType()` and the declarations built on it show property constraints the TypeScript type cannot express as tags on the property's comment line, such as `// @integer @minimum 0 @maximum 30000 @default 0`. Covered keywords: `integer`, numeric bounds, `multipleOf`, string length, `pattern`, `format`, array length, `uniqueItems`, non-null `default`, and `deprecated`; constraints of nullable `anyOf`/`oneOf` fields are read from the non-null branch, and draft-04 boolean `exclusiveMinimum`/`exclusiveMaximum` are shown as exclusive bounds. Property descriptions now also split on U+2028/U+2029. A type over `maxChars` is rendered again without tags before it becomes `unknown` ([#10707](https://github.com/earendil-works/pi/issues/10707))
- `image()` errors describe the accepted image block as `{ type: "image", data, mimeType }` instead of an MCP image block
- The VM now polls for interrupts while it drains promise jobs, so a script such as `while (true) await null` is stopped at the same points as a synchronous loop

### Fixed

- Fixed `parseCodemodeSource()` ignoring a `// @options:` line that is not the first line, so its `timeout_ms` never applied; it now throws `CodemodeSourceError` ([#10631](https://github.com/earendil-works/pi/issues/10631))
- Fixed `CodemodeSandbox` failing with a broken bridge error when the host runs under `node --watch` on Node 24 or 26, which posts `watch:import`/`watch:require` messages on the worker channel ([#10725](https://github.com/earendil-works/pi/issues/10725))

## [1.1.0] - 2026-10-07

### Added

- Added `console: true` to text output items produced by `console.*`, so hosts can tell them apart from `text()` output

## [1.0.4] - 2026-10-05

### Changed

- Built-ins are frozen and built-in globals are read-only before the script runs, so patches such as `Array.prototype.toJSON = ...` have no effect. Instances can still override `constructor`, `name`, `message`, `toString`, `toLocaleString`, `valueOf`, `toJSON`, and `Object.prototype` members ([#10444](https://github.com/earendil-works/pi/issues/10444))

### Fixed

- Fixed a script that patched built-ins crashing the host process and leaving `execute()` unsettled. Malformed payloads from the worker now fail the execution with a `sandbox` error ([#10444](https://github.com/earendil-works/pi/issues/10444))

## [1.0.3] - 2026-10-05

## [1.0.2] - 2026-10-04

## [1.0.1] - 2026-10-03

### Fixed

- Fixed scripts that print in a loop growing the host's memory until it crashes: output is limited to `MAX_OUTPUT_CHARS` (16 Mi) characters and `MAX_OUTPUT_ITEMS` (100000) items, and a script past either limit fails with a `RangeError` ([#10283](https://github.com/earendil-works/pi/issues/10283))

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
