# Worklog: dual-queue semantics for /queue steer toggle

Created pin: `devdocs/pins/20260206-1019-steer-queue-dual.md`.

Next work is design + implementation:
- Introduce separate queue(s) for `steer` (queued-next) vs normal (queued-by-end)
- Preserve ordering semantics when both exist
- Update TUI pending message microcopy to show `Queued next:` for steered entries.

2026-02-06
- Chosen design: single queue with per-item `kind: by-end | next` set at enqueue-time.
- Drain only `next` items in the `interrupt()` hook; drain any remaining items after `agent_end` as today.
- Planned extra: when switching away from `steer`, normalize queued `next` -> `by-end` (interrupt disabled).

Slice 1 (mu-agent-core)
- Updated `packages/agent/src/agent.ts`:
  - queued messages now carry `kind: "by-end" | "next"` (set at enqueue time)
  - `interrupt()` drains only `kind:"next"`
  - switching queue mode away from `steer` normalizes queued `next` -> `by-end`
- Added tests: `packages/agent/test/queue-steer-dual.test.ts`
- Verified: `npm test -w @kennyfrc/mu-agent-core` (PASS)

Slice 2 (mu-coding-agent)
- Updated `packages/coding-agent/src/tui/tui-renderer.ts`:
  - queued message entries now track `kind: by-end | next`
  - pending queue microcopy shows `↳ Queued next:` for `kind:"next"`
  - switching queue mode away from `steer` normalizes local queued `next` -> `by-end` (mirrors agent)
- Verified: `npm test -w @kennyfrc/mu-coding-agent` (PASS)
- Verified: root `npm run check` (PASS)
