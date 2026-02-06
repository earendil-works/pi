# Pi-Mono Extension Architecture Patterns

Extracted from analysis of [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

---

## 1. Dual-Purpose Message Architecture

**Pattern: Extendable Message Union with Separation of Concerns**

The session stores all messages (LLM-facing + system-only), but provides a `convertToLlm` function that filters/transforms before sending to any provider.

```typescript
// Base LLM messages (portable across providers)
type Message = UserMessage | AssistantMessage | ToolResultMessage;

// Extended with custom types via declaration merging
interface CustomAgentMessages {
  artifact: ArtifactMessage;
  notification: NotificationMessage;
}

// Final union - some go to LLM, some don't
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

This lets extensions:
- Store state in session files without polluting the LLM context
- Render custom UI components that don't participate in AI reasoning
- Add metadata that survives branching/navigation

### Session Entry Types

| Type | Sent to LLM | Purpose |
|------|-------------|---------|
| `message` | Yes | Standard conversation |
| `custom` | No | Extension state persistence |
| `custom_message` | Yes | Extension-injected context |
| `compaction` | Yes (as summary) | Context compression |
| `branch_summary` | Yes | Captures abandoned branch context |

---

## 2. Provider-Abstracted Session Portability

**Pattern: Lowest-Common-Denominator Normalization with Provider-Specific Adaptation**

```typescript
// Core model interface - provider-agnostic
interface Model<TApi extends Api> {
  id: string;
  api: TApi;  // 'anthropic-messages' | 'openai-responses' | etc.
  provider: Provider;
  reasoning: boolean;
  input: ('text' | 'image')[];
  // ...
}
```

### Key Mechanisms

**Message normalization:** All provider-specific formats (Anthropic thinking blocks, OpenAI reasoning, Google thought signatures) normalize to a common `ThinkingContent` type internally.

**Cross-provider handoff:** Thinking content is preserved when staying within the same provider/API, but converted to `<thinking>` text tags when crossing provider boundaries—preserving context without requiring provider-specific features.

**Compat layers:** OpenAI-compatible APIs get auto-detected compatibility settings, overridable via `compat` field.

---

## 3. Hot Reloading via JIT Extension Loader

**Pattern: Runtime Module Loading with Virtual Module Resolution**

```typescript
// Uses jiti (TypeScript JIT) with module cache disabled
const jiti = createJiti(import.meta.url, {
  moduleCache: false,  // ← Key for hot reload
  virtualModules: VIRTUAL_MODULES,  // For bundled binaries
  alias: getAliases(),  // For dev/Node.js
});

// Load fresh copy every time
const module = await jiti.import(extensionPath, { default: true });
```

### Architecture

- Extensions are TypeScript files loaded at runtime (no build step for extension dev)
- `moduleCache: false` ensures fresh code on each `/reload` command
- **Virtual modules** allow extensions to import core packages even in compiled Bun binaries
- Extension state is reconstructed from session history on reload

### The Loop

Agent writes extension code → `/reload` → fresh code loaded → state reconstructed from session entries → test → repeat.

---

## 4. Tree-Structured Session with Event Sourcing

**Pattern: Append-Only Event Log with Branching**

```typescript
// Every entry has id + parentId forming a tree
interface SessionEntryBase {
  id: string;           // 8-char hex
  parentId: string | null;
  timestamp: string;
}

// Session is JSONL - each line is an immutable event
{"type":"message","id":"a1b2c3d4","parentId":"prev1234",...}
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8",...}
```

### Key Patterns

**Event sourcing:** State is reconstructed by replaying events from the current branch.

**Branching:** Navigate to any point (`/tree`), create new leaf—history preserved, no copying.

**Branch summaries:** When abandoning a branch, LLM generates a summary entry capturing context.

**Compaction:** Lossy compression of old messages into summary entries, but full history remains in file.

---

## 5. Extension State Reconstruction Pattern

**Pattern: Derive Current State from Immutable History**

```typescript
// From todo.ts example - state is NOT stored in variables that survive reload
let todos: Todo[] = [];  // In-memory only

// Reconstruct from session on every lifecycle event
const reconstructState = (ctx: ExtensionContext) => {
  todos = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      if (entry.message.toolName === "todo") {
        todos = entry.message.details?.todos ?? [];
      }
    }
  }
};

pi.on("session_start", reconstructState);
pi.on("session_switch", reconstructState);
pi.on("session_fork", reconstructState);  // Critical: works correctly on branch
pi.on("session_tree", reconstructState);
```

### Why This Matters

Extension state is correct for *any point in history* because it's derived from the branch, not stored as mutable state. This enables the "side-quest" workflow—fix a tool on a branch, then rewind and the main session sees the fix.

---

## 6. Lifecycle Event Interception Pattern

**Pattern: Observable Event Stream with Blocking/Modification Hooks**

```typescript
// Extensions subscribe to events, can block or transform
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
    const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
    if (!ok) return { block: true, reason: "Blocked by user" };
  }
});

pi.on("tool_result", async (event, ctx) => {
  // Can modify results before they go to LLM
  return { content: [...], details: {...}, isError: false };
});

pi.on("context", async (event, ctx) => {
  // Filter/prune messages before LLM call
  return { messages: filtered };
});
```

### Capabilities

Tools are not hardcoded. The extension system wraps all tools with interceptors, enabling:
- Permission gates
- Result transformation
- Context window management
- Custom logging/audit

---

## Summary: The Meta-Pattern

**"Software as Clay" Architecture:**

1. **Everything is data** — session files are plain JSONL, models are data, tools are data
2. **Everything is transformable** — extensions can intercept and modify at every boundary
3. **Everything is replayable** — tree structure + event sourcing = time travel
4. **Everything is portable** — lowest-common-denominator abstractions with adapter layers

This creates a system where the agent can modify its own tooling, reload, and continue—because the "code" (extensions) and "state" (session) are separate concerns that compose correctly.

---

## Reference: Key Files

| File | Purpose |
|------|---------|
| `packages/agent/src/types.ts` | `AgentMessage` union, `AgentLoopConfig` |
| `packages/ai/src/types.ts` | Base `Message` types, `Model` interface |
| `packages/coding-agent/docs/session.md` | Session format, entry types |
| `packages/coding-agent/docs/extensions.md` | Extension API reference |
| `packages/coding-agent/src/core/extensions/loader.ts` | JIT loading implementation |
| `packages/coding-agent/examples/extensions/todo.ts` | State reconstruction example |
