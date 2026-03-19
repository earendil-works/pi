# Mission Architecture: `mission-reset-control-event`

## Summary

Add a new slash command, `/mission-reset <mission-path>`, that appends an explicit control event to an optimize mission's `EXPERIMENTS.jsonl` so a previously converged or blocked mission can be resumed without pretending a real experiment occurred.

Agreed durable event shape:

```json
{
  "type": "control",
  "kind": "resume-reset",
  "timestamp": 1760000000000,
  "note": "Manual resume reset"
}
```

## Boundaries

### `packages/coding-agent/src/missions/*`
- Own mission-history reading and appending.
- Parse mixed mission history events from `EXPERIMENTS.jsonl`.
- Derive convergence and blocked-stop behavior from the append-only event stream.

### `packages/coding-agent/src/tui/tui-renderer.ts`
- Own slash-command registration.
- Own parsing `/mission-reset <mission-path>`.
- Own user-facing success and failure messaging.

### Test surface
- Mission runner tests should verify barrier semantics from real history files.
- TUI/command tests should verify the built-in slash command path.
- XTUI verification should exercise the real interactive CLI path.

## Abstractions

Prefer one primary abstraction:

- `mission history event stream`

Derived operations should stay small and explicit, for example:

- read mission history events
- append control event
- derive convergence view from real experiment outcomes and control barriers
- derive whether resume is currently blocked

Do not introduce a sidecar reset-state file.

## Tradeoffs

### Chosen design: explicit control event
- Preserves the meaning of real experiment statuses like `keep`.
- Keeps history append-only.
- Makes operator intent grep-friendly and legible.
- Requires small parser/runner changes.

### Rejected design: synthetic `keep`
- Mechanically simple.
- But corrupts mission history semantics.
- Risks future reporting and logic treating an administrative reset as a successful experiment.

## What Matters Most

1. Preserve truth in mission history.
2. Keep `EXPERIMENTS.jsonl` append-only.
3. Make resume behavior explicit and durable.
4. Verify via both code-level tests and XTUI end-to-end interaction.
5. Keep implementation narrow and local.

## Approved Design Decisions

- Slash command name: `/mission-reset`
- Event format: `type: "control"`, `kind: "resume-reset"`
- Testing: both code-level tests and XTUI verification
- Fixture strategy: both a real mission fixture under `devdocs/missions/...` and synthetic test fixtures under tests
- Command behavior: explicit mission path required

## Out of Scope

- Auto-targeting the current mission without a path
- Auto-running the mission after reset
- Changing build-mode mission behavior
- Reworking the entire mission event schema beyond the new control event
