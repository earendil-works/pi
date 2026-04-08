---
name: figma-integration-worker
description: Deliver the Figma MCP pilot, including slash-command UX, status surfaces, and real-endpoint validation.
---

# Figma Integration Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the work procedure.

## When to Use This Skill

Use for features that connect the generic MCP runtime to Figma-specific config, auth UX, slash commands, connection indicators, and real Figma validation flows.

## Required Skills

- `cli-design` — invoke when adding or refining slash commands, help text, or operator-facing status output.
- `design-principles` — invoke when deciding which behavior is Figma-specific versus generic MCP runtime behavior.
- `xtui` — invoke for manual verification of slash-command UX and visible status transitions.

## Work Procedure

1. Read `mission.md`, `AGENTS.md`, `.factory/library/architecture.md`, `.factory/library/mcp.md`, and `.factory/library/user-testing.md`.
2. Write failing tests first for the Figma-facing contract:
   - slash command discovery/execution
   - status indicator transitions
   - auth failure and recovery messaging
   - surfaced tool availability
3. Implement the smallest Figma-specific layer on top of the generic MCP runtime. Do not move Figma-specific behavior back into the generic MCP core.
4. Verify local deterministic behavior first with tests or harnesses, then run the required real Figma validation path if credentials are available.
5. Use `xtui` for TUI-level checks whenever the feature changes slash-command or visible status behavior.
6. Run package validation after focused tests:
   - targeted Figma/runtime tests
   - `npm run check -w @kennyfrc/mu-coding-agent`
7. In the handoff, report the real Figma validation outcome separately from local harness validation.

## Example Handoff

```json
{
  "salientSummary": "Added the Figma MCP pilot layer with slash commands, footer status transitions, and bearer-auth-backed real-endpoint validation. Local harness tests cover the same UI contract, while the real Figma pass confirmed one meaningful Figma read action through the normal tool pipeline.",
  "whatWasImplemented": "Implemented the Figma pilot integration on top of the generic MCP runtime, including slash commands for status/reconnect flows, footer indicators for connection state, and Figma-specific runtime wiring that surfaces discovered tools without modifying the generic transport layer. Added tests for slash overlay discovery, status transitions, and auth recovery messaging.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "npm run test -w @kennyfrc/mu-coding-agent -- test/figma-pilot.test.ts test/figma-slash-ui.test.ts --maxWorkers=4",
        "exitCode": 0,
        "observation": "Focused Figma pilot tests passed for slash UX, status transitions, and surfaced tool availability."
      },
      {
        "command": "npm run check -w @kennyfrc/mu-coding-agent",
        "exitCode": 0,
        "observation": "Package check passed with the Figma pilot changes."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Used the TUI slash overlay to discover and execute the Figma status command, then observed state transitions from disconnected to connected.",
        "observed": "Slash command executed through the extension path, footer indicator updated correctly, and surfaced Figma tools became callable."
      },
      {
        "action": "Ran a real Figma validation command with configured credentials.",
        "observed": "Received concrete Figma-specific data through the normal tool pipeline."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "packages/coding-agent/test/figma-slash-ui.test.ts",
        "cases": [
          {
            "name": "figma commands appear in slash overlay without mutating state while browsing",
            "verifies": "slash-command discovery is safe and discoverable"
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- Real Figma validation is required for the feature but the credentials or endpoint access are unavailable.
- The requested UX requires new mission-level behavior not yet captured in the validation contract.
- Figma-specific work reveals a generic MCP runtime gap that belongs in an earlier feature or milestone.
