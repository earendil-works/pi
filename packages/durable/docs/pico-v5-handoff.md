# Pico5 implementation handoff

`packages/durable/docs/pico-v5.md` is normative. Implement this list in order.
After every package: run its tests, run `npm run check`, and stop for user review.
Do not redesign later packages while implementing the current one.

Pico3 is reference material only. Preserve useful behavior, not its capability
facades, membranes, document routing, view projection, events, or clone chains.

## Status

- Obsolete `pico` and `pico4` prototypes were removed.
- `pico3` remains.
- Packages 1–17 are implemented in `packages/durable`; Package 10 was already satisfied by Chord's canonical structural diff implementation.

## 1. Records, cursors, and memory tables

Implement IDs, sequences, reserved root conversation ID `1`,
`ConversationRecord`, `EntryRecord`, strict input/write `SubmissionRecord`
values, live/terminal `TaskRecord` values, document records, storage writes, backend-opaque JSON cursors, and
detached `MemoryStorage` tables.
Reserve `Conversation` for the public conversation object, `Entry` for the typed
entry definition, and `Task` for the typed executable definition returned by
`defineTask()`.

Test reserved root identity and immutable creation, mixed atomic commits,
rollback, detached reads/writes, cursor boundaries,
fork-aware entry scans through deep ancestor caps, head lookup,
entry-to-commit lookup, full task replacement, and submission replacement/
request-ID lookup.

## 2. Memory document records

Add selected document base/delta writes, retirement, reincarnation,
current/as-of membership, exact logical-address lookup, scoped scans, and
materialized point-in-time reads. Storage keeps base/delta revisions private and
returns a detached value plus its stored definition version. It applies Chord
`Op[]` directly and receives no definition callbacks or unused candidate values.

Test Session-, conversation-, and task-scoped documents, half-open lifetimes,
create-plus-retire, retired historical membership, family queries, current-only
reclamation, version boundaries, detached ownership, and no scans of unrelated
document records.

## 3. SQLite backend

Implement the complete storage contract with ordinary rows and indexed document
records. Do not translate Chord operations into SQL JSON patches.

Run the memory conformance suite after reopen. Test SQL transaction rollback,
recent/ancient as-of reads, query plans, latest reclamation, WAL checkpointing,
deleted-page reuse, and representative storage sizes.

## 4. JSONL publication

Implement table writes in `main.jsonl`, one document sidecar per incarnation,
one sidecar per live task, and one main marker per commit. Do not add a
standalone-sidecar protocol.

Copy, rather than import, the current `ExecutionEnv`, `FileSystem`, `Shell`, Node
implementation, and their required utility files from `packages/agent/src/harness`
into `packages/durable/src/env`. Copy only the environment-related slice, not
agent skills, prompts, telemetry, or tool definitions. Extend the copied
filesystem contract with exact-byte file truncation and file flushing. JSONL
depends only on `FileSystem`, not the broader `ExecutionEnv`. Keep the portable
environment and JSONL entry points free of Node built-ins; expose Node
implementations only from `/env/node` and `/storage/jsonl/node`. Do not use the
Pico3 implementation as source material.

Refactor the current `MemoryStorage` state machinery into a two-phase prepared
mutation: validation and detachment produce a candidate that can later be
applied without failure. Build `MemoryStorage.commit()` on that pair, and reuse
the same machinery for JSONL. JSONL must append every prepared sidecar record,
append the main marker, and only then apply the prepared in-memory mutation.
Serialization or preparation failure occurs before file I/O and does not poison
the backend. Retained indexes/materializations remain detached from write
arguments, and reads never expose backend-owned cached objects.

JSONL creation has `fsync?: boolean`, defaulting to `false`. With `false`, append
sidecars and then the marker without an explicit flush. With `true`, append all
affected sidecars, flush each affected sidecar, and then append the main marker.
Do not explicitly flush `main.jsonl` for ordinary publication. A main-only commit
has no sidecars to flush. Any uncertain publication append or flush failure
poisons the open backend and publishes no prepared in-memory mutation. Package 5
adds the separate post-publication flush required to authorize reclamation.

Fault-test torn/short sidecar writes, failures between sidecars, every marker
boundary, unconfirmed tails, missing confirmed data, poisoned writes, exact-byte
tail truncation, both fsync settings and their call ordering, detached retained
state and reads, and browser-safe portable entry points. Run the complete storage
conformance suite directly and after reopen.

## 5. JSONL reclamation

Implement task-document retirement and current-only base reclamation using
committed markers and descriptor invalidation. Remove a sidecar directly when no
records remain; otherwise use temporary replacement and rename. With `fsync:
true`, flush `main.jsonl` once before destructive reclamation so the authorizing
marker cannot disappear while cleanup survives; if that flush fails, skip
reclamation without failing the already-published commit. Flush a non-empty
temporary replacement before rename. This is not publication flushing or main
compaction.

Crash-test every rewrite/rename boundary. Verify that rewindable history is
never reclaimed and default no-fsync behavior matches the specification.

## 6–7. Tracker transaction core, definitions, and typed access

**Prerequisite:** `@earendil-works/chord/delta` exports the canonical
Astra-immutable-optimized `track`, `Tracker`, `Change`, and `Prepared`, and its
draft placements reject values that are not strict JSON.
Experimental variants under other Delta directories are not Pico APIs.

Implement these packages as one milestone. Keep the implementation layers
separate, but do not build a temporary untyped document-acquisition seam.
Implement the generic `Tx` table surface these tests require: exact table reads,
paginated conversation/entry/task scans, `ReadAfterWrite`, ID-creating writes,
and full task replacement. Scans expose the Storage cursor and caller-selected
limit; they never hide an unbounded full scan. Semantic
conversation, entry, task, and scheduler behavior remains in Packages 13–17.

Keep one Astra-immutable tracker per loaded document. Its trusted immutable
`value` is the current shareable revision. `prepare()` emits detached
self-contained operations and computes the next revision with the optimized
immutable applier; operation placement payloads and that revision may share
containers, and neither may be mutated. `adopt()` validates ownership and
revision, then only pointer-swaps to the already-computed value.

Implement scope-preserving singleton/family tokens and overloads for Session,
conversation, and task owners. Only `tx.doc()` is get-or-create: singleton tokens
supply `initial()`, while family calls always supply key and seed and use only the
first seed when absent. Definitions are explicit typed arguments, not registered
declarations; conflicting definitions claiming one persisted kind are
unsupported caller misuse.

On first `tx.doc()` access, memoize the acquisition promise by logical address
before awaiting it, then call `tracker.beginChange()`. Repeated access returns the
same overlay draft for the whole possibly async Session callback. The Session
line permits only one open change per tracker. A callback that settles with an
unresolved acquisition rejects: seal `Tx`, abort open changes, drain and abort
the pending acquisition, and observe its failure. Callback failure aborts every
change. Callback success prepares every change before Storage admission.

Do not walk prepared operation payloads or selected bases for strict JSON; they
are strict JSON by construction. Tracker branding and revision checks enforce
ownership and staleness. Evaluate each staged document write exactly once and
pass Storage only the selected base value or operation batch. Keep every previous immutable revision unchanged through Storage
settlement. On success, adopt every prepared value by pointer swap and enqueue
its immutable revision/operations publication before releasing the line. On
Storage failure, abort prepared changes, poison the Session, and publish nothing.
Preparation failures roll back normally; Package 8 adds checkpoint selection and
its failure path.

Initializer, migration, and replacement roots are copied into exclusive kernel
ownership with a strict-JSON check before becoming trusted immutable revisions.
Loaded and fork-copy roots come detached from Storage and are tracked without
another copy. Chord copies and strict-JSON-checks every draft placement and
throws at the offending assignment. Astra empty batches suppress
ordinary writes, while replayable nonempty structural no-ops remain valid writes
and publications. No runtime freezing or second operation-payload copy is
required.

Snapshot, source, and watch lookup never create and return `undefined` when
absent. `snapshot()` returns the shareable immutable current revision; callers
must copy before mutation. A read-only migration may cache its migrated immutable
tracker together with the older stored-version marker, without writing; the next
successful `tx.doc()` still writes the required current-version base.
Transaction-staged creation or migration enters the shared cache only after its
enclosing Storage commit succeeds. All cold loads run on the Session line; a
loaded immutable revision may be read without copying.

Test callback failure; escaped-draft revocation at callback settlement; concurrent duplicate
acquisition; callback failure and success with a pending acquisition; late
acquisition after sealing; concurrent initialization once; initial bases; family
first-seed wins; scope/token mismatch; non-creating reads; shared immutable
snapshots and stable prior revisions; empty-batch suppression and replayable
redundant structural no-ops; multi-document preparation failure; uncertain
Storage failure poisoning; old-revision stability through Storage settlement;
pointer-swap and replacement adoption; operation/revision payload sharing under
the trusted no-mutation contract; non-JSON initializer and draft-placement
rejection; assignment copying and repeated-placement
independence; authority and prepared-draft non-escape; terminal-task rejection;
task-derived conversation identity; retirement; reincarnation-bound sources;
and unload/reload. Include create-task-then-document,
document-after-terminal rejection, and create-document-then-terminal settlement
in one transaction; internal candidate validation must not trigger
`ReadAfterWrite`.

## 8. Checkpoints and migration

After tracker preparation, Session evaluates `checkpointWhen(value, ops, { deltasSinceBase })` exactly once
for ordinary mutations and sends Storage only the selected base or delta.
Implement required creation/version bases and lazy all-older-version migration
on typed access; Harness open does not scan ordinary documents.

Test read-only in-memory migration, `tx.doc()` migration rollback and coalescing
with later edits, rewindable migration on current/historical read, the first
successful `tx.doc()` version base even without a JSON change, newer-version
rejection, migrated state/watch hydration without a write, subsequent operations
against that migrated baseline, stored-version fork copying, unaccessed and unavailable-definition
preservation, predicate failure rollback before Storage admission, and checkpoint
starvation without backend heuristics.

## 9. Conversation document forks

Using fixture conversations and entry-to-commit mappings, implement the `asOf`,
`current`, and `initial` settings for singleton and family documents.

Test opaque stored-version copying without definitions, retired membership, new
child incarnations, later lazy migration, lazy `initial` creation, and exclusion
of task- and Session-scoped documents.

## 10. Chord structural array operations

**Chord-owned prerequisite/integration:** the canonical Astra-immutable operation
generator must encode compact replayable array changes; Pico only verifies and
consumes it.

Improve the canonical generator so ordinary positional mutations encode
scattered removals without carrying retained payloads. Callers must not write
operations manually.

Test front/tail/middle/scattered/all/no removal, retained 256 KiB and 1 MiB
payloads, append plus removal, later nested/index writes, exact replay, unchanged
previous immutable revisions, and equality between Astra's prepared candidate
and immutable operation replay. One prepared document change remains one Session
commit; no intermediate candidate is adopted or published.

## 11. Chord document state

Use Chord's existing `ReplicatedStateSource` attachment contract internally, but
expose one already-attached read-only `DocumentState` per acquisition. It must
atomically hydrate in O(1) from the current immutable revision and publish later
exact committed immutable value/operation frames without another tracker, value
copy, or re-diff. Disposal unregisters that one state. Pico remains the sole
document mutator.

Test contiguous Chord delivery sequences, atomic hydrate/subscribe, a baseline
that covers queued publication without duplicate application, exact value and
operation reference sharing, retirement to `null`, incarnation-bound recreation,
independent state disposal, migrated hydration, definition-free fork copies,
tracker-cache unload, and trusted mutation footguns.

## 12. Document watches

Implement non-creating `watchDoc` as an incarnation-bound `WatchHandle` that
returns `undefined` when absent and atomically captures the current immutable
revision in O(1) while registering for later exact committed frames. Before
`start()`, its value remains the acquisition revision. After start, invoke one
serialized asynchronous listener with each exact value and operation batch,
advancing `watch.value` immediately before the callback. Preserve commit Context
values without inheriting producer cancellation.

Retain at most 100 pending frames, excluding the in-flight callback. Adding frame
101 replaces the complete undelivered suffix with one root replacement carrying
the newest exact immutable revision and Context. Do not estimate serialized
bytes, call `JSON.stringify()` for accounting, copy values, replay operations, or
re-diff revisions.

Test updates between acquisition/return/start; exact values and operation
references; no callback overlap; listener-initiated commits; commits during an
in-flight callback; overflow before start and behind an active callback;
retirement folded into an overflow reset; replayable redundant structural
commits; delivery Context value preservation; retained earlier revision
stability; trusted mutation footguns; retirement before start and while active;
recreation; idempotent stop; second-start rejection; cancellation during
acquisition; cancellation/close during a callback without aborting or joining it;
listener-error settlement; and invocation-owned cleanup in package 14.

Packages 13–20 are vertical milestones. Each must leave one real public path
working end to end; do not defer all integration to the last package.

Cross-cutting constraints for these milestones:

- Introduce each persisted built-in document kind once, with its final schema,
  history/fork policy, migration, checkpoint predicate, and public mount path.
  Record that concrete protocol in the normative specification when the kind
  lands. Do not add temporary built-in kinds or later replace a fake schema.
- Keep all visible progress durable. Tests may use faux models and fake effects,
  but production code must use pi-ai's exported `Models` interface and the real
  task chain; do not add a Pico model adapter or production fake successor.
- Prepare every loaded `ConversationView` revision from the complete candidate
  Session commit before Storage admission. Never rebuild a view by subscribing
  to already-committed table/document publications.
- A milestone may leave later operations unimplemented, but it must not expose a
  temporary public facade. Extend the final §2.2 objects as later behavior lands.

## 13. Openable Harness

Implement the first usable slice of the final §2.2 surface: `Harness.open/close`
with a registry, `root(context, { init })`, `conversation(id)`,
`createConversation({ ownership, init })`, and generic
inherited Session document APIs (`Harness extends Session`). Implement the
public `Entry` definition token and `Conversation` handles rather than adding an
intermediate capability facade. `Conversation` provides `id`, conversation-bound
`commit()`, fork-aware cursor `entries()`, `context()`, `fork(at, { ownership,
init })`, and every configuration getter/setter.

Implement the §7.1 registry core: `createRegistry()`, `tools.add`, `tools.wrap`
composition, `batch`, keyed ordering with remembered positions, `Registration`
`dispose`, immutable `snapshot()`, and list helpers. Hook,
task, and system prompt registrations are stored and listed now; their dispatch
lands in Packages 14–16.

Bring conversation and entry semantics up to the normative contract: explicit
ownership, fork-aware cursor pagination, head lookup, entry edits, and model
context derivation. Context reduction includes newest-edit wins, positional PR
#9548 `SystemMessage` replay, tool-result ordering, missing post-fork tool
results, excluded stop reasons, and separate raw-history/model-context results.

Define the final `ConversationConfig` document from §2.2. Raw document writes
are trusted and unchecked. Root creation uses the internal reserved-ID
bootstrap in one commit together with the default configuration and `init`; do
not expose a temporary root-creation API.

Open ignores live tasks in this milestone; Package 14 adds reconciliation.

Acceptance: open persistent storage, obtain the root, mutate configuration and
history through public handles, create and fork conversations, close, reopen,
and verify stable root/conversation identity and state. Test lazy root creation
with `init` run once; atomic create/fork with `init`; actual forks; deep ancestor
caps; same-commit entry prefixes; cursor boundaries; self-head resolution;
newest-edit wins; raw head-to-tail transcript versus model context; model-less
and excluded assistant entries; replacements/omissions; multiple heads;
positional system messages; tool-result ordering; missing post-fork results;
every configuration getter/setter; `setActiveTools` duplicate and newly-added
unregistered rejection with stale names allowed; default active tools from the
registry; as-of configuration inheritance including unavailable names; registry
add/dispose/batch rollback/nested-batch rejection/keyed order/wrap composition;
and reopen.

## 14. Durable task runtime

Implement `defineTask`, exhaustive phase maps, full checkpoint replacement,
kind migration at reservation, runtime commits and memos, invocation lifetime
gates, scheduler reservation, dependencies, terminal outcomes, typed waits,
and joins. Complete the task-facing §2.2 methods: `resume`, `getTask`,
`waitForTask`, `abortTask`, and the task-aware portion of idle waits. Task definitions come from the registry snapshot;
add `RegistryReader.subscribe()` so registry changes wake the scheduler.

Include the execution-critical abort core: durable direct-task marks,
signal-and-join of an active run, fresh abort invocation, run-commit rejection
after a mark, and close precedence. Deep owned-subtree cascading and background
boundaries remain Package 18. Open now reconciles every surviving `running` task
to `pending`. Missing, too-old, and unmigratable definitions leave the task pending and
blocked (§5.4); registry changes wake the scheduler to reconsider them. Aborting
a blocked task settles it as `orphaned` with the full cleanup; nothing else
orphans a task. Implement per-phase registry snapshots, refresh at
every normal phase boundary, and hand over when the task definition object changed
and the new definition can reserve the task.

Deferred to later packages; do not stub them in Package 14:
- Orphaning writes the terminal `orphaned` record and retires task documents.
  Unanswered input submissions and clearing run control are added in Package
  15, when submissions and run control exist.
- `TaskRuntime.hooks` (the hook runner) is added in Package 16 with hook
  dispatch. Package 14 adds `runtime.registry` (the phase's registry snapshot)
  and `runtime.models`.
- `TaskRuntime.conversation()` returns a `ConversationHandle`, whose `submit`
  needs Package 15 and whose `abort`/`waitForIdle` need ownership traversal; it
  is added with the invocation-bound owned APIs in Package 18.
- Idle waits count live non-background tasks directly (Harness-wide or in the
  addressed conversation). Traversal through owned conversations and background
  boundaries replaces this in Package 18.

Use a fake two-phase external effect to test the real runtime. Acceptance is an
intent/effect/outcome task interrupted after intent, closed, reopened on the same
storage, and safely resumed to a durable terminal receipt. Also test unchanged-
checkpoint faulting, same-phase progress, cancellation precedence, thrown
handlers, dependencies, result values and entry IDs, first-writer-wins memos,
terminal checkpoint/memo removal, task-document retirement, close/reopen without
abort marks or fabricated outcomes, no fresh phase/abort dispatch while closing,
watch cleanup, blocked tasks unblocked
by later registration, migration failure leaving the record unchanged, handover
after a same-name task replacement, no handover to a missing or incompatible
definition, no overlap between predecessor and successor
invocations, abort of a blocked task settling as `orphaned` with full cleanup,
run commits rejected after the mark, and crashes at every direct-task abort stage.

Implemented design notes: every task transition is decided by one callback
serialized on the Session line (reservation, abort marks, runtime commits, and the
step before each phase). `Tx` has no task replacement; `runtime.commit()`
callbacks return the typed next state. `suspend()`, `hold()`, `quiescent()`, and
a public `markTask()` were dropped from §2.2.

## 15. First runnable no-tool chat turn

Implement the smallest real input-to-answer vertical path. Extend Package 14's
`orphaned` settlement to mark affected input submissions unanswered and clear
matching run control in the same commit, through the Harness hook for
scheduler-written outcomes (§5.4); the scheduler learns nothing about turns or
task kinds. Implement the final `pi.live` document (§8.2) with `run` and
`generation`, the built-in entry kinds (§8.1), and the `pi.generation` task
(§8.3). The inbox document is defined in Package 17 with its first writer. Add
input `Submission` admission, request-ID deduplication, reacquisition and
waiting, idle placement, active-turn ownership, successful answer settlement,
and terminal failure cleanup. Expose the final `SubmissionDraft` union. Idle
write submissions append their entry and settle `done`. Until Package 17, every
submission to a busy conversation rejects with `ConversationBusy` regardless of
`whenBusy`, writing nothing. Busy steer/follow-up behavior, queued writes, and
reset remain Package 17.

Also implement the decided surface changes: typed entry tokens
(`defineEntry<D extends JsonValue>`, token-first `tx.appendEntry()` and
`tx.entry()` overloads); removal of `input` from `createConversation()`;
built-in tasks pre-registered by `createRegistry()` (undisposable, not
overridable, required by `Harness.open`); the `TaskRuntime` additions
`snapshot`/`snapshotAsOf`, `context()`, `now()`, and `report()`; and the
`streamOptions`/`retry` configuration fields with their getters and setters.

Implement the §7.4 system prompt: rendering registered sections with `tag` and
wrappers, and no-tool request preparation, including
exact persisted rendered strings, positional system baselines/deltas with empty
`content`, head-cut rebaselining with `ContextEdit` omissions, order-only
two-entry rewrites, and section failure handling. No tools are offered in this
package: preparation emits no tool declarations and passes `PromptInput.tools`
as `[]`. Until Package 16, a `toolUse` response settles as the answer.
Implement the ordinary generation phases needed for one response: preparation,
request intent, durable throttled partials, attempts/retry classification,
deferred handle polling/cancellation, assistant entry settlement, and input-
submission completion.

Call pi-ai only through its exported `Models` methods: `getModel()`,
`streamSimple()`, `fetchDeferred()`, and `cancelDeferred()`. The test double must
implement that same interface; production code gets no adapter. A missing configured model produces
the durable `no_model` failure. All progress exposed to observers is committed
state, never raw provider frames.

Acceptance: `Harness.open → root → resume → submit(input) → Submission.wait →
durable assistant answer → close/reopen`, using faux Models in tests. Exercise
interruption and reopen before/after every implemented generation phase,
aborted-partial conversion, deferred polling/cancellation, retryable and
terminal model errors, no-visible-undurable updates, exact section order/value
patches, complete post-head baselines, retained system deltas on both sides of a
head marker, sections reading conversation documents through `input.read`,
throwing sections, preparation
rerun after a concurrent tail/config commit, fault and orphan turn cleanup,
typed entry tokens, and durable submission settlement. This is also the first print-mode smoke path: print
awaits its own input submission rather than global idle.

## 16. First coding-agent tool turn

Implement hook dispatch and `TaskRuntime.hooks`, deferred from Package 14
(Session-wide and scoped to a conversation or its owned subtree, §7.2), and wire
the real generation → tool tasks → post-tools → generation chain (§8.3–8.5).
Neither side uses a production fake successor.

- Generation: tool declarations in preparation (§7.4: additions/removals,
  same-name replacement, order rewrite, complete baseline after a head cut,
  duplicate active names offered once, wrapped and failing wrappers,
  `PromptInput.tools`); `toolExecution` pinned in `request`/`poll`; the tool
  round commit (offered check against the committed context through `cutoff`,
  unaffected by `beforeRequest`; `tool_unavailable`
  results for calls not offered, parallel or `after`-chained sequential tool
  tasks, post-tools, `pi.live.tools`, run handed to post-tools);
  `beforeRequest`, `afterResponse`, and `onYield` continuations.
- `pi.tool` (§8.4): input `{ assistant, callId }`, resolve/validate/
  `beforeTool`/validate/intent/execute/`afterTool`/result in one `call` handler,
  recovery-only `execute` with the stored/current replay rule, bounded output and
  details in the `pi.live.tools` slot, the terminal commit as final flush,
  diagnostics (`api.diagnostic()`, result diagnostics, Harness truncation and
  error codes, the `<harness>` block, `pi.tool-result` `data: { diagnostics }`),
  and the abort handler.
- `pi.post-tools` (§8.5): `afterTools`, `addTools`, all-results `terminate`, the
  `postTools`/`final` boundaries (no inbox placement until Package 17), and the
  next generation. The `handoff` control moves to Package 17 with `reset()`,
  which defines the headed entry both write.
- `pi.live.tools` and the checkpoint rule (§8.2); the scheduler cleanup hook for
  `pi.post-tools` (ends the run) and `pi.tool` (marks the slot `done`).
- Surface: `ToolExecutionApi` without `conversation()`, which the `src` type
  drops until Package 18 adds it with `ConversationHandle`; `api.env` and `HarnessOptions.env`,
  `ToolRegistration.executionMode`, the `toolExecution` configuration field with
  its getter/setter, `TaskRuntime.getTask()` and `entry()`, `HookApi`, and the
  exported `GenerationTask`, `ToolTask`, and `PostToolsTask` tokens.
- `@earendil-works/pi-durable/tools`: copy `read`, `bash`, `edit`, and `write`
  with their helpers from `packages/agent/src/harness/tools` and adapt them to
  `ToolRegistration` (`api.env`, `api.output`, `api.details`). Image reading in
  `read` is deferred; note it where the tool rejects or skips images. The env
  shell streams raw output (`onOutput`) and spills past thresholds; `output()` is
  the only place output is bounded, sanitized, and throttled. `prepareArguments`
  restores the edit tool's argument repair.

Acceptance: input → model tool call → registered local read/bash/edit operation →
tool result → model answer → durable submission settlement. Run that path once
normally and once interrupted/reopened. Test recovery from every tool and post-
tools phase; offered-set enforcement, including a tool deactivated after
preparation still executing; before/after hook rules, hook scopes, and hook
memos; `onYield` continuations; both stored/current replay-policy directions;
default and overridden `outputLimits`; output content fallback; details
replacement, last-details fallback, and coalesced commit settlement; the terminal
commit as final flush; abort/close with buffered output; invocation-bound
watches; parallel and sequential rounds, including a per-tool sequential mode;
unregistered active tools that are removed from the offered set, re-added after
re-registration, and produce `tool_unavailable` results when called, without
failing the request; a tool replaced mid-call finishing under the implementation
it resolved; hooks surviving a task reload; order-only tool changes; atomic
assistant/tool/post-tools commits; `terminate` only when every result requests
it; `addTools`; tool fault/orphan leaving a synthesized context result;
diagnostic ordering, the `<harness>` block, and entry `data`; and all
positional tool-history cases. Also test the ported tools against
`NodeExecutionEnv`, and a wrapper supplying a different `api.env`.

Document in the durable README that the package root loads TypeBox through the
tool task's argument validation (pi-ai `validateToolArguments()`): about 23 MB of
peak RSS unbundled, about 4 MB in a tree-shaken bundle.

Tool output benchmark (`test/*.bench.ts`, memory, SQLite, and JSONL): drive the
real tool task, adaptive throttle, and `pi.live` commits with low (a line every
few seconds), normal (a compiler or test run), and high (continuous `cat` of a
large file) output rates, head and tail retention, one tool and several parallel
tools, over one long round. Report commits, operation bytes written, stored
size before and after the round's base, reclamation, heap and RSS, commit
latency, and reopen/replay time mid-round. Assert that head output commits as
Chord appends and that a sliding tail of non-repetitive output within 64 KiB
commits as trim plus append; report how often repetitive output falls back to a
full window set. The checkpoint rule stays "base whenever nothing runs" (§8.2) with
no delta-count bound; the benchmark decides whether that holds. Assign
`slot.output` as one string field so Chord can diff it; replacing the slot
object records a full set.

Throughput target: a plain `cat` of a 1 GiB file of unique lines through the
ported bash tool and the real Harness path (env capture and spill, `api.output`,
throttled `pi.live` commits, result entry) completes in about 0.4 s, like the
mini coding agent. Also drive `api.output()` directly with the same 1 GiB in
64 KiB chunks: accepting a chunk must not cost work proportional to the
retained window.

## 17. Live UI and product state

Complete submissions and the inbox (§6): the `pi.inbox` document created by the
built-in setup; busy `steer`/`followUp`/`reject`; queued writes; admission to an
idle conversation with a non-empty inbox (queue, then a final boundary in the
same commit); withdrawal removing the item; `tx.placeSubmission()`; ordered
`postTools`/`final` selection by the new `steeringMode`/`followUpMode`
configuration fields (with getters/setters), writes before user items; stale
head writes; a reset at `postTools` ending the run with `reset`; successor runs;
and `onYield` applying only when the final boundary selected no user item and no
reset. Only an answer, `terminate`, or `handoff` applies the final boundary;
failure, a run task's abort, fault, and orphan leave the inbox alone.
Successful inputs still require an answer; writes settle on placement and never
start generation by themselves.

Define the `pi.reset` entry (§8.1), written by `Conversation.reset(handoff)`
through a write submission and by the post-tools `handoff` control.

Usage (§8.6): the `pi.usage` document created by the built-in setup, updated in
the same commit as every assistant entry (`appendAssistant()`) and every tool
result with `usage` (`ToolExecutionResult.usage`, `appendToolResult()`), and
`Harness.usage()` summing every conversation's document.

`ConversationView`, `viewState()`, and `watch()` (§9.3): one mount per
conversation, built lazily on the Session line, advanced from
`subscribeCommits()` publications, and dropped with its last observer.

Last: the experimental `watchEvents()` adapter (§9.4) with the snapshot event,
translated message and tool deltas, and overflow-to-snapshot.

Examples next to the existing ones in `test/examples/`: a print demo awaiting
its own `Submission`, a JSON demo with two modes, `--events` (adapter
events as JSON lines) and `--ops` (raw `ConversationView` frames), an inbox
demo, and a late-join demo attaching a view and an event stream mid-run. An
interactive TUI demo and coding-agent integration are later work.

Table-test every submission transition, cross-type request-ID conflicts,
interleaved queue selection under both queue modes, writes placed before user
items, stale head writes, a reset at each boundary, handoff, `onYield` with and
without queued items, compact positional removal of large payloads, withdrawal,
reopen waits, queued items surviving a failed run and drained by the next
submission, and orphan/fault cleanup. Test minimal Chord deltas for `pi.inbox`
and `pi.usage` changes. Test one view revision per touching commit; atomic
entry/document publication; fork-aware active entries and head cuts; mounted
create/retire; empty-batch suppression; stable paths; structural sharing; watch
overflow; and dropping the mount. Test the event translation of every
`MessageChange` and output change, the snapshot at attachment and after
overflow, and absence of raw provider frames.

## 18. Ownership and subagents

Complete the remaining owned-conversation and abort semantics: durable foreground
subtree cascades, signal/join/fresh-abort across ownership edges, background
boundaries, ordinary and full traversal, conversation abort, and exact idle
waits. Finish invocation-bound owned APIs used by tools and the foreground and
background subagent provisioning patterns, including atomic task/conversation/
registry creation and request-ID-safe submission recovery.

Test deep ownership trees, owner edges after terminal settlement, nested
background boundaries, conversation abort/join with surviving passive writes and
background tasks, cancellation of waiters without cancellation of work, and
atomic cancellation intent. Test default non-inheritance, inheritance from the
current committed tail, empty source conversations, document fork policies,
configuration overrides through `init`, foreground subagent cascade, and
background supervisor recovery before and after submission admission.

## 19. Compaction and overflow

Implement manual, threshold, and generation-overflow compaction; exchange-boundary
range selection; summarization; retry policy; staleness checks; and headed
summary entries. Wire generation's real overflow path directly to the compaction
task, and complete `Conversation.compact()` so it returns the admitted task ID.

Generation preparation no longer rechecks the transcript before appending its
system entries (§7.4, §12): only run tasks and turn boundaries write to a busy
conversation. A compaction summary for a busy conversation must therefore be
placed at a turn boundary or as a step of the run, never appended concurrently.

Test model context before and after compaction, raw history preservation, provider
failure, declined and stale work, manual/threshold/overflow admission, late-join
presentation state, and reopen from every phase. Rerun generation overflow
integration without a fake compaction kind.

## 20. Reload and final conformance

Complete any remaining §2.2 surface and lifecycle gates and the §7.5 in-process
reload path through the registry: batch replacement while the Harness keeps
running, pinned in-flight work, and task handover at phase boundaries.
Close/reopen is not required for reload.

Test that close seals commit and mutation admission, lets already-admitted
storage settlement finish despite caller cancellation, stops future state/watch
delivery, joins task/tool/hook invocations outside the Session line, writes no
abort or terminal outcome, starts no fresh abort invocation, and never runs old
and new Harness generations concurrently. Include cancellation during watch
acquisition and an already-running callback that remains caller-owned across
shutdown. Verify service withdrawal and client detach.

Run the exhaustive public conformance matrix: stable persisted root identity;
all root/create/lookup/fork/reset/compact/abort/idle paths; every configuration
getter/setter and fork override; typed input/write submissions; task wait/abort;
generic document access; registry changes before open, between open and resume,
and while work runs; structural watches; and blocked tasks surviving open. Compile-test every §2.2 and §3 owner/key/seed overload,
the normative usage sequences, and the Chord guide. The erased registry test must
use a concrete narrowed-input task with multiple checkpoint phases and custom
hooks. Verify that a Chord root-replacement delta remains distinct from a
Session-selected storage checkpoint.

Run all package-specific tests and the repository check. Finish with a local
coding-agent turn and a reopened interrupted turn through the public Harness,
then stop for final review.
