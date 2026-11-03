# rev-ho-opus — adversarial reviewer of Chord v2 / p3 state, jobs, reload and rollout

This file records the findings, review points, open questions and recommendations I produced in the review conversation. It excludes the functionality map. Status labels reflect later owner decisions or later designs known in that conversation; they are not a fresh re-review of current HEAD.

Status legend:

- **Decided / superseded:** the owner later chose a design that replaces the reviewed one.
- **Decided / adopted:** the later target design explicitly adopted the recommendation.
- **Confirmed fixed:** a later prototype revision and regression test addressed the finding.
- **Open:** no later owner decision or verified fix was established in the conversation.
- **Historical:** useful implementation evidence from a design that is no longer the target.

---

## 1. Drain/handover prototype: first adversarial review

**Status: Decided / superseded.** The owner later rejected drain-based handover. These findings remain useful traces of why.

### 1.1 Blocker: a drained object could still run old code during the rest of its handover

**Finding.** `object.ts:1667` admitted any call whose call tree had work in *any* object of the handover group. Each object's handover ran independently (`reload.ts:568`), not in dependency order. Once B had drained, a call from A, which was still draining, could enter B's old code while B migrated and swapped resources.

**Concrete trace / test.** `/tmp/chrev/reentry.test.ts`: B drained, migrated `{n:1} -> {m:1}`, closed `conn1` and waited on `conn2`. A's call then reached B v1: its write to `n` produced `{n:11}`, its resource read threw `stale`, and B ended at `{m:1}`. The write was lost although the reload reported `installed`.

**Recommendation.** Admit re-entry only while the whole closure is draining. Drain the closure to one common quiet point before any member runs migration/close/open steps, then execute steps in dependency order.

**Later status: Confirmed fixed in the prototype.** The rewritten test retained the re-entrant write (`{m:11}`), and no read happened after resource close.

### 1.2 Major: registry calls escaped contributor admission and ownership

**Finding.** `host.ts:617` returned raw registry values. A route or tool call did not become work of the contributing object. Neither handover drain nor `releaseAfterOwners` waited for it.

**Trace.** `/tmp/chrev/registry.test.ts`: a running route saw `close conn1`, then `route v1 ERR stale`, for both an exclusive handover and a parallel resource replacement.

**Recommendation.** Wrap function entries so invocation enters the contributor's admission and begins stamped work with the caller's root id/context.

**Later status: Confirmed fixed for function-valued entries; object-valued entries remained a later finding.**

### 1.3 Major: queued `run()` closures were stamped when they started, not when admitted

**Finding.** A closure queued before publication could begin afterward with the new publication stamp and therefore own none of its old declarations.

**Trace.** `/tmp/chrev/queued.test.ts`: `v1 handled 1 with conn1`, then `close conn1`, then queued `v1 handled 2 ERR stale`.

**Recommendation.** Reserve and stamp work when `run(fn)` admits the closure, or drop queued closures from a stopped generation.

**Later status: Confirmed fixed.** The old resource closed only after the queued closure ran.

### 1.4 Major: every failed object blocked every unrelated reload

**Finding.** `#todo` retried failed objects in every reload. A failed exclusive open therefore rejected an unrelated facet change during prepare.

**Trace.** `/tmp/chrev/failedblocks.test.ts`: while port 9090 remained busy, reloading an unrelated `other` facet was rejected with `EADDRINUSE`.

**Recommendation.** Retry failed objects only when their type/plugin is in the batch, or isolate retry failure to that object and continue the reload.

**Later status: Confirmed fixed.**

### 1.5 Major: reverting to last-live code could not repair a failed handover

**Finding.** Staged v2 state was treated as current, so reverting to v1 was rejected as a version decrease even though v2 had never gone live.

**Trace.** `/tmp/chrev/revert.test.ts`: after a failed v2 port open, reload to v1 failed with `version of state count lowered from 2 to 1`.

**Recommendation.** Plan from last-live state. A staged copy is valid only for exactly its target version/schema and should be discarded for a different target.

**Later status: Confirmed fixed.**

### 1.6 Major: a handover step that hung was never reported and could never be repaired

**Finding.** Exclusive `open` and `init` after drain had no deadline. The object remained `updating`, not `stalled`; reload never resolved, later reloads got `handover_running`, and a child's serialized install queue wedged permanently.

**Trace.** `/tmp/chrev/hang.test.ts`: an exclusive open that never resolved left `reload()` pending and the object `updating, stalled:false`.

**Recommendation.** Give each post-drain step an aborting deadline and stalled reporting; do not let a child install queue wait forever on a post-publication handover.

**Later status: Partly fixed for one-member closures; multi-member closure remained broken in round two.**

### 1.7 Major: a second reload during async effect cleanup started a replacement under it and left `stalled` stuck

**Finding.** A stopped run had already been cleared, so the second swap saw nothing to wait for and started immediately. The superseded first swap returned without clearing its stalled flag.

**Trace.** `/tmp/chrev/doubleswap2.test.ts`: `setup v3` occurred before `cleanup done v1`; the second report said `installed`; `stalled` stayed true forever. The loop variant also showed the stuck flag.

**Recommendation.** Keep the pending cleanup promise on the slot and chain every later start after it. Clear stalled state when the cleanup settles or a swap is superseded.

**Later status: Confirmed fixed for loops and plain setups.**

### 1.8 Minor: old activations delayed publication and could livelock reload

**Finding.** Prepare waited for activating objects of changed types. A slow activation delayed reload up to `readyTimeout`; a steady stream could prevent publication forever, despite a `CodeChanged` restart path existing.

**Recommendation.** Publish without waiting and abort/restart old-code activations synchronously at publication.

**Later status: The direct wait was fixed; a prepare/activation dependency cycle remained a later finding.**

### 1.9 Missing design pieces

- Facet setup was not represented as a facet object, so objects sharing facet closures were not handed over with it.
- Dependents of a failed provider stayed live rather than failing with it.
- Handovers ran concurrently rather than in dependency order.

**Recommendation.** Introduce the anonymous facet object, include served objects when its declarations change, propagate provider failure, and order close/open by the resource/reference dependency graph.

**Later status: Implemented in the prototype, then superseded with the drain design itself.**

### 1.10 What held in the first prototype

Calls racing publication, waiting calls, stale-write refusal after install, parallel-resource ownership by stamped work, cell version checks and dry runs, no repeated migration on a plain retry, and the repeated-reload generation checks held under the tests examined.

---

## 2. Drain/handover prototype: second adversarial review

**Status: Decided / superseded.** The owner later rejected the drain design. These findings came after closure-wide drain, dependency order and the facet object were added.

### 2.1 Major: sequential closure steps let one member freeze every later member

**Finding.** Members' close/open steps were awaited one at a time. A member whose open ignored its signal prevented all later members from reaching their own steps and prevented the reload report from completing.

**Traces.**

- `/tmp/chrev/r2facet.test.ts`: served object `a` hung opening a cursor after a facet DB replacement. `reload()` never reported; served object `b` remained `updating`; later reloads were refused.
- `/tmp/chrev/r2seq.test.ts`: six independent served objects each took 60 ms, below a 100 ms step deadline. Sequential processing took 366 ms and the last two waiting calls hit `handover_timeout`.

**Recommendation.** Execute independent members concurrently once their providers are ready. Report every member blocked behind a stalled provider. Size call waiting by the longest dependency path, not the number of members.

### 2.2 Major: registry entry code ran with the caller's context, not work-owned child context

**Findings.**

- The handover deadline aborted the entry's internal work record, but not the context passed to entry code. A streaming route honoring `ctx.signal` never stopped.
- New code reached through a long-lived caller context retained the caller's pre-migration stamp, so legitimate writes were rejected as stale.

**Traces.**

- `/tmp/chrev/r2entryabort.test.ts`: the reload reported pending, the route kept running, and `host.close()` hung.
- `/tmp/chrev/r2entrystale.test.ts`: a new route after migration got `stale: a write from work that started before its state was migrated`.

**Recommendation.** Replace the entry's context argument with `ctx.child(contributor, work)`, exactly as object method calls do.

### 2.3 Major: object-valued registry entries bypassed admission and ownership

**Finding.** Only top-level function values were wrapped. A tool object such as `{ name, execute }` was returned raw.

**Trace.** `/tmp/chrev/r2registry.test.ts`: the old resource closed while `execute` ran; `execute` then got `stale`.

**Recommendation.** Wrap declared callable properties of object entries, or constrain registries to function values.

### 2.4 Major: removing a facet closed facet resources under served-object work

**Finding.** `dropFacetObject` released its host hold immediately. The facet object disposed and closed resources before served objects completed forced disposal.

**Trace.** `/tmp/chrev/r2facet.test.ts`: `close db1` occurred while a served call was pending; the call resumed with `not_ready`.

**Recommendation.** Keep the facet hold until every served object has disposed; release it afterward.

### 2.5 Major: revision skip after a rejected child install permanently stranded missing modules

**Finding.** A child that rejected R2 could successfully install only R3's delta and then claim R3. Reconnect skipped because revisions matched, although R2's module was never installed.

**Trace.** `/tmp/chrev/r2revision.test.ts`: module `a` failed transiently in R2, module `b` installed in R3; reconnect installed nothing and the worker had only `b` while the server desired `a,b`.

**Recommendation.** Clear/withhold the child's revision after rejection, track revision per connection, or send the complete desired module set for every revision.

### 2.6 Minor/major: prepare deadlocked with an old-code activation

**Finding.** The activation waited for reload decision, while a trial/new host object waited for a reference to that activation.

**Trace.** `/tmp/chrev/r2activation.test.ts`: reload rejected after `readyTimeout`, naming the activating target reference.

**Recommendation.** A candidate acquisition of an old-code activating object must restart it immediately with candidate code, or prepare must not await readiness of references to changed types.

### 2.7 Minor: no-context entry call could wait for its own handover

**Finding.** A closure member calling a registry entry without passing a context got a new root and a never-aborting signal. It parked behind its own fence.

**Trace.** `/tmp/chrev/r2registry.test.ts`: still waiting after two seconds; it could wait roughly the full 60-second handover timeout.

**Recommendation.** Carry root identity through async-local context, or reject/cancel no-context entry waits at the drain deadline.

### 2.8 Facet-generation GC held

`/tmp/chrev/r2gc.test.ts` reloaded facet objects five times with both parallel and exclusive resources; only the current generation remained. This part held.

---

## 3. State §7 design reviews before transactional documents

### 3.1 `init({ previous, from })`: live previous value was unsafe

**Status: Decided / superseded by transactional documents.**

**Finding.** Passing the live last-live object let `init` mutate state outside transactions. If `init` later failed, reverting served corrupted old state with no state event.

**Trace.** `/tmp/chrev/r2init.test.ts`: `init` drained `previous.items` then threw. Revert served `{ items: [] }` instead of `['a','b','c']`.

**Recommendation.** Pass a structured clone or frozen value.

### 3.2 `init` calling another closure member could deadlock

**Status: Decided / superseded.**

`init` ran in a fresh root after re-entry closed. Calling a sibling/self that had not completed handover parked until deadline and failed repeatedly. The author could not know closure membership statically.

**Recommendation.** Enforce at runtime: fail fast when an init root calls an updating closure member, or permit only already-installed providers.

### 3.3 An init deadline could be too short for data-moving I/O

**Status: Decided / superseded.**

Moving a large in-memory value to SQLite under the ordinary drain deadline could fail every retry. If I/O committed after abort, retry repeated it.

**Recommendation.** Give init its own longer deadline and require one transaction plus idempotence.

### 3.4 Mirror cell could lose or duplicate source events around init

**Status: Decided / adopted in later design as source readables / derives.**

**Trace.** First start: init reads m1–m4, m5 commits before subscription, so m5 is lost. Reload: an event m5 buffers while init reads through m5; replay appends m5 twice.

**Recommendation.** Mirrors come from atomic readable sources, or use sequence-numbered events with subscribe-before-catch-up and drop events at or below the read position.

### 3.5 Memory-only data could be silently dropped

**Status: Decided / superseded by versioned transactional documents.**

Because every cell had init, a bump without migrate silently reset drafts. Returning `undefined`, renaming or removing a cell had the same effect.

**Recommendation.** Declare mirror versus memory state, require migrate for memory state, and require an explicit drop/retire declaration.

### 3.6 Paging needed stable cursors, gap detection and cache epochs

**Status: Partly adopted by the real Chat window/history design; general contract remained a review recommendation.**

**Traces.** Offset paging while the window advances causes skips/duplicates. A disconnected client whose cache ends at m149 can reconnect to window m400–m449 without knowing m150–m399 are missing. Schema/source rewrites leave cached pages stale.

**Recommendation.** Stable monotonic entry ids; window bounds `{from,to,items}`; `history({before:id,limit})`; reconnect fills the gap; cache keyed by contract fingerprint and source epoch.

### 3.7 Cross-cell init ordering was undefined

**Status: Decided / superseded.**

Two bumped cells could initialize in parallel; one reading the other could observe old shape, no value or nondeterministic order.

**Recommendation.** Forbid reading not-yet-initialized cells, support explicit dependencies, or pass staged values into init.

---

## 4. Reload without drain / version-fence proposal

**Status: Decided / rejected.** The owner replaced it with transactional documents plus per-generation handles and restart-like reload.

### 4.1 Major: retryable stale after partial external work duplicates effects

**Trace.** `Catalog.create` writes SQLite, then its mirror-cell update throws stale; client retries and creates another session. Search mark/index had the same source-first/mirror-second pattern.

**Recommendation.** Do not make stale generically retryable. Require request ids for mutating methods crossing reload, or let mirror updates trigger re-read rather than fail. Provide real readable wrappers for SQLite mirrors.

### 4.2 Major: per-cell fences miss copied values and cross-cell invariants

Old code can copy a v1 value before publish, await, and write a derived value to an unchanged cell, Durable or another object. No changed handle is touched after publication.

**Recommendation.** Keep a per-object write epoch: if any storage changes, old-stamped work cannot write any document of that object and its signal aborts cooperatively. Old derives over bumped documents also become stale.

### 4.3 Major: stale-on-read breaks cleanup and timers

**Trace.** Chat's shell timer/finally read `shell.value`. A bump could throw from a raw timer, crash the worker, skip cleanup, leave `running:true`, while the new closure no longer had the native abort controller.

**Recommendation.** Old reads return their generation's immutable snapshot; only writes fail. Reset transient fields during migration. Abort all work owned by the object, including detached roots it started.

### 4.4 Major: immediately closing exclusive natives is not restart-equivalent

A restart kills old work; fenced reload left it running against closed SQLite/socket/native handles. Work in dependent objects was not necessarily signalled. Abandoned old opens could race a new exclusive open.

**Recommendation.** Abort work of every dependent object and wait boundedly before close. New calls already wait for reopen, so this bounded exclusive-only drain cannot deadlock. Wait for abandoned exclusive opens to settle.

### 4.5 Major: Durable pinned snapshots and stale conflict

A phase pins an Extensions snapshot. Late binding would pair a v1 schema with v2 implementation; old binding could hit changed storage and commit a stale tool error where restart would resume the task.

**Recommendation.** Keep Durable reservations/ownership. A pinned phase runs its snapshot code and keeps declarations alive; abort/reschedule the phase rather than commit stale.

### 4.6 Major: effects and entries started before async activation

**Trace.** Chat's watch routine starts while its conversation resource is reopening; source resolution throws `not_ready`, and the effect stays failed until another reload. Reset members can appear unhydrated to existing holders.

**Recommendation.** Keep object `updating` during async activation. Start effects, entries and remote snapshots only after success; buffer events meanwhile.

### 4.7 Minor/major: async effect cleanup overlap

Search indexer or subagent reporter old/new loops could overlap. Old report may overwrite new state; indexing could run the same range twice.

**Recommendation.** Replacement starts after cleanup settles for that slot; deadline/stalled is local to the routine, not the object.

### 4.8 Minor: post-publish failure made revert impossible

The cell migrated at publish; an exclusive open then failed. v1 code could not be restored without a version decrease.

**Recommendation.** Retain pre-migration last-live snapshots until activation succeeds; allow revert to restore them. If reset moves memory into a source, pass previous with idempotent semantics.

### 4.9 Verdict on version fences

Simpler than full drain but broken at storage/work boundaries. The choices that had to change were per-cell rather than per-object fencing, stale-on-read and retryability, and immediate exclusive close. Useful pieces to preserve were ownership stamps, deferred close, Durable reservations, per-object write epoch, readiness during async activation, serialized effect cleanup, dependency ordering, last-live state and bounded exclusive-only drain.

---

## 5. Transactional-document Chord v2 / p3 target design: full review

### 5.1 Blocker: publish-before-migration let new code touch old document shape

**Status: Later target text changed toward migrate-on-access; verify current implementation plan preserves the fix.**

The reviewed §15 published new code synchronously, then performed migration commits. If an old transaction held the object's line, new v2 code could synchronously read v1 or draft v2 ops onto a v1 base before migration.

**Trace.** Old `Draft` v1 transaction awaits storage commit. Publish installs v2. New `snapshot(Draft)` returns v1; new `save` writes v2 paths. Migration then processes a mixed value. Exposed state could send v1 under a v2 contract.

**Recommendation.** At publication mark bumped documents migrating. New-code reads and transactions wait on the object's line until migration commits, or migrate in memory synchronously and fail/rebase old transactions. Exposed readables keep old snapshot until reset.

### 5.2 Major: old code could drive a newly replaced native

**Status: Decided / adopted.** Later design says handles belong to generations and old handles throw stale.

A shared by-name resource handle returning the latest value lets old job logic silently operate a semantically new sandbox/socket.

**Recommendation.** Per-generation handles; old handles revoke on replacement. New calls wait during replacement.

### 5.3 Major: routine serialization is required

**Status: Decided / adopted in §11.**

Queue item X can be processed by the old handler and by the new reconciler after reload. Search and subagent reporting can duplicate or reorder actions.

**Recommendation.** Stable per-routine dispatcher; new reconciliation starts only after old handler/cleanup settles, with a routine-local deadline.

### 5.4 Major: old code's final transaction can lose already-completed work

**Status: Decided / addressed by two-phase jobs; see section 8.**

A shell completes, then its old-code transaction touches a migrated result document and throws. Cleanup could falsely record `interrupted`; external effects already happened.

**Recommendation.** Old run returns outcome to runtime; current code applies it. Mutating methods need idempotency/request ids or non-retryable stale semantics.

### 5.5 Major: immediate exclusive replacement under dependent work

**Status: Resource design evolved to `replace` handoff; no-wait replacement remains an explicit tradeoff.**

The Durable harness/execution dependency illustrates that work in other objects may close over the native. Closing under it differs from restart, where old work dies.

**Recommendation.** Propagate replacement through declared deps; old handles stale; bounded abort/wait for truly exclusive natives if native corruption is possible.

### 5.6 Major: Durable phases pin registry tables

**Status: No-late-binding immutable tables adopted. Open issue remained for resource-bumped old entries.**

Pinned old tools either need old declarations kept alive, or stale must terminate and reschedule the Durable invocation without committing a tool error.

### 5.7 Major: start routines and entries only when contributor is live

**Status: Decided / adopted as readiness gates and old-entry retention, with later review caveats.**

Publishing an Extension before resources open can resume a Durable task into `not_ready` and commit the fault.

**Recommendation.** Contributor entries become current only at readiness. Existing entries remain until success or failure, and are removed on failure.

### 5.8 Major: jobs must count for keep-alive and relocation

**Status: Decided / adopted in job section.**

A tab can close while shell/codemode work remains. If jobs are not activity, idle stop or relocation kills/moves beneath the job.

**Recommendation.** Host activity includes running/unsettled jobs; relocation refuses or explicitly aborts them and waits through finish.

### 5.9 Minor: wire atomicity does not compose with adapters

Raw v2 document ops cannot apply to an adapter-produced v1 view. Atomicity per hold can also tear a commit observed through two holds.

**Recommendation.** Diff adapted values per binding; define whether atomicity is per hold or batch all holds on a link/object.

### 5.10 Minor: persisted identity and one-way migration footguns

**Status: Stable-identity restriction, tags and storeKey were later adopted. Revert behavior remained a design concern.**

Worker generation and owner access path make principal keys unstable. Session clone changes ids. Removed types leave persisted docs without an owner. Lazy one-way migration means some docs advance and dev revert cannot read them.

**Recommendation.** Persist only host-lifetime objects or types with explicit stable `storeKey`; retire by tag/type; retain prior base until a subsequent successful reload or explicitly accept forward-only migrations.

### 5.11 Contradictions and startup cycle

Earlier plugin-loading text said registries had no versions/adapters while target design defined them. A worker readiness/report cycle was possible if server routing waited for report while `host.ready()` needed a server object.

**Recommendation.** Report code installation separately from object readiness; route per live object; keep docs aligned.

### 5.12 Verdict on transactional documents

Transactional documents, object lines and copied Durable transaction/eviction semantics are a sound and simpler base than drain handover. Before implementation, the design needed to close the publish/migration gap, preserve per-generation native handles, serialize routines, finish jobs through current code, gate entries on contributor readiness, count jobs as activity, and make rollout status/revisions precise.

---

## 6. Jobs design

### 6.1 Real-case classification

- Chat `!cmd` shell: detached background work is required. It must outlive the tab, expose progress to multiple viewers, be abortable by id and land exactly once in the transcript.
- Login OAuth: detached job is required. A short link blip must not abort the provider flow; prompts are Questions; notices are progress.
- Env test: a long method call is enough. It is request/response, idempotent and may die with its caller.
- Codemode/tool execution: Durable task, not Chord job; it already needs checkpoints/replay/task ownership.

**Owner decision: adopted in current §10 / Questions design.**

### 6.2 Initial concrete job proposal

The proposal was a runtime-owned job record:

```ts
type JobEnd<A, R> = { id: JobId; args: A } &
  ({ kind: "done"; outcome: R } |
   { kind: "failed"; error: string } |
   { kind: "lost" });
```

A versioned definition provides typed args, progress and outcome, optional persistence/concurrency/retention, and pure upgrading of old results. Starting belongs in a transaction (`tx.start`) so busy check and request-key dedupe are atomic. `ctx.progress` is throttled/in-memory. Running/unsettled records count as activity. Persisted running records from a dead incarnation become `lost` on next activation.

The initial proposal separated `settle` (transactional current code) and `deliver` (idempotent external I/O). The owner then preferred the cleaner two-phase form below.

### 6.3 Owner's two-phase `run` / `finish` shape

**Status: Decided / adopted.**

I agreed with the shape: `run` returns the result; `finish(end, tx)` from current code records it; Chord acknowledges the run in the same transaction. This is cleaner than separate settle/deliver for ordinary outcomes.

Required refinements I recommended:

1. Typed terminal end including `lost`.
2. Atomic start inside a transaction.
3. Pure `accepts`/upgrade for args/results from an older job version; terminal stored results are not rewritten.
4. Explicit rule for external systems.
5. Key tombstones retained long enough to dedupe client retries.
6. Pending finish must retain outcome and retry after reload/activation.

### 6.4 Problem 1 trace: result document migrated during run

1. `tests` migrates v1 -> v2 while v1 env test runs.
2. v1 `run` returns and writes no document.
3. v2 current `finish` drafts the v2 document and records outcome.
4. Chord acknowledgment and app document write commit atomically.

This solves the original false-`interrupted` bug.

### 6.5 Problem 2: external systems cannot be written inside finish transaction

**Decision/recommendation.** The external operation belongs in `run` and carries `ctx.jobId` as its dedupe key. For the shell, Durable submission uses `requestId = jobId`. `finish` only records app state/acknowledges.

Crash windows:

- Submit succeeds, process dies before acknowledgment: persisted run appears `lost`; Durable already has exactly one entry because request id dedupes.
- Process dies before submit: outcome is lost. This cannot be solved for non-replayable work.
- External system without a dedupe key: at-most-once attempt in `run`, or an outbox document written by `finish` and drained at-least-once by a serialized routine.

### 6.6 Abort and the missing closing signal

**Open/review point later found in current §10.** `ctx.signal` is fired by user abort. A cancelled shell still must submit its cancelled transcript entry, but a Durable submission using that signal rejects immediately.

**Recommendation.** Add `ctx.closing`, which aborts only on forced object/host closure. The run stops the process with `ctx.signal`, then performs final idempotent delivery under `ctx.closing`. Running jobs keep their object alive. Forced disposal records `aborted` and runs finish before closing the store when possible.

### 6.7 Busy semantics and finish failure

**Open finding from current §10 review.** Current text counted runs whose `finish` had not committed against `concurrency`. A migrated document without a valid migration, a broken finish, or missing job adapter could block a concurrency-1 shell forever.

**Recommendation.** Concurrency counts only live effects. An ended record waiting for finish remains visible as `{phase:"finishing"}` and reports failure, but does not hold the live-run slot. If the owner intentionally wants ordering through finish, make that separate/explicit.

### 6.8 Progress and unavoidable limits

- `OutputBuffer` + `Progress` avoids write amplification; progress is in-memory and may lose the tail on crash.
- Old-version live progress should be hidden unless adapted.
- A command that completed just before crash can return as `lost` despite external side effects. No generic runtime can distinguish this without effect-side idempotency/receipt.
- A process cannot be relocated; relocation must refuse or abort.

### 6.9 What to drop from the old §10

- `cleanup(jobId)` that could overwrite a completed result with `interrupted`.
- The old run's final `self.tx`.
- `running.value.length` followed by `start` (non-atomic).
- Treating a request id merely as run id; use it as a dedupe key while Chord mints globally unique run ids.
- “After crash nothing runs” as the only behavior; persisted records allow a `lost` outcome.

### 6.10 Current §10 review points

**Status: some open.**

- A blocked/failing finish must not hold the busy slot forever.
- The abort path needs `ctx.closing` and explicit object-ending semantics.
- Job `accepts` must preserve args/outcome meaning and never silently drop blocked outcomes.
- `finish` retry/backoff must retain the terminal result.
- Running and unsettled runs count as activity.

---

## 7. Questions service

### 7.1 Overall assessment

**Status: Decided / adopted as a p2 service, not a Chord/Durable primitive.**

The design is sound if the in-memory pending store is the truth, calls use stable keys to reattach after link loss, and authorization is per question.

### 7.2 Open list must derive from resource state, not a document

A migrated/persisted open-list document can retain ghost questions after resolver loss or old-generation cleanup failure.

**Recommendation adopted in questions.md.** Store `{question, resolve, reject}` in a resource Map; expose a filtered readable/derive. Answer/abort/deadline atomically `take(id)` before resolving. A late/second answer gets gone.

### 7.3 Link loss is not denial

Durable `beforeTool` catches a hook error and blocks the tool. A phone network blip during approval must not become a permanent `blocked: unavailable` transcript result.

**Recommendation adopted.** `ask(...,{key})` takes stable flow identity (task id/job id). Retry `unavailable` under the caller's signal; same key reattaches.

### 7.4 Reattachment must include prompt identity

**Open finding from current Questions review.** Login example used `key: ctx.jobId` for successive prompts. If one OAuth flow asks account selection and then manual code, the second ask can attach to the first question unless key includes prompt id/counter or reattach validates exact question identity.

**Recommendation.** Stable key is `(flow id, prompt id)`; reattach only if scope, audience, policy and normalized question match.

### 7.5 Authorization and secrets

**Adopted.**

- Worker asker only in own session.
- Secret questions only from server askers.
- Audience controls answer authority; guest send access does not imply tool approval.
- Viewing and answering checked separately.
- Secret answer never enters readable/doc/log; redaction occurs in answer before provider code receives it.

### 7.6 Tool approval memo must bind approved arguments

**Open finding.** A bare boolean memo can approve different final arguments if argument-rewriting hooks change after reload/crash before intent commit.

**Recommendation.** Memo `{allowed, digest(finalArguments)}`. Re-ask if digest differs. Approval hook must run after all argument-rewriting hooks.

### 7.7 Approval needs a default deadline

**Open finding.** Pending `ask` is an active call. With owner offline and no deadline, it can hold worker keep-alive and relocation fence indefinitely.

**Recommendation.** Tool approvals get a bounded default deadline that resolves to deny/no-answer. Long-lived multi-party question tool already specifies one.

### 7.8 Plain-data resource required for generation GC

**Open finding.** `replace: old => old` on an instance of `PendingQuestions` retains the old class prototype and bundle generation, contradicting loader D reclamation.

**Recommendation.** Resource value is a plain Map/listener container; current facet code supplies all logic. If a class is unavoidable, replace constructs a new-generation instance from old data.

### 7.9 Notices are not questions

**Adopted.** Login auth URL, device code and provider notices are one-way job progress, not prompts. Remote device-code auto-selection stays in the login flow.

### 7.10 Durable question-tool context example

**Open doc issue found in review.** The question-tool scenario used `ctx.get` / `ctx.toolCallId` as if Durable tool execute received a Chord ctx. Durable provides its own API/context.

**Recommendation.** Wrap the call in `host.root`, use Durable task/call id as the question key, and document that unsafe tools interrupted after execute intent do not re-run hooks.

---

## 8. Resources with `replace`

### 8.1 Hand-over hook rationale

**Status: Owner adopted.** A synchronous `replace(old)` may transfer a native/container into the new shape without closing it. Old-generation handles stale. Async behavior/handshakes live in routines.

### 8.2 `replace(old) => old` generation leak

See Questions 7.8. More generally, transferring a value with old prototype/method closures keeps old generation code alive.

**Recommendation.** Resource values should be native/plain data; behavior outside. `replace` constructs a new wrapper if wrapper code changed.

### 8.3 Dependency semantics were underspecified

**Open review point.** When a provider is handed over with `replace`, are dependents kept, handed over, or reopened? Reopening a dependent whose close owns the same socket can close the transferred native.

**Recommendation.** State explicitly: a provider's `replace` preserves its identity for dependency comparison only if declared; each changed dependent either has its own `replace` or reopens without closing transferred provider state. Close/open ordering follows deps.

### 8.4 Replace failure and old work

If replace throws, design closes old value while old jobs/calls still use it. This is an accepted restart-like native error, but must be explicit. Old handles stale immediately and object fails; no code may silently follow the replacement.

---

## 9. Routines and naming

### 9.1 Required semantics

Standing behavior is separate from jobs, methods, docs and resources. It has `on`, `every`, `loop`, `custom`; errors are caught; cleanup and in-flight handler serialize across reload; timer due date survives reload.

**Status: Adopted as `self.routines`.**

### 9.2 Naming recommendations

Initial ranking:

1. `self.standing`: directly matches “standing behavior”; no collision.
2. `self.supervised`: Chord starts/stops/restarts/catches errors, analogous to Erlang/OTP and Akka supervision.
3. `self.daemon`: background behavior for object lifetime.

Related framework terms: RxJS subscriptions; Kubernetes controllers/reconcile loops; Orleans timers/reminders; Durable Object alarms; Temporal durable timers; React setup/cleanup effects.

### 9.3 `self.run` versus `self.routines`

I ranked `self.run` below `routines`.

- Job execution and job callback already use “run”.
- `self.run.custom(... ({run}) => ...)` gives the same word two meanings in one call.
- As a verb, `self.run.loop` sounds imperative rather than declarative.
- `self.routines.every(...)` names the category, has no collision, and reads consistently.

**Later status: current target used `self.routines`.**

---

## 10. Reload as restart: dropping trials and dry runs

### 10.1 Position

I agreed with dropping the old prepare trial machinery and migrate dry run because the old bugs came from trial objects acquiring refs/opening resources/racing activation, and dry run covered only loaded documents.

I initially recommended retaining a cheap recording-only factory call before publication to catch common factory typos without creating objects or resources. The later owner decision explicitly chose **no factory trial**; reload is explicit, not on save, and factory failure is restart-like. Treat that recommendation as **not adopted**.

### 10.2 Facet setup failure semantics

Recommendation at review time:

- Failed facet object; served objects fail with it; entries leave table as after restart.
- Build registry tables once after setup staging.
- Contributor entries appear only when contributor is live.

Later owner decision changed this: a throwing setup retains that facet's previous version while other facets publish. This introduced per-plugin mixed-version/revision concerns recorded in section 12.

### 10.3 Long publish

Only objects of changed plugins should rerun factories. Measure/report synchronous publish duration. Do not lazily rerun factories, because calls would observe mixed old/new code by object.

**Status: Adopted: publish is measured/reported and one tick.**

### 10.4 Start barrier

Recommendation: first start waits until required host objects settle; optional failed facets remain unavailable; Durable resumes only after required cwd/model/config are ready. Reload has no global barrier.

**Status: Adopted in broad form.**

### 10.5 Exposed singleton migration failure

I objected to merely refusing one access while references supposedly remain hydrated. A singleton exposed under a new contract but still v1 cannot truthfully remain healthy.

Recommendation then: migrate loaded exposed singleton during after; on throw either fail the member/object with an explicit error state and no v2 ops, while preserving stored data. The later text chose per-member error while methods/other members remain live. Verify wire/hydration semantics make that state explicit rather than serving stale shape.

### 10.6 Jobs of failed objects

Their terminal outcome remains recorded; `finish` waits until current code exists after retry/reload. Pending finish should not hold the live concurrency slot forever.

---

## 11. Current jobs / routines / resources / Questions consistency review

### 11.1 Finish-pending busy slot

Current §10 said `running` includes finish-pending runs and the busy slot remains held. A broken finish or missing adapter can permanently block concurrency-1 work.

**Fix recommendation:** separate `running` effect from `finishing` outcome; preserve/report result and retry finish without blocking new effect unless explicitly requested.

### 11.2 Abort/final delivery missing `ctx.closing`

Current §10 says abort fires `ctx.signal`, but shell example submits externally after process end. Cancellation aborts the delivery too.

**Fix recommendation:** job ctx has stopping signal and closing signal; object/job lifecycle explicitly says when finish may run.

### 11.3 Tool approval memo argument digest

See 7.6.

### 11.4 Question store class generation leak and key collision

See 7.4 and 7.8.

### 11.5 Resource replace/deps wording mismatch

See 8.3; update resource, reload and version table consistently.

### 11.6 Durable context mismatch in question-tool example

See 7.10.

---

## 12. Focused reload and rollout review of §15

**Status: Open unless current target has since changed.** These findings apply to the explicit load -> publish -> after, restart-like rollout reviewed at 6559589bd.

### 12.1 Major: Durable phase spans a resource bump

A pinned old registry table invokes old code after the contributing resource is replaced; old handle throws stale and Durable can commit the tool error permanently.

**Concrete p2 trace.** Codemode extension reads `sandboxResource.value`; long agent phase pins Extensions; reload bumps sandbox; next script in phase uses old entry and gets stale.

**Recommendation.** p2 Durable bridge treats stale from a pinned entry as invocation loss without commit, then reschedules with a fresh snapshot. Correct “old, consistent code” wording: it is consistent only while declarations it uses stay alive.

### 12.2 Major: old entries must leave when new contributor fails

Old entries staying “until new version is live” has no end when factory/resource/migration fails. They remain callable against closed/stale handles.

**Recommendation.** Retain old entry until new contributor is live **or failed**; remove and report on failure.

### 12.3 Major: overlapping `after` steps across quick reloads

R1 is reopening port 9090. R2 publishes before R1 finishes and starts another reopen. Opens race (`EADDRINUSE`), R1 may complete after R2 close and leak, and R1 may open R2's gate incorrectly.

**Recommendation.** Per-object serialized after queue. Superseded async opens close their eventual value and cannot mutate readiness.

### 12.4 Major: one host revision cannot represent partial facet retention

A setup failure keeps plugin A at R-1 while plugin B reaches R. The host is at neither revision. A host-wide mismatch status misclassifies unaffected contracts and reconnect state.

**Recommendation.** Revision/status per plugin (or complete code-set digest plus per-plugin exceptions). Mismatch carries the serving plugin's desired/running revision and status.

### 12.5 Major: client wait has no exit when its own install rejected

Provider is ahead, so browser assumes its own install is coming. If web facet setup rejected or tab never installs, calls park to deadline, reacquire and park again.

**Recommendation.** Binding checks local install status; rejected fails fast. Browser/TUI unable to install in place falls back to full page/worker swap.

### 12.6 Major: server incarnation forces unnecessary full reinstall

Server restart changes incomparable incarnation although code digest is unchanged. Every worker reruns all factories/routines and cannot serve until reporting, stalling all sessions.

**Recommendation.** Revision also carries complete code-set digest. Same digest means synchronized without install; incarnation/sequence orders rollouts.

### 12.7 Minor: routine start ordering can cycle with readiness gate

Old serialized routine handler calls its own object and parks behind readiness. New routine waits for old handler. Gate opens only after new routine starts.

**Recommendation.** Open readiness after resources/derives are ready, then start routines. Routine can reconcile once calls are admitted.

### 12.8 Minor: plugin-loading removal check contradicted restart-like bind failure

Plugin-loading §4.2 still refused removal while holders exist, while new §15 removed consumer checks and says consumers fail at bind. Durable live-task removal also has special behavior in plugin-loading §10.

**Recommendation.** Pick one rule and align docs. Under restart semantics, delete holder refusal and explicitly point removal to Durable task provenance/stop policy.

### 12.9 Additional rollout review points considered

- Worker spawned mid-rollout must install the server's complete desired code set before routing; snapshot desired set atomically with spawn.
- Rapid R1/R2 should reconcile directly to latest complete set; superseded installs cannot publish late.
- Background/old clients need a full-reload fallback after install deadline.
- Server load/build error before publish should stop rollout and preserve previous desired revision everywhere.
- Calls parked on a binding released by consumer code replacement end and are not resent: this avoids duplicate method execution.
- A facet retained at old version may conflict with newly published consumer facets/contracts/registry owners on the same host; per-plugin status must make failures local and explicit.

### 12.10 Verdict at that review

Single-host load/publish/after was judged sound in shape, but not ready until Durable stale handling, failed-entry removal, per-object after serialization, per-plugin revision/status, client rejection exit and digest-based reconnect were specified. These fixes do not reintroduce factory trial or drain.

---

## 13. Prototype regression-test audit summary

These throwaway tests were written under `/tmp/chrev` during the reviews. They are historical and may no longer apply to current code:

- `reentry.test.ts`: old code after member drain / lost write.
- `registry.test.ts`: registry call ownership.
- `queued.test.ts`: queued run closure ownership.
- `doubleswap.test.ts`, `doubleswap2.test.ts`: effect cleanup overlap/stalled flag.
- `hang.test.ts`: unbounded post-drain step.
- `failedblocks.test.ts`: failed object blocking unrelated reload.
- `revert.test.ts`: failed handover unable to revert.
- `r2facet.test.ts`: facet removal under work; multi-member stall.
- `r2registry.test.ts`: object-valued entries; no-context self-wait.
- `r2activation.test.ts`: prepare/activation deadlock.
- `r2gc.test.ts`: facet generation reclamation (passed).
- `r2seq.test.ts`: sequential members causing needless call timeout.
- `r2revision.test.ts`: rejected delta skipped after later revision.
- `r2entryabort.test.ts`, `r2entrystale.test.ts`: registry context/signal/stamp.
- `r2init.test.ts`: init mutating live previous value.

---

## 14. Cross-cutting recommendations retained across designs

1. **Generation ownership must be explicit.** Handles, routines, jobs and pinned registry values must either retain the exact declarations they use or fail in a way the caller can safely replay.
2. **Do not call partial external work generically retryable.** Retry requires a request/dedupe key or a durable outbox.
3. **No old-code write through new shape.** Transaction/document version checks are necessary, including copied-value/cross-document decisions where possible.
4. **Serialized standing behavior.** New reconciler starts after old handler/cleanup for the same routine; no object-wide drain.
5. **Contributor readiness gates registry visibility.** No task/tool/route should become discoverable before its resources and exposed state are ready.
6. **Jobs are activity.** They keep objects/workers alive and participate in relocation/stop policy.
7. **Immutable registry tables need lifecycle ownership.** Pinned old entries are safe only while the generation's declarations stay usable.
8. **Revisions describe actual code, not intended code.** Partial installs require per-plugin status; reconnect equality needs code-set digest.
9. **Complete-set reconciliation beats deltas.** Rejected revisions must not be skipped by a later delta.
10. **GC is part of correctness.** Resource values handed over across bundle generations must not carry old prototypes/closures unless intentionally pinned.

---

## 15. Known owner decisions recorded in this conversation

- **Rejected:** drain-based handover, distributed re-entry/root ids, closure-wide drain machinery.
- **Rejected:** pure version-fence design without transactions.
- **Adopted:** Chord-owned transactional documents modeled after Durable, per-object lines and serialized host storage commits.
- **Adopted:** handles belong to code generations; old code touching migrated documents or replaced handles fails.
- **Adopted:** routines serialize per routine across reload.
- **Adopted:** resources support synchronous `replace(old)` handoff plus dependency order.
- **Adopted:** versioned immutable registry tables; no late binding.
- **Adopted:** typed host values and start barrier.
- **Adopted:** jobs use intent/effect/outcome (`tx.start`, old-generation `run`, current-code `finish`) with atomic acknowledgment.
- **Adopted:** abort is a request; live progress uses `OutputBuffer`/`Progress`; jobs count as activity.
- **Adopted:** Questions is a p2 service backed by an in-memory shared resource and per-principal Chord views.
- **Adopted:** explicit reload, never on save; no factory trial, no migrate dry run, no prepare-time live-consumer compatibility vote.
- **Adopted:** facet setup declarations stage at publish; setup failure keeps that facet's previous version while other facets may advance.
- **Adopted:** explicit load -> synchronous publish -> ordered after activation and readiness.
- **Adopted:** restart-like contract mismatch behavior at bind.
- **Adopted:** rollout revisions identify complete desired code sets and installs reconcile missing code; later review found partial-facet status still needs per-plugin precision.
- **Naming adopted in current text:** `self.routines.on/every/loop/custom`; I preferred it over `self.run` because `run` collides with job runs and custom's helper.

## 16. Still-open points from my reviews

Unless superseded after the conversation, the main open points were:

- Whether finish-pending jobs hold concurrency slots; recommendation: no, expose `finishing` separately.
- A separate `ctx.closing` signal for final delivery after user abort.
- Pure adaptation of old job args/results and behavior when no adapter exists.
- Question key identity for successive prompts and argument-digest binding for tool approval.
- Default approval deadlines and relocation/keep-alive behavior.
- Plain-data Question store to avoid generation leaks.
- Exact resource `replace` semantics for dependents and failure.
- Durable handling of stale pinned registry entries.
- Old-entry removal when contributor activation fails.
- Per-object serialization/cancellation of overlapping after phases.
- Per-plugin rollout revision/status and code-set digest on reconnect.
- Client install rejection/full-reload fallback.
- Alignment of plugin removal semantics between target-design and plugin-loading.
- Explicit wire behavior for adapted document ops and cross-hold atomicity.
- Revert/forward-only policy for lazily migrated persisted documents.
