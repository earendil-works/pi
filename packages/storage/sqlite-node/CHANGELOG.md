# Changelog

## [Unreleased]

### Breaking Changes

- Replaced the legacy SQLite session schema and repository with the v4 lane-based `SessionRepo` contract. Existing work-in-progress databases are not migrated.

### Added

- Added bounded active-branch queries, durable operation records, global facts, shared sequence allocation, session statistics, and fenced writer leases to the SQLite backend.

## [0.83.0] - 2026-07-29

## [0.82.1] - 2026-07-25

## [0.82.0] - 2026-07-24

## [0.81.1] - 2026-07-21

## [0.81.0] - 2026-07-21

### Added

- Added a Node.js SQLite storage backend for agent harness sessions, including migrations and materialized session views ([#6594](https://github.com/earendil-works/pi/pull/6594) by [@cristinaponcela](https://github.com/cristinaponcela)).
