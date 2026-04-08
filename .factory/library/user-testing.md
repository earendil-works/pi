# User Testing

Testing surfaces and validation guidance for the MCP mission.

**What belongs here:** validation surfaces, tools to use, setup expectations, concurrency limits, gotchas.
**What does not belong here:** implementation tasks or feature decomposition.

---

## Validation Surface

### Surface: package-level command validation
- Primary tool: `Execute`
- Purpose: run focused `vitest` coverage, config parsing, harness-backed integration tests, and package/root checks.
- Typical evidence: command output, exit codes, bound ports, surfaced errors, transcript snippets from CLI modes.

### Surface: TUI slash/status validation
- Primary tool: `xtui`
- Purpose: verify slash command discovery/execution, footer indicator state, reload behavior, and visible readiness/degraded states.
- Typical evidence: interaction log, snapshots, transcript output, footer/status changes.

### Surface: local MCP harness validation
- Primary tool: `Execute`
- Purpose: deterministic connect/discover/invoke/reload/recovery checks on `3200-3299`.
- Typical evidence: harness startup output, request logs, active tool surface output, failure/recovery logs.

### Surface: real Figma validation
- Primary tool: `Execute`
- Purpose: validate real Figma MCP connectivity and at least one meaningful Figma operation through the normal runtime.
- Typical evidence: real-endpoint invocation output, Figma-specific result data, selected auth mode, redacted errors if failure occurs.

## Validation Concurrency

Machine profile observed during planning:
- CPU cores: `10`
- Total memory: `34 GB`
- Available memory during planning: about `12 GB`
- 70% usable headroom target: about `8.4 GB`

### Command validation
- Max concurrent validators: `3`
- Rationale: package checks/tests measured roughly 185-486 MB RSS per process during dry run, but Vitest plus harness processes can stack unpredictably. Three concurrent command validators stay conservative while leaving headroom.

### XTUI validation
- Max concurrent validators: `3`
- Rationale: TUI interactions are lighter than full test suites, but each validator may still start a separate CLI runtime and hold interactive state.

### Local MCP harness validation
- Max concurrent validators: `2`
- Rationale: each validator may own a harness plus a CLI runtime and recovery path. Keeping this at two reduces port/state collisions and keeps logs readable.

### Real Figma validation
- Max concurrent validators: `1`
- Rationale: real credentials, remote rate limits, and session/auth state make this the least parallel-friendly surface. Run sequentially.

## Guidance

- Prefer focused package tests during iteration and reserve root `npm run check` for milestone or completion gates.
- When validating reload or recovery, collect before/after evidence. Do not treat a single final healthy state as sufficient proof.
- Real Figma validation is not complete unless the output contains concrete Figma-specific data through the normal tool path.
