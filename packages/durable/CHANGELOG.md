# Changelog

## [Unreleased]

### Breaking Changes

- `SqliteExecutor` (re-exported from Chord) gains `runCounted(sql, ...params)`, resolving with the rows the statement changed; custom `SqliteDatabase` implementations add it.
- `Storage.commit(writes, adopt, context)` takes an `adopt(seq)` callback, the Session's in-memory adoption and publication of the batch: a storage calls it exactly once, synchronously, once the batch is durable and before its next commit starts, then resolves with `seq`, and never for a commit that fails before the batch is durable. Memory, SQLite, JSONL, and IndexedDB storages do; custom storages and wrappers must call or forward it, and the storage conformance suite checks it. A commit that rejects after its adoption is published and fails the Session without rolling the adopted changes back.
- `Storage.mintId()`'s contract is narrowed to IDs greater than every ID minted since the storage was opened and every ID stored, also across reopen. The bundled storages already behave so.
- Watches use Chord's `WatchHandle` and `WatchEnd` (Durable re-exports both, with `WatchChange` and `NativeWatchChange`). End reasons are `stopped`, `cancelled`, `ended` (was `session_closed`), `listener_error`, and `failed` (was `session_failed`); `retired` is gone (see below). An ended watch drops its listener and every reference into its Session, so a stopped watch that is still referenced keeps only its last value.
- Watch listeners take one change object before the context: `watch.start(async ({ value, ops, retired }, context) => …)` for document, conversation view (`Conversation.watch()`), and task graph watches, and `stream.start(async ({ value: events }, context) => …)` for `watchEvents()`. Migration: `start(async (value, ops, ctx) => …)` becomes `start(async ({ value, ops }, ctx) => …)`, and an event listener `(events, ctx)` becomes `({ value: events }, ctx)`.
- Document watches follow their address (kind, scope, and key) instead of one incarnation: `DocumentWatch<T>` is `WatchHandle<Readonly<T>>` (no `null`). A retirement no longer ends the watch with a last frame `[["r", null]]` and `retired`: the next call has `retired: true`, the last value the watch was given, and no ops (folded with what is pending; a change made in the retiring commit itself is not shown), and a document created at the address later arrives on the same watch as `[["r", value]]`, possibly in the same call. A task document's watch ends `ended` once the retirement call of the commit that makes its task terminal has returned; Session close or failure still ends it first if that call was not delivered yet (a watch never started). Acquiring an absent document still gives `undefined`. A watch pins the incarnation at its address, nothing while it is absent. Migration: test `change.retired` instead of a `null` value or a `retired` end, and stop a watch whose document may be retired for good, as it otherwise stays until the Session ends.
- Document, conversation view, and task graph watches deliver the commits made while their listener runs (or before `start()`) in one callback: the newest value, the commits' operations folded (appends to one string join, sets of one field keep the last) and the newest commit's Context. Past 10,000 pending operations the callback gets one root replacement `[["r", newest]]`. Before, each commit was its own callback and more than 100 pending commits became a root replacement. `watchEvents()` still delivers every event batch in order, with one `snapshot` past 100 pending batches.
- Removed the Chord state getters `Session.documentState()`, `Conversation.viewState()`, and `Harness.taskGraph()`, and the `DocumentState` type; use `watchDoc()`, `Conversation.watch()`, and `Harness.watchTaskGraph()`. Durable no longer uses Chord's `replicatedState()`.
- Partial answers and running tool output are stored later than they are shown: their throttled commits are deferred (`CommitPersistence`, spec §4.1), so watches, views, and agent events see each at once, while Storage gets them together with the next commit that reads `pi.live` (the end of the answer, a tool settling, a run ending) and at the latest after `settings.progress.persistWithinMs` (default 1,000 ms). With 32 streams over SQLite this cuts storage transactions about 5.7x and disk writes about 2.9x for turns with parallel tools, 27x and 9x for long answers, and CPU by about a quarter. A crash now loses up to about a second of streamed content instead of 100 ms; a stream that crashes before its first store leaves no aborted entry, and that attempt's usage is not recorded. `subscribeCommits()` gets these commits only once they are stored, with exactly what was stored (held operations first; a document the commit retires shows as its retirement only, without the operations stored before it), and gets a publication for a deadline's store too; it no longer sees every partial. Migration: a `subscribeCommits()` listener that showed live progress should use `watchDoc()`, `Conversation.watch()`, or `watchEvents()`; one that mirrors Storage keeps working; set `settings.progress.persistWithinMs: 0` to store progress right after each commit, about as before (one storage transaction per partial).
- The change type of `FileSystem.watch()` in `@earendil-works/pi-durable/env` is renamed from `WatchChange` to `FileChange` (same shape: `{ paths }`, `{ overflow: true }`, or `{ error }`), so `WatchChange` names only a watch listener's change. Migration: import `type FileChange` from `@earendil-works/pi-durable/env` where `WatchChange` was imported from it.
- `HostCallback` gains `"telemetry"`: a `host_error` report about a telemetry adapter that threw while a commit was published. Exhaustive switches over `HostCallback` need a case for it.

### Added

- Deferred commits: `Session.commit()`, `Conversation.commit()`, `TaskRuntime.commit()`, and a tool's `api.commit()` take `{ persistence: { kind: "deferred", withinMs? } }`. A commit that changes only existing conversation documents with `history: "latest"` and `fork: "initial"` is then adopted in memory and shown to watches at once, and stored with the next commit that reads or writes the document, before the document leaves memory, at close, or within `withinMs` (default `settings.progress.persistWithinMs`, or `createSession(storage, { persistWithinMs })`); any other write makes it immediate. A crash loses what is held. See spec §4.1.
- Synchronous observers for adapters, such as a Chord source over a Durable view: `Session.observeDoc(token, ...scope, observer, context)`, `Harness.observeConversation(id, observer, context)`, and `Harness.observeTaskGraph(observer, context)` attach an `Observer<T>` (`advance(change, context)`, `end(failure)`) atomically on the Session line, like a watch, and return an `Observation<T>` (`value`, `detach()`; `observeDoc` gives `undefined` for an absent document). `advance` gets every change unfolded as memory adopts it, for a stored commit inside Storage's `adopt` and for a deferred one before it is stored, so it must only record it: no awaits, no Session calls, no throws. A document observer gets one call per change at its address (two for a commit that retires and recreates it), the task graph also a call outside any commit when a registry change or a failed migration changes a `blocked` reason, and a change can arrive before the attaching promise resolves. The attaching context governs only the attachment; a closed Session or an invalid argument rejects the promise. One that throws is reported as `listener_error`, detached, and ended with the error. `end` comes once, at Session close or failure, or after a task document's retirement with its task. Document, view, and task graph watches are built on them (spec §9.1).
- `HarnessOptions.readOnly` opens a Harness as a viewer of a session another process drives: open leaves running tasks as committed instead of recovering them, every commit with writes rejects with `ReadOnlySession` before it reaches Storage, and `resume()` and every call that would run tasks reject with it.

### Changed

- Document, conversation view, task graph, and event watches use Chord's watch handles (`Watch`, and `NativeWatch` for event batches).
- A stored commit is published when Storage adopts it, inside `Storage.commit()`: the commit's telemetry events and Durable's own observers (document watches, conversation views, the task graph, the scheduler, and waits) run inside `adopt`, so two views never show one commit apart. `subscribeCommits()` listeners run one microtask later, outside the storage's synchronous step, before every wait the commit resolves and every abort signal it fires; they have no order relative to watch listeners and `onWake`. With a storage that works after adopting (JSONL's sidecar reclaim), all of these run before `Storage.commit()` resolves.
- `subscribeCommits()` listeners are read when a commit's dispatch runs: a listener added between adoption and the dispatch gets the commit only when one was registered at adoption; one added after the dispatch ran misses it.
- The abort signal of a newly marked running task fires after `subscribeCommits()` listeners instead of before them.
- A throwing Durable commit observer fails the Session after `Storage.commit()` returned, after the other observers and the host listeners got the commit; the commit still stands. When Storage also rejects that commit after adopting it, the storage error fails the Session and the observer's error is reported as `listener_error`.

### Fixed

- Fixed a tool round with `control.handoff` ending the run on the tool-calling answer: the handoff's `pi.reset` entry is written and the same run continues with a new generation in the new context, so the submission settles with the eventual answer. Queued writes and selected steers are placed after the handoff text, follow-ups wait for the run's final boundary, and a queued reset still ends the run `unanswered` with reason `reset`. `terminate` remains the way to end a round without another model request.
- Fixed a conversation watcher (`watchEvents()`, conversation views) holding a copy of a streamed text or tool call per partial commit, through Chord append ops that kept the whole string alive; a 140 KB answer followed by a 140 KB tool call held well over 100 MB ([#9265](https://github.com/earendil-works/pi/issues/9265))
- Fixed a nested call's error summary keeping the call's whole output alive through a slice of it ([#9265](https://github.com/earendil-works/pi/issues/9265))
- Fixed task span error messages and codemode call previews keeping the whole text they were cut from alive ([#9265](https://github.com/earendil-works/pi/issues/9265))
- Fixed partial commits of a streamed answer copying every growing text, thinking and tool-call argument string in full on each commit (about 20 s of CPU and a 100 MB heap peak for a 500 KB tool call): they now append new text with Chord's `appendText()`, and apply the argument changes of their own parse of the streamed argument text ([#9265](https://github.com/earendil-works/pi/issues/9265))
- Fixed stored assistant messages lacking `thinkingLevel`: a generation records the Pi thinking level its request asked for on the response, also after polling a deferred one, as pi-agent-core's agent loop does
- Fixed partial commits polluting `Object.prototype` when a streamed tool call's arguments gained a `__proto__` member after an earlier commit: the merge read the missing member through to `Object.prototype` and wrote into it
- Fixed a commit that Storage rejects after adopting it (a failed JSONL reclaim) publishing nothing: it is published and its waits resolve before the Session fails, so a replica built from `subscribeCommits()` stays equal to Storage and `pi.durable.tasks.active` stays balanced.
- Fixed a throwing telemetry adapter (a commit's `pi.durable.entry` or `pi.durable.submission` event, `pi.durable.tasks.active`) rejecting a durable commit and leaving the views and the scheduler without it: it is reported as `host_error` with callback `"telemetry"`, and the commit resolves. A throwing report metric or report event is dropped.

## [1.4.0] - 2026-10-21

### Breaking Changes

- `TaskRuntime.sleep()` is removed: it waited inside a phase, which holds an invocation and, after a restart, reruns the phase and restarts the wait. A task now ends its phase asleep with `runtime.sleepUntil(until, checkpoint, context)` or by returning `{ status: "sleeping", until, checkpoint }` from `runtime.commit()`; move the work after the wait into the next phase and carry what it needs in the checkpoint. `TaskRuntime.setTimer()` paces work inside a phase without waiting for it.
- Tasks have a `sleeping` status, so code that handles every `TaskState`, `TaskGraphState`, or `TaskInspection` state needs a case for it.
- Opening a SQLite storage migrates it to schema version 2 automatically, rebuilding its task table. A migrated database cannot be opened by 1.3.0 or earlier, so a deployment cannot roll back past this release. JSONL storage needs no migration, but 1.3.0 or earlier never resumes a sleeping task it finds (a run's conversation stays busy).
- `TaskRuntime` has `sleepUntil()` and `setTimer()`, and `ToolExecutionApi` has `now()`: code that builds either object by hand, such as a test fake or a tool wrapper that does not spread the original, must add them.
- A task cut off by a crash 5 times in a row without committing a new state is parked instead of run again (see the crash-loop guard under Added); set `settings.restartLimit` to `Infinity` to keep the old behavior. `TaskInspection`'s blocked reasons include `restart_limit`.
- `defineDoc()` and `defineDocFamily()` require an explicit `checkpointWhen` predicate on every definition; there is no default. Use `() => false` to keep ordinary changes as deltas, or supply a policy that periodically writes a base.

### Added

- Added `IndexedDbStorage` (`@earendil-works/pi-durable/storage/indexeddb`), a browser storage backed by IndexedDB.
- `HarnessOptions.telemetry` emits the content-free `DURABLE_TELEMETRY_SCHEMA`: public submission admission spans, task phase spans (including extension tasks), committed entry and submission events, running phase-change checkpoints, and nested-tool replay events. Optional propagation stores opaque carriers on submissions and tasks so queued inputs and reopened tasks retain their trace; `TaskOptions.trace` accepts a carrier override or `"root"` (absence inherits the creator's carrier); creation-time `links` connect inputs sharing a run, while steer admissions link to the running trace. Internal admissions emit events without a submit span. Optional metrics record phase duration and live task counts. Failed phases record fixed error-status categories (`task_faulted`, `task_failed`, `task_orphaned`) and diagnostics capped at 500 characters; aborted phases keep status `ok`. Every `onReport` report also emits a fixed-field `pi.durable.report` event on its current span (dropped by the NOOP span when there is none), plus a `pi.durable.reports` counter by type; report telemetry contains no error payload and leaves the callback unchanged. Clock failures report without a phase context. Generation and compaction forward their phase context to pi-ai requests.
- `settings.compaction.modelOverrides` sets compaction thresholds per model, keyed by exact `"provider/modelId"`, so one harness can serve small- and large-window models; the threshold check, overflow recovery, and the compaction task use the entry of the model they act for ([#10942](https://github.com/earendil-works/pi/issues/10942)).
- Durable sleeps: a sleeping task holds no invocation, survives restarts, and resumes at its checkpoint once the Harness clock reaches `until`.
- `HarnessOptions.setTimer` arms the timers of the Session, the scheduler, and its tasks (progress throttles, idle-memory eviction, sleeps), also for `createSession()`; with `now`, they run on a host or fake clock. A foreground timer the host throws on or declines falls back to `setTimeout`. `ToolExecutionApi.now()` reads the Harness clock.
- `Harness.wake()` and `HarnessOptions.onWake` tell a host when the Session next needs a process: `active` while work can run, `at` for the earliest sleep. With `onWake`, the Harness keeps no timer for sleeps, so a Cloudflare Durable Object can hibernate and wake on its alarm, calling `resume()`.
- Crash-loop guard: open counts the restarts of each task that a crash, eviction, or reset cut off (`TaskRecord.restarts`); a close writes the tasks it stopped back as `pending` uncounted, and a new state the task commits starts the count over. At `settings.restartLimit` the task is parked: blocked with reason `restart_limit` in `inspect()` and the task graph, not active in `wake()`, and reported once. `Harness.retryTask(id)` runs it again. An abort handler cut off that many times ends its task `faulted`.
- `onReport(error, info)`: `info` (`ReportInfo`) says what happened in `type`: `session_failed`; `task_faulted`, `task_parked`, `migration_failed`, `task_outdated`, or `task_error` with the task and the extension that installed it; `extension_error` with the extension's name; `host_error` with the failing `HostCallback`; or `listener_error`.
- `settings.afterFailedRun`: a run that fails with `model_error` or `no_model` keeps the inputs queued behind it (`keep`, the default), starts the next run with them (`continue`), or settles them `unanswered` with reason `run_failed` (`withdraw`).
- The task graph shows why a task cannot run (`TaskGraphNode.blocked`: `missing_task`, `task_too_old`, `migration_failed`, or `restart_limit`) and follows registry changes and failed migrations.
- Added `HarnessOptions.identity` (a pi-ai `ClientIdentity`) to set the `User-Agent` and provider attribution of every model request through the Harness, including hooks and tools. `api.models` in tools and hooks is now a wrapper of the host's `Models` that adds the identity, not the same object.
- `HarnessOptions.models` and `HarnessOptions.settings` also accept a function returning the current value, like `env`. Generation, compaction, hooks and tools call it at each use (`api.models` reads the current value at each access), so a host can replace its model configuration or settings without reopening the Harness. A plain object still works.

### Changed

- A task phase that faults is reported through `onReport` (as `task_faulted`), not only recorded in its outcome.
- `onReport` gets a second argument, `info`, and `TaskRuntime.report()` takes an optional `from` (see Added); an `onReport` written for one argument still works.
- Generation retry backoffs, deferred-response polls, and compaction retry backoffs sleep instead of waiting in a running phase, so a process can stop or hibernate during them. A record an earlier version stored mid-backoff sleeps again when it resumes before its time. A deferred poll whose model is gone after a reopen now fails `no_model` once the poll is due, not at once.
- Code mode measures script deadlines and wall time on the Harness clock (`HarnessOptions.now`) instead of `Date.now()`.
- SQLite drivers, portable interfaces, and the generic migration runner now come from `@earendil-works/chord/sqlite`. Existing Durable SQLite entry points keep re-exporting their public names; storage helpers and Durable schema migrations stay here.
- `ToolControl.terminate` is now typed `boolean` instead of `true`, matching `pi-agent-core` and `pi-coding-agent`; `false` does not end the run ([#10858](https://github.com/earendil-works/pi/issues/10858)).

### Fixed

- In Cloudflare Workers with `nodejs_compat`, the timers that evict idle documents and contexts were armed, since timers there have an `unref()`; a pending one kept a Durable Object from hibernating and blocked its eviction. They are now declined in Workers, and memory is freed at later commits.
- The README's Errors section now limits the `StorageRequestError` exemption to reads: a `StorageRequestError` thrown by `commit()` or `mintId()` fails the Harness like any other storage error ([#11014](https://github.com/earendil-works/pi/issues/11014)).
- The Node environment now detects the legacy WSL `bash.exe` launcher from `%SystemRoot%` instead of assuming `C:\Windows` ([#9501](https://github.com/earendil-works/pi/pull/9501) by [@petrroll](https://github.com/petrroll)).

## [1.3.0] - 2026-10-15

### Added

- `SqliteStorage.open(database, { prefix })` can namespace every table and index; `openNodeSqliteStorage()` and `openDurableObjectSqliteStorage()` forward it, for databases shared with host tables.

### Changed

- Cloudflare Durable Object SQLite adapters created for the same storage object now coordinate their operations, allowing multiple Pi storages to safely share one Durable Object database.

### Fixed

- The system baseline written after a compaction now leads the model context when the kept history includes an assistant message, as does a first baseline written after earlier answers, instead of following the new input; Anthropic and OpenAI Codex requests sent it as a mid-conversation system message without an initial prompt or tool set. Other system messages after an assistant message stay in place ([#10904](https://github.com/earendil-works/pi/issues/10904)).
- `toBase64`, used by `read` and the Photon image processor, no longer takes about 140 MB of heap to encode a 3 MiB image, which exceeded the 128 MB memory limit of a Cloudflare Durable Object; it now builds a binary string 8 KiB at a time and encodes it with `btoa` ([#10923](https://github.com/earendil-works/pi/issues/10923)).

## [1.2.0] - 2026-10-12

### Breaking Changes

- `ToolTaskInput` and `ToolTaskResult` are tagged unions: a model-issued call is `{ kind: "model", ... }` with its previous fields, a nested call `{ kind: "nested", ... }`. `pi.tool` is version 2 and migrates live version 1 tasks.
- `ToolExecutionResult.content` is now `output`, next to the new `structuredOutput`.
- `bash` and `powershell` answer a nonzero exit with an error result carrying an `exit_code` diagnostic, instead of throwing (`tool_error`).
- Any error a `Storage` method throws, a read included, now fails the Session, which closes itself: every later call and every pending wait rejects with `SessionFailed`, whose `cause` is that error, and nothing is retried. `StorageRejected` is removed; a storage retries its own transient failures and throws the new `StorageRequestError` for an invalid request, which fails only that call. A throw in the scheduler's own commits, or in the commit listeners of the Harness's components, fails the Session too.
- `subscribeCommits()` and `subscribeClose()` listeners that throw, or return a rejected promise, are reported through `onReport` instead of failing the operation that ran them.
- A display-only write submission, one of only `kind` and `data` (no `model`, `head`, or `edits`), is appended and settled `done` at once, even while the conversation is busy or has queued items, instead of waiting in `pi.inbox` for the next boundary; only a queued reset still holds it back, so the reset does not hide it. It changes nothing the model sees, so a chat message shows as soon as it is sent, ahead of earlier submissions still queued, and it no longer places items left queued after a failed run ([#10407](https://github.com/earendil-works/pi/issues/10407)).

### Added

- Optional `ExecutionEnv.listFiles(path, options, context)` for bounded, gitignore-aware tree listings (`ListFilesOptions`, `FileListing`, `FileListEntry`); `registerEnvConformance` takes a `listFiles` option to cover it.
- Input submissions take `entry: { kind, data }` (`InputEntry`): the input is placed as an entry of that kind carrying that data, with its content as the user message, instead of `pi.user`, and behaves as any other input; the kind must not start with `pi.`. Queued inputs carry it in their `pi.inbox` item ([#10407](https://github.com/earendil-works/pi/issues/10407)).
- `Session.closed` settles once the Session has closed, Storage included: `{ reason: "closed" }` after `close()`, or `{ reason: "failed", error }` after a storage error. `WatchEnd` gains `{ reason: "session_failed", error }`, and the README has an Errors section.
- `ToolExecutionApi.executeTool(name, args, context, { key?, progress? })`: a tool calls another tool as a nested call. The nested call is its own `pi.tool` task owned by the caller, runs validation, the `ToolTask` hooks (whose `ToolHookCall` carries `parent`), output limits, and its replay policy, and returns a `NestedToolExecutionResult` (its `taskId`, `structuredOutput`, `details`, `diagnostics`, `usage`, `isError`, `durationMs`, but not the model's `output`) to the caller instead of the transcript. Each nested call is a member of `NestedCallDoc`, a task-scoped document family of the caller keyed by the call's key, holding its `taskId` and, once it ends, its `result` as returned, so it is gone from storage once the caller settles; its task's receipt stays small. Keys, by default the call's position, let a replay-safe caller's rerun reattach to its nested calls; a caller that is not replay-safe has its unfinished nested calls abandoned after a restart. Nested calls show in `pi.live.nestedTools`, with the arguments they run with and a `summary` (error, duration, usage) once done (`progress: false` keeps their running output out), and as tool events with `parentToolCallId` and `parentTaskId`; every tool event also carries its call's `taskId`. A caller aborts the nested calls it left running before it settles.
- Structured tool output: a tool declares `structuredOutputSchema` and returns `structuredOutput`, which the Harness validates and gives to programs that call the tool; a tool without a schema gives them its bounded output, one text item as a string, one image as itself, and otherwise the content list, for errors too. `structuredOutput` is always the tool's own value: a schema tool's error result keeps the value it returned, and the text of one without becomes a `tool_error` diagnostic of the nested result, as a thrown error's message does. A nested call with invalid structured output gets an error result; a model-issued one only loses it, and the host gets a report. `api.retainedOutput()` reads the bounded output the model will see. `bash` and `powershell` return `{ output, truncated, fullOutputPath?, exitCode }`.
- `ToolRegistration.callers` (`model`, `tools`, or both, the default) and `pi.agent` `modelTools`: who may call a tool, and which of its tools a conversation offers the model; `Agent.callable` lists the tools nested calls resolve among. `addTools` also extends `modelTools`.
- Deferred tools: `ToolRegistration.deferred` keeps a tool from the model until `modelTools` names it, in its array or its new `add` (`{ remove?, add? }`); `control.addTools` writes names to `add`, and loaded tools follow the others in load order, so a load only appends declarations. `Agent.deferred` lists the deferred tools not loaded yet. `@earendil-works/pi-durable/tool-search` provides the coding agent's `tool_search` tool, which searches them with BM25 and loads the matches. The `codemode` section leaves deferred tools out.
- `TaskOptions.abandonOnRestart`: a task its creator awaits only in memory is aborted, with its owned work, when a later Harness starts scheduling, before any of it runs again. Its mark carries `abortReason: "restart"`, which cascades; such a task waits for a missing definition instead of becoming `orphaned`. Nested calls and `api.createTask()` children of tools that are not replay-safe get it by default. No task below an owner with cancellation intent starts a run phase any more, even before the cascade marks it.
- `TaskRuntime.abortOwned(id, context)`: abort a task this task owns and wait until it is terminal.
- `TaskRuntime.ownedTasks(context)`: the live tasks a task owns directly, whichever invocation created them, as copies. A tool call settling finds the nested calls it left running with it.
- `@earendil-works/pi-durable/codemode`: a `codemode` tool (`createCodemodeExtension({ sandbox })`) whose scripts call the conversation's tools as nested calls and survive a restart: the script is replayed deterministically from a journal of the results it got, written before each delivery, reattaching to its nested calls, and then continues. Divergence, a changed sandbox fingerprint or module version, and a passed deadline end the call with an error. As in the coding agent, a `codemode` prompt section lists the tools scripts can call (`namespaces`, an inline token budget), scripts find tools with `searchTools()`, `describeTool()`, and `describeNamespace()`, and the result is laid out with a header, text item markers, a console block, truncation to `max_output_tokens` with a spill file, and saved images. Scripts get `models.*` (the catalog, `models.classify()`, `models.generateImages()`; the last two as nested calls of internal tools, at most four at once), and the tool declares the Lark grammar of its source for models that support grammar-constrained sampling. A failed call rejects in the script with its text, except an error result of a schema tool with its own value, which resolves: `tools.bash` gives `{ output, exitCode, ... }` for a nonzero exit. Scripts keep `store()`/`load()` values per conversation, forked as of the fork's entry. The result's `details.calls` list the script's tool calls with their status; live progress is in `pi.live.nestedTools` (`npm run bench:codemode`).
- `read` returns images as one image block instead of an `unsupported_image` error: PNG, JPEG, GIF, and WebP within the model's image limits (by default 2000x2000 pixels and 4.5 MB of base64) as they are, or, with `createCodingTools({ images })`, oriented, converted, and shrunk to fit. `@earendil-works/pi-durable/images` provides a Photon (WebAssembly) image processor, with `/images/node` and `/images/cloudflare` loaders; `/images/node` prepares images in a worker thread, so a large photo never blocks the event loop, and the thread exits after 30 s without images; nothing loads it unless imported. A model without image input gets a diagnostic saying it sees a placeholder.
- `pi.live.compactionFailure` keeps the newest compaction failure (task, reason, error) until a compaction produces a summary; the agent events' snapshot carries it as `compactionFailure`, and `compaction_end` carries `error` for a compaction that failed. A failed background or manual compaction was invisible once its status was removed.

### Fixed

- A wait that closes a cycle through waits and held owners is rejected by `runtime.commit()`, naming the cycle, instead of leaving every task on it waiting forever; waiting on itself or on an owner chain were the only cycles caught. A background task may now wait on the owner of its conversation, which is no cycle ([#10411](https://github.com/earendil-works/pi/issues/10411); tests and approach from [#10533](https://github.com/earendil-works/pi/pull/10533) by [@odysseus0](https://github.com/odysseus0))
- Appending to an array in a document no longer costs a walk over the whole array per commit: Chord's delta tracker plans inserts and removals that keep the remaining elements in order from the changed ranges alone, and builds an appended array in one copy instead of two. 32,000 one-item appends, one commit each, take 1.4 s instead of 11.3 s; what remains is the copy each immutable value needs (`npm run bench:document-append`).
- A generation whose blocking threshold compaction failed, faulted, was orphaned, or was aborted directly now fails with `model_error` (`Compaction failed: <error>`) instead of sending its request anyway. The context was still above the blocking threshold, so the request at best left no room for the answer: a session at 996K of a 1M window got an empty `length` answer on every turn, with no visible error.

- Compaction no longer includes thinking in the summarization request. Replayed thinking is often not in the live context, so a request that included it could be larger than the context it summarized and fail with "prompt is too long" on every attempt.
- A throwing `onReport` no longer replaces the error being reported or becomes an unhandled rejection, a throwing `now()` is reported once and `Date.now` used, and a watch listener's error is reported as well as ending the watch with `listener_error`.
- A task whose fault write failed no longer runs again in the same process.
- The scheduler no longer visits every live task on each pass: abort cascades start only from tasks with cancellation intent, owned live work and idle scopes are walks down an in-memory ownership index, and reservation, finalization, and failFast checks keep their own candidate sets. A chain of 500 owned tasks that took 12 s to settle takes 50 ms, 20,000 take 1.5 s; a tool making 8000 parallel nested calls finishes in 2.7 s instead of 18.8 s, with one document per nested call instead of one growing index (`npm run bench:scheduler-fanout`).
- The scheduler's ownership indexes are bounded by live work: it keeps a conversation's owner and an ended task's ownership only while live work is below them, instead of every conversation and subagent chain it ever saw. Work that later appears in an old conversation loads its chain from storage again. After 10,000 ended subagent calls under a live parent it kept 10,000 ended tasks and 10,001 conversation edges; now none of either beyond the parent's conversation (`npm run bench:scheduler-memory`). A queued input no longer makes the scheduler scan every queued submission when nothing is being cancelled.
- The Session's document cache is bounded by use: a loaded document that no watch or document state observes leaves memory once it was not read or written for `documentRetentionMs` (new in `HarnessSettings` and `createSession()` options; default ten minutes, `0` drops it right after use) and loads from Storage again on its next access. It held every conversation and session document ever touched, built-in and third-party, for the life of the process: 5,000 conversations kept 26,000 documents and about 3.8 KB each; with retention 0 they keep none (`npm run bench:document-cache`).

## [1.1.0] - 2026-10-07

### Breaking Changes

- `Storage` implementations must honor the new `order` field of `ConversationQuery`, `EntryQuery`, `TaskQuery`, and `SubmissionQuery`, and continue a cursor in the order it was returned with. A storage that ignores it returns pages in the wrong direction; the conformance suite covers both orders ([#10546](https://github.com/earendil-works/pi/issues/10546)).
- `TaskRuntime.context()` takes the cutoff as an options object, matching `Conversation.context()`: `runtime.context(conversationId, context, { at })` replaces `runtime.context(conversationId, context, at)`.

### Added

- `ToolExecutionApi.models` and `HookApi.models`: the Harness's `models`, so tools and hooks can resolve models and make requests with the same catalog, credentials, and request transforms as generation ([#10395](https://github.com/earendil-works/pi/issues/10395)).
- `Conversation.context(context, { at })` returns the model context as of a visible earlier entry, the same view `fork(at)` would start with, without creating a conversation ([#10512](https://github.com/earendil-works/pi/issues/10512)).
- `ScanOrder` (`ascending` or `descending`) as `order` on conversation, entry, task, and submission scans, including `Tx.scanTasks()` and `Conversation.entries()`, so hosts can page the newest tasks first. Defaults are unchanged: entries newest first, everything else oldest first. A cursor continues in its scan's order, so the query may omit `order`; asking for the other order with it throws ([#10546](https://github.com/earendil-works/pi/issues/10546)).
- Task records carry `startedAt` and `endedAt`, wall-clock times the Session stamps at the first change to `running` and at the change to `terminal`, with `HarnessOptions.now` or the new `createSession(storage, { now })` option. `startedAt` survives waits and reopen. `inspect()` shows them on each live task's record. Records written by earlier versions have neither ([#10549](https://github.com/earendil-works/pi/issues/10549)).
- `pi.tool-result` messages carry `durationMs`: how long `execute()` took in that attempt, measured with a monotonic clock. Calls that did not execute, and interrupted or aborted calls, have none ([#10549](https://github.com/earendil-works/pi/issues/10549)).
- Assistant messages carry the `durationMs` pi-ai measures for each response ([#10549](https://github.com/earendil-works/pi/issues/10549)).
- `openDurableObjectSqliteStorage(ctx.storage)` in `@earendil-works/pi-durable/storage/sqlite/cloudflare`: SQLite storage on a SQLite-backed Cloudflare Durable Object.
- `settings.contextRetentionMs` (default ten minutes): how long an idle conversation keeps its last context read in memory; `0` drops it once idle.

### Changed

- `runtime.context()` keeps each conversation's last read range and derived view in memory: a later read by any of its tasks with the same head marker scans and derives only the entries committed since. A generation no longer rereads and re-derives the whole transcript for each model request. Busy conversations keep it; idle ones for `settings.contextRetentionMs`.

### Fixed

- A conversation's first system message, and the baseline after a compaction or reset, now leads the model context instead of following the input that started the run. Providers with native mid-conversation tool changes, such as Anthropic, keep the prompt cache across later tool changes instead of rewriting it in full ([#10542](https://github.com/earendil-works/pi/issues/10542)).

## [1.0.4] - 2026-10-05

### Breaking Changes

- `NodeExecutionEnv.watch()` fails with `permission_denied` when a target, or a watched directory itself, cannot be read for lack of permission; before, it was watched as if missing. Later rescans that hit this report `{ error }` with `permission_denied` instead of `invalid`.
- The env conformance suite checks three more `watch()` behaviors: changes to the file a watched symbolic link points to, recursive coverage below a target that a non-recursive target overlaps, and a directory replaced at the same path. Custom environments that passed the 1.0.3 suite may need changes.

### Added

- `createPowerShellTool()` in `@earendil-works/pi-durable/tools`: a `powershell` tool that runs `pwsh`, else Windows PowerShell, directly through argv `exec` (no other shell parses the command), with UTF-8 output and the `bash` tool's output window, spill and errors.

### Fixed

- The `read` tool reads a file that grows while it is read (an active log) instead of failing with "changed while it was read"; it reads again only when the file shrank or was rewritten in place.
- `NodeExecutionEnv.watch()`: a directory replaced at the same path gets a new native watcher; a target that is a symbolic link to a file reports changes to that file; a non-recursive target no longer stops an overlapping recursive target from covering subdirectories; closing during a rescan no longer leaks watchers.
- Bounded tool output keeps a U+FEFF at the start of the retained tail, and drops a byte-order mark only at the very start of byte output.
- `settings.progress` fields given as `undefined` keep their defaults.

## [1.0.3] - 2026-10-05

### Breaking Changes

- `FileSystem` requires `openBinaryReader()` and `openDirReader()`; custom environments must implement them.
- `BinaryReader` requires `scanLines()`.
- `FileSystem` requires `watch()`.
- `Shell.exec()` accepts an argv array besides a shell string, and `ShellExecOptions.onOutput` receives a third `info` argument naming the stream (`stdout` or `stderr`); custom environments must accept both forms and pass the stream.

### Added

- `openBinaryReader()` for bounded positional reads of one opened regular file, with `noFollow` to refuse a final-component symlink.
- `openDirReader()` for paged directory listings that read metadata only for returned entries.
- Argv form of `exec()`, which runs a program without a shell.
- `createEnvConformance()` and `registerEnvConformance()` in `@earendil-works/pi-durable/testing` for checking custom `ExecutionEnv` implementations.
- `settings.progress` with `partialIntervalMs` and `outputIntervalMs` configures how often generation partials and running tool output are committed; defaults stay 100 ms ([#10357](https://github.com/earendil-works/pi/issues/10357))
- `ShellExecOptions.window` and `ShellOutputInfo.skipped`: an environment may omit shell output outside the caller's retained tail and report the omission, so remote environments need not transfer output the caller drops. `ToolExecutionApi.outputWindow` provides the window and `output(chunk, skipped)` counts omissions; the `bash` tool passes them through.
- `BinaryReader.scanLines()` locates and measures a span of lines in one pass inside the environment; `LineScanner`, `StreamDecoder`, `rangeDecoder()` and `startsWithBom()` in `@earendil-works/pi-durable/env` let other environments decode and scan exactly like `NodeExecutionEnv`.
- `FileSystem.watch()` reports changes to files and directories, recursive with excludes, including missing targets, with explicit `overflow` and `error` and a `native` or `polling` mode. `NodeExecutionEnv` polls on Windows (native watchers there keep directories open, which blocks renaming their parents) and on network and FUSE file systems, and on macOS rescans shortly after installing native watchers because FSEvents misses changes made right after `fs.watch` returns; its `watch` option sets the mode, poll interval, and directory limit.

### Changed

- The `read` tool reads only the file's header, one scan, and the lines it shows, instead of loading the whole file; its results are unchanged.

### Fixed

- `NodeExecutionEnv.flushFile()` on a directory fails with `is_directory` on Windows, as on POSIX.
- Tail-retained tool output no longer depends on when progress commits happened: a progress snapshot compacted the stored output to the kept window, which could move where a later window's first line started.
- `NodeExecutionEnv` shell output and text line readers no longer drop a U+FEFF that follows a chunk boundary; Node's streaming `TextDecoder` with BOM handling dropped it, unlike decoding all of the bytes at once.

## [1.0.2] - 2026-10-04

### Fixed

- Persisted a distinct provider session UUID per conversation and forwarded it for prompt-cache and session affinity ([#10424](https://github.com/earendil-works/pi/issues/10424))

## [1.0.1] - 2026-10-03

## [1.0.0] - 2026-10-01

### Added

- Initial release of `@earendil-works/pi-durable`, a durable agent harness. See the [README](README.md) and the [design document](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md).
