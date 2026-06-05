# workflow-core

Shared library for multi-agent workflow orchestration. Extracted from the subagent extension for reuse by the workflow extension and refactored subagent.

## Purpose

- Discover agents from user/project directories
- Spawn isolated `pi` subprocesses per agent invocation
- Execute recursive workflows: single, parallel, and chain steps (nestable)
- Summarize results for the main LLM (context firewall: no raw message history)

## Structure

```
workflow-core/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts           # Public exports
    ├── types.ts           # AgentStep schema, AgentResult, AgentProgress
    ├── discover-agents.ts # Agent discovery from ~/.pi/agent/agents and .pi/agents
    ├── spawn-subprocess.ts# runSingleAgent, getPiInvocation
    ├── invoke-agent.ts    # Recursive invokeAgent
    └── summarize.ts       # summarizeWorkflowResults
```

## AgentStep schema

Recursive discriminated union:

| Type | Fields | Behavior |
|------|--------|----------|
| `single` | `agent`, `task`, `cwd?` | One subprocess |
| `parallel` | `steps[]`, `maxConcurrency?` | Concurrent nested steps (max 8 tasks, 4 concurrent by default) |
| `chain` | `steps[]` | Sequential; `{previous}` in single-step tasks is replaced with prior output |

Example nested workflow:

```json
{
  "type": "chain",
  "steps": [
    { "type": "single", "agent": "scout", "task": "Find auth code" },
    {
      "type": "parallel",
      "steps": [
        { "type": "single", "agent": "planner", "task": "Plan for {previous}" },
        { "type": "single", "agent": "reviewer", "task": "Review scope of {previous}" }
      ]
    },
    { "type": "single", "agent": "worker", "task": "Implement based on {previous}" }
  ]
}
```

## Usage

```typescript
import {
  AgentStepSchema,
  discoverAgents,
  invokeAgent,
  summarizeWorkflowResults,
} from "../workflow-core/src/index.ts";

const discovery = discoverAgents(cwd, "user");
const step: AgentStep = {
  type: "chain",
  steps: [
    { type: "single", agent: "scout", task: "Find relevant files" },
    { type: "single", agent: "planner", task: "Plan changes for {previous}" },
  ],
};

const execution = await invokeAgent(step, {
  cwd,
  agents: discovery.agents,
  signal,
  onProgress: (progress) => { /* stream UI updates */ },
});

const summary = summarizeWorkflowResults(step, execution);
// Return summary to main LLM; keep execution.results in tool details
```

## Context firewall

`summarizeWorkflowResults` returns only final outputs (truncated per task). Full `AgentResult.messages` stay in tool details for expanded UI rendering, not in the model-visible tool result.

## Dependencies

- `typebox` — AgentStep JSON schema (TypeBox 1.x, published as `typebox` on npm)
- `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` — resolved from monorepo workspace

## Consumers

- **workflow extension** (Agent 2): tool registration, UI rendering
- **subagent refactor** (Agent 3): import workflow-core instead of inline logic
