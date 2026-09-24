# Pico5 implementation handoff

`packages/durable/docs/pico-v5.md` is normative. Implement this list in order.
After every package: run its tests, run `npm run check`, and stop for user review.
Do not redesign later packages while implementing the current one.

Pico3 is reference material only. Preserve useful behavior, not its capability
facades, membranes, document routing, view projection, events, or clone chains.

## Status

- Obsolete `pico` and `pico4` prototypes were removed.
- `pico3` remains.
- Packages 1–5 are implemented in `packages/durable`; later Pico5 runtime packages remain.

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
Implement the generic `Tx` table surface these tests require: table reads,
`ReadAfterWrite`, ID-creating writes, and full task replacement. Semantic
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

After tracker preparation, Session evaluates `checkpointWhen(value, ops)` exactly once
for ordinary mutations and sends Storage only the selected base or delta.
Implement required creation/version bases and lazy all-older-version migration
on typed access; Harness open does not scan ordinary documents.

Test read-only in-memory migration, `tx.doc()` migration rollback and coalescing
with later edits, rewindable migration on current/historical read, the first
successful `tx.doc()` version base even without a JSON change, newer-version
rejection, migrated source/watch hydration without a write, subsequent operations
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

## 11. Chord document source

Chord's existing `ReplicatedStateSource` attachment and `replicatedState(source)`
adoption contract already matches specification §9.1; this is Pico-side work.

Implement Pico's opaque committed document source on that contract. It must
atomically attach in O(1) to the source's current immutable revision and later
committed immutable revision/operation frames without another tracker, value
copy, or re-diff. Pico
remains the sole document mutator. Trusted immutable source revisions and
operation placement payloads may share containers.

Test contiguous Chord delivery sequences, atomic hydrate/subscribe, a snapshot
that already covers a queued publication without duplicate application,
retirement between source acquisition and attachment hydrating `null` rather than
a replacement, retirement ending one incarnation, recreation requiring
reacquisition, listener isolation, and mutation footguns. Reuse the transaction
core's immutable published value; do not materialize another document copy.

## 12. Document watches

Implement non-creating `watchDoc` as an incarnation-bound `WatchHandle` that
returns `undefined` when absent and atomically captures the current immutable
revision in O(1) while registering for later revisions. Before `start()`, its
value remains the acquisition revision. After start, retain only the last
delivered and newest committed immutable revisions. Off the Session line, derive
`diffRevisions(lastDelivered, newest)` and advance the handle's value to
`newest`. An empty diff advances silently. A nonempty diff invokes one serialized
asynchronous listener with a watch-owned cancellation Context carrying values
from the newest coalesced commit's Context. Do not retain operation queues,
estimate serialized bytes, call `JSON.stringify()` for accounting, or construct
reset frames.

Test updates between acquisition/return/start; asynchronous initialization from
a stable immutable revision; no callback overlap; listener-initiated commits;
commits during an in-flight callback; coalescing many revisions directly to the
latest; an empty net diff silently advancing without a callback; replayable
redundant structural commits coalescing away when state is unchanged; delivery
Context cancellation ownership; retained earlier revision stability; trusted
mutation footguns; bounded revision-reference retention; retirement before start
and while active; recreation; idempotent stop; second-start rejection;
cancellation during acquisition; cancellation/close during a callback; diff and
listener-error settlement; `closed` self-join misuse; and invocation-owned
cleanup in package 15.

## 13. Conversations and entries

Implement conversation history/ownership records, entry creation,
conversation-bound cursor-based fork-aware scans, head lookup, and entry edits.
Expose public history pagination through `Conversation.entries()`, never through
`Harness`.

Test conversation creation and actual forks, deep ancestor caps, same-commit
entry prefixes, newest-edit wins, self-head resolution, raw head-to-tail
transcript, and ownership traversal.

## 14. Context derivation and system messages

Implement model-context reduction, PR #9548 positional `SystemMessage` replay,
tool-result ordering, and missing post-fork tool results. Replay `content`,
ordered named `sections` with `null` removal, then tool removals/additions.

Test model-less and excluded-stop-reason entries, replacements/omissions,
multiple heads, section replacement/removal/re-addition order, order-only
configuration changes between separate request preparations, rejection of
integer-like section keys, tool addition/removal/replacement order, and raw-view
versus model context.

## 15. Task definitions and invocations

Implement `defineTask`, exhaustive phase maps, full checkpoint replacement,
kind migration, runtime commits, memos, and invocation close gates.

Use a fake two-phase effect. Test intent/effect/outcome recovery,
unchanged-checkpoint faulting, same-phase checkpoint progress, cancellation
precedence, thrown-handler faulting, close/reopen without abort marks, outcomes,
or task-document retirement, no fresh phase/abort dispatch while closing,
first-writer-wins memos, and automatic watch cleanup.

## 16. Scheduler and terminal tasks

Implement reservation, running-task reopen reconciliation, dependencies,
terminal outcomes, waits, holds, joins, and orphaning.

Test result values and entry IDs, terminal records after reopen, dependency
eligibility, unknown kinds, and terminal removal of checkpoints/memos.

## 17. Abort and owned conversations

Implement durable abort marks, signal/join/fresh-abort invocation, owned
conversation creation, subtree traversal, background behavior, and idle waits.

Test commit rejection after a run task is marked, crashes at every abort stage,
close precedence over a previously marked task, deep ownership trees, atomic
retirement of task-scoped documents, default non-inheritance, inheritance from
the current committed tail, an empty source conversation, document fork
policies, and explicit model/section seed overrides.

## 18. Submissions and positional inbox

Define the initial inbox and turn-control documents, then implement strict input/
write `SubmissionRecord` variants, `Conversation.submit()`, request-ID
deduplication, awaitable/reacquirable submissions, busy admission, withdrawal, queue modes,
and `postTools`/`final` boundaries. Successful input settlement requires an
answer; write settlement means entry placement and never starts a turn. Use a fake successor
task.

Table-test every submission transition, cross-type request-ID conflicts,
interleaved steer/follow-up/write selection, self-head cuts, stale targets,
successor triggers, reopen waits, writes pending without a later boundary,
compact large-payload removals, abort results for queued/placed/terminal
submissions, and orphan/fault cleanup of active turn control.

## 19. Remaining built-in documents and view

Define the concrete configuration, preference, and live presentation documents;
reuse the approved inbox/turn definitions. Record all IDs, fields, history,
fork settings, migration, and checkpoint predicates in the normative
specification.

Implement `{ conversation, entries, docs }` as immutable structurally shared
revisions produced by the optimized immutable applier. Build the first revision
lazily on the Session line. For every later affected Session commit, derive the
mounted operation batch and prepare its next revision before Storage admission;
a failure rolls back normally. After Storage succeeds, finalization only installs
prepared pointers/cursors and enqueues publication. Conversation
watches use Package 12's O(1) acquisition and latest-revision coalescing.

Test direct task writes, one publication per Session commit, atomic
entry/preview settlement, parent-linked active-entry reconstruction, head
changes, mounted create/recreate/retire transitions, preparation failure before
Storage, empty mounted-batch suppression, redundant nonempty mounted revisions,
contiguous revisions, stable public paths, immutable O(1) acquisition,
asynchronous consumer
initialization, serialized updates, revision/payload structural sharing,
coalescing behind an in-flight callback, retry/collapse late-join status,
bounded-output truncation metadata, and absence of semantic projection. Specify
which diagnostics become entries, terminal details, or bounded document state.

## 20. Registries, hooks, and sections

Implement task/tool/section registries, Session and owned-subtree hooks,
positional PR #9548 section/tool updates, complete baselines after a head cut,
and preparation revision checks. Do not add a Session-kernel semantic event
journal or extension-state router; package 24 adds the thin product notification
adapter from specification §9.4.

Test registration lifetimes, hook replay with memos, exact persisted rendered
section strings, minimal section patches and `null` removals, complete baseline
tool declarations, and a head cut that retains earlier system messages. Verify
the new baseline entry omits those messages through `ContextEdit` before replay,
including retained `content`, section order, and tool changes. Include a retained
delta whose ID precedes the head-carrying entry: select omissions by retained
context membership, not an ID comparison with the head entry. Test tool loadout
additions/removals and preparation retry after registry movement. Do
not implement in-process replacement of Session-side extension code; a host extension
change uses the Harness close/reopen boundary.

## 21. Tool and post-tools tasks

Implement offered-set checks, argument validation, tool hooks, durable bounded
progress, owned APIs, interrupted/replay-safe recovery, result entries,
post-tools joining, controls, and boundaries using fake tools.

Test recovery from every phase, both stored/current replay-policy directions,
default and overridden bounds, streamed-content fallback, progress replacement
and coalesced commit settlement, drain-before-terminal ordering,
abort/close with buffered output, invocation-bound owned handles, and atomic
assistant/tool/post-tools settlement. Use a fake
generation successor; package 22 replaces it and reruns integration.

## 22. Generation task

Implement preparation, request intent, durable throttled partials, attempts,
retry policy, response classification, continuation, and deferred polling/
cancellation through pi-ai's exported `Models` interface. Do not add a Pico
model adapter. The faux test double implements that same interface.

Test every phase before and after reopen, aborted partial conversion, overflow
through a fake collapse kind, input-submission settlement, and no visible-undurable update.
Replace the fake tool successor and rerun the package 21 integration tests.

## 23. Collapse task

Implement manual, threshold, and overflow collapse; exchange-boundary range
selection; summarization; retries; staleness; and headed summary entries.

Test context before/after collapse, provider failure, declined/stale work, and
reopen from every phase. Replace generation's fake overflow target and rerun its
overflow integration test.

## 24. Harness integration

Implement the exact public surface in specification §2.2:
`Harness.open/resume/suspend/close`, lifecycle gates, root/create/lookup
`Conversation` objects, typed input/write `submit()` and `Submission` objects,
conversation-bound commits and history pagination, fork/collapse/reset/abort/idle,
typed task wait/abort, generic document access, task/tool/section registries, and
structural conversation watches. Do not restore Pico3's
namespace router, fixed document accessors, semantic view events, or manual Chord
view bridge.

Expose service withdrawal/client detach and product wiring. Implement the §9.4
agent-mode notification adapter directly from uncoalesced committed publication,
without another tracker or persistence authority. Migrate TUI hydration to the
structural conversation watch, make print await its own input `Submission`, and expose
JSON/RPC correlated commands plus ordered committed notifications. Test that
watch latest-revision coalescing cannot erase a separately subscribed
notification lifecycle, late clients use structural hydration rather than event
replay, progress notifications
reflect durable throttled state rather than every provider frame, and stdout
backpressure/disconnect policy stays in the mode adapter.

Implement the v1 host-extension reload path as stop admission, close/join, dispose,
rebuild with new document tokens and registered task/tool/section definitions, reopen/migrate live tasks, and resume. Ordinary documents migrate
on later typed access. Test that closing seals commit and
mutation admission, lets storage settlement for already-prepared admitted
commits finish despite caller cancellation, stops watches, joins in-flight watch
callbacks and task/tool/hook invocations outside the Session line, writes no abort
or terminal outcome, starts no fresh abort invocation, and does not run old and
new generations concurrently. Include cancellation during watch acquisition and
a non-cooperative watch callback in shutdown/extension-reload quiescence tests.

Test stable persisted root identity; atomic conversation/config/section/input-
submission creation; default `"off"` thinking; every configuration getter/setter; explicit
active-tool seed duplicate/unregistered rejection; default active registry
snapshot; as-of fork inheritance including unavailable historical names; durable
`missing_active_tool` settlement; fork seed overrides; concrete-entry forks;
collapse task-ID return;
busy reset admission and later placement; mark-only versus signalling abort;
conversation abort/join with surviving passive writes and background tasks;
quiescence with eligible work; listener initial/future delivery and isolation;
and runtime registration between open and resume without resurrection of a task
settled during open.

Compile-test every §2.2 and §3 owner/key/seed overload plus the usage sequences
in the normative specification and Chord guide. Verify that a Chord root
replacement delta remains distinct from a Session-selected storage checkpoint. The erased registry test must include a concrete task with narrowed
input, multiple checkpoint phases, and custom hooks. Run all package-specific
tests and the repository check. Verify a local
coding-agent turn and a reopened interrupted turn, then stop for final review.
