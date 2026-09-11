# pico implementation plan

Clean room. Nothing from pico2 is copied; its tests are read for the bugs they caught (a failed
generation that never ended its run, refs inside task patches, a collapse deadlocking appends,
quiescence firing during a retry wait, watch dropping late deltas) so that packages 6, 9, 12 and
16 each carry a case for them.

The target is bottom-up modules with their own tests and explicit dependencies, green after every
step. The numbered groups below are a provisional coverage map, not final work-package sizes or a
completed dependency audit. After the remaining conceptual blockers are settled, run the independent
whole-document review and final work-package decomposition described below. `pico-v3.md` is the
reference design; `pico-usage-guide.md` shows the intended surface.

## 1. Types and ids

`Id`, `EntryIdentity`, `EntryBase`, the composable `EntryData` / `ModelProjection` /
`ContextHead` / `ContextEdits` facets, `Entry`, `EntryKind`, `EntryInput`, `ContextEdit`, `Task`,
`TaskRole`, status-tagged task-state unions and their derived `Orphaned` variant, compiler-only
`TypedTask`/`TaskDefinition` witnesses preserving the complete union and literal role map, stored task roles
and `turn` flag, `Conversation`, `QueuedInput`, `InputResult`, `InboxOp`, acceptance
receipts, `Call` (an alias of Chord Context), `TaskRuntime`/`ToolRuntime`, private typed invocation
identity, `Address`/`Value`/`List`/`Scope`, `Write`/`CommitBatch`, `Page`/`Cursor` and query shapes.
Every async harness/handle/runtime method takes a required final Call; no duplicate signal options,
task-conversation facades or admission gates.

Add immutable `SystemSection<T>` definitions created by `defineSystemSection<T>`: a durable string
`key` and synchronous pure `render(value: T): string`, with JSON-representable payloads. Tokens provide
typed access without plugin casts; only their keys and payloads are serialized. Export typed built-ins
`systemSections.identity`, `.environment` and `.skills`; plugins may define/register their own.
There is no discovery/read callback on a token and no renderer callback on an entry kind. Payload
shapes are trusted after wire validation; shape changes need migration or compatible replacement.

`SystemSectionDraft` exposes typed `get(token)`, `set(token, value)`, `delete(token)` and
`wrap(token, rendered => string)`. `get` returns an owned copy; array changes use get+set, not an append
operator. Persist ordered `SectionChange` records:

```ts
type SectionChange =
  | { key: string; action: "set"; value: JsonValue; rendered: string }
  | { key: string; action: "remove" };
interface SystemData {
  baseline?: true;
  sections?: readonly SectionChange[];
}
type SystemEntry = EntryBase & EntryData<SystemData> & ModelProjection<SystemMessage> & Partial<ContextEdits>;
```

Baseline sections are a complete ordered array of set records. Null and empty string are valid
payloads; deletion is an explicit action. Definitions and wrapper closures are never stored. Tool
definitions live only in model fields, never duplicated in SystemData.

Tests: typed token/draft inference without plugin casts; owned-copy reads; JSON null versus deletion;
every entry facet and built-in combination; persisted payload+rendered text and model-only tool definitions.
Task type tests: `defineTaskKind<States>()({ ... })` infers literal roles; exact role-map keys, start-only
initial status, reserved orphaned, consistent common-field types/optionality; orphaned exposes only
common fields via `Pick<S, Exclude<keyof S, "status">>`, preserving common optional fields. Typed reads
include orphaned; kind methods exclude it. No compiler witness is stored or needed by untyped readers.

## 2. Memory storage

`Storage` and `MemoryStorage`: `commit` numbering from `lastSeq`, point reads, fork-aware
`scanEntries` / `scanTasks` / `scanConversations` with cursors, target-capped `newestHead` over stored
numeric boundaries, stored entry data/model/edits, value versions and list elements read at a
position, `ownedFrom`, the set of entry kind strings written and session-wide live-task scans.
Use existing batched `getTasks` for named owners; no header/projection APIs or inbox-specific queries.

Tests: every row of the §7.2 query table against hand-built batches; ids are `lastSeq + 1 + i`; a
head is found without a kind; entry reads/scans/head lookup return full entries after indexed
selection; live-task scans skip terminal rows (named owner reads may fetch them); `remove` and
`clear` hide by position.

## 3. The line and `Tx`

`commit(plan, call)` on a serialized line: buffered writes, ids final at call time, rewindable
conversation value/list writes after an entry throw, a throwing plan discards everything, publish
after persist; apply the entire batch to live indexes before scheduling or testing idle. Driver
callbacks, signals and task methods dispatch outside the line. Session and sticky conversation state, task
writes and conversation writes may appear anywhere. `task` / `patch` / `settle` materialize the role
from the kind's status map; status lives only in `state.status`. `patch(task, status, payload)` and
`settle(task, status, payload)` always require an explicit status and its complete payload without
status. Both replace state with `{ ...payload, status }`; no partial merge or status-free overload.
Patch targets start/inflight roles, settle targets terminal roles and retires scratch; neither exposes
orphaned. A bare id must first be read with a kind to obtain the typed witness. Materialize `turn` from the kind and
maintain the indexed `inTurn` predicate. `entry` rejects outside-turn model-visible writes while turn
tasks are live; `write` places immediately or queues at a safe boundary, returning an inputId.
`value` / `list` / `entry` / `task` / `patch` / `settle` build the batch of §7.3.

Tests: concurrent commits serialize; a rejected commit consumes no ids; each builder verb produces
the expected write; reads inside a plan see committed state only; session and sticky conversation
writes may follow and reference a new entry; rewindable value set/delete and list
append/remove/clear after an entry each reject; exact invocation-token checks run on the line;
post-mark main/scratch mutation rejects before builder; only an owned task's current invocation may
patch its state/status or settle it (host abort marks remain allowed); caller cancellation never
abandons admitted persistence; Tx/ScratchTx reads are asynchronous and builders may await them
without releasing the line; writes remain synchronous. No external effects or nested line entry in builders.
Compile-time cases: required target fields and types, no extra top-level keys on literals/variables/spreads,
no duplicated status, status/payload correlation under union arguments, no role/status widening from
inference, narrowed task retains all transition targets, typed reads cannot write orphaned, no bare-id
escape. Cover valid same-status full replacement and optional fields; document structural typing/cast
limits rather than adding deep exact-type machinery. Runtime cases: replacement drops prior-variant
fields, rejects wrong roles/reserved statuses/duplicated payload status, current terminal tasks cannot
change, and same-status replacement does not advance the epoch. Payload validation stays at wire boundaries.

## 4. Entry kinds and context

`EntryKind` as `kind` plus `is`, the registry and typed append helpers for the built-in kinds
(`user`, `assistant`, `tool_result`, `system`, `notice`, `summary`, `handoff`, `reset`). Writers
materialize optional model messages and stored controls; context = newest stored head prepended to
the fork-aware range from its numeric boundary, older heads excluded, stored edits folded in
transcript order, stored model arrays concatenated, then pi-ai tool results ordered by call index.
This package has no managed-system state fold, baseline hoisting or system-kind projection filter.
Generation preparation writes any required system changes and omission edits (group 9); the generic
projector applies stored facets only. Arbitrary plugin head writers need no system-specific behavior.

Tests: data-only and model-only entries; summary keeps the tail; handoff/reset normalize `"self"`;
repeated compaction subsumes; a stored head below the previous visible boundary is rejected; edits
omit/replace targets and persist across turns; arbitrary managed-system targets reject, while atomic
fresh-baseline supersession is permitted; context is identical with its plugin kind unregistered;
retained system deltas remain visible until a later stored omission applies; tool-result order.

## 5. Forks and historical reads

`createConversation` with `parent`, the shared prefix in fork-aware `scanEntries`, capped-source
lookup for values and lists, arbitrary transcript-entry fork points.

Tests: a fork sees the head, edits and values in force at its entry; heads/results the source adds
later are invisible; deep fork chains; successful incomplete tool exchanges project with missing
results but inherit no tasks; state committed after the entry (a model change) is not in the fork.

## 6. Task kinds and the driver

`TaskKind` with `(task, runtime, call)` methods, registry and `TaskRuntime`; one Call-final convention
for operations, existing Context-aware env/provider/hook boundaries. Driver decisions, attachments,
waiters, invocation completion and lifecycle run on the commit line. Only effects/callbacks dispatch
outside it. Seed live tasks once; committed batches update live, reverse-dependency and conversation
indexes. Resolve ownership upward only for live/owned work; evict unused ancestry. Stable attachments
are distinct from temporary waiters. No Wake, polling loop, worker pool, poison graph, gate or parked role.

One invocation per task ID, concurrent across IDs; reserve before dispatch and release only after
actual return, even if already terminal. Durable abort revokes execute/recover main and scratch writes,
then signals outside line; fresh abort invocation alone writes cancellation outcomes. Status epochs
count actual committed transitions, including same-start/end cycles. Task-contract faults fail-stop:
reject waiters, stop admission, signal/join and close; preserve durable recovery state.

Tests: one open scan, no full scan per completion; 100,000 historical children with two live tasks;
whole-batch settle/successor publication; exact epoch rules; owned-task exclusive mutation; one
invocation per ID; blocked calls do not block others; abort bypasses dependencies and never overlaps
execute; repeated mark spares running abort; abort-handler failure; cooperative signal window;
known direct/dependency self-waits, including background caller and new cycle-creating admission;
already-aborted waiter registration and every cancellation/idle race; repeated drive uses one
attachment; foreground idle while attached background work continues; reopen recovers marked work.

## 7. Scratch

Scratch batches, one task per batch, `ScratchTx`, retire on settle, sidecar-independent (memory).

Tests: a crash before settle keeps scratch; settle deletes it; writes after mark/settle/retired token
reject; new attempts clear scratch; persisted assistant frames use the pi-ai compact frame encoder,
not raw cumulative provider events; a rejected stream-frame write cancels and joins the producer
before invocation completion (iterator exit is insufficient); harness progress bridges own every promise, suppress expected
late cancellation only, report persistence errors, and drain before invocation completion. Raw task
scratch calls must be awaited/caught; no successful silent no-op.

## 8. Harness shell and handles

`Harness.open` (built-in registries, `kinds` and `replace` options, kinds-set check, `inspect`,
`drive`, `close`, `shutdown`), `ConversationHandle` (`commit`, `value` / `list`, `config` /
`settings`, `fork` with `abort`, `abort`, `hooks.on` scoped with `subtree`), `acceptance(requestId)`,
`result(inputId, call)`, `abortTask`, `conversations` with `parent` / independent filtering. Call is
required on every async public/runtime operation, including reads and lifecycle; no raw host-lifecycle
Harness exposed to tasks. No section-order option or separate ordering configuration. No agent
behaviour yet. Root creation applies explicit `rootValues` atomically and only once; reopen preserves
durable model/thinking/selectedTools. Registry contents do not imply tool selection. Children use
explicit value-inheritance policy; missing required generation configuration fails clearly.

Initial `Harness.open` accepts `sections: [...]` definitions in addition to the built-in tokens.
Mutable registry operations take a required final Call and serialize on the line:
- `h.sections.register(token, call)`, `.replace(token, call)`, `.remove(tokenOrKey, call)`.
- Parallel `h.entryKinds` and `h.taskKinds` register/replace/remove APIs use kind definitions or names.

Register rejects duplicates; replacement is explicit and must understand the stored shape. Removing
code never deletes durable entries or section state. In-flight preparation retains its captured section
registry snapshot; later preparations see newer definitions, including explicit renderer replacements.
No rendering runs during registry mutation or replay. Task-kind removal rejects while live instances
exist. Open settles missing-kind foreground tasks as `orphaned`, parks missing-kind background tasks,
and leaves terminal history untouched. Registration restores parked recovery in already attached
scopes; it neither implicitly drives other scopes nor resurrects terminal tasks.

Tests: rootValues applies atomically only to a fresh root, ignored on reopen; no automatic tool
selection from registry changes; required-config errors; open on empty vs existing storage;
initial/custom/built-in section definitions; duplicate
registration rejects; compatible explicit replacement; removal preserves durable state and stored
rendered fallback; registry changes during preparation do not alter its captured definitions, while
later preparation sees the replacement. Unregistered entry kinds are reported without history scans
and stored facets still derive context; missing foreground kinds become orphaned, missing background
kinds remain parked and reported, registration restores recovery, terminal history stays untouched;
removal with live instances rejects. Replace by name keeps `h.kinds.<name>` consistent; `settings` round-trips; scoped hooks run after
harness-wide ones, innermost last; derived Call preserves typed private identity and telemetry;
stale/foreign task token rejects; close stops admission in one nonpersistent line job, joins outside;
shutdown atomically marks live tasks only, then permits abort cleanup; queued items/results remain
unchanged, including idle inbox-only conversations; crash/reopen child cleanup marks tasks only and
preserves queues; repeated close/shutdown share completion; close interrupt rejects shutdown;
lifecycle calls with task identity reject; delete rejects outstanding terminal invocations.

## 9. Generation kind

One stable generation task carries `inputs: Id[]` and cycles pending → streaming → retry_wait /
deferred → streaming until done / failed / aborted on a faux provider; explicit terminal results for
its whole input group; captured config (model, thinking, selected tools, profile, budget);
`system_instructions`, `before_request`, `after_response`, `on_yield`; retry sleeps in execute;
recover from frames; usage recorded per attempt.

**Durable configuration and typed preparation.** Config remains ordinary scoped state, persisted
when changed with its declared rewind/sticky policy. Host files and catalogue contents are not
magically stored as config. The Call-final `system_instructions` hook receives captured config and
one shared mutable `SystemSectionDraft` as `sections`. Sections are mutated, not returned; a handler
may return `{ tools?: readonly Tool[] }` as a full desired loadout. Handlers run sequentially in
registration order, with outer scopes before inner ones.

Seed each new draft from canonical durable section payloads and rendered text. Typed `get(token)`
returns a copy; changes require `set(token, value)`. Setting an existing key retains its position;
a new key appends; `delete(token)` explicitly removes it. Array payloads use typed get+set, without
an append operator. Missing contributions or registered definitions are not deletions. An untouched
seeded section retains its stored rendered text, including after restart; an unavailable renderer
uses that fallback. Initial sections need a provided base payload or stored fallback.

Explicit set/wrap or renderer replacement recomputes through the captured registered renderer.
`wrap(token, rendered => string)` requires a registered section; wrappers are synchronous, pure and
applied in registration order after rendering its payload, not on top of already wrapped stored text.
Wrappers belong only to the current draft and reset each preparation. Host handlers refresh full
current base payloads before plugin transformations; this intentionally rebuilds wrappers. Preservation
of a missing wrapper across a refreshed base is not promised. The composed transformation CHAIN must
reach a fixed point under repeated preparation, or use an earlier authoritative base reset. Individually
idempotent handlers are insufficient; the harness does not add a generic convergence loop.

Disk discovery and caches remain private to host/hook closures or services, refreshed by their own
watcher/TTL policy. Tokens have no source-read callback and entries retain no callback state. Refresh
failure is not deletion. Under the existing skip-failed-handler policy, discard that handler's draft
mutations, including wrappers, while retaining earlier handlers' changes; never publish a partial delete.
After hooks, capture payloads and pure rendered results outside the line. No plugin renderer runs on
replay or on the commit line.

**Canonical section state, separate from model projection.** Fold fork-visible managed system data
through the target, starting at the most recent baseline, independently of model heads and baseline
supersession omissions. Those facets control model projection, not canonical section payloads. Use existing indexed
kind scans, not unrelated transcript scans or a new storage API. An optional per-handle cache retains
current section state and its prepared cursor, not full history; each fresh baseline checkpoints all
canonical sections. There is no additional sticky full-state write. Missing contributors therefore
survive restart and compaction even when their original baseline is outside the retained model range.

Compare both payload and final rendered text by key, never by parsing prose. Baseline data contains
complete ordered set records; delta data contains only set/remove changes. JSON null and empty string
are values, not removal. A payload-only change persists a metadata-only managed delta with `model: []`
when there is no independent tool change. A renderer/wrapper change with unchanged payload emits a
model update when rendered text changes. Pure reorder emits no entry or order-change delta. Render
baselines and simultaneous changes in draft order with generic initial/change/remove labels by stable
key; historical messages are never reordered. A system entry records canonical instructions PREPARED
for a request, not proof the provider received them; appending it invokes no provider.

Tool differences remain independent of section differences. Complete definitions occur only in
SystemMessage `toolsAdded`/`toolsRemoved`, never SystemData. Fold removals before additions; additions
upsert by name, including same-name definition/schema replacement without a removal for that name.
A deletion carries the previous stored full definition, not a lookup in today's catalogue.

**Epoch preparation, not head-time behavior.** Every generation/provider request preparation checks
the newest visible head and effective managed system entries. A missing current-epoch baseline
requires a fresh baseline. Arbitrary managed-system edits reject; the current baseline's supersession
omissions do not invalidate it repeatedly. Rebuilding uses canonical payloads/rendered fallback from
the independent data fold, never just the model tail.
Append stored omission edits on that same fresh baseline entry for superseded retained managed
baselines AND deltas, never arbitrary system notices. Before preparation, generic context may expose
dangling old deltas; no request bypasses preparation. Head writers stay generic. The fresh baseline
remains at its appended position after the retained tail, not in a hidden prepended slot.

Apply planned omissions before folding tool declarations from ALL remaining effective SystemMessages,
including non-managed messages. A fresh baseline adds the complete desired tool set and explicitly
removes unwanted remaining declarations; `baseline: true` is not a pi-ai tool-map reset. Never emit
removals derived solely from messages that the same preparation is about to omit.

Capture canonical section state/cursor and the section registry snapshot before hooks. After hook and
render completion outside the line, verify on the line that no concurrent managed section-state change
occurred, including metadata-only changes. If it changed, restart preparation outside the line from
fresh canonical state. A compaction-only head change does not stale the payload draft: recompute only
the model baseline/delta choice, planned omissions and effective tool differences on the line.

Atomically persist any baseline/delta (including metadata-only), inflight status and
`state.requestThrough` on the prepared generation variant. Capture the cutoff even when no system
change is needed; unprepared variants have none and deferred variants retain their request's cutoff. After
persistence, the same line operation catches the current model cache up to the cutoff and captures an
immutable array of effective entry references, including immutable replacement projections, before
releasing the line. Current caches advance independently; the invocation keeps its snapshot, not mutable
cache containers. Clone messages only for request-local mutating normalization/hooks. Cold/recovery
reads at an older cutoff derive from storage without rewinding current caches. Release snapshot and
captured registry references after invocation; no version registry.

**Request-local overrides.** Preserve arbitrary `before_request` message transformations on a
request-local copy; they cannot mutate stored entries or switch Pico out of messages-only mode.
Canonical prepared state remains the basis for later diffs. Exact transformed requests are not
reconstructible from that state unless explicitly captured; no mandatory second request ledger.
Validate returned tool calls against the actual offered definitions after transformation, while
retaining implementation availability and permission checks (group 10).

Tests:
- Typed built-in/custom tokens; owned-copy get and explicit set; shared-draft registration/inner order;
  existing-key replacement retains position, new key appends, explicit delete differs from null/empty
  payload, array updates use get+set, and wrappers require registered sections.
- Untouched seeds retain rendered text; explicit set/wrap and renderer replacement recompute; wrappers
  compose in registration order and reset per draft. Authoritative base refresh rebuilds wrappers;
  missing wrappers need not survive that refresh. Check stability of the complete transformation chain,
  not merely its individual handlers, and repeated preparation with earlier authoritative base reset.
- Missing contributor/definition and failed refresh preserve stored payload/text; a skipped handler's
  partial mutations cannot leak. Registry remove never deletes section state; re-registration and
  compatible replacement work. No renderer runs on replay/line; no closures enter persisted records.
- Persist payload AND rendered text; changed payload/unchanged text gives metadata-only `model: []`;
  unchanged payload/changed rendering gives a model update; explicit removals and reorder-only no-op.
  Baseline/change rendering follows draft order. Tool changes remain independent, including tool-only
  empty content, additions/removals, same-name schema changes and `addTools`; no duplication in data.
- Config change commits before the next system entry; crash after config change preserves it; crash
  after system append before invocation does not duplicate unchanged canonical preparation. Canonical
  recovery folds metadata-only records and never requires the original contributor/renderer.
- Independent canonical fold across fork cutoffs, model heads and supersession omissions; missing-plugin
  sections survive an original baseline outside the model range and appear in the next full baseline.
  Repeated compaction uses the latest canonical checkpoint without an unbounded handle history cache.
- Compaction/reset/handoff and arbitrary plugin heads; a retained old model baseline still requires a
  new epoch baseline; retained tail order, baseline-time omissions and preserved notices; fork before
  and after preparation uses its own canonical state/inherited config without changing the source.
- Arbitrary managed-system omit/replace edits reject; fresh-baseline supersession commits controls and
  instructions together without changing the seed's canonical data. Superseded omissions do not trigger
  repeated baselines. Compute tool removals after planned omissions; include remaining non-managed tool
  declarations. Generic projection runs no system-kind code.
- Concurrent canonical writes during hooks/render, including metadata-only deltas, force preparation
  retry outside the line; registry changes preserve the captured snapshot and affect later prepares.
  Head-only changes recompute epoch/omissions without discarding the payload draft. A later head during
  projection/streaming cannot change `requestThrough`, including when no system entry was appended.
- Preparation snapshots include baseline omissions; later heads, edits and cache updates cannot change
  captured entries or replacement projections. Normalization/hooks mutate message clones only.
  Cold/recovery derivation at an older cutoff leaves current caches unchanged; invocation completion
  releases snapshot references without a version registry.
- Request-local overrides leave stored state unchanged, remain messages-only and determine actual
  offered-tool validation; adapter fixtures are gated on the pi-ai prerequisite in group 20.
- In-band provider abort without a durable mark has a kind-level outcome; post-mark execute settlement
  rejects and fresh abort writes optional partial, cancelled input results and known usage atomically.
  No mark branch in normal settlement; missing post-cutoff usage is unknown; crash while streaming
  publishes the partial; retry budget exhausted → failed with no successor.

## 10. Tools, post_tools, exchanges

The tool kind with the sink (`ToolOutput`, `ToolOutputState`, limits enforced by the sink, `diag`,
`delegate`, `handoff`, `addTools`, `terminate`), tool-result entries with structured data plus their
materialized model message, `before_tool` (fail-closed) and `after_tool`,
replay policy on recover; post_tools with `after`, carried input groups, terminate / handoff / steer /
next generation; `accept` idle vs busy; `prompt`, `result` and request acceptance lookup. Validate
calls against the actual definitions offered by the prepared request after request-local overrides,
not merely captured selected-tool names or today's catalogue. Preserve registry and permission checks.

Tests: transformed offered-tool definitions, removed tools and same-name schema changes; parallel tools
completing in either order; sequential via `after`; an aborted generation
creates no tool tasks/results while an aborted existing tool writes its own error result;
`new_context` resets after the exchange, never inside it; `addTools` writes the rewindable loadout
before any handoff/user entry in the settlement commit and appears in the next turn's `toolsAdded`;
a throwing tool → error result, `terminate` still honoured; truncation diag from the sink; a lost
accept response is recovered through `acceptance(requestId)`; a duplicate create reports the first
receipt without comparing payloads or modes; results remain point-readable after further turns.
post_tools handles orphaned tool tasks by writing unavailable-tool results from their common fields.
Turn-task entry appends remain immediate; outside-turn model-visible writes queue while inTurn is
nonempty and land at post_tools/final boundaries. Data-only entries are never blocked.

## 11. Inbox

`pi.inbox` as a conversation sticky list whose element id is `inputId` and whose value holds mode,
user content or a write's entry draft and optional request id; append/remove/clear watch operations;
queued/placed/done/unanswered result variants; the three placement points; carried generation/post_tools
input groups; `queueInput` and `abortInput`; abort draining steer and followUp while preserving write
and nextRun. A write reaches done without an answer in its placement commit.

Tests: idle append/remove is one commit and emits no inbox event; busy image payload is one append
operation; the modes table; steer joins at post_tools but starts a group after a final answer;
followUp starts the next group; nextRun waits for idle accept; writes are placed without joining;
several inputs resolve to one answer; cancel/land and abort/group-transfer in both orders; queued and
placed crash recovery; cancelled unplaced payload is unavailable; input queued during collapse lands.

## 12. Collapse

Manual, threshold and overflow; `before_collapse`; publish only if no newer head; the overflow
chain (generation settles → collapse → new generation carrying the attempt).

Tests: a summary lands under a running generation and later entries stay in context; a competing
head makes a summary stale while intervening edits do not; overflow retries once and no live task
ever waits on the collapse; threshold before a turn; abort of a running collapse leaves appends flowing.
A head adds no implicit system omissions: next request preparation writes them with its fresh baseline.
Test retained deltas before preparation and their stored omission afterward, without invalidating an
already-prepared request at its frozen cutoff.

## 13. Subagents

The `subagent` tool (`run`, `spawn`, `send`, `status`, `wait`, `stop`), ownership links, foreground
reach through live owners, `run`'s recover driving the child again, `spawn` initialization of config,
explicit child input results.

Tests: restart in the middle of `run`; conversation abort reaches a `run` child and spares a `spawn`
child; abortTask marks only owner and fresh cleanup cancels its child; drive waiter observes Call;
cleanup tolerates already-terminal child/job; `stop`; nested children; child's own baseline.

## 14. Jobs and the budget

`jobKind` on `ExecutionEnv.exec` with output into its scratch, `waitForTask` / `jobOutput`, `bash`
delegating first and waiting with the budget, `notify` and the `notice` entry, the `job` tool,
schedules.

Tests: job creation atomically stores job id and cancellation policy on the tool; fresh tool abort
uses those durable references, not execute locals or catch writes; budget expiry settles delegated
and job continues; delegation requests notification in separate sticky state, not a patch to an owned
job; both notification/completion orders publish once for exited, lost and killed; schedule cycles one
stable id; foreground drive
ignores background recurrence; recover → lost or safe rerun; abort kills non-detached job.

Remaining integration design: arbitrary-promise budget adoption must explicitly transfer effect and
sink ownership before the tool invocation releases. A raced, abandoned promise is not permitted.
Preserve the capability (crash outcome lost), but implement job-first execution until transfer is settled.

## 15. Previews

`runtime.preview` as a Chord tracker per task; the generation applies stream events to a partial
message, the tool's preview is its sink state, the job's the same; `preview.init` on attach and
reopen; flush after each scratch commit.

Tests: one token → one `a` op and nothing else; no `r` mid-stream; init after reopen yields a base
equal to the live preview; a sliding tool tail → `t` + `a`.

## 16. Watch

`ConversationView`, `ConversationEvent`, the exported kind-free `applyEvent`, `WatchHandle`
(capture on the line, bounded buffering, `resnapshot`, `unsubscribe`), the session watch with
`report` and `usage`, the usage ledger (`pi.usage` + totals).

Tests: the fold is correct (view after N events equals a fresh capture, randomized); head and edit
entries update derived context; inbox append/remove/clear operations update the view and same-commit
append/remove cancels; all events of one commit delivered together; a thin-client reducer over a
recorded stream with no kinds loaded;
lag → fault → resnapshot; `resnapshot` from inside the listener; usage totals equal the ledger
fold, failed and aborted attempts included.

## 17. JSONL storage

Append-only batches, replay on open, torn tail discarded, malformed line fails open, entry
`data`/`model`/`head`/`edits` and the kind-string set from replay. Whole value sets and intrinsic list
operations in main and scratch files; no Chord storage codec. Replay main first, then surviving live
scratch; per-file sequence gaps are valid. Recover lastSeq from maximum complete surviving batch
endpoint, including clear/remove. Retired scratch is ignored; its later settlement covers its ids.
Physically remove torn suffixes before appending; malformed complete replayed batches fail.

Tests: conformance against memory; full replacement values on disk; compact incremental frames/output
operations avoid repeated growing snapshots; main=100/live scratch=150 reopens at 150; settle=151
with failed unlink ignores retired scratch, even malformed; clear/remove high-water; torn main and
live scratch tails; nonoverlapping ranges; accepted payload plus placement has two JSONL copies,
including idle acceptance. Backend memory and disk growth claims match whole-value behavior.

## 18. SQLite storage

Tables and indexes of §7.5, nullable entry JSON columns for data/model/edits and an indexed integer
head boundary, scratch rows deleted in the settle transaction, storage version and `migrate`.

Tests: conformance three ways; removed sticky inbox elements may be physically discarded while
input results remain point-readable; a cold reopen decodes live tasks and only named required owner
records, including terminal owners; no retained terminal payload cache; a version mismatch rejects.

## 19. Race matrix and telemetry

The §10.2 matrix in both orders with faux clocks, fake processes and storage barriers; spans per
task call and per commit.

Tests: the matrix; span tree for one turn with a tool and retry; nested Call preserves active telemetry
parent and private invocation identity; drive-caller cancellation does not become the task signal;
providers/env interpret signals, hooks propagate cancellation rather than swallowing it; no callback
runs on the line; stale RPC-bound invocation rejected. Metadata transport never carries task authority.

## 20. Clients and pi-ai integration prerequisite

mini (`worker/run.ts`, `worker/lane-service.ts`, TUI `apply(view)`), the experimental agent's four
seam files (`session-worker.ts`, `agent-controller-provider.ts`, `models-provider.ts`,
`transcript-provider.ts`), real providers. The integration milestone remains: system deltas on a live
model, a retry, a spawned subagent surviving a restart, speculative compaction under a running turn.

**External prerequisite, not landed functionality.** PRs
[#9116](https://github.com/earendil-works/pi/pull/9116) and
[#9117](https://github.com/earendil-works/pi/pull/9117) are open dependencies in this design round.
Their agreed target and fixtures must be delivered and verified before integration; neither an open
PR's types nor this plan establish that the behavior already exists.

Target: pi-ai enters system-message mode when BOTH `context.systemPrompt` and `context.tools` are
undefined. Pico supplies only `{ messages }`, never parallel top-level instructions/tools. SystemMessage
carries text plus complete JSON `toolsAdded`/`toolsRemoved` definitions. Provider/model translation
belongs to pi-ai: unsupported mid-conversation changes become user messages bracketed with `<system>`
at their historical positions, and adapters derive required bulk wire tool declarations from message
history. Pico does not implement fallback or flatten changes into a rewritten top-level prompt.
Cache preservation is best-effort, not a universal prefix-cache or instruction-priority guarantee.

Required adapter fixtures: both top-level fields absent versus either supplied; ordered baseline and
section updates; empty-content tool-only changes; removals and same-name upserts; historical calls to
removed/replaced tools; historical-position fallback; compaction with retained tail, stored omissions
and an appended fresh baseline. Include messages-only preparation for summarizer/provider request
paths, not just ordinary generation. Run faux fixtures without provider credentials; live integration
waits for the dependency contract and separately authorized smoke tests.

The current sketch puts groups 1–16 before this milestone and 17–19 later. That ordering and those
sizes are provisional, to be verified and split at the final planning gate below.

## Final review and work-package gate

After the remaining conceptual blockers are settled, perform an independent whole-document audit of
spec, guide and this plan: reconcile APIs, invariants, examples, cross-references, external prerequisites
and coverage while preserving agreed features and explicitly tracking residual integration questions.
That audit is still ahead, not completed by the blocker-7 update.

Then replace the provisional groups with small, self-contained, testable, human-reviewable work
packages. Each needs explicit prerequisites, bounded scope, interfaces and acceptance tests, with a
green incremental verification step and no unresolved forward dependencies. Do not treat the current
numbering or package sizes as the final implementation decomposition.

## 21. Runtime schema bundle

`harness.schema(call)` walks the three registries and emits one document describing everything a
client can see in this session: the core protocol types (`ConversationView`, `ConversationEvent`,
`InputResult`, `QueuedInput`, `DeltaOp`), plus each registered entry kind's `data`, each task
kind's state union and preview, and each tool's parameters and details. Generated at runtime, not
at build time, because the interesting half is per installation: the plugin kinds and tools that
happen to be registered. A client fetches it once per session and can then read `Entry.data`,
`Task.state` and previews from plugins its authors never heard of.

Schemas are optional per kind. A kind that declares none is still usable; its payload is opaque
JSON to a foreign client, which is the generic-fallback case a renderer already handles. Declaring
is progressive: add a schema to the kinds you want third-party clients to understand.

Two open options for how a kind declares one, to be picked after trying the first:

- A small descriptor owned by pico (about twelve cases: scalars, literal, array, object with
  optional fields, tagged union, ref, unknown) with `Static<S>` deriving the TypeScript type, plus
  adapters `toJsonSchema` / `toTypeBox` / `toZod` and `fromTypeBox` / `fromZod` for authors who
  already declare with a validator. Pico then depends on no validation library. Cost: hand-rolled
  conditional types with worse errors than TypeBox's, and adapters must reject what the descriptor
  cannot express (refinements, formats, dynamic keys) rather than silently dropping it.
- JSON Schema as the descriptor, since tool `parameters` already is one, with adapters only for
  authoring convenience. One representation fewer; authors without a validator library write JSON
  Schema by hand.

Schemas describe, they do not validate: stored objects are trusted (§7.3) and validation belongs at
wire boundaries, so a host that wants strict ingest validation opts in. Versioning is per kind, not
global; a kind that changes its shape bumps its own version, which is also the migration signal.

Needed when a client is not JavaScript. Not part of the gate.

Not packages: permissions and approval policy are plugin territory (`before_tool` can block or
rewrite args and may wait for a person, scratch holds the durable memo, values hold whatever the
plugin remembers, and a keyed service instance shows the question to every attached presentation),
and session migration is a non-issue while this is experimental.

## What comes from the lane harness, and how

Clean room means no imports from `src/harness/runtime`, `session`, `agent-harness.ts` or the
`dom`/`pico`/`pico2` spikes. Where the old code has something worth keeping, it is **copied** into
`src/harness/pico/` and owned there; pico must build with the rest of `src/harness` deleted.

Copy (under `packages/agent/src/harness/` unless noted):

| what | from | into | package |
|---|---|---|---|
| `ExecutionEnv` / `FileSystem` / `Shell` types, the Node env, capture and spill | `types.ts`, `env/`, `tools/tool-context.ts` (03-execenv) | `pico/env/` | 10, 14 |
| shell output limits, `applyShellOutputUpdate`, truncation totals | `utils/` | `pico/env/output.ts` | 10 |
| the built-in tools (`read`, `write`, `edit`, `bash`, `image`) | `tools/*.ts` | `pico/tools/`, rewritten to the sink signature | 10, 14 |
| system prompt helpers, skills, context files, templates | `system-prompt.ts`, `skills.ts`, `prompt-templates.ts` | host handlers refresh typed base payloads; pure section renderers format them, without a source-read framework | 9, 20 |
| telemetry span helpers | `telemetry.ts` | `pico/telemetry.ts` | 19 |

Depend on, as packages (they are not the old harness):

- `@earendil-works/chord` Context types and `@earendil-works/chord/context` helpers (1, 6, 8, 19)
- `@earendil-works/chord/delta` (15, 16: preview/watch only; not storage)
- `@earendil-works/pi-ai`: `faux` provider for tests, `utils/estimate` for thresholds; SystemMessage and
  messages-only adapter behavior depend on the verified PR #9116/#9117 target above (4, 9, 12, 20)

Read before writing the equivalent, then close the file:

- `runtime/drive/retry.ts`, `deferred.ts`, `response.ts`: retryable-error classification, overflow detection, deferred polling (9)
- `compaction/`, `runtime/drive/boundary.ts`: the exchange-cut rule and the summarizer prompt (12)
- `runtime/drive/recovery.ts`, `restore.ts`: the per-phase recovery case list (9, 10, 14)
- `runtime/drive/tool-placement.ts`: the result order projection must reproduce (4)
- `hooks.ts`, `docs/harness.md` §before_tool: the exact decision shape (10)
- `session/`, `test/harness/jsonl-*.test.ts`: torn-tail and malformed-line rules (17)
- `session/`, `test/harness/mutation-line.test.ts`: line discipline edge cases (3)
- `agent-harness.ts`: `LaneSnapshot` / `HarnessEventPayload`, for the `toLaneSnapshot(view)` shim only (20)

Tests to port (`packages/agent/test/harness/`): the three conformance suites as the model for 17–18;
`compaction`, `branch`, `context`, `execution-*`, `values`, `mutation-line` as the parity source for
19; `system-prompt`, `prompt-templates` for the host handler in 9; `tools`, `truncate`,
`output-capture` for 10; pico v1's 27 ported scenarios as the shortest list of behaviours to
re-prove.

Do not read: `runtime/lane.ts`, `reducer.ts`, `drive/reconcile.ts`, `structural.ts`,
`terminal.ts`, `checkpoint.ts`, and the `dom` spike. They are the operation state machines and the
reconciler this design replaces.
