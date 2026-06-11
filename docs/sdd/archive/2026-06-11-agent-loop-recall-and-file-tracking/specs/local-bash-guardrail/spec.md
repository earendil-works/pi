# local-bash-guardrail Specification

## ADDED Requirements

### Requirement: Bash intent guardrail shared between local bash and satellite

The `extensions/personal-assistant/tools.ts` SHALL detect bash
commands that should have used a structured read/write/edit/list/find/grep
tool and emit a guidance message (block: true, reason: "Prefer X over
bash Y") to nudge the LLM toward structured tools. The same detection
logic SHALL be applied to both:

1. Local `bash` tool calls (`event.toolName === "bash"`)
2. Satellite `satellite_remote_exec` calls where `event.input.tool === "bash"`

The two scopes SHALL use independent per-turn budgets keyed by
`${turnId}:${prefix}:${intent}` where `prefix` is `"local"` or
`"satellite"`. First two occurrences of the same intent on the same
side emit guidance; the third occurrence emits a hard block.

#### Scenario: Local bash cat → suggest read
- **GIVEN** LLM calls local `bash({ command: "cat /etc/hostname" })`
- **WHEN** the `tool_call` event fires
- **THEN** the hook returns `{ block: true, reason: "Prefer read over bash cat. Use { tool:\"read\", path:'/etc/hostname' } for offset/limit/truncation." }`

#### Scenario: Local bash ls → suggest list
- **GIVEN** LLM calls local `bash({ command: "ls -la /tmp" })`
- **WHEN** the `tool_call` event fires
- **THEN** the hook returns `{ block: true, reason: "Prefer list over bash ls. Use { tool:\"list\", path:'/tmp' } for structured output." }`

#### Scenario: Local bash find → suggest find
- **GIVEN** LLM calls local `bash({ command: "find /tmp -name '*.txt'" })`
- **WHEN** the `tool_call` event fires
- **THEN** the hook returns `{ block: true, reason: "Prefer find over bash find. Use { tool:\"find\", pattern:'<glob>', path:'/tmp' }." }`

#### Scenario: Local bash grep → suggest grep
- **GIVEN** LLM calls local `bash({ command: "grep -r foo /tmp" })`
- **WHEN** the `tool_call` event fires
- **THEN** the hook returns `{ block: true, reason: "Prefer grep over bash grep. Use { tool:\"grep\", pattern:'<regex>', path:'/tmp' }." }`

#### Scenario: Local bash sed -i → suggest edit
- **GIVEN** LLM calls local `bash({ command: "sed -i 's/foo/bar/' file.txt" })`
- **WHEN** the `tool_call` event fires
- **THEN** the hook returns `{ block: true, reason: "Prefer edit over bash sed -i. Use { tool:\"edit\", path:'file.txt', edits:[{oldText,newText}] }." }`

#### Scenario: Local bash echo> → suggest write
- **GIVEN** LLM calls local `bash({ command: "echo 'x' > file.txt" })`
- **WHEN** the `tool_call` event fires
- **THEN** the hook returns `{ block: true, reason: "Prefer write over bash echo/printf. Use { tool:\"write\", path:'file.txt', content:'...' } for atomic writes." }`

#### Scenario: Local bash unrelated command passes
- **GIVEN** LLM calls local `bash({ command: "ps aux | head" })` (not cat/ls/find/grep/sed/echo>)
- **WHEN** the `tool_call` event fires
- **THEN** the hook returns undefined (no block)

#### Scenario: Local bash with pipelines not intercepted
- **GIVEN** LLM calls local `bash({ command: "cat /etc/hostname | tr a-z A-Z" })` (contains pipe)
- **WHEN** the `tool_call` event fires
- **THEN** the hook returns undefined (pipelines are not safe matches)

#### Scenario: Local and satellite budgets are independent
- **GIVEN** the same turn uses local `bash: cat /a`, then satellite `remote_exec: bash: cat /a`
- **WHEN** both `tool_call` events fire
- **THEN** both get guidance messages (each side's budget is independent, neither side is at 3 yet)

#### Scenario: Third local bash cat is hard-blocked
- **GIVEN** the same turn calls local `bash: cat /a` twice (each guidance)
- **WHEN** the same turn calls local `bash: cat /a` a third time
- **THEN** the hook returns `{ block: true, reason: "Blocked: you have tried bash with similar intent 3 times. Use tool=read instead." }`

#### Scenario: Existing satellite-guards tests still pass
- **GIVEN** the existing `test/satellite-guards.test.ts` covers satellite `remote_exec: bash: cat/ls/find/grep/sed -i/echo>`
- **WHEN** the test suite runs after this change
- **THEN** all existing satellite-guards tests pass
- **AND** the test assertions use the new short names (`read` / `list` / `find` / `grep`)
