# Durable: split `pi.live` into `pi.run` and `pi.progress`, with deferred persistence for progress

Status: **proposal, owner wants it (2026-10-23), pending a full review by Astra and Fable**. A breaking change in pi's
Durable (`packages/durable`), upstream first; pairs with pi #11327 (windowed view, `runFailure`, removing
`watchEvents`) and #11139 (a run cut off by repeated crashes ends visibly).

## Problem

Durable commits a streaming answer's partial every ~100 ms per conversation into `pi.live`, a persisted document. Each
partial commit is a full durable write: a storage transaction, a delta row, an outbox record (p3's store syncs it to
Radius). With 32 subagents streaming in one session (a real case) that is ~320 durable commits per second, almost all
overwritten 100 ms later. Measured by `rqlite-eval` (`/tmp/rqlite-eval.md`, real Durable Session on SQLite, 32
streams): 100 ms persistence 9.8% CPU, 5.6 MB/s disk (20 GB/hour), 79 KB/s outbox raw; 1 s persistence 1.6% CPU,
0.6 MB/s, 16 KB/s. Per partial commit ~640 us, ~310 us of it the SQLite transaction (`is-9265`'s profile).

Persisting the partial less often is not possible today, because `pi.live` mixes two kinds of fields: control that
Durable itself decides with (`run`, tool slot identity and status, compaction status) and fields only clients display
(the partial message, tool output, backoff times). Deferring writes of a mixed document either risks losing control
state in a crash (trace: the final commit deletes `run` and settles the submissions; if `pi.live`'s part were lost, the
resumed host sees `run` still set, `submissions.ts` treats the conversation as busy, nothing ends that run) or needs a
flush rule that, applied session-wide, would flush ~10 times per second with 32 streams and win nothing.

## Proposal

### Two documents, every field in exactly one

```ts
/** pi.run: what Durable decides with. Persisted with every commit, as today. */
type RunState = {
	run?: { taskId: TaskId; inputs: SubmissionId[] };                 // present exactly while busy
	runFailure?: { taskId: TaskId; reason: string; error: string };   // why the last run ended unanswered (#11327, #11139)
	generation?: { attempt: number };                                  // an attempt is running
	tools?: { callId: string; name: string; status: "pending" | "running" | "done"; taskId?: TaskId; entry?: EntryId }[];
	nestedTools?: {
		callId: string; name: string; status: "pending" | "running" | "done";
		parentCallId: string; parentTaskId: TaskId; taskId: TaskId;
		arguments: JsonObject;                                           // what the call runs with
		summary?: { isError: boolean; durationMs?: number; usage?: Usage; error?: string };
	}[];
	compactions?: { taskId: TaskId; reason: CompactionReason; blocking: boolean; attempt: number }[];
};

/** pi.progress: for display only. Persisted deferred (at most once a second). */
type ProgressState = {
	message?: AssistantMessage;                                        // the partial answer
	retry?: { at: number; error: string };                             // generation backoff
	deferred?: { pollAt: number };                                     // a deferred response being polled
	calls: { [taskId: string]: {                                       // model-issued and nested calls, by tool task id
		output?: string; droppedBytes?: number; droppedLines?: number;
		details?: JsonValue; diagnostics?: ToolDiagnostic[];
	} };
	compactions: { [taskId: string]: { retry?: { at: number; error: string } } };
	compactionFailure?: { taskId: TaskId; reason: CompactionReason; error: string };
};
```

- Progress is keyed by **task id**, not call id: a nested call's id is `<parentCallId>/<key>` and a model-issued id
  from OpenAI Responses (`call_id|item_id`) may contain `/`, so call ids are not unique across both kinds by
  construction; task ids are (minted per session), and progress only exists while a call runs, when it has its task.
- Renderers read both from one view value and join by task id; nothing is duplicated, so nothing can disagree.
- `pi.live` disappears (the name meant "live state"; `pi.run` is control, `pi.progress` display).

### Deferred persistence: a generic document option

```ts
export const ProgressDoc = defineDoc<ProgressState>({ kind: "pi.progress", …, persist: { deferMs: 1000 } });
```

The Session knows nothing about `pi.progress`; its rule is generic:

- Every commit is adopted and published at once, as today (watchers and the view see every 100 ms update).
- Writes to documents whose definition has `persist.deferMs` are **held** per document, their ops folded (the leaf
  index of Chord's pending queue: appends to one text join, sets replace sets); all other writes go to storage in the
  commit's storage transaction as today.
- One Session timer stores every held document's folded ops in one storage transaction, at most `deferMs` after the
  first held write. A commit that writes a held document anyway may carry its held ops in the same transaction
  (optional; storage is fresher at no extra transaction).
- `close()` stores everything held. A base write of a held document (checkpoint, retirement) includes its held ops.
- No commit ever has to store another document's held writes for consistency: held writes touch only their own
  document, so storing them later gives the same stored state.

### Crash and resume

- Control (`pi.run`, entries, tasks, submissions) is always stored with its commit.
- `pi.progress` in storage is up to ~1 s behind, or absent if the host died within the first second of a stream.
- Resume converts the stored partial (`pi.progress.message`) into an aborted entry as today; if it is absent, there
  is no aborted entry and the request is resent anyway.

### Migration of existing sessions

- `pi.run` is created from an existing `pi.live` (its control fields) when a conversation is first opened by the new
  version; `pi.live` is retired.
- Every view-only field is cleared when a run ends (`endRun` deletes `generation`, `tools`, `nestedTools`), so a
  session at rest loses nothing; `pi.progress` starts empty and is created by its first write.
- A session upgraded in the middle of a run (it crashed or stopped mid-stream and resumes on the new version) loses its
  old partial preview and tool output; resume may read the old `generation.message` once to write the aborted entry.
- Clients reading `pi.live` break (public protocol, spec §9.3): p2's renderers, aron-cf's integration. Accepted
  (owner).

### Changelog: breaking change with a migration guide (owner)

Durable's `CHANGELOG.md` gets an entry under `### Breaking Changes` with a migration guide inside it: what moved where
(a field table `pi.live.<field>` -> `pi.run.<field>` or `pi.progress.<field>`), how a renderer joins tool slots with
their progress by task id (code before and after), what the view exposes (`docs["pi.run"]`, `docs["pi.progress"]`),
what happens to stored sessions on first open (and mid-run), the new `persist: { deferMs }` option for extensions'
own documents, and what a crash now loses (up to ~1 s of progress, or the whole progress of a stream's first second).

## What the reviewers check (in full, against Durable's code)

1. Every reader and writer of each `pi.live` field (`generation.ts`, `tool.ts`, `compaction.ts`, `live.ts`,
   `submissions.ts`, `events.ts`, `view.ts`, `inspect()`, the task graph, tests): is each field placed right (control vs
   display)? In particular: does Durable read `generation.retry`, `generation.deferred`, a compaction's `retry` or a
   tool slot's `output`/`details` itself (resume, scheduling, replay)? Then it is control and stays in `pi.run`.
2. The Session mechanics: adoption and publication of a held write without a storage seq (today adoption is driven by
   storage's `adopt(seq)` callback and every publication carries a seq); the documents engine accepting one stored
   delta that covers several in-memory revisions; checkpoints (`checkpointWhen`), the "complete base whenever nothing
   runs" rule of `pi.live`; retirement; `close`, eviction and `writeAtClose`; `StoreStorage` and the outbox (p3's store).
3. Crash and resume: every resume path that reads progress (`convertPartial`, tool replay clearing progress, compaction
   retries), and what an absent `pi.progress` means for each.
4. Migration: creating `pi.run` from `pi.live` on open (where, when, atomically), mid-run upgrades, forks
   (`fork: "initial"` today), copies (`document.copy`).
5. The view (#11327 and today's mount: `MOUNTED` documents), `watchEvents` until it is removed, and p2's renderers.
6. Numbers: confirm the win at 32 streams with the real code path (commits, CPU, disk, outbox), and what remains.
7. Anything simpler that gets the same result.
