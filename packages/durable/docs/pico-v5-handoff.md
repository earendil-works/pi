# Pico5 implementation handoff

`packages/durable/docs/pico-v5.md` is normative. Implement this list in order.
After every package: run its tests, run `npm run check`, and stop for user review.
Do not redesign later packages while implementing the current one.

Pico3 is reference material only. Preserve useful behavior, not its capability
facades, membranes, document routing, view projection, events, or clone chains.

## Status

- Obsolete `pico` and `pico4` prototypes were removed.
- `pico3` remains.
- No Pico5 implementation exists.

## 1. Records, cursors, and memory tables

Implement IDs, sequences, reserved root conversation ID `1`,
`ConversationRecord`, `EntryRecord`, tagged inputs, live/terminal `TaskRecord`
values, document lifecycle records, storage writes, backend-opaque JSON cursors, and
detached `MemoryStorage` tables.
Reserve `Conversation` for the public conversation object, `Entry` for the typed
entry definition, and `Task` for the typed executable definition returned by
`defineTask()`.

Test reserved root identity and immutable creation, mixed atomic commits,
rollback, detached reads/writes, cursor boundaries,
fork-aware entry scans through deep ancestor caps, head lookup,
entry-to-commit lookup, and full task replacement.

## 2. Memory document records

Add selected document base/delta writes, retirement, reincarnation,
current/as-of membership, exact logical-address lookup, scoped scans, and
base-plus-tail reconstruction. Storage receives no definition callbacks or
unused candidate values.

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
standalone-sidecar protocol. Serialization must also provide the storage ownership
boundary: retained indexes/materializations are detached from write arguments,
and reads never expose backend-owned cached objects.

Fault-test torn/short sidecar writes, failures between sidecars, every marker
boundary, unconfirmed tails, missing confirmed data, and poisoned writes.

## 5. JSONL reclamation

Implement task-document retirement and current-only base reclamation using
committed markers, temporary replacement, rename, and descriptor invalidation.

Crash-test every rewrite/rename boundary. Verify that rewindable history is
never reclaimed and default no-fsync behavior matches the specification.

## 6. Tracker transaction core

Keep one tracker per loaded document. Add transaction begin, callback rollback
from the unchanged baseline, flush, fatal post-flush failure, committed baseline
adoption, and eviction. After storage succeeds, materialize one immutable
published value per changed document with `applyImmutable(previous, ops)`,
separate from mutable tracker and borrowed storage candidates.

Do not add membranes, transaction proxy graphs, capability facades, or defensive
full-document clones. Test callback failure, no-op transactions, storage failure
poisoning, immutable prior published values, replacement-payload ownership, and
unload/reload.

## 7. Document definitions and access

Implement `defineDoc`, `defineDocFamily`, document kind/key validation, the three
direct scopes, and get-or-create `tx.doc`, `snapshot`, and `documentSource`
acquisition. Definitions are explicit typed arguments, not registered declarations;
conflicting definitions that claim one persisted kind are unsupported caller
misuse.

Test concurrent initialization once, initial bases, detached snapshots, family
initializer use only on first creation, scope/target mismatch, terminal-task
rejection, task-derived conversation identity, retirement, and
reincarnation-bound sources. Include create-task-then-document,
document-after-terminal rejection, and create-document-then-terminal settlement
in one transaction; internal candidate validation must not trigger
`ReadAfterWrite`.

## 8. Checkpoints and migration

After tracker flush, Session evaluates `checkpointWhen(value, ops)` exactly once
for ordinary mutations and sends Storage only the selected base or delta.
Implement required creation/version bases and lazy all-older-version migration
on typed access; Harness open does not scan ordinary documents.

Test latest migration persistence, `tx.doc()` migration rollback and coalescing
with later edits, rewindable migration on current/historical read, first
post-migration mutation base, newer-version rejection, unaccessed and unavailable-definition
preservation, predicate failure poisoning, and checkpoint starvation without
backend heuristics.

## 9. Conversation document forks

Using fixture conversations and entry-to-commit mappings, implement the `asOf`,
`current`, and `initial` settings for singleton and family documents.

Test opaque stored-version copying without definitions, retired membership, new
child incarnations, later lazy migration, lazy `initial` creation, and exclusion
of task- and Session-scoped documents.

## 10. Chord structural array operations

Make ordinary positional mutations encode scattered removals without carrying
retained payloads. Callers must not write operations manually.

Test front/tail/middle/scattered/all/no removal, retained 256 KiB and 1 MiB
payloads, append plus removal, later nested/index writes, exact replay, and
unchanged previous immutable snapshots. Internal flushes must remain one commit.

## 11. Chord document source

Add the thin opaque-source adapter to `ReplicatedState`. It must use committed
value/ops directly, with no tracker or re-diff.

Test contiguous Chord adapter delivery sequences, atomic hydrate/subscribe,
attachment races, retirement ending one incarnation, recreation requiring
reacquisition, and listener isolation. Reuse the transaction core's immutable
published value; do not materialize another document copy.

## 12. Document watches

Implement get-or-create `watchDoc` as an incarnation-bound `WatchHandle` that
atomically captures one fixed immutable value and registers for later committed
operation batches. `start()` installs one serialized asynchronous listener.
Bound the pending queue only by the total number of operations in its undelivered
batches. Never estimate serialized bytes or call `JSON.stringify()` for delta
queue accounting. When the operation-count limit is exceeded, compact the entire
undelivered suffix into one root replacement using the matching latest immutable
published value from package 6; never retain mutable tracker or borrowed storage
candidates.

Test updates between acquisition/return/start; asynchronous consumer
initialization; no callback overlap; listener-initiated commits; compaction
before start and behind an in-flight callback; one over-limit commit batch;
repeated overload behind a pending reset; empty batches and repeated unchanged
view commits consuming no queue space; no serialization during queue accounting;
immutable earlier values; retirement before start and while active;
recreation; idempotent stop; second-start rejection; cancellation during acquisition;
cancellation/close during a callback; listener-error settlement; `closed`
self-join misuse; and invocation-owned
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

## 18. Inputs and positional inbox

Define the initial inbox and turn-control documents, then implement request-ID
deduplication, awaitable input handles, busy admission, withdrawal, queue modes,
and `postTools`/`final` boundaries. Use a fake successor task.

Table-test every input transition, interleaved steer/follow-up/write selection,
self-head cuts, stale targets, successor triggers, reopen waits, compact
large-payload removals, and orphan/fault cleanup of active turn control.

## 19. Remaining built-in documents and view

Define the concrete configuration, preference, and live presentation documents;
reuse the approved inbox/turn definitions. Record all IDs, fields, history,
fork settings, migration, and checkpoint predicates in the normative
specification.

Implement `{ conversation, entries, docs }`. Test direct task writes, one
publication per Session commit, atomic
entry/preview settlement, head changes, contiguous revisions, stable public
paths, immutable acquisition snapshots, asynchronous consumer initialization,
serialized updates, reset compaction, retry/collapse late-join status,
bounded-output truncation metadata, and absence of semantic projection. Specify which
diagnostics become entries,
terminal details, or bounded document state.

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
through a fake collapse kind, input settlement, and no visible-undurable update.
Replace the fake tool successor and rerun the package 21 integration tests.

## 23. Collapse task

Implement manual, threshold, and overflow collapse; exchange-boundary range
selection; summarization; retries; staleness; and headed summary entries.

Test context before/after collapse, provider failure, declined/stale work, and
reopen from every phase. Replace generation's fake overflow target and rerun its
overflow integration test.

## 24. Harness integration

Implement the exact Pico3-shaped public surface in specification §2.2:
`Harness.open/resume/suspend/close`, lifecycle gates, root/create/lookup
`Conversation` objects, ordered `write` handles, send/input handles,
conversation-bound commits and history pagination, fork/collapse/reset/abort/idle,
typed task wait/abort, generic document access, task/tool/section registries, and structural conversation watches. Do not restore Pico3's
namespace router, fixed document accessors, semantic view events, or manual Chord
view bridge.

Expose service withdrawal/client detach and product wiring. Implement the §9.4
agent-mode notification adapter directly from uncoalesced committed publication,
without another tracker or persistence authority. Migrate TUI hydration to the
structural conversation watch, make print await its own `InputHandle`, and expose
JSON/RPC correlated commands plus ordered committed notifications. Test that
watch reset compaction cannot erase a subscribed notification lifecycle, late
clients use structural hydration rather than event replay, progress notifications
reflect durable throttled state rather than every provider frame, and stdout
backpressure/disconnect policy stays in the mode adapter.

Implement the v1 host-extension reload path as stop admission, close/join, dispose,
rebuild with new document tokens and registered task/tool/section definitions, reopen/migrate live tasks, and resume. Ordinary documents migrate
on later typed access. Test that closing seals commit and
get-or-create admission, lets storage settlement for already-flushed admitted
commits finish despite caller cancellation, stops watches, joins in-flight watch
callbacks and task/tool/hook invocations outside the Session line, writes no abort
or terminal outcome, starts no fresh abort invocation, and does not run old and
new generations concurrently. Include cancellation during watch acquisition and
a non-cooperative watch callback in shutdown/extension-reload quiescence tests.

Test stable persisted root identity; atomic conversation/config/section/input
creation; default `"off"` thinking; every configuration getter/setter; explicit
active-tool seed duplicate/unregistered rejection; default active registry
snapshot; as-of fork inheritance including unavailable historical names; durable
`missing_active_tool` settlement; fork seed overrides; concrete-entry forks;
collapse task-ID return;
busy reset admission and later placement; mark-only versus signalling abort;
conversation abort/join with surviving passive writes and background tasks;
quiescence with eligible work; listener initial/future delivery and isolation;
and runtime registration between open and resume without resurrection of a task
settled during open.

Compile-test every §2.2 signature and the usage sequences in the normative
specification and Chord guide. The erased registry test must include a concrete task with narrowed
input, multiple checkpoint phases, and custom hooks. Run all package-specific
tests and the repository check. Verify a local
coding-agent turn and a reopened interrupted turn, then stop for final review.
