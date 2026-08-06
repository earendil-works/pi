# Changelog

## [Unreleased]

## [0.84.0] - 2026-08-06

### Breaking Changes

- Renamed the package from `@earendil-works/pi-storage-sqlite-node` to `@earendil-works/pi-session-backend-sqlite-node`.
- Replaced the legacy SQLite session schema and repository with the v4 lane-based `SessionRepo` contract. Existing work-in-progress databases are not migrated.

### Added

- Added bounded active-branch queries, durable operation records, global facts, shared sequence allocation, session statistics, and fenced writer leases to the SQLite backend.

### Fixed

- Fixed SQLite session listings to avoid acquiring writer claims and include current session names, allowing inventory reads while sessions have active writers ([#7655](https://github.com/earendil-works/pi/pull/7655)).

## [0.83.0] - 2026-07-29

## [0.82.1] - 2026-07-25

## [0.82.0] - 2026-07-24

## [0.81.1] - 2026-07-21

## [0.81.0] - 2026-07-21

### Added

- Added a Node.js SQLite storage backend for agent harness sessions, including migrations and materialized session views ([#6594](https://github.com/earendil-works/pi/pull/6594) by [@cristinaponcela](https://github.com/cristinaponcela)).
