# 023: Session Tree Structure with id/parentId Branching

**Date:** 2025-12-22
**Source:** Commit `c58d5f20`

## Context

Session storage was a flat entry list where every new message, compaction, or branch appended to the same array. No way to express branching: switching paths meant starting a new session file. The compaction system (ADR-014) worked around this by replacing entries with summaries, but the original history was lost. Users who wanted to explore alternate paths couldn't switch between them.

## Decision

Replace the flat entry list with a tree structure. Every entry gains an `id` and `parentId`, forming a directed acyclic graph. The `SessionManager` tracks a `leafId` pointing to the current position in the tree. `buildSessionContext()` traverses from leaf back to root, collecting the active path. Branching is native: switching to a different leaf produces a different context path from the same session file. Compaction returns a `CompactionResult` (content only) rather than modifying the tree structure. Old sessions are migrated from flat to tree format on load.

## Consequences

- Branching is no longer a separate session. Users explore alternate paths within one session file and switch between them.
- `buildSessionContext()` replaces ad-hoc message collection. The tree traversal determines what the LLM sees based on the active leaf.
- Compaction becomes cleaner: it compresses content without affecting the tree topology. The tree preserves what happened, compaction summarizes the content.
- Old sessions migrate on load. One-way, rewrites the file. A bug could corrupt session files, which required a recovery script (v0.30.2 fix).
- The tree adds complexity to the session manager. Operations that were simple array pushes now require tree-aware insertion.

## Confidence

High. The commit body and the session-tree-plan.md document the design and migration strategy.
