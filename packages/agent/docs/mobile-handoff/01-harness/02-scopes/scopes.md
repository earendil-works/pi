# Session Storage: Scopes

> **Status:** Design evidence. The actionable Step 1 contract is [`implementation-handoff.md`](implementation-handoff.md), which supersedes this document on sequence allocation, reusable scope IDs, retirement authority/records, sidecar layout, implementation order, and the separation of JSONL encoding into Step 2.
>
> **Scope:** `packages/agent/src/harness/session/`, plus the call sites in
> `runtime/` listed in §10.
>
> **Depends on [01-delta](../01-delta/delta.md)** for the landed Chord op vocabulary that pending state is stored in (§2, §11) and for the `WireOp` form the record encoding carries (§12). The two
> are otherwise independent and compound: encoding shrinks every write, scopes
> move one class of write out of the main log entirely.
>
> Every claim here was checked against `runtime/lane.ts`, `runtime/progress.ts`
> and `runtime/drive/*.ts`. The type-level enforcement in §6 was verified with
> `tsc --strict`, including that mixed-scope commits are the *only* thing it
> rejects.

## 1. The problem

Operation state — pending tool output, pending assistant output — matters only
while the operation runs. It is crash-recovery scaffolding, not history.

The JSONL log is append-only, so it persists anyway. Worse, deleting it *adds*
records: `deleteValue` and `deleteList` write a line each, and those lines also
persist. Today only a full snapshot rewrite reclaims the space, and no in-place
compaction exists (`jsonl/storage.ts` has `createFromSnapshot`, used for fork).

Measured on 20 operations, each 400 assistant frames plus 2 tools at 60
checkpoints of a 50 KB window:

| | size |
| --- | --- |
| total JSONL | 93.89 MB |
| settled transcript entries — the part that is actually history | **0.06 MB** |

Three orders of magnitude of the file is scaffolding for finished operations.

**Two independent fixes, and they are not alternatives:**

- **Encoding** ([delta.md](../01-delta/delta.md)): value writes carry Chord ops rather than whole values, and addresses are interned. Takes the same workload to **5.32 MB in a single file**, with no change to atomicity. The op vocabulary and flush-time tracker have landed; storage integration has not.
- **Scopes** (this document): pending state leaves the main log entirely, so it is
  never history to begin with.

Do the encoding first. Scopes are worth it because 5.32 MB of dead weight per 20
operations still accumulates, and there is no compaction pass to reclaim it.

## 2. Scope on the address

Scope has two halves that must not be confused: a **type-level tag** carrying no
data, and a **runtime scope id** that names the file.

```ts
export type SessionScope   = { readonly kind: "session" };
export type EphemeralScope = { readonly kind: "ephemeral" };
export type Scope = SessionScope | EphemeralScope;

// Passing a scopeId is what makes an address ephemeral.
export function value<T>(namespace: string, key: string): Value<T, SessionScope>;
export function value<T>(namespace: string, key: string, scopeId: string): Value<T, EphemeralScope>;

export function list<T>(namespace: string, key: string): ValueList<T, SessionScope>;
export function list<T>(namespace: string, key: string, scopeId: string): ValueList<T, EphemeralScope>;

/** A main-log record retiring an ephemeral scope. See §5. */
export function retireScope(id: string): Write<SessionScope>;
```

The suffix is not decoration: `Session` already names the session interface in
`harness/session/types.ts`, and reusing it produces `TS2440`/`TS2484` plus an
ambiguous re-export from `session/index.ts`.

```ts
interface Value<T, Sc extends Scope = SessionScope> extends ScopedAddress<Sc> {
  readonly namespace: string;
  readonly key: string;
  /** Present iff Sc is Ephemeral. Routes the write and names the sidecar. */
  readonly scopeId?: string;
}
```

The id is a plain runtime string, because it is an operation id — generated at
runtime and unavailable to the type system. That is precisely why §6 can
distinguish *session from ephemeral* statically but cannot distinguish *two
different ephemeral scopes*: the tag is in the type, the id is not.

```ts
// Durable lists carry encoded batches; one encoder/decoder pair belongs to each value stream.
export const pendingToolOutput = (operationId: string, invocationId: string) =>
  list<WireOp[]>("pi.pending.tool_output", `${operationId}:${invocationId}`, operationId);

export const pendingAssistantOutput = (operationId: string, entryId: string) =>
  list<WireOp[]>("pi.pending.assistant_output", `${operationId}:${entryId}`, operationId);

export const operationToolMemo = (operationId: string, invocationId: string, name: string) =>
  value<JsonValue>("pi.op.tool_memo", `${operationId}:${invocationId}:${name}`, operationId);

// unchanged — no scopeId, so Session by inference
export const laneStateValue = (lane: string) => value<DurableLaneState>("pi.lane.state", lane);
```

**Scope is the file.** A session-scoped write goes to the main log; an
ephemeral-scoped write goes to `<session>.<scopeId>.jsonl`.

Other backends need no sidecars at all: in-memory drops a `Map` keyed by scope id,
SQLite issues one `DELETE ... WHERE scope = ?`. Scope is meaningful to them only as
a lifetime hint. It is JSONL that needs the file split, and that is where the
constraints in §4 and §5 come from.

## 3. Which addresses are scoped, and why

The boundary is drawn by **write isolation**, not by lifetime.

Scoping everything under `pi.op.*` on the grounds that it dies with the operation
looks right and is wrong. `lane.ts` shows why: **every** operation commit bundles
`operationState` with `laneState`.

```ts
// lane.ts:405/431, 659/660, 749/750, 1071/1072 — the same shape each time
writes: [
  ...decision.writes,
  setValue(operationStateValue(operationId), decision.operationState),
  setValue(laneStateValue(this.name), durableLaneState(...)),
]
```

That pair is coordination state: lane state says the operation is at step N,
operation state holds the data for step N. Splitting them across files makes a
crash produce a lane that believes it is somewhere the data does not support.

The **bulk** values behave differently. `openProgress` commits exactly one write
(`runtime/progress.ts:51`), and `pendingToolOutput` / `pendingAssistantFrames`
appear in multi-write transactions only as *deletes*.

| | addresses |
| --- | --- |
| **ephemeral (sidecar)** | `pi.pending.tool_output`, `pi.pending.assistant_output`, `pi.op.tool_memo` |
| **session (main log)** | `pi.lane.state`, `pi.op.state`, `pi.op.meta`, `pi.result`, `pi.pending.entry`, `pi.branch.tip`, `pi.op.tool_args`, `pi.op.preparation` |

`operationToolMemo` is ephemeral so that the memo-plus-checkpoint bundling in
`harness-tools.md` §7.5 is a single-file transaction. `terminal.ts:34` already
treats `operationToolMemoPrefix` and `pendingToolOutputPrefix` as the same cleanup
class, so this matches how the code already thinks about them.

The size win is unaffected by leaving `operationState` behind: effectively all of
the 93.89 MB in §1 is pending tool and assistant output.

## 4. Two files are not atomic

Serialising on the Session line gives **ordering, not atomicity**. Two `write()`
calls to two descriptors, two fsyncs, no journal spanning them. A crash between
leaves the files disagreeing, and JSONL has nothing to repair it with.

So the design does not try to make cross-file transactions work. It ensures none
exist:

> **All writes in a transaction share one scope.**

That is achievable because it is already true of the code — see §5 for the audit.

Two consequences of *not* needing cross-file commits:

- **No write ordering between files is required.** The commit-record pattern
  (sidecar first, fsync, then a main-log record acknowledging it) is unnecessary if
  no transaction spans files. There is nothing to acknowledge.
- **No commit marker for sidecar-only writes.** One tempting design is a small
  main-log record for `openProgress`, since nothing acknowledges its write. It is
  not needed: that transaction is one write in one file and already atomic. Torn
  tails are handled the same way as in the main log — every line is a complete op
  or a whole batch, so a reader stops at the last intact one.

What remains is a **durability** choice, not a consistency one: if the sidecar is
fsynced less aggressively, recent checkpoints can be lost. That is the same bounded
loss the checkpoint interval already accepts, but it should be a deliberate policy
rather than an accident.

## 5. Audit: does the existing code satisfy the rule?

Every commit in `lane.ts` (12 sites) and every `writes:` producer in
`runtime/drive/*.ts` (32 sites) was read.

**Result: yes, with one adjustment.** No transaction writes to two files. The
spanning cases are all *deletes* of ephemeral state bundled with main-log writes:

- `response.ts:340` — the settle commit: `insertEntry`, `insertUsage`,
  `setValue(branchTip)`, plus `deleteList(pendingAssistantFrames(...))`.
- `terminal.ts:50` `operationCleanupWrites` — bundles main-log deletes with
  `toolMemos` and `toolOutputs` deletes, returned into the same array as
  `operationResultValue` and `laneStateValue`.
- `tools.ts:230, 257` — `deleteValue(pendingToolOutput)` with main-log writes.
- `deferred.ts:157` — `deleteList(pendingAssistantFrames)`.

**The adjustment: retirement becomes a main-log record.**

```ts
retireScope(operationId): Write<SessionScope>
```

The log is the truth; the sidecar file is a cache. Recovery reads the retire record
and ignores — then removes — the sidecar. Unlinking eagerly after commit is a pure
optimisation; losing the unlink costs disk, never correctness.

This makes all four sites above single-scope, because the individual ephemeral
deletes disappear. It also *simplifies* `operationCleanupWrites`: the `scanValues`
calls for `operationToolMemoPrefix` and `pendingToolOutputPrefix` are replaced by
one `retireScope`.

And it makes the open-time sweep principled rather than heuristic. A sidecar is
dead iff the main log retired it or its operation is absent — no inference from
operation status.

### 5.1 Two ephemeral scopes in one transaction cannot arise

A lane holds `operation: { meta, state } | null` — **singular**. Every write set
uses one `operationId`, either `drive.operationId` or the newly created one in
`startOperation`, which asserts no operation is active. Retire and start are always
separate transactions: the settle commits at `lane.ts:427` and `response.ts:339`
set lane state to `null`.

Concurrency is across **lanes**, and each lane has at most one active operation, so
two ephemeral scopes never meet in a commit. The runtime assertion in §6 is defence
against a future change, not a live gap.

## 6. Static enforcement

> **`scopes.variance.ts` ships alongside this doc** and is the executable form of
> this section: `npx tsc --noEmit --strict --lib es2023 scopes.variance.ts`.
> Silence means the rule holds. Its three `@ts-expect-error` lines fail the
> compile if they ever start type-checking, so it catches the enforcement being
> weakened as well as broken.


Two phantom types, differing only in where `Sc` appears. This distinction is
load-bearing and is the single easiest thing to get wrong here.

```ts
declare const storedScopeType: unique symbol;

/** Addresses: COVARIANT — Sc only in return position. */
export interface ScopedAddress<Sc extends Scope> {
	readonly [storedScopeType]?: () => Sc;
}

/** Writes: INVARIANT — Sc in both parameter and return position. */
export interface Scoped<Sc extends Scope> {
	readonly [storedScopeType]?: (scope: Sc) => Sc;
}

export interface Value<T, Sc extends Scope = SessionScope>
	extends StoredAddressBase, ScopedAddress<Sc> { … }

export interface ValueSetWrite<Sc extends Scope> extends Scoped<Sc> { … }
```

**Why they differ.** Reading an address is safe at any scope — `getValue` does not
care which file a value lives in, so `Value<T, SessionScope>` must be usable where
`Value<T, Scope>` is expected. Forming a transaction is *not* safe at any scope,
because two files are not atomic, so a commit must pin down exactly one.

Enforcement therefore belongs where transactions are formed, not where addresses
are read. `setValue<T, Sc>(address: Value<T, Sc>, …): Write<Sc>` is the bridge: it
infers the scope from a covariant address and stamps it onto an invariant write.

> **Getting this wrong is expensive.** Making addresses invariant too breaks every
> reader — `getValue`, `scanValues`, `readList` and everything downstream — and
> produced a 36-error cascade across storage backends that had done nothing wrong.
> The tempting workaround, making each reader generic over `Sc` to mean "any
> scope", propagates a type parameter through the whole storage stack to express
> something variance gives for free.

Verified with `tsc --noEmit --strict`. Reads pass at both scopes:

```ts
getValue(laneState);        // Value<T, SessionScope>
getValue(pendingOutput);    // Value<T, EphemeralScope>
```

Single-scope commits pass:

```ts
commit([setValue(laneState, a), setValue(operationState, b)]);
commit([setValue(toolMemo, m), setValue(pendingOutput, o)]);
commit([setValue(laneState, a), retireScope("op_1")]);
```

Mixed-scope commits fail, and are the *only* things that fail:

```ts
commit([setValue(laneState, a), setValue(pendingOutput, o)]);   // ERROR
commit([setValue(pendingOutput, o), retireScope("op_1")]);      // ERROR
```

### 6.1 What the type system cannot catch

Two different ephemeral scopes both type as `Write<EphemeralScope>`, because the id
is a runtime string (§2). A runtime assertion at commit covers it — compare
`scopeId` across all writes — and per §5.1 it should never fire.

## 7. Recovery and sweeping

On open, enumerate sidecars alongside the main log and load them. Their records
participate in replay exactly as main-log records do.

A sidecar is removed when the main log holds a `retireScope` record for it, or when
its operation is absent — a crash between commit and unlink. Torn-tail semantics
are unchanged: each line is self-contained, so a crash mid-write loses exactly the
trailing line.

## 8. Sequence numbers

Scoped writes get their own sequence space per scope. Nothing outside a scope
orders against its contents, and keeping them separate means `nextSeq` in the main
header does not account for numbers consumed by files that will be deleted.

Shared numbering would leave large gaps after several operations settled, and the
high-water mark would need separate persistence.

## 9. Measured effect

Same workload as §1:

| | size | of today |
| --- | --- | --- |
| today, single JSONL | 93.89 MB | — |
| ops + interned addresses, single JSONL | 5.32 MB | 5.7% |
| **plus scopes — main log** | **0.06 MB** | **0.06%** |
| — sidecars, retired on settle | 5.26 MB | peak 0.26 MB per operation |

The 5.7% figure is **rate-dependent and must not be quoted alone**: it holds at
2 KB of tool output per checkpoint and inverts above the cap, where a whole-value
replacement wins.

The scope result is **not** rate-dependent. The main log holds settled entries
regardless of encoding, and that is the number that governs session file growth.

## 10. What changes in the existing code

The compiler finds these for you: once addresses carry a scope and `Write<Sc>` is
invariant, every site that mixes scopes in one transaction fails to typecheck.
This list is what a full pass turned up, so you know when you are done.

**New, in `session/values.ts` and `session/types.ts`**

`SessionScope` / `EphemeralScope` / `Scope`; the two phantoms from §6;
`Value<T, Sc>` and `ValueList<T, Sc>`; `scopeId` on the address; the `value` /
`list` overloads; `retireScope`; scope-preserving `setValue` / `deleteValue` /
`appendList` / `deleteList`; `Write<Sc>` with entries, usage and retirement
session-only by construction.

**Generified**

`CommitDecision<TResult, Sc>`, `lane.command<TResult, Sc>`, `Storage.commit<Sc>`.
Give `Sc` a default of `SessionScope`: conditional types are not inference sites,
so without a default a mixed array falls back to the constraint `Scope` and every
call site fails. `settleOperation` and `continueOperation` stay **non**-generic —
see §5.

**Committed writes**

`CommittedScopeRetireWrite`, and `scopeId` carried through the committed shapes so
`JsonlStorage` can route on it.

**Call sites that must change** — each currently mixes scopes in one transaction:

| site | what it does today | what it becomes |
| --- | --- | --- |
| `drive/terminal.ts` `operationCleanupWrites` | enumerates tool memos and tool outputs via `scanValues`, deletes each alongside session deletes | one `retireScope(operationId)`; two of its four scans disappear |
| `drive/response.ts` (settle) | `deleteList(pendingAssistantOutput)` bundled with operation state | drop it — the sidecar is discarded at retire |
| `drive/deferred.ts` (superseded response) | same | same |
| `drive/tools.ts` (tool settle) | `deleteValue(pendingToolOutput)` plus memo deletes in a session write array | drop them |
| `drive/tool-placement.ts` | `deleteValue(pendingToolOutput)` | drop it |

The pattern is the same everywhere: **intra-operation cleanup of ephemeral state
is impossible**, because those commits also write operation and lane state. The
sidecar is discarded wholesale at retire. The cost is that a multi-turn operation
holds superseded pending output until settle — bounded by turns, and never
reaching the main log.

**Storage**

Sidecar routing in `JsonlStorage.commit` (assert one scope id per transaction,
route the append), unlink on a `scope` record **after** the commit, and an
open-time sweep that loads sidecars and removes any the main log already retired.
In-memory drops a `Map` keyed by scope id; SQLite issues one
`DELETE ... WHERE scope = ?` and treats a retire record as a no-op, because it has
no sidecar and the terminal transaction deletes the scoped values explicitly.

**Expected test churn**

Nine tests assert the old cleanup write set and will fail — `drive-terminal` (3),
`drive-retry-deferred` (2), `drive-tools`, `drive-reconcile`, `drive-generation`,
and one pinning reserved namespaces. They expect six or seven individual deletes
where the new code emits fewer plus one `retireScope`. That is the change landing,
not a regression.

## 11. List tags and stop conditions

Tracked state is stored as a list of op batches (`delta.md` §9). Recovery needs "the
batches since the last base batch" without unpacking every row, which lists cannot
express today: `ListReadOptions` has `cursor`, `order` and `limit` only.

`BranchScan` already solves the same problem for entries, and its vocabulary is
the one to copy — `stopAtType` / `stopAtId` for a terminator, plain field names
for a filter.

```ts
appendList<T, Sc>(address: ValueList<T, Sc>, element: T, tag?: string): ListAppendWrite<Sc>;

export interface ListElement<T> {
  seq: number;
  value: T;
  tag?: string;
}

export interface ListReadOptions {
  cursor?: ListCursor;
  order?: "asc" | "desc";
  limit?: number;
  /** Include elements up to and including the first carrying this tag, then stop. */
  stopAtTag?: string;
  /** Return only elements carrying this tag. */
  tag?: string;
}
```

**`stopAtTag` is a stop condition within a page, not a guarantee.** It can only end
a page earlier than `limit` would; it never overrides it. If the tagged element is
not in the page, the consumer sees no tagged element and pages again with the
cursor — the same loop `readAssistantFrames` already runs. There is no ordering
question between the two bounds and no "not found" error.

For that loop to work, `readList` must return the tag on each element. Otherwise a
consumer cannot tell "page ended at the tag" from "page ended at the limit"
without parsing the value, which is the thing the tag exists to avoid.

**The producer sets the tag, not storage.** For a tracked value the caller
already knows, because `isBase(ops)` is a token comparison on the first op
(`delta.md` §2):

```ts
const ops = tracker.flush();
if (ops.length === 0) return;
writes: [appendList(address, enc.encode(ops), isBase(ops) ? "base" : undefined)];
```

Storage must never inspect an element to derive a tag. That is what keeps op
batches opaque to the storage layer, and it is the same property that makes
`EntryScan.type` work: the discriminant is a stored column, not something derived
from the payload.

**The tag lives on the storage record**, beside `seq` and `value`:

```jsonc
["l",7,9,[["r",{…}]],"base"]        // per §12.1
```

Storage must never parse an element to evaluate a predicate. That is what keeps
ops opaque to storage and the durable path free of domain knowledge
(`harness-tools.md` §7.7). It is also why `EntryScan.type` works: the discriminant
is a stored column, not something derived from the payload.

`order` stays `"asc" | "desc"` rather than `BranchScan`'s
`"newestFirst" | "oldestFirst"`. Branch order is semantic — a walk from a tip
through a tree. List order is over `seq`. Borrowing the branch words would imply a
traversal that is not happening.

Backends: SQLite gets a `tag` column and a real predicate. JSONL holds the list in
memory already, so it scans backwards and checks a field — no worse than today.
In-memory likewise.

The primitive generalises past frames: any list wanting "the tail since the last
checkpoint" gets it.

## 12. JSONL record encoding

Two dictionaries at two layers. They are the same trick and are independent: the
**address** dictionary is over `namespace` + `key` on the record; the **path**
dictionary is over paths *inside* a value's ops (`delta.md` §4).

### 12.1 Records

```
["@", addrId, namespace, key]              address definition
["v", addrId, seq, wireOps]                value write   — WireOp[], delta.md §4
["l", addrId, seq, element, tag?]          list append   — element is WireOp[]
                                             for a tracked value
["x", addrId, seq]                         delete (value or list)
["!", addrId, seq]                         retire an ephemeral scope
```

**Record verbs and op verbs are separate vocabularies read at different levels**,
but they must not look alike. `!` rather than `r` for retire: `r` is delta's
replace op, and a reader scanning a file should not have to remember which nesting
level they are at to know what a tuple means.

Retire takes an address id like everything else, defined by an `["@", id, …]`
whose namespace is the scope. That keeps one interning rule for the whole file
rather than a special case for one record.

Entries and usage rows keep their current keyed form: they are written once, never
repeat an address, and are read by machinery that has nothing to do with ops.

An address is defined on its **second** use, matching path interning — a
definition is pure overhead for an address written once, and a session has many of
those.

### 12.2 Worked example

Four writes across two addresses, before and after.

```jsonc
// today — 1250 bytes
{"kind":"value","op":"set","seq":7,"namespace":"pi.op.state","key":"01a04cf6-…","value":{"at":"starting","control":{…},"settings":{…},"latestAssistantEntryId":null}}
{"kind":"value","op":"set","seq":8,"namespace":"pi.lane.state","key":"main","value":{"currentOperationId":"01a04cf6-…",…}}
{"kind":"value","op":"set","seq":9,"namespace":"pi.op.state","key":"01a04cf6-…","value":{"at":"checkpoint",…}}
{"kind":"value","op":"set","seq":12,"namespace":"pi.op.state","key":"01a04cf6-…","value":{"at":"assistant.ready",…}}
```

```jsonc
// with both dictionaries — 547 bytes
["@",0,"pi.op.state","01a04cf6-…"]
["v",0,7,[["r",{"at":"starting","control":{…},"settings":{…},"latestAssistantEntryId":null}]]]
["@",1,"pi.lane.state","main"]
["v",1,8,[["r",{"currentOperationId":"01a04cf6-…",…}]]]
["v",0,9,[["#",0,["at"]],["s",0,"checkpoint"]]]
["v",0,12,[["s","assistant.ready"]]]
```

| line | before | after |
| --- | --- | --- |
| address definition | – | 61 |
| op.state -> `starting` (base batch) | 353 | 256 |
| address definition | – | 31 |
| lane.state (base batch) | 181 | 114 |
| op.state -> `checkpoint` | 355 | **48** |
| op.state -> `assistant.ready` | 361 | **37** |
| **total** | **1250** | **547** (44%) |

The shape matters more than the total. Base batches barely shrink — 353 to 256 is
envelope only, since the value ships whole either way. The transitions collapse
~8x because they carry one changed field instead of the whole state including the
never-changing `settings` block.

Both dictionaries appear on line 5: `0` in `["v",0,9,…]` is an **address** id,
while `["#",0,["at"]]` defines a **path** id inside the value's ops. Same trick,
different layers, separate tables. Line 6 then drops the path entirely — arity
omission, because it targets the same path as the previous op in that batch.

**Do not quote 44% as the file-level saving.** Dictionary entries are one-time, so
a real operation's ~11 op.state writes amortise them and the ratio improves; but
transcript entries are untouched, and they were 18 KB of a 67 KB tool-heavy run.
Applied there this hits the ~27 KB of value writes and would take the file down by
roughly a fifth, not by half.

### 12.3 Reading

A reader builds both tables while replaying, so a torn tail costs exactly the
trailing lines and no header needs rewriting. A snapshot rewrite starts fresh
tables and re-emits definitions naturally.

A numeric `addrId` for which no definition has been seen is a corrupt file, not a
recoverable state — unlike a missing path id, which cannot occur because path
definitions are inside the same record as their first use.

## 13. Open questions

- File-handle pressure across concurrent lanes, each with a live sidecar. Probably
  fine, unmeasured.
- fsync policy for sidecars (§4) — matched to the main log, or relaxed given the
  contents are bounded-loss scaffolding.
- Whether a long-running operation should rotate its sidecar. `rebase()`
  (`delta.md` §3.2.3) bounds *recovery* length but not file size, so a command
  running for hours still grows its sidecar without bound.
- Whether an in-place compaction pass for the main log is worth building anyway.
  `createFromSnapshot` plus atomic replace is the mechanism; scopes reduce the need
  but do not remove it, since superseded session-scoped values still accumulate.
