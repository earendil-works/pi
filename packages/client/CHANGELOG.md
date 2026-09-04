# Changelog

## [Unreleased]

## [0.85.0] - 2026-09-04

## [0.84.4] - 2026-08-28

## [0.84.3] - 2026-08-24

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Breaking Changes

- Replaced `SessionSummary` with durable `SessionMetadata` for `PiClient.listSessions()` and server snapshots; runtime state is available only from acquired session snapshots ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Added

- Added the experimental transport-neutral `PiClient` and multi-session `PiSessionHandle` APIs with structured `PiServerError` responses.
