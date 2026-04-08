---
name: mcp-runtime-worker
description: Build generic MCP config, transport, discovery, and invocation behavior inside the coding-agent runtime.
---

# MCP Runtime Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the work procedure.

## When to Use This Skill

Use for features that add or change MCP config schema, transport adapters, connection/session management, tool discovery/mapping, auth resolution, local harnesses, and transport-parity behavior.

## Required Skills

- `design-principles` — invoke when defining config, naming, session, and auth boundaries.
- `core-library-design` — invoke when deciding what belongs in the MCP core versus transport adapters or pilot integrations.
- `cli-design` — invoke when config or command surfaces become user-facing.

## Work Procedure

1. Read `mission.md`, `AGENTS.md`, `.factory/library/architecture.md`, `.factory/library/mcp.md`, and the validation assertions this feature fulfills.
2. Write failing tests first for the behavior being introduced. Include both positive and adversarial cases:
   - invalid config
   - collision or stale inventory
   - failure/recovery or redaction paths
3. If the feature introduces a reusable local MCP harness, make it deterministic and keep it inside the reserved `3200-3299` range.
4. Implement generic MCP behavior only. Keep Figma-specific wording and logic out of the generic runtime layer.
5. Validate with the smallest useful stack first, then broaden:
   - focused MCP unit/integration tests
   - transport-specific tests (`streamable_http` and, when applicable, `stdio`)
   - `npm run check -w @kennyfrc/mu-coding-agent`
6. Update `.factory/library/mcp.md`, `.factory/library/architecture.md`, and `.factory/services.yaml` when new durable commands or harness services become real.
7. In the handoff, name the exact auth precedence, naming rule, and recovery behavior that was proven.

## Example Handoff

```json
{
  "salientSummary": "Added generic MCP config parsing and HTTP discovery/invocation plumbing with deterministic tool qualification and redacted error surfaces. The new local harness tests prove connect/discover/invoke plus malformed-response degradation without leaking auth material.",
  "whatWasImplemented": "Implemented MCP runtime config loading, a shared server-session layer, HTTP discovery/invocation wiring, deterministic remote tool qualification, and redaction-aware failure handling. Added a deterministic local MCP harness and exercised success, malformed-response, and reconnect scenarios through package integration tests.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "npm run test -w @kennyfrc/mu-coding-agent -- test/mcp-config.test.ts test/mcp-http-runtime.test.ts --maxWorkers=4",
        "exitCode": 0,
        "observation": "Focused MCP tests passed for config, discovery, invocation, and malformed-response handling."
      },
      {
        "command": "npm run check -w @kennyfrc/mu-coding-agent",
        "exitCode": 0,
        "observation": "Package check passed with the new MCP runtime code."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Ran a harness-backed CLI flow that exposed a discovered MCP tool and invoked it through the normal tool pipeline.",
        "observed": "Tool call/result appeared through the standard runtime surface; no separate MCP-only path was needed."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "packages/coding-agent/test/mcp-http-runtime.test.ts",
        "cases": [
          {
            "name": "discovers and qualifies remote tools",
            "verifies": "remote inventory becomes callable through the normal runtime"
          },
          {
            "name": "redacts bearer material in connection failures",
            "verifies": "secret-bearing auth values do not leak to surfaced errors"
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- You cannot satisfy a validation assertion without changing mission-level config/auth decisions.
- The transport/session model needs a new cross-feature invariant not yet captured in shared state.
- Real Figma auth or an external dependency is required to proceed and is not available.
