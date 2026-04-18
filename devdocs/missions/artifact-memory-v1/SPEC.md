---
mode: build
---

# 1. Summary & Recommendation

Implement v1 memory as a global append-only artifact memory system with workspace-specific derived projections and a small explicit memory tool boundary.

The authoritative state must be append-only memory entries under `~/.mu/wiki/`. Startup and retrieval should use derived workspace projections. Automatic memory writes must happen only after durable artifact-producing actions (`edit`, `apply_patch`, `write`, and artifact-producing `bash`). When the user explicitly asks to save/store memory, the agent should use the memory tool surface rather than ad hoc generic file editing.

# 2. What Must be True

- There is one authoritative global memory store under `~/.mu/wiki/`.
- The authoritative state is append-only memory entries, not a hand-maintained wiki index.
- Each workspace has a unique derived memory projection.
- Retrieval is workspace-first, with optional global fallback.
- Automatic memory writes happen only after completed durable artifact-producing actions:
  - `edit`
  - `apply_patch`
  - `write`
  - `bash` when durable artifacts were produced
- Explicit user-directed memory writes use a model-facing memory tool by the time this mission is complete.
- The model can retrieve memory through a stable memory boundary instead of rediscovering file layout with generic tools.
- Fresh-session retrieval works through `mu exec --json` validation.
- Updated memory can supersede older memory while preserving append-only history.

# 3. What Must Never Happen

- The full memory corpus must never be blindly loaded into startup context.
- The index/startup digest must never become the authoritative source of truth.
- Ordinary chat turns must never auto-write memory in v1.
- Automatic memory writes must never trigger on non-durable/no-op tool activity.
- Explicit memory storage requested by the user must never bypass the memory tool surface once that tool exists.
- Workspace projections must never leak unrelated workspace-local memory as the primary retrieval result.
- Memory retrieval correctness must never depend on embeddings or an LLM classifier in v1.

# 4. Inputs / Outputs

## Inputs

- completed tool executions for `edit`, `apply_patch`, `write`, and artifact-producing `bash`
- explicit user requests to save/store memory
- fresh-session retrieval requests through `mu exec --json`
- workspace path / workspace identity

## Outputs

- append-only memory entries under `~/.mu/wiki/`
- derived per-workspace projections for startup/retrieval
- explicit memory-tool read/search/store results
- retrieval answers in fresh sessions

## Recommended Tool Surface

- `memory_search`
- `memory_read`
- `memory_store`

# 5. Edge Cases

- tool changed files but yielded no durable memory-worthy outcome
- `bash` ran successfully but produced no artifact
- the same artifact/decision is stored repeatedly
- explicit user memory request updates or supersedes prior memory
- two workspaces store conflicting local facts
- retrieval from a fresh session with no prior conversation context
- empty global memory store
- projection rebuild after restart

# 6. Constraints

- Keep one authoritative append-only data shape.
- Prefer derived projections over write-managed summaries.
- Keep implementation scoped to the coding-agent/runtime surfaces needed for memory.
- Do not use an LLM classifier in v1.
- Do not require embeddings for write decisions in v1.
- Verification must include real `mu exec --json` fresh-session checks.
- Validation should be outcome-based; exact tool-call order is not part of the contract.
- For explicit user-requested storage, validate that the memory tool boundary is used.

# 7. Definition of Done

- A global append-only memory store exists under `~/.mu/wiki/`.
- Completed `edit`/`apply_patch`/`write` operations append durable memory entries when appropriate.
- Completed artifact-producing `bash` operations append durable memory entries when appropriate.
- Workspace-specific projections are derived and readable.
- A fresh `mu exec --json` session can retrieve previously stored memory without relying on prior chat history.
- Two distinct workspaces prefer their own projections during retrieval.
- Explicit user-directed memory storage uses the memory tool surface.
- Supersession/update behavior is durable and append-only.
- Targeted tests and `npm run check` pass.

## Verification Contract

### Red checks
- no global append-only memory store exists yet
- no workspace projection retrieval boundary exists yet
- durable artifact tool completions do not yet create memory entries
- explicit user memory storage does not yet use a dedicated memory tool
- fresh-session retrieval through `mu exec --json` does not yet prove persistence

### Green checks
- targeted tests prove append-only store and projection derivation
- targeted tests prove artifact-triggered writes for `edit`/`apply_patch`/`write`
- targeted tests prove artifact-triggered writes for `bash` only when artifacts were produced
- targeted tests prove explicit `memory_store` / `memory_search` / `memory_read` behavior
- real `mu exec --json` checks prove write in one session and retrieve in a fresh session
- workspace A and workspace B prefer their own projections in fresh-session retrieval

### Surface checks
- run real `mu exec --json` flows in temp workspaces
- capture stdout/stderr and assert correct retrieval in a fresh session
- assert explicit memory requests use the memory tool boundary once implemented

# 8. What needs to be done to deliver the spec

- Add the append-only memory store and entry schema.
- Add workspace projection derivation and workspace-first retrieval.
- Add artifact-triggered memory append logic for `edit`, `apply_patch`, `write`, and artifact-producing `bash`.
- Add explicit memory tools for search/read/store.
- Add targeted tests for store/projection/tool behavior.
- Add real `mu exec --json` fresh-session verification in temp workspaces.
- Run repo-wide verification after implementation.
