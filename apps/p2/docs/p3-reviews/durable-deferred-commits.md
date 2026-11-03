# Durable: deferred storage of throttled commits

Status: **proposal for review** (2026-10-24). Replaces the `pi.run`/`pi.progress` split
(`durable-run-progress.md`, kept for its reviews). A pi change in `packages/durable`, upstream first. No schema change,
no change for renderers.

## Problem

Durable commits a streaming answer's partial (`pi.live.generation.message`) and running tool output (`pi.live` tool
slots' `output`, `details`, `diagnostics`) about every 100 ms per conversation. Each commit is a full storage
transaction: SQLite writes ~17.7 KB per commit (page granularity) for a ~150-byte change, and p3's store adds an
outbox record per commit. With 32 streams (a real case): ~270-320 commits/s, ~4.7 MB/s of disk writes (~17 GB/hour),
~11% CPU on slayer (Fable, `/tmp/group-commit-fable.md`; Astra, `/tmp/drp-review-astra.md`). CPU is mostly the
Session's in-memory work, which stays; disk and outbox are what this proposal reduces. Group commit was measured and
rejected (2-4x less disk only at >= 8 streams, no CPU gain, a few ms latency on every commit, early adoption needed).

## Idea

Only the two throttles (the generation's partial throttle in `harness/generation.ts`, the tool output throttle in
`harness/tool.ts`) mark their commits **deferrable**. Such a commit is adopted in memory and published to watchers
at once, as today, but not stored: its ops wait, folded, in a `PendingOps` per document (Chord's
`@earendil-works/chord/delta`, upstream `d8d99950a`). They are stored by the first of:

1. the next **normal** commit that writes the **same document** (it stores the held ops first, in its own storage
   transaction);
2. a Session **timer**, at most ~1 s after the first held write (one storage transaction for every held document);
3. `close()`.

A deferrable commit that writes anything else (an entry, a task, another document, a document creation, migration or
retirement) is stored at once: the mark is a permission, not an order.

## Why storage stays consistent

- Held ops belong to one document, `pi.live`, and only to its streaming fields.
- Everything that consumes or clears streamed content writes `pi.live` in the same commit: converting a partial into an
  aborted entry deletes `generation`; ending an answer clears the partial and sets `tools`; settling a tool builds its
  result from the slot's output and sets the slot `done`; steering, run start and run end change `run`. So each of
  these commits stores the held ops first, together with its own changes.
- Commits that do not write `pi.live` (a task's own state, a display-only entry, a submission record, another
  document) do not depend on the partial; they need not flush it.
- Guarantee: every document in storage is a state it really had; every commit that writes a held document stores it
  together with its own changes. Interleaving is low: control changes of `pi.live` happen at phase boundaries (run
  start, answer end, tool start and end, run end); streaming happens in between.
- Order: held ops are older than the normal commit that stores them, so they come first in the stored delta; with
  folding, a later write of the same field absorbs the held one (deleting `generation` drops the held appends).

## Adoption, sequence numbers, publication

All on the Session's line (one commit at a time), as today.

1. **A held commit:** memory adoption only (the tracker's pointer swap and ops), no change to stored-revision counters
   (`storedVersion`, `deltasSinceBase`) or record metadata; its ops go into the document's `PendingOps`; the document
   is pinned in the Session's cache until stored (no idle eviction, also with retention 0). Publication is tagged:

   ```ts
   type CommitPublication =
   	| { readonly kind: "stored"; readonly seq: Seq; readonly changes: readonly CommitChange[] }               // as today
   	| { readonly kind: "memory"; readonly after: Seq; readonly changes: readonly DocumentCommitChange[] };   // held
   ```

   A held commit only ever contains document changes, hence `DocumentCommitChange`; `after` is the last stored seq.
   The view mount and document watches apply its ops as usual; listeners that care about durability (replication,
   anything keyed by seq) skip `memory`.
2. **A normal commit writing a document with held ops:** `take()` the held ops, fold this commit's ops for that
   document onto them, one `document.change` write; storage commits as today; `adopt(seq)` adopts this commit's own
   ops in memory and updates the stored counters for the whole delta; the publication carries only this commit's own
   ops (the held ones were published already); the pin is released.
3. **The timer or `close()`:** a store-only commit on the line, one `document.change` per held document, one storage
   transaction; adoption updates stored counters only (no memory change, no publication). It takes a seq like any
   storage write; listeners see a gap, which Durable allows (it compares seqs, never counts them).

So `Transaction.adopt` splits into adopting in memory and recording what was stored; today's path runs both, a held
commit only the first, a flush only the second.

## Restrictions and edges

- The option applies only to documents with `history: "latest"` and `fork: "initial"` (`pi.live` qualifies): "as of"
  reads and forks of the current state read storage by seq and would miss held ops.
- Creation, migration and retirement of a document are never held.
- Checkpoints: `checkpointWhen` counts stored deltas; a base write includes everything held.
- The timer is a foreground timer (Workers refuse background timers), its deadline from the first held write; a failed
  flush fails the Session (as any storage failure).
- Other readers of storage (p3's outbox and replicas, an export, a second process) lag up to ~1 s for held fields; an
  export that must include them flushes first.

## Crash and resume

After a crash or a Cloudflare eviction, held ops are lost with the process; storage has `pi.live` with control as of its
last normal commit and streaming fields as of the last flush (up to ~1 s older, or absent if the stream started less
than a second before).

| What was running | Resume | Difference from today |
| --- | --- | --- |
| generation streaming | converts the stored partial into an aborted entry, clears it (normal commit), resends | the aborted entry up to ~1 s shorter; none if the stream was under 1 s old (today: 100 ms); its usage up to ~1 s low |
| deferred response being polled | continues from the task's checkpoint | none |
| replay-safe tool | reruns, progress cleared by a normal commit | none |
| tool without replay | ends `interrupted` with the stored output | output up to ~1 s shorter (accepted lossy recovery input) |
| compaction | reruns from its checkpoint | none |
| clean `close()` | stores everything held first | none |
| restart counter (#11139) | partial commits never counted as progress | none |

At open nothing is held; every resume step that consumes progress is a normal commit writing `pi.live`, so a second
crash cannot convert the same partial twice.

## Expected effect

32 streams: storage transactions for partials and tool output drop from ~300/s to at most one per conversation per
phase boundary or per second; disk and outbox accordingly (estimate: about 10x less; to be measured). CPU about the
same (the 100 ms in-memory work stays). One stream: ~10x fewer storage transactions for streaming.

## Changelog

Durable's `CHANGELOG.md`: the tagged `CommitPublication` is a breaking change for `subscribeCommits` consumers (a
migration note: skip or handle `kind: "memory"`); the crash window for streamed content grows from ~100 ms to ~1 s.

## What the reviewers check (against Durable's code, in full)

1. The consistency argument: is there any commit that stores data derived from `pi.live`'s streaming fields without
   writing `pi.live` in the same commit? Any reader of storage (scheduler, resume, inspect, forks, copies, events,
   view builds after eviction) that would see an inconsistent combination?
2. The adoption split, the tagged publication, the flush path, pinning, the timer, `close`, failures: feasible as
   described in `session.ts`, `transaction.ts`, the documents and storages? Every consumer of `CommitPublication` and
   `seq`.
3. Resume: every path in the table, plus double crashes.
4. Interleaving: measure on a real Durable conversation with tools (parallel tools included) how many normal commits
   write `pi.live` per second against held ones; and the disk, outbox and CPU effect at 1 and 32 streams.
5. Size of the change and anything simpler.

## Decided (owner, 2026-10-24), after the reviews (`/tmp/ddc-review-{astra,fable,opus}.md`)

- **Spec change accepted:** Durable's spec §1 ("all visible progress is durable; no volatile publication path") and the
  §13 non-goal change: a commit may be marked deferrable; what watchers see can be up to its window ahead of storage.
  A stream that crashes before its first flush leaves no aborted entry, and that attempt's usage is not recorded.
- **Public option, per commit, tagged:** `commit(change, context, { persistence: { kind: "deferred", withinMs? } })`;
  without `withinMs` the default is `settings.progress.persistWithinMs` (1,000); without the option, immediate. No
  internal flag: any task (built-in or third-party) may use it. The two throttles (generation partials, tool output) use
  it.
- **A deferrable commit is held only** when every write changes an existing document defined with `history: "latest"`
  and `fork: "initial"`; creation, migration and retirement of a document are never held; anything else in the commit
  makes it immediate (the mark is a permission).
- **Stored by the first of:** a normal commit that **reads (`tx.doc`) or writes** the document (held ops first, in its
  storage transaction); the document's deadline (the earliest `withinMs` deadline of its held commits), on a
  **foreground** timer through the injected `setTimer`; `close()` (after `writeAtClose`, before documents are cleared,
  in `try/finally`); and before a tracker with held ops is dropped (`unloadDocuments`, a version-mismatch reload) or
  its document retired.
- **Held ops leave the queue only at the last step before `Storage.commit`** (a failure earlier loses nothing); a failed
  flush fails the Session; the `PendingOps` overflow (10,000 ops) stores a base.
- **Pinning:** a document with held ops is not evicted.
- **Publications:** held commits are delivered to internal observers (`observeCommits`: the view mount, document
  watches; tasks and submissions ignore them) tagged memory-only; `subscribeCommits` stays durable-only and carries
  exactly what was stored (no breaking type change for it).
- **Changelog:** a Breaking/Changed entry for the spec change with a migration note (opt-in; what a crash loses).
