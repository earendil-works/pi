---
name: core-runtime-worker
description: Stabilize and extend the coding-agent core runtime without breaking existing extension behavior.
---

# Core Runtime Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the work procedure.

## When to Use This Skill

Use for features that change extension lifecycle, registries, session/runtime cleanup, hook composition, slash-command routing, or other host-runtime seams that MCP will rely on.

## Required Skills

- `design-principles` — invoke when shaping runtime boundaries or lifecycle contracts so the smallest stable core stays explicit.
- `cli-design` — invoke when touching slash-command behavior, help text, or machine-readable CLI surfaces.

## Work Procedure

1. Read the feature, `mission.md`, `AGENTS.md`, `.factory/library/architecture.md`, and any affected runtime tests before editing.
2. Write or extend failing tests first for the runtime contract being changed. Favor focused `vitest` coverage near the touched subsystem.
3. Implement the smallest runtime change that makes the new tests pass while preserving existing selection, hook, and cleanup semantics.
4. Verify reload/unload behavior explicitly when changing lifecycle code; do not assume static tests cover stale registrations.
5. Run focused validation first, then broader package validation:
   - targeted `vitest` files for the touched area
   - `npm run check -w @kennyfrc/mu-coding-agent`
6. If the feature changes runtime facts or boundaries, update `.factory/library/architecture.md`, `.factory/library/mcp.md`, or `.factory/library/user-testing.md` before finishing.
7. In the handoff, be explicit about lifecycle guarantees proven, not just files changed.

## Example Handoff

```json
{
  "salientSummary": "Stabilized extension unload/reload for MCP-oriented core work by adding explicit cleanup coverage for stale hooks and indicators. Updated slash-command routing tests to prove built-in command precedence still wins after extension reload.",
  "whatWasImplemented": "Added targeted runtime tests for extension unload cleanup, indicator removal, and built-in slash-command precedence. Adjusted the extension manager and TUI routing so unloaded extensions no longer leave hook effects or stale footer indicators behind, while preserving current registry priority rules and reload semantics.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "npm run test -w @kennyfrc/mu-coding-agent -- src/extensions/manager.test.ts src/extensions/runner.test.ts src/extensions/command-registry.test.ts --maxWorkers=4",
        "exitCode": 0,
        "observation": "Focused runtime tests passed and covered unload/reload behavior."
      },
      {
        "command": "npm run check -w @kennyfrc/mu-coding-agent",
        "exitCode": 0,
        "observation": "Package check passed after the runtime changes."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Verified slash-command precedence through the TUI path after reload in a test harness.",
        "observed": "Built-in command routing won over a colliding extension command; non-colliding extension commands remained available."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "packages/coding-agent/src/extensions/manager.test.ts",
        "cases": [
          {
            "name": "removes stale indicators on extension unload",
            "verifies": "old extension UI state disappears after reload/unload"
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The requested behavior needs a new lifecycle or config contract that changes multiple mission artifacts.
- A runtime change would require violating the mission boundary to start a long-lived service outside `3200-3299`.
- Existing tests reveal unrelated baseline failures that block proving the touched runtime contract.
