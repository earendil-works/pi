# Code/State Separation: Teaching by Example

The key insight from pi-mono: **Code is ephemeral, state is derived, history is permanent.**

This enables agents to modify their own tools and continue without losing context.

---

## The Wrong Way: Code and State Entangled

Imagine a simple todo extension the "naive" way:

```typescript
// naive-todo.ts - THE WRONG WAY
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// STATE IS GLOBAL - tied to the code module
let todos: string[] = [];
let nextId = 1;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "todo",
    description: "Manage todos",
    parameters: Type.Object({ action: Type.String(), text: Type.String() }),
    
    async execute(_id, params) {
      if (params.action === "add") {
        todos.push(params.text);  // Mutates module-level state
        return { content: [{ type: "text", text: `Added: ${params.text}` }] };
      }
      // ...
    }
  });
}
```

### What Goes Wrong

**Scenario: Agent adds a todo, then modifies the extension**

```
User: add a todo "buy milk"
[Agent calls todo tool, "buy milk" stored in module-level `todos` array]

User: can you make the todo tool also support priorities?
[Agent edits todo.ts, adds priority field]

User: /reload
[Extension reloaded - NEW module instance created]

User: list my todos
[todos array is EMPTY - state lost!]
```

**The module-level variables are wiped on reload.** The code changed, so the module was re-evaluated. The state was in the code's closure, so it vanished.

**Scenario: Branching breaks state**

```
User: add todo "fix bug #1"
[todo stored in global array]

User: /tree  [navigate to earlier point]
User: add todo "fix bug #2"  [on a branch]
[todo stored in SAME global array - WRONG]

User: /tree  [switch back to first branch]
[Sees both todos - but second todo shouldn't exist on this branch!]
```

Global state doesn't understand branching. It's one global variable, not branch-specific.

---

## The Right Way: State Derived from History

Now look at how pi-mono actually does it (simplified from `examples/extensions/todo.ts`):

```typescript
// pi-todo.ts - THE RIGHT WAY
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface Todo { id: number; text: string; done: boolean; }

export default function (pi: ExtensionAPI) {
  // In-memory cache ONLY - source of truth is session
  let todos: Todo[] = [];

  // DERIVE state from immutable history
  const reconstructState = (ctx: ExtensionContext) => {
    todos = [];
    
    // Walk the current branch from root to leaf
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "todo") {
          // State is in the session entry details
          todos = entry.message.details?.todos ?? [];
        }
      }
    }
  };

  // Reconstruct on EVERY lifecycle event
  pi.on("session_start", (_event, ctx) => reconstructState(ctx));
  pi.on("session_switch", (_event, ctx) => reconstructState(ctx));
  pi.on("session_fork", (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", (_event, ctx) => reconstructState(ctx));

  pi.registerTool({
    name: "todo",
    description: "Manage todos",
    parameters: Type.Object({ action: Type.String(), text: Type.String() }),
    
    async execute(_id, params, _onUpdate, _ctx, _signal) {
      if (params.action === "add") {
        const newTodo = { id: Date.now(), text: params.text, done: false };
        const newTodos = [...todos, newTodo];
        
        return {
          content: [{ type: "text", text: `Added: ${params.text}` }],
          // STATE IS SAVED IN TOOL RESULT DETAILS
          details: { todos: newTodos }
        };
      }
      // ...
    }
  });
}
```

### What the Session File Looks Like

```jsonl
{"type":"session","version":3,"id":"abc123","timestamp":"2025-01-31T10:00:00Z","cwd":"/project"}
{"type":"message","id":"msg001","parentId":null,"timestamp":"2025-01-31T10:00:01Z","message":{"role":"user","content":"add todo buy milk"}}
{"type":"message","id":"msg002","parentId":"msg001","timestamp":"2025-01-31T10:00:02Z","message":{"role":"toolResult","toolCallId":"call001","toolName":"todo","content":[{"type":"text","text":"Added: buy milk"}],"details":{"todos":[{"id":123456,"text":"buy milk","done":false}]}}}
```

**The `details` field contains the full state.** Not a diff, not an update—the complete state snapshot after this operation.

---

## Why This Works: The Composition

### 1. Code Changes, State Persists

```
User: add todo "buy milk"
[Tool executes, stores { todos: [{id: 1, text: "buy milk"}] } in session file]

User: add priority field to the todo tool
[Agent edits todo.ts]

User: /reload
[Module re-evaluated, `todos` array initialized to []]

[session_start event fires → reconstructState() runs]
[Reads session file → finds todo entry → restores todos array]

User: list todos
[Shows "buy milk" - state survived the reload!]
```

**Key:** The session file (JSONL on disk) outlives the code module (in-memory JS/TS).

### 2. Branching Works Correctly

```
User: add todo "fix auth bug"
[Entry A: details.todos = [{id: 1, text: "fix auth bug"}]]

User: /tree [navigate to before the todo was added]
[Leaf is now at Entry A's parent]

User: add todo "fix ui bug"  
[Entry B (new branch): details.todos = [{id: 2, text: "fix ui bug"}]]

[Current branch: root → Entry B. Auth bug todo is NOT on this branch]

User: /tree [navigate back to Entry A]
[Current branch: root → Entry A. UI bug todo is NOT on this branch]
```

**Key:** `getBranch()` returns different entries depending on which branch you're on. State is reconstructed from the branch's specific history.

### 3. Time Travel (The "Side Quest" Pattern)

```
Main session:
  [User asks agent to implement feature X]
  [Agent tries, hits error in tool Y]
  
User: /tree [go back to before the error]
User: fix tool Y, then test it
  [Agent edits tool Y, /reload, tests on branch]
  
User: /tree [go back to main branch]
User: continue implementing feature X
  [Tool Y now works correctly because code was fixed]
  [Session state for feature X work is intact]
```

The agent fixed the tool on a side branch, but the fix persisted because:
1. The code change was saved to the file
2. The session state (feature X work) was never lost—it was just on a different branch

---

## The Composition Contract

| Concern | Ownership | Lifetime | Source of Truth |
|---------|-----------|----------|-----------------|
| **Code** | Extension file (.ts) | Ephemeral (reloaded) | File system |
| **State** | Session entries | Permanent (appended) | Session JSONL |
| **Runtime cache** | In-memory variables | Session-scoped | Derived from entries |

### The Reconstruction Loop

```
Code Load → Event Trigger → Walk Branch → Replay Entries → Build State → Use State
    ↑                                                                              ↓
    └─────────────────────────────/reload or branch switch─────────────────────────┘
```

**Critical invariant:** Any state that needs to survive reloads MUST be stored in session entries. The in-memory variables are just a cache.

---

## Pattern Variations

### Storing State Without Tool Results

Sometimes you need state that doesn't map to a tool call. Use `appendEntry`:

```typescript
pi.on("session_start", async (_event, ctx) => {
  // Restore from custom entries
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "my-config") {
      config = entry.data;
    }
  }
});

// Save state without a tool call
pi.appendEntry("my-config", { theme: "dark", fontSize: 14 });
```

Custom entries:
- Persist to disk (survive reloads)
- Are NOT sent to LLM (won't consume context)
- Participate in branching (each branch has its own config)

### Partial State Reconstruction

For performance, you don't need to replay from the beginning every time:

```typescript
let lastReconstructedEntryId: string | null = null;

const reconstructState = (ctx: ExtensionContext) => {
  const branch = ctx.sessionManager.getBranch();
  const startIdx = lastReconstructedEntryId 
    ? branch.findIndex(e => e.id === lastReconstructedEntryId) + 1
    : 0;
  
  // Only process new entries since last reconstruction
  for (let i = startIdx; i < branch.length; i++) {
    applyEntry(branch[i]);
  }
  
  lastReconstructedEntryId = branch[branch.length - 1]?.id ?? null;
};
```

(Note: Pi's actual implementation is simpler—just walks the whole branch. Premature optimization unless you have thousands of entries.)

---

## Anti-Patterns to Avoid

### ❌ Don't: Store state in global variables without reconstruction

```typescript
// BAD - state lost on reload
let counter = 0;
pi.registerTool({ name: "count", execute: () => counter++ });
```

### ❌ Don't: Use external files for extension state

```typescript
// BAD - breaks branching, no atomicity with session
const saveTodos = () => fs.writeFileSync('/tmp/todos.json', JSON.stringify(todos));
```

External files:
- Don't participate in branching
- Can get out of sync with session
- Not atomic with session writes
- Hard to share/synchronize across machines

### ❌ Don't: Store state in tool results but forget to replay

```typescript
// BAD - state stored but never loaded
pi.registerTool({
  execute: () => {
    todos.push(item);
    return { content: [...], details: { todos } };
  }
});
// Missing: pi.on("session_start", reconstructState)
```

### ✅ Do: Store complete snapshots, not deltas

```typescript
// GOOD - stores complete state
return { details: { todos: [...todos, newTodo] } };

// BAD - stores only the delta, requires complex replay logic
return { details: { action: "add", todo: newTodo } };
```

Storing complete snapshots makes reconstruction trivial: just take the last entry's state. Deltas require replaying the entire history to compute current state.

---

## Summary

**Code/State separation** means:

1. **Code is a pure function of the file system** — reload it anytime
2. **State is a pure function of session history** — derive it by replaying entries
3. **History is append-only and immutable** — branches are just different views
4. **The composition is: `State = f(History)`** — code just provides `f`

This is what makes "agents building agents" possible. The agent can modify the code (its own tooling), reload, and continue—because the work-in-progress state is safely stored in the session history, not trapped in the old code's memory.

> "The session is the database. The extension is the query."
