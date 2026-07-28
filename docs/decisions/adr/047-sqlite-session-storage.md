# 047: SQLite Session Storage Backend

**Date:** 2026-07-21
**Source:** Commit `9e7582aa`

## Context

Session storage used JSONL files on disk — one file per session, with entries appended as newline-delimited JSON. This worked for single-user local usage but had limitations: reading a session required scanning the entire file, branching required tree traversal, and there was no indexing for quick lookups (session list, search, stats). The AgentHarness (ADR-043) abstracted session storage behind a `SessionStorage` interface, which made it possible to add alternative backends without changing the session logic.

## Decision

Add a SQLite session storage backend in a new `packages/session-backend-sqlite` package. Define a schema with tables for session headers, entries, sequences (preserving the append-only JSONL semantics), branches, and materialized views for quick resume stats. Implement a migration system for schema evolution. Wire the backend into the AgentHarness session abstraction alongside the existing JSONL and in-memory backends.

## Consequences

- SQLite enables indexed queries: session listing, full-text search, and aggregated stats don't require full file scans.
- The migration system allows the schema to evolve without breaking existing sessions.
- The JSONL format remains the default for backward compatibility. SQLite is opt-in through the AgentHarness configuration.
- Adding a SQLite dependency increases the binary size and adds build complexity (native bindings for `better-sqlite3` or similar).
- The schema design (sequences table) preserves the append-only semantics that the session tree (ADR-023) depends on.

## Confidence

High. Commit body and schema definitions document the design and migration strategy.
