# How It All Ties Together: A Practical Walkthrough

This document shows how the primitive concepts from `primitive-concepts.md` manifest in actual pi-mono code, walking through a concrete scenario.

---

## The Scenario

A user is coding with pi. They:
1. Add a todo item via the AI
2. The agent (via tool call) adds "buy milk" to a todo list
3. User asks the agent to enhance the todo tool with priorities
4. Agent modifies the extension code
5. User runs `/reload`
6. Agent uses the new priority feature

Let's trace how the primitives make this work.

---

## 1. The Session File (The Log)

After step 2, the session file (`~/.pi/agent/sessions/--project--/2025-01-31_abc123.jsonl`) looks like:

```jsonl
{"type":"session","version":3,"id":"abc123","timestamp":"2025-01-31T10:00:00.000Z","cwd":"/project"}
{"type":"message","id":"e1a2b3c4","parentId":null,"timestamp":"2025-01-31T10:00:01.000Z","message":{"role":"user","content":"Add a todo: buy milk","timestamp":1738316401000}}
{"type":"message","id":"f2b3c4d5","parentId":"e1a2b3c4","timestamp":"2025-01-31T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call001","name":"todo","arguments":{"action":"add","text":"buy milk"}}],"provider":"anthropic","model":"claude-sonnet-4-5","api":"anthropic-messages","usage":{...},"stopReason":"toolUse","timestamp":1738316402000}}
{"type":"message","id":"g3c4d5e6","parentId":"f2b3c4d5","timestamp":"2025-01-31T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"call001","toolName":"todo","content":[{"type":"text","text":"Added todo #1: buy milk"}],"isError":false,"details":{"todos":[{"id":1,"text":"buy milk","done":false}],"nextId":2},"timestamp":1738316403000}}
```

**Primitive mapping:**
- Each line = **Event**
- The file = **Log** (append-only)
- `id` + `parentId` = Tree structure for **Branch** navigation
- The `details` field in the toolResult = Extension **State** snapshot

---

## 2. The Extension (Code as Pure Function)

The todo extension at `~/.pi/agent/extensions/todo.ts`:

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface Todo { id: number; text: string; done: boolean; }

export default function (pi: ExtensionAPI) {
  // In-memory cache (ephemeral)
  let todos: Todo[] = [];

  // STATE PROJECTION: Derive from log events
  const reconstructState = (ctx: ExtensionContext) => {
    todos = [];  // Reset cache
    
    // Get current branch from session manager
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "todo") {
          // Extract state from event details
          todos = entry.message.details?.todos ?? [];
        }
      }
    }
  };

  // Reconstruct on every context change
  pi.on("session_start", (_event, ctx) => reconstructState(ctx));
  pi.on("session_switch", (_event, ctx) => reconstructState(ctx));
  pi.on("session_fork", (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", (_event, ctx) => reconstructState(ctx));

  // Register the todo tool
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage todos: list, add, toggle, clear",
    parameters: Type.Object({
      action: Type.String(),
      text: Type.Optional(Type.String()),
      id: Type.Optional(Type.Number()),
    }),
    
    async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
      // Read from derived state
      switch (params.action) {
        case "add": {
          const newTodo = { 
            id: Date.now(), 
            text: params.text, 
            done: false 
          };
          const newTodos = [...todos, newTodo];
          
          // Return result with state snapshot in details
          return {
            content: [{ type: "text", text: `Added: ${params.text}` }],
            details: { todos: newTodos, nextId: newTodos.length + 1 }  // ← STATE SNAPSHOT
          };
        }
        // ... other actions
      }
    }
  });
}
```

**Primitive mapping:**
- `reconstructState` = **Projection** function (folds events into state)
- `pi.on("session_*")` = Subscribe to **Context** switch events
- `details: { todos }` = State stored in **Event** payload

---

## 3. The Session Manager (Log Operations)

From `session-manager.ts`, here's how primitives are implemented:

### Append-Only Log

```typescript
export class SessionManager {
  private fileEntries: FileEntry[] = [];  // The log in memory
  private byId: Map<string, SessionEntry> = new Map();  // Index for O(1) lookup
  private leafId: string | null = null;  // Current branch pointer

  // APPEND: The only write operation
  private _appendEntry(entry: SessionEntry): void {
    this.fileEntries.push(entry);        // Add to log
    this.byId.set(entry.id, entry);      // Index it
    this.leafId = entry.id;              // Advance leaf pointer
    this._persist(entry);                // Write to disk (append-only)
  }

  // Example: Appending a message
  appendMessage(message: AgentMessage): string {
    const entry: SessionMessageEntry = {
      type: "message",
      id: generateId(this.byId),     // Generate unique ID
      parentId: this.leafId,          // Link to current leaf
      timestamp: new Date().toISOString(),
      message,
    };
    this._appendEntry(entry);
    return entry.id;
  }
}
```

### Branch Navigation (Context Switch)

```typescript
// BRANCH: Move leaf pointer to create new timeline
branch(branchFromId: string): void {
  if (!this.byId.has(branchFromId)) {
    throw new Error(`Entry ${branchFromId} not found`);
  }
  this.leafId = branchFromId;  // Just move the pointer!
}

// GET BRANCH: Derive current timeline
getBranch(fromId?: string): SessionEntry[] {
  const path: SessionEntry[] = [];
  const startId = fromId ?? this.leafId;
  let current = startId ? this.byId.get(startId) : undefined;
  
  // Walk parent pointers to root
  while (current) {
    path.unshift(current);  // Add to front (root → leaf order)
    current = current.parentId ? this.byId.get(current.parentId) : undefined;
  }
  return path;
}
```

**Primitive mapping:**
- `_appendEntry` = **append** operation (immutable, creates new event)
- `branch()` = **navigate** operation (O(1), just moves pointer)
- `getBranch()` = **project** operation (derives current timeline)

---

## 4. The Extension Runner (Event System)

From `runner.ts`, here's how the event/interceptor system works:

### Event Emission (The Chain of Responsibility)

```typescript
export class ExtensionRunner {
  private extensions: Extension[];  // All loaded extensions

  // Emit event to all subscribers
  async emit(event: ExtensionEvent): Promise<undefined> {
    const ctx = this.createContext();  // Build context for handlers

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get(event.type);
      if (!handlers) continue;

      for (const handler of handlers) {
        try {
          const result = await handler(event, ctx);
          
          // Check for cancellation (interceptor pattern)
          if (result?.cancel) {
            return result;  // Stop propagation
          }
        } catch (err) {
          this.emitError({ extensionPath: ext.path, event: event.type, error: err });
        }
      }
    }
  }

  // Tool call with interception
  async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    for (const ext of this.extensions) {
      const handlers = ext.handlers.get("tool_call");
      if (!handlers) continue;

      for (const handler of handlers) {
        const result = await handler(event, this.createContext());
        
        if (result?.block) {
          return result;  // INTERCEPT: Block the tool
        }
      }
    }
    return undefined;  // Pass through
  }
}
```

### Tool Wrapping (Interceptors in Action)

From `wrapper.ts`:

```typescript
export function wrapToolWithExtensions<T>(tool: AgentTool<any, T>, runner: ExtensionRunner): AgentTool<any, T> {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      
      // BEFORE: Emit tool_call event (interceptors can block)
      const callResult = await runner.emitToolCall({
        type: "tool_call",
        toolName: tool.name,
        toolCallId,
        input: params,
      });
      
      if (callResult?.block) {
        throw new Error(callResult.reason || "Blocked by extension");
      }

      // EXECUTE: Run the actual tool
      const result = await tool.execute(toolCallId, params, signal, onUpdate);

      // AFTER: Emit tool_result event (interceptors can modify)
      const resultResult = await runner.emit({
        type: "tool_result",
        toolName: tool.name,
        toolCallId,
        input: params,
        content: result.content,
        details: result.details,
        isError: false,
      });

      if (resultResult) {
        // Return modified result
        return {
          content: resultResult.content ?? result.content,
          details: resultResult.details ?? result.details,
        };
      }
      return result;
    },
  };
}
```

**Primitive mapping:**
- `emit()` = **Event** emission (publish to all subscribers)
- `emitToolCall()` with `block` = **Interceptor** pattern
- Handler chain = **Middleware** pipeline

---

## 5. The Hot Reload (Code/State Separation in Action)

When user runs `/reload`:

### What Happens (Step by Step)

```typescript
// 1. Reload command triggered
pi.on("input", async (event, ctx) => {
  if (event.text === "/reload") {
    // 2. Re-discover and re-load extensions
    const { extensions, runtime } = await discoverAndLoadExtensions(
      configuredPaths,
      cwd,
      eventBus
    );
    
    // 3. Create new ExtensionRunner with fresh code
    const newRunner = new ExtensionRunner(extensions, runtime, cwd, sessionManager, modelRegistry);
    
    // 4. Bind core actions to the runner
    newRunner.bindCore(actions, contextActions);
    
    // 5. SessionManager is UNCHANGED (same log, same leaf)
    //    - All fileEntries preserved
    //    - leafId unchanged
    //    - byId index intact
    
    // 6. Emit session_start to all extensions
    await newRunner.emit({ type: "session_start" });
    //    Each extension calls reconstructState(ctx)
    //    State is derived fresh from the log
    
    return { action: "handled" };
  }
});
```

### State Before/After

**Before reload:**
```
Module: old todo.ts code
  ↓
Closure: todos = [{id: 1, text: "buy milk", done: false}]
  ↓
Log: [...events with details.todos...]
```

**During reload:**
```
Module: unloaded (todos array destroyed!)
  ↓
/reload command
  ↓
Module: new todo.ts code loaded (todos = []) ← fresh closure
```

**After reload (session_start event):**
```
Event: session_start
  ↓
Handler: reconstructState(ctx)
  ↓
ctx.sessionManager.getBranch() → [events...]
  ↓
for each event: if toolResult with todos, update todos array
  ↓
todos = [{id: 1, text: "buy milk", done: false}] ← RESTORED!
```

**Key insight:** The in-memory `todos` array was destroyed, but the **Log** (session file) preserved the state. The reconstruction replayed the events to rebuild the cache.

---

## 6. Branching (The Side Quest)

User wants to try adding priority feature on a branch:

```
User: /tree
[TUI shows tree, user selects event before "buy milk" todo]
[User branches to that point]

SessionManager.branch("f2b3c4d5");  // Move leaf to before tool result
// leafId is now "f2b3c4d5"

User: Add priority support to the todo tool
[Agent edits todo.ts, adding priority field]

User: /reload
[Extension reloaded, reconstructState() runs]
[getBranch() now returns path UP TO f2b3c4d5, not including g3c4d5e6]
[todos array is EMPTY on this branch - correct!]

User: add todo "urgent: fix bug" with high priority
[Tool executes, stores {todos: [{id: 2, text: "urgent: fix bug", priority: "high"}]}]
```

### The Log After Branching

```jsonl
{"type":"session",...}
{"type":"message","id":"e1a2b3c4",...}  // user: add todo
{"type":"message","id":"f2b3c4d5",...}  // assistant: tool call
{"type":"message","id":"g3c4d5e6",...}  // tool result (buy milk) ← NOT on current branch
{"type":"message","id":"h4d5e6f7","parentId":"f2b3c4d5",...}  // NEW: tool result (fix bug)
```

Tree structure:
```
e1a2b3c4 (root: user msg)
  └── f2b3c4d5 (assistant: tool call)
        ├── g3c4d5e6 (tool result: buy milk) ← Original branch
        └── h4d5e6f7 (tool result: fix bug) ← Current branch (leaf)
```

**Primitive mapping:**
- Branching = Change `leafId` pointer
- Different branches = Different `getBranch()` results
- State per branch = Correct because derived from that branch's events

---

## 7. The Composition Equation in Code

Here's how `State = Projection(Branch)` actually executes:

```typescript
// Extension's reconstructState = Projection
const reconstructState = (ctx: ExtensionContext) => {
  // 1. Get Branch (timeline of events)
  const events = ctx.sessionManager.getBranch();  // [e1, f2, g3] or [e1, f2, h4]
  
  // 2. Fold/Reduce into State
  todos = events.reduce((state, event) => {
    if (isTodoToolResult(event)) {
      return event.message.details.todos;  // Take latest snapshot
    }
    return state;
  }, []);
};

// SessionManager.getBranch = Branch resolution
getBranch(): SessionEntry[] {
  const path = [];
  let current = this.byId.get(this.leafId);  // Start at leaf
  
  while (current) {
    path.unshift(current);  // Build path backwards
    current = this.byId.get(current.parentId);  // Follow parent
  }
  return path;  // Return root→leaf ordered events
}

// ExtensionRunner.emitContext = Context transformation
async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
  let currentMessages = messages;
  
  for (const ext of this.extensions) {
    const handlers = ext.handlers.get("context");
    for (const handler of handlers) {
      const event: ContextEvent = { type: "context", messages: currentMessages };
      const result = await handler(event, ctx);
      if (result?.messages) {
        currentMessages = result.messages;  // Transform messages
      }
    }
  }
  return currentMessages;  // Final context for LLM
}
```

---

## Summary: Primitives → Implementation

| Primitive | Pi-Mono Implementation | File |
|-----------|------------------------|------|
| **Event** | `SessionEntry` interfaces (message, compaction, custom, etc.) | `session-manager.ts` |
| **Log** | JSONL file + `fileEntries` array + `appendFileSync` | `session-manager.ts` |
| **Branch** | `leafId` pointer + `parentId` chain | `session-manager.ts` |
| **State** | In-memory variables reconstructed via `reconstructState()` | Extension code |
| **Projection** | `getBranch()` + fold over events | `session-manager.ts` |
| **Context** | `ExtensionContext` with `sessionManager`, `ui`, etc. | `runner.ts` |
| **Command** | Tool calls, user input → produce events | `wrapper.ts` |
| **Interceptor** | `emitToolCall()` with `block` capability | `runner.ts` + `wrapper.ts` |

**The magic:** Because code and state are separate, you can:
1. Change the code (modify extension)
2. Reload (new code, fresh closures)
3. Reconstruct state from immutable log
4. Continue as if nothing happened

The session file is the database. The extension is the query. The in-memory variables are just a cache.
