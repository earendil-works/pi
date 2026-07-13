# agent-memory-write-tool Specification

## ADDED Requirements

### Requirement: memory_save tool exposes three write outcomes

The `memory_save` tool SHALL accept a single TypeBox-schema input and produce exactly one of three outcomes: `created`, `updated`, or `skipped`. The outcome is determined by the input and the existing DB state, never by tool internals.

#### Scenario: memory_save creates a new atom when no id is supplied and no fingerprint match exists

- **GIVEN** `~/.pi/agent/memory/memory.db` contains no atom with the same `content_fingerprint` as the input
- **AND** `event.input` does not include `id`
- **WHEN** the agent calls `memory_save({type, title, content, summary, tags, importance})`
- **THEN** tool embeds the embeddable text (`title + summary + tags`) via `embedText` with 15s timeout
- **AND** tool inserts one row into `memory_index` via `MemoryIndex.insertAtom` (with vector from `embedText` or zero-vector fallback)
- **AND** tool writes `${atomsDir}/${type}/${<new uuid>}.md` via `writeAtomToFile`
- **AND** tool calls `reindexOne(<new uuid>)` to refresh the bge-m3 service index
- **AND** tool returns `{action: "created", id: <new uuid>, embedding: "ok" | "skipped"}`

#### Scenario: memory_save returns skipped outcome when fingerprint matches an existing active atom

- **GIVEN** `memory_index` contains an active (`is_latest=1, archived=0`) atom whose `content_fingerprint` equals `sha256(normalizeContent(input.content)).slice(0, 16)` of the input
- **AND** `event.input` does not include `id`
- **WHEN** the agent calls `memory_save({type, title, content, ...})` with content whose fingerprint matches
- **THEN** tool returns `{action: "skipped", reason: "duplicate_content", existing_id: <matched atom id>}`
- **AND** tool does NOT call `insertAtom`, `writeAtomToFile`, or `reindexOne`
- **AND** the matched atom's `version`, `updated_at`, and `access_count` remain unchanged

#### Scenario: memory_save updates an existing atom in-place when id is supplied and atom exists

- **GIVEN** `memory_index` contains an atom with the given `id` (regardless of `is_latest` or `archived` state)
- **WHEN** the agent calls `memory_save({id, type, title, content, summary, tags, importance})`
- **THEN** tool computes `mergedAtom = {...existing, type, title, summary, content, tags, importance, content_fingerprint, updated_at: Date.now()}` (id, version, source_session preserved)
- **AND** tool calls `MemoryIndex.updateAtom(mergedAtom, vector)` which performs in-place UPDATE with SQL `version = version + 1`
- **AND** tool calls `writeAtomToFile(mergedAtom, atomsDir)` overwriting the existing `.md`
- **AND** tool calls `reindexOne(id)` to refresh the bge-m3 service index
- **AND** tool returns `{action: "updated", id, embedding: "ok" | "skipped"}`

#### Scenario: memory_save returns id_not_found error when id is supplied but no such atom exists

- **GIVEN** `memory_index` contains no atom with the given `id`
- **WHEN** the agent calls `memory_save({id, type, ...})`
- **THEN** tool returns `{action: "error", error: "id_not_found", id}`
- **AND** tool does NOT call `insertAtom`, `updateAtom`, `writeAtomToFile`, or `reindexOne`

### Requirement: memory_save validates input via TypeBox schema

The `memory_save` tool SHALL enforce input validation via TypeBox at tool-call dispatch time, before any storage I/O.

#### Scenario: invalid type rejected

- **GIVEN** agent calls `memory_save({type: "opinion", ...})`
- **WHEN** TypeBox validates the input
- **THEN** tool returns `{action: "error", error: "invalid_type", allowed: ["rule", "fact", "process"]}`
- **AND** no storage or file I/O occurs

#### Scenario: content shorter than 10 characters rejected

- **GIVEN** agent calls `memory_save({content: "x", ...})`
- **WHEN** TypeBox validates the input
- **THEN** tool returns `{action: "error", error: "content_too_short"}`

#### Scenario: importance outside [0, 1] rejected

- **GIVEN** agent calls `memory_save({importance: 1.5, ...})` or `importance: -0.1`
- **WHEN** TypeBox validates the input
- **THEN** tool returns `{action: "error", error: "invalid_importance"}`

### Requirement: memory_save gracefully falls back to zero vector when embed service is unavailable

When `embedText` returns `null` (timeout, ECONNREFUSED, non-2xx response, malformed body), `memory_save` SHALL proceed with a zero-filled 1024-dim vector so the row is still inserted into `memory_index` and `memory_vectors`. `reindexOne` SHALL still be called so the bge-m3 service can refresh its internal index from the `.md` body.

#### Scenario: embedText times out, atom still written

- **GIVEN** the embedding service is unreachable (ollama / bge-m3 endpoint times out at 15s)
- **WHEN** the agent calls `memory_save({type, title, content, ...})`
- **THEN** tool uses `vector = new Array(1024).fill(0)` for `insertAtom`
- **AND** tool returns `{action: "created", id, embedding: "skipped"}`
- **AND** `memory_index` has the new row; `memory_vectors` has a row with zero vector

### Requirement: agent save counter increments on every memory_save call

The personal-assistant extension SHALL maintain a module-level `segmentMemorySaveCount` that increments by 1 on every `memory_save` tool execution, regardless of outcome (created / updated / skipped / error). The counter SHALL be exposed via `getSegmentMemorySaveCount()` for the `session_before_compact` hook.

#### Scenario: counter increments on skipped outcome

- **GIVEN** `segmentMemorySaveCount = 0`
- **WHEN** agent calls `memory_save({content: "duplicate of existing atom", ...})` and tool returns `skipped`
- **THEN** `getSegmentMemorySaveCount() === 1` after the call

#### Scenario: counter increments on error outcome

- **GIVEN** `segmentMemorySaveCount = 5`
- **WHEN** agent calls `memory_save({id: "a-ghost", ...})` and tool returns `id_not_found`
- **THEN** `getSegmentMemorySaveCount() === 6` after the call

### Requirement: segment save counter resets at session and compact boundaries

The personal-assistant extension SHALL reset `segmentMemorySaveCount` to 0 on `session_start` and `session_compact` events, so the counter accumulates across all agent turns within a single segment (between compacts) and only resets when a new segment begins. The counter SHALL NOT reset on `before_agent_start` (per-turn).

#### Scenario: counter resets on session_start

- **GIVEN** `segmentMemorySaveCount = 5` (carried over from a prior session in the same process)
- **WHEN** `session_start` event fires
- **THEN** `getSegmentMemorySaveCount() === 0` after the handler returns

#### Scenario: counter resets on session_compact

- **GIVEN** `segmentMemorySaveCount = 3` (from saves within the current segment)
- **AND** `session_before_compact` ran and either skipped (counter >= 1) or completed extraction
- **WHEN** `session_compact` event fires
- **THEN** `getSegmentMemorySaveCount() === 0` after the handler returns (next segment starts fresh)

#### Scenario: counter survives between turns within a segment

- **GIVEN** turn 1, 2, 3 each have `memory_save` calls (3 total)
- **AND** turns 4 through 10 have no `memory_save` calls
- **AND** turn 11 triggers `session_before_compact`
- **THEN** `getSegmentMemorySaveCount() === 3` at the moment of `session_before_compact` (counter is per-segment, not per-turn)
- **AND** safety net skips extraction (counter >= 1)
- **AND** the next `session_compact` event resets the counter to 0 for the next segment

### Requirement: tool_call hook blocks direct file writes to memory atoms

The personal-assistant `tool_call` hook SHALL block agent invocations of `write`, `edit`, or `bash` whose resolved path falls under `~/.pi/agent/memory/atoms/**` and represents a write operation. Read operations (`read` tool, bash commands without `>` / `>>` / `tee`) SHALL NOT be blocked.

#### Scenario: write tool to atoms/process/foo.md is blocked

- **GIVEN** `~/.pi/agent/memory/atoms/` exists
- **WHEN** agent calls `write({path: "~/.pi/agent/memory/atoms/process/foo.md", content: "..."})`
- **THEN** `tool_call` hook returns `{block: true, reason: "memory atoms must be written via the memory_save tool, not direct file write/edit..."}`
- **AND** `write` tool is not executed
- **AND** no `.md` file is created or modified

#### Scenario: edit tool to existing atom file is blocked

- **GIVEN** `~/.pi/agent/memory/atoms/fact/a-123.md` exists
- **WHEN** agent calls `edit({path: "~/.pi/agent/memory/atoms/fact/a-123.md", oldText: "...", newText: "..."})`
- **THEN** `tool_call` hook returns `{block: true, reason: ...}`
- **AND** `edit` tool is not executed

#### Scenario: bash redirect to atoms/ path is blocked

- **GIVEN** agent calls `bash({command: "cat > ~/.pi/agent/memory/atoms/process/foo.md <<EOF\n...\nEOF"})`
- **WHEN** `tool_call` hook parses the command
- **THEN** hook detects the `>` redirect + path under `atoms/**`
- **AND** returns `{block: true, reason: ...}`

#### Scenario: bash tee to atoms/ path is blocked

- **GIVEN** agent calls `bash({command: "echo 'x' | tee ~/.pi/agent/memory/atoms/fact/bar.md"})`
- **WHEN** `tool_call` hook parses the command
- **THEN** hook detects `tee` + path under `atoms/**`
- **AND** returns `{block: true, reason: ...}`

#### Scenario: read of atom file is NOT blocked

- **GIVEN** `~/.pi/agent/memory/atoms/fact/a-123.md` exists
- **WHEN** agent calls `read({path: "~/.pi/agent/memory/atoms/fact/a-123.md"})`
- **THEN** `tool_call` hook returns `undefined` (no block)
- **AND** `read` tool executes normally

#### Scenario: bash read of atom file is NOT blocked

- **GIVEN** `~/.pi/agent/memory/atoms/fact/a-123.md` exists
- **WHEN** agent calls `bash({command: "cat ~/.pi/agent/memory/atoms/fact/a-123.md"})`
- **THEN** `tool_call` hook returns `undefined` (no block; command has no `>` / `>>` / `tee`)

#### Scenario: writeAtomToFile is self-consistent (not blocked by hook)

- **GIVEN** `memory_save` tool internally calls `writeAtomToFile(atom, atomsDir)` → `fs.writeFile(...)`
- **WHEN** the internal Node `fs.writeFile` runs
- **THEN** `tool_call` hook is NOT triggered (fs.writeFile bypasses tool_call event path)
- **AND** the `.md` file is created/overwritten normally

### Requirement: session_before_compact is a graceful safety net

The `session_before_compact` hook SHALL skip extraction when the agent has made at least one `memory_save` call in the current segment. When extraction does run (segment counter == 0), extraction failures SHALL NOT cancel compact — the hook SHALL return `undefined` and surface a `warn`-level notify.

#### Scenario: safety net skipped when agent saved at least once

- **GIVEN** `segmentMemorySaveCount >= 1` from a prior turn's `memory_save` call
- **WHEN** `session_before_compact` event fires
- **THEN** hook returns `undefined` immediately, before any extraction work
- **AND** `runCompactExtraction` is NOT invoked
- **AND** compact proceeds

#### Scenario: safety net runs when agent never saved

- **GIVEN** `segmentMemorySaveCount === 0`
- **WHEN** `session_before_compact` event fires
- **THEN** hook invokes `runCompactExtraction`
- **AND** on success, returns `undefined` and compact proceeds

#### Scenario: safety net graceful on extraction failure

- **GIVEN** `segmentMemorySaveCount === 0`
- **AND** `runCompactExtraction` throws (e.g. extraction model not configured, auth failed, LLM call errored)
- **WHEN** `session_before_compact` event fires
- **THEN** hook catches the error
- **AND** `ctx.ui.notify("memory: safety net skipped — <reason>", "warn")` is invoked
- **AND** hook returns `undefined` (compact proceeds; NOT `{cancel: true}`)

### Requirement: before_agent_start system prompt informs agent about memory_save

The personal-assistant `before_agent_start` hook SHALL append a `## Memory` section to the system prompt explaining the `memory_save` tool, when to use it, and rules around fingerprint-skip and overwrite-by-id semantics.

#### Scenario: system prompt contains the Memory section

- **GIVEN** the `before_agent_start` event fires
- **WHEN** the handler returns the augmented system prompt
- **THEN** the returned system prompt includes the substring `## Memory`
- **AND** it mentions `memory_save` by name
- **AND** it states the fingerprint-skip outcome behavior
- **AND** it states the overwrite-by-id pattern (`id` field for updates)
- **AND** it states the importance 0-1 honesty rule