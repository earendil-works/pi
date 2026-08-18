# Changelog

> **Fork notice:** this is the closed-network fork
> [tculpepp/secure-pi-mono](https://github.com/tculpepp/secure-pi-mono), published as
> `@tculpepp/spi-*`. Entries below are upstream's; issue links point at
> [earendil-works/pi](https://github.com/earendil-works/pi).

## [Unreleased]

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Breaking Changes

- Restricted assistant and tool transcript lifecycle schemas to valid state combinations and terminal items.
- Replaced `SessionSummarySchema` and `SessionSummary` with durable `SessionMetadataSchema` and `SessionMetadata` for session lists; runtime state remains in acquired `SessionSnapshot` values ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Added

- Added transport-neutral CBOR protocol schemas, codecs, and length-prefixed framing for remote pi sessions.
- Added `not_implemented` and `internal_error` protocol error codes for sanitized server failures ([#7644](https://github.com/earendil-works/pi/pull/7644)).
