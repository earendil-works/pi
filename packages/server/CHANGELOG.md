# Changelog

## [Unreleased]

## [0.85.0] - 2026-09-04

## [0.84.4] - 2026-08-28

## [0.84.3] - 2026-08-24

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Breaking Changes

- Changed `toProtocolToolResultMessage()` to require the original `ToolCall` and verify tool result association.
- Changed `PiServerService.listSessions()` to return durable `SessionMetadata` instead of runtime `SessionSummary` values ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Fixed

- Hardened protocol adapters against contradictory lifecycle states, invalid identifiers and timestamps, sparse execution arrays, and additive `pi-ai` contract drift.
- Sanitized service and runtime failures into stable `not_implemented` and `internal_error` responses without exposing private error details ([#7644](https://github.com/earendil-works/pi/pull/7644)).

## [0.83.0] - 2026-07-29

## [0.82.1] - 2026-07-25

## [0.82.0] - 2026-07-24

## [0.81.1] - 2026-07-21

## [0.81.0] - 2026-07-21

### Changed

- Renamed the orchestrator workspace package and internal server references to server ([#6898](https://github.com/earendil-works/pi/pull/6898) by [@cristinaponcela](https://github.com/cristinaponcela)).

## [0.80.10] - 2026-07-16

## [0.80.9] - 2026-07-16

## [0.80.8] - 2026-07-16

## [0.80.7] - 2026-07-14

## [0.80.6] - 2026-07-09

## [0.80.5] - 2026-07-09

## [0.80.4] - 2026-07-09

## [0.80.3] - 2026-06-30
