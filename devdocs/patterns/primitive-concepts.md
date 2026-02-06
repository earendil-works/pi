# Primitive Concepts & Operations

The pi-mono architecture is built on a small set of fundamental primitives. Everything else is derived from these.

---

## Core Concepts

### 1. Event (The Atom)

An **event** is an immutable, timestamped record that something happened.

```typescript
interface Event {
  id: string;           // Unique identifier
  type: string;         // What happened
  timestamp: number;    // When it happened
  parentId: string | null;  // Previous event (forms chain)
  payload: unknown;     // Event-specific data
}
```

**Properties:**
- Immutable: Never modified after creation
- Append-only: Only add, never remove or update
- Self-contained: Includes all context needed to understand it
- Ordered: Total order within a branch (via parentId chain)

**Examples:**
- `UserMessageSent`
- `ToolExecuted`
- `ModelChanged`
- `ExtensionStateUpdated`

---

### 2. Log (The Source of Truth)

The **log** is an append-only sequence of events. It is the sole source of truth.

```typescript
type Log = Event[];  // Ordered by id/parentId chain
```

**Properties:**
- Append-only: `log.push(event)` only
- Immutable history: Past events never change
- Persistent: Survives process restarts
- Serializable: Can be stored, transmitted, replicated

**In pi-mono:** The session JSONL file IS the log.

---

### 3. Branch (The Timeline)

A **branch** is a path through the event tree—a linear sequence from root to a specific leaf.

```typescript
interface Branch {
  root: Event;          // First event (parentId: null)
  leaf: Event;          // Current tip
  events: Event[];      // Ordered path from root to leaf
}
```

**Key insight:** The same log contains many possible branches. Branching creates a new leaf with an existing event as parent.

```
Log (as tree):
  Event1 (root)
    └── Event2
          ├── Event3 ← Branch A (leaf)
          └── Event4 ← Branch B (leaf)
```

**Operations:**
- `getBranch(log, leafId)` → ordered events from root to leaf
- `branch(log, atEventId, newEvent)` → create new branch
- `listBranches(log)` → all possible leaf events

---

### 4. State (The Derivative)

**State is not stored. State is derived.**

```typescript
type State = unknown;  // Domain-specific
type Projection = (events: Event[]) => State;
```

State is computed by folding (reducing) events through a pure function:

```typescript
const state = events.reduce(projection, initialState);
```

**Properties:**
- Derived: Always computed, never stored as primary data
- Deterministic: Same events → same state
- Replayable: Can reconstruct at any point in history
- Branch-local: Different branches → different states

**In pi-mono:**
```typescript
const reconstructState = (ctx: ExtensionContext) => {
  const events = ctx.sessionManager.getBranch();  // Get current branch
  return events.reduce(applyEvent, initialState); // Derive state
};
```

---

### 5. Context (The Boundary)

**Context** defines what events are visible and how they're interpreted.

```typescript
interface Context {
  branch: Event[];      // Which events are visible
  projection: Projection;  // How to interpret them
  handlers: Map<EventType, Handler[]>;  // Who reacts to them
}
```

**Operations:**
- `switchContext(toBranch)` → Change which events are visible
- `transformContext(fn)` → Modify/filter events before projection
- `forkContext(atEvent)` → Create new branch from point

**Key insight:** Context switching (branching) is cheap because events are immutable and shared.

---

### 6. Command (The Intent)

A **command** is an intention to change state. Commands produce events.

```typescript
interface Command {
  type: string;
  payload: unknown;
}

type CommandHandler = (cmd: Command, ctx: Context) => Event | Event[] | null;
```

**Flow:**
```
Command → Validate → Produce Events → Append to Log → Project State
```

**Important:** Commands are ephemeral. Only events are preserved. If a command fails validation, no event is created.

**In pi-mono:**
- User input → Command
- Tool execution → Command  
- Extension API calls → Commands

---

### 7. Interceptor (The Middleware)

An **interceptor** transforms or blocks events before they take effect.

```typescript
type Interceptor = (event: Event, ctx: Context) => 
  | Event           // Transform
  | Event[]         // Split/Multiply
  | null            // Block
  | undefined;      // Pass through unchanged
```

**Uses:**
- Validation (block invalid events)
- Transformation (normalize data)
- Side effects (trigger other actions)
- Auditing (log all events)

**In pi-mono:**
```typescript
pi.on("tool_call", async (event, ctx) => {
  if (isDangerous(event)) {
    const ok = await confirm();
    if (!ok) return { block: true };  // Intercept: block
  }
  // Return undefined = pass through
});
```

---

## Primitive Operations

### Write Operations (Side Effects)

| Operation | Signature | Description |
|-----------|-----------|-------------|
| **append** | `(log, event) → void` | Add event to log |
| **branch** | `(log, atEvent, newEvent) → Branch` | Create new timeline |
| **register** | `(context, eventType, handler) → void` | Subscribe to events |

### Read Operations (Pure)

| Operation | Signature | Description |
|-----------|-----------|-------------|
| **project** | `(events, projection) → State` | Derive state from events |
| **query** | `(state, query) → Result` | Read from derived state |
| **getBranch** | `(log, leafId) → Event[]` | Get event sequence |
| **diff** | `(branchA, branchB) → Event[]` | Find diverging events |

### Navigation Operations (Context Switch)

| Operation | Signature | Description |
|-----------|-----------|-------------|
| **navigate** | `(context, toEvent) → Context` | Switch to different branch |
| **rewind** | `(context, count) → Context` | Go back N events |
| **fork** | `(context, atEvent) → Context` | Create branch at point |

---

## The Fundamental Equation

```
State(t) = Projection(Branch(t))
```

At any time `t`, the state is the projection of the current branch.

**Corollaries:**
1. **State is always consistent** — derived from immutable events
2. **State is always reconstructible** — replay the events
3. **State is branch-local** — different branches, different states
4. **Time travel is free** — just switch branches

---

## Composition Rules

### 1. Events Compose Sequentially

```
Event A → Event B → Event C = Log [A, B, C]
```

### 2. Projections Compose Functionally

```
State = events.reduce(apply, initial)
```

### 3. Branches Compose as Trees

```
Log = Tree<Event>
Branch = Path(root → leaf)
```

### 4. Contexts Compose by Layering

```
Base Context + Extension Handlers = Augmented Context
```

---

## Architectural Invariants

### Invariant 1: Events Are Immutable

```typescript
// NEVER
existingEvent.payload = newValue;

// ALWAYS
append(log, { ...existingEvent, payload: newValue, id: newId() });
```

### Invariant 2: State Is Derived

```typescript
// NEVER
state.todos.push(newTodo);
saveStateToFile(state);

// ALWAYS
append(log, { type: "TodoAdded", payload: newTodo });
state = project(getBranch(log));  // Re-derive
```

### Invariant 3: Effects Happen via Events

```typescript
// NEVER
fs.writeFileSync("state.json", JSON.stringify(state));

// ALWAYS
append(log, { type: "FileWriteRequested", path, content });
// Handler performs actual write
```

### Invariant 4: Branches Are Cheap

```typescript
// Branching is O(1) - just create new leaf with existing parent
const newBranch = branch(log, existingEventId, newEvent);

// No copying of historical events
// No forking of state
// Just a new pointer into the existing tree
```

---

## Derived Patterns

These higher-level patterns emerge from the primitives:

| Pattern | Primitives Used |
|---------|----------------|
| **Event Sourcing** | Events + Log + Projection |
| **CQRS** | Commands → Events / Queries ← State |
| **Git-like Branching** | Tree Log + Branch paths |
| **Time Travel** | Navigate + Project |
| **Hot Reload** | Re-register handlers + Re-project |
| **Side Quests** | Fork + Navigate + Merge (via summary) |
| **Interceptor Chain** | Register + Intercept + Transform |

---

## Summary Table

| Concept | Analogy | Lifetime | Mutability |
|---------|---------|----------|------------|
| **Event** | Fact | Permanent | Immutable |
| **Log** | History book | Permanent | Append-only |
| **Branch** | Timeline | Ephemeral (pointer) | Mutable pointer |
| **State** | Understanding | Ephemeral (cache) | Derived |
| **Context** | Frame of reference | Ephemeral | Switchable |
| **Command** | Intent | Ephemeral | Transient |
| **Projection** | Perspective | Permanent (code) | Versioned |

**The insight:** Everything mutable is ephemeral. Everything permanent is immutable. The system moves forward by appending immutable facts, then deriving current understanding from them.
