# Agent Bus

The agent bus is Pi's read-only mirror seam for federated rosters. It lets a Pi session publish normalized lifecycle events to an external observer such as nineight without handing that observer ownership of the Pi session.

## Ownership rule

- Pi owns Pi sessions and applies Pi-native control (`prompt`, `steer`, `follow_up`, `abort`, session replacement).
- Claude Code owns Claude sessions and applies Claude-native control.
- A federated roster mirrors both as read-only actual state, then routes control requests back to the owning harness.

Do not make another system edit Pi session JSONL as a control path. Session files are provenance, not the command API.

## Event mirror

`createAgentBusMirror()` subscribes to an `AgentSession` and emits v0 `AgentBusEvent` records:

```typescript
import { createAgentBusMirror } from "@mariozechner/pi-coding-agent";

const unsubscribe = createAgentBusMirror(session, {
  project: "nineight",
  host: "franks-laptop",
  sink: async (event) => {
    await fetch("http://localhost:9888/api/agent-bus/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  },
});

// Later, when tearing down the runtime:
unsubscribe();
```

The helper emits `agent.registered` immediately, then converts Pi `AgentSessionEvent` values into normalized event kinds such as `agent.started`, `message.ended`, `tool.started`, `queue.changed`, and `compaction.ended`.

By default the mirror is safe for roster views: message text, queued prompts, tool arguments, tool results, and error strings are summarized by shape/length only. Set `includeSensitiveData: true` only for a trusted local sink.

High-volume streams are opt-in:

- `includeMessageUpdates: true` mirrors assistant streaming deltas.
- `includeToolUpdates: true` mirrors partial tool updates.

## Addressing

Pi uses the same address shape as the inter-agent mailbox envelope:

```typescript
type AgentBusAddress =
  | { kind: "run"; harness: string; runId: string; host?: string }
  | { kind: "session"; harness: string; sessionId: string; host?: string }
  | { kind: "name"; name: string; project?: string; harness?: string; host?: string }
  | { kind: "role"; role: string; project?: string; harness?: string; host?: string };
```

A Pi interactive or SDK session should normally register as `{ kind: "session", harness: "pi-agent", sessionId }`.

## Control path

The mirror is not the control path. A federated control layer should accept a `ControlIntent`, check policy/gates, then route to the owner:

| Intent | Pi owner applies | Foreign observer should record |
| --- | --- | --- |
| `prompt` | `session.prompt()` / RPC `prompt` | receipt: `applied` or `failed` |
| `steer` | `session.steer()` / RPC `steer` | receipt: native `steer` applied |
| `follow_up` | `session.followUp()` / RPC `follow_up` | receipt: native `follow_up` applied |
| `abort` | `session.abort()` / RPC `abort` | receipt: aborted/failed |
| `note` | extension custom message or inbox | receipt: delivered/read |

If another harness asks Pi to do something Pi cannot honor, return a degraded/failed receipt. Do not silently emulate unsupported behavior.

## Federated roster shape

A consumer such as nineight can derive a roster entry from `agent.registered` plus later events:

```typescript
type FederatedRosterEntry = {
  address: AgentBusAddress;
  source: "pi-agent" | "claude-code" | string;
  project?: string;
  cwd?: string;
  desiredState?: "active" | "paused" | "retired"; // roster-owned
  actualState: "working" | "blocked" | "done" | "failed" | "stopped" | "unknown"; // harness-owned
  lastSeenAt: string;
};
```

The important split is desired versus actual state. Pi supplies actual state. The roster/project-lead layer may decide desired state, leases, budgets, or assignments, but must reconcile by asking Pi to act through Pi's native APIs.
