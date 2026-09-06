# AgentHarness — implementation specification

Sections are numbered (§N.M) for cross-reference; part-level contents:

- [Part 0 — Orientation](#part-0--orientation): system model · three stores · worked examples · non-goals · notation/source types · validation boundary · implementation status
- [Part 1 — Storage](#part-1--storage): model · identity · bound values/lists · transactions · queries · usage ledger · backends · rationale
- [Part 2 — The conversation tree](#part-2--the-conversation-tree): entries · placement · Branches/AgentLanes · metadata · branch queries/context · branch index · forks · Session/repository (incl. C1, search) · precise rewrite
- [Part 3 — The operation state machine](#part-3--the-operation-state-machine): operations · state · lane state · transition rule · graph · acceptance · assistant · tools · summaries · navigation · inbox · boundary · terminal results
- [Part 4 — Execution, recovery, abort, close](#part-4--execution-recovery-abort-close): Drive · effect gate · mutation line · attachment · recovery · abort · close · faults
- [Part 5 — Public surface](#part-5--public-surface): lane · harness · Session/Branch · snapshots · events · hooks · execution blocks · telemetry
- [Part 6 — Future: partitioned retention (Postgres)](#part-6--future-partitioned-retention-postgres)
- [Part 7 — Schema evolution](#part-7--schema-evolution)
- [Part 8 — Work packages](#part-8--work-packages)
- [Part 9 — Invariants and tests](#part-9--invariants-and-tests): 38 invariants · race catalog · test tiers
- [Appendix A — Glossary](#appendix-a--glossary) · [Appendix B — Coding-agent v3-format compatibility](#appendix-b--coding-agent-v3-format-compatibility) · [Appendix C — Open questions](#appendix-c--open-questions)

# Part 0 — Orientation

## 0.1 What this is

A durable runtime for agent conversations: it persists conversation and operation state so interrupted work resumes without repeating settled effects. This document is the normative specification; §0.9 marks the parts that are specified but not implemented. Public type declarations live in the source files named in §0.7 — this document repeats a declaration only where its shape itself is a rule.

## 0.2 System model

A **session** has four parts: an immutable **entry tree** (message, compaction, branch summary, or application-defined custom entries; branches share the tree, enabling branching, compaction, forking, and parallel work while preserving history); mutable **values and lists** at bound typed addresses (built-ins: session name, entry labels; applications define their own collision-resistant addresses); **Branches and AgentLanes** (a Branch is one named data path with a movable tip; an AgentLane adds total model configuration, queues, and at most one operation; sessions may start with zero of either, and `main` is an ordinary explicit name); and an append-only **usage ledger**.

The Session layer owns global durable data and Branch capabilities. The **harness** drives lanes through four primitives — `accept` durably creates an operation, `drive` advances an expected operation, `requestAbort` durably requests cancellation, `inspectExecution` atomically reports current and latest-terminal execution — plus conveniences (`prompt`, `resume`, `abort`, …) composing them with process-local waiting policy. A serving layer may instead schedule `drive` calls through alarms, jobs, or another host runtime. The harness also owns harness-wide tool and prompt-resource registries, hooks, passive events, and runtime configuration.

An **operation** is one accepted unit of lane work: run, compaction, or navigation. Immutable metadata records identity, intent, and starting point; a total current state records phase, control, and recovery data; queued input belongs to the lane. Acceptance and execution ownership are separate: an accepted operation may have no process-local driver. Completion deletes operation-owned state and writes one immutable result record.

**Context.** Every asynchronous public harness/lane/Session/Branch/repository/storage method takes an explicit trailing `Context`; synchronous registration (`events.on()`, `hooks.on()`) is contextless, and handlers receive a Context when invoked. Context exists because concurrent calls need independent telemetry parentage and an RPC adapter must carry one request's cancellation as `context.abortSignal`. Shared receivers never retain a caller Context or discover one through `AsyncLocalStorage`. Request-ID RPC cancellation is implemented: the client maps its signal to `cancel(requestId)`, and the server derives a request Context with an `AbortController` that aborts on matching cancellation or disconnect. Trace injection/extraction and remote telemetry-parent reconstruction are specified but not implemented (T1, §5.8). Context is process-local invocation authority, never durable data: aborting it does not call `requestAbort()` or write `cancel_requested`.

**Storage** (Part 1) exposes atomic transactions and queries over three durable forms. `pi.op.meta` is written once per operation; `pi.op.state` is replaced after each transition with the complete current state; tool checkpoints of bounded progress are auxiliary and never prove effect completion. The terminal transaction deletes operation-owned values/lists and writes immutable `pi.result/{operationId}`. No partial transaction is ever visible.

## 0.3 The three stores

Everything in Parts 1–5 follows from four rules.

**1. Three stores, one invariant.**

```text
entries        conversation tree — write-once, append-only
values/lists   current mutable state — replaceable values; append-only lists
               (append or whole-list delete)
usage ledger   cost history — append-only rows
```

*Every payload is in an entry, a bound value/list, or the ledger; there is no third place.* An entry is the complete conversation record: placement and payload in one row. A `Value<T>` holds only its current value; a `ValueList<T>` holds immutable elements ordered by write sequence, deletable only whole. Complete content that durably exists before tree placement — queued input, deferred writes, finalized out-of-order tool results — waits in `pi.pending.entry` and becomes an entry in the transaction that places it; tool progress may occupy `pi.pending.tool_output` only while its effect is uncertain; streamed assistant frames occupy `pi.pending.assistant_frame` only while their response is effect-pending (§3.7). Per-backend projections (branch index, search, stats) are rebuildable and carry no authority.

**2. Atomic transactions** (§1.4): entry/usage inserts and value/list writes committed all-or-none with strictly increasing sequence numbers; no crash state exists inside a transaction; the only write primitive.

**3. The durable restart point** (§3.2): after every durable transition, the harness replaces `operationState(operationId)` with the *complete, total* current state — never depending on a previous state. After task loss, recovery reads it and starts at the responsible procedure, never replaying a journal or inferring position from what is missing. Small captured values are inline; large stable payloads live at sibling operation-owned addresses or are named by id; the terminal transaction deletes them, leaving exactly the conversation, ledger, and a handful of lane/session values.

**4. Intent and settlement** (§0.4 trace, §3.7–§3.8): provider requests and real tool calls are wrapped in two commits — intent ("about to do X; output will use ids R and U"), the uncertain effect, then settlement (complete output + next state, plus source-ordered materialization for tools). Hooks follow a replay contract instead: a hook result becomes durable in the transaction that consumes it, and a crash before that transaction may rerun the hook. Every external effect can therefore happen without durable settlement; intents make that explicit where replay policy depends on it, and idempotent hooks accept it as a non-goal.

## 0.4 Worked example — a Slack thread

A user posts in a channel with 400 entries of history; the application creates a lane anchored at the channel's tip and calls `lane.prompt(...)`. The normative write order (each `TX[...]` is one atomic commit): acceptance is hook-free and starts no task or effect; the intent mints response/usage ids before anything is sent; streamed events append compact frames without blocking the stream (§3.7); settlement commits response, usage, next state, and frame-list deletion together; tool calls follow intent → effect → outcome settlement, materializing in assistant source order; the terminal transaction deletes operation values/lists and writes `pi.result/O`:

```text
TX[ insert entry n1 (user msg), upsert pi.branch.tip = n1,
    upsert pi.op.meta/O, upsert pi.op.state/O = starting,
    upsert pi.lane.state = { currentOperationId: O } ]
… first drive owns real work; before_drive then before_run …
TX[ insert injected messages if any, upsert pi.branch.tip when needed,
    upsert pi.op.state/O = checkpoint need_assistant ]
TX[ upsert pi.op.state/O = assistant ready (config snapshot) ]
TX[ upsert pi.op.state/O = effect_pending (reserves response n2, usage u1) ]
… provider streams …                                  ← the uncertain window
TX[ append pi.pending.assistant_frame/O:n2 += frame ]    ← zero or one per non-terminal
                                                        event, enqueued without awaiting
TX[ insert entry n2, insert usage u1, upsert pi.branch.tip = n2,
    delete list pi.pending.assistant_frame/O:n2,
    upsert pi.op.state/O = tools (result id n3 reserved) ]
TX[ upsert pi.op.tool_args/O:s1:0, upsert pi.op.state/O = call 0 effect_pending ]
… tool runs; selected bounded updates may replace pi.pending.tool_output/O:n3 …
TX[ upsert pi.pending.entry/n3 = finalized tool result,
    delete pi.pending.tool_output/O:n3, upsert pi.op.state/O = call 0 outcome_ready ]
TX[ insert entry n3, delete pi.pending.entry/n3, upsert pi.branch.tip = n3,
    upsert pi.op.state/O = checkpoint ]
… second turn: ready · intent · stream · settle (n4, u2) …
TX[ delete pi.op.meta/O, pi.op.state/O, pi.op.tool_args/O:*,
    set pi.result/O = { operationId: O, kind: "run", status: "completed",
                        fromTipId, tipId: n4, startedAt, endedAt },
    upsert pi.lane.state = { currentOperationId: null,
                             lastOperationId: O, inbox: [] } ]
```

Kill the process between any two transactions and restart: the harness reads the lane's required values, sees which committed last, and continues. A death during the provider stream leaves a request that may have been billed and may or may not have produced output — the one genuinely uncertain window; §4.5 states the policy, and the committed frame prefix preserves the latest durable partial for synthetic settlement and reconnect display without proving how the request ended. A second thread in the same channel runs its own lane over the same shared history with no coordination.

## 0.5 Worked example — a crash mid-tool

The model returns two tool calls for `lane.prompt("delete the stale migrations and run the test suite")`. The harness commits the batch plan, then the intent for call 0 with its exact arguments and `replay: "never"`. The tool deletes files, emits bounded progress every 100 ms, and requests a durable checkpoint every two seconds. The process dies after one checkpoint commits:

```text
TX[ insert entry n2 (assistant, 2 calls), insert usage u1, upsert pi.branch.tip = n2,
    upsert pi.op.state/O = tools (result ids n3, n4 reserved) ]
TX[ upsert pi.op.tool_args/O:s1:0, upsert pi.op.state/O = call 0 effect_pending,
                                                    replay: "never" ]
… tool deletes files; live updates u1 … u19 …
TX[ upsert pi.pending.tool_output/O:n3 = bounded update u1 ]
… live updates u2 … u19 …  ← CRASH
```

On restart, `pi.op.state` says `calls[0].status = "effect_pending", replay = "never"`, so the deletion is not re-run. A later drive reconciles the orphan per §4.5: latest durable checkpoint content plus an explicit interruption warning, staged as a synthetic error under the reserved id, then materialized normally:

```text
TX[ upsert pi.pending.entry/n3 = synthetic interrupted result containing u1,
    delete pi.pending.tool_output/O:n3, upsert pi.op.state/O = call 0 outcome_ready ]
TX[ insert entry n3, delete pi.pending.entry/n3, upsert pi.branch.tip = n3,
    upsert pi.op.state/O = call 0 completed ]
```

Every tool call has a result and nothing ran twice; without a committed checkpoint the result contains only the warning. Had the tool declared `replay: "safe"` (a read, a query), the harness would instead have re-executed it with the persisted arguments.

## 0.6 Non-goals

- **Exactly-once external effects** — hooks with side effects must be idempotent, keyed by operation id.
- **Provider stream resumption** — the harness never reattaches to a provider stream; committed frames (§3.7) preserve the latest durable partial for recovery and reconnect display, and a settled response is persisted *completely* before anything classifies it.
- **Multiple writable owners** — exactly one host-assigned owner may hold a writable Session at a time; normally that owner is its Session worker, while the server may temporarily own a newly created or forked destination before handing it off. Storage backends do not enforce this host-lifecycle rule. Read-only repository work such as a SQLite source snapshot may overlap the worker (§1.7, §2.7). Lanes cover the workload that looks like multi-writer.
- **Work scheduling** — the harness never creates platform alarms, scans repositories for abandoned sessions, leases hosted submissions, or promises an HTTP receipt; it reports durable waits through `drive` and the serving layer decides when to call again.
- **Replication** — a session lives in one place.
- **Durable write history** — values retain only current state, lists only until whole-list deletion; no API or table exposes replaced values or deleted elements. Test write-order assertions use an instrumented decorator around `commit()` (Part 9); production auditing belongs to telemetry (§5.8).
- **Deletion as a runtime feature** — entries and usage rows are never deleted: compaction changes provider context, not storage; terminal cleanup deletes only values/lists; `retainedTail` copies old messages forward and summaries derive from old content, so compaction is not erasure. Compliance-grade erasure is the administrative precise rewrite (§2.9), the sole sanctioned exception.

## 0.7 Notation and source types

- `TX[ a, b, c ]` — one atomic commit with writes in that order. Write vocabulary: `insert entry`, `insert usage`, `setValue`, `deleteValue`, `appendList`, `deleteList`. Traces may abbreviate a bound address as its persisted `namespace/key`; that is never an API signature or second key argument (§1.3).
- Ids are UUIDv7s (§1.2), abbreviated `e_*`/`u_*`/`op_*`; where the time prefix matters, examples show it.
- `S(next)` overwrites `operationState(operationId)` with the next total state; `L(next)` the same for `laneState(lane)`.
- Declarative rules, transition/race tables, invariants, and traces explicitly called normative are normative; examples and sections marked informative are not. **must / must not** emphasize obligations but are not the only normative wording. This clarifies the old shorthand: tables that tests consume are part of the contract.

Path convention: `src/...` is relative to `packages/agent/`; bare harness paths such as `session/types.ts` or `agent-harness.ts` are relative to `packages/agent/src/harness/`; `docs/...` is relative to `packages/agent/`; paths beginning `packages/` are repository-root relative. Source type provenance: `AgentMessage`, `AgentTool`, `AgentToolResult`, `QueueMode`, `ThinkingLevel` — `packages/agent/src/types.ts`. `Skill`, `PromptTemplate`, `AgentHarnessResources` (`Resources` below), the `AgentHarnessTool*` family, `AgentHarnessStreamOptions`/`Patch` — `packages/agent/src/harness/types.ts`. `Model`, `Models`, `Tool`, `Usage`, `RetryPolicy`, `StopReason`, `AssistantMessage`, `ImageContent`, provider messages, stream options, deferred handles — `packages/ai`; `AiContext` aliases pi-ai's provider request `Context` to distinguish it from the harness invocation `Context`. `AssistantMessageFrame`, `AssistantMessageFrameEncoder`, `reduceAssistantMessageFrames` — `packages/ai` `src/utils/assistant-message-frame.ts`; the harness defines no second frame codec or reducer. `CompactionSettings`, `CompactionPreparation`, `CompactResult`, `BranchPreparation`, `BranchSummaryResult` — `packages/agent/src/harness/compaction/`; existing preparation and split-turn algorithms remain the implementation unless this document changes them. `TelemetryContext` and schema helpers — `packages/telemetry`; agent-owned schemas — `src/harness/telemetry.ts`. `Context`, `ContextKey`, `BACKGROUND_CONTEXT`, derivation helpers — `src/harness/context.ts`. Harness/lane public declarations — `src/harness/agent-harness.ts`; Session/storage declarations — `src/harness/session/types.ts` and `session/values.ts`.

Public `QueueMode` is `"all" | "one-at-a-time"`. Public `RetryPolicy` is `{ enabled, maxRetries, baseDelayMs }`; operation state stores the normalized `{ maxAttempts, baseDelayMs }`. `maxRetries` and `baseDelayMs` must be finite non-negative safe integers and `maxRetries + 1` must remain safe; disabled retry normalizes to one attempt; delay and `notBefore` arithmetic saturate at `Number.MAX_SAFE_INTEGER`. Public `CompactionSettings` is `{ enabled, reserveTokens, keepRecentTokens }`; both token counts must be finite non-negative safe integers. Constructors and setters reject invalid settings before publication. `AgentHarnessStreamOptions` and its patch include `deferred?: boolean | { window?: "15m" | "1h" | "24h" }`; structural requests always force it to false. `SettledAssistantMessage` is `AssistantMessage & { stopReason: Exclude<StopReason, "pending"> }`. Provider dispatch resolves the durable `{ provider, modelId }` identity through `Models` at request time (which also applies auth); a missing or swapped registry entry fails the request in-band, like an unknown tool.

## 0.8 Validation boundary

Internal pi objects are trusted typed values: Session, storage, operation procedures, and in-process extensions neither runtime-validate shapes nor defensively clone. Storage still enforces its operational invariants (atomicity, sequence allocation, unique ids, parent existence); backends serialize/parse as needed; externally edited or shape-corrupt storage is unsupported. Runtime schema validation belongs at untrusted wire boundaries — a future protocol-schema slice defines shared TypeBox schemas for serializable pi-ai/harness data and derives TypeScript types from them, without adding validation to internal paths. Attachment validates only the relationships needed to publish the small lane/operation projection (§3.3, §4.4); detailed state-directed references are consumption-time checks (`watch` verifies the pending/entry discriminants and message-role relationships its snapshot needs; drive verifies transition inputs), and optional assistant-frame lists and tool checkpoints may be absent.

## 0.9 Implementation status

WP00–WP07 are complete (Part 8): the operation graph, public lane runtime, and SQLite host-ownership alignment are implemented. Part 9 states the required conformance matrix; it is not a claim that every listed row already has one dedicated test. Known missing behavior and current contract debt, each labeled again at its section:

- **J1 — JSONL snapshot compaction (§1.7):** specified, not implemented; dead bytes are never reclaimed today.
- **C1 — raw RemoteSession (§2.8):** the specified remote mutation transport contradicts the shipped process-local product; a decision is required before implementing either direction.
- **R12 — `watchSession` (§5.2):** public method throws `SliceNotImplemented`; the sole stubbed Harness method.
- **T1 — telemetry (§5.8):** span vocabulary declared; production starts only the tool-hook span. RPC ingress has request-ID cancellation but no trace propagation.
- **S3 — search (§2.8):** design only; the current `src/search/index.ts` skeleton conflicts with it and has no implementation.
- **R11 — schema migrations (Part 7):** mechanism specified; activation-gated; no migration exists or is required.
- **WP08 — named-branch and streaming forks (§2.7):** in progress on Slice A. Explicit scope and named-branch selection, ancestry validation, configured-lane enforcement, and the closed scalar fork policy are implemented. Lists, sequence/high-water preservation, direct Memory construction, and bounded JSONL/SQLite transfer remain.
- **SQLite branch divergence (§2.6):** the current compaction-bounded algorithm can copy O(history) on an uncompacted branch, contrary to its bounded-prefix goal.
- **H1 — contract/test closure:** public `OperationStatus` includes `"running"` but current observations produce only `"open"`/`"aborting"` (§5.4); the pre-rewrite abort contract bound `operation_abort` before resolving/signalling but current code signals first and binds recipients before releasing the line (§4.6); Part 9 remains the required conformance matrix, not a claim that every row has a dedicated test.
- **Source declaration corrections:** `CommitResult.stats` and `SessionReader.getStats()` are implemented; the old inline declarations omitted them even though other old sections depended on post-commit totals (§1.4, §2.8). The old execution-block declarations also predate the current source shapes: standalone `streamHarnessAssistant` permits an absent `afterResponse`, while the durable Harness caller always supplies it; tool phases directly carry `AgentHarnessTool`, `toolContext`, and invocation capabilities and create the canonical result message after an immediate raw result (§5.7). These are source-shape corrections, not changes to the durable boundaries.
- **Gate close typing (§4.2):** the production contract permits only `HarnessClosed | HarnessFault`; source currently widens the private primitive to `Error`, which isolated tests use. Production calls obey the narrower rule; narrowing the source type remains H1 cleanup.
- **Precise rewrite (§2.9)** and **partitioned Postgres (Part 6):** administrative/future; no implementation.

Storage format 4 is still WIP (pre-stabilization): shapes may change in place without migrations; do not invent migration obligations for them. The detailed future-work inventory is [`post-wp05-roadmap.md`](post-wp05-roadmap.md).

---

# Part 1 — Storage

Storage knows nothing about agents, lanes, or conversations. It stores entries and usage rows, updates bound values/lists, and answers a small fixed query set. Parts 2–4 are built entirely on this.

## 1.1 The model

Declarations: `session/types.ts`, `session/values.ts`. Semantics:

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** Write-once complete conversation record: placement and payload in one row.
    Created in exactly one transaction, never modified or deleted. Concrete
    entry types: §2.1. */
interface EntryBase {
  id: string;                // UUIDv7 (§1.2)
  parentId: string | null;
  seq: number;               // storage-assigned at commit
  timestamp: number;         // Unix ms, storage-assigned at commit
  type: "message" | "compaction" | "branch_summary" | "custom";
  customType?: string;       // when type === "custom"
}

/** The only mutable store, addressed by bound typed addresses. */
function value<T>(namespace: string, key = ""): Value<T>;      // kind: "value"
function list<T>(namespace: string, key = ""): ValueList<T>;   // kind: "list"
interface StoredValue<T> { address: Value<T>; value: T; seq: number }  // seq of last set
interface ListElement<T> { seq: number; value: T }             // global write seq of the append

/** Append-only cost ledger row. Never modified, never deleted (§1.6). */
interface UsageRow {
  id: string;                // UUIDv7 (§1.2)
  seq: number;
  usage: Usage;
  entryId?: string;          // the entry this cost belongs to, when there is one
  adjustment: boolean;       // true = caller-supplied reconciliation, not a provider report
  details?: JsonValue;
}
```

## 1.2 Identity

Every id — operation, entry, usage, every reserved id — is a **UUIDv7** from the session's id generator (§2.8); legacy imports re-mint to conform (Appendix B). `accept` may receive a caller-supplied operation id so a durable host submission and harness operation share one identity; the caller must mint it by the same contract and never reuse it. Omission mints internally. The first 48 bits are the mint time, so every reference is self-describing and time-sortable; the accepted cost is that ids leak creation time. (Part 6's informative Postgres sketch builds on this prefix.)

Minting rules: (1) ids are minted with `now()` when their committing operation begins — direct appends place in the same transaction; assistant/tool ids trail placement by at most the request duration; (2) **tool-result ids inherit their assistant id's timestamp** (`idGenerator.next(timestampMs?)`, fresh random tail), so a call-and-results group is time-cohesive under id order even across midnight; (3) synthetic settlements write under already-reserved ids (§4.5) — no special case.

**Opaque payloads** — custom entry `data`, application values, `details`, message text — may embed entry ids; the harness never tracks those references and they may go stale. Copy content, don't reference it.

**Absolutes.** Within a session, entries and usage rows are never deleted — the precise rewrite (§2.9) is the sole exception. A missing parent is always corruption.

## 1.3 Bound values and lists

The public storage abstraction is a **bound typed address**: `value<T>(namespace, key?)` names one replaceable durable value, `list<T>(namespace, key?)` one append-only durable list of `T`. Namespace and key are bound once; every later read or write receives only the address. There is no global value-type map, token catalog, declaration merging, or separate application-state storage mechanism. Built-in constructors live in `session/values.ts` and are imported directly — no runtime catalog or dependency-injection bundle; core and applications use the same universal constructors.

Rules:

- `namespace` must be non-empty; neither component may contain `\u0000`.
- Namespace `pi` and every `pi.*` namespace are reserved for built-ins by contract; every built-in namespace starts with `pi.`. Application use of `pi.*` is a trusted-programming defect; constructors perform no ownership check — exact constructor tests, not runtime privilege checks, enforce the convention.
- An empty key is legal and addresses one session-wide value or list.
- Object identity has no durable meaning; equal `(kind, namespace, key)` triples name the same location.
- Constructing one location with incompatible TypeScript types is a trusted-programming defect. Value and list addresses may not share one `(namespace, key)` in a storage version; storage performs no cross-kind collision check.
- Changing namespace, key grammar, kind, or incompatible value shape requires migration (Part 7). Later operations never accept another key after address construction.

Complete built-in inventory:

| Address constructor                             | Kind  | Persisted namespace, key                                 | Value                            | Meaning                              |
| ----------------------------------------------- | ----- | -------------------------------------------------------- | -------------------------------- | ------------------------------------ |
| `branchTip(lane)`                               | value | `pi.branch.tip`, lane                                    | entry id or `null`               | where this lane appends next         |
| `laneConfig(lane)`                              | value | `pi.lane.config`, lane                                   | `LaneConfiguration`              | total lane configuration             |
| `laneState(lane)`                               | value | `pi.lane.state`, lane                                    | `LaneState` (§3.3)               | current/last operation ids and inbox |
| `operationResult(opId)`                         | value | `pi.result`, operation id                                | `OperationResultRecord` (§3.13)  | immutable terminal observation      |
| `operationMeta(opId)`                           | value | `pi.op.meta`, operation id                               | `OperationMeta` (§3.1)           | acceptance data; written once        |
| `operationState(opId)`                          | value | `pi.op.state`, operation id                              | `OperationState` (§3.2)          | total durable restart point          |
| `operationToolArgs(opId, stepId, sourceIndex)`  | value | `pi.op.tool_args`, `{opId}:{stepId}:{sourceIndex}`       | effective arguments              | written once at clearance            |
| `operationToolMemo(opId, invocationId, name)`   | value | `pi.op.tool_memo`, `{opId}:{invocationId}:{name}`        | `JsonValue`                      | invocation-scoped durable memo       |
| `operationPreparation(opId, taskId)`            | value | `pi.op.preparation`, `{opId}:{taskId}`                   | `DurableStructuralPreparation`   | structural preparation               |
| `pendingEntry(entryId)`                         | value | `pi.pending.entry`, reserved entry id                    | `PendingEntry`                   | complete content awaiting placement  |
| `pendingToolOutput(opId, invocationId)`         | value | `pi.pending.tool_output`, `{opId}:{invocationId}`        | `AgentToolResult<unknown>`       | latest bounded progress checkpoint   |
| `pendingAssistantFrames(opId, responseEntryId)` | list  | `pi.pending.assistant_frame`, `{opId}:{responseEntryId}` | `AssistantMessageFrame` elements | committed stream-frame prefix        |
| `sessionName`                                   | value | `pi.session.name`, empty key                             | string                           | session name                         |
| `entryLabel(entryId)`                           | value | `pi.entry.label`, entry id                               | string                           | entry label                          |

Exactly five exported scan-prefix constructors encapsulate lane inventory and operation-cleanup grammar. Their results are valid only as namespace-scoped `scanValues()` inputs, never exact get/set/delete addresses:

| Prefix constructor | Namespace | Prefix key |
|---|---|---|
| `branchTipInventoryPrefix()` | `pi.branch.tip` | `""` (all lanes) |
| `operationToolArgsPrefix(opId, stepId?)` | `pi.op.tool_args` | `{opId}:` or `{opId}:{stepId}:` |
| `operationToolMemoPrefix(opId, invocationId?)` | `pi.op.tool_memo` | `{opId}:` or `{opId}:{invocationId}:` |
| `operationPreparationPrefix(opId)` | `pi.op.preparation` | `{opId}:` |
| `pendingToolOutputPrefix(opId)` | `pi.pending.tool_output` | `{opId}:` |

```ts
/** Unplaced content: current mutable state until the placement transaction
    writes the complete entry and deletes this value (§2.2). */
type PendingEntry =
  | { type: "message"; payload: AgentMessage }
  | { type: "custom"; customType: string; payload?: JsonValue };
    // absent custom payload = a custom entry with no data
```

`DurableStructuralPreparation` (`session/types.ts`) is a two-variant union: `kind: "compaction"` with `messagesToSummarize`, `turnPrefixMessages`, `retainedTail`, `isSplitTurn`, `tokensBefore`, optional `previousSummary`, `fileOps`, `settings`; and `kind: "branch_summary"` with `messages`, `fileOps`, `totalTokens`. `fileOps` is `{ read, written, edited: string[] }`.

Lifetimes:

```text
pi.lane.*  pi.session.*  pi.entry.*   session-lived semantic values
pi.result                             immutable lane-lived records, one per terminal operation
pi.op.*                               operation-lived; deleted no later than the terminal transaction (§3.13)
pi.pending.entry                      until placement, cancellation, or owning-operation cleanup
pi.pending.tool_output                only while its invocation is effect-pending
pi.pending.assistant_frame            only while its response is effect-pending
```

- `pi.op.meta` and `pi.op.preparation` are written exactly once; `pi.op.tool_args` once per call. Invocation memos die when the invocation reaches `outcome_ready`. Every `pi.op.*` value is deleted no later than the terminal transaction.
- The lane inbox and its pending payloads outlive operations and die only when consumed or cancelled; operation-owned staged tool outcomes die at placement or terminal cleanup (§3.11).
- Tool output is optional auxiliary state: outcome staging deletes it atomically; safe replay deletes it before re-execution; unsafe recovery may consume it into an interrupted result.
- Assistant frames are auxiliary list elements ordered by global write `seq`. A missing list is valid. Frames never prove request admission, completion, or failure and never select a restart point; settlement deletes the exact bound list atomically (§3.7).
- `pi.result` records are written once by terminal transactions, never updated or deleted by the runtime, and never read by recovery.
- Deleting a bound value removes it; JSON `null` stays distinct from absence where the address type permits it.

## 1.4 Transactions

A `Write` is an erased storage record for one of six operations — entry insert, usage insert, value set/delete, list append/delete — carrying `(namespace, key)` plus the value where applicable. Raw write shapes are storage internals: all code constructs them through `insertEntry(entry)`, `insertUsage(row)`, `setValue(address, next)`, `deleteValue(address)`, `appendList(address, element)`, and `deleteList(address)`, which check the bound address/value relationship before erasure. Value helpers cannot target list addresses and vice versa; `NoInfer<T>` makes the address authoritative instead of widening `T`.

```ts
interface CommitResult {
  firstSeq: number; seqs: number[]; timestamp: number;
  stats: SessionStats;   // session totals immediately after this commit
}
```

Rules:

1. A transaction commits **all-or-none**; no observable state has some writes and not others.
2. Writes receive **strictly increasing** `seq` in the order given; gaps are legal within and between transactions; `seq` is monotonic session-wide across all lanes and write kinds. A value `set` stamps the stored value with its assigned `seq`.
3. Writes apply in order within a transaction: an entry may name a parent created earlier in the same transaction; a stored value may reference entry/usage ids created earlier in it. A placement transaction inserts the complete entry and deletes its `pendingEntry(id)` together (§2.2) — both never exist at once.
4. Entry and usage ids share one session-wide id namespace; writing either kind under any existing id is **corruption**, not an update.
5. A value `set` replaces the current value; `delete` removes it; a later `set` recreates it; no history is retained. A `delete` naming an absent key is a no-op, so public deletions such as clearing an unset label stay legal.
6. One list `append` carries one element and never reads existing elements. Elements are immutable after commit and ordered by assigned write `seq`; gaps from unrelated writes are irrelevant. No per-element update, delete, insertion, or truncation exists.
7. A list `delete` removes every element under `(namespace, key)`; deleting an absent list is a no-op; `delete` then `append` in one transaction atomically creates a fresh list. "Append-only" describes elements while the key exists — whole-key deletion is lifecycle cleanup, not element mutation.
8. Transactions on one session are **serialized**: one writer, one queue.

Session passes typed transactions to storage without a codec, runtime shape validation, or cloning. A failed admitted commit **faults the harness** (§4.8): all effects stop, all calls reject, the process must restart. A partially applied transaction is not tolerated.

## 1.5 Queries

One `Storage` instance serves one session; repository discovery and lifecycle are outside it (§2.8).

```ts
interface Storage {
  commit(writes: Write[], context: Context): Promise<CommitResult>;
  getEntries(ids: string[], context: Context): Promise<Map<string, Entry>>;
  getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined>;
  /** Internal namespace-scoped prefix scan; the bound address key is the prefix. */
  scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
  readList<T>(address: ValueList<T>, options: ListReadOptions | undefined,
              context: Context): Promise<ListElement<T>[]>;
  scanBranch(q: StorageBranchScan, context: Context): Promise<Entry[]>;           // §2.5
  scanBranchStructure(q: StorageBranchScan, context: Context): Promise<EntryStructure[]>;
  scanEntries(q: EntryScan, context: Context): Promise<Entry[]>;   // session-wide inventory
  scanUsage(q: UsageScan, context: Context): Promise<UsageRow[]>;  // ledger read (§1.6)
  getStats(context: Context): Promise<SessionStats>;               // maintained projection
  close(context: Context): Promise<void>;
}
```

`EntryStructure` is the entry minus payload fields (`id`, `parentId`, `seq`, `timestamp`, `type`, `customType`). `EntryScan`/`UsageScan` filter by `type`/`customType` (entries only), `fromSeq`/`toSeq`, `order: "asc" | "desc"`, `limit`. `ListReadOptions` is `{ cursor?: { seq }, order?: "asc" | "desc" (default "asc"), limit? }`; the limit must be a positive safe integer, defaults to 1,000, and clamps above 10,000.

List read semantics: ascending returns `seq > cursor.seq`, descending `seq < cursor.seq`; results are ordered before `limit`; absent and empty keys both return `[]`; callers continue with the last element's `seq`, and an empty page ends iteration. A cursor is a sequence filter, not a snapshot or key-incarnation token: concurrent later appends may appear on later ascending pages, and after a whole-key delete a read simply applies the comparison to surviving elements. There is deliberately no unbounded "read the whole list" helper.

`scanValues(prefix)` is namespace-scoped, interprets the bound key as a prefix, and returns values in key-ascending order. Core inventory/cleanup uses only the five §1.3 prefix constructors; core call sites do not repeat raw reserved grammar. Ordinary reads use exact addresses. There is no cross-namespace value dump or durable write log. Entry inventory uses `scanEntries`, ledger reads `scanUsage`, totals the stats projection (§1.6), and test-order assertions the instrumented decorator (Part 9).

Recovery and execution reads must be index-driven and bounded: never infer state from an absent value (no history exists to fold). Exact dereference is allowed — current typed state may name a bounded set of entries and values, and an exact list address derived from current state may be read in bounded pages and reduced by its consumer (assistant frames use `reduceAssistantMessageFrames`, §3.7). Base restore never reads lists (§4.4). Public inventory/debugging APIs expose explicit limits/pagination through Session and Branch.

`close()` is idempotent: seal admission, reject later reads/commits on that instance, drain commits admitted before the seal, then release backend resources. Durable data reopens through the repository; writable-owner handoff belongs to the host lifecycle, not Storage.

## 1.6 Usage ledger

Every settled provider attempt writes one `UsageRow` — successful, failed, retried, and synthetic alike, including attempts whose operation later aborts. An orphaned structural/deferred intent that recovery discards or replaces has no settled outcome and may leave its reserved response/usage ids unused; abandonment alone writes no synthetic usage row, while any already committed usage remains. Settlement writes the response entry and its usage row together (§3.7); synthetic settlements write zero usage under the reserved usage id. Rows are append-only: terminal cleanup never deletes ledger rows, so billing survives everything that happens to orchestration state.

- `entryId` names the entry the cost belongs to, when one exists; structural attempts that fail before producing an entry, and standalone adjustments, have none.
- `adjustment: true` marks a caller-supplied reconciliation (`recordUsage`, §5.1), not a provider report; the format-3 import writes one aggregate adjustment row (Appendix B).
- Provider-attempt usage ids are reserved in the intent commit, so settlement writes under exactly the promised id. Adjustment rows, tool-reported usage, hook-supplied compaction/navigation usage (§3.9, §3.10), and import aggregates mint ids at commit; nothing reserves them.
- `getStats()` is a maintained projection over the ledger plus the message-entry count — `messageCount` counts `message` entries only. After every commit it equals the ledger sum (asserted by conformance, Part 9). Rows reach the application through the `usage` event at commit (§5.5); `scanUsage` reads them back by seq range, so a consumer persisting the greatest applied event `seq` catches up with `scanUsage({ fromSeq })`. Recovery never reads the ledger.

## 1.7 Backends

Three encodings of one model ship — Memory, JSONL, SQLite — and all pass the same conformance suite (Part 9). Each records the session's `storageVersion` (Part 7): a JSONL header field, a SQLite catalog column; Memory sessions are always current. Partitioned Postgres is informative only (Part 6).

### Memory

Maps for entries, scalar values, list arrays, and usage rows, physically keyed by `namespace + separator + key`. One queue serializes commits. A commit checks storage invariants, assigns sequences and the transaction timestamp, then applies writes synchronously; all validation and serialization needed to admit a transaction completes before any map mutates. Value delete = map delete; list append pushes the sequenced element; whole-key list delete removes the array; list reads filter by the exclusive cursor and slice to the validated limit. Reads are map lookups; `scanBranch` walks `parentId` in RAM. Memory returns typed values without cloning and holds exactly the live state — there is no log.

### JSONL

The file is the **replay recipe** for the Memory maps, not the state. One physical line per `commit()`: storage assigns sequence/timestamp fields, then encodes one committed write as a JSON object line or several as one **array line**. The header line is `{"v":4,"kind":"header","id":…,"storageVersion":1,"createdAt":…,"cwd":…}` plus optional `parentSessionId`, `legacyParentSessionPath`, and the `nextSeq` high-water mark written by fork destinations and v3 normalization (and required for future J1 rewrites).

- This is format 4. The pre-WP01 unfinished format-4 spelling was replaced in place; no migration for it exists or is required. Coding-agent format 3 remains supported (Appendix B).
- Open replays lines in order into the maps — entries/usage accumulate; a later value `set` overwrites, `delete` removes; list `append` adds `{ seq, value }`, list `delete` removes the key. That is *decoding*, not recovery logic. Open verifies persisted sequence monotonicity (strictly increasing, gaps legal) and timestamps, and never regenerates committed timestamps. All queries then run in RAM.
- **A torn final line is discarded whole**, including every element of an array line, and truncated before new writes are admitted — this makes "no crash prefix inside a transaction" true here. A malformed *interior* line or invalid framing is corruption. A future older storage version is decoded only when an explicit R11 migration defines that total mapping; post-migration compaction retires its bytes.
- Durability is process-crash level: a resolved `commit()` survives process death; no fsync promise. Optionally retain `(offset, length)` per entry and load payloads lazily — only if profiling demands it.

**Snapshot compaction (J1 — specified, not implemented).** In SQLite a value `set` is an in-place upsert; in JSONL every `set` appends, so a 30-turn run leaves ~10 dead `pi.op.state` lines after the terminal `delete`: the file grows with write history even though logical state does not. The specified fix rewrites the file as `header + current entries + current values + surviving list elements + usage rows` via temp file + atomic rename. Surviving lines keep their original `seq` values (dropped-line gaps are legal; no renumbering). Each surviving list element is rewritten as an append record carrying its original `seq`, merged in sequence order — never collapsed into one synthetic append — so list cursors survive. Deleted lists produce no snapshot records; the `nextSeq` high-water mark is preserved so dropping a trailing delete line cannot permit sequence reuse. Compact on open when the dead-bytes ratio crosses a threshold, after a terminal or outcome-staging deletion pushes the file across it, and always after a schema migration (Part 7); between compactions, operation is append-only and O(1) per commit.

Until J1 lands, deleted pending payloads, superseded state revisions, superseded tool checkpoints, and deleted frame lists linger as bytes indefinitely — logical deletion is immediate; physical deletion currently never happens. Tool authors therefore own bounded checkpoint values, cadence, and duplicate suppression (bash: live updates at 100 ms, checkpoints at most every two seconds, only when changed; at 50 KiB per checkpoint, continuously changing output adds ~15 MiB per ten minutes). Assistant frame lists grow linearly with model output; the [mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md) replaces per-frame durable and replication writes with tracked output in scoped storage. One small immutable `pi.result` record per terminal operation is retained forever and copied into every later snapshot — result growth is linear in operation count by design. Deployments needing prompt physical removal of sensitive cancelled content compact eagerly at terminal boundaries, once J1 exists.

### SQLite

Backend: `packages/session-backends/sqlite-node`. **One database file per session is the default; a shared container is supported.** Without `databasePath`, safe alphanumeric/underscore/hyphen ids retain `{id}.sqlite`; every other explicit id uses a `~`-prefixed base64url encoding of its UTF-16 code units, so separators, dots, percent signs, and Unicode cannot escape `directory`. With `databasePath`, any number of Sessions share one container. Metadata reports the canonical physical container path. Every authoritative and projection row is scoped by `session_id`; shared containers are a supported deployment mode, not an implementation detail to remove. SQLite supplies atomic transactions and coherent WAL snapshots, not Session ownership.

`001_initial.sql` (storage version 1), all scoped by `session_id`:

```sql
entries(id, parent_id, seq, type, custom_type, timestamp, payload) WITHOUT ROWID;
  -- ix_entry_parent(parent_id), ix_entry_seq(seq, type)
scalar_values(namespace, key, seq, value, PRIMARY KEY (namespace, key)) WITHOUT ROWID;
list_values(namespace, key, seq, value, PRIMARY KEY (namespace, key, seq)) WITHOUT ROWID;
usage_ledger(id, seq, entry_id, adjustment, usage, details) WITHOUT ROWID;
  -- ix_usage_seq(seq)

-- Private branch index (§2.6). Not values/lists; no equivalent in other backends.
branch_entries(branch_id, entry_id, entry_seq, entry_type,
               PRIMARY KEY (branch_id, entry_id)) WITHOUT ROWID;
  -- ix_be_seq(branch_id, entry_seq, entry_id, entry_type): entry_seq must directly
  --   follow branch_id or ORDER BY needs a temp b-tree; trailing columns cover
  --   id-only reads. ix_be_type(branch_id, entry_type, entry_seq, entry_id),
  --   ix_be_entry(entry_id)
branch_meta(branch_id PRIMARY KEY, tip_entry_id, tip_seq, base_branch_id, base_seq);
  -- unique ix_bm_tip(tip_entry_id)

sessions(id, created_at, parent_session_id, storage_version, metadata,
         message_count, usage_payload, next_seq);        -- one row per Session
```

Triggers enforce the shared entry/usage id namespace and ordered parent insertion at the storage level. No pre-WP01 format-4 SQLite file is supported; migration machinery belongs to R11.

One `commit()` is one SQL transaction: insert entries and ledger rows, replace/delete scalar values, insert/whole-list-delete list elements, maintain the branch index, bump session stats (`message_count`, aggregate `usage_payload`). Never update or delete an entry or ledger row; mutability is confined to values/lists, the branch index, stats, sequences, and the catalog row. List paging is `SELECT seq, value FROM list_values WHERE namespace = ? AND key = ? AND seq > ? ORDER BY seq ASC LIMIT ?` (descending symmetric; omit the predicate without a cursor); assert via `EXPLAIN QUERY PLAN` that it uses the primary key with no temporary sort.

**Every transaction that may write must open with `BEGIN IMMEDIATE`.** A deferred `BEGIN` that reads before writing takes a read snapshot and must later upgrade to the write lock; if another writer committed in between, SQLite fails the upgrade — and `busy_timeout` cannot rescue it, because waiting cannot refresh a stale snapshot; the only recovery is rollback and full retry. Every commit reads the session row's `next_seq` before writing, so a read precedes a write in every writing transaction; branch creation (§2.6) also reads the newest compaction before inserting. Coherent read-only snapshot transactions — fork capture (§2.7) — may use a deferred `BEGIN` read transaction; they never upgrade to a write. The old blanket wording covered every transaction and conflicted with its own read-only fork rule; this narrows the rule to the source behavior without weakening any write path.

**Session ownership is host-authoritative.** Exactly one worker normally owns a writable Session; create/fork administration may own a destination only until it closes that Session and hands metadata to the worker. Memory, JSONL, and SQLite do not detect a second process opening the same Session for writes; bypassing the server/worker lifecycle is a trusted-host defect. SQLite has no lease, fence, heartbeat, or replacement ownership primitive. A repository still rejects duplicate writable handles and reserves create/open/fork/delete destinations it owns in one process. The host closes a worker before deletion; shared-container deletion removes only that Session's rows in one `BEGIN IMMEDIATE` transaction, while per-file deletion removes its database and WAL/SHM sidecars.

Database access has three explicit modes: intentional create-or-open, no-create read-write, and no-create read-only. Metadata `open` and deletion use no-create read-write access; listing and external fork sources use no-create read-only access, so missing paths never become empty databases. Writable `open`/`delete` metadata must resolve to the repository-affine physical path. A foreign fork source is instead read from its exact physical path and can never alias an active local source with the same Session ID.

Read-only fork access may overlap the worker: WAL permits the server's repository to capture a live worker-owned source while the worker continues committing. Every source uses an independent read-only connection and one deferred read transaction that never upgrades or claims writable authority; it validates the Session row and storage version inside that transaction and sees every source transaction wholly before or wholly after its snapshot boundary. For a same-repository open source, the reader opens first and a short callback on the source commit queue begins the transaction and establishes its snapshot before releasing the queue. WAL frames become visible only when the commit record lands, so no fork sees part of a commit. Selected rows stream into a temporary on-disk staging database while the source reader remains open; after that reader closes, the stage streams into one destination `BEGIN IMMEDIATE` transaction and is removed in `finally`. Later source commits may complete while staging. Repository close seals admission, starts every open Session close, waits for all to settle, and reports one error directly or several in an `AggregateError`.

Each physical segment of `scanBranch` uses one JOIN (§2.6 combines segment ranges):

```sql
SELECT e.id, e.parent_id, e.seq, e.type, e.custom_type, e.timestamp, e.payload
FROM branch_entries b
CROSS JOIN entries e ON e.id = b.entry_id
WHERE b.branch_id = ? AND b.entry_seq > ? AND b.entry_seq <= ?
ORDER BY b.entry_seq;
```

`CROSS JOIN` is required: it forces `branch_entries` as the outer loop; left alone the planner may drive from `entries`, scan it, and sort through a temp b-tree. Assert the plan in a test (`SEARCH b USING COVERING INDEX ix_be_seq …`, then `SEARCH e USING PRIMARY KEY`); any plan with `USE TEMP B-TREE FOR ORDER BY` or an `entries` scan is a regression. `scanBranchStructure` is the same query without the payload column; `getEntries` is a primary-key `IN (...)` lookup.

In per-session-file mode a precise rewrite (§2.9) may build a fresh database (`VACUUM INTO` or row copy over one read snapshot) and atomically swap it over the old path, like JSONL. A shared-container rewrite/fork copies only the selected Session's rows and must not rewrite unrelated Sessions. Fork staging writes to a separate temporary file in both layouts; precise-rewrite tooling remains administrative future work.

## 1.8 Why write-once plus values and lists

Consequences relied on throughout: attachment is bounded (fixed projection point reads per lane, §4.4; one compaction-bounded watch scan plus exact state-directed reads, §5.4; the only reducer on a durable path is pi-ai's frame reducer over one exact bounded list, §3.7); crash states are enumerable — between transactions, never inside one; cleanup is deletion, not collection — a 30-turn run replaces `operationState` ~30 times then deletes it, leaving exactly the conversation, ledger, and a few lane/session values (JSONL defers physical reclamation to J1; logical state is identical); recovery never repairs by rewrite — it appends entries and replaces only values it owns with the same transitions normal execution would commit, so interrupting and rerunning gives the same result; readers never see partial state. Staging writes are deliberate: queued content serializes into `pi.pending.entry` at enqueue and again into its entry at placement; finalized tool outcomes stage before source-ordered materialization, preventing a completed parallel effect from replaying after a crash; assistant settlements are born placed, their frames dying atomically with settlement. Staging always has one owner and dies atomically with placement or cleanup.

---
# Part 2 — The conversation tree

## 2.1 Entries

An **entry** is the complete stored row (§1.1): placement fields and payload together. `getEntries` and the scans return exactly what was committed — no materialization step, no join.

```ts
interface MessageEntry extends EntryBase {
  type: "message"; message: AgentMessage; terminate?: true;
}
interface CompactionEntry extends EntryBase {
  type: "compaction"; summary: string; retainedTail: AgentMessage[];
  tokensBefore: number; details?: JsonValue; usage?: Usage; fromHook: boolean;
}
/** fromId: the summarized branch's pre-navigation tip — the producing
    operation's sourceTipId (§3.10) — or null when that source is the root. */
interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary"; fromId: string | null; summary: string;
  details?: JsonValue; usage?: Usage; fromHook: boolean;
}
interface CustomEntry extends EntryBase {
  type: "custom"; customType: string; data?: JsonValue;
}
type Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry;
```

Rules: `type`/`customType` are structural fields — branch queries filter on them and the branch index denormalizes them (§2.6); `customType` is set exactly on custom entries; payload fields never drive structure. Assistant entries always contain a `SettledAssistantMessage` — reject `pending` before writing. Tool-result entries carry `terminate?: true`, orchestration state `ToolResultMessage` has no field for. Every compaction and branch summary carries `fromHook` (`true` = hook output, `false` = generated). Every compaction stores a complete `retainedTail` (`[]` when empty); **context never reads past a compaction** — a compaction is a self-contained checkpoint, not a pointer into history. Only a custom entry may lack `data`. Payloads are inline; two entries never share stored content and there is no deduplication layer.

## 2.2 Placement

> An **entry** is created, complete, when placement happens. Content durable *before* placement is current mutable state waiting in a `pendingEntry(id)` value; the placement transaction writes the entry and deletes the pending value. Neither is modified after that.

**Born placed** — assistant responses and direct appends to an idle lane; content and placement arrive in one transaction (`TX[ insert entry, upsert pi.branch.tip ]`).

**Content first — queued input.** `steer`, `followUp`, `nextRun`, and deferred tree writes mint the entry id at enqueue and construct `pendingEntry(id)`; queue state references content by that id, and the two transactions may be far apart:

```text
t0  TX[ upsert pi.pending.entry/e_q1 = { type: "message", payload: <200KB message> },
        S(next){ ...inbox.steer += "e_q1" } ]
t1  TX[ insert e_q1 (parent e_a3), delete pi.pending.entry/e_q1,
        upsert pi.branch.tip/main = "e_q1", S(next){ ...inbox.steer -= "e_q1" } ]
```

Crash before `t1`: still queued; after: placed, pending value gone. Until placement or cancellation exactly one of pending value and entry exists; cancellation deletes the value and the content never enters the tree (§3.11).

**Content first — finalized parallel tool outcomes.** A tool result id begins as a plain reserved string in `pi.op.state`. When execution and `after_tool` finish, the complete final `ToolResultMessage` is staged in `pendingEntry(resultEntryId)` and the call becomes `outcome_ready`; it enters the tree only when every earlier source position is ready (`t0`: stage + `outcome_ready`; `t1`: insert after the earlier result + delete pending + `completed`). Effects settle in completion order while entries materialize in assistant source order. Crash before `t0`: uncertain effect; after `t0`: never re-executed; after `t1`: immutable entry.

**Id reserved before content exists.** Assistant response, tool-result, and usage ids are minted as strings in operation state. Assistant settlement places its result directly; during the effect window the reserved response id also keys the auxiliary frame list, which settlement deletes (§3.7).

Consequences: a queued or outcome-ready item is invisible to tree queries but visible through its owning state and `pendingEntry(id)`; queue placement/cancellation and outcome-ready materialization delete `pi.pending.entry` atomically with their state change; a reserved tool-result id moves through `string only → pi.pending.entry → immutable entry` with no two representations coexisting at a commit boundary; queued input pays the deliberate double-write (§1.8), and finalized tool outcomes stage once before placement when source ordering requires it — the extra write that prevents completed parallel effects from replaying after a crash.

## 2.3 Branches and AgentLanes

A `Branch` is data for one named path through the tree; it exists exactly when its tip value `pi.branch.tip/{name}` exists (entry id or `null`). A Branch owns only its tip, branch-relative queries, and direct append — a raw append always inserts at the current tip and moves the tip in one Session mutation. It has no model, queues, operation state, hooks, or execution policy.

A configured `AgentLane` is a Branch plus total agent state: `pi.lane.config/{name}` (`LaneConfiguration = { model: { provider, modelId }, thinkingLevel, activeToolNames }`), `pi.lane.state/{name}` (`LaneState`, §3.3), and one `pi.result/{operationId}` per terminal operation.

`AgentHarness.lane(name, options?, context)` is atomic get-or-create: a missing Branch writes its tip, the immutable Harness seed configuration, and idle lane state together; a data-only Branch receives configuration and idle state without moving its existing tip; a complete AgentLane returns unchanged; partial combinations fault as corruption. Concurrent acquisitions publish and return one process-local AgentLane. A fresh Session/Harness may have no Branches or AgentLanes; `main` is created only when explicitly acquired. During an active run, AgentLane append methods preserve operation-aware deferred-write semantics; a raw Branch append remains direct, and mutating that raw Branch while a Harness owns its lane is a trusted-programming defect.

## 2.4 Session metadata and application values

Session name and entry labels are latest-wins values outside the tree (`sessionName`, `entryLabel(entryId)`, §1.3). `getName`/`setName` and `getLabel`/`setLabel` wrap them; passing `undefined` deletes, deleting an absent value is a no-op (§1.4); these writes commit immediately and never move a tip. Applications define their own stable collision-resistant addresses (`value<T>("my-app.state")`, `list<T>("my-app.events")`); there is no built-in application namespace or separate application-state API. Fork behavior is defined in §2.7; applications own their migration policy.

## 2.5 Branch queries and context

```ts
interface BranchScan {
  start?: string;           // required at Storage; Branch/AgentLane default to the receiver's tip
  stopAtType?: EntryType;   // scan ends after the first match, inclusive
  stopAtId?: string;
  type?: EntryType; customType?: string;
  order?: "newestFirst" | "oldestFirst";   // default newestFirst
  limit?: number;
  cursor?: { seq: number };                // EntryCursor
}
type StorageBranchScan = BranchScan & { start: string };
```

Semantics: take the path from `start` toward the root, order it (default `newestFirst`), stop **inclusively** at the first `stopAt` match, filter by `type`/`customType`, apply the exclusive cursor (`newestFirst` retains `seq < cursor.seq`, `oldestFirst` `seq > cursor.seq`), then `limit`. A `stopAt` entry is returned only if it also passes the filter. `stopAtType` applies after ordering — `oldestFirst` with `stopAtType: "compaction"` stops at the oldest compaction segment — so canonical context reads use `newestFirst` through the newest compaction and reverse the bounded result.

**Context projection** — how a provider request is built:

1. `scanBranch({ start: tip, order: "newestFirst", stopAtType: "compaction" })`.
2. Reverse to oldest-first. If a compaction terminated the scan, the context is its `summary`, then its `retainedTail`, then every entry after it. **Nothing earlier is read.**
3. Drop assistant responses whose stop reason is `error`, `aborted`, or `deferred`; retain genuine output-limit `length`.
4. Run custom entries through `entryProjectors`; an unprojected custom entry never enters context.
5. Run `transform_context`, then `toProviderMessages`.

An overflow response needs no dedicated omission rule: it is committed with stop reason `error` (§3.7) and dropped by rule 3.

**Append-only context invariant.** Across one lane's requests, provider context must only grow at the tail: an insertion before the previous request's tail invalidates the provider's KV cache and multiplies cost. This is why mid-run writes defer to checkpoints, where they append at the tail. Compaction is the one deliberate cache invalidation, traded for a smaller context.

## 2.6 The branch index

Memory and JSONL walk parent pointers in RAM. SQLite maintains a private segmented branch cache so a diverging append does not copy the full root prefix. `branch_entries` stores the entries physically present in one segment; `branch_meta` stores its tip and optional `{ baseBranchId, baseSeq }`. A segment logically contains its own rows above `baseSeq` plus the referenced base prefix through `baseSeq`.

Append: (1) if a branch tip equals the lane tip, append one row and move that tip; (2) otherwise resolve a branch that actually covers the tip, find the newest compaction at or below the tip through the complete segment chain, copy only rows after that compaction through the tip, and set the older prefix as the new segment's base; (3) append the new entry and make it the new segment tip.

**Known contradiction (open):** the copy bound is the newest compaction, so a first divergence from a long *uncompacted* transcript copies O(history) rows — the "no unbounded copy" goal is not met in that case. The implementation follows the compaction-bounded algorithm as written. Resolving this needs a segment representation that can reference a covering segment at the parent boundary (inventoried in `post-wp05-roadmap.md`); specification and representation must change together.

Read newest segment first; if the requested range crosses `baseSeq`, continue through the base chain with the upper bound capped at that boundary; merge segment results into the requested order before filtering/limiting. Two correctness rules are mandatory: the base branch must itself cover the tip within its logical range (containing the tip in an ancestor is insufficient), and the newest-compaction search must traverse the base chain (checking only the newest physical segment can miss it). The cache must preserve: a segment chain followed to its end yields the exact root path with no gaps or duplicates; all chains containing an entry agree below it; runtime reads never fall back to a table scan or parent walk; stale branches remain valid cache history; only an explicit repair operation rebuilds the cache from entries. Tests assert these invariants and the required query plans; no wall-clock threshold is normative.

## 2.7 Forks

A fork is a repository operation over one coherent source-storage boundary. Destination metadata records the source id as `parentSessionId`.

```ts
type ForkOptions =
  | { scope: "branch"; branch: string; entryId?: string;
      position?: "before" | "at"; id?: string }
  | { scope: "tree"; id?: string };
```

**Branch scope** requires the named source Branch to be a complete configured AgentLane: tip, configuration, and lane state must all exist. A missing tip is an unknown Branch; a data-only Branch rejects; a partial configuration/state pair, or lane values without a tip, is corruption. `entryId`, when supplied, must be on the named Branch's current-tip ancestry, inclusive; omission selects the current tip. `position` defaults to `"at"`; `"before"` selects the target's parent and may produce a `null` destination tip before a root entry. A `null` source tip is legal only with no `entryId`. The destination contains exactly that one Branch under the same name, its selected path and tip, copied configuration, and fresh idle lane state.

**Tree scope** copies every immutable entry, including entries unreachable from all current tips; every Branch tip; every configured lane's configuration plus fresh idle lane state under the same name; and every data-only Branch as data-only. A partial configuration/state pair or lane values without a tip is corruption and rejects instead of being dropped. A branchless source produces a branchless destination.

**Both scopes** copy the session name and labels only for copied entries. They exclude the usage ledger, `pi.result`, every `pi.op.*`, and every `pi.pending.*` value/list, including pending entries, tool checkpoints, and assistant frames. Destination usage starts at zero and `messageCount` counts copied message entries. Copied entries retain ids.

Application state follows scope rather than a historical sequence cutoff: tree scope copies every current application scalar and every surviving application list element; branch scope copies none. Current state has no replaced values or deleted list elements from which to reconstruct an earlier point, so filtering surviving rows by `seq <= selectedTipSeq` is forbidden. Applications re-derive branch-scoped state.

One closed core policy classifies every namespace. Session name copies; labels depend on copied-entry membership; branch/lane values are reconstructed coherently; operation, pending, and result namespaces exclude; application namespaces follow scope. Exact namespace `pi` and every otherwise-undeclared `pi.*` namespace reject only when current surviving scalar or list state exists. Replaced or deleted history is absent and cannot by itself reject a fork.

Copied entries, values, and list elements retain their source `seq`. Rewritten tips and fresh idle lane states reuse the source rows' current sequences, and destination `nextSeq` equals the source high-water mark so no sequence can be reused. Memory constructs destination state directly at its commit-queue boundary. JSONL captures a fixed read-only file prefix and uses bounded disk-backed passes without mutating the source. SQLite establishes an independent read snapshot, streams into a temporary staging database, closes the source reader, then publishes the stage in one destination transaction. Later source commits are wholly outside that fork.

## 2.8 Session and repository boundary

`Storage` is one-session only. `Session` owns global metadata, values/lists, entry and usage queries, Branch discovery/creation, one mutation line, and one backend lifecycle; it does not implement Branch and has no implicit main. Full declarations: `session/types.ts`. The surface, by group (every asynchronous method takes a trailing `Context`):

- **`SessionReader`** (implemented by Session and mutation capabilities): `getEntries(ids)`, `getStats()`, `getValue(address)`, `scanValues(prefix)`, `readList(address, options?)`, `scanBranch(query: StorageBranchScan)`.
- **`SessionMutation extends SessionReader`**: `commit(writes)` — zero or one attempt, does not release — and `end()` — waits for any admitted commit, invalidates, releases. `SessionMutator = Omit<SessionMutation, "end">`.
- **`Branch`**: `name`, `getTipId()`, `findEntries(query?: BranchScan)`, `findEntry(query?: BranchScan)`, `appendMessage(message)` and `appendCustomEntry(customType, data?)` (both return the new entry id).
- **`Session<M extends SessionMetadata>` extends SessionReader**: `metadata`, `idGenerator: { next(timestampMs?) }`, `getEntry(id)`, `findEntries`/`findEntry` (session-wide `EntryQuery`: `type?`, `customType?`, `order?: "asc"|"desc"`, `limit?`, `cursor?`), `getName`/`setName(name | undefined)`, `getLabel`/`setLabel(targetId, label | undefined)`, `branch(name)`, `createBranch(name, at)`, `beginMutation()`, `mutate(callback)`, `setValue`/`deleteValue`/`appendList`/`deleteList`, `close()`.

All supported mutations serialize on one keyless Session line (§4.3). `beginMutation()` is the explicit scope; **every direct `beginMutation()` caller must call `end()` in `finally`**. `Session.mutate()` is the callback convenience and always ends in `finally`; normal harness/plugin code uses `mutate`. Ordinary Session and Branch reads bypass the line: each read observes the latest fully applied commit, but several reads are not a snapshot — use `mutate()` for coherent read-decide-write.

**C1 — raw RemoteSession (contradiction, decision required).** The begin/read/commit/end lifecycle was specified as the RemoteSession transport contract: a worker runs its local callback and publication while the server holds the sole concrete Session line, then sends end; disconnect or timeout terminates that scope; no caller-selected lane key exists. No implementation, protocol schema, client facade, server-held scope, worker adapter, or conformance test exists — the shipped product deliberately deleted raw `RemoteSession` in favor of process-local Session plus routed semantic services. C1 (Part 8, roadmap) must decide whether to implement or retire this contract; if C1 commissions a remote Session, it must preserve the same read → decide → commit → process-local publication → end order (invariant 38). Until decided, treat the remote lifecycle as specification under dispute, not current behavior.

A repository creates only metadata/header/catalog state: no Branch, configuration, or lane state. `createBranch` validates name, absence, and a non-null target atomically and writes only the tip. `SessionRepo` exposes `create`, `open`, `list`, `delete`, and `fork` with implementation-specific metadata/list-option generics.

### Search

**S3 — design only, not implemented.** The current `src/search/index.ts` exports a draft `SessionSearchService` skeleton (`sync()`, `notify()`, array-returning `searchEntries()`) that conflicts with this design and has no implementation; S3 must reconcile the public API before implementing. The design:

Search is a **standalone service with its own store**; the repository knows nothing about it and exposes no search methods. A sync utility consumes `repo.list()` and read-only session opens to feed the index store; applications construct the service, run sync at startup or on a schedule, wire the notify utility to their event stream for freshness, query the service directly, and call `search.remove()` alongside `repo.delete()` (or leave stale rows to the next reconciliation). Callers join metadata and fetch entries through the repository they already hold. Draft interfaces: `SessionSearchHit { sessionId, entryId }`; `SessionSearchOptions { entryTypes?, limit?, signal? }`; `SessionSearch<T>.search(text, options?): AsyncIterable<T>`; `SessionSearchService { searchSessions({ text, limit? }): Promise<SessionSearchResult[]>; searchEntries?: SessionSearch; remove(sessionId); close() }` (`limit` counts sessions; `SessionSearchResult { sessionId }`; display services may extend hits/results with `timestamp`, `snippet`, `score`, `top`); catch-up targets implement `SessionSearchSyncTarget { getCursor(sessionId, storeGeneration), indexBatch(batch), remove(sessionId) }` with `SearchIndexBatch { sessionId, storeGeneration, fromSeq, toSeq, entries: { entryId, seq, text, timestamp }[] }`.

**Indexing is pull-based; events are only hints.** The store keeps a durable cursor per session — the highest entry `seq` indexed. Sync enumerates sessions via the repository (old, new, copied files alike), reads `scanEntries({ fromSeq: cursor + 1 })`, indexes message-entry text idempotently per `(sessionId, entryId)`, and advances the cursor in the same store transaction; a crash mid-batch re-indexes into the same state, and years of existing sessions catch up with the same loop. Notify carries no content — a poke triggering a debounced pull; a lost poke is caught by the next sweep. The index is a rebuildable projection with zero authority; indexing failures never affect the harness or commits. Reading a Session its worker writes is legal through the backend's read-only path: host lifecycle prevents a second writable owner, and WAL gives cross-process snapshot reads. The precise rewrite (§2.9) may renumber seqs, so cursors key on `(sessionId, storeGeneration)`; the rewrite bumps a generation counter and a mismatch triggers full re-index. Reference implementation: one standalone SQLite database — an FTS5 table over `(session_id, entry_id, text)` plus the cursor table — working unchanged over JSONL session files; several processes may share it (WAL, `busy_timeout`, `BEGIN IMMEDIATE`, idempotent rows, monotonic cursor updates; writers serialize).

**Open question — metadata filtering.** Coding-agent's resume flow filters by `cwd`; other repositories have no cwd concept, and search options are deliberately generic. Candidates: (a) typed filter passthrough (service generic over each repo's filter vocabulary); (b) pre-restrict via the repo's own listing, passing a possibly huge candidate id set; (c) post-filter in the app — **unsound**, filtering after ranked `limit` drops results; (d) index chosen metadata fields at sync time and filter natively, coupling the service to those fields and requiring re-sync when they change. Settled with S3.

## 2.9 The precise rewrite

Entries and usage rows are never deleted (§1.2); the sole sanctioned exception is the **precise rewrite**: an administrative repository operation that copies the retained set — entries, usage rows, semantic values, lane values, immutable result records — into a fresh session store over a coherent snapshot, exactly as a fork does, then atomically swaps it for the old store. Its keep-predicate can express what no runtime mechanism may: compliance-grade erasure (including content copied into `retainedTail`s and summaries), pruning abandoned branches, re-minting legacy-format ids (Appendix B). It is tooling above the harness — no harness surface exposes it, no core rule depends on it, and **no implementation exists**.

Result records are retained even when the rewrite removes an entry named by `fromTipId`/`tipId`; those pointers then deliberately dangle — the record's identity, kind, terminal status, error, and times remain valid while transcript dereference reflects the erasure. Rewrites do not silently delete or mutate immutable operation dispositions.

# Part 3 — The operation state machine

## 3.1 Operations

```ts
interface OperationMeta {
  operationId: string;
  lane: string;
  sourceTipId: string | null;    // lane tip before acceptance
  startedAt: number;
  intent:
    | { kind: "run"; promptEntryIds: string[] }
    | { kind: "compaction"; customInstructions?: string }
    | { kind: "navigation"; targetId: string | null; summarize: boolean;
        label?: string; customInstructions?: string };
}
```

`OperationMeta` is immutable acceptance data: written once, paired with one complete `operationState(operationId)`, deleted by the terminal transaction (§3.13). For runs, `promptEntryIds` names only normalized request messages; queued items captured by acceptance and later hook messages are not prompt intent. An operation id may be supplied or minted before acceptance; it correlates a host submission with `inspectExecution`, `drive`, and the result record but is not an unbounded acceptance-idempotency index. The process-local operation `{ meta, state }` is never stored as one object.

## 3.2 Operation state — the durable restart point

`operationState(operationId)` holds one member of a flat 13-leaf union; every transition replaces the complete value; there is no finished state — terminal completion deletes it. Full fields: `session/types.ts`. The shared shapes:

```ts
type Control = { status: "running" } | { status: "cancel_requested"; requestedAt: number };

interface OperationScope {           // carried by every leaf
  control: Control;
  settings: { compaction: CompactionSettings; steeringMode: QueueMode;
              followUpMode: QueueMode; toolExecution: "sequential" | "parallel" };
  latestAssistantEntryId: string | null;
}

type Continuation =
  | { kind: "need_assistant"; overflowRecoveryUsed: boolean }
  | { kind: "may_finish"; includeFinalAssistant: boolean };
interface CheckpointData { continuation: Continuation; triggerEntryId: string }

type ResultBoundary =
  | { kind: "resume_checkpoint"; resumeAfter: CheckpointData }
  | { kind: "finish" }
  | { kind: "commit_navigation"; targetId: string; label?: string };
interface SummaryTask {
  taskId: string; reason?: "manual" | "threshold" | "overflow";
  customInstructions?: string; boundary: ResultBoundary;
}

type OperationState =            // at:
  | StartingOperation                    // "starting"
  | CheckpointOperation                  // "checkpoint"
  | AssistantReadyOperation              // "assistant.ready"
  | AssistantEffectPendingOperation      // "assistant.effect_pending"
  | AssistantRetryWaitOperation          // "assistant.retry_wait"
  | ToolsOperation                       // "tools"
  | DeferredSuspendedOperation           // "deferred.suspended"
  | DeferredEffectPendingOperation       // "deferred.effect_pending"
  | SummaryDecidingOperation             // "summary.deciding"
  | SummaryReadyOperation                // "summary.ready"
  | SummaryEffectPendingOperation        // "summary.effect_pending"
  | SummaryRetryWaitOperation            // "summary.retry_wait"
  | NavigationReadyToCommitOperation;    // "navigation.ready_to_commit"
```

The four `summary.*` leaves carry one `SummaryTask`; summary kind is derived from the closed boundary union, never duplicated. `ToolBatch`/`ToolCall` remain a nested child state machine because parallel children genuinely settle concurrently — a `ToolCall` is `{ sourceIndex, resultEntryId }` plus `planned | effect_pending{replay} | outcome_ready{terminate} | completed{terminate}`. Large content stays at referenced sibling addresses; state contains only bounded policy and the ids required to dispatch and recover. A live procedure's JavaScript continuation is finer-grained than the durable leaf: after `assistant.effect_pending` commits, a live process awaits the provider; after process loss, the same leaf means unknown-outcome recovery.

## 3.3 Lane state and the restore projection

```ts
interface LaneState {
  currentOperationId: string | null;
  lastOperationId: string | null;
  inbox: Array<{ entryId: string; kind: "steer" | "followUp" | "nextRun" | "write" }>;
}
```

Attachment reads `branchTip`, `laneConfig`, and `laneState` per configured lane; if `currentOperationId` names O, also `operationMeta(O)` and `operationState(O)`. It validates required existence, lane/id agreement, and intent-to-leaf reachability. It never reads `operationResult`: `lastOperationId` is only an observation pointer.

The restored process-local projection is authoritative while the Harness owns the Session; every supported mutation commits on the Session mutation line and publishes the matching projection before releasing it. Attachment does not dereference transcript, inbox payloads, deferred sources, frames, tool arguments/checkpoints/memos, preparations, or staged outcomes — `watch` and drive procedures validate those references when they consume them (§4.4). Missing optional frame lists and tool checkpoints are legal; contradictory required content faults its consumer.

## 3.4 The atomic transition rule

> Compute one complete next state in memory, then atomically commit every entry, usage row, value/list write, and projection change that makes it true.

`Lane.state` supplied by the Session mutation line is the control authority. Drive procedures never reread `laneState`, `operationMeta`, `operationState`, `branchTip`, `laneConfig`, or `operationResult` to choose work; storage reads dereference ids named by current state or enumerate operation-owned cleanup addresses. §4.1's single-writer rule follows: concurrent inbox calls change only `LaneState.inbox` and `requestAbort` only `control` (draining selected inbox tags), so settlement preserves current inbox/control fields; parallel tool children retain child-status fencing. Providers, tools, hooks, timers, and event delivery run outside mutation callbacks.

## 3.5 The graph

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> starting : accept run
    idle --> summary_deciding : accept compaction / summarized navigation
    idle --> navigation_ready : accept unsummarized navigation

    starting --> checkpoint : before_run consumed
    checkpoint --> assistant_ready : need assistant / selected input
    checkpoint --> summary_deciding : threshold preparation
    checkpoint --> terminal : may finish

    assistant_ready --> assistant_pending : request intent
    assistant_pending --> assistant_retry : retryable error
    assistant_retry --> assistant_ready : retry elapsed
    assistant_pending --> tools : tool calls
    assistant_pending --> deferred_suspended : deferred handle
    assistant_pending --> summary_deciding : overflow preparation
    assistant_pending --> checkpoint : settled response

    tools --> tools : child intents/outcomes/placement
    tools --> checkpoint : batch placed

    deferred_suspended --> deferred_pending : one poll permit
    deferred_pending --> deferred_suspended : still pending
    deferred_pending --> tools : ready with calls
    deferred_pending --> checkpoint : ready without calls / terminal response

    summary_deciding --> summary_ready : hook selects generation
    summary_ready --> summary_pending : request attempt
    summary_pending --> summary_retry : retryable attempt
    summary_retry --> summary_ready : retry elapsed
    summary_deciding --> boundary : decline / hook result
    summary_pending --> boundary : generated result / terminal failure
    boundary --> assistant_ready : resume checkpoint with selected input
    boundary --> checkpoint : resume may-finish resting point
    boundary --> terminal : standalone finish / navigation commit / run failure

    navigation_ready --> terminal : move/label commit
    terminal --> [*]
```

`terminal` and `boundary` are explanatory nodes, not durable leaves. Every summary result switches once on `ResultBoundary`: resume an enclosing run, finish standalone compaction, or atomically commit navigation. Cancellation is orthogonal; before ordinary dispatch it routes every one of the 13 leaves to reconciliation (§4.6).

## 3.6 Acceptance

`accept(request, context)` normalizes immutable input off the mutation line, then performs one acceptance command: check the lane is idle, validate durable inputs, commit metadata plus the initial leaf, publish events, return `OperationAdmission`. It installs no Drive and invokes no hook, provider, tool, timer, or process owner. Run acceptance selects eligible items from the lane's one ordered inbox:

| Tag | Idle acceptance |
|---|---|
| `write` | all |
| `nextRun` | all |
| `steer` | all or oldest according to `steeringMode` |
| `followUp` | all or oldest according to `followUpMode` |

Selected items place in global admission order regardless of tag; request prompt entries are newer and follow them. Selection deletes each `pendingEntry(id)` and removes only selected inbox ids in the same transaction; mode remainders and late admissions stay queued. An empty public prompt is valid only when captured queued content places at least one conversational message — the ordinary continuation-run acceptance used after structural convenience operations.

| Request | Initial durable leaf and acceptance writes |
|---|---|
| prompt, skill, template | selected queued entries + normalized prompt entries; `OperationMeta`; payload-free `starting`; lane current id |
| compaction | durable preparation + `OperationMeta`; `summary.deciding` with boundary `finish`; lane current id |
| summarized navigation | preparation + `OperationMeta`; `summary.deciding` with boundary `commit_navigation`; lane current id |
| unsummarized navigation | `OperationMeta`; `navigation.ready_to_commit`; lane current id |

Structural preparation may run outside the mutation line, but the acceptance command revalidates the observed source tip and idle state before committing. Pre-acceptance failures write nothing: busy lane, empty/invalid message, missing skill/template, nothing to compact, invalid navigation, unknown target; model/tool registry availability is checked only at the later effect boundary. `starting` is consumed by the Drive after the cancellation check and `before_drive`; `before_run` runs off-line, and one commit places its injected messages and enters `checkpoint` — a crash before that commit may repeat the hook, a crash after it cannot. Concurrent accepts serialize on the Session line (loser: `LaneBusy`); a crash after acceptance leaves an open initial leaf that only a later `drive` advances.

## 3.7 Assistant generation

Four phases: read compaction-bounded context and resolve captured model/tools → run `before_request` and commit `assistant.effect_pending` with response/usage ids → admit and consume the provider stream → commit response entry + usage + frame cleanup + one classified successor.

The request identity is the stable lane identity `Session metadata id + ":" + lane name` (§5.7). The intent snapshots the lane configuration, stream options, retry policy, trigger, and overflow-recovery flag. An unavailable captured model or configured tool fails terminally before intent with a machine-readable configuration error and no fabricated response or usage.

Settlement commits the complete response entry, usage row, branch tip, deletion of `pendingAssistantFrames(O, R)`, and exactly one successor:

| Settled response | Successor |
|---|---|
| accepted tool calls | `tools` with reserved result ids |
| retryable error with attempts remaining | `assistant.retry_wait` |
| first overflow with preparation | `summary.deciding` with `resume_checkpoint` |
| valid deferred handle | `deferred.suspended` |
| stop or genuine output-limit length | `checkpoint{may_finish}` |
| terminal error, exhausted retry, invalid deferred handle, second overflow, or empty overflow preparation | terminal failed result |

A retry timer runs off the mutation line and enters `assistant.ready` only after `notBefore`; cancellation or close wins without starting another request. Every response/usage/decision lands together or none does.

### Streamed frame persistence

During an admitted assistant or deferred effect, one `AssistantMessageFrameEncoder` converts provider events to compact recovery frames. A convertible event synchronously enqueues one invocation-fenced append to `pendingAssistantFrames(operationId, responseEntryId)` and emits the corresponding live message event. The provider loop never awaits storage per frame; Session FIFO preserves order, every promise carries fault observation, and settlement awaits the latest queued frame write before `after_response` and the final commit.

Each append checks the same response id is still effect-pending: an append admitted before settlement may commit first; one reaching the line after settlement declines and cannot recreate the list. Frames are auxiliary — absence is legal, they do not prove request completion, and a complete-looking prefix still restores as unknown outcome until settlement commits. Recovery reduces the exact list with `reduceAssistantMessageFrames`, synthesizes the documented partial result, and deletes the list with its next durable decision. Structural summary streams intentionally persist no frames. JSONL records the appends physically until snapshot compaction (J1) even after logical deletion. The [mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md) replaces this path with tracked pending output in ephemeral scoped storage while preserving unknown-outcome recovery.

### Classification order

First match wins:

1. current durable control is `cancel_requested` → normalize to `aborted`; reconciliation terminalizes it as aborted;
2. adapter-reported or recognized context overflow → normalize to `error`; enter one overflow summary, or terminal-fail if recovery was already used;
3. valid deferred handle → suspend; invalid handle → terminal failure;
4. retryable error with attempts remaining → retry wait; otherwise terminal failure;
5. accepted tool calls → tools;
6. stop or genuine output-limit length → `checkpoint{may_finish}`.

Overflow is checked before retryability. Error, aborted, and deferred assistant entries remain durable history but are omitted from future provider context by §2.5. A genuinely truncated response carrying calls produces synthetic error tool results rather than executing potentially corrupted arguments.

## 3.8 Tools

Tool execution separates effect completion from source-ordered tree placement:

| From | Trigger | Transaction | To |
|---|---|---|---|
| call _i_ `planned` | clearance passed (`before_tool`, lookup, arg validation) | `TX[ upsert pi.op.tool_args/O:{stepId}:{i} = effective args, S(call i = effect_pending, replay) ]` | dispatch |
| call _i_ `effect_pending` | tool calls `onUpdate(partial, { checkpoint:true })` | `TX[ upsert pi.pending.tool_output/O:{resultEntryId} = partial ]` after invocation fencing; state unchanged | `effect_pending` |
| call _i_ `effect_pending` | effect settled; latest update delivery and latest checkpoint write awaited; `after_tool` applied | `TX[ upsert pi.pending.entry/{resultEntryId} = finalized result, delete pi.pending.tool_output/O:{resultEntryId}, delete pi.op.tool_memo/O:{resultEntryId}:*, S(call i = outcome_ready, terminate) ]`, with post-commit `tool_end` | `outcome_ready` |
| call _i_ `planned` | unknown tool / invalid args / `before_tool` blocks or throws / control cancelled | `TX[ upsert pi.pending.entry/{resultEntryId} = complete synthetic result, S(call i = outcome_ready, terminate) ]`, with post-commit `tool_start` followed by `tool_end`; no effect intent | `outcome_ready` |
| source-ready prefix | first non-completed calls are `outcome_ready` | `TX[ insert result entries in source order, delete their pi.pending.entry values, insert reported usage, upsert pi.branch.tip, S(calls = completed / next checkpoint) ]` | `completed` or checkpoint |

**Updates and checkpoints.** Every `onUpdate` is a process-local `tool_update` observation: the synchronous callback emits the event and retains the latest delivery promise internally; tools neither receive nor await it. `checkpoint:true` additionally requests replacement of the invocation's bounded durable progress snapshot: each such call synchronously enqueues one invocation-fenced value replacement on the mutation line, attaches the ordinary harness-fault observer, and replaces only the process-local latest checkpoint-write promise reference. No checkpoint write is dropped or coalesced; Session FIFO preserves request order, and each mutation verifies the same call is still `effect_pending` when it executes. The tool alone controls cadence, duplicate suppression, and bounding — requesting checkpoints faster than storage commits queues memory under the trusted-tool contract, and the API imposes no generic byte cap or truncation. When the tool promise settles, the harness stops accepting updates and closes checkpoint admission; a late request returns without committing. Before `after_tool`, the procedure awaits the latest update-delivery promise **and** the latest checkpoint-write promise — each implies completion of everything earlier in its queue. Checkpoint writes order before outcome staging, and staging deletes the value; a failed checkpoint commit follows the ordinary storage-fault path and prevents staging.

**Staging.** Outcome staging is the point after which the tool can never replay. After `after_tool`, the procedure constructs the complete canonical final result — bounded independently of progress snapshots — and stages its `ToolResultMessage`; the state carries only `terminate` and the reserved id. The staging commit publishes `tool_end` after committed state is installed, so that event is durable evidence that the call is `outcome_ready`. For a fresh synthetic call, the same staging commit publishes `tool_start` followed by `tool_end`; it never crosses the external tool-effect boundary or runs `after_tool`. Tool-reported usage stays inside the staged message until materialization, where its ledger row commits atomically with the entry; added tool names likewise become active from the materialized transcript point, never from invisible staging.

`tool_start`/`tool_end` bracket public processing of a fresh call and finalized-result availability, not necessarily an external effect. Historical events are not replayed: an unsafe restored `effect_pending` call is represented as running by the initial snapshot and may emit only a recovery-tagged `tool_end` when its interruption result stages. A safe replay's checkpoint-clear commit publishes its recovery-tagged `tool_start`; its staging commit later publishes `tool_end`.

After any outcome stages, the procedure materializes the contiguous `outcome_ready` prefix from the first non-completed source position; several results may enter the tree in one transaction, each parented to the previous inserted result. When the final call materializes, the same transaction deletes the addresses from `scanValues(operationToolArgsPrefix(O, stepId))` and chooses: **every** completed call set `terminate: true` → `checkpoint{may_finish, includeFinalAssistant: false}`; otherwise `checkpoint{need_assistant(overflowRecoveryUsed: false)}`. `terminate` lets a tool end the run without another provider turn (a "submit final result" tool in place of structured output); the result record still embeds no message payload.

Modes: **sequential** — clear → intent → execute → finalize → stage → materialize, one call at a time; **parallel** — clearance and intent in source order, effects and post-effect hooks settle independently, each complete outcome stages immediately in completion order, tree materialization stays source ordered.

Blocked and invalid calls skip intent/execution but still stage a synthetic outcome. A missing tool implementation is the ordinary unknown-tool case: stage an `isError:true` `ToolResultMessage` saying the named tool is unavailable, then continue the batch and later assistant turn; the harness constructs that message directly, omits `details`, and must not invent a value for the tool's typed details contract. A crash before staging reruns ordinary clearance, including `before_tool` under its replay contract; a crash after staging never reruns the hook or tool.

Calls are tracked internally by `sourceIndex` (position in the assistant message's complete content array); hooks and events see provider `toolCallId` and tool name. A provider `toolCallId` is unique only within its tool-call batch and may be reused by a later assistant message. `AgentHarnessToolInvocation.invocationId` equals the reserved session-unique `resultEntryId`, is stable across safe replay, and scopes durable memos under `operationToolMemo(O, invocationId, name)`. Memo names must be non-empty with no `:`; `setMemo(name, undefined)` deletes. Memo operations synchronously enqueue on the mutation line before returning their promises, and tools must await writes; each job verifies the same effect-pending invocation when it executes, so a queued memo write cannot outlive staging. A pre-return write is FIFO-ordered before staging and then deleted by it; a post-return call rejects after capability expiry; no separate write drain exists. Flue-style named effect memoization (`step.do(name, effect)`) awaits these operations: a committed value returns on replay, while a crash before its memo commit may rerun the effect. There is no nested per-step replay state and no exactly-once external-effect promise.

## 3.9 Summary generation — compaction and navigation summaries

Compaction and navigation summaries share one durable quadruple, `summary.deciding → summary.ready → summary.effect_pending ↔ summary.retry_wait`. `SummaryTask.boundary` determines semantics:

| Boundary | Use | Successful publication |
|---|---|---|
| `resume_checkpoint` | threshold/overflow inside a run | compaction entry, then one atomic boundary plan for queued input and run continuation |
| `finish` | standalone compaction | compaction entry plus terminal compaction result |
| `commit_navigation` | summarized navigation | move, summary entry, optional label, and terminal navigation result in one commit |

Preparation is immutable content stored at `operationPreparation(operationId, taskId)` in the same transaction that enters `summary.deciding`; `before_compaction` runs off-line. A decline, hook-supplied result, generated result, model absence, or terminal generation failure all meet at one boundary switch; cancellation never takes a boundary continuation.

If generation is selected, `summary.ready` captures configuration, stream options, retry policy, and result id. Each nested provider request has its own durable request/usage intent inside `summary.effect_pending`, and its usage commits before another nested request begins. Structural request options force `cacheRetention: "none"` and a fresh request identity; structural streams emit no assistant-message lifecycle and persist no frames. A lost effect-pending attempt is unknown and retries under the captured policy; committed attempt usage remains in the ledger.

Threshold compaction is guarded by transcript recency: it runs only when `shouldCompact` is true and the newest compaction entry is older than the checkpoint trigger, so a successful compaction is its own durable marker; decline never commits back to the threshold-checking checkpoint, so no extra checked flag exists.

Overflow trace: assistant settlement normalizes the response to `error` + usage + overflow preparation → `summary.deciding{boundary: resume_checkpoint{need_assistant(true)}}`; summary attempts run intent → effect → usage/result; publication commits the compaction entry + selected write/steer items + `assistant.ready` in one commit. The overflow response remains durable but is excluded from summarized context. `overflowRecoveryUsed: true` prevents a second compaction loop; a second overflow terminal-fails the run.

## 3.10 Navigation

Unsummarized navigation accepts directly into `navigation.ready_to_commit`; summarized navigation enters the shared quadruple with `commit_navigation`. The successful transaction is atomic: optional hook usage → move tip to target → optional summary entry parented to target (tip moves to it) → optional target label → operation cleanup + immutable navigation result + idle lane state. A summarized decline moves nothing. Abort before commit moves nothing and records `aborted`; after commit the operation is already completed. `navigation_end` tells replicas to rebase because the new tip can be outside their transcript; `WatchHandle.resnapshot()` captures the replacement snapshot (§5.4).

## 3.11 Inbox, queues, deferred writes

Every queued admission mints an entry id and atomically writes `pendingEntry(id)` plus one tagged item into the lane's single ordered inbox. Enqueue is accepted while idle, during any operation family, during deferred suspension, and after durable cancellation. Tags determine eligibility, not ownership:

| Drain point | Eligible tags |
|---|---|
| idle acceptance | all `write` and `nextRun`; mode-selected `steer` and `followUp` |
| run boundary | all `write`; mode-selected `steer`; mode-selected `followUp` only at `may_finish` |
| idle direct append | all earlier `write`, then the new direct entry |
| abort | all `steer` and `followUp` removed and returned; `nextRun`/`write` remain |

Within one drain, selected items always place in global inbox order; queue modes select per tag and leave remainders in their original relative positions. `nextRun` is never consumed mid-run and never blocks finish. A steer admitted too late for one boundary stays queued and becomes eligible at the next boundary or idle acceptance — not an error.

`steer`, `followUp`, `nextRun`, and operation-aware append all use the same staging path and emit the authoritative full `queue_update`; there is no separate `write_pending` event. `LaneSnapshot.queues` uses the same ordered `LaneQueuedItem[]`; clients group by `kind` without reordering it.

`cancelQueued(id)` performs one triage on the mutation line: pending item → remove it and delete its payload, `cancelled`; immutable entry exists → `already_consumed`; neither → `not_found` (a lost/retried cancellation treats `not_found` as success). Terminal cleanup never deletes lane-owned inbox payloads. Writes can remain pending for an unbounded structural operation; callers needing immediate placement use `waitForIdle()` then append, and `runWhenIdle()` provides serialized process-local callback ownership — neither creates durable scheduling state.

## 3.12 The checkpoint and boundary procedure

A boundary pass makes one decision and commits at most once. It may perform bounded transcript/payload reads and run `before_run_end` off the mutation line, but never commits back into `checkpoint` merely to remember a drain. For an ordinary checkpoint:

1. select eligible `write` + `steer` in global order;
2. if none project, evaluate the transcript-derived threshold guard;
3. route `need_assistant`, or at `may_finish` select eligible `followUp`;
4. if still finishing, capture a no-write verdict and run `before_run_end` off-line;
5. re-enter the mutation line and replan; discard stale hook output if inbox/control changed;
6. commit one of: selected entries + `assistant.ready`, `summary.deciding`, hook follow-up + `assistant.ready`, or the terminal transaction.

The shared structural `resume_checkpoint` publication uses the same planner with threshold checking disabled; its compaction entry, selected queued entries, inbox deletion, tip movement, and successor leaf commit together. A `may_finish` result with no selected input may rest in `checkpoint` so the same live Drive can run finish mediation; it cannot re-trigger threshold because the new compaction is newer than the trigger. Failures terminalize directly; they do not consume queued lane input to rescue the failed operation — that input stays available to a later ordinary run.

## 3.13 Terminal transactions and result records

```ts
interface OperationResultRecord {
  operationId: string;
  kind: "run" | "compaction" | "navigation";
  status: "completed" | "declined" | "aborted" | "failed";
  error?: OperationError;
  fromTipId: string | null;
  tipId: string | null;
  startedAt: number;
  endedAt: number;
}
```

Every terminal path performs one universal suffix in the same transaction as its final business writes: procedure-specific entries/usage/tip writes → delete all operation-owned `pi.op.*` and pending progress/frame/outcome addresses → set `operationResult(operationId)` exactly once → set `laneState{ currentOperationId: null, lastOperationId: operationId, inbox: preservedCurrentInbox }`. This is the implementation's normative write order. The old §3.13 prose listed result before cleanup, while its worked trace and source used cleanup first; this resolves that contradiction in favor of source and the trace.

The record is the public settled outcome, not a pointer to a hydrated outcome object; it embeds no entries and is never read by recovery. `fromTipId`/`tipId` delimit the operation's transcript segment; a precise rewrite may make either pointer dangle (§2.9) without changing the recorded disposition. Records are immutable, lane-lived, and retained for every operation; J1 snapshot compaction must carry them forward. `getResult(id)` is one value read. `drive(id)` is total: the current id installs/joins the lane Drive, an existing record returns `{ kind: "settled", outcome: record }`, and neither returns `OperationMismatch`; `LaneState.lastOperationId` and `LaneSnapshot.lastResult` expose the newest record without limiting access to older ids. A terminal commit under `cancel_requested` always records `aborted`, so `completed`/`declined`/`failed` imply terminal control was still running. Operation cleanup never deletes the lane inbox; usage rows and immutable transcript entries survive terminal cleanup.

# Part 4 — Execution, recovery, abort, close

## 4.1 The live operation task

An open operation has durable state whether or not this process executes it. A `Drive` is the lane-owned process-local continuation for one pass: it answers whether the lane already has a live continuation, supplies the effect gate, and exposes one shared completion.

```ts
class Drive {
  readonly operationId: string;
  readonly completion: Promise<DriveOutcome>;
  readonly gate: Gate;
  readonly context: Context;       // installing invocation cancellation removed
  readonly waitForRetry: boolean;
  deferredPermits: number;         // 1 when installed with pollDeferred
}
```

The first matching `drive` caller installs the Drive on the Session mutation line; every later matching caller observes the same `Drive.completion`. The first caller is not an owner: all callers are observation peers and the Lane owns execution. Each caller races only its own observation with `context.abortSignal` — a signal winning before installation starts nothing; after installation it rejects only that caller's invocation, never removing, replacing, or cancelling the Drive. Durable cancellation exists only through `requestAbort`.

One Drive is the sole top-level state-advance writer. Inbox methods mutate only inbox fields, `requestAbort` only control, and close seals mutation admission — so a live procedure's operation identity and `at` leaf cannot change concurrently, and procedures do not repeatedly verify operation existence, id, kind, Drive identity, or expected `at`. After awaiting external work they re-enter the mutation line and receive the latest authoritative `Lane.state`, preserving concurrent control/inbox changes. Parallel tool children are the exception: sibling call statuses genuinely race, so call identity/status and source-ready-prefix checks remain.

The task runs direct async procedures — no graph interpreter or action scheduler. The Lane supplies two mutation operations: `continueOperation` returns explicit `cancel_requested` without invoking the planner when control is cancelled, otherwise pairs the next state write with projection publication and returns the planner's result; `settleOperation` performs already-admitted effect settlement and tool-child transitions despite cancellation and owns the universal terminal suffix. Intent publishers use `continueOperation`, outcome publishers `settleOperation`: cancellation prevents a new durable intent but cannot erase already-admitted work.

A pass ends at a terminal result or durable wait; that pass clears `activeDrive`, and no live pass is replaced in-process. A crash or close destroys/detaches the continuation; a later attachment rebuilds `Lane.state` from durable values before another pass starts. Normal procedures are straight-line: prepare immutable inputs → publish durable intent → perform the effect → publish one durable outcome. Recovery dispatches directly from the flat `state.at` leaf; cancellation reconciliation runs before ordinary dispatch and never starts new ordinary effects.

## 4.2 Effect gate

`Session.mutate` orders durable races, but ordinary hook/provider/tool/timer admission occurs outside a transaction. Each installed `Drive` owns a split gate:

```ts
interface Gate {
  readonly signal: AbortSignal;
  /** Synchronously checks admission and invokes the operation with no yield between. */
  admit<T>(invoke: () => T): T;
}
interface GateControl {
  beginAbort(cancellation: Promise<void>): void;
  signalAbort(): void;
  close(error: HarnessClosed | HarnessFault): void;
}
type GateState =
  | { status: "open" }
  | { status: "aborting"; cancellation: Promise<void> }
  | { status: "closed"; error: Error };
```

Procedures receive only `drive.gate`; `Drive` privately retains `GateControl`, and there is no procedure-facing `assertOpen`. The source primitive currently types `close(error: Error)` so isolated tests can close with a generic error, but production `Drive` closure supplies only `HarnessClosed | HarnessFault`; the narrower declaration above is the production contract and the broader source type is H1 cleanup. `Gate.admit(invoke)` performs the only check and immediately returns `invoke()`: aborting → throw `AbortRequested(cancellation)`; closed → throw the closing error. The gate owns the cooperative `AbortController`, exposed as `gate.signal`.

`requestAbort(operationId, context)` is the durable cancellation primitive. With a matching live Drive it creates the abort-mutation promise and calls `drive.beginAbort(promise)` synchronously before the lane mutation; the committed marker resolves the promise and then `drive.signalAbort()`. An id mismatch resolves it and returns `OperationMismatch`; a commit fault rejects it and closes with `HarnessFault`. With no Drive, requestAbort commits or observes the marker but starts no pass.

**The admission boundary must be synchronous.** Preparation finishes first; then the gate check and operation invocation are one synchronous expression — wrapping preparation itself in `admit` is wrong, because abort could win while preparation awaits after admission:

```ts
await prepareRequest();   // all preparation first
const admittedContext = withAbortSignal(drive.gate.signal, drive.context);
const stream = drive.gate.admit(() =>
  models.streamSimple(model, aiContext, {
    ...options,
    signal: admittedContext.abortSignal,
    telemetryContext: admittedContext.telemetryContext,
  }),
);
```

The admitted boundary is the public Models/tool/hook operation, not an eventual SDK syscall: a Models call synchronously returns a lazy stream, and later auth resolution, provider loading, and delegation remain part of the admitted operation and own the same signal.

The complete admission catalog:

- **Hook aggregates** (one `admit` wraps the complete registered pipeline, not each handler): `before_drive`, `before_run`, `before_run_end`, `transform_context`, `before_request`, `before_payload`, `after_response`, `before_tool`, `after_tool`, `before_compaction`, `before_navigation`.
- **Provider operations:** one assistant `Models.streamSimple`, each individual structural-summary request, one explicit `Models.streamDeferred` poll. Best-effort `cancelDeferred` is cancellation cleanup and uses its separate close-only signal.
- **Other:** one real `tool.execute` and creation of each assistant/structural retry timer. Unknown, invalid, blocked, and synthetic tool outcomes start no tool and use no gate.

No other code calls `Gate.admit`. It does not wrap commits, public queue/configuration/value/tree mutations, pure classification, transaction construction, synthetic settlement, argument/system/context preparation, an already-admitted promise, cancellation reconciliation, or passive listeners.

The two possible orders: **admission first** — `Gate.admit` checks and invokes synchronously; `requestAbort` begins durable cancellation; the marker commits; `signalAbort` pulls the already-admitted operation's signal. **Abort first** — `beginAbort` closes ordinary admission synchronously; a later `Gate.admit` throws `AbortRequested` and `invoke` never runs; the task waits for the marker and reconciles.

The gate is not durable state, a mutex, scheduler, or mutation line. If the process dies before the cancellation commit, the closed gate disappears and no cancellation exists; recovery trusts only durable control. Every catalog item has abort-first/admission-first tests; preparation must precede `admit`, and the admitted signal must reach asynchronous Models auth/loading/provider work.

## 4.3 The Session mutation line

Every supported mutation uses the one keyless Session line of §2.8: reads and at most one commit happen through the capability, successful commits publish their exact process-local projection and synchronously bind event recipients, and `end()` releases. Lane commands, lane acquisition, progress writes, Branch creation/appends, metadata/value writes, and coherent restore/watch capture all use this line — deliberately sacrificing preparation overlap between lanes for a simpler ownership model. Storage retains its independent commit serializer for atomic application and session-global sequence assignment.

`Session.mutate()` is trusted and easy to misuse: the callback must use the supplied mutator for bounded reads and its sole commit. Calling a public Session writer inside the callback queues the nested write behind the active callback; awaiting it deadlocks. Plugins must not perform nested public writes or unbounded work while holding the line.

A Drive procedure uses the current owned Lane projection for control flow; the Lane pairs every operation-state write with publication of the matching projection, so settlement preserves newer inbox/control fields. Providers, tools, hooks, timers, event delivery, idle waits, and Drive completion stay outside the line. Raw Branch mutation while a Harness owns the corresponding AgentLane can stale the projection and is a trusted-programming defect; AgentLane methods are the operation-aware surface during ownership.

## 4.4 Attachment and open-operation inventory

`AgentHarness.create(options, context)` performs one bounded keyless Session mutation to inventory and restore complete AgentLanes before publishing the Harness. It starts no hook, provider, tool, timer, Drive, or application callback.

Attachment inventories the union of Branch tips and lane configuration/state. A Branch with only a tip is data-only and not published as an AgentLane; a complete lane has tip + configuration + lane state and optional compatible current operation metadata/state; partial or orphan lane values fault attachment; zero Branches and no main are legal. Per-lane restore performs exactly the §3.3 reads and validation — nothing more.

The returned `open` array contains one item per restored lane with a current operation and omits data-only Branches and idle lanes. It is inventory, not scheduling or ownership. Configured model identities remain unresolved strings until their actual effect boundary.

## 4.5 Driving and crash recovery

Recovery begins only when an open operation has no `Drive` and a matching `drive({ operationId }, context)` installs a real pass owner. `AgentHarness.create` never drives; `resume(context)` inspects and drives the current operation without exposing its id and grants the pass one deferred-poll permit; `requestAbort` with no task commits cancellation but installs nothing, and the next drive enters reconciliation directly.

The pass first inspects the owned control projection: cancellation requested → invoke neither `before_drive` nor `before_run`, enter §4.6. Otherwise gate and invoke `before_drive`; failure rejects the pass without faulting the harness or writing durable progress. Model/tool implementations resolve only at the boundary that needs them: an unavailable provider/model or configured request tool is a non-retryable configuration failure before request intent, an unavailable requested tool a synthetic error result; neither suspends the operation. Durable phase then decides the work: `starting` runs and settles `before_run` per §3.6; a pending effect with no owner is an orphan and follows the table; all other phases continue ordinarily.

| Orphaned restart point | Activation recovery |
|---|---|
| assistant generation `effect_pending` | Read bounded pages from `pendingAssistantFrames(O, R)`, reduce with `reduceAssistantMessageFrames`, and commit under the reserved ids a synthetic zero-usage `error` response carrying the reconstructed partial (no committed start frame → `api:"unknown"`, captured provider/model strings, empty content). Include an explicit warning: request interrupted, preceding content is the latest committed partial, newer live output may be missing, external outcome unknown. The same transaction deletes the frame list. The committed error then follows ordinary classification: attempts remaining → retry wait and a later numbered attempt under fresh ids; cap reached → terminal failure. Partial tool calls inside it never execute, and `after_response` never runs — there is no trustworthy complete provider result to transform. |
| structural generation `effect_pending` | Treat the entire attempt as uncertain, including any completed first split-turn request whose intermediate text was process-local. Advance to a later `ready` attempt under the captured policy or fail at the cap. Committed request-usage rows remain in the ledger. |
| tool call `effect_pending` | Stored and current declarations both `safe`: delete any old progress checkpoint and re-execute persisted arguments with the same invocation memos/id. Implementation absent, current declaration no longer safe, or stored declaration `never`: synthesize interruption instead of suspending — preserve checkpoint content/details/usage when present, ignore its added-tool/termination hints, append the explicit latest-durable/newer-live-may-be-missing/unknown-outcome warning, and stage a non-terminating error without `after_tool` (no checkpoint → omit `details`). |
| deferred poll `effect_pending` | No poll permit → stays suspended; may expose its durable partial in snapshots. Permit plus resolvable captured model → replace the unknown poll with fresh response/usage ids at the same poll number and fetch once; the replacement intent deletes the abandoned old frame list. Captured model unavailable → delete that old frame list and enter configuration-provenance failure without fabricating settlement. There is no cap. |

After orphan recovery removes or takes live ownership of every pending effect, the ordinary procedures continue. Calls already `outcome_ready` need no identity or effect recovery; ordinary source-order materialization places their staged results. Recovery is not a second end-to-end driver.

Atomic transactions have no internal prefix, so every repeat-sensitive effect has the same four durable crash positions:

| Crash point | Durable restart point | Activation behavior |
|---|---|---|
| before intent commit | previous ordinary state | run the ordinary procedure as if nothing happened |
| after intent, before effect admission | `effect_pending` | outcome indistinguishable from a crash during the effect; apply the table above |
| during/after effect, before settlement | `effect_pending` | same unknown-outcome policy |
| after settlement commit | output + usage + next state | continue; never re-settle |

Queue application and final structural commits remain atomic (Part 3): a crash before one sees the prior complete state, after one the next. A crash after durable abort activates reconciliation; a crash after terminal cleanup sees an idle lane and its immutable `pi.result`.

Retry waits are ordinary restartable states with two caller policies: `waitForRetry: false` returns waiting/`notBefore` with no timer and the caller schedules a wake, later driving the same id; `waitForRetry: true` admits and starts the retry timer through `drive.gate` — the timer reaching `notBefore` verifies the same current wait and commits `ready`, `requestAbort` wakes it after durable cancellation so reconciliation runs, and close rejects the local task with no durable write. At or after `notBefore`, either policy verifies the same current durable wait in the owned projection and commits `ready` without an unnecessary timer.

## 4.6 Abort and cancellation reconciliation

Invocation cancellation and durable cancellation are different: aborting one caller's `Context` stops only that caller's observation and never mutates operation state. Durable cancellation exists only through `requestAbort(operationId, context)` or the `abort(context)` convenience.

For a matching current operation, the first request, in order: (1) synchronously call `Drive.beginAbort()` when a live Drive exists, preventing new effect admission while the marker is pending; (2) on the mutation line, set `control = { status: "cancel_requested", requestedAt }`; (3) in the same commit, remove every `steer` and `followUp` item from the inbox and delete its pending payload, preserving `nextRun` and `write`; (4) after commit, publish the Lane projection, resolve the abort mutation, and signal the live gate; (5) still before releasing the mutation line, bind `operation_abort` and any `queue_update` recipients; (6) deliver those events, then return `{ operationId, newlyRequested: true, steer, followUp }`. Signal callbacks run before event recipients are bound, but no later Lane mutation can publish first because the current mutation still owns the Session line.

The drained messages exist only in that return value and event — no durable drained-control fields. A process crash, transport loss, or lost response after the commit permanently loses those payloads: an explicit product tradeoff. A repeat request against the same still-open cancelled operation returns `newlyRequested: false` with empty drains and no duplicate event. A stale id returns `OperationMismatch` and cannot cancel another operation. `requestAbort` never installs a Drive; with none it only commits or observes the marker, and a later `drive` reconciles. `abort()` inspects the current id, requests cancellation, then ensures a same-id reconciliation pass is observed; an idle lane returns `NoActiveOperation`.

Before every ordinary dispatch the Drive checks control; `cancel_requested` routes to one total reconciliation switch over all 13 leaves that starts no new ordinary hook/provider/tool work. It settles or reconstructs admitted assistant/deferred outcomes, preserving committed frame prefixes; interrupts unsafe orphaned tools, safely replays only where policy permits, and stages and source-orders outcomes already durable; discards process-local structural results not atomically published; best-effort cancels a deferred provider handle using the Drive's close-only signal; and deletes operation-owned values/lists, recording one terminal `aborted` result. Lane-owned `nextRun`/`write` items remain queued. Close is not abort (§4.7).

## 4.7 Close — a controlled crash

Close writes no cancellation or terminal state. It seals harness and Lane mutation admission, rejects caller observations through the harness-close boundary, keeps detached pass promises observed, drains Session mutations admitted before the seal, then closes storage. A provider/tool result produced after sealing cannot commit — its next Lane mutation rejects with `HarnessClosed`. The Drive is not replaced and durable operation state is unchanged, so reopening sees the same restart point as process loss. Whether a host also signals cooperative provider/tool work is local resource cleanup; it must not write cancellation, synthesize settlement, remove a durable operation, or create an ownership-loss recovery path.

## 4.8 Faults

A failed admitted storage commit faults the whole harness: it closes Drive gates, rejects barriers and pending/future calls with `HarnessFault`, and requires process restart — never an expected `Err` result. `faulted:true` appears in snapshots obtained before observation closes; reopen restores from the last successful transactions.

Close rejects active drive and convenience-operation promises with `HarnessClosed`; already-resolved admissions remain durable, calls not yet accepted return `Err(Closed)`, and surfaces without a `Result` channel reject with `HarnessClosed` on and after close. Provider, tool, and isolated hook failures remain per-lane and in-band. A throw/rejection from trusted deterministic application computation (`systemPrompt`, `toolContext`, `toProviderMessages`, an `entryProjector`) faults the harness; `AgentTool.prepareArguments` is the deliberate exception, normalized to a synthetic tool error.

# Part 5 — Public surface

## 5.1 The lane surface

An `AgentLane` is the execution-capable facade over one named Branch. Full declarations: `agent-harness.ts`. Every asynchronous method takes a trailing `Context`. The complete method inventory:

- **Branch surface** (same five methods as `Branch`, §2.8, plus operation-aware append behavior): `getTipId`, `findEntries`, `findEntry`, `appendMessage`, `appendCustomEntry`.
- **Primitives:** `accept(request: OperationRequest) → OperationAdmissionResult`; `drive(options: { operationId; waitForRetry?; pollDeferred? }) → DriveResult`; `requestAbort(operationId) → AbortRequestResult`; `getResult(operationId) → OperationResultRecord | undefined`; `inspectExecution() → LaneExecutionInfo`.
- **Conveniences:** `prompt(text, images?)` and `prompt(message | message[]) → RunResult`; `skill(name, additionalInstructions?) → RunResult`; `promptFromTemplate(name, args?) → RunResult`; `compact({ customInstructions? }?) → CompactionResult`; `navigateTree(targetId, options?: { summarize?; label?; customInstructions? }) → NavigationResult`; `resume() → ResumeResult`; `abort() → AbortResult`.
- **Queues:** `steer`/`followUp`/`nextRun(message: string | AgentMessage, images?) → QueueResult`; `cancelQueued(entryId) → CancelQueuedResult`.
- **Other:** `recordUsage(usage, { entryId?; details? }?) → RecordUsageResult`; `waitForIdle()`; `runWhenIdle(callback)`; `getModel`/`setModel(identity: { provider, modelId })`; `getThinkingLevel`/`setThinkingLevel`; `getActiveTools`/`setActiveTools(names)`; `watch() → WatchHandle<LaneSnapshot>`.

`OperationRequest` is the union of `prompt` (text+images or message(s)), `skill`, `prompt_template`, `compaction`, and `navigation` requests, each with an optional caller-supplied `operationId` (§1.2, §3.1).

The four primitives are `accept`, `drive`, `requestAbort`, and `getResult`/`inspectExecution` for observation. `accept` commits no process owner; `drive` installs or joins one lane-owned pass, reports durable retry/deferred waits, and returns old result records without disturbing the current operation; each caller races only its own observation with its Context signal; `requestAbort` is expected-id fenced and the sole durable cancellation primitive.

Conveniences add process-local waiting policy only: `prompt`/`skill`/`promptFromTemplate` compose acceptance and drive; `resume` inspects and drives any current operation, granting one deferred poll permit; `abort` requests durable cancellation and observes reconciliation; `compact`/`navigateTree` settle structural operation A, then may accept and drive an ordinary empty-prompt run B when queued conversational input remains — B has a fresh id and ordinary `run_start`, and a competing acceptance may win that idle window, in which case the convenience returns only A. Primitive and convenience histories are equivalent and externally reproducible; no scheduler, auto-start-on-reopen, or hidden continuation exists below this layer.

### Results

```ts
interface SuspendedRun { operationId: string; status: "suspended"; deferred: DeferredHandle }

type RunResult = Result<OperationResultRecord | SuspendedRun,
  LaneBusy | InvalidMessage | UnknownSkill | UnknownTemplate | Closed>;
type CompactionResult = Result<
  { compaction: OperationResultRecord; run?: OperationResultRecord | SuspendedRun },
  LaneBusy | NothingToCompact | Closed>;
type NavigationResult = Result<
  { navigation: OperationResultRecord; run?: OperationResultRecord | SuspendedRun },
  LaneBusy | InvalidNavigation | UnknownTarget | Closed>;
type ResumeResult = Result<OperationResultRecord | SuspendedRun, NothingToResume | Closed>;
type QueueResult = Result<{ entryId: string }, InvalidMessage | Closed>;
type CancelQueuedResult = Result<{ kind: "cancelled" | "already_consumed" | "not_found" }, Closed>;
type AbortResult = Result<
  { operationId: string; steer: AgentMessage[]; followUp: AgentMessage[] },
  NoActiveOperation | Closed>;
type RecordUsageResult = Result<{ usageId: string }, Closed>;

type DriveOutcome =
  | { kind: "settled"; outcome: OperationResultRecord }
  | { kind: "waiting"; operationId: string; reason: "retry"; notBefore: number }
  | { kind: "waiting"; operationId: string; reason: "deferred"; deferred: DeferredHandle };
type DriveResult = Result<DriveOutcome, OperationMismatch | Closed>;
type AbortRequestResult = Result<
  { operationId: string; newlyRequested: boolean;
    steer: AgentMessage[]; followUp: AgentMessage[] },
  OperationMismatch | Closed>;
```

`SuspendedRun` is convenience-only and never stored. Terminal outcomes are exactly the immutable record; callers retrieve entry payloads separately through Branch/Lane queries. Queue admission returns the reserved `entryId`; `AbortResult`/`AbortRequestResult` carry the family-neutral `operationId` plus the drained steer/follow-up messages; `recordUsage` writes an adjustment row and returns its id.

`waitForIdle` resolves after earlier admitted lane jobs settle, there is no current operation, and no idle callback owns the lane; multiple waiters may resolve together and later work may begin immediately afterward. `runWhenIdle` serializes one process-local callback owner, released on return or throw; the callback must not invoke another mutating method on the same lane (it would wait behind itself); close rejects callbacks not started and waits for one already running. `setModel` stores `ModelIdentity`, not a live registry object — an unavailable identity remains valid configuration and later fails in-band when generation resolves it. Tree browsing beyond one branch, fork administration, label inventory, and Session/repository listing are deliberately not AgentLane methods; a serving/RPC facade composes those read services beside the lane rather than widening it.

## 5.2 The harness

Full declarations: `agent-harness.ts`. `AgentHarness<TContext>` methods (all with trailing `Context`):

- `lane(name)` / `lane(name, { createAt?: string | null })` → `AgentLane`; `lanes() → LaneInfo[]`.
- `getName`/`setName(name | undefined)`; `getLabel`/`setLabel(targetId, label | undefined)`.
- Harness-global configuration — tool implementations are code and cannot persist, active names live in each lane's configuration, and `setTools` replaces only the registry: `getTools`/`setTools`, `getResources`/`setResources`, `getStreamOptions`/`setStreamOptions`, `getRetryPolicy`/`setRetryPolicy`, `getCompactionSettings`/`setCompactionSettings`, `getSteeringMode`/`setSteeringMode`, `getFollowUpMode`/`setFollowUpMode`.
- `watchSession() → WatchHandle<SessionSnapshot>`; `hooks`; `events`; `close()` (detach cleanly, §4.7 — durable open operations remain open).

`AgentHarness.create(options, context)` returns `{ harness, open: OpenOperation[] }`, where `OpenOperation = { lane, operationId, kind, startedAt, aborting?: true }` and `LaneInfo = { name, tipId, operation: CurrentOperationInfo | null }`.

**R12:** `watchSession` currently throws `SliceNotImplemented("watchSession")` — the sole stubbed Harness method. The current `SessionSnapshot` is `{ lanes: LaneInfo[]; faulted: boolean }`; R12 decides whether it stays that small.

Passing an open `Session` to `create` transfers orchestration ownership to the attachment attempt and then the returned Harness until `close` resolves; if create rejects, ownership returns to the caller. During ownership, raw Branch mutation for a configured AgentLane and direct writes to reserved `pi.*` control addresses can stale the authoritative Lane projection and are trusted-programming defects; session-global application values remain available. `create` creates nothing and restores the small durable projection for every complete lane before returning (§4.4); `open` contains exactly one item per lane with a durable current operation, omits idle lanes, copies `aborting:true` only from durable cancellation control, and is inventory that may become stale — not a reservation, identity prediction, or drive claim. Detailed snapshot payloads are read only by `watch(context)`.

### Options

`AgentHarnessOptions<TContext>`: `session`, `models`; the immutable lane seed `model`, `thinkingLevel?` (default `"off"`), `activeToolNames?` (default: initial tool names) — captured at `create`, initializing every missing AgentLane, never overriding an existing complete lane configuration; `tools?`, `toolContext?` (a `TContext` value or `(context) => TContext | Promise<TContext>`), `systemPrompt?` (string or sync/async `(toolContext, context) => string`, evaluated per request), `resources?` (skills, prompt templates), `streamOptions?`, `retry?`, `compaction?`, `steeringMode?`, `followUpMode?`, `toolExecution?` (`"sequential" | "parallel"`, default parallel), `toProviderMessages?`, `entryProjectors?: Record<string, EntryProjector>` where `EntryProjector` is a sync/async `(entry: CustomEntry, context) => AgentMessage[] | undefined`. `Resources = AgentHarnessResources<Skill, PromptTemplate>`. `AgentHarnessStreamOptions` is the curated §0.7 type; it excludes signal and provider lifecycle callbacks, which the harness owns.

`AgentHarnessTool` replaces `AgentTool.execute` with `execute(toolCallId, params, onUpdate, toolContext, invocation, context)`; the update callback is `(partialResult, options?: { checkpoint?: true }) => void`; `AgentHarnessToolInvocation` is `{ invocationId, operationId, turnId, getMemo(name), setMemo(name, value | undefined) }` — `invocationId` is an opaque session-unique logical call id equal to the reserved result entry id, and `setMemo(name, undefined)` deletes.

There is no harness-level telemetry default: a shared harness may serve concurrent callers, each method/callback uses only its explicit invocation Context, `context.telemetryContext` is always the telemetry parent, and runtime configuration must not reintroduce a receiver-level fallback.

`create` copies the three seed fields into one immutable `LaneConfiguration`, storing the model as `{ provider, modelId }`; existing complete lanes use only their current config. `lane` atomically gets or creates/attaches on the Session mutation line, using the seed whenever it creates or attaches; missing lanes use `options.createAt ?? null`, existing lanes ignore it. Commit success publishes the one Lane object and synchronously binds `lane_created` recipients before line release, then awaits delivery outside. Invalid names and unknown non-null targets reject with `InvalidLane`/`UnknownTarget`; partial durable combinations fault. Lane configuration and Harness metadata setters likewise bind their events in the committing Session job. Applications opt into deferred generation through `setStreamOptions({ deferred: ... })` or initial `streamOptions`; `before_request` may patch the same curated field per attempt. Initial, replacement, and hook-patched stream options are trusted typed internal values; patch deletion semantics apply before publication, and extensions returning values outside the declared types are defective rather than runtime-validated.

`systemPrompt`, `toolContext`, `toProviderMessages`, and `entryProjectors` are deterministic/idempotent computation callbacks: they receive the current invocation Context and may repeat after a crash; effectful interception belongs in hooks. `systemPrompt` is evaluated per provider request; `transform_context` then receives and may request-locally transform both messages and that prompt — durable run context belongs in `before_run` message injection, not request-local transformation. `toolContext` is resolved once per live batch; each bound call receives its stable invocation and a required synchronous update callback even with no live listener. A `replay:"safe"` tool may implement named durable effect memoization over `getMemo`/`setMemo`; committed values survive replay until the call reaches `outcome_ready`, and tools must await memo writes. These methods are invocation-scoped capabilities, not raw Session access.

## 5.3 Session and Branch

Session-global metadata, values/lists, global entry queries, Branch discovery/creation, mutation, id generation, and close live on `Session` (§2.8); Session has no tip or implicit-main methods. `Branch` is intentionally narrow (§2.8): because the receiver already names one Branch, its query methods are `findEntries`/`findEntry`, and direct appends always extend its current tip atomically. AgentLane exposes the same five methods and adds operation-aware append behavior. There is no nested tree/store/view accessor.

## 5.4 Snapshots and subscription

```ts
interface LaneSnapshot {
  lane: string;
  transcript: Entry[];
  tipId: string | null;
  lastResult?: OperationResultRecord;
  configuration: LaneConfiguration;
  stats: SessionStats;
  operation: null | {
    id: string; kind: "run" | "compaction" | "navigation";
    startedAt: number; fromTipId: string | null;
    status: "running" | "open" | "aborting";
    retry?: { attempt: number; maxAttempts: number; nextAttemptAt: number };
    deferred?: { handle: DeferredHandle; poll: number };
    streamingMessage?: AssistantMessage;
    runningTools: Array<
      | { status: "running"; toolCallId: string; toolName: string; args: unknown;
          result?: AgentToolResult<unknown> }
      | { status: "settled"; toolCallId: string; toolName: string; args: unknown;
          result: AgentToolResult<unknown>; isError: boolean }
    >;
  };
  queues: LaneQueuedItem[];
  faulted: boolean;
}

interface WatchHandle<T> {
  snapshot: T;
  start(listener: EventListener): void;
  resnapshot(context: Context): Promise<T>;
  unsubscribe(): void;
}
```

`OperationStatus` includes `"running" | "open" | "aborting"`, but current snapshot and reducer paths produce only `"open"` and `"aborting"`; `"running"` has no defined producer and is tracked as contract cleanup (§0.9, roadmap).

`watch(context)` captures one coherent presentation snapshot on the Session mutation line, then exposes events serialized after it. Capture performs one compaction-bounded transcript read, the newest result lookup named by `lastOperationId`, current stats, and exact state-directed reads for inbox payloads, frames, deferred source, effect-pending tool progress, and outcome-ready staged results. A running tool's optional `result` is its latest complete progress snapshot; a settled tool's required `result` is final and remains in `runningTools` until its own `entry_added` moves presentation to the transcript. Required missing references fault capture; optional frame/checkpoint absence is legal; results remain unrelated to recovery. `queues` is the one global ordered tagged inbox including pending writes; `configuration`, `stats`, and `faulted` make the initial snapshot self-sufficient before any event arrives. First snapshot, reconnect capture, and `resnapshot()` share one path.

`reduceLaneSnapshot(snapshot, event)` is the normative client fold: for non-navigation histories, folding a snapshot over its own events produces the next snapshot. It returns `{ rebase: true }` for `navigation_end`; the client calls `handle.resnapshot(context)` without tearing down or resubscribing. Resnapshot marks a barrier on the event-bus delivery tail while the mutation line still holds the captured boundary — queued pre-boundary watcher deliveries are invalidated and post-boundary events held until the fresh snapshot installs — so calling it from inside the listener neither deadlocks nor refolds stale queue/usage state. The reducer ignores other lanes' events, applies session-wide usage totals, and clones its input rather than mutating caller state.

Operation-terminal events are `run_end`, `navigation_end`, and `compaction_end` only when the open snapshot operation kind is standalone compaction; in-run `compaction_start`/`compaction_end` are segment brackets inside the open run. `run_suspend` is non-terminal and leaves the operation open with a deferred descriptor; `run_resume` clears it.

## 5.5 Events

Events are passive committed-state/lifecycle observations: they never drive execution and are not replayed from durable history. `HarnessEvent` adds `lane` to lane-scoped payloads and may add `recovery: true` for actual orphan recovery/replay. Full payload unions: `agent-harness.ts`. The authoritative groups:

| Group | Events and required data |
|---|---|
| operation | `run_start{runId,startedAt}`, `compaction_start{runId,reason,startedAt}`, `navigation_start{runId,targetId,startedAt}`, `operation_abort{operationId,steer,followUp}` |
| terminal/segment | `run_end{runId,status,fromTipId,tipId,endedAt,error?}`, `compaction_end{runId,reason,status,endedAt,entryId?,error?}`, `navigation_end{runId,status,fromTipId,tipId,endedAt,error?}` |
| suspended/retry | `run_suspend{runId,reason:"deferred",deferred,poll}`, `run_resume{runId}`, `retry_scheduled{step,attempt,maxAttempts,delayMs,notBefore,errorMessage}`, `retry_start`, `retry_end` |
| transcript | `message_start`, `message_update{message,event,frame?}`, `message_end{message,entryId?}`, `entry_added{entry}` |
| tools/turns | `turn_start`, `turn_end`, `tool_start`, `tool_update`, `tool_end` |
| replicated state | `queue_update{queues}`, lane/global `config_update`, `usage{row,totals}`, `lane_created{at}` |
| metadata/faults | `value_update`, `fault`, `handler_error` |

`queue_update` carries the complete ordered `LaneQueuedItem[]` after every inbox change and is the sole authoritative queue event; there is no `write_pending`. Lane configuration updates carry `previous` and `value`; global data-bearing configuration updates do the same, while tools/resources remain notification-only because code registries are not replicated. Usage events carry authoritative committed totals from `CommitResult`/storage stats.

Acceptance publishes after its transaction: the start event, message lifecycle plus `entry_added` for placed queued/request entries, then `queue_update` when capture changed the inbox. Standalone structural starts publish before `accept` resolves. Provider streaming and `tool_update` observations may precede the transaction persisting final content; `tool_start` is emitted from the commit that establishes fresh effect intent or synthetic outcome readiness, `tool_end` is emitted only after its finalized result stages, and `entry_added` always means the immutable entry is queryable. `tool_start` carries effective arguments for an intended effect and source arguments for an immediate synthetic result; `tool_end` carries the finalized result but does not repeat arguments.

Clients depend on the terminal taxonomy: `run_end` closes a run; `navigation_end` closes navigation and requires snapshot rebase; standalone-compaction `compaction_end` closes compaction; in-run `compaction_start`/`compaction_end` are nested segment brackets that do not clear the run; `run_suspend` keeps the operation open. Every structural start has one matching end, including `aborted`. `compaction_end.status` is `completed | declined | failed | aborted` (success carries `entryId`); `run_end` is `completed | failed | aborted`; `navigation_end` additionally permits `declined`.

The event bus binds recipients and Context synchronously after commit, serializes delivery in mutation order, and makes the public operation await its retained delivery promise. Listener failures emit `handler_error` and do not roll back committed state. `watch` recipients install on the mutation line so no event falls between snapshot and subscription. `reduceLaneSnapshot` (§5.4) is the supported fold; clients should not reconstruct operation terminality or queue/config/stat state with a second reducer.

## 5.6 Hooks

Hooks are awaited interception points. Registration is harness-global: `Hooks.on(name, handler, options?: { id? })` returns an unsubscribe function; `HookHandler` receives the event plus `{ lane, runId }` (`HookInvocation`) and the current operation Context as its final argument, and returns the result synchronously or as a promise. Registration is host-local configuration and retains no caller Context; nested handler work must derive from the invocation Context, not a harness default. A registration `id` is optional observability metadata only — not uniqueness, persisted routing, replay identity, or a durability protocol. Extension-private durable state belongs in extension-owned bound values/lists or audited custom entries keyed by lane/operation id; the extension owns replay, cleanup, and idempotency.

The canonical hook contract (event/result field shapes as declared in `agent-harness.ts`):

| Hook | Event | Result | Durability |
|---|---|---|---|
| `before_run` | `{ prompt: AgentMessage[], resources }` | `{ messages? }` | transition-consumed: injected messages and the checkpoint commit together |
| `before_drive` | `{ operation: "run"\|"compaction"\|"navigation" }` | `void`; failure rejects the pass with no durable progress | pass-local |
| `before_run_end` | `{ runId, messages }` | `{ followUp?: string }` | transition-consumed: a follow-up and continuation commit together, or the terminal transaction consumes the no-follow-up decision |
| `transform_context` | `{ messages, systemPrompt }` | `{ messages?, systemPrompt? }` | request-local |
| `before_request` | `{ model, step: "assistant"\|"deferred"\|"compaction"\|"branch_summary", attempt, streamOptions }` | `{ streamOptions?: AgentHarnessStreamOptionsPatch }` | request-local: the intent stores only its specified derived request metadata |
| `before_payload` | `{ model, payload: unknown }` | `{ payload }` | request-local |
| `after_response` | `{ status?, headers?, message: SettledAssistantMessage }` | `{ message? }` (must keep role) | transition-consumed: the transformed message feeds the settled response entry; cancellation or overflow may normalize it at commit |
| `before_tool` | `{ toolCallId, toolName, args }` | `{ args?, block?: { reason, terminate? } }` | transition-consumed: effective arguments commit with effect intent, or a blocked outcome is staged |
| `after_tool` | `{ toolCallId, toolName, args, content, details?, isError, usage? }` | `{ content?, details?, isError?, usage?, terminate? }` (field-by-field patch) | transition-consumed: the finalized result commits with `outcome_ready` staging |
| `before_compaction` | `{ reason: "manual"\|"threshold"\|"overflow", preparation: CompactionPreparation, customInstructions? }` | `{ decline?, compaction?: CompactResult }` | transition-consumed: decline, supplied result, or selection of generation commits as the next structural transition |
| `before_navigation` | `{ targetId, preparation: BranchPreparation, customInstructions? }` | `{ decline?, summary?: BranchSummaryResult }` | transition-consumed, as above |

Timing and repetition:

| Hook | When it runs / repetition |
|---|---|
| `before_drive` | once per newly installed real drive pass, after the cancellation check and before recovery or ordinary work; repeats after every wait/suspension or process loss; joiners do not rerun it |
| `before_run` | while a run is durably `starting`, after `before_drive`; may rerun until its consuming commit succeeds; never after that transition |
| `transform_context`, `before_request`, `before_payload` | once per request attempt, including retry and replay; `transform_context` at `AgentMessage` level before `toProviderMessages`; `before_payload` on the provider-specific wire payload |
| `after_response` | per settled response, after streaming settles and the latest frame write completes (§3.7), before `message_end` and the commit; unless abort wins before it starts |
| `before_tool` | after validation, before execution; per call execution; not when an orphaned unsafe call is synthesized without execution |
| `after_tool` | after execution, before outcome staging; per executed result unless abort wins before it starts; runs on safe replay |
| `before_compaction`, `before_navigation` | in `deciding`; once until a structural source commits; never once generation is durable |
| `before_run_end` | at a normal finish boundary; may repeat after a crash at that boundary; never for abort, terminal failure, or exhausted auto-compaction |

Uniform semantics:

- Handlers run in registration order, each seeing prior aggregate output where the hook transforms a value. A throw emits `handler_error`, skips that handler, and lets the rest continue — except **`before_drive` fails closed and rejects the pass, and `before_tool` fails closed and blocks the tool**. One accepted-operation hook invocation calls `drive.gate.admit(() => runPipeline(...))`; individual handlers are not separate gate checks.
- Aggregation: `before_run` appends messages, each later handler seeing the prompt plus prior injections, all applied once by the consuming `starting → checkpoint` transaction. `transform_context`, request/payload/response, and `after_tool` transformations chain with field-by-field patch merging. `before_tool` argument replacements chain and are revalidated; the first block is terminal and later handlers do not run. `before_compaction`/`before_navigation` stop at the first decline or supplied result; if all return neither, generation is selected; decline plus a result is a handler error, ignored like a throw. `before_run_end` uses the latest defined follow-up.
- Durability classes: **pass-local** results control only the current process-local pass — nothing records that the hook ran. **Request-local** values exist only while constructing/executing that provider request — transformed context, system prompts, stream-option patches, and provider payloads are not durable request snapshots, and a retry or rebuilt request runs fresh middleware. **Transition-consumed** output is reflected in the transaction performing the dependent durable transition: before it commits the output may be lost and the hook may run again per the recovery path; after, recovery observes the resulting state/content rather than rerunning the hook. There is no separate hook-completion record. Events expose post-hook values; passive listeners cannot transform them.
- `before_request` receives `AgentHarnessStreamOptions` and returns `AgentHarnessStreamOptionsPatch`; neither can contain a signal or provider lifecycle callback. `after_response` must preserve the assistant role and may return `aborted` only when the harness signal is already aborted. `before_navigation` runs only for summarized navigation; unsummarized navigation cannot decline.

No external hook is globally exactly-once. Transition-consumed hooks commit their interpreted output with dependent durable progress; pass-local and request-local hooks do not. A crash before a consuming transaction may lose the output and repeat the hook when the procedure retries, while recovery paths that synthesize an unknown outcome may skip it. External side effects require extension-owned idempotency keyed by stable operation or invocation ids.

## 5.7 Harness execution blocks

The harness owns purpose-built execution blocks under `src/harness/execution/`; they implement provider and tool mechanics for the operation procedures and know nothing about durable operation state, lanes, retries, classification, queues, or storage. `src/agent-loop.ts` is an independent compatibility implementation, not modified or rebuilt on these blocks — its exports, injected `StreamFn`, callback shapes, mutable-context behavior, and event ordering are unchanged.

### Assistant streaming

`assistant.ts` owns one already-approved provider request (`streamHarnessAssistant(messages, config, context)`; shapes in source). Before the request intent commits, the assistant procedure verifies the captured durable `{ provider, modelId }` resolves in `Models` and runs `before_request`; after that commit, the request adapter resolves the same pair, derives the admitted Context, and invokes `Models` through `drive.gate.admit(...)` under its composed abort signal and telemetry parent. Block order: `transformContext` → `toProviderMessages` → construct provider `AiContext` → map curated stream options + thinking level to `SimpleStreamOptions` → install `context.abortSignal`, `context.telemetryContext`, `beforePayload`, metadata capture → `request(...)` → either `observer.start` then `observer.update`* or a pre-generation error with no start/update → settle the stream completely → `afterResponse(settled message, captured metadata)` → `observer.end` → return the settled message.

It never mutates `messages`; every callback receives the same invocation Context unless its adapter deliberately derives a child span Context. The observer feeds actual start/update events to one per-stream `AssistantMessageFrameEncoder` and synchronously enqueues each returned invocation-fenced frame append without awaiting storage (§3.7); events already covered by a queued frame return no frame. The standalone block's source config makes `afterResponse` optional for callers that need no durable frame/hook mediation; the old inline declaration made it required. The durable Harness procedure must always install it — even with no hook listeners — because it first stops frame admission and awaits the latest frame-write promise before the optional `after_response` pipeline. A pre-generation `error` emits no synthetic start: the adapter calls only `observer.end` after the response hook. An update or successful `done` before `start`, a duplicate start, or an event after terminal is a provider protocol defect. If abort interrupts the parked `afterResponse` adapter, the block awaits the carried abort-mutation promise, skips that hook, emits `observer.end` with the raw settled message, and returns it so the caller commits it under the now-current cancellation control. `beforePayload` maps to pi-ai's payload callback; metadata capture maps to pi-ai's `onResponse`, which runs before the response body is consumed — distinct from `afterResponse`, which transforms the settled message afterward. The harness exposes neither callback through `AgentHarnessStreamOptions`.

The request function, not the block, owns registry dispatch, auth, and admission: it resolves the captured model, derives the admitted Context, and invokes `models.streamSimple` inside `gate.admit` exactly as §4.2 shows, additionally passing ``sessionId: `${session.metadata.id}:${lane.name}` ``. No yield exists between check and invocation; asynchronous auth/lazy/provider work is part of the admitted request and owns the admitted signal. Ordinary assistant requests derive that one stable cache/affinity identity per lane; lanes in one Session never share it, and identity-prefix changes may miss old cache entries but cannot incorrectly reuse them — no durable lineage or rotation state exists. Structural summary requests use fresh identities with `cacheRetention: "none"`; deferred polling sends no cache identity. A captured identity that disappears after intent becomes an in-band provider error under the reserved ids; one unavailable before intent becomes a non-retryable configuration failure with no fabricated response or usage (§3.7, §4.5). Existing summary helpers keep their separate `Models`-based generation logic but gate their `Models` invocation the same way.

### Tool phases

`tools.ts` exposes phases at the exact durable boundaries of §3.8 — `prepareToolCall`, `applyBeforeToolDecision`, `executeToolCall`, `finalizeToolCall`, `createToolResultMessage` (shapes in source). Hooks remain separate gated invocations and commits remain explicit operation-procedure statements; neither hides behind a callback bag. The batch procedure composes: prepare (lookup, `prepareArguments`, initial validation) → `before_tool` → apply decision (block or validate replacement arguments) → commit `pi.op.tool_args` + effect-pending intent with post-commit `tool_start` → execute (effect + live updates + checkpoint requests) → stop updates, expire memo capability, close checkpoint admission → await latest `tool_update` delivery and latest checkpoint write → `after_tool` → finalize → commit `pi.pending.entry` + `outcome_ready` + invocation cleanup with post-commit `tool_end` → materialize source-ready outcomes as entries + usage.

Unknown tools, `prepareArguments` failures, invalid initial/replacement arguments, and blocked calls produce an immediate raw error `AgentToolResult` with `isError: true` and no invented `details`; `createToolResultMessage` constructs the canonical synthetic message before staging `outcome_ready`. Their outcome-staging commit emits `tool_start` followed by `tool_end`; they still invoke no tool effect or `after_tool`. The old inline declarations instead put a `ToolResultMessage` directly in the immediate outcome. `AgentHarnessTool.prepareArguments` is deterministic/idempotent computation and may repeat before intent; effectful policy belongs in `before_tool`. At `tool.execute` admission, `executeToolCall(call, gate, onUpdate, toolContext, invocation, context)` derives `withAbortSignal(gate.signal, context)` and invokes `AgentHarnessTool.execute` directly through `gate.admit(...)`, with the admitted Context trailing; there is no neutral `AgentTool` adapter. The old four-argument declaration and adapter description predate this source shape. The block converts expected tool throws to an error result and stops accepting updates when the tool promise settles; the declared raw tool-effect span is not emitted until T1 (§5.8); update/checkpoint promise retention and the await-both rule follow §3.8. `finalizeToolCall` applies the field-by-field patch before outcome staging and post-commit `tool_end`.

Before starting any call in a live batch, the procedure resolves `toolContext` once and filters the current `AgentHarnessTool` registry to the complete captured active-name set, retaining that procedure-local snapshot. The `executeToolCall` call site supplies each call's stable invocation (`invocationId: resultEntryId`, `operationId`, `turnId`, memos), update callback, tool context, and current invocation Context. An absent implementation — or a provider call outside the captured active names — becomes the §3.8 synthetic unknown-tool result and does not suspend the batch. Every call observes the same application context and its own stable invocation identity. Safe replay creates a new code/context snapshot but passes the same invocation id and memos after deleting the stale progress checkpoint. `AgentHarnessTool.replay` defaults to `"never"`.

There is deliberately no harness `executeToolBatch`. In parallel mode the direct procedure makes one source-ordered start pass; each position either starts a real promise or retains an immediate outcome until it can be staged. Effects/finalization settle independently: each complete result commits `outcome_ready` in completion order, and a separate Session mutation job materializes the contiguous ready prefix in source order. Durably, completed calls form a prefix while the suffix may mix `planned`, `effect_pending`, and `outcome_ready` — e.g. `[effect_pending, outcome_ready, effect_pending]` after the completed prefix. A crash discards only unstaged process-local outcomes; recovery safely replays or interrupts orphaned effects, materializes already-ready outcomes without resolving tool code, and reruns ordinary clearance for planned positions. The same procedure owns cancellation and durable batch completion. Genuine-`length` calls bypass effects but stage their specified synthetic outcomes (§3.7).

The legacy agent loop remains behavioral evidence for ordinary streaming and tool execution; harness differences are deliberate — `before_tool` returns explicit revalidated replacement arguments, hooks have explicit gate boundaries, parallel outcomes stage in completion order, entries materialize in source order. Remote protocol adapters validate untrusted wire data before returning typed provider values; the harness trusts those typed values and all in-process tool/hook/extension values, and violations are adapter or extension defects, not storage validation cases. Expected provider failures still become assistant `error` settlements, tool preparation/argument failures synthetic tool results, throwing hooks retain their documented handling, and invalid public caller operations return their declared errors before acceptance.

## 5.8 Telemetry

Use the existing callback-based `TelemetryContext`, no-op/reference implementations, typed schema machinery, and agent-owned schemas; do not invent a second contract. Invocation Context is passed explicitly as the trailing argument; no core `AsyncLocalStorage`, global active span, or mutable receiver default is permitted.

Local Context propagation and request-ID RPC cancellation follow §0.2, with these additions: child work derives a new immutable Context when it starts a child span; a pre-aborted request starts no server work; one request or drive joiner cannot cancel another caller. An aborted `context.abortSignal` must not call `requestAbort()`, write `cancel_requested`, or commit a durable aborted result while control remains running — only explicit `requestAbort`/`abort` owns that transition. Context objects, signals, telemetry objects, and backend-native span objects are never stored durably or serialized as business arguments. RPC currently carries cancellation metadata and reconstructs a fresh local cancellation Context. T1 retains the old specified trace recipe: the client injects trace metadata; the server extracts the incoming trace parent into a local `TelemetryContext`; then it derives a fresh invocation Context with both `withAbortSignal` and `withTelemetryContext` before invoking core. T1 must define the trace carrier encoding and implement that reconstruction; it does not reopen the composition rule. Whether selected adapter-managed typed values may also cross remains an RPC design decision. Shared receivers retain no caller Context and expose no receiver-level telemetry default; process-local objects representing one invocation (a drive pass, an event subscription) may retain their derived Context for that invocation only. Buffered events retain `{ event, context }`; `emitBatch` binds recipients synchronously so delayed local handlers and RPC event frames preserve source lineage.

**T1 — declared, largely unimplemented.** `src/harness/telemetry.ts` and the generated `docs/telemetry-schema.md` declare the span vocabulary below, but production starts only `pi.harness.hook`, and only for registered `before_tool`/`after_tool` handlers. AI options propagate `telemetryContext`, but no provider path starts `pi.ai.request`, and no tool-effect span is emitted anywhere. Server request ingress has request-ID cancellation signaling but no trace carrier and no client/server RPC spans. T1 must first reconcile whether every declared span is wanted, then implement or remove; RPC trace propagation and an exporter are separate follow-ups. The declared spans:

```text
pi.harness.run | compaction | navigation
pi.harness.checkpoint | turn | step | tool | hook | sleep | event_handler
pi.session.write
pi.ai.request
```

Specified span semantics for the implementation T1 commissions: operation, step, tool, hook, event, and write parents follow the actual async procedure nesting; sleep spans permit run, compaction, navigation, turn, and checkpoint parents; `stepId`/`taskId` correlate retries and recovery. Every provider request/fetch/cancel uses `pi.ai.request`; each real or safely replayed phase-two tool effect uses one tool span. Every storage transaction uses one `pi.session.write` whose start attributes include `pi.session.item_count` and `pi.session.item_kinds` (`entry`, `usage`, `value`, `list`); list appends/deletes are never reported as value replacements; a calling procedure may supply its lane/operation ids and storage never infers them from payloads; end attributes include first and last committed sequence. Tool-checkpoint, invocation-memo, and assistant-frame commits are ordinary value/list writes under this span and emit no additional tool- or provider-effect span; address namespaces may be attributes, but snapshot and frame content never enters telemetry. No span is emitted when a mutation returns without committing; synthetic settlements and blocked/invalid tools emit no provider/tool-effect span.

Telemetry attributes may contain declared ids, names, counts, durations, statuses, and usage — never prompts, completions, tool arguments/results, file contents, provider payloads, headers, handles, or credentials. Events and hooks may contain such content. The generated schema document and adapter/runtime conformance tests remain authoritative; implementation slices extend instrumentation only through those schemas.

# Part 6 — Future: partitioned retention (Postgres)

**Informative; no normative rule.** Memory, JSONL, and SQLite never partition and never delete entries or usage rows (§1.2); no core rule references this part. It records why §1.2's identity choices suffice for a possible Postgres deployment with TTL retention: UUIDv7 sorts bytewise in time order, so entries, the usage ledger, and `branch_entries` can use `PARTITION BY RANGE` on the id with period-boundary UUIDs as bounds and no partition column, while values, `branch_meta`, stats, and sessions stay in a hot unpartitioned catalog. Dropping a period requires an online pre-pass repairer (reparent edges crossing into the period, null dormant tips via value-seq CAS, force-expire open operations through the §3.13 terminal transaction under exclusive administrative ownership, uuid-range-delete labels), then one transactional lock barrier around delta repair plus plain `DETACH PARTITION`, so every commit sees either the fully attached period or a fully repaired store without it. A `DEFAULT` partition absorbs stray inserts whose ids predate every attached partition and is never dropped. A backend admitting an external repairer must perform value reads and CAS checks inside the commit transaction; shipping single-writer backends need no such rule. Retention policy, period granularity, and partition-count limits stay unspecified until the backend is real.

# Part 7 — Schema evolution

**R11 status: mechanism specified, not implemented; activation-gated.** No format-4 migration exists or is required: Memory is current-only, JSONL and SQLite reject unsupported storage versions, and SQLite runs only idempotent `001_initial.sql`. R11 becomes required immediately before the first incompatible durable change after format 4 stabilizes; format 4 is still WIP and pre-stabilization shape changes happen in place without migrations.

**Problem and why it is small here.** Durability snapshots in-flight state shaped like *today's* state machine; ship a different machine and old durable state still exists mid-run. Migration cost is proportional to what must convert: entries and usage rows (years) cannot be rewritten and must stay read-compatible; lane/semantic values are a few per lane; `pi.op.*` exists only for open operations (usually zero); `pi.pending.entry` holds queued items plus staged tool outcomes; `pi.pending.tool_output` only optional open-call checkpoints; `pi.pending.assistant_frame` only open-response frames (usually zero). With no history retained, the entire mutable surface is a few dozen current values/lists, and the host assigns one writable owner before migration starts — migrate-on-open has no concurrent writer.

**Mechanism: storage version plus migrate-on-open.** One session-level `storageVersion` lives in the catalog or header. A version number beats versioned namespace suffixes (`pi.lane.state.v2`): one number to check, chained `v1→v2→v3` migrations, no probing of historical namespace names, stable address components for point lookups.

```text
open session:
  version == current → proceed
  version  < current → run migrations in order, each one transaction:
                         convert lane/semantic/pending values,
                         handle open operations, bump the version
  version  > current → refuse to open (older binary, newer session)
```

Chained migrations run under exclusive host-assigned writable ownership before `open()` returns. Each step commits its conversions and version bump atomically, so a crash mid-chain resumes at the recorded version; conversions must be idempotent over already-converted values, which plain field mappings naturally are.

JSONL has one wrinkle in each direction: when R11 adds migrations, replay must decode exactly the older-version value/list records the migration names, because pre-migration bytes remain in the file; a migration then triggers snapshot compaction (J1), whose temp-file-and-rename persists the new header version atomically and retires the old bytes. Between crash and compaction, version-specific decoding plus idempotent conversion keep the intermediate state harmless. None of this adds compatibility for the pre-WP01 WIP format-4 spelling. Legacy format 3 predates `storageVersion`; it normalizes through Appendix B on load and receives the current version with its first format-4 write.

**Migrations are total.** Value conversion is a field mapping; a state-machine shape change is more — an old `pi.op.state` mid-phase may have no field-by-field equivalent in the new machine. A vN→vN+1 migration translates every stored value/list: lane/semantic values, `pi.pending.entry`, optional `pi.pending.tool_output`, invocation memos, and open operations' `pi.op.meta`/`pi.op.state` included (a migration adding `outcome_ready`, for example, must distinguish staged finalized tool results from still-uncertain effects). The author of a state-machine change writes the mapping for every reachable old state in the same change; a state with no natural successor maps to an explicit safe choice — no force-settle path or silent partial escape hatch. This is tractable because migration runs at open under exclusive host-assigned ownership over quiescent state: no task running, no effect in flight, every `pi.op.state` exactly what some transaction committed — a pure function over a small, fully enumerable, fully typed set of values.

Address and list rules (§1.3, §1.4) extend the discipline: a bound address's namespace, key grammar, and kind are static for one storage version — changing any component or value↔list kind is an explicit migration, storage never infers or coerces kind, changing the TypeScript value shape requires a total value migration when old values are incompatible, and adding a new address with no stored value rewrites nothing. A list migration pages current elements in sequence order and either maps values preserving each element's `seq` or deletes the whole key — never loading an unbounded list at once. A migration changing `AssistantMessageFrame` shape must map every surviving element or explicitly delete the whole list, leaving `effect_pending` recovery with no partial; it must never infer completion from legacy frames.

**Three strata as policy:** entries + usage carry the stability budget — provider-shaped messages plus three simple structural types, read-compatible forever (the precise rewrite §2.9 is administrative, not an open-time step; custom entry payloads are the application's contract). Lane/session values migrate on open, a few per lane, cheap forever. `pi.op.*`/`pi.pending.*` are ephemeral by design and few; every state-machine change ships the total mapping for its own states, and the cost is bounded by open operations — usually zero. Orchestration is ephemeral while the conversation format changes rarely, so migration cost is bounded by the small mutable surface and long-lived entries stay read-compatible.

# Part 8 — Work packages

A rolling plan, not a history. `harness.md` remains the normative behavior contract; a work-package handoff defines one executable implementation boundary. The evidence-backed inventory and dependency order live in [`post-wp05-roadmap.md`](post-wp05-roadmap.md); this part names packages and status only.

Workflow: keep a future package's row here until actionable; move exact files/tests/ordering/exclusions into one handoff; move newly discovered normative behavior into Parts 0–7 or Part 9; only then reduce the row to a link. Every package implements its named concern end to end and tests its normal path, introduced states, owned crash boundaries, and both orders of owned races. Consumption-time dereference checks, implementation resolution, hooks, events, and deterministic effect controls land with the package that first needs them; earlier packages do not build generic future machinery. If implementation exposes a contradiction or a materially simpler boundary, stop for review.

| ID | Status | Outcome | Handoff |
|---|---|---|---|
| WP00 | complete | Reconciled acceptance/hooks, harvested runtime1 scenarios, switched the public factory, deleted runtime1. | [Runtime1 removal](work-packages/00-runtime1-removal.md) |
| WP01 | complete | Bound values/lists across Session, Memory, JSONL, SQLite, instrumentation, conformance, public application access. | [Bound values and lists](work-packages/01-bound-values-lists.md) |
| WP02 | complete | Atomic prompt/skill/template acceptance, minimal open-operation attachment, Session mutation inspection, gap-free lane watch capture. | [Atomic acceptance and coherent attachment](work-packages/02-atomic-run-acceptance.md) |
| WP03 | complete | Removed the wall-clock drive deadline and non-durable yielded outcome. | [Remove drive deadlines](work-packages/03-remove-drive-deadlines.md) |
| WP04 | complete | Synchronous `emitBatch` publication; Session owns committed lane publication. | [Mutation publication and event delivery](work-packages/04-mutation-publication.md) |
| WP05 | complete | The total direct durable graph, public/replicated lane surfaces, immutable results, atomic boundaries, cancellation reconciliation, lane-safe provider identity. The [mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md) is its only recorded follow-up. | [Direct durable drive](work-packages/05-direct-durable-drive.md) |
| WP06 | complete | Separated Session, Branch, AgentLane, AgentHarness; one keyless Session mutation line. | [Session, Branch, Lane separation](work-packages/06-session-branch-lane-separation.md) |
| WP07 | complete | Removed SQLite storage-layer ownership; added live read-only source forks, no-create opens, deletion reservation, physical/path safety, and all-settled close. | [SQLite host ownership and live forks](work-packages/07-sqlite-host-ownership-live-forks.md) |
| WP08 | in progress — Slice A | Replace implicit-main forks with named-branch/tree semantics and bounded-memory backend copies. | [Named-branch and tree forks with streaming copies](work-packages/08-named-branch-streaming-forks.md) |
| WP09 | complete | Project effect-pending and settled-but-unplaced tool calls continuously through snapshots and lifecycle events until transcript placement. | [LaneSnapshot settled-but-unplaced tools](work-packages/09-lane-snapshot-settled-tools.md) |

WP05 subsumed the former R2–R12 execution rows; their implemented contract is in Parts 0–5 and the completed handoff.

Future candidates (detail and order in the roadmap): **WP08** — complete Slice A and the JSONL/SQLite streaming slices; **H1** — resolve the `OperationStatus.running`, abort signal/event-order, and private gate-close typing contracts and audit Part 9 coverage; **C1** — resolve the §2.8 raw-RemoteSession contradiction before implementing either direction; **L1** — repository ownership of open handles and all-settled close across the three backends; **J1** — implement the §1.7 snapshot rewrite, dead-byte triggers, preserved high-water/list sequences, physical reclamation; the **[mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md)** — implement tracked assistant progress, scoped durability, and delta replication without weakening unknown-outcome recovery; **R12** — implement `watchSession`; **T1** — reconcile the declared telemetry schema, then implement retained local spans (RPC trace propagation and an exporter are separate follow-ups); **S3** — reconcile the draft search API, then implement the standalone service, repository catch-up utilities, and the reference SQLite FTS5 projection (§2.8); **R11** — chained migrate-on-open under exclusive host ownership with total mappings (Part 7), activated only before the first incompatible stabilized-format change.

Client watch/subscription incarnation fencing, SQLite branch/query performance, pending-payload measurement, and optional presentation/plugin capabilities are inventoried in the roadmap; they do not alter the Harness state machine. Protocol, client/server resnapshot, and lane reducer surfaces required by WP05 are already implemented; future protocol work extends them rather than redefining the lane contract.

# Part 9 — Invariants and tests

## 9.1 Invariants

Storage:

1. Entries and usage rows are **write-once** and share one session-wide id namespace. Writing either kind under any existing id is corruption.
2. Transactions are all-or-none, with strictly increasing `seq` in write order; gaps are legal. `seq` is monotonic session-wide.
3. Bound values and lists are the only mutable state. `setValue` replaces the current value and `deleteValue` removes it; `appendList` adds one immutable element and `deleteList` removes every element at the exact address. There are no tombstones or per-element mutations, and JSON `null` is legal only where an address's type permits it.
4. **Every payload lives in exactly one place**: an entry, a bound value/list, or the ledger.
5. No read on a hot path may fold history or infer state from an absent value — no value history exists to fold. Execution, recovery, and branch hot paths must be index-driven; inventory and debugging APIs page through indexes. Bounded paged reads of an exact list address derived from current typed state are the one sanctioned ordered read; their contents are auxiliary and never restart authority. Every bound address has one stable namespace, key, kind, and trusted value type per storage version; value helpers cannot target list addresses or vice versa. Namespace `pi` and every `pi.*` namespace are reserved by contract; every built-in namespace starts with `pi.`, and application use is a trusted-programming defect. Core and applications use the same constructors with no privilege split. Exactly five core prefix constructors encapsulate lane inventory and operation-cleanup grammar and are consumed only by `scanValues`.

Tree:

6. An entry's parent chain never changes. Branches share prefixes; nothing is copied.
7. Entries are trusted typed internal values. Only a custom entry may omit payload data; external shape corruption is unsupported rather than revalidated on internal reads.
8. Configuration and orchestration never enter the tree. Deleting every operation-owned value and list must leave a complete, valid conversation and ledger.
9. A lane's tip moves only by append or navigation.
10. A branch segment chain, followed to its end, yields the full root path (§2.6).
11. A missing parent is corruption — always (§1.2).

Operations:

12. `laneState(lane)` confers lane ownership and `operationState(operationId)` operation-state ownership. An open lane names operation O, `operationMeta(O)` holds that lane's compatible `OperationMeta`, and `operationState(O)` holds an `OperationState` compatible with O's intent kind; state values carry no duplicate owner metadata. While a harness owns the session, exactly one live `Lane` owns each lane's authoritative projection and every supported write to that lane's control addresses commits through it.
13. Operation-owned values and lists may exist only while their operation is open: the terminal transaction deletes them atomically with clearing `currentOperationId` (§3.13). The lane inbox and its `pendingEntry` payloads are lane-owned and never deleted by terminal cleanup.
14. Acceptance must observe `currentOperationId === null`, commits no `Drive`, and returns before any hook/provider/tool/timer work begins. Run acceptance commits payload-free `starting`; only its consuming command may apply `before_run` output and replace it with `checkpoint`. A supplied operation id obeys §1.2 and is the exact id written to `pi.op.meta`, events, and its eventual `pi.result` record.
15. A reserved id may exist only with the content its intent named. Queued-content ids begin in `pi.pending.entry`; settlement-family ids begin as strings in `pi.op.state`. A tool-result id may then move through `string only → outcome-ready pi.pending.entry → immutable entry`; no two representations coexist at a commit boundary (§2.2). An effect-pending response id may additionally key its auxiliary frame list (§3.7); frames are observation, not a content representation, and die with settlement.
16. Only terminal transitions construct `OperationResultRecord`. Exactly one immutable `pi.result/{operationId}` is retained per terminal operation; older records remain readable after later operations, and recovery never reads any record.
17. At most one operation is open per lane. Two is corruption.
18. `overflowRecoveryUsed` is `true` only after overflow compaction. A transition that adds projecting conversational input or tool results and requires an assistant writes `false`; an unprojected custom write preserves it.
19. A response committed with `stopReason: "aborted"` has `control.status === "cancel_requested"`; every terminal transaction under cancelled control records `status: "aborted"`. Equivalently, a terminal `completed`, `declined`, or `failed` record proves control was still running at its terminal commit. Providers must comply with the harness-owned signal contract; violation is corruption.
20. Attachment restores and validates only the small lane/operation projection (§3.3, §4.4). That owned projection is authoritative until close, fault, or process loss. Detailed presentation references are validated by `watch(context)` under the Session mutation line; drive payload references are validated by their consuming procedure. Missing or contradictory required data faults that consumer, while optional frame/checkpoint absence is legal. Top-level operation state has one live writer; only parallel tool-call status and queued progress/memo writes require child-state fencing. `pi.result` never determines an open operation's next procedure.
21. At most one terminal transaction and one immutable result-record write commit per operation. The one lane-owned Drive is the sole top-level state-advance writer, and every terminal candidate serializes on the Session mutation line. Administrative mutation of a live Lane's reserved control values is unsupported; offline administration first acquires exclusive Session ownership.
22. At most one `Drive` exists per lane. Acceptance and taskless `requestAbort` never install one. A matching `drive` installs it before releasing the Session mutation line; another matching drive joins that pass, and a stale id starts nothing. Caller cancellation ends only that caller's observation. A live Drive is never replaced in-process. Close/fault seal mutation admission and reject observations without writing operation state. Each newly installed pass invokes `before_drive` once after the cancellation check; joiners do not. `starting` under cancelled control invokes neither `before_drive` nor `before_run`.
23. The §4.2 `Gate.admit()` catalog is complete. Every listed hook/provider/tool/timer integration calls `admit(() => operation())` after preparation; no unlisted code calls it. Admitted asynchronous provider setup/delegation owns `drive.gate.signal`.
24. `drive` and `requestAbort` are fenced by expected operation id. They may affect only that current operation; `drive` may also return any matching immutable terminal result, including records older than the lane's latest. A stale wake for A cannot drive or cancel B.
25. No public drive option encodes a wall-clock budget or partial-progress return. An admitted effect settles normally or is recovered from durable state after task loss; host scheduling and process termination remain outside the harness contract.
26. Convenience operations and their explicit primitive compositions produce the same durable writes, events, results, and recovery behavior. Structural continuation is an ordinary empty-prompt acceptance with a fresh operation id; a competing acceptance may win the idle window. Convenience adds only process-local waiting/scheduling policy.
27. Each logical tool call's public `invocationId` is its reserved `resultEntryId`: unique within the session and unchanged across safe replay. Tools must await invocation-memo writes. Such writes synchronously enqueue, verify effect-pending ownership on the Session mutation line, and are deleted with outcome staging.
28. Completed tool calls form a source-ordered prefix. A sequential suffix permits at most one effect-pending or outcome-ready call before planned calls; a parallel suffix may mix `planned`, `effect_pending`, and `outcome_ready`. Completion-order outcome staging never extends the prefix; source-ordered materialization does.
29. Every outcome-ready call has exactly one matching finalized `pi.pending.entry`, no immutable result entry, no invocation memos, and no tool-output checkpoint. Outcome-ready and completed calls never execute again.
30. A tool progress checkpoint is an optional bounded complete `AgentToolResult` snapshot, selected with `checkpoint:true`. It never proves completion. Every selected checkpoint synchronously enqueues one invocation-fenced value replacement; no write is dropped or coalesced, only the latest write promise reference is retained, and awaiting it implies completion of every earlier write. Staging or terminal cleanup deletes the value and fences late recreation.
31. Assistant/deferred operation state is the sole restart authority for streamed partials. One effect-pending response id constructs exactly one `pendingAssistantFrames(operationId, responseEntryId)` address; every element is an exported pi-ai `AssistantMessageFrame`; frame order is a subsequence of provider event order because already-covered queued events produce no frame; terminal `done`/`error` events are never stored; frames never establish provider completion or suppress unknown-outcome recovery.
32. Every final or synthetic response settlement — normal, recovery, or cancellation — atomically deletes its exact frame list. Idle forks contain no frame lists. A restored partial may appear in `streamingMessage` but never in `transcript` before settlement.
33. The provider loop never awaits storage per frame; frame appends are enqueued synchronously in provider-event order, and awaiting the latest frame-write promise at stream settlement implies every accepted append completed.
34. Successful attachment publishes only complete lane projections and an open-operation inventory. It resolves no model/tool identity and starts no work. A later drive uses the authoritative owned projection; storage reads only dereference payloads named by that projection.
35. Every event-producing committing harness lane job publishes its owned projection and calls `emitBatch` with its complete event batch in the exact continuation that observes commit, as the callback's final action; this includes AgentLane appends, lane and metadata setters, acceptance, and AgentLane acquisition/attachment. The mutation never awaits delivery, but the public operation does. A lane watch registers buffering and clones live presentation synchronously, then performs bounded durable reads while holding the line. Snapshot plus buffered events has no gap or duplicate and replays no pre-registration lifecycle. `emitBatch` binds recipients and the emitting Context immediately; a delayed watcher receives the object-identical source Context, never its start Context. For non-navigation histories, `reduceLaneSnapshot` folding those events equals a later snapshot; navigation explicitly rebases through `resnapshot`.
36. Shared Harness/AgentLane/Session/Branch receivers retain no invocation Context and expose no receiver-level telemetry default. Concurrent calls preserve independent telemetry and cancellation lineage. Context and its values are neither durable operation data nor serialized business arguments. RPC cancel/disconnect reaches only the matching invocation through `context.abortSignal` and never becomes durable cancellation.
37. Process-local model/tool registry absence never becomes durable waiting state or an acceptance error. Pre-intent request-configuration absence fails in-band without fabricating a response/usage; missing requested tools stage `isError` tool-result messages with no invented details; uncertain effects settle under their existing recovery rules first.
38. `beginMutation()` acquires exactly one Session mutation line, `commit()` consumes at most one commit capability without releasing that line, and `end()` alone invalidates and releases it after any admitted commit settles. `Session.mutate()` always ends in `finally`; its callback cannot end early; direct `beginMutation()` callers end in `finally`. Local — and, if C1 commissions one, remote — implementations preserve the same read → decide → commit → process-local publication → end order (§2.8).

## 9.2 Race catalog

Each durable mutation race has exactly two durable histories. Matching callers install or join one lane-owned Drive; stale operation ids are rejected. Test every listed order with test-only commit gating and controlled hooks, providers, tools, and timers.

| Race | Orders |
|---|---|
| `prompt` vs `prompt` on one lane | both compose `accept`; one accepts, one gets `LaneBusy` |
| `accept(A)` vs process loss before `drive(A)` | acceptance absent → serving layer retries; acceptance present → restored `starting` drives normally, with no unknown effect |
| `drive(A)` vs `drive(A)` | one installs the pass; the other joins exactly that pass and may drive again after its outcome |
| stale `drive(A)`/`requestAbort(A)` vs current B | expected-id mismatch; B is untouched |
| `requestAbort` vs response settlement | marker first → normalized `aborted`; terminal commit first → completed record and later abort mismatches |
| `abort` vs started tool outcome staging | abort first → real result stages under cancelled control; outcome first → finalized result is preserved and later materializes |
| checkpoint vs tool settlement | every accepted checkpoint was enqueued before settlement closed admission; settlement awaits the latest write, then staging deletes the value; a late update is fenced without committing |
| assistant frame append vs response settlement | settlement awaits the latest frame write, then its transaction deletes the list; a crash between leaves the committed frame prefix under `effect_pending` |
| live update event vs its queued frame/checkpoint commit | either finishes first; events are observation, and reconnect uses only committed frames/checkpoints |
| later tool B settles vs earlier tool A | B stages outcome-ready immediately; tree placement waits for A |
| `abort` vs `before_run_end` follow-up | marker first → stale hook output is dropped and reconciliation aborts; follow-up commit first → the run continues under the later cancellation marker |
| `cancelQueued` vs boundary consumption | cancel first → `cancelled`; consume first → `already_consumed`; abort drain first → `not_found` |
| `setModel` vs generation step start | old snapshot used; or new snapshot used |
| `abort` vs structural commit | `aborted` with no entry; or `completed` |
| `nextRun` vs acceptance | captured by this run; or stays for the next |
| structural A terminal vs convenience continuation B | B accepts queued input as an ordinary run; or a competing acceptance wins and the convenience returns A only |
| structural result boundary vs queued input | input commits first and is selected in the one publication commit; publication commits first and input remains queued for the next boundary/operation |
| abort drain response vs process/transport loss | caller receives drained steer/follow-up; or content is durably gone and the response is lost by the accepted drain-and-return tradeoff |
| manual-compaction preparation vs idle tree write | write before the final command → stale preparation is discarded/recomputed; acceptance first → the write follows active-operation rules; preparation never blocks the lane |
| deferred write vs abort | write survives abort either way |
| `requestAbort` vs `before_drive`/`before_run` admission | admission first → the complete hook pipeline runs and its consuming command observes cancellation; cancellation first → reconciliation runs and neither hook starts |
| `requestAbort` vs ordinary operation admission | admission first → operation is invoked with the signal; cancellation first → gate refuses invocation |
| attachment vs concurrent resume | attachment owns the session before publication; after return, resume uses the authoritative owned projection and stale `open` remains harmless |
| watcher registration vs state publication | watcher first → old snapshot plus the complete buffered event batch; publication/`emitBatch` first → new snapshot without that old batch |
| close vs attachment | create completes and publishes a fully open harness; or close/fault rejects attachment without a partial harness |
| snapshot capture vs resume | capture first yields pre-resume snapshot plus events; resume publication first yields post-transition snapshot |
| concurrent invocation contexts | each call/event/session write retains its own telemetry parent and abort signal; cancellation ends only that caller observation and writes no durable cancellation |
| `close` vs settlement | settlement abandoned, state stays `effect_pending`; or it committed before the flag was set |

## 9.3 Test tiers

**Tier A — state and drive.** For each of the 13 leaves in Part 3: construct it durably, close, reopen, drive its expected operation id, and assert the next durable transition, wait, or terminal result. Coverage includes accepted/restored `starting`; minimal projection restore; required/optional watch references; assistant unknown-outcome recovery with no/partial/authoritative-end frames; every classification and retry/deferred outcome; every tool child status and source-order placement; memo/checkpoint fencing; every summary boundary and overflow crash position; summarized/unsummarized navigation; cancellation reconciliation from every leaf; configuration failures; terminal deletion of operation-owned args, memos, checkpoints, frames, preparations, staged outcomes, and pending payloads; immutable `pi.result`; preservation of the lane inbox; representation exclusivity; and every half-completed recovery prefix.

For each recovery prefix: close, reopen, drive, and compare against uninterrupted recovery — invoking recovery twice from the initial prefix is **not** sufficient. Every operation kind also covers accept → close before first drive → reopen → drive. At every test-controlled committed lane boundary, compare the published `Lane.state` with a fresh `restoreLaneState` result; divergence is an implementation defect, never silently healed by the next transition. One corruption assertion constructs an `aborted` response with running control directly and requires the consuming transition to reject it as an invariant defect; provider conformance separately proves implementations emit `aborted` only for the supplied signal.

**Tier B — writer conformance.** Run the public harness against the instrumented-storage decorator (a spy wrapping `Storage.commit()` recording every transaction's writes in order); assert exact write order and content against the Part 3 transaction tables and §5.5 ordering, with faux provider/tool/hook spies interleaving starts/events with commits. It catches: effects before intent; missing awaits of latest update delivery or checkpoint write before `after_tool`; per-frame storage awaits in the provider loop; frame appends out of provider-event order or persisted for `done`/`error`; settlements missing their frame-list delete; `tool_end` before rather than after staging; missing response/usage settlement; checkpoint or frame writes after their child state settled; outcomes not staged before replay becomes impossible; out-of-order tree placement; late result-id reservation; memos or staged/checkpoint/frame values leaked by outcome/terminal cleanup.

**Tier C — deterministic interleavings.** Every race in §9.2, in both orders, with test-only gated commits and controlled hooks, providers, tools, and timers.

**Cross-cutting:**

- **Backend conformance.** One suite, three backends, identical results — including explicit begin/commit/end lane exclusion, commit-without-release, end-without-commit, close waiting for end, checkpoint value set/replace/delete, list append/page/whole-key-delete with identical sequence cursors and reduced frame sequences, and torn-transaction handling exposing no list element. Memory/SQLite retain one current checkpoint; JSONL may retain superseded bytes physically, but compaction (J1, once implemented) must produce identical logical state including preserved list cursors. Internal values are not cloned or shape-validated. Write-order assertions use the instrumented decorator, never a durable log.
- **Attachment and watch.** Construct every durable phase directly and assert minimal open inventory, configured/captured identity inspection without resolution, projection corruption faulting create, presentation corruption faulting watch, exact required/optional ad-hoc reads, no attachment effects, Session mutation inspection, complete snapshots, live-over-durable partial precedence, no historical lifecycle replay, recipient binding at `emitBatch`, and both registration/publication orders without gaps or duplicates.
- **Drive equivalence.** Convenience calls and explicit `accept`/`drive`/`requestAbort` compositions produce byte-identical durable state and equivalent events/results.
- **Deterministic transition control.** Test-only storage gating parks commits without production annotations; controlled hooks, providers, tools, and timers expose effect windows. Each runtime slice tests every durable edge and both orders of each owned race.
- **Effect-start gate.** Cover every item in §4.2's catalog and assert no other path calls `Gate.admit()`. At each integration, force both orders of abort versus admission: abort-first invokes nothing; admission-first gives the complete operation `drive.gate.signal`. Provider tests assert request preparation precedes the check and the same signal reaches Models auth/lazy/provider work. Hook tests treat each aggregate pipeline as one admitted unit. A cancelled drive must enter reconciliation without invoking `before_drive` or `before_run`.
- **Invocation context.** Public operations receive trailing Context; hooks/listeners/callbacks and Session reads/writes preserve it. Cross concurrent calls on one shared receiver and assert independent telemetry/cancellation lineage. Buffered delivery retains the object-identical emitting Context. Context is never written durably. An RPC cancel/disconnect aborts only its reconstructed request signal, and invocation cancellation never writes `cancel_requested`.
- **Signal ownership.** No public surface accepts a standalone operation signal; invocation cancellation arrives through `Context.abortSignal`, operation-owned effect signals remain harness-controlled, and a `before_request` patch carrying a signal has it stripped. Assert by type and by test.
- **Ledger completeness.** Every settled attempt commits its response and its usage; failed structural attempts retain their cost; `getStats()` equals the ledger sum after every commit; a fork starts at zero.
- **Query-plan guards.** `EXPLAIN QUERY PLAN` for `scanBranch` matches §1.7 exactly — no `entries` scan or temporary ordering b-tree. Segment tests assert copied rows are bounded by the newest compaction interval.
- **Transaction discipline.** Assert every SQLite transaction that may write opens with `BEGIN IMMEDIATE`. Add a regression test that reads, lets a second connection commit, then writes — it must succeed, and would fail with `database is locked` under a deferred `BEGIN`.
- **Segment chain soundness.** Build a chain by alternating branch-and-append across several compactions, then assert a full-to-root scan through the chain returns exactly the entries a flat branch would, with no duplicates and no gaps. Both §2.6 rules — resolve-through-base coverage and the chain-searched newest compaction — fail this test when violated, and fail silently without it.

---

# Appendix A — Glossary

Shorthand vocabulary only; common terms already defined clearly in the body are omitted.

| Term | Meaning / defined in |
|---|---|
| **Pending entry** | Complete unplaced content in `pi.pending.entry` until placement/cancellation/cleanup (§2.2). |
| **Inbox** | Lane-owned globally ordered tagged queue (§3.11). |
| **Result record** | Immutable `pi.result/{operationId}` terminal disposition (§3.13). |
| **Continuation run** | Fresh ordinary run accepted by structural convenience code when queued conversational input remains (§5.1). |
| **Operation status** | Process-relative observation: `running`, `open`, or `aborting`; idle is no current operation; never predicts registry availability. |
| **Open operation** | Attachment inventory item for a lane with durable current work; not a reservation or continuation policy (§4.4). |
| **Attachment** | Minimal lane/operation projection restore plus open inventory; starts no execution (§4.4). |
| **Drive / drive pass** | The one installed lane-owned process-local pass (§4.1). |
| **Effect** | Anything not pure computation: commit, provider request, tool, hook, timer. A **repeat-sensitive effect** is one whose repetition is observable outside the harness. |
| **Effect gate** | Process-local synchronous arbitration of effect admission against cancellation (§4.2). |
| **Reserved id** | An id minted before content exists (§2.2). |
| **Follower id** | An id minted with its leader's 48-bit timestamp so a call/result group shares one time prefix (§1.2). |
| **Session mutation line / mutation** | The Session-wide serialization point and its explicit read/one-commit capability (§2.8, §4.3). |
| **Control** | Orthogonal per-leaf cancellation flag: `running` or `cancel_requested` (§3.2). |
| **Checkpoint / boundary pass** | Durable resting leaf between turns, and the one-decision procedure that resolves it (§3.12). |
| **Continuation** | Durable answer to "does this run still owe an assistant turn?" (§3.2). |
| **Tool checkpoint** | Optional bounded complete live-update snapshot in `pi.pending.tool_output`; auxiliary, never completion authority (§3.8). |
| **Assistant frame** | Compact replayable pi-ai stream frame in `pi.pending.assistant_frame`; auxiliary, never completion authority (§3.7). |
| **Outcome ready** | Tool call whose finalized result is durable and will never execute again, awaiting source-ordered placement (§3.8). |
| **Invocation memo** | Tool-invocation-scoped durable value for replay-safe memoization (§3.8). |
| **Terminal transaction** | The commit performing the universal terminal suffix (§3.13). |
| **Segment** | A branch-index range referencing an older branch instead of copying it (§2.6). |
| **Precise rewrite** | The administrative copy-retained-and-swap rebuild of a session store (§2.9). |

# Appendix B — Coding-agent v3-format compatibility

"v3" here names the legacy coding-agent JSONL session format, not this document. Old v3 files must open unchanged and restore idle. Normalization on load:

- `custom_message` becomes a custom agent message.
- `label` and `session_info` become session-name/entry-label values (latest by file position wins) and leave the tree. A label target resolves through discarded nodes to its nearest retained ancestor; if resolution produces `null`, the label is skipped.
- Legacy `model_change`, `thinking_level_change`, and `active_tools_change` nodes disappear from the tree. The importer uses the nearest change of each kind on the selected physical main path to write ordinary total main-lane configuration plus idle state before returning; an unsupported nearest value does not fall back to older history. Missing active-tools history normalizes to `[]`; missing or unsupported required model/thinking history leaves main data-only.
- Each retained child of a discarded node is reparented to its nearest retained ancestor. `main`'s tip is the final physical node resolved the same way.
- An old compaction resolves its legacy `firstKeptEntryId` field against its own branch and materializes that range as `retainedTail`. Format 4 never exposes or persists that field.
- Existing `details`, `usage`, and `fromHook` are preserved; absent `fromHook` normalizes to `false`. v3 ISO timestamps convert to Unix milliseconds.
- A v3 `parentSession` path resolves to an available parent header id; otherwise it is preserved as `legacyParentSessionPath`.
- On first format-4 write, append one aggregate adjustment usage row with `details: { source: "v3-import" }`, summing v3 node usage so ledger-derived totals remain unchanged.
- Legacy v3 ids are re-minted at import: each entry gets a UUIDv7 whose prefix is the legacy entry's own timestamp (random tail), preserving time order and §1.2's every-id-is-time-prefixed property. All references the format knows are remapped — parent chains, `main`'s tip, surviving label keys, non-null `fromId`, usage `entryId`. Ids embedded in opaque payloads are not rewritten; the opaque-payload contract (§1.2) covers them.

Read-only open leaves the file unchanged and computes stats from normalized entry snapshots. The first format-4 write persists normalization through a temporary file and atomic rename over the original path, including the aggregate adjustment so subsequent stats are ledger-derived, and stamps the current `storageVersion` (Part 7). Forking an open legacy-v3 source rejects until a normal non-empty commit persists its normalized format-4 ids. A closed legacy-v3 source is parsed without mutation: tree forks remain available; branch forks require a reconstructable complete configured main lane and use its normalized tip when `entryId` is omitted, while data-only main rejects.

# Appendix C — Open questions

1. **Overflow detection remains heuristic.** The normalization specified in §3.7 is authoritative. Preserve the original reason in `errorMessage` for diagnosis.
2. **Pending-payload write amplification.** The deliberate double write (§1.8) is paid only by queued items; measure it for pathological payloads before optimizing (`INSERT … SELECT` placement exists on SQL backends, eager compaction on JSONL).
