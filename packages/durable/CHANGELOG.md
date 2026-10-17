# Changelog

## [Unreleased]

### Added

- `settings.compaction.modelOverrides` sets compaction thresholds per model, keyed by exact `"provider/modelId"`, so one harness can serve small- and large-window models; the threshold check, overflow recovery, and the compaction task use the entry of the model they act for ([#10942](https://github.com/earendil-works/pi/issues/10942)).
- `HarnessOptions.models` and `HarnessOptions.settings` also accept a function returning the current value, like `env`. Generation, compaction, hooks and tools call it at each use (`api.models` reads the current value at each access), so a host can replace its model configuration or settings without reopening the Harness. A plain object still works.
- `HarnessOptions.timer` replaces the native timer behind `TaskRuntime.sleep()`, so a host can wait for retry backoffs, deferred polls, and custom task deadlines with alarms or delayed queue delivery instead of keeping long in-memory timers. A sleep rejects at once when cancelled, even if the timer ignores the cancellation.

### Changed

- `ToolControl.terminate` is now typed `boolean` instead of `true`, matching `pi-agent-core` and `pi-coding-agent`; `false` does not end the run ([#10858](https://github.com/earendil-works/pi/issues/10858)).

### Fixed

- The README's Errors section now limits the `StorageRequestError` exemption to reads: a `StorageRequestError` thrown by `commit()` or `mintId()` fails the Harness like any other storage error ([#11014](https://github.com/earendil-works/pi/issues/11014)).

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
