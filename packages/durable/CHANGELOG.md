# Changelog

## [Unreleased]

### Breaking Changes

- `TaskRuntime` now requires `env`, `hooks`, `getTask()`, `waitForTask()`, and `entry()`; `ToolExecutionApi` requires `env` and `diagnostic()` and no longer declares `conversation()` until owned-conversation handles land.
- `createRegistry()` also pre-registers the built-in `pi.tool` and `pi.post-tools` tasks.
- `ToolResultEntry` now carries `data: { diagnostics }`.
- `Tx` now requires `placeSubmission()` and `latestHeadMarker()`.
- Busy submissions no longer reject with `ConversationBusy`: they queue in the conversation's `pi.inbox`, except input with `whenBusy: "reject"`.
- The built-in `pi` setup now also creates `pi.inbox` and `pi.usage` in every Harness conversation.
- The environment shell no longer keeps a bounded, throttled output view: `ShellExecOptions.capture` and `onUpdate` are replaced by raw `onOutput` chunks and `spill: { afterBytes, afterLines }`, `ShellExecResult` is `{ exitCode, spillPath? }`, and `ExecutionError.spillPath` reports the spill of a timed-out or aborted command.

### Added

- Added the tool chain: generation offers active registered tools through positional system entries, answers calls to tools it did not offer with `tool_unavailable`, and hands the run to parallel or sequential `pi.tool` tasks and a `pi.post-tools` task that applies `addTools` and `terminate` and continues with the next generation.
- Added the `pi.tool` task: argument validation before and after `beforeTool`, durable intent with the replay policy, recovery that reruns only replay-safe tools, bounded `output()` and `details()` progress in `pi.live.tools` slots with adaptive throttling, output and details fallback, `afterTool`, and results with a rendered `<harness>` diagnostics block.
- Added tool diagnostics: `api.diagnostic()`, `ToolExecutionResult.diagnostics`, and Harness diagnostics for truncation and error results.
- Added hook dispatch with conversation and owned-subtree scopes: `beforeRequest`, `afterResponse`, and `onYield` continuations on generation, `beforeTool` and `afterTool` on tools, and `afterTools` on post-tools, with `HookApi` memos.
- Added `HarnessOptions.env`, `ToolRegistration.executionMode`, and the `toolExecution` configuration with `get/setToolExecution()`.
- Added `read`, `bash`, `edit`, and `write` tools in `@earendil-works/pi-durable/tools`; they use `api.env`. Bash streams raw output into `api.output()`, reports its spill file as a diagnostic, and throws on a nonzero exit or timeout. Reading images is not supported yet.
- Added `ToolRegistration.prepareArguments()` to repair malformed arguments before validation; the edit tool uses it for `edits` sent as a JSON string or a single object and for top-level `oldText`/`newText`.
- Tool output retained by `api.output()` is an exact slice of whole lines, sanitized of control characters.
- Added the `bench:tool-output` benchmark of tool output rates, retention, backends, replay, and 1 GiB throughput.
- Added the inbox: busy steer and follow-up inputs and passive writes queue in the `pi.inbox` document (`InboxDoc`) and are placed at post-tools and final boundaries, writes before user items, by the new `steeringMode` and `followUpMode` configuration with `get/set` accessors. Withdrawal removes the item; stale head writes settle `unanswered`; queued items survive a failed run until the next submission.
- Added `Conversation.reset(handoff)` and the post-tools `handoff` control, which write the headed `pi.reset` entry (`ResetEntry`); a reset queued during a tool round ends the run.
- `onYield` continuations now apply only when the final boundary places no queued user input and no reset.
- A generation that faults or is orphaned now converts its committed partial into an aborted assistant entry, which counts in `pi.usage`, instead of discarding it.
- Added the `pi.usage` ledger (`UsageDoc`) of assistant usage per model and tool usage per tool, `ToolExecutionResult.usage`, and `Harness.usage()` for the Session total.
- Added the structural `ConversationView` with `Conversation.viewState()` and `Conversation.watch()`.
- Added the experimental `watchEvents()` agent event adapter with snapshot events, translated message and tool deltas, and overflow to a snapshot.

### Fixed

- Avoided loading TypeBox through the package root's generation retry helpers and switched examples to narrow pi-ai model and faux-provider imports.

## [0.99.1] - 2026-09-29

## [0.99.0] - 2026-09-29

### Breaking Changes

- Reordered Storage scan arguments so the limit precedes the cursor.
- Added the required conversation-visible `Storage.entry(conversationId, id, context)` overload.
- Split `Tx.createConversation()` from `Tx.forkConversation()`, replaced raw conversation-record input, and require explicit ownerless or task ownership.
- Replaced untyped numeric record IDs and the `TaskRef` wrapper with erased branded numeric ID types, including result-typed `TaskId<R>`, separately branded commit sequences, and generic `Storage.mintId()`.
- Made task conversation membership immutable after task creation.
- Added `ConversationQuery` to Storage and transaction conversation scans.
- Added required `StoredDocument.deltasSinceBase` to Storage document reads.
- Task definitions now require an exhaustive `phases` map and an `abort` handler; define them with `defineTask()`.
- `RegistryReader` now requires `subscribe()`.
- Removed `Tx.setTask()`; a task changes its own state by returning the next state from its `runtime.commit()` callback.
- `Session.subscribeClose()` listeners now run synchronously when close begins, after admission is sealed.
- `defineEntry<D>()` now takes the entry's `data` type instead of a record type; `Entry<D>.is()` narrows to `TypedEntry<D>`.
- Added the required `Storage.scanSubmissions()` scan of submissions by conversation and status.
- `createRegistry()` now pre-registers the built-in `pi.generation` task and `pi` conversation setup, which cannot be disposed or replaced, and `Harness.open()` rejects a registry whose snapshot lacks either.
- `RegistrySnapshot` now requires `conversationSetups()`.
- `Tx` now requires `settleSubmission()`.

### Added

- Added transactional Sessions with typed durable documents, task creation, snapshots, retirement, and commit publications.
- Added document checkpoint selection, lazy version migration, and `Session.snapshotAsOf()` for rewindable conversation documents.
- Added policy-driven backend-side conversation document copying when creating forks.
- Added indexed conversation ownership queries and guaranteed no-effect Storage rejection handling.
- Added the JSONL storage backend (`@earendil-works/pi-durable/storage/jsonl`, and `openNodeJsonlStorage()` from `@earendil-works/pi-durable/storage/jsonl/node`), including sidecar reclamation.
- Added the execution environment (`@earendil-works/pi-durable/env`, and `NodeExecutionEnv` from `@earendil-works/pi-durable/env/node`) for file access and shell execution with bounded output capture and truncation.
- Added the `@earendil-works/pi-durable/testing` export with the scoped storage conformance suite (`createStorageConformance()`, `registerStorageConformance()`) and storage benchmark workloads ([#9977](https://github.com/earendil-works/pi/pull/9977) by [@christianklotz](https://github.com/christianklotz)).
- Added incarnation-bound read-only Chord document states and serialized asynchronous document watches with bounded exact-frame buffering.
- Added `deltasSinceBase` checkpoint predicate information so definitions can bound replay without value counters.
- Added `Harness.open()` with lazy root creation, atomic conversation creation and forks with `init`, conversation-bound commits, fork-aware entry pagination, model context derivation, and the built-in `ConversationConfig` document with model, thinking level, and active tool accessors.
- Added `createRegistry()` for tools, tool wrappers, hooks, tasks, and system prompt sections with batched publication and stable keyed ordering.
- Added `defineEntry()` typed entry kinds.
- Added the durable task runtime: `defineTask()`, registry-resolved phase handlers with checkpoint progress rules decided on the Session line, migration at reservation, typed runtime commits, memos, `sleep()`, and invocation-owned watches, plus `Harness.resume()`, `getTask()`, `waitForTask()`, `abortTask()`, and task-aware `waitForIdle()` on the Harness and conversations. Open reconciles running tasks to pending; tasks without a fitting definition stay blocked until registration, and aborting them settles them as `orphaned`.
- Added the first runnable chat turn: `Conversation.submit()` with request-ID deduplication, `Submission` handles (`status()`, `wait()`, `abort()`), `Harness.submission()`, `Harness.abortSubmission()`, and `ConversationBusy` for submissions to a busy conversation.
- Added the built-in `pi.generation` task: positional system prompt preparation from registered sections (tags, wrappers, failures, minimal patches, order rewrites, and head-cut rebaselines), model requests through `Models`, durable throttled partials in the `pi.live` document (`LiveDoc`), retries with backoff, deferred-response polling and cancellation, and aborted-partial conversion.
- Added `Tx.settleSubmission()`, which run tasks use to settle the inputs they answer.
- Added built-in entry tokens `UserEntry`, `AssistantEntry`, `SystemEntry`, and `ToolResultEntry`, and token-first `tx.entry()` and `tx.appendEntry()` overloads.
- Added `streamOptions` and `retry` to `ConversationConfig` with `get/setStreamOptions()` and `get/setRetryPolicy()` on conversations.
- Added `snapshot()`, `snapshotAsOf()`, `context()`, `now()`, and `report()` to `TaskRuntime`.
- Added `Harness.inspect()`: live tasks with their derived scheduler state (running, ready, waiting, or blocked with its reason), queued and placed submissions, and registry wrapper failures.
- Entries appended by a task's runtime commits now record the task as `byTaskId`.
- Added `registry.conversations.setup()`: setups run in every Harness commit that creates or forks a conversation, including raw `Tx.createConversation()` and `Tx.forkConversation()`, before host `init`. The built-in `pi` setup runs first and stages the default configuration with every registered tool active (forks keep their copied configuration) and an empty `pi.live`.
- `Conversation.submit()`, `Submission.wait()`, `waitForTask()`, and `waitForIdle()` now enable task scheduling, so they never wait on a Harness whose `resume()` was not called.
- Scheduler-written `faulted` and `orphaned` outcomes of a run task now settle the run's input submissions `unanswered` and clear its run control in the same commit.

### Fixed

- Fixed cached documents skipping migration when accessed with a newer definition version, and older definitions reading values migrated only in memory. Document states and watches hydrated under another definition version receive the new value as a root replacement.

## [0.87.1] - 2026-09-22

## [0.87.0] - 2026-09-21

## [0.86.1] - 2026-09-20

## [0.86.0] - 2026-09-19

### Added

- Added the initial Pico durable record contracts and detached in-memory storage implementation.
