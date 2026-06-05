# Workflow Extension

Multi-agent orchestration for pi with a **context firewall**: child agents run in isolated subprocesses, and the main session only sees a condensed summary.

Uses shared [`workflow-core`](../workflow-core/) for agent discovery, subprocess spawning, and recursive step execution.

## Installation

From the repository root:

```bash
mkdir -p ~/.pi/agent/extensions/workflow
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/workflow/index.ts" ~/.pi/agent/extensions/workflow/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/workflow/executor.ts" ~/.pi/agent/extensions/workflow/executor.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/workflow/settings.ts" ~/.pi/agent/extensions/workflow/settings.ts
```

Or load directly:

```bash
pi --extension packages/coding-agent/examples/extensions/workflow/index.ts
```

Ship agents from `../subagent/agents/` or define your own under `~/.pi/agent/agents/*.md`.

## Commands

| Command | Description |
|---------|-------------|
| `/workflow <task>` | Prompt main agent to plan and call `run_workflow` |
| `/workflows` | List persisted runs for the current session |

## Settings

Optional keys in `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`:

```json
{
  "workflow": {
    "maxConcurrency": 4,
    "autoMode": false
  }
}
```

- `maxConcurrency` — parallel subprocess limit (default: 4)
- `autoMode` — when `true`, appends workflow hints to substantive user prompts

## AgentStep schema

Recursive discriminated union (`type` field required):

| Type | Fields | Behavior |
|------|--------|----------|
| `single` | `agent`, `task`, `cwd?` | One subprocess |
| `parallel` | `steps[]`, `maxConcurrency?` | Concurrent nested steps |
| `chain` | `steps[]` | Sequential; `{previous}` in single tasks injects prior output |

Example (`examples/auth-audit.json`):

```json
{
  "task": "Audit API authentication",
  "phases": ["Reconnaissance", "Synthesis"],
  "step": {
    "type": "chain",
    "steps": [
      {
        "type": "parallel",
        "steps": [
          { "type": "single", "agent": "scout", "task": "Find route handlers and middleware" },
          { "type": "single", "agent": "scout", "task": "Find auth config and session code" }
        ]
      },
      {
        "type": "single",
        "agent": "planner",
        "task": "Synthesize auth risks from recon:\n\n{previous}"
      }
    ]
  }
}
```

Pass `phases` to `run_workflow` for a confirmation dialog before execution.

## vs `subagent` tool

| | `subagent` | `run_workflow` |
|---|---|---|
| Orchestration | One mode per tool call | Full AgentStep tree in one call |
| Main context | Each step output returned | Summary only; details hold full results |
| Recursion guard | None | Child spawns must not load extensions / `run_workflow` |

## Persistence

Runs are stored under `~/.pi/agent/workflows/<sessionId>/<runId>.json`.

## Tool result shape

- **content** — summary string only (context firewall)
- **details** — full `execution.results`, usage stats, run metadata (expand in UI with Ctrl+O)
