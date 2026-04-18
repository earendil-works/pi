# Architecture Proposal

## Summary

Implement v1 memory as a global append-only artifact memory store with workspace-specific derived projections.

Recommended v1 shape:

- authoritative memory lives under `~/.mu/wiki/`
- memory entries are append-only and file-backed
- each workspace gets its own derived projection for startup and retrieval
- automatic writes happen only after durable artifact-producing actions
- explicit user-directed memory actions go through model-facing memory tools
- retrieval uses a stable memory-tool boundary instead of generic file discovery
- no LLM classifier or every-turn conversational memory in v1

## Proposed Boundaries

### `packages/coding-agent/src/memory/*`
- Own the authoritative append-only memory entry store.
- Own entry parsing, append behavior, and projection building.
- Own workspace-scoped derived views.

### `packages/coding-agent/src/tools/*`
- Own model-facing memory tools for explicit user-directed memory interactions.
- Recommended v1 tool surface:
  - `memory_search`
  - `memory_read`
  - `memory_store` (explicit user request only)

### agent/tool execution integration
- Own post-tool memory triggers for:
  - `edit`
  - `apply_patch`
  - `write`
  - `bash` when it produced durable artifacts
- Do not trigger memory writes for ordinary chat turns in v1.

### CLI / exec validation surface
- Own `mu exec --json` verification scenarios that prove write-then-fresh-session-retrieve behavior.
- Own workspace-isolation/projection verification.

### Test surface
- Unit tests for entry store, projection derivation, and explicit memory tools.
- Integration tests for post-tool memory writes.
- Real CLI verification through `mu exec --json` in temp workspaces.

## Key Abstractions

- `MemoryStore`
  - append entry
  - list/query entries
  - read by id

- `MemoryProjector`
  - derive workspace startup projection
  - derive workspace retrieval index/view
  - rebuild projections from authoritative entries

- `MemoryQuery`
  - workspace-first retrieval
  - optional global fallback

- `ArtifactMemoryTrigger`
  - evaluate completed tool results
  - append durable artifact/decision entries when warranted

## Tradeoffs

### Chosen design: append-only entries as authority
- avoids stale synchronized wiki/index state
- keeps projections derivable and swappable
- costs projection rebuild logic

### Chosen design: workspace projections as derived views
- gives relevance at startup and retrieval time
- preserves one shared global memory substrate
- requires explicit workspace provenance on entries

### Chosen design: artifact-triggered automation only
- simple and observable
- captures durable work outcomes without needing a classifier
- misses purely conversational durable facts in v1

### Chosen design: explicit memory tools for user-directed memory actions
- gives a stable validation boundary
- makes explicit memory operations legible in transcripts
- adds a small tool surface that must be maintained

### Rejected design: LLM classifier for every turn
- more flexible later
- too heavy-handed for v1
- harder to validate and tune safely right now

## What Matters Most

1. One authoritative append-only memory shape.
2. Workspace-specific projections with workspace-first retrieval.
3. Stable explicit memory-tool boundary for retrieval and user-requested storage.
4. Automatic writes only from durable artifact-producing actions.
5. Real `mu exec --json` validation across fresh sessions.
6. Swappability: projections/search can evolve without changing the authoritative model.

## Approved Design Decisions

- Storage scope: global under `~/.mu/wiki/`
- Authority: append-only memory entries, not the wiki index or startup digest
- Projection model: one derived projection per workspace
- Automatic write triggers: `edit`, `apply_patch`, `write`, and artifact-producing `bash`
- Explicit user-directed memory actions should use memory tools by then
- No LLM classifier in v1

## Out of Scope

- conversational memory automation
- every-turn memory passes
- embedding-based write gates
- full wiki preload at startup
- sophisticated ranking/embedding retrieval as a correctness dependency for v1
