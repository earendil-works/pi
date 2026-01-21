# Pin: Manager/Subagent Implementation

## Goal
Make the main pi-coding-agent act as a manager that can spawn subagent “Ralph loop” runs, coordinate shared pin/todos via a versioned task JSON file, and only enable subagents when opt-in via CLI.

## Constraints
- Shared state lives in a task JSON file; subagent completion requires explicit `status: "done"`.
- Use TypeBox schemas compatible with TypeCompiler (no StringEnum).
- Run `npm run check` at repo root after code changes.

## Current State
- Task file schema + helpers implemented (`subagent/types.ts`, `subagent/task-file.ts`) with vitest coverage.
- Subagent loop (`subagent/loop.ts`) emits progress events (loop/task status/todo selection) and exits immediately when task status becomes done.
- Subagent mode writes progress events to stdout via `runSubagentMode` so the Task tool streams them to the TUI.
- Tool execution UI now renders streaming output for non-Bash tools (including Task), so subagent progress is visible while running.
- Task tool input schemas accept strings for todo status/priority and parse them with clear validation errors.
- Task tool returns a warning if the subagent exits nonzero after completing the task (status done).
- Task tool is enabled by default (no `--enable-subagent` needed) and help text updated.
- Subagent spawn handles ts entrypoints (argv1 ends with .ts/.tsx -> command=tsx) with unit test coverage.
- `npm run check` completed successfully.

## Next Step
Retry the hello-world Task tool flow via `npm run start -w @kennyfrc/pi-coding-agent` to see streaming progress updates and clean termination messaging.
