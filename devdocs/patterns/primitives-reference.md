# Primitive Concepts: Reference Guide

## The 7 Primitives

---

### 1. Event

**Purpose:** The immutable atom of history. A record that something happened at a specific time.

**Behavior:**
- Created once, never modified
- Contains all context needed to understand what happened
- Self-describing via `type` field
- Ordered by timestamp and chain (parentId)

**Operations:**
```typescript
createEvent(type, payload, parentId) → Event
serialize(event) → JSON
deserialize(json) → Event
```

**Key Property:** Events are facts. Once written, they are permanent and unchangeable.

---

### 2. Log

**Purpose:** The source of truth. An append-only sequence of events.

**Behavior:**
- Only append operation allowed
- No updates, no deletions
- Persistent (survives restarts)
- Serializable and transferable

**Operations:**
```typescript
append(log, event) → void           // Add to end
read(log) → Event[]                 // Get all events
find(log, id) → Event | undefined   // Lookup by ID
serialize(log) → string             // To JSONL
```

**Key Property:** The log is the database. Everything else is derived from it.

---

### 3. Branch

**Purpose:** A timeline—a path through the event tree from root to a specific leaf.

**Behavior:**
- Multiple branches can exist in the same log
- Branching is cheap (O(1), just change a pointer)
- Each branch has its own view of history
- Branches can diverge and never merge (in pi-mono)

**Operations:**
```typescript
branch(log, atEventId) → Branch     // Create new branch at point
getPath(branch) → Event[]           // Get ordered events root→leaf
switchBranch(branch) → void         // Change current branch
getLeaf(branch) → Event             // Get current tip
```

**Key Property:** Branching creates alternate timelines without copying data.

---

### 4. State

**Purpose:** The current understanding derived from a branch's events.

**Behavior:**
- Never stored permanently (always computed)
- Deterministic: same events → same state
- Local to a branch
- Can be reconstructed at any time

**Operations:**
```typescript
project(events, projectionFn) → State   // Fold events into state
rebuild(branch) → State                 // Reconstruct from scratch
diff(stateA, stateB) → Changes          // Compare states
```

**Key Property:** State is a cache. The log is the truth.

---

### 5. Context

**Purpose:** The boundary defining what's visible and how to interpret it.

**Behavior:**
- Contains current branch, projection function, and handlers
- Can be switched (change branch)
- Can be transformed (filter/modify events)
- Layered (multiple contexts can compose)

**Operations:**
```typescript
createContext(branch, projection) → Context
switchContext(context, branch) → Context
transformContext(context, fn) → Context
getVisibleEvents(context) → Event[]
```

**Key Property:** Context is the frame of reference for all operations.

---

### 6. Command

**Purpose:** An intention to change the system. Commands produce events.

**Behavior:**
- Ephemeral (not stored)
- Validated before execution
- May produce zero, one, or many events
- Can fail (no events produced)

**Operations:**
```typescript
validate(command, state) → boolean    // Check if valid
execute(command, context) → Event[]   // Run, produce events
batch(commands) → Event[]             // Execute multiple
```

**Key Property:** Commands are the write API. Events are the write result.

---

### 7. Interceptor

**Purpose:** Middleware that transforms or blocks events/commands.

**Behavior:**
- Chained (multiple interceptors can run)
- Can transform (modify event)
- Can block (prevent propagation)
- Can observe (side effects)

**Operations:**
```typescript
registerInterceptor(context, eventType, handler) → void
emit(context, event) → Result           // Run through interceptors
intercept(event) → Event | null         // Transform or block
```

**Key Property:** Interceptors enable cross-cutting concerns without modifying core logic.

---

## ASCII Architecture Diagrams

### System 1: PyMono (Full Implementation)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PY-MONO ARCHITECTURE                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌───────────┐ │
│  │   User      │────▶│  Command    │────▶│  Extension  │────▶│  Event    │ │
│  │   Input     │     │  (Input)    │     │  Runner     │     │  Emitter  │ │
│  └─────────────┘     └─────────────┘     └─────────────┘     └─────┬─────┘ │
│         │                                                            │      │
│         │                    ┌──────────────────┐                    │      │
│         │                    │   INTERCEPTORS   │                    │      │
│         │                    │  ┌────────────┐  │                    │      │
│         │                    │  │ tool_call  │  │◀── Can block/modify│      │
│         │                    │  │ tool_result│  │                    │      │
│         │                    │  │ context    │  │◀── Transform msgs  │      │
│         │                    │  └────────────┘  │                    │      │
│         │                    └──────────────────┘                    │      │
│         │                                                            ▼      │
│         │                                                   ┌─────────────┐ │
│         │                                                   │   EVENT     │ │
│         │                                                   │   (Log)     │ │
│         │                                                   │  ┌───────┐  │ │
│         │                                                   │  │Message│  │ │
│         │                                                   │  │Custom │  │ │
│         │                                                   │  │Compact│  │ │
│         │                                                   │  │Branch │  │ │
│         │                                                   │  └───────┘  │ │
│         │                                                   └──────┬──────┘ │
│         │                                                          │       │
│         │                    ┌──────────────────┐                  │       │
│         │                    │  SESSION MANAGER │                  │       │
│         │                    │  ┌────────────┐  │                  │       │
│         │                    │  │append()    │  │◀── Write events  │       │
│         │                    │  │branch()    │  │◀── Switch branch │       │
│         │                    │  │getBranch() │  │──▶ Read events   │       │
│         │                    │  │leafId      │  │◀── Current ptr   │       │
│         │                    │  └────────────┘  │                  │       │
│         │                    └──────────────────┘                  │       │
│         │                                                          │       │
│         │                                                          ▼       │
│         │                                            ┌───────────────────┐ │
│         │                                            │   PROJECTION      │ │
│         │                                            │  ┌─────────────┐  │ │
│         │                                            │  │reconstruct  │  │ │
│         │                                            │  │State = f(   │  │ │
│         │                                            │  │  Events)     │  │ │
│         │                                            │  └─────────────┘  │ │
│         │                                            └─────────┬─────────┘ │
│         │                                                      │          │
│         │                                                      ▼          │
│         │                                            ┌───────────────────┐ │
│         └───────────────────────────────────────────▶│   DERIVED STATE   │ │
│                                                      │   (In-memory)     │ │
│                                                      │  ┌─────────────┐  │ │
│                                                      │  │ todos[]     │  │ │
│                                                      │  │ config{}    │  │ │
│                                                      │  │ cache       │  │ │
│                                                      │  └─────────────┘  │ │
│                                                      └───────────────────┘ │
│                                                                             │
│  KEY FEATURES:                                                              │
│  • Tree-structured log (parentId chain)                                     │
│  • Full interceptor chain (before/after tool execution)                     │
│  • Hot reload (reconstruct state from log)                                  │
│  • Branching (side quests, time travel)                                     │
│  • Extension system (dynamic tool registration)                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### System 2: Simple Event Store (Minimal Implementation)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SIMPLE EVENT STORE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌───────────┐ │
│  │   User      │────▶│   Command   │────▶│   Handler   │────▶│   Event   │ │
│  │   Action    │     │  (Validate) │     │  (Execute)  │     │  (Store)  │ │
│  └─────────────┘     └─────────────┘     └─────────────┘     └─────┬─────┘ │
│                                                                     │       │
│                                                                     ▼       │
│                                                            ┌─────────────┐  │
│                                                            │     LOG     │  │
│                                                            │  (Append-   │  │
│                                                            │   Only)     │  │
│                                                            │  ┌───────┐  │  │
│                                                            │  │Event 1│  │  │
│                                                            │  │Event 2│  │  │
│                                                            │  │Event 3│  │  │
│                                                            │  └───────┘  │  │
│                                                            └──────┬──────┘  │
│                                                                   │         │
│                                                                   ▼         │
│                                                        ┌─────────────────┐  │
│                                                        │   PROJECTION    │  │
│                                                        │  (Simple Fold)  │  │
│                                                        │  currentState = │  │
│                                                        │  events.reduce  │  │
│                                                        └────────┬────────┘  │
│                                                                 │           │
│                                                                 ▼           │
│                                                      ┌────────────────────┐ │
│                                                      │    DERIVED STATE   │ │
│                                                      │   ┌────────────┐   │ │
│                                                      │   │  count: 3  │   │ │
│                                                      │   │  items: [] │   │ │
│                                                      │   └────────────┘   │ │
│                                                      └────────────────────┘ │
│                                                                             │
│  SIMPLIFICATIONS:                                                           │
│  ✗ No tree structure (linear log only)                                      │
│  ✗ No branching (single timeline)                                           │
│  ✗ No interceptors (direct command→event)                                   │
│  ✗ No hot reload (state stored in memory, lost on restart)                  │
│  ✓ Still has: Event, Log, State, Projection                                 │
│                                                                             │
│  USE CASE: Simple audit logs, analytics, metrics                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### System 3: Git-Like Document Store (Branch-Heavy)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      GIT-LIKE DOCUMENT STORE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌───────────┐ │
│  │   User      │────▶│   Commit    │────▶│   Merge     │────▶│   Event   │ │
│  │   Edit      │     │  (Snapshot) │     │  (Resolve)  │     │  (Diff)   │ │
│  └─────────────┘     └─────────────┘     └─────────────┘     └─────┬─────┘ │
│         │                                                          │       │
│         │                    ┌──────────────────┐                  │       │
│         │                    │  BRANCH GRAPH    │                  │       │
│         │                    │                  │                  │       │
│         │                    │     main ──┐     │                  │       │
│         │                    │       │    │     │                  │       │
│         │                    │       ▼    ▼     │                  │       │
│         │                    │      A1 ◄──B1    │                  │       │
│         │                    │       │    │     │                  │       │
│         │                    │       ▼    ▼     │                  │       │
│         │                    │      A2    B2    │                  │       │
│         │                    │       │    │     │                  │       │
│         │                    │       ▼    └────┐│                  │       │
│         │                    │      A3 ◄───────┘│                  │       │
│         │                    │       │          │                  │       │
│         │                    │       ▼          │                  │       │
│         │                    │      A4 (leaf)   │                  │       │
│         │                    │                  │                  │       │
│         │                    └──────────────────┘                  │       │
│         │                                                          │       │
│         │                                                          ▼       │
│         │                                               ┌────────────────┐ │
│         │                                               │      LOG     │ │
│         │                                               │  (Merkle     │ │
│         │                                               │   Tree)      │ │
│         │                                               │  ┌────────┐  │ │
│         │                                               │  │Commit 1│  │ │
│         │                                               │  │Commit 2│  │ │
│         │                                               │  │Commit 3│  │ │
│         │                                               │  └────────┘  │ │
│         │                                               └──────┬───────┘ │
│         │                                                      │         │
│         │                    ┌──────────────────┐              │         │
│         │                    │  CHECKOUT/RESET  │              │         │
│         │                    │  ┌────────────┐  │              │         │
│         │                    │  │checkout()  │  │◀── Switch    │         │
│         │                    │  │reset()     │  │◀── Rewind    │         │
│         │                    │  │merge()     │  │◀── Combine   │         │
│         │                    │  └────────────┘  │              │         │
│         │                    └──────────────────┘              │         │
│         │                                                      ▼         │
│         │                                         ┌─────────────────────┐│
│         └────────────────────────────────────────▶│   WORKING TREE      ││
│                                                   │   (Derived State)   ││
│                                                   │  ┌───────────────┐  ││
│                                                   │  │ file.txt      │  ││
│                                                   │  │ doc.md        │  ││
│                                                   │  └───────────────┘  ││
│                                                   └─────────────────────┘│
│                                                                             │
│  DIFFERENCES FROM PY-MONO:                                                  │
│  • Commits store snapshots (not just events)                                │
│  • Merge operation exists (branches can rejoin)                             │
│  • Content-addressed (hash-based IDs)                                       │
│  • Working tree is explicit (not just in-memory cache)                      │
│  • No interceptor chain (no middleware)                                     │
│                                                                             │
│  USE CASE: Version control, collaborative editing, CMS                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Primitive Comparison Matrix

| Primitive | PyMono | Simple Event Store | Git-Like Store |
|-----------|--------|-------------------|----------------|
| **Event** | Rich types (message, custom, compaction, branch_summary) | Single type (action record) | Commit (snapshot + metadata) |
| **Log** | JSONL file, tree structure (parentId) | Array/DB table, linear | Merkle tree, content-addressed |
| **Branch** | Full tree, cheap branching | None (linear only) | Full DAG, merge support |
| **State** | Reconstructed from events | Folded from events | Working tree (explicit checkout) |
| **Context** | Extension context with UI | Simple query context | Working directory + index |
| **Command** | Tool calls with interceptors | Direct append | Commit + merge + rebase |
| **Interceptor** | Full chain (before/after/around) | None | Hooks (pre-commit, post-merge) |

---

## The Core Equation Across Systems

All three systems follow the same fundamental pattern:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   State(t) = Projection(Context(t), Branch(t), Log)         │
│                                                             │
│   Where:                                                    │
│   • Log = immutable append-only event sequence              │
│   • Branch(t) = pointer to position in log at time t        │
│   • Context(t) = frame of reference at time t               │
│   • Projection = pure function (events → state)             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**PyMono:** Context = extension runtime, Branch = leafId, Projection = reconstructState()

**Simple Store:** Context = query filter, Branch = always "latest", Projection = reduce()

**Git Store:** Context = working directory, Branch = HEAD, Projection = checkout/apply

---

## When to Use Which

| Use Case | Recommended System |
|----------|-------------------|
| AI agent with tool calling, hot reload, side quests | **PyMono** (full primitives) |
| Audit logs, event sourcing, metrics | **Simple Event Store** (Event + Log + State) |
| Version control, collaborative editing | **Git-Like Store** (Branch-heavy + merge) |
| Real-time collaboration (Figma, Notion) | **PyMono** (interceptors for sync) |
| Financial ledger, accounting | **Simple Event Store** (linear + immutable) |
| Game save system with branching | **PyMono** or **Git-Like** (time travel) |
