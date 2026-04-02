---
mode: build
---

# 1. Summary & Recommendation

Add a dedicated `mu exec` subcommand and make it the canonical non-interactive machine interface.

`mu exec --json` must emit a stable JSONL event stream on `stdout`, one JSON object per line, with a public schema modeled after Codex-style exec events. Mu must not expose raw internal runtime event names like `turn_start` or `tool_execution_start` in the public machine contract.

# 2. What Must be True

- `mu exec <prompt>` exists and is the canonical headless execution path.
- `mu exec --json <prompt>` emits valid JSONL only on `stdout`.
- The first event of a new run is `thread.started`.
- Each prompt execution emits exactly one `turn.started`.
- Each turn ends with exactly one terminal turn event: `turn.completed` or `turn.failed`.
- Assistant output is represented as an `agent_message` item.
- Command execution is represented as a `command_execution` item.
- File modifications are represented as a `file_change` item.
- Todo or plan state is represented as a `todo_list` item.
- Unknown or non-command tools still surface through a stable public item shape rather than raw internal events.
- Fatal failures are visible through the public exec error contract and non-zero exit status.
- The schema is stable and additive.

# 3. What Must Never Happen

- Human-readable noise must never appear on `stdout` in `mu exec --json`.
- Raw internal event names must never appear in the public exec JSON contract.
- A turn must never end without a terminal turn event.
- A turn must never emit more than one terminal turn event.
- JSON lines must never be malformed.
- File-changing operations must never be omitted from the public event stream.
- Command execution terminal state must never be hidden when the command actually ran.

# 4. Inputs / Outputs

## Input

- `mu exec <prompt>`
- `mu exec --json <prompt>`
- future-compatible inputs may include session, resume, attachment, provider, and model controls

## Success Output

### `mu exec`
- final assistant text on `stdout`
- diagnostics on `stderr`
- exit code `0`

### `mu exec --json`
- JSONL on `stdout`
- diagnostics on `stderr`
- exit code `0`

## Failure Output

- non-zero exit code
- terminal failure event in the JSON stream if streaming has started
- clear error text on `stderr`

## Required Public Event Types

- `thread.started`
- `turn.started`
- `item.started`
- `item.updated`
- `item.completed`
- `turn.completed`
- `turn.failed`
- `error`

## Required Public Item Types

- `agent_message`
- `reasoning`
- `command_execution`
- `file_change`
- `todo_list`
- `tool_call` or equivalent stable fallback for other tools

# 5. Edge Cases

- no model configured
- missing API key
- prompt produces no assistant text
- tool-only turn
- streaming command output with multiple progress chunks
- multi-file apply-patch or edit result
- repeated todo updates in one turn
- fatal runtime exception before turn start
- abort or interruption after turn start
- future unknown item kinds

# 6. Constraints

- Keep the change scoped to the coding-agent CLI and its direct runtime/output adapters.
- Do not add any `any` types unless absolutely necessary.
- Stable machine contract takes precedence over preserving legacy non-interactive flags.
- Verification must include automated assertions and a real CLI surface check.
- The public exec contract must be line-oriented and easy to parse with shell tooling.
- Prefer explicit data shapes and additive evolution.

# 7. Definition of Done

- `mu exec --help` documents the new subcommand and `--json` flag.
- `mu exec "hi"` works as the canonical non-interactive path.
- `mu exec --json "hi"` emits valid JSONL only on `stdout`.
- Public JSON events use normalized dotted names rather than raw internal runtime event names.
- Event ordering is stable and verifiable.
- Exhaustive major item coverage exists for assistant messages, command execution, file changes, todo lists, and generic tool calls.
- Failure semantics are verifiable through terminal events and exit codes.
- Targeted tests and repo-wide `npm run check` are green.

## Verification Contract

### Red checks
- `mu exec` does not yet exist.
- current non-interactive JSON output exposes raw internal event names.
- current machine-readable path does not provide a stable public exec schema.

### Green checks
- `mu exec --json` emits only valid JSONL on `stdout`.
- every line parses as JSON and conforms to the public event schema.
- every turn has one start and one terminal event.
- command execution, file changes, and todo updates are all represented by public item events.
- fatal failures produce terminal failure semantics and non-zero exit status.

### Surface checks
- run the real CLI in a temp workspace and capture `stdout`/`stderr`
- assert `stdout` contains only JSONL in `--json` mode
- assert help text exposes the new command surface

# 8. What needs to be done to deliver the spec

- Add a dedicated `mu exec` CLI entrypoint.
- Define a public exec event schema in a dedicated module.
- Add an adapter that maps Mu runtime events into the public exec schema.
- Add output writing that enforces `stdout`/`stderr` discipline.
- Add targeted tests for schema shape, lifecycle ordering, item mapping, and failure behavior.
- Add a real CLI verification path that spawns the built CLI and inspects `stdout`, `stderr`, and exit status.
- Run repo-wide verification after implementation.
