# Scoped storage Step 1 — actionable implementation handoff

**Status: actionable, not implemented.**

**Prepared against:** `c4b0e35ab` (`dev`). Re-audit named source files if the implementation baseline changes materially.

This handoff implements storage scopes only. **Read this file before [`scopes.md`](scopes.md).** It supersedes conflicting details there, especially per-scope sequence spaces, operation-derived orphan detection, one-use scope IDs, raw-string scope arguments, sidecars ending in `.jsonl`, the proposed interned retirement tuple, and bundling JSONL delta/address encoding into the same change. The broader motivation and measurements in `scopes.md` remain design evidence; its signatures and implementation order are not current where this file differs.

Step 2—Chord-encoded JSONL values, address interning, compact tuple records, and their measurements—is a separate package. Do not begin Step 2 until Step 1 has been tested, reviewed, explicitly approved by the user, committed, and pushed.

## 0. Delivery protocol

This package has a mandatory user checkpoint:

1. Implement Step 1 only.
2. Run every required focused test, `npm run check`, and `./test.sh`.
3. Review the complete diff and report results. Delegated reviews, if used, run with provider `anthropic` and model `claude-fable-5`.
4. **Stop and wait for explicit user approval.**
5. After approval, commit only this package's files and push that commit.
6. Confirm the pushed commit before designing or implementing Step 2.

Do not combine the Step 1 and Step 2 commits. Do not commit or push before approval.

## 1. Mandatory reading

Read completely before editing:

1. `packages/agent/docs/harness.md` §§0.2–0.9, 1.1–1.7, 2.7–2.8, 3.7–3.8, 3.13, 4.4–4.8, 5.4, Part 7, Part 9.
2. `packages/agent/docs/values.md`.
3. `packages/agent/docs/mobile-handoff/README.md`.
4. [`scopes.md`](scopes.md), using this handoff where they conflict.
5. `../01-delta/delta.md` for vocabulary ownership only; Step 1 does not store Chord ops.
6. `../04-tool-output/harness-tools.md` §§7.1–7.7 for later-consumer context; do not implement its output redesign here.
7. `../05-assistant-output/message-update.md` §7 for later-consumer context; do not implement it here.
8. `packages/agent/src/harness/session/{types,values,commit,in-memory-storage-state,memory,session,index}.ts`.
9. Every file under `packages/agent/src/harness/session/jsonl/` and the `FileSystem` declaration/implementation in `packages/agent/src/harness/{types,env/nodejs}.ts`.
10. `packages/agent/src/harness/runtime/{progress,lane}.ts`, `runtime/drive/{terminal,response,deferred,tools,reconcile,structural,boundary}.ts`, and every caller of `operationCleanupWrites`. Inspect `tool-placement.ts` through the grep audit, but current source has no scoped delete there.
11. `packages/session-backends/sqlite-node/src/{index,sqlite/index}.ts`, `sqlite/{storage,repo}.ts`, `migrations/001_initial.sql`, and `session/{values,session-sequences}.ts`.
12. Shared storage/repository conformance and every focused test named in §9.
13. `scopes.variance.ts` for the covariant-address/invariant-write phantom mechanism only. Its current no-ID `EphemeralScope` and `retireScope(id: string)` signatures are superseded by §2 and must be updated in Slice A.

Do not use `dist/` as implementation input. Format 4 remains WIP; no R11 migration is part of this package.

## 2. Fixed scope contract

### 2.1 Runtime scope identity

A scope ID is a reusable logical lifetime name, not a globally one-use token:

```ts
export type SessionScope = { readonly kind: "session" };

export interface EphemeralScope {
	readonly kind: "ephemeral";
	readonly id: string;
}

export type Scope = SessionScope | EphemeralScope;

export function ephemeralScope(id: string): EphemeralScope;
```

`ephemeralScope(id)` requires a non-empty well-formed Unicode string and returns a frozen value. Equal IDs identify the same physical scope; object identity has no meaning. JSONL encodes IDs with `encodeURIComponent`. The encoded component must be at most 180 ASCII characters; reject longer IDs and lone-surrogate input. The physical filename always has a fixed `scope-` prefix, so encoded `.`/`..` values cannot become path segments. Do not directly interpolate unencoded caller input into a path.

No create/open-scope transaction exists. The first scoped value/list write creates physical state. A later `retireScope(scope)` ends everything in that scope through its assigned global sequence. A write under the same ID after retirement begins a new logical lifetime.

Harness operation scopes use `ephemeralScope(operationId)`. Generic application scopes may use stable names. Storage never parses a scope ID as an operation ID and never reads Harness operation state to decide lifetime.

### 2.2 Reuse and retirement boundary

Global sequence order defines reusable generations:

```text
seq 10  scoped write S
seq 20  scoped write S
seq 30  retireScope(S)
seq 40  scoped write S       # new lifetime
```

For a given scope ID, only scoped records with `seq` greater than its latest committed retirement sequence are live. Memory and SQLite realize this by deleting current rows/maps at retirement and allowing later writes to recreate them. JSONL uses the retirement sequence as its replay boundary (§6).

Retirement is idempotent in the storage sense: retiring a scope with no current state is legal and advances the boundary. A later write still begins a new lifetime. Storage does not maintain an all-time used-ID registry or reject reuse.

A scoped write reaching the commit line after retirement is therefore a new-lifetime write. Harness invocation fencing and settlement drains must continue to ensure a late assistant/tool progress job cannot recreate operation output after terminal retirement. Add explicit tests for this boundary.

### 2.3 Explicit retirement is the sole authority

```ts
export function retireScope(scope: EphemeralScope): Write<SessionScope>;
```

Storage never infers orphanage from operation absence, namespace, current state, or a missing owner. The only valid lifetime boundary is a committed `retireScope` write. If an owner never retires its scope, that is an owner defect and the scope remains live.

Crash behavior:

- crash before the retirement transaction commits: the scope remains live and reopens;
- crash after retirement commits but before JSONL unlink: replay sees the retirement boundary, ignores pre-boundary sidecar records, and retries physical deletion;
- crash during a later reused lifetime: records after the latest retirement reopen normally.

Repository deletion separately removes every physical sidecar belonging to the deleted Session. It does not need operation semantics.

### 2.4 Address and write typing

Addresses carry a covariant scope tag; writes carry an invariant scope tag. Preserve value-type invariance independently:

```ts
interface Value<T, Sc extends Scope = SessionScope> { /* existing fields + scope */ }
interface ValueList<T, Sc extends Scope = SessionScope> { /* existing fields + scope */ }

declare function value<T>(namespace: string, key?: string): Value<T, SessionScope>;
declare function value<T>(namespace: string, key: string, scope: EphemeralScope): Value<T, EphemeralScope>;
declare function list<T>(namespace: string, key?: string): ValueList<T, SessionScope>;
declare function list<T>(namespace: string, key: string, scope: EphemeralScope): ValueList<T, EphemeralScope>;
```

A session-scoped address has no runtime scope ID. An ephemeral address carries its scope ID. Scope is part of physical identity: equal namespace/key addresses in session scope and ephemeral scope, or in two different ephemeral IDs, are distinct.

`setValue`, `deleteValue`, `appendList`, and `deleteList` preserve the address scope in `Write<Sc>`. Entry and usage writes are session-scoped. `retireScope` is session-scoped even though applying it deletes ephemeral state.

All writes in an ordinary transaction have one static scope. A session transaction may include session values, entries, usage, and one or more `retireScope` writes. It may not include a direct ephemeral set/delete/append. An ephemeral transaction may include value/list writes only. At runtime, every ephemeral write in one transaction must carry the same scope ID; two different IDs have the same TypeScript tag and require this assertion.

Make the minimum generic changes necessary to preserve this through `Write`, `CommittedWrite`, `Storage.commit`, Session mutation capabilities, `CommitDecision`, and lane commands. Follow the variance proof in `scopes.variance.ts`; do not make readers invariant or propagate unnecessary scope type parameters through read-only APIs.

### 2.5 One global sequence space

Memory, JSONL main records, JSONL sidecar records, and SQLite rows share one Session-global sequence space. Every admitted commit remains serialized and receives increasing sequences in admission order. Gaps remain legal.

- Memory continues using one `nextSeq`.
- SQLite continues allocating from `sessions.next_seq` inside the write transaction.
- JSONL main and sidecar appends share one commit queue and one resident `nextSeq`.

JSONL open computes the high-water mark from the main header and every complete record in every matching sidecar **before** deleting or ignoring retired physical files. A retired sidecar's sequences may then become gaps but can never be reused. Torn uncommitted final transactions do not advance the durable high-water mark.

No reservation record, per-scope sequence counter, or range allocator is permitted.

## 3. List tags

Step 1 adds only the mechanism required by later tracked-output recovery:

```ts
export interface ListElement<T> {
	seq: number;
	value: T;
	tag?: string;
}

export interface ListReadOptions {
	cursor?: ListCursor;
	order?: "asc" | "desc";
	limit?: number;
	stopAtTag?: string;
}

export function appendList<T, Sc extends Scope>(
	address: ValueList<T, Sc>,
	element: NoInfer<T>,
	tag?: string,
): ListAppendWrite<Sc>;
```

Tags are non-empty strings when present. Storage stores and returns the tag without interpreting the element.

Read semantics:

1. Apply address scope, exclusive cursor, and order.
2. Inspect at most the normalized `limit` elements.
3. Stop at and include the first element carrying `stopAtTag`.
4. Return that possibly shortened page.

`stopAtTag` never searches beyond the page limit. If absent from the page, the caller pages again from the last returned sequence. Do **not** add the draft `tag` filter; no current consumer needs it and combining filtering with the existing cursor shape is ambiguous.

SQLite may fetch the indexed `limit` rows and truncate at the first returned tag in TypeScript; storage still never parses payloads. Preserve the existing primary-key query plan with no temporary sort.

## 4. Step 1 durable payloads remain unchanged

This package changes lifetime and routing, not output representation:

- `pendingToolOutput` remains `Value<AgentToolResult<unknown>, EphemeralScope>`;
- `pendingAssistantFrames` remains `ValueList<AssistantMessageFrame, EphemeralScope>`;
- `operationToolMemo` remains a `JsonValue` scalar;
- JSONL transaction records remain readable keyed objects;
- assistant progress still appends one frame per accepted frame;
- tool checkpoints still replace whole snapshots;
- `message_update` and `tool_update` event shapes do not change;
- safe replay retains its current checkpoint behavior, including the known delete-before-replay bug owned by the later tool-output package.

Do not rename `pendingAssistantFrames`, introduce `pendingAssistantOutput`, store `WireOp[]`, add Chord trackers/codecs, redesign `AgentHarnessTool`, or change output cadence here.

## 5. Runtime ownership and cleanup

### 5.1 Addresses moved to the operation scope

Construct these addresses with `ephemeralScope(operationId)`:

- `operationToolMemo(operationId, invocationId, name)`;
- `pendingToolOutput(operationId, invocationId)`;
- `pendingAssistantFrames(operationId, responseEntryId)`.

All other current built-ins remain session-scoped. In particular, `pi.op.state`, `pi.op.meta`, `pi.op.tool_args`, `pi.op.preparation`, and `pi.pending.entry` remain in the main scope because their writes coordinate atomically with lane/operation state.

### 5.2 No cross-file cleanup transaction

Remove direct ephemeral deletes from transactions that also write session state:

- assistant response settlement;
- deferred-response supersession;
- tool outcome staging in `drive/tools.ts`;
- cancellation/recovery decisions;
- terminal per-address cleanup.

Current `drive/tool-placement.ts` has no ephemeral delete; do not invent a change there.

`operationCleanupWrites` stops scanning tool memos and tool outputs and stops constructing a state-directed assistant-frame delete. It keeps session-scoped operation/meta/args/preparation/pending-entry cleanup and adds exactly one `retireScope(ephemeralScope(operationId))` in the universal terminal suffix.

After removing the current staging/terminal scans, remove `operationToolMemoPrefix` and `pendingToolOutputPrefix`; current source has no other production consumers. Update the normative exported prefix-constructor count from five to three and update exact constructor tests rather than retaining dead inventory APIs.

An ephemeral-only delete remains legal. For example, the current safe-replay checkpoint delete remains because its transaction contains no session write; fixing its behavior belongs to the later tool-output package, not scoped storage or JSONL optimization.

### 5.3 Unreachable scoped residue

After a response settles, a deferred response is superseded, or a tool reaches `outcome_ready`, its former frames/checkpoints/memos may remain physically and logically addressable inside the still-active operation scope. Current scalar operation state no longer references them; no recovery or snapshot path scans the scope to infer authority. The terminal retirement deletes the whole scope.

Call this **unreachable scoped residue**, not orphanage. Update `harness.md` invariants that currently require an `outcome_ready` call to have no physically present memo/checkpoint. The replacement invariant is that settled child state never consumes or exposes residue and terminal retirement removes all scoped state atomically with operation completion.

Close and fault are controlled crashes and never retire the scope. Reopen restores scoped progress only through addresses derived from current authoritative operation state.

## 6. JSONL sidecars

### 6.1 Physical layout

The main session file remains unchanged except for committed scope-retirement records. Every main file owns one known sidecar directory at `${mainPath}.scopes`; this requires no dirname API or `FileSystem` extension. Create it lazily with `createDir(..., { recursive: true })`. Discover scopes with `listDir` on that exact path. A sidecar filename is exactly `scope-${encodeURIComponent(scope.id)}.scope`, subject to §2.1's 180-character encoded-component limit. The suffix does not end in `.jsonl`, and the sidecar directory itself is a directory, so repository listing never mistakes either for a Session.

A sidecar begins with this exact header:

```ts
interface JsonlScopeHeader {
	v: 4;
	kind: "scope_header";
	sessionId: string;
	scopeId: string;
	storageVersion: 1;
}
```

Validate the exact session/scope identity before replay. Create the first header through a temp file inside `${mainPath}.scopes` plus atomic rename. Temporary filenames end in `.tmp` and are never discovered as sidecars. Use the existing `FileSystem` capability; do not add a dirname method, extend `JsonlStorageOptions`, or add Node-only filesystem access to agent core.

Step 1 sidecar writes retain the current object record spelling and carry/validate their scope ID in committed shapes. Each physical transaction remains one complete line or one array line. Sidecar transactions may contain only value/list writes for that exact scope.

### 6.2 Retirement record

The main log records an explicit committed write:

```ts
interface CommittedScopeRetireWrite {
	kind: "scope";
	op: "retire";
	seq: number;
	scopeId: string;
}
```

Its Step 1 JSON representation is the corresponding readable object. Do not use the draft `['!', addrId, seq]`: a scope is not an interned value/list address. Compact tuple spelling belongs to Step 2 and must be designed there.

Applying a committed retirement removes resident values/lists in that scope. After the complete main transaction is durable, JSONL synchronously serializes lifecycle cleanup on the same commit queue: close any owned sidecar resource, attempt unlink, then release the queue. Failure to unlink is non-fatal to the already-committed business transaction; the sidecar remains logically bounded by the retirement sequence and deletion is retried on reopen.

### 6.3 Replay and reusable IDs

Open performs these logical stages before admitting writes:

1. Read/repair the main file and parse complete main transactions.
2. Discover and validate matching sidecars; ignore unrelated files.
3. Parse complete sidecar transactions and repair torn final transactions.
4. Compute the global sequence high-water mark from the header and **all** complete main/sidecar records, including records later excluded by retirement.
5. Determine the latest retirement sequence per scope from main transactions.
6. Keep sidecar writes whose sequence is greater than that scope's latest retirement.
7. Merge retained main and sidecar transactions by global sequence and replay them in global order, preserving transaction boundaries and rejecting duplicate/non-monotonic sequences.
8. Advance to the precomputed high-water mark.
9. Remove sidecars with no records after their latest retirement; cleanup failure does not make retired contents live.

Main transactions have sequence gaps where sidecar transactions occurred. Sidecars have gaps where other scopes/main commits occurred. Both remain valid.

A sidecar containing records after a retirement is an active reused lifetime and must not be deleted. Serialize retirement cleanup against later writes so an old unlink cannot race and remove a newly reused sidecar.

Malformed interior records or identity mismatch in an active sidecar are storage corruption and fail open. A torn final transaction is discarded wholly. Temporary files left by interrupted atomic creation are cleanup artifacts and never become sidecars.

### 6.4 Legacy v3

Legacy v3 has no scopes. An ordinary Harness operation commits session-scoped acceptance before any progress write, so it upgrades first in the normal path. Still define and test the generic storage behavior when the first caller write is ephemeral: complete the existing v3-to-v4 main rewrite/usage adjustment under the global commit queue, then commit the scoped transaction without placing it in the main file. A crash before the sidecar append leaves no committed caller transaction and may reuse its uncommitted sequence.

### 6.5 Repository and fork behavior

- Repository `list()` ignores `${mainPath}.scopes` directories and their files through its existing non-file/`.jsonl` filtering.
- Repository `delete()` removes the main file through its current path, then removes `${mainPath}.scopes` recursively with `force: true`; a scope-directory cleanup failure rejects deletion after the main-file result is known, without inferring Harness state. Missing scope directories are legal.
- `JsonlStorage.close()` drains its admitted main/sidecar commits as today; `JsonlSessionRepo.close()` retains its current lifecycle behavior because repository ownership is a separate package. No progress scope is retired merely because a handle closes.
- Preserve the current fork allowlist exactly. Do not add generic application values or lists to either fork scope. Ensure source snapshots and backend fork readers ignore all ephemeral values/lists regardless of namespace; current destinations remain logically unchanged except that ephemeral state cannot leak.
- Fork destinations contain no sidecars or retirement state.
- WP08 may later replace fork materialization but must preserve this scope policy.

J1 compaction is excluded. When J1 eventually lands, it may omit a historical retirement record only after no physical sidecar can be made live by losing that boundary.

## 7. Memory backend

Extend `InMemoryStorageState` physical value/list identity with scope. Session scope and each ephemeral ID are distinct. Preserve one global `nextSeq` and current stats behavior.

Applying `CommittedScopeRetireWrite` deletes every scalar/list in that scope in the same synchronous application of the surrounding transaction. It does not delete entries or usage, which cannot be ephemeral. A later scoped write recreates state under the same ID.

Snapshots expose scope so fork code can reject ephemeral state, but `createForkSnapshot` keeps its current built-in allowlist and must not start copying generic session-scoped application values or lists. Instrumentation must still report exact committed write order, including retirement.

## 8. SQLite backend

Change WIP schema in place with no migration:

```sql
scalar_values(
  session_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(session_id, scope_id, namespace, key)
) WITHOUT ROWID;

list_values(
  session_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  value TEXT NOT NULL,
  tag TEXT,
  PRIMARY KEY(session_id, scope_id, namespace, key, seq)
) WITHOUT ROWID;
```

Use `scope_id = ''` for session scope and the exact scope ID otherwise. Every point read, prefix scan, set/delete, append/delete, snapshot, and query-plan assertion includes scope identity.

Inside the same `BEGIN IMMEDIATE` transaction, a retirement write executes:

```sql
DELETE FROM scalar_values WHERE session_id = ? AND scope_id = ?;
DELETE FROM list_values   WHERE session_id = ? AND scope_id = ?;
```

It still consumes its assigned global sequence through `sessions.next_seq`, even though no retired-scope tombstone row remains. A later write under that ID recreates rows naturally. Retirement rollback must restore both scoped rows and all sibling main writes.

Fork paths copy only `scope_id = ''`. Shared-container deletion remains Session-scoped and removes all values/lists regardless of scope along with the other Session rows.

## 9. Required tests

Port tests before or with each implementation slice. Use the repository Vitest binary from the owning package. Do not run the full Vitest suite directly.

### 9.1 Type and constructor tests

- Session addresses default to `SessionScope`.
- Ephemeral overloads retain `EphemeralScope` while preserving invariant `T`.
- Address scope is covariant for reads; write scope is invariant.
- Same-scope session transactions typecheck.
- Same-scope ephemeral transactions typecheck.
- Session writes plus `retireScope` typecheck.
- Direct session + ephemeral writes in one transaction fail with `@ts-expect-error`.
- Two ephemeral IDs evade static distinction but fail the runtime same-ID assertion.
- Scope object identity is irrelevant; equal IDs access the same state.
- Empty and overlong encoded IDs reject; separators/Unicode encode without path escape.
- Session and ephemeral addresses with equal namespace/key do not alias.

### 9.2 Shared backend conformance

Run identically on Memory, JSONL, and SQLite:

- ephemeral scalar set/get/replace/delete;
- ephemeral list append/page/whole-list-delete;
- independent scopes with equal namespace/key;
- session scope independent from equal ephemeral address;
- mixed session/ephemeral transaction rejection before mutation;
- two ephemeral IDs in one transaction rejection before mutation;
- retirement deletes every value/list in the exact scope and no other scope;
- retirement atomic with session sibling writes;
- retirement of absent state is legal;
- write after retirement recreates a new lifetime;
- repeated retirement advances the boundary without making later writes disappear;
- main, scope A, scope B, retirement, and reused-A commits receive globally increasing sequences in admission order;
- retired/deleted physical elements leave legal gaps and first post-reopen commit allocates above every complete prior record;
- list tags round-trip, page limits remain bounded, and ascending/descending `stopAtTag` includes the marker;
- stats ignore scoped values/lists and retirement;
- close drains admitted scoped commits and rejects later reads/writes.

### 9.3 JSONL focused tests

- first scoped write creates exactly one valid sidecar and no main value/list record;
- several writes in one scoped transaction remain one physical sidecar line;
- main and multiple sidecars replay in global sequence order;
- header `nextSeq` and all complete sidecar records contribute to reopen high-water;
- torn sidecar final transaction is discarded wholly and repaired;
- malformed interior active sidecar and header identity mismatch fail open;
- crash before retirement leaves scoped data live;
- crash after main retirement but before unlink leaves data logically absent and cleanup retries;
- unlink failure does not reject the already-committed terminal transaction;
- reuse after retirement replays only records after the latest retirement sequence;
- multiple retirement/reuse cycles choose the latest boundary;
- retirement cleanup is serialized so a later reuse cannot be deleted by an earlier unlink;
- ignored pre-boundary records still prevent sequence reuse;
- sidecars and temp files never appear in repository listing;
- repository deletion removes all sidecars;
- forks exclude generic application-owned ephemeral values/lists;
- legacy-v3 first session write and first scoped-write paths both produce valid v4 state;
- close/reopen preserves active operation progress and does not retire it.

### 9.4 SQLite focused tests

- schema and query helpers include `scope_id`; list rows preserve nullable tags;
- one transaction atomically deletes scoped scalar/list rows and writes terminal main state;
- forced failure after scope deletion rolls back deletion and sibling writes;
- reuse after retirement recreates rows under the same scope ID;
- `sessions.next_seq` advances for retirement;
- list paging plan still uses the scoped primary key with no temp b-tree;
- both per-file and shared-container layouts isolate Session and scope IDs;
- fork and Session deletion exclude/remove scoped rows correctly.

### 9.5 Harness integration

Update existing exact-write tests rather than weakening them:

- assistant/deferred settlement drops mixed-scope frame deletes;
- tool outcome staging drops mixed-scope checkpoint/memo deletes;
- unreachable residue is never consumed by snapshot/recovery after its owning child settles;
- safe-replay's current ephemeral-only delete remains ordered and fenced;
- every terminal leaf emits one retirement in the documented cleanup position;
- close/fault emits no retirement and reopen recovers current frames/checkpoint/memos;
- cancellation and unknown-outcome recovery retire only at terminal completion;
- late queued assistant/tool progress cannot commit after terminal retirement or reopen the scope;
- terminal cleanup no longer scans memo/output prefixes;
- every focused test and fixture found by the §12 old-delete/prefix greps is updated deliberately; do not rely on a historical numeric test count;
- every terminal path reached through `operationCleanupWrites` callers in `drive/{response,reconcile,structural,boundary}.ts` is covered, including each operation family and cancellation.

Likely focused files include:

```text
packages/agent/test/harness/values.test.ts
packages/agent/test/harness/{memory,jsonl}-storage*.test.ts
packages/agent/test/harness/{memory,jsonl}-session-repo*.test.ts
packages/agent/test/harness/runtime/drive-{terminal,retry-deferred,tools,reconcile,generation}.test.ts
packages/session-backends/sqlite-node/test/{storage,storage-conformance,repo,repo-conformance}.test.ts
```

Use compiler and grep guards to find additional affected tests rather than assuming this list is exhaustive.

## 10. Implementation slices

### Slice A — contract, types, Memory reference, list tags

Primary files:

```text
CREATE packages/agent/src/harness/session/scope.ts for `SessionScope`, `EphemeralScope`, `Scope`, `ephemeralScope`, scope phantoms/helpers, and runtime scope-ID validation
MODIFY packages/agent/src/harness/session/{types,values,commit,in-memory-storage-state,memory,session,index}.ts
MODIFY packages/agent/src/harness/session/testing/{conformance/storage,instrumented-storage,storage-decorator,gating-storage}.ts
MODIFY packages/agent/test/harness/{values,memory-conformance,memory-storage,storage-backed-session}.test.ts
MODIFY packages/agent/docs/mobile-handoff/01-harness/02-scopes/scopes.variance.ts
```

1. Add scope values/address/write variance and reusable-ID semantics.
2. Add retirement committed write and one-scope transaction validation.
3. Add tag/`stopAtTag` behavior.
4. Implement Memory physical identity, retirement, global sequences, snapshots.
5. Pass type tests and Memory conformance before continuing.

### Slice B — SQLite

Primary files:

```text
MODIFY packages/session-backends/sqlite-node/src/sqlite/migrations/001_initial.sql
MODIFY packages/session-backends/sqlite-node/src/sqlite/{storage,repo}.ts
MODIFY packages/session-backends/sqlite-node/src/sqlite/session/{values,session-sequences}.ts
MODIFY packages/session-backends/sqlite-node/test/{storage,storage-conformance,repo,repo-conformance}.test.ts
```

1. Add scoped schema/query identity and tags.
2. Implement atomic `DELETE ... WHERE scope_id` retirement.
3. Preserve global sequence allocation, stats, branch indexes, shared-container behavior.
4. Exclude ephemeral rows from forks.
5. Pass SQLite focused/conformance tests before continuing.

### Slice C — JSONL sidecars

Primary files:

```text
CREATE packages/agent/src/harness/session/jsonl/scope-files.ts for fixed directory/file naming, exact header parsing/serialization, discovery, atomic first creation, torn-tail parsing/repair, and recursive cleanup helpers
MODIFY packages/agent/src/harness/session/jsonl/{types,codec,storage,repo,legacy-v3,index}.ts
MODIFY packages/agent/test/harness/jsonl-{storage,storage-conformance,session-repo,session-repo-conformance,v3-migration}.test.ts
```

1. Add sidecar naming/header/create/discovery.
2. Route scoped commits to sidecars while allocating globally.
3. Persist main retirement records and serialized unlink.
4. Implement multi-file high-water calculation and globally ordered replay with reusable boundaries.
5. Handle torn tails, corruption, v3, listing, delete, close, and forks.
6. Pass all JSONL tests before runtime migration.

### Slice D — Harness migration

Primary files:

```text
MODIFY packages/agent/src/harness/session/values.ts
MODIFY packages/agent/src/harness/runtime/{progress,lane}.ts to propagate scoped write generics through progress channels and lane commands
MODIFY packages/agent/src/harness/runtime/drive/{terminal,response,deferred,tools,reconcile,structural,boundary}.ts
INSPECT packages/agent/src/harness/runtime/drive/tool-placement.ts; current source needs no scoped cleanup change
MODIFY all focused runtime tests found by the §12 greps
```

1. Scope memo/tool/frame addresses by operation ID.
2. Remove mixed-scope deletes and cleanup scans.
3. Add terminal retirement in the universal suffix.
4. Preserve current output/replay/event behavior.
5. Prove late-write fencing and every terminal/close/recovery path.

### Slice E — documentation and final validation

Update current normative/reference docs:

```text
packages/agent/docs/harness.md
packages/agent/docs/values.md
packages/agent/docs/post-wp05-roadmap.md
packages/agent/docs/mobile-handoff/README.md
packages/agent/docs/mobile-handoff/01-harness/02-scopes/scopes.md
packages/session-backends/sqlite-node/README.md
packages/agent/src/harness/telemetry.ts and generated `packages/agent/docs/telemetry-schema.md`: add the `scope` session-write item kind without implementing spans
```

Do not rewrite historical WP00–WP07 handoffs or released changelog sections. On `dev`, do not add changelog entries under the repository's main-only rule.

Run:

```bash
npm run check
./test.sh
```

Also run every modified focused test after each slice. Record full command results for the approval checkpoint.

## 11. Exclusions

Do not include:

- Chord `Op`/`WireOp` storage integration;
- JSONL address/path interning or compact tuple records;
- pending-output address renames;
- `ToolOutput`, tool API changes, replay seeding, memo/checkpoint atomicity, progress cadence, rate limiting, exec-env changes;
- compact `message_update`, assistant incremental reducer changes, or protocol replication changes;
- J1 main-log snapshot compaction;
- WP08 fork redesign beyond excluding ephemeral state from current forks;
- repository lifecycle contract changes;
- telemetry implementation beyond keeping the declared schema accurate for the new write kind;
- migrations or compatibility for older WIP format-4 SQLite schemas;
- application-level automatic scope ownership, operation-derived orphan inference, leases, TTLs, or background scope collection.

If implementation requires an excluded item, stop and revise this handoff before expanding scope.

## 12. Grep guards

Before final review, inspect every remaining match:

```text
operationToolMemoPrefix
pendingToolOutputPrefix
deleteList(pendingAssistantFrames
deleteValue(pendingToolOutput
scopeId
retireScope
stopAtTag
```

Expected outcomes:

- no session-scoped transaction directly deletes an ephemeral address;
- no terminal path omits retirement;
- no backend point read/write omits scope identity;
- no fork copies ephemeral state;
- no JSONL sidecar is treated as a Session file;
- no per-scope sequence counter exists;
- no operation-state/orphan inference exists in storage.

## 13. Exit condition

Step 1 is implementation-complete when:

- scope/address/write typing rejects mixed-scope transactions and runtime validation rejects two ephemeral IDs in one transaction;
- IDs are reusable through latest-retirement global sequence boundaries with no historical ID registry;
- Memory, JSONL, and SQLite share one global sequence space and pass common conformance;
- SQLite retirement deletes exact scoped rows atomically with terminal state;
- JSONL writes ephemeral values/lists only to sidecars, records retirement only in the main log, replays all files in global order, preserves high-water marks, and deletes retired sidecars without operation inference;
- list tags and bounded `stopAtTag` work identically across backends;
- current tool/assistant payload and event formats are unchanged;
- every terminal path retires once, while close/fault preserves active scope recovery;
- forks and repository listing/deletion handle sidecars correctly;
- focused tests, `npm run check`, and `./test.sh` pass;
- final review has no blocker;
- the complete diff and results have been presented to the user and implementation has stopped for approval.

Only after explicit approval may Step 1 be committed and pushed. Step 2 starts only after that push is confirmed.
