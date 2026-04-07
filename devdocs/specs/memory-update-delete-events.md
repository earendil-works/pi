# Specification: Memory Store Update/Delete Events

## Summary & Recommendation

**Problem:** Memory projections show duplicate/outdated entries because the system lacks update and delete event types. The current design only supports `create` operations, causing projections to accumulate stale entries.

**Recommendation:** Extend the artifact memory store to support three event types: `create`, `update`, and `delete`. The projection layer will respect these events to filter out superseded and deleted entries while maintaining the append-only ledger.

---

## What Must Be True

1. **Event types are explicit:** Every entry has an `event` field with values: `create`, `update`, or `delete`
2. **Target targeting:** `update` and `delete` events have a `targetId` field specifying which entry is affected
3. **Projection filters correctly:** The projection layer excludes:
   - Entries marked as deleted
   - Entries that are superseded by an update
4. **Ledger remains append-only:** No mutation of existing entries; events are appended as new entries
5. **Backward compatible:** Existing entries without `event` field are treated as `create` events
6. **Tool interface supports supersedes:** `memory_store` tool parameters include `supersedes` (current) and new `delete` field

---

## What Must Never Happen

1. **No mutation of existing entries:** The ledger must remain append-only
2. **No orphaned updates:** An `update`/`delete` event must reference a valid, existing `targetId` (validated at projection time, not write time)
3. **No circular references:** An entry cannot supersede itself, and chains must be resolvable
4. **No duplicate deletions:** A deleted entry cannot be deleted again (projection filters already-deleted entries)
5. **No resurrections:** A deleted entry cannot be updated (must create new entry)
6. **Projection must not fail:** Invalid/deleted entries are filtered gracefully; projection always returns valid state

---

## Inputs / Outputs

### Entry Schema (Extended)

```typescript
interface ArtifactMemoryEntry {
  id: string;                    // mem-UUID
  timestamp: string;             // ISO 8601
  event: "create" | "update" | "delete";  // NEW: defaults to "create" if missing
  kind: string;
  summary: string;
  workspaceRef: string;
  artifacts?: string[];
  sourceRefs?: string[];
  targetId?: string;             // NEW: for update/delete, the entry being affected
}
```

### Tool Parameters (memory_store)

```typescript
interface MemoryStoreParams {
  kind: string;
  summary: string;
  scope?: "workspace" | "global";
  workspaceRef?: string;
  artifacts?: string[];
  sourceRefs?: string[];
  supersedes?: string;  // EXISTING: creates an "update" event
  delete?: string;      // NEW: creates a "delete" event
}
```

### Projection Output

```typescript
interface WorkspaceProjection {
  workspaceRef: string;
  entries: ArtifactMemoryEntry[];      // Only active (non-deleted, non-superseded)
  startupItems: WorkspaceProjectionItem[];
  startupSummary: string;
  // NEW: metadata about filtering
  meta: {
    totalEntries: number;              // Total entries in ledger for this workspace
    activeEntries: number;             // Entries after filtering
    deletedCount: number;              // Number of deleted entries
    supersededCount: number;           // Number of superseded entries
  };
}
```

---

## Edge Cases

1. **Legacy entries without `event` field:** Treat as `create` events
2. **Update chain:** Entry A → B → C where B updates A, C updates B → projection shows only C
3. **Delete then update:** If A is deleted, then B attempts to update A → projection shows nothing (A is deleted, B is invalid)
4. **Update deleted entry:** If A is deleted, then C updates A → projection shows nothing (A is deleted, C targets deleted entry)
5. **Concurrent updates:** Entries B and C both update A → projection shows both B and C (unusual but valid)
6. **Self-reference:** Entry A attempts to update A → projection shows A (ignore self-reference)
7. **Circular reference:** A updates B, B updates A → projection shows both entries after the cycle (unresolvable)
8. **Missing targetId:** Update/delete event without targetId → treated as create event (graceful degradation)
9. **Invalid targetId:** Update/delete references non-existent entry → treated as create event
10. **Delete already-deleted:** Entry B deletes A, Entry C also deletes A → projection shows nothing (idempotent)
11. **Global scope deletion:** Global entry deleted from workspace context → projection filters globally

---

## Constraints

1. **Append-only ledger:** No mutation of existing entries; events are appended
2. **Idempotent projection:** Building the same projection twice yields the same result
3. **Performance:** Filtering should be O(n) where n is number of entries in workspace
4. **Storage efficiency:** Entry size increase should be minimal (2 new fields: `event` + `targetId`)
5. **No breaking changes:** Existing entries and tools must continue to work
6. **No database:** Continue using JSONL file format (append-friendly)
7. **No transaction support:** Entries are written one at a time; projection must handle incomplete states

---

## Definition of Done

### Verification Contract

#### 1. Unit Tests (Red → Green)

- **Test 1:** Create entry → update with `supersedes` → projection shows only updated entry
- **Test 2:** Create entry → delete with `delete` param → projection shows no entries
- **Test 3:** Create entry A, entry B updates A, entry C updates B → projection shows only C (update chain)
- **Test 4:** Multiple entries of same kind, only one updated → projection shows correct set
- **Test 5:** Legacy entry without `event` field → projection treats as `create`
- **Test 6:** Delete non-existent entry → projection unchanged (graceful)
- **Test 7:** Update deleted entry → projection shows nothing (deleted takes precedence)
- **Test 8:** Concurrent updates to same entry → projection shows both updates (valid)
- **Test 9:** Self-referential update → projection shows entry (ignore self-ref)
- **Test 10:** Circular update chain → projection shows both entries after cycle

#### 2. Integration Tests

- **Test 1:** `memory_store` with `supersedes` creates update event
- **Test 2:** `memory_store` with `delete` creates delete event
- **Test 3:** Background write processes events correctly
- **Test 4:** Projection rebuilds correctly after events

#### 3. Manual Verification

- **Step 1:** Create two similar entries in a workspace
- **Step 2:** Verify projection shows both entries
- **Step 3:** Update second entry with `supersedes: first.id`
- **Step 4:** Rebuild projection
- **Step 5:** Verify projection shows only second entry
- **Step 6:** Delete the entry
- **Step 7:** Verify projection shows no entries

#### 4. Snapshot Verification

- **Snapshot 1:** ai21 workspace projection before fix (shows duplicate workflow entries)
- **Snapshot 2:** ai21 workspace projection after fix (shows single consolidated entry)

---

## What Needs to Be Done

### 1. Schema Extension (packages/coding-agent/src/memory/store.ts)

**Thesis:** Add `event` and `targetId` fields to `ArtifactMemoryEntry` interface

```typescript
// Add to ArtifactMemoryEntry
event?: "create" | "update" | "delete";
targetId?: string;
```

**Verification:** Run existing tests → should pass (backward compatible)

### 2. Parsing Update (packages/coding-agent/src/memory/store.ts)

**Thesis:** Parse optional `event` and `targetId` fields from JSONL

```typescript
function parseArtifactMemoryEntry(line: string, lineNumber: number): ArtifactMemoryEntry {
  // ... existing parsing ...
  event: parseOptionalEvent(parsed.event, "event", lineNumber),
  targetId: parseOptionalString(parsed.targetId, "targetId", lineNumber),
}

function parseOptionalEvent(value: unknown, field: string, lineNumber: number): "create" | "update" | "delete" | undefined {
  if (value === undefined) return undefined;
  if (value === "create" || value === "update" || value === "delete") return value;
  throw new Error(`Invalid artifact memory entry on line ${lineNumber}: ${field} must be create, update, or delete`);
}
```

**Verification:** Create JSONL with new fields → parse → verify fields present

### 3. Write Path Update (packages/coding-agent/src/memory/background-write.ts)

**Thesis:** Background writer includes `event` and `targetId` when present

```typescript
// In BACKGROUND_WRITER_SCRIPT
const stored = {
  id: 'mem-' + crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  event: entry.event ?? 'create',  // NEW
  kind: entry.kind,
  summary: entry.summary,
  workspaceRef,
  artifacts: entry.artifacts,
  sourceRefs: entry.sourceRefs,
  targetId: entry.targetId,  // NEW
};
```

**Verification:** Store entry with `event` → read JSONL → verify event present

### 4. Tool Schema Update (packages/coding-agent/src/tools/memory-tools.ts)

**Thesis:** Add `delete` parameter to `memoryStoreSchema`

```typescript
const memoryStoreSchema = Type.Object({
  kind: Type.String({ minLength: 1 }),
  summary: Type.String({ minLength: 1 }),
  scope: Type.Optional(memoryScopeSchema),
  workspaceRef: Type.Optional(Type.String({ minLength: 1 })),
  artifacts: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  sourceRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  supersedes: Type.Optional(Type.String({ minLength: 1 })),
  delete: Type.Optional(Type.String({ minLength: 1 })),  // NEW
});
```

**Thesis:** Map `supersedes` to `update` event, `delete` to `delete` event

```typescript
execute: async (_toolCallId: string, args: MemoryStoreParams) => {
  // Determine event type
  let event: "create" | "update" | "delete" = "create";
  let targetId: string | undefined;

  if (args.delete) {
    event = "delete";
    targetId = args.delete;
  } else if (args.supersedes) {
    event = "update";
    targetId = args.supersedes;
  }

  const receipt = enqueueArtifactMemoryWrite({
    workspaceRef,
    entries: [{
      event,
      kind: args.kind,
      summary: args.summary,
      workspaceRef,
      artifacts: args.artifacts,
      sourceRefs: args.sourceRefs,
      targetId,
    }],
  });
  // ...
}
```

**Verification:** Call `memory_store` with `supersedes` → verify `event: "update"` in JSONL

### 5. Projection Filtering (packages/coding-agent/src/memory/projection.ts)

**Thesis:** Filter out deleted and superseded entries before building projection

```typescript
function filterActiveEntries(entries: ArtifactMemoryEntry[]): ArtifactMemoryEntry[] {
  // Track deleted/superseded entry IDs
  const deletedOrSuperseded = new Set<string>();

  // First pass: collect all deleted/superseded IDs
  for (const entry of entries) {
    if ((entry.event === "update" || entry.event === "delete") && entry.targetId) {
      deletedOrSuperseded.add(entry.targetId);
    }
  }

  // Second pass: filter to active entries
  return entries.filter(entry => {
    // Treat missing event as "create"
    const event = entry.event ?? "create";
    
    // Delete events don't appear in projection
    if (event === "delete") return false;
    
    // Superseded entries don't appear in projection
    if (deletedOrSuperseded.has(entry.id)) return false;
    
    return true;
  });
}

async buildWorkspaceProjection(workspaceRef: string): Promise<WorkspaceProjection> {
  const resolvedWorkspaceRef = normalizeArtifactMemoryWorkspaceRef(workspaceRef);
  const allEntries = readArtifactMemoryEntries(this.baseDir).filter(
    (entry) => entry.workspaceRef === resolvedWorkspaceRef,
  );

  // NEW: Filter to active entries
  const activeEntries = filterActiveEntries(allEntries);

  const projection: WorkspaceProjection = {
    workspaceRef: resolvedWorkspaceRef,
    entries: activeEntries,
    startupItems: buildStartupItems(activeEntries),
    startupSummary: summarizeEntries(activeEntries),
    meta: {
      totalEntries: allEntries.length,
      activeEntries: activeEntries.length,
      deletedCount: allEntries.filter(e => e.event === "delete").length,
      supersededCount: deletedOrSuperseded.size,
    },
  };
  // ...
}
```

**Verification:** Create update chain → rebuild projection → verify only latest appears

### 6. Documentation Update (packages/coding-agent/src/prompts/tools.yaml)

**Thesis:** Document `supersedes` and `delete` parameters in `memory_store` description

```yaml
memory_store: |
  Store an explicit durable memory entry in the append-only artifact memory store.

  Use this when the user explicitly asks to save, store, or remember something durable.

  Scope semantics:
  - omit `scope` to store in the current workspace
  - use `scope: "workspace"` with optional `workspaceRef` to target a specific workspace
  - use `scope: "global"` to store a global memory entry not tied to one workspace

  Update semantics:
  - use `supersedes: "<entryId>"` to update an existing entry (creates an "update" event)
  - use `delete: "<entryId>"` to mark an entry as deleted (creates a "delete" event)

  Note: writes are backgrounded. Queue the write and continue; the agent does not need to wait for completion.
```

**Verification:** Read tool description → verify documentation present

### 7. Migration Script (Optional)

**Thesis:** Provide a script to migrate existing entries to explicit `event: "create"`

```bash
# Optional: migrate existing entries to add explicit event field
# This is NOT required as missing event defaults to "create"
```

**Verification:** Run migration → verify entries have `event: "create"`

---

## Architecture Notes

### Abstractions

1. **Event Sourcing:** Treat each entry as an immutable event, not mutable state
2. **Projection as View:** The projection is a derived view, not the source of truth
3. **Graceful Degradation:** Invalid references don't break projection; they're filtered out

### Tradeoffs

1. **Append-only vs. Mutation:** Chose append-only for audit trail and simplicity
2. **Explicit event vs. Implicit:** Chose explicit `event` field for clarity and extensibility
3. **Projection-time filtering vs. Write-time validation:** Chose projection-time for performance (no reads during write)
4. **Single targetId vs. Multiple:** Chose single for simplicity; multiple updates use multiple update events

### Boundaries

1. **Memory Store:** Responsible for appending events to ledger
2. **Projection:** Responsible for filtering and summarizing active entries
3. **Tools:** Responsible for mapping user intent to event type
4. **Background Writer:** Responsible for async persistence (unchanged)

---

## Open Questions

1. **Q:** Should we support updating a deleted entry?
   - **A:** No. Create a new entry instead. Deleted entries stay deleted.

2. **Q:** Should we validate `targetId` at write time?
   - **A:** No. Validation happens at projection time for performance (no reads during write).

3. **Q:** Should we support batch updates/deletes?
   - **A:** Not in v1. Multiple updates can be sent as separate events.

4. **Q:** Should we expose the full event history in a separate API?
   - **A:** Not in v1. The ledger is accessible via file system if needed.

5. **Q:** Should we add `event` to `ArtifactMemoryEntryInput`?
   - **A:** Yes. The input interface should match the stored schema.
