# local-bash-guardrail Specification

## MODIFIED Requirements

### Requirement: Bash intent guardrail shared between local bash and satellite

The `extensions/personal-assistant/tools.ts` SHALL detect bash commands that should have used a structured read/write/edit tool and emit a guidance message (`block: true, reason: "...")` to nudge the LLM toward structured tools. The detection logic SHALL apply ONLY to:

1. Satellite `satellite_remote_exec` calls where `event.input.tool === "bash"`

Local `bash` tool calls (`event.toolName === "bash"`) are NO LONGER guarded — local pi's default active tools do not include `ls`/`grep`/`find` and the system prompt explicitly recommends `bash` for file operations, so guarding local bash would redirect the LLM to non-existent tools.

The per-turn budget key SHALL be `${turnId}:satellite:${intent}`. The previous `${turnId}:local:${intent}` budget is removed entirely. First two occurrences of the same intent in the satellite scope emit guidance; the third occurrence emits a hard block.

#### Scenario: Satellite bash cat → suggest read
- **GIVEN** LLM calls `satellite_remote_exec` with `tool: "bash", command: "cat /etc/hostname"`
- **WHEN** the `tool_call` event fires
- **THEN** the hook returns `{ block: true, reason: "Prefer read over bash cat. Use { tool:\"read\", path:'/etc/hostname' } for offset/limit/truncation." }`

#### Scenario: Satellite bash sed -i → suggest edit
- **GIVEN** LLM calls `satellite_remote_exec` with `tool: "bash", command: "sed -i 's/foo/bar/' /etc/hosts"`
- **WHEN** the `tool_call` event fires
- **THEN** the hook returns `{ block: true, reason: "Prefer edit over bash sed -i. Use { tool:\"edit\", path:'/etc/hosts', edits:[{oldText,newText}] }" }`

#### Scenario: Satellite bash echo> → suggest write
- **GIVEN** LLM calls `satellite_remote_exec` with `tool: "bash", command: "echo 'x' > /tmp/file.txt"`
- **WHEN** the `tool_call` event fires
- **THEN** the hook returns `{ block: true, reason: "Prefer write over bash echo/printf. Use { tool:\"write\", path:'/tmp/file.txt', content:'...' } for atomic writes." }`

#### Scenario: Satellite bash unrelated command passes
- **GIVEN** LLM calls `satellite_remote_exec` with `tool: "bash", command: "module load python/3.10"`
- **WHEN** the `tool_call` event fires
- **THEN** the hook returns undefined (no block)

#### Scenario: Satellite bash with pipelines not intercepted
- **GIVEN** LLM calls `satellite_remote_exec` with `tool: "bash", command: "cat /etc/hostname | tr a-z A-Z"`
- **WHEN** the `tool_call` event fires
- **THEN** the hook returns undefined (pipelines are not safe matches)

#### Scenario: 3rd violation in same turn hard-blocks
- **GIVEN** Same turn already had 2 satellite bash `cat` calls blocked
- **WHEN** LLM calls `satellite_remote_exec` with `tool: "bash", command: "cat /etc/hostname"` a 3rd time
- **THEN** the hook returns `{ block: true, reason: "Blocked: you have tried bash with similar intent 3 times. Use tool=read instead." }`

## REMOVED Requirements

### Requirement: Local bash cat → suggest read
- **Reason**: Local pi's default active tool set is `[read, bash, edit, write]` and does not include `ls`/`grep`/`find`. The system prompt explicitly recommends using `bash` for `ls`/`find` operations. Guarding local `bash cat` would redirect the LLM to a `read` tool that IS available — but the same redirect applies to all local bash usage, including `ls`/`find`/`grep` which lack available targets. Removing the entire local layer is consistent.
- **Migration**: No migration needed. Local `bash cat` now passes through to the underlying bash tool. The model can still use `read` for structured output (truncation, offset/limit), but is no longer forced.

### Requirement: Local bash ls → suggest list
- **Reason**: Local pi does not have a `list` tool — the equivalent is `ls` (factory exists but not in default active set). Guarding local `bash ls` and suggesting `tool="list"` was redirecting to a non-existent tool. The system prompt recommends `bash` for `ls` operations.
- **Migration**: No migration needed. Local `bash ls` now passes through to the underlying bash tool.

### Requirement: Local bash find → suggest find
- **Reason**: Local pi has a `find` tool factory but it is not in the default active set. The suggestion `tool="find"` would fail at runtime. Additionally, `bash find` works as-is and the model can use it directly.
- **Migration**: No migration needed. Local `bash find` now passes through to the underlying bash tool. If structured `find` is needed, opt in via `--tools read,grep,find,ls`.

### Requirement: Local bash grep → suggest grep
- **Reason**: Local pi has a `grep` tool factory but it is not in the default active set. The suggestion `tool="grep"` would fail at runtime. `bash grep` works as-is.
- **Migration**: No migration needed. Local `bash grep` now passes through to the underlying bash tool. If structured `grep` is needed, opt in via `--tools read,grep,find,ls`.

### Requirement: Local bash sed -i → suggest edit
- **Reason**: Removed as part of the local layer deletion. The satellite counterpart is preserved.
- **Migration**: No migration needed. Local `bash sed -i` now passes through to the underlying bash tool.

### Requirement: Local bash echo> → suggest write
- **Reason**: Removed as part of the local layer deletion. The satellite counterpart is preserved.
- **Migration**: No migration needed. Local `bash echo>` now passes through to the underlying bash tool.

### Requirement: Local bash unrelated command passes
- **Reason**: Removed as part of the local layer deletion. Without the local layer, ALL local bash commands pass through, not just unrelated ones. The scenario is replaced by "all local bash passes through".
- **Migration**: No migration needed. The new behavior is a superset (all commands pass, not just unrelated ones).

### Requirement: Local bash with pipelines not intercepted
- **Reason**: Removed as part of the local layer deletion. Pipeline handling is now irrelevant since the local layer is gone.
- **Migration**: No migration needed.

### Requirement: Local and satellite budgets are independent
- **Reason**: Removed because the local budget is gone. Only the satellite budget remains.
- **Migration**: No migration needed. The satellite budget operates independently per turn, and is no longer paired with a local counterpart.
