# TDR-004: Session Tree Migration Without Rollback

**Date:** 2025-12-31
**Source:** Commit `cb6310e1`

The session tree format (ADR-023) required migrating existing flat session files to the new tree structure. The migration runs on load and rewrites the file in place. A bug in the initial migration (v0.30.0) corrupted session files, requiring a recovery script (v0.30.2). The one-way migration means there is no fallback to the old format — once migrated, a session cannot be opened by older versions of the agent. The recovery script only handles the known corruption pattern, not arbitrary migration failures.

**Related to:** [ADR-023](adr/023-session-tree-structure.md)
