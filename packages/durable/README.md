# @earendil-works/pi-durable

> **Experimental.** The API changes without notice between releases.

A durable agent harness. Conversations, model turns, tool calls, and your own state are committed to storage before anything is shown. If the process dies mid-turn, reopening the storage picks the work up where it stopped; a model request it died during counts as a failed attempt and is retried, so a request that keeps killing the process ends (see [Persist and Resume](#persist-and-resume)).

Built on [`@earendil-works/pi-ai`](../ai/README.md) for model access and `@earendil-works/chord` for document state.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Concepts](#concepts)
- [Persist and Resume](#persist-and-resume)
- [Extensions](#extensions)
- [Tools](#tools)
- [Code Mode](#code-mode)
- [System Prompt](#system-prompt)
- [Per-Conversation Agent](#per-conversation-agent)
- [Settings](#settings)
- [Environment](#environment)
- [Reload](#reload)
- [Watching a Conversation](#watching-a-conversation)
- [Busy Conversations](#busy-conversations)
- [Reset and Handoff](#reset-and-handoff)
- [Compaction](#compaction)
- [Agent Events (Experimental)](#agent-events-experimental)
- [Hooks](#hooks)
- [More Conversations and Forks](#more-conversations-and-forks)
- [Abort and Subagents](#abort-and-subagents)
- [Child Tasks](#child-tasks)
- [Task Graph](#task-graph)
- [Your Own State](#your-own-state)
- [Usage and Cost](#usage-and-cost)
- [Storage](#storage)
- [Errors](#errors)
- [Examples](#examples)
- [Design Documents](#design-documents)

## Installation

```bash
npm install @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
```

## Quick Start

```typescript
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

const models = createModels();
models.setProvider(openaiProvider()); // reads OPENAI_API_KEY

const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
const root = await harness.root(context, { agent: { model: { provider: "openai", modelId: "gpt-6-sol" } } });

const submission = await root.submit({ type: "input", content: "What is the capital of France?" }, context);
const settled = await submission.wait(context);
if (settled.status === "done" && settled.type === "input") {
	const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	console.log(answer?.model?.[0]);
}
await harness.close(context);
```

What happened:

- `Harness.open()` opens a Session over a storage backend. `MemoryStorage` keeps everything in memory.
- `root()` returns the root conversation, creating it on first use with the given agent choices. A conversation is a transcript of immutable entries.
- `submit()` durably admits your input and returns a `Submission`. A built-in generation task calls the model and appends the answer.
- `wait()` resolves once the input is answered (`done`) or has failed (`unanswered`, with a reason).

Every async call takes a Chord `Context`, which carries cancellation and its current `TelemetrySpan`. `BACKGROUND_CONTEXT` never cancels and uses a NOOP span. The Harness owns the root adapter; adapters are never stored in a `Context`. Cancelling a wait only cancels that wait, never the work.

`HarnessOptions.identity` sets how model requests identify the app to providers (a pi-ai `ClientIdentity`), merged over `DEFAULT_HARNESS_IDENTITY` (`{ attribution: PI_ATTRIBUTION }`: OpenRouter, NVIDIA NIM, and OpenCode attribution headers name pi). It applies to generation, compaction, hooks, and tools, over the identity the host's `Models` was created with. Pass your app's attribution, for example `{ attribution: { name: "my-app", url: "https://my-app.example" } }`, or `{ attribution: null }` to send none.

`HarnessOptions.telemetry` accepts a host-owned `TelemetryContext` from `@earendil-works/pi-telemetry`, with optional `propagation` and `metrics` capabilities; omitted, it is a no-op. `DURABLE_TELEMETRY_SCHEMA`, exported from the package root, documents its typed spans, events, and metrics. Attributes contain IDs and control metadata, never messages, arguments, or results; IDs point to the transcript.

- `pi.durable.submit` covers the public submit call and its commit; for `submit(tx, draft)` it covers the admission only, its `result` is provisional until your commit is stored, and the commit's events go to your commit's context. Each input starts a new root trace with a link to its caller's current span; a write is a child of its caller. Duplicate `requestId` preserves the original submission and carrier. Internal admissions, such as compaction writes, emit events on their phase span without a submit span.
- `pi.durable.phase` covers one run or abort phase of every task, including its decision commit, never the next phase, a durable wait, or a restart. Its attributes identify the task, phase, attempt when present, `resumed`, and outcome. Tool phases also identify the tool and call. Nested tasks and background compactions inherit the creating phase; model requests receive that phase context. Hooks add no spans.
- Failed phase outcomes set error status with a fixed category (`task_faulted`, `task_failed`, or `task_orphaned`) and the outcome's diagnostic message, truncated to 500 characters (the reason for an orphaned task). Diagnostics can contain caller content; no error detail or exception name is recorded. An `aborted` outcome keeps status `ok`, including interruption by close or cancellation.
- Every `onReport` report also emits a `pi.durable.report` event on its current span. Without a span, the NOOP span drops the event; no root report span is created. Only `type` (the report's `kind`), optional fixed `reason`, `extension`, and `task.id` are recorded; no error payload is included. `pi.durable.reports` counts all reports by `type` only, including those without a span. Clock failures report without a phase context. The `onReport` callback is unchanged.
- Committed entries and settled submissions emit `pi.durable.entry` and `pi.durable.submission`. Committed running phase changes emit `pi.durable.checkpoint`; a nested call answered from its stored result emits `pi.durable.replay`.
- Propagation stores optional opaque `trace` carriers in submission and task JSON without a storage migration. Phase spans extract their task's stored carrier, or start at the adapter root when absent or unknown. `TaskOptions.trace` inherits the creator's carrier when absent, accepts an explicit carrier override, or uses `"root"` to start at the adapter root without storing a carrier. A run started for several queued inputs takes the first input's trace; its first invocation's phase spans link to the other inputs through immutable task `links`. A steer stays in the running trace and its submit span links to that run's stored carrier. A reopened task's first invocation has `resumed: true` in the same trace.
- Metrics record `pi.durable.phase.duration` (milliseconds; task, phase, outcome) and `pi.durable.tasks.active` (live tasks; task name), without record IDs. Closing the Harness releases its active counts.

## Concepts

- **Harness**: one open storage plus the machinery that runs agents on it. All changes go through one line of atomic commits, and nothing is shown before its commit is stored.
- **Conversation**: a transcript. `root()` creates the root conversation on first use; you can create more and fork them. A `Conversation` handle holds no state; compare handles by `id`.
- **Entry**: one immutable transcript record, such as a user message (`pi.user`), a model response (`pi.assistant`), a tool result (`pi.tool-result`), a system prompt change (`pi.system`), a reset (`pi.reset`), or your own kind. The model sees the entries from the newest reset onward.
- **Commit**: an atomic write. `conversation.commit((tx) => ...)` can append entries, edit documents, and create tasks together; either all of it is stored or none of it.
- **Document**: typed JSON state stored next to the transcript and changed in commits. Built-in ones hold each conversation's agent choices (`pi.agent`), provider-facing session identity (`pi.provider`), running generation and tools (`pi.live`), queued submissions (`pi.inbox`), and spend (`pi.usage`).
- **Task**: a durable state machine that saves a checkpoint at every step, so a restarted process continues from the last one. Every task has an owner: its conversation, or another task. The Harness runs answers as built-in tasks: `pi.generation` calls the model and owns the `pi.tool` tasks of its tool calls, waits for them, and hands the run to the next generation.
- **Submission**: something you hand to a conversation, either user input or an entry to write, which you can wait for.
- **Turn and run**: a turn is one model response and its tool calls; a run is the turns from an input to its final answer. A conversation is busy while a run is going.
- **Extension**: a named bundle of tools, system prompt sections, hooks, wrappers, and tasks.
- **Registry**: the extensions this process installed. It can change while the Harness runs; new work uses the new state.
- **Agent**: what a conversation runs with: model, thinking level, selected extensions, tools, instructions, and working directory. Stored per conversation as names in `pi.agent`, resolved against the registry at each use.

One answered input, as entries and tasks:

```text
submit(input) → pi.user
  pi.generation → pi.system (only if the prompt or tools changed), pi.assistant (tool calls)
    pi.tool × n → pi.tool-result × n   (owned by the generation, which waits for them)
  pi.generation → pi.assistant (answer) → submission done
```

## Persist and Resume

Use SQLite or JSONL storage to keep conversations across restarts:

```typescript
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const harness = await Harness.open(await openNodeSqliteStorage("./session.sqlite"), { models, registry }, context);
const root = await harness.root(context); // the same root as last time
harness.resume(); // continue any run the last process left unfinished
```

Work interrupted by a crash or close stays pending. `resume()` starts the task scheduler; submitting or waiting starts it too. A process that only shows a session another one drives opens it with `readOnly: true`: open recovers nothing, and every write, `resume()`, and every call that would run tasks rejects with `ReadOnlySession`. Each conversation has its own persisted UUIDv7 in `pi.provider`, forwarded to pi-ai as `sessionId` for provider prompt-cache and session affinity. It survives reopen, retries, reset, compaction, and model changes; a child or fork receives a fresh identity. A legacy conversation receives and persists one before its first generation or compaction request.

A retried submission with the same `requestId` returns the existing submission instead of submitting twice:

```typescript
const submission = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// After a restart: the same request ID finds the same submission.
const again = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// again.id === submission.id
```

`harness.submission(id)` reacquires a submission by ID, for example to wait for it after a restart.

### Sleeping and Waking Up

A task waits for time by ending its phase asleep. The sleep is stored, so the task holds no invocation meanwhile, survives restarts, and resumes at the checkpoint once the Harness clock reaches `until`:

```typescript
const Reminder = defineTask<{ text: string; at: number }, { phase: "wait" } | { phase: "deliver" }, null>({
	name: "app.reminder",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		// Resolves once the sleep is stored; the phase ends there.
		wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: "deliver" }, context),
		deliver: async (task, runtime, context) => {
			await notify(task.input.text);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
```

There is no sleep in the middle of a phase: a phase reruns from its top after a restart, so work after the wait goes in the next phase, and what it needs goes in the checkpoint. `{ status: "sleeping", until, checkpoint }` returned from `runtime.commit()` is the same sleep, committed together with other writes. Retry backoffs and deferred-response polls of the built-in tasks sleep the same way.

The timers of the Session, the scheduler, and its tasks go through `setTimer` (default `setTimeout`), and their times through `now` (default `Date.now`); pass both to run a Harness on a fake clock. The Node.js environment, file watcher, and image worker keep their own timers. Sleep deadlines are stored on `now`, so every process that opens one storage must use the same clock. While scheduling runs, a timer resumes sleeping tasks when they are due and keeps a Node.js process alive meanwhile.

A host whose process can be evicted, such as a Cloudflare Durable Object, wakes it itself. With `onWake`, the Harness arms no timer for sleeps; it tells the host what `harness.wake()` says whenever that changes: `active` while some task can run now or is running, and `at`, the earliest sleep. The host keeps its alarm armed and calls `resume()` when it fires:

```typescript
export class Session extends DurableObject<Env> {
	#harness!: Harness;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			// A fallback before anything can throw: an object whose open or recovery fails is started again.
			const fallback = Date.now() + 60_000;
			const current = await ctx.storage.getAlarm();
			if (current === null || current > fallback) await ctx.storage.setAlarm(fallback);
			const storage = await openDurableObjectSqliteStorage(ctx.storage);
			const onWake = (wake: Wake) =>
				// A failed alarm write resets the object; it arms again when it next starts.
				void this.#arm(wake).catch(() => ctx.abort("Alarm write failed"));
			this.#harness = await Harness.open(storage, { models, registry, onWake }, context);
			// Armed before `resume()` runs anything, as for any call that can start work.
			await this.#arm(this.#harness.wake());
			this.#harness.resume(); // work a lost instance left, and due sleeps
		});
	}

	override async alarm(): Promise<void> {
		await this.#arm({ ...this.#harness.wake(), active: true });
		this.#harness.resume(); // due sleeps and work a lost instance left
	}

	// Arm before any call that can start work (submit, compact, abortTask, abort, a registry change): `onWake` runs
	// after the commit. An early alarm is harmless, a missing one strands the work.
	async submit(conversation: Conversation, input: string, requestId: string): Promise<void> {
		await this.#arm({ ...this.#harness.wake(), active: true });
		await conversation.submit({ type: "input", content: input, requestId }, context);
	}

	async #arm(wake: Wake): Promise<void> {
		// A recovery heartbeat while work runs, never later than the earliest sleep.
		const heartbeat = wake.active ? Date.now() + 60_000 : undefined;
		const at = heartbeat === undefined || wake.at === undefined ? (heartbeat ?? wake.at) : Math.min(heartbeat, wake.at);
		if (at === undefined) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(at);
	}
}
```

The default `setTimer` declines the timers that only free memory in Workers, so no pending timer keeps the object from hibernating or being evicted; memory is then freed at later commits.

### Failures and Recovery

**Crash loops.** Work that deterministically crashes its process, by exhausting memory or CPU before its next checkpoint, would otherwise be resumed and crash again forever. A model request the host died during is a failed attempt under `settings.retry`: its partial answer is kept as an aborted entry, the next attempt waits for the backoff (shown in `docs["pi.live"].generation.retry`), and with no retry left the run ends with `docs["pi.live"].runFailure` reason `interrupted`. A deferred response that was being fetched is polled again as the next attempt, not requested again, and cancelled when the run ends. A close is not a crash: a request it stopped is sent again. Other work is counted: open counts each task a crash, eviction, or reset cut off, and a new state the task commits starts the count over. Once the count reaches `settings.restartLimit` (default 5; `Infinity` never ends a task for it), the task ends instead of running again: a tool call with an error result (diagnostic code `restart_limit`), a compaction failed into `compactionFailure`, a run with `runFailure` reason `restart_limit` (also when charging an interrupted request keeps crashing), and a task of your own kinds `faulted`, reported as `task_faulted` with reason `restart_limit`. The built-in ones are reported as `task_interrupted`, as is a run that ends `interrupted`, so a crash loop always reaches `onReport`. Every task running when a process dies is counted, not only the one that killed it. An abort handler cut off that many times ends its task `faulted` too; a run someone aborted still ends `aborted`, with the cut-off in `detail`.

**Reports.** `onReport(report)` gets one `Report`: the `error` and what happened in `report.kind`: `storage_failed` for the error that failed the Harness (a Storage error, often a platform reset); `task_faulted`, `task_interrupted` (crashes ended it, with `report.reason` and `report.restarts`), `migration_failed`, `task_outdated` (`reason` `missing_task`, `task_too_old`, or `migration_failed`, the words a blocked task shows), or `task_error` for a task, with `report.task` (its `id`, `kind`, and `conversationId`) and the extension that installed it in `report.extension`; `extension_error` for hooks, sections, wrappers, and tools, with the extension's name; `host_error` for a host callback, named in `report.callback`; and `listener_error`. A host can feed `task_faulted` reports of one kind to its own breaker.

**Queued inputs after a failed run.** A run that fails with a model error, a missing model, nothing to answer, its turn limit, or crashes (`interrupted`, `restart_limit`) leaves the inputs queued behind it waiting until the next input arrives. `settings.afterFailedRun` changes that: `continue` starts the next run with them, as after an answer, and `withdraw` settles them `unanswered` with reason `run_failed`.

**Blocked tasks.** Tasks blocked on a missing or unmigratable definition show their reason in the task graph too, and a registry change that unblocks them makes `onWake` report the Session active, so a host need not poll them.

## Extensions

Code the Harness runs, other than its built-in tasks, comes in named extensions installed in a registry your process owns:

```typescript
import { createRegistry, defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const Coding = defineExtension({
	name: "coding",
	sections: [section("preamble", () => "You are a concise coding assistant.", { tag: false })],
	hooks: [hook(ToolTask, { beforeTool: (call) => (isDangerous(call) ? { block: "Needs approval" } : undefined) })],
});

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Coding);
```

An extension may bring `tools`, `sections`, `hooks`, `wraps` (decorators of a tool or section by name), and `tasks`. By default every conversation selects every installed extension, in install order. Nothing in the registry is stored; conversations store extension names.

## Tools

`@earendil-works/pi-durable/tools` provides `read`, `write`, `edit`, and `bash`, and the `CodingTools` extension with all four. They touch files and processes only through the call's environment (see [Environment](#environment)).

`read` returns an image file as one image block, which programs calling it get as an `ImageContent`. Limits are the model's `inputLimits.images.resize`, by default 2000x2000 pixels and 4.5 MB of base64. Without an image processor it sends PNG, JPEG, GIF, and WebP files within them (dimensions read from the file's header) as they are, without decoding them, and refuses larger ones and other formats. With one, it decodes every image, turns it upright by its EXIF orientation, converts BMP to PNG, and shrinks it to fit. The Photon-based processor runs on WebAssembly and is only loaded when you import it:

```typescript
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node"; // or /images/cloudflare, or createPhotonImages(wasm) from /images
import { createCodingTools } from "@earendil-works/pi-durable/tools";

registry.install(createCodingTools({ images: await createNodePhotonImages() }));
```

A model without image input sees a placeholder instead of the image, and `read` says so in a diagnostic. `/images/node` prepares images in a worker thread, so a large photo (a second or two of work) never blocks the event loop; the worker exits after 30 s without images, freeing Photon's WebAssembly memory (`createNodePhotonImages({ worker: false, idleMs })`). Elsewhere, `createPhotonImages()` and `/images/cloudflare` work on the calling thread, and decoding takes the image's full size in WebAssembly memory, which does not shrink again; leave the processor out on memory-constrained hosts such as Cloudflare Workers unless images stay small.

Define your own tool with a TypeBox schema. `defineTool()` types `args` from `parameters`, which the Harness validates before `execute()`. `api.output()` streams running output, which becomes the result when `execute()` returns no `output`:

```typescript
import { Type } from "@earendil-works/pi-ai";

const count = defineTool({
	name: "count",
	description: "Count from 1 to n",
	parameters: Type.Object({ n: Type.Number() }),
	execute: async (args, api) => {
		for (let i = 1; i <= args.n; i++) api.output(`${i}\n`);
		return {};
	},
});
registry.install(defineExtension({ name: "count", tools: [count] }));
```

Each call runs as its own durable task. Its intent is committed before `execute()` runs. If the process dies mid-call, the tool reruns on reopen only when it is declared `replay: "safe"`; otherwise the model gets an `interrupted` error result with the output committed so far. A replay-safe call cut off `settings.restartLimit` times in a row ends with a `restart_limit` error result instead of running again. Throwing from `execute()` gives the model an error result. A result can also return `usage`, which is added to the conversation's [usage](#usage-and-cost). It can also return `control: { terminate: true }`: when every result of the round asks for it, the run ends without another model request.

A result has three channels: `output` for the model, `structuredOutput` for programs that call the tool (see [Calling tools from tools](#calling-tools-from-tools)), and `details` for UIs. A tool that declares `structuredOutputSchema` returns a matching `structuredOutput`, which the Harness validates. Programs calling a tool without one get its bounded output: one text item as a string, one image as its `ImageContent`, nothing as `""`, and anything else as the content list, for errors too. `structuredOutput` is always the tool's own value: a schema tool's error result keeps the value it returned, and the text of one without is in a `tool_error` diagnostic, as a thrown error's message is. The transcript stores only `output` and `details`:

```typescript
const lines = defineTool({
	name: "lines",
	description: "Count the lines of a file",
	parameters: Type.Object({ path: Type.String() }),
	structuredOutputSchema: Type.Object({ lines: Type.Number() }),
	execute: async (args, api, context) => {
		const text = await readText(api, args.path, context);
		const count = text.split("\n").length;
		return { output: [{ type: "text", text: `${count} lines` }], structuredOutput: { lines: count } };
	},
});
```

A missing, undeclared, or invalid `structuredOutput` turns a nested call's result into an error result with an `invalid_structured_output` diagnostic; for a call the model made, which never sees it, it is dropped and reported through `onReport`. An error result may omit it, and programs then find its text in a `tool_error` diagnostic; error results the Harness writes itself (blocked, invalid, interrupted, aborted) carry none, even when an `afterTool` hook returns one, and their `diagnostics` say what went wrong; one a hook turns into a success gives a schema-less tool's program its output. An `afterTool` hook that redacts a schema tool's `output` must redact its `structuredOutput` too. The built-in `bash` returns `{ output, truncated, fullOutputPath?, exitCode }`, where `output` is the retained tail the model sees, read with `api.retainedOutput()`, and answers a nonzero exit with an error result that still carries it.

A later extension's tool with the same name replaces an earlier one where both are selected, and `wrapTool()` decorates whichever tool won:

```typescript
const Venv = defineExtension({ name: "venv", tools: [createBashTool({ commandPrefix: "source .venv/bin/activate" })] });
const Timing = defineExtension({
	name: "timing",
	wraps: [wrapTool(createBashTool(), (bash) => ({ ...bash, execute: (args, api, ctx) => timed(() => bash.execute(args, api, ctx)) }))],
});
```

### Calling tools from tools

A tool calls another tool with `api.executeTool()`, as a code mode script or an MCP bridge does. The nested call is its own tool task, owned by the calling one: it is validated, runs the `ToolTask` hooks, keeps its own output limits and replay policy, and returns its result to the caller instead of the transcript:

```typescript
const testsPass = defineTool({
	name: "tests_pass",
	description: "Run the test suite and say whether it passed",
	parameters: Type.Object({}),
	execute: async (_args, api, context) => {
		const run = await api.executeTool("bash", { command: "npm test" }, context, { progress: false });
		// Absent when bash did not finish, for example on a timeout.
		const exitCode = (run.structuredOutput as { exitCode: number } | undefined)?.exitCode;
		return { output: [{ type: "text", text: exitCode === 0 ? "passed" : "failed" }] };
	},
});
```

- The caller gets the nested call's `taskId`, `structuredOutput`, `details`, `diagnostics`, `usage`, and `isError`, not the `output` meant for the model. A blocked, invalid, failed, or aborted nested call returns an `isError` result. `executeTool()` itself rejects once `execute()` has returned, when the caller is aborted, or when the Harness closes; cancelling its `context` stops only the wait.
- Hooks see a nested call's `call.parent`, so a guard can treat calls from scripts differently.
- While the caller runs, its nested calls show in `docs["pi.live"].nestedTools`, with their caller's `parentCallId` and `parentTaskId`, the arguments they run with, and a `summary` (error, duration, usage) once done; a nested call's full result is in its caller's `NestedCallDoc` while the caller runs. `progress: false` keeps a nested call's running output out of `pi.live`. Before the caller settles, nested calls it left running are aborted, also those an earlier attempt made. The caller's result message does not list its nested calls; their task records keep them.
- Each nested call has a key, its position among the caller's nested calls unless the caller passes `{ key }`. A replay-safe caller that reruns after a crash and calls in the same order, or passes the same keys, gets the nested calls it already made back, finished or still running, instead of starting them again. A nested call the crash interrupted before its result was committed follows its own `replay` policy, so a replay-safe tool with external effects still needs its own idempotency. A caller that is not replay-safe never reruns, so after a restart its unfinished nested calls are abandoned, with everything they own, before they run again.
- A nested call's `usage` is counted under its own tool; passing it on in the caller's result counts it twice.
- Nested results are not kept: they live in the caller's task documents (`NestedCallDoc`, one per nested call, keyed by its key, holding `{ taskId, result? }`) only until the caller settles. The nested call's task record keeps only a small receipt. A stored result is exactly what `executeTool()` returns, without the model's `output`, so an image or a `bash` tail is stored once.
- Nothing bounds how deeply calls nest; a tool with the default `callers` may even call itself. Restrict `callers` where that matters (below).

### Who may call a tool

`callers` on a tool says who may call it: the model, other tools through `executeTool()`, or both, the default. A conversation's `modelTools` narrows which of its tools the model is offered, without taking them away from tools:

```typescript
const codemode = defineTool({ name: "codemode", callers: ["model"], ... }); // scripts cannot start scripts
const search = defineTool({ name: "mcp__github__search", callers: ["tools"], ... }); // never offered to the model

// The model is offered only codemode; its scripts call read, bash, and the MCP tools.
await root.configure({ modelTools: [codemode] }, context);
// The model is offered everything but bash, which scripts may still call.
await root.configure({ modelTools: { remove: [bash] } }, context);
```

`conversation.agent()` resolves both lists: `tools`, offered to the model, and `callable`, which nested calls resolve among. `tools` still decides what is enabled at all; `modelTools` cannot add to it.

A `deferred: true` tool is not offered to the model until it is loaded, though other tools can call it any time. The `tool_search` tool from `@earendil-works/pi-durable/tool-search` (`createToolSearchExtension()`) lets the model search the deferred tools and loads the matches with `control.addTools`, which records them in `modelTools`; loaded tools stay offered on that branch, also after a compaction, and the `codemode` section leaves deferred tools out. Use it for large tool sets, such as an MCP server's.

### Tasks a restart abandons

A task that its creator awaits only in memory, and that the creator never resumes after a restart, can be created with `abandonOnRestart: true`. When a later Harness starts scheduling and finds it still live, it is aborted with `abortReason: "restart"`, together with everything it owns, before any of it runs again. Nested calls of tools that are not replay-safe get this automatically, and so do the child tasks such a tool creates with `api.createTask()`. A task abandoned this way whose definition is missing waits until its extension is installed, so its abort handler still cleans up. Its caller, and the conversation, wait with it; `harness.inspect()` shows it as blocked. Aborting it then orphans it, as any abort does.

## Code Mode

`@earendil-works/pi-durable/codemode` adds a `codemode` tool: the model writes JavaScript that calls the conversation's tools as `await tools.<name>(args)`, in a QuickJS sandbox (`@earendil-works/pi-codemode`). Each call is a nested tool call, and only the script's output reaches the model. The script survives a restart: it resumes where it was, without running its finished calls again.

```typescript
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";

registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }) }));
```

The extension also adds a `codemode` prompt section listing the tools scripts can call, as TypeScript declarations within a token budget; scripts find the others with `searchTools()`, `describeTool()`, and `describeNamespace()`. Group tools by name prefix with `namespaces: [{ name, description, prefix }]`, for example an MCP server's `mcp__github__`. The result reads like the coding agent's: a header, the script's output, and on failure the calls already made; text past `max_output_tokens` is cut, with the full text in a temp file. Scripts also get `models.*`: the model catalog, `models.classify()`, and `models.generateImages()`, which run as nested calls of internal tools (`models: false` turns them off). On Cloudflare, pass a `RemoteCodemodeSandbox` instead. Closing the sandbox while a script runs (for example when shutting down) is not an outcome: the script resumes with the next process's sandbox. A failed nested call rejects in the script with its error text, unless the tool declares a schema and returned its own value with the error: `tools.bash` resolves with `{ output, exitCode, ... }` also for a nonzero exit, so scripts check `exitCode`. `store(key, value)` and `load(key)` keep JSON values per conversation; a fork sees them as they were at its entry.

How it survives a restart: the sandbox runs the script deterministically (a virtual clock, seeded randomness, UTC), and the tool writes each result the script gets to a journal before handing it over. After a restart, the tool runs the script again and hands it the journaled results in the same order, so it makes the same calls with the same arguments; these reattach to their nested calls by key, and then the script continues. A rerun ends the call with an error instead when the script takes another path than before, when the sandbox's fingerprint or the code mode version changed, or when its `timeout_ms` passed meanwhile. A nested call running at the restart follows its own replay policy.

## System Prompt

The system prompt is built from the selected extensions' sections, rendered in order before each request. A section sees the resolved agent, the environment built for the request, and committed documents:

```typescript
section("cwd", (input) => input.env?.cwd); // rendered as <cwd>\n...\n</cwd>; undefined omits it
```

A conversation's `instructions` render last, as the section `instructions`. Sections and tool changes are stored as positional system entries in the transcript. Only what changed is sent again, which keeps provider prompt caches warm. A section that returns something different every time, such as the current time, defeats that.

## Per-Conversation Agent

Each conversation stores what it runs with in its `pi.agent` document. `configure()` changes it in one commit; unset fields follow the host:

```typescript
await root.configure(
	{
		model: { provider: "openai", modelId: "gpt-6-sol" },
		thinkingLevel: "high",
		extensions: { remove: [Coding] }, // edits the host default; an array selects exactly these, in order
		tools: [readTool, bashTool], // an array enables exactly these; { remove: [...] } drops some
		modelTools: [readTool], // of those, offer the model only read; tools may still call bash
		instructions: "Only read; never edit files.",
		cwd: "/work/repo",
		maxTurns: 50, // tool rounds one run takes at most; unset: no limit
	},
	context,
);
await root.configure({ tools: null }, context); // null clears a field back to the host default
const agent = await root.agent(context); // resolved: model, extensions, tools, sections, cwd
```

Extensions and tools are passed as objects and stored by name, so a stored name outlives its code: after an extension is uninstalled, conversations that select it just stop getting it until it is installed again. `createConversation()`, `fork()`, and `root()` take the same change as `agent`. A task-owned conversation, such as a subagent's, starts as a copy of its owner's conversation's agent. A fork starts with the agent its parent had at the fork entry. The model, prompt, and offered tools of a request are fixed when it is prepared; a change applies from the next request. Tool calls and hooks use the agent as their task phase resolves it, and the environment is built from the current `cwd` at each use, so a `cwd` or extension change can reach calls the model already made.

**Turn limits.** `maxTurns` bounds the tool rounds one run takes: the round that reaches it still runs its tools, then the run ends `unanswered` with `turn_limit`, like a failed run (`runFailure`, and `settings.afterFailedRun` decides the inputs queued behind it). An answer always ends the run, so it is never cut off. The count is `docs["pi.live"].run.turns`; it survives restarts, and every run starts at 0, also one a continue starts (see [Busy Conversations](#busy-conversations)), so a host or tool that continues automatically gets a fresh budget each time and must bound that itself. An `onYield` continuation also starts the count over: an extension that keeps a run going bounds its own loop, reading `pi.live.run.turns` and `pi.agent.maxTurns` with `api.snapshot`. `configure()` throws a `RangeError` for anything but an integer 1 or more (or `null`); a change applies at the end of the current round, and children and forks inherit it like the rest of the agent.

## Settings

Run policy shared by every conversation is passed as `settings`. It is read at every use and never stored, so getters make it live, for example backed by a settings file:

```typescript
const harness = await Harness.open(storage, {
	models,
	registry,
	settings: {
		extensions: [CodingTools, Coding], // default selection; absent: every installed extension
		stream: { timeoutMs: 120_000 },
		retry: { maxRetries: 3 },
		compaction: { reserveTokens: 16384 },
		progress: { partialIntervalMs: 100, outputIntervalMs: 100, persistWithinMs: 1_000 },
		toolExecution: "parallel",
		contextRetentionMs: 600_000, // idle conversations keep their context in memory this long (checked lazily where background timers are declined, as in Workers)
		documentRetentionMs: 600_000, // loaded documents nothing observes stay in memory this long after their last use; observed ones always
		get followUpMode() {
			return userSettings.followUpMode;
		},
	},
}, context);
```

## Environment

`env` builds the execution environment for each tool call, section rendering, and `runtime.env()`. It receives the conversation's ID, its agent `cwd`, and committed reads, so one function serves a directory per conversation or a container per conversation:

```typescript
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const harness = await Harness.open(storage, {
	models,
	registry,
	env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
}, context);
```

A throw from `env` becomes the call's error result. Without an environment, the built-in tools fail with an error result. A fresh environment object per call is fine: `edit` and `write` serialize changes to one file by the environment's `id` and path. A custom `ExecutionEnv` sets `id` so that equal ids see the same files at the same paths, for example one id per container.

Hosts can use the environment directly too, for example to show a project's files. `openBinaryReader()` reads byte ranges of one opened file, `openDirReader()` pages a directory, and `exec()` with an argv array runs a program without a shell, reporting which stream each output chunk came from:

```typescript
const status = { stdout: "", stderr: "" };
await env.exec(["git", "status", "--porcelain=v2", "-z"], {
	onOutput: (text, _context, { stream }) => {
		status[stream] += text;
	},
}, context);
```

Abort the context to stop one call; `cleanup()` is for shutting the environment down. A custom environment can check itself with `registerEnvConformance()` from `@earendil-works/pi-durable/testing`, like storage below.

Some environments also implement the optional `listFiles()`: the files and directories below a directory at any depth, as `fd` lists them, skipping what git ignores and stopping at bounds with `truncated`. `NodeExecutionEnv` does not; pi-env's `RemoteExecutionEnv` and `LocalExecutionEnv` do. Callers fall back to their own walk when the method is missing or fails with `not_supported`:

```typescript
const listing = await env.listFiles?.(".", { exclude: ["node_modules"], maxEntries: 50_000 }, context);
```

## Reload

Installing an extension with an installed name replaces it in place, in one step:

```typescript
registry.install(await loadCodingExtension()); // same name "coding": replaces the installed one
```

`registry.uninstall(extension)` removes the installed extension with that name, whichever object it is.

Work that already started keeps the code it took: a running tool call finishes under its old implementation, and each task phase resolves hooks and the agent once, from the registry at the phase's start. The next phase, request, or call uses the new code. After a restart, install the same extensions again; pending tasks of an extension's `tasks` resume once it is installed.

## Watching a Conversation

Everything a UI needs is committed state. `watch()` returns a watch of the conversation's structural view: its value at attachment, then each commit that touches it, with the Chord operations of that commit, one callback at a time:

```typescript
const watch = await root.watch(context);
render(watch.value); // the state at attachment
watch.start(async (call) => {
	if (call.kind !== "value") return; // Durable's watches end on a failure; they never send a failed call
	const { value, ops } = call;
	// value.entries: a window over the transcript, newest last; value.before: the entry just before it
	// value.docs["pi.live"]: the run, the running generation (streamed partial, retry, deferred), tool calls (output,
	//   details), compactions, and why the last run ended without an answer (runFailure)
	// value.docs["pi.inbox"], value.docs["pi.usage"], value.docs["pi.agent"], value.docs["pi.provider"]
	render(value);
	await send(ops); // for example to a remote client that applies them
});
// later: await watch.stop();
```

The view's `entries` are a window, so neither the first value nor a reconnect costs the whole transcript. A watch starts with the newest 50 entries; new entries are appended, and once the window would hold more than 100, its oldest leave in one splice, leaving the newest 50. `watch(context, { min, max })` changes the bounds. `from` picks where the first value starts (as `transcript.resume` does after a drop); every entry committed after the watch attached is appended, so a `from` past the newest entry starts empty and receives what comes next. Compaction summaries and resets are entries like any other, in place; a summary's `head` says where the entries it summarizes end. `conversation.context()` gives the active transcript the model sees.

`ConversationTranscript` keeps what a client has seen beyond the window: call `merge()` with every value of the view, and render the `items` it returns, the client's whole transcript with a "load earlier" marker at the top and a "load more" gap wherever the client missed entries, after a stall or a reconnect:

```typescript
import { ConversationTranscript } from "@earendil-works/pi-durable";

const transcript = new ConversationTranscript((query, limit, ctx) => root.entries(query, limit, undefined, ctx));
const watch = await root.watch(context);
render(transcript.merge(watch.value));
watch.start(async (call) => {
	if (call.kind === "value") render(transcript.merge(call.value));
});

// When a marker scrolls into view:
render(await transcript.loadEarlier(context)); // the page before the oldest entry
render(await transcript.fillGap(gap, context)); // the next page of a gap item

// Reconnect after a drop: only what was missed, when it fits the window, otherwise the newest entries and a gap.
const resumed = await root.watch(context, transcript.resume);
```

Entries never change once committed, so a merge only adds; one that adds nothing returns the same `items` array. See `test/examples/31-transcript.ts`.

Watches are Chord's `WatchHandle` (exported by `@earendil-works/chord`; Durable re-exports it). The listener gets one `WatchCall` per call, tagged by `kind`, and the newest commit's context: `{ kind: "value", value, ops, retired }`. Chord's watches also have `{ kind: "failed", error }` calls for failures a source recovers from; Durable's failures are final, so a Durable watch never sends one and ends instead. A watch ends once, and `closed` (or `stop()`) gives a `WatchEnd` tagged by `kind`: `stopped`, `aborted` (its acquisition context was aborted), `ended` (the Harness closed, or a task document's task ended), `listener_error`, or `failed` (the Harness failed). An ended watch keeps its last value and no longer references the Harness.

Adapters that must change in the same step as Durable's memory, such as a Chord source over a view, attach a synchronous observer instead of a watch: `harness.observeConversation(id, observer, context)`, `harness.observeTaskGraph(observer, context)`, and `harness.observeDoc(token, ...scope, observer, context)` return the current `value` and `detach()`, and call `observer.advance(call, context)` with every later change as a `WatchCall` (always a `value` call), unfolded, as memory adopts it: inside the storage's commit for a stored commit, at once for a deferred one (before it is stored). A document observer gets one call per change at its address, so a commit that retires and recreates the document gives two; the task graph also advances without a commit when a registry change alters a task's `blocked` reason. A change can arrive before the `observeXXX()` promise resolves; its ops apply from the observation's `value`. `observer.end(end)` comes once with a `WatchEnd`: `ended` when the Harness closes or, for a task document, right after the retirement of the commit that ends its task, `failed` when the Harness fails. `advance` only records the change: no awaits, no Harness calls, no throws, and quick, since every commit waits for it. One that throws (or returns a rejected promise) is reported, detached, and ended `listener_error`. Watches are built on these observers.

Commits that land while a callback runs are delivered together in the next callback: the newest view and the operations of all of them, folded (appends to one string join, sets of one field keep the last). Past 10,000 pending operations the callback gets one root replacement `[["r", view]]` holding the whole newest view instead, its window included. A client that joins late or reconnects starts from the current view; nothing is replayed.

Partial answers and tool output are committed at most every 100 ms by default, and watches see each commit at once. Storage gets them later and together, as deferred commits (see [Your Own State](#your-own-state)): with the next commit that reads `pi.live`, such as the end of the answer or of a tool, and at the latest after `settings.progress.persistWithinMs` (default 1,000 ms). A crash loses at most about that window of an answer or of tool output; a stream that crashes in its first second may leave no aborted entry, and that attempt's usage is not recorded. `settings.progress` changes the intervals; a host whose storage is remote can commit less often, for example `{ partialIntervalMs: 500, outputIntervalMs: 500 }`.

## Busy Conversations

A conversation is busy while a run is working on an input. Submitting to a busy conversation queues the submission in the conversation's inbox, `docs["pi.inbox"]` in the view:

```typescript
await root.submit({ type: "input", content: "Also run the tests" }, context); // follow-up (default)
await root.submit({ type: "input", content: "Use pnpm, not npm", whenBusy: "steer" }, context);
await root.submit({ type: "input", content: "Only if idle", whenBusy: "reject" }, context); // throws ConversationBusy
await root.submit({ type: "input", content: "Only if busy", whenBusy: "steer", whenIdle: "reject" }, context); // throws ConversationIdle when idle
await root.submit({ type: "write", entry: { kind: "app.note", data: "user opened a file" } }, context);
```

- **Steers** are placed after the current tool round and join the running work.
- **Follow-ups** are placed when the run answers, and start the next run.
- **`whenIdle: "reject"`** refuses an input when no run is working, so it never starts a run of its own. With `whenBusy: "steer"`, it steers the current run or throws `ConversationIdle`. A run that answered and waits for its [after-run tasks](#work-at-the-end-of-a-run) is still working, so such an input queues and starts the next run.
- **`submit(tx, draft)`** admits inside your own commit, with the same rules, and returns the submission's ID. Your checks, the admission, and your writes are stored together or not at all:

  ```typescript
  const id = await harness.commit(async (tx) => {
    const chat = await tx.doc(MyChat, root.id); // your own conversation document
    if (chat.muted.includes(userId)) throw new Error("Muted");
    const id = await root.submit(tx, { type: "input", content: text, whenBusy: "steer", whenIdle: "reject" });
    chat.sent.push({ id, userId }); // your own state, same commit
    return id;
  }, context);
  ```

  Call it before the commit's own table writes (`appendEntry()`, `createTask()`, another admission), once per commit: otherwise it throws `ReadAfterWrite`, on every path. Documents may be read and written before and after it. A rejection (`ConversationBusy`, `ConversationIdle`) throws before any write, so you may catch it. Until your commit is stored the admission is provisional: if your callback throws later, no submission exists. Tasks and tools do the same in their own commits through `api.conversation(id)`; entries the admission places carry the task's `byTaskId`.
- **Writes** append an entry without asking the model anything. A write of only `kind` and `data` changes nothing the model sees, so it is appended at once, even mid-run, and is never queued: a chat message shows in the transcript as soon as it is sent. It can therefore appear before items submitted earlier that are still queued, except behind a queued reset, where it waits so the reset does not hide it. A write with `model`, `head`, or `edits` waits for the next boundary like a steer.
- `await submission.abort(context)` withdraws a queued submission.
- The [settings](#settings) `steeringMode: "all"` and `followUpMode: "all"` place every queued item at once instead of one per turn.

If a run fails, queued items stay in the inbox until the next input, queued write, or continue places them, oldest first.

When a run ends without an answer, `docs["pi.live"].runFailure` says why until the next run starts: `model_error` and `no_model` (with the error text or the missing model in `detail`), `aborted`, `reset`, `interrupted` (the host stopped while the model answered, with no retry left), `faulted`, `orphaned`, and `restart_limit` (the run's task could not go on), `turn_limit` (a tool round reached the conversation's `maxTurns`), or `nothing_to_answer` (a continue, below, found nothing to answer). The run's inputs are in it too, settled `unanswered`; the settlement's reason is the same, except that an orphaned run's inputs carry why it was orphaned (`missing_task`, `task_too_old`, `migration_failed`) and `no_model` has no `detail` there (spec §8.2).

To resume such a run without typing a message, submit a continue. It starts a run on the context as it is, so the model answers the user message or tool results the stopped run left:

```typescript
const live = await harness.snapshot(LiveDoc, root.id, context);
if (live?.run === undefined && live?.runFailure !== undefined) {
	const resumed = await root.submit({ type: "continue" }, context); // throws ConversationBusy while busy
	await resumed.wait(context); // done with the answer, or unanswered like any run
}
```

A continue is never queued: it throws `ConversationBusy` while a run is working, since whether there is anything to continue depends on how that run ends. Items a failed run left queued are placed first and join the run. A context with nothing to answer (empty, or ending in an answer, also a text answer cut off at its output limit) ends the run without a request, `unanswered` with `nothing_to_answer`. A cut-off answer with tool calls can be continued: its calls never ran, so the context ends in their error results. Tools can continue the conversations they own through `api.conversation(id)`, as they submit to them.

An input is placed as a `pi.user` entry. To show it as something else, give it an `entry` with your kind and data; the model still sees `content` as the user message:

```typescript
await root.submit(
	{
		type: "input",
		content: "ann: can you check the build?",
		entry: { kind: "chat.mention", data: { author: "ann", text: "can you check the build?" } },
	},
	context,
);
// placed as { kind: "chat.mention", data: { author: "ann", ... }, model: [{ role: "user", content: "ann: can you check the build?" }] }
```

It behaves like any other input: it starts a run, steers, follows up, or rejects, and is answered. While queued, its inbox item carries the entry. The kind must not start with `pi.`.

## Reset and Handoff

`reset()` starts a new context. The model no longer sees older entries, but they stay in storage:

```typescript
await root.reset(undefined, context);                                  // start from nothing
await root.reset("We were fixing the flaky login test. Continue.", context); // start from a handoff note
```

While busy, the reset is queued like a write. When it is placed during a tool round, the current run ends: its inputs settle `unanswered` with reason `reset`, and queued inputs run in the new context.

A tool can return `control: { handoff: "..." }` to write the same reset with its text, but the run continues: the next model request starts in the new context, and the submission settles with that eventual answer. Queued writes and steers land after the handoff text, follow-ups wait for the run's end, and a queued `reset()` still ends the run. When every call of the round also returns `terminate: true`, the run ends after the handoff instead.

## Compaction

Compaction shrinks what the model sees: it summarizes older entries and appends a `pi.compaction` entry that holds the summary and heads the first entry it keeps. Older entries stay in storage.

```typescript
const id = await root.compact("Keep the failing test names", context); // manual, with optional instructions
const { outcome } = (await harness.waitForTask(id, context)).state;
if (outcome.status === "completed" && outcome.result.submissionId !== undefined) {
	const placed = await (await harness.submission(outcome.result.submissionId, context))!.wait(context);
	console.log(placed.status); // "done", or "unanswered" with reason "stale"
}
```

The conversation keeps working while the summary is made. The summary is placed at once when the conversation is idle, otherwise at the next turn boundary. Esc (`abort()`) cancels a manual compaction.

Generation also compacts on its own, controlled by the [settings](#settings):

```typescript
settings: {
	compaction: {
		enabled: true, // automatic compaction; manual compact() always works
		reserveTokens: 16384, // above contextWindow - reserveTokens, the next request waits for a compaction
		keepRecentTokens: 20000, // roughly how much recent context stays verbatim
		backgroundTokens: 32768, // this far below that, a compaction starts in the background; 0 disables it
		modelOverrides: {
			// exact "provider/modelId"; each field set here replaces the one above for that model
			"local/small-32k": { reserveTokens: 4096, keepRecentTokens: 8000, backgroundTokens: 4096 },
		},
	},
}
```

The fixed token counts rarely suit a 32k and a 1M context window alike; `modelOverrides` lets one harness serve both. The conversation's current model picks the entry, at the threshold check, after a context overflow, and when a compaction selects what to summarize.

When a provider rejects a request because the context is too long, generation compacts and retries once. A summary that would cut before the start of the current context settles as `stale` when it is placed, so when several are in flight, the furthest cut stays in effect. Summarization spend counts in `pi.usage`. A `beforeCompact` hook on `CompactionTask` can decline or supply its own summary.

When a compaction that a generation waits for at the blocking threshold fails, the generation fails too, without sending a request: its inputs settle `unanswered` with `model_error` and detail `Compaction failed: <error>`. One that finds nothing to compact or is declined lets the request go ahead.

Running compactions are listed in `docs["pi.live"].compactions` with their `trigger` (`manual`, `threshold`, or `overflow`), attempt, and retry backoff. The newest failure stays in `docs["pi.live"].compactionFailure` (task, trigger, error) until a compaction produces a summary.

## Hooks

Hooks let extensions observe or adjust the built-in tasks, in the conversations that select them:

```typescript
import { GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";

const Guard = defineExtension({
	name: "guard",
	hooks: [
		hook(ToolTask, { beforeTool: (call) => (call.name === "bash" ? { block: "bash is disabled here" } : undefined) }),
		hook(GenerationTask, { onYield: (answer) => (needsMoreWork(answer) ? { continue: "Keep going." } : undefined) }),
	],
});
```

- **Generation:** `beforeRequest` (replace the messages of one request), `afterResponse`, `onYield` (continue the run with another user message), `afterTools` (runs once a round's tools are done), and `afterRun` (tasks to run before the run ends, below).
- **Tools:** `beforeTool` (block or rewrite arguments) and `afterTool` (replace the result). `afterTool` sees every result a tool task writes, also the error results the Harness writes itself (unavailable, invalid, blocked, interrupted, restart limit, aborted), told apart by their diagnostic code; past `settings.restartLimit` it no longer runs. On an abort it runs inside the abort handler, so a slow hook delays `abort()`.

To limit a hook to some conversations, select its extension only there, for example with `configure({ extensions: { add: [Guard] } })`.

Hooks read committed documents (`api.snapshot()`) and the conversation's raw history (`api.entry()`, `api.entries()`), which compaction never changes.

### Work at the end of a run

An `afterRun` hook starts durable work after a run answered, without a tool call: for example the project's tests after a run that edited files. It returns tasks, built with `runEndTask()`, and the generation creates them as its children and waits for them before the run ends:

```typescript
import { defineExtension, GenerationTask, hook, runEndTask, ToolResultEntry } from "@earendil-works/pi-durable";

const TestsAfterEdits = defineExtension({
	name: "tests-after-edits",
	tasks: [RunTests], // a task of yours, defineTask(): runs the tests, then commits its result
	hooks: [
		hook(GenerationTask, {
			afterRun: async (run, api, context) => {
				// The run's own entries, also those a compaction summarized.
				const range = { minEntryId: run.first, maxEntryId: run.last, order: "ascending" } as const;
				const { items } = await api.entries(range, 1000, undefined, context); // page with `next` for longer runs
				const edited = items.some((entry) => {
					const message = entry.model?.[0];
					return ToolResultEntry.is(entry) && message?.role === "toolResult" && message.toolName === "edit";
				});
				return edited ? { tasks: [runEndTask(RunTests, { command: "npm test" })] } : undefined;
			},
		}),
	],
});
```

- **When:** after a final answer or a `terminate` round, not while an `onYield` continuation keeps the run going, never after a failure or an abort.
- **The answer first:** the answer is committed and the run's inputs settle `done` before the hooks are asked, so `Submission.wait()` resolves at the answer.
- **Busy until done:** `pi.live.run` stays, with `run.afterRun` listing the tasks, so the conversation is busy and `waitForIdle()` includes them; Stop aborts them; a crash resumes them. A crash before they exist asks the hooks again, never twice once they do.
- **Input meanwhile:** steers and follow-ups queue and start the next run once the tasks are done; `whenBusy: "reject"` and a continue throw `ConversationBusy`.
- **Results for the model:** a task gets its conversation's handle before its commit, `const handle = (await runtime.conversation(runtime.conversationId, context))!`, and admits a write or a follow-up (say "the tests failed: ...") inside it with `handle.submit(tx, draft)`, before its own table writes. Both are placed when the run ends: a write before any queued user input, a follow-up in queue order with the rest. A follow-up starts a fix run, which asks `afterRun` again with a fresh turn budget, so cap such loops in your extension.
- **Broken requests** (an uninstalled or built-in task, a non-JSON input, a throwing `initial()`) are reported through `onReport` against the hook's extension and skipped; the run still ends.

## More Conversations and Forks

```typescript
const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
const fork = await root.fork(entryId, { ownership: { kind: "ownerless" } }, context);
```

A fork sees its parent's entries up to `entryId` and continues independently. It keeps the parent's agent as of that entry but receives a fresh provider session identity. Both take `agent` and `init`, applied in the creating commit.

## Abort and Subagents

`await root.abort(context)` stops a conversation: queued inputs are withdrawn (queued writes stay), every task of its current work is aborted, and the call resolves once the conversation is idle.

A conversation can be **owned** by a task. A subagent tool creates its child inside `api.commit()` with `ownership: { kind: "task", taskId: api.taskId }`, then drives it through `api.conversation(id)`:

```typescript
const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description: "Delegate a self-contained task to a subagent and get its answer back.",
			parameters: Type.Object({ task: Type.String() }),
			replay: "safe", // a rerun after a crash finds the same child and submission
			execute: async (args, api, context) => {
				const child = await api.commit(async (tx) => {
					// The ownership index remembers the child, so a rerun reuses it.
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					// Starts as a copy of this conversation's agent: model, extensions, tools, cwd.
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					// A cheaper model, and no subagents of its own.
					await configure(tx, created.id, { model: haiku, extensions: { remove: [Subagent] } });
					return created.id;
				}, context);
				await api.details({ conversationId: child }, context); // lets a UI attach to the child
				const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
				const settled = await (await (await api.conversation(child, context))!.submit(request, context)).wait(context);
				return { output: [{ type: "text", text: settled.status }] };
			},
		}),
	],
});
```

Owned work belongs to its owner:

- Aborting the call aborts the child. So does the call failing: `execute()` throwing, or a crash that interrupts a call that is not replay-safe.
- The parent is idle only once the child is.
- A task created with `{ background: true }` is a boundary: work it owns survives the parent's abort and does not keep the parent busy. `root.abort(context, { background: true })` aborts it too.

The examples show both patterns as product code:

- [`21-subagent-foreground.ts`](test/examples/21-subagent-foreground.ts): the tool above, returning the child's answer. The UI finds the child through the call's `details` and prints the child's events indented under the call.
- [`22-subagent-background.ts`](test/examples/22-subagent-background.ts): persistent subagents behind one `subagent` tool that spawns, messages (steer or follow-up), waits for, stops, and lists them. Each child is owned by a background anchor task, so the parent's Esc and idle waits never reach it. Each message is delivered by a background reporter task that posts the answer back to the parent as a follow-up input once it arrives; request IDs keep a restart from sending a message or a report twice.

## Child Tasks

A task can own child tasks, created with `ownership: { kind: "task", taskId }`, and wait for them by committing a `waiting` state:

```typescript
pay: async (task, runtime, context) => {
	await runtime.commit(async (tx) => {
		const payments = [];
		for (const card of task.input.cards) {
			payments.push(await tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }));
		}
		// Resume in `decide` once every payment is done; the first failure aborts the rest.
		return { status: "waiting", checkpoint: { phase: "decide", payments }, on: payments, policy: "failFast" };
	}, context);
},
decide: async (task, runtime, context) => {
	const outcomes = await runtime.outcomes(task.state.checkpoint.payments, context);
	// ...commit the checkout's own outcome
},
```

- **Waiting:** the task runs no code while it waits. With `allSettled` it resumes once every task in `on` is done; with `failFast` the first failed child also aborts the others. `on` may name other tasks too, with `allSettled`.
- **Finishing:** a task that finishes while work it owns is still running is `completing`: its outcome is decided, but it becomes terminal, and `waitForTask()` returns, only once that work is done. A failed or aborted outcome aborts that work first.
- **Aborting:** abort runs bottom-up. Aborting a task aborts the work it owns first, and its own abort handler starts only once that work is done, so each task undoes its own effects.

[`23-child-tasks.ts`](test/examples/23-child-tasks.ts) runs a checkout with four payments: a declined card, a cancelled checkout, and a restart while the payments run.

## Task Graph

`harness.watchTaskGraph(context)` watches every live task of the Session as one value, for a task panel or debugging, like a conversation's `watch()`. Each node has its owner edge (`owner` task, or none for a task its conversation owns), its status, whether it is `background` or abort-marked, and the conversations it owns.

```typescript
const graph = await harness.watchTaskGraph(context);
graph.start(async (call) => {
	if (call.kind !== "value") return;
	for (const node of Object.values(call.value.tasks)) {
		const status = node.state.status === "waiting" ? `waiting on ${node.state.on.join(", ")}` : node.state.status;
		console.log(`${node.id} ${node.kind} ${status}`, node.owner ?? `conversation ${node.conversationId}`);
	}
});
```

A task appears with the commit that creates it and leaves with the commit that makes it terminal. Statuses are the committed ones: `pending`, `running`, `waiting` (with `on` and `policy`), and `completing` (with the held outcome's status). After a restart, tasks that were `running` show as `pending` until they run again. Whether a pending task is blocked by a missing definition is not part of the graph; `harness.inspect()` reports that. The graph lists live tasks only: once a subagent's owner task is terminal, a later task in its conversation is a top-level node, and the conversation's `ConversationRecord.owner` (also in its view's `conversation`) links it to its parent. [`23-child-tasks.ts`](test/examples/23-child-tasks.ts) prints the checkout's tree while its payments run.

## Your Own State

Documents are typed JSON objects committed together with entries. Define one, and edit it in a commit:

```typescript
import { defineDoc } from "@earendil-works/pi-durable";

const Todos = defineDoc<{ items: string[] }>({
	kind: "app.todos",
	version: 1,
	scope: "conversation",
	history: "latest", // or "rewindable" to read old values with snapshotAsOf()
	fork: "initial", // what a fork starts with: "initial", "current", or "asOf"
	initial: () => ({ items: [] }),
	checkpointWhen: () => false, // required: true stores this change as a complete base, bounding replay
});

await root.commit(async (tx) => {
	(await tx.doc(Todos, root.id)).items.push("write docs");
}, context);
console.log(await harness.snapshot(Todos, root.id, context));
```

A commit whose changes are cheap to lose, such as your own streamed progress, can be shown at once and stored later:

```typescript
await root.commit(
	async (tx) => {
		(await tx.doc(Todos, root.id)).items.push("draft"); // a document like Todos: latest, fork "initial"
	},
	context,
	{ persistence: { kind: "deferred", withinMs: 1_000 } }, // without withinMs: settings.progress.persistWithinMs
);
```

Watches and the view see it at once. Storage gets it with the next commit that reads or writes the document, before the document leaves memory, at close, and at the latest about `withinMs` later; `observeCommits()` sees it then, with exactly what was stored (a document the commit retires shows as its retirement only). A crash loses what was not stored yet, so derive nothing durable from such a value outside a commit that reads it. Only a commit that changes nothing but existing documents with `history: "latest"` and `fork: "initial"` is deferred; anything else in it, such as an entry, a new document, or a task state, stores it at once.

`harness.watchDoc()` watches one document like the view above. A document watch follows its address: a retirement is a call with `retired: true`, the last value the watch was given (a change made in the retiring commit itself is not shown), and no ops, and a document created there later arrives as `[["r", value]]` on the same watch. A task document's watch ends `ended` with its task: once the retirement call of the commit that ends the task has returned, or at the Harness's close if that call was never delivered (a watch never started); an observer of it gets `end({ kind: "ended" })` right after the retirement. `HarnessOptions.conversationCreated(tx, conversation)` runs in every commit that creates or forks a conversation, including a tool's raw `tx.createConversation()`, so every conversation gets your documents; `init` in `createConversation()`, `fork()`, and `root()` writes per-call data in the same commit. An extension's tools, sections, and hooks read their own documents through `api` or `input.read`, and treat an absent one as its default ([`10-extension-state.ts`](test/examples/10-extension-state.ts)).

## Usage and Cost

Each conversation keeps token and cost totals in `docs["pi.usage"]`: per `provider/model` for model responses, and per tool name for tool results that report usage. Failed and aborted attempts count too. For the whole Session:

```typescript
const usage = await harness.usage(context); // { models: { "openai/gpt-6-sol": Usage }, tools: {...} }
```

## Storage

| Backend | Import | Notes |
|---|---|---|
| Memory | `MemoryStorage` from the package root | Nothing is persisted. |
| IndexedDB | `IndexedDbStorage.open(name)` from `@earendil-works/pi-durable/storage/indexeddb` | Browser-only storage in one IndexedDB database. |
| SQLite | `openNodeSqliteStorage(file)` from `@earendil-works/pi-durable/storage/sqlite/node` | One database file. WAL mode with `synchronous = NORMAL`: commits survive process crashes; the newest may be lost on power or host failure. |
| JSONL | `openNodeJsonlStorage(directory, context)` from `@earendil-works/pi-durable/storage/jsonl/node` | Append-only files in one directory. Pass `{ fsync: true }` to flush before each commit marker. Keeps the whole history in memory too, so memory grows with it; use SQLite for long-running agents. |
| Cloudflare Durable Object | `openDurableObjectSqliteStorage(ctx.storage)` from `@earendil-works/pi-durable/storage/sqlite/cloudflare` | The SQLite storage of one SQLite-backed Durable Object; commits are its storage transactions. |

In a browser, open IndexedDB storage with `await IndexedDbStorage.open(name)`. One owner must hold the database at a
time; use a [Web Lock](https://developer.mozilla.org/docs/Web/API/Web_Locks_API) around its lifetime rather than opening
it in competing tabs or workers. Call `await navigator.storage.persist()` when durable retention matters.

SQLite storage can namespace its tables and indexes when sharing a database: pass `{ prefix: "pi_" }` to
`SqliteStorage.open(database, options)`, `openNodeSqliteStorage(path, options)`, or
`openDurableObjectSqliteStorage(ctx.storage, options)`. Storage renders the prefixed names into its SQL, so adapters
need no support. A prefix must be a SQLite identifier and cannot begin with `sqlite_`; a host may reserve more, such
as `_cf_` in Durable Objects. Changing the prefix does not migrate existing data.

Multiple Pi storages opened through the Cloudflare adapter with the same storage object automatically share an
operation queue. To share the database with host tables, create an adapter and use it for both Pi and all host queries;
direct storage calls bypass the queue and may be rolled back with a Pi transaction:

```typescript
const database = new DurableObjectSqliteDatabase(ctx.storage);
const piStorage = await SqliteStorage.open(database, { prefix: "pi_" });
await database.exec("CREATE TABLE IF NOT EXISTS host_notes (text TEXT)");
await database.run("INSERT INTO host_notes (text) VALUES (?)", text);
```

One process owns a storage at a time; there is no cross-process locking. The portable SQLite and JSONL cores (`/storage/sqlite`, `/storage/jsonl`) run without Node APIs, for example on Bun or in Cloudflare Durable Objects, given an asynchronous `SqliteDatabase` facade or a `FileSystem` from `@earendil-works/pi-durable/env`.

SQLite adapters implement promise-based `exec`, `run`, `get`, `all`, `transaction`, and `close`. `run`, `get`, and `all` take SQL text plus positional bindings; adapters may cache prepared statements by SQL text. A transaction callback receives a transaction handle; all work in the transaction must use it, and the handle expires when the callback settles. Adapters must queue unrelated operations and other transactions until the transaction finishes, so calling `database` itself inside the callback never settles:

```typescript
await database.transaction(async (transaction) => {
	await transaction.exec("CREATE TABLE example (value TEXT)");
	await transaction.run("INSERT INTO example (value) VALUES (?)", "stored atomically");
});
```

A custom backend's `commit(writes, adopt, context)` calls `adopt(seq)` once the batch is durable, synchronously and before its next commit starts, and then resolves with `seq`; a commit that fails before the batch is durable never calls it. `adopt` is the Session's in-memory adoption and publication of the batch, so memory and every view never show a partial log: inside it the Session's own observers run (views, task graph, scheduler, waits), and `subscribeCommits()` listeners, watch listeners and the code the commit wakes follow in microtasks, so at the backend's next `await` if it still works after `adopt` (as JSONL reclaims sidecars), before its `commit` resolves. `adopt` calls no Storage method and never throws; once it ran, the commit is published even if the backend then rejects, and the Session then fails. Custom backends can run the shared conformance suite, which checks this too, with any Vitest- or Jest-compatible runner:

```typescript
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";

registerStorageConformance({ describe, expect, it }, "My Storage", async (use) => {
	const storage = await openMyStorage();
	try {
		await use(storage);
	} finally {
		await closeMyStorage(storage);
	}
});
```

The package root loads TypeBox, because the tool task validates arguments with pi-ai's `validateToolArguments()`. That costs about 23 MB of peak RSS unbundled, about 4 MB in a tree-shaken bundle.

## Errors

Three rules decide what an error does:

1. **A storage error ends the Harness.** The call that hit it rejects with the error. Everything after it, and every pending wait, rejects with `SessionFailed` (its `cause` is that error); watches end with `failed`; running tasks get their abort signal; `onReport` gets the error once. The Harness then closes itself. Nothing is retried; a custom storage retries its own transient failures. Reopen to recover: commits are atomic, so the store is consistent, and resubmitting with the same `requestId` finds a submission that was already admitted.
2. **An invalid read fails only that call:** a storage read throws `StorageRequestError` for a bad cursor, an unknown conversation, or history a document does not keep. A read you cancelled fails only itself too. The exemption covers reads only: any error from `commit()` or `mintId()`, `StorageRequestError` included, ends the Harness as in rule 1.
3. **Your code fails only its own unit:** a throwing task phase faults that task, a throwing tool gets an error result, a throwing hook is reported and skipped (`beforeTool` blocks the call), and a throwing commit callback rolls back that commit. Listeners that throw, or return a rejected promise, are reported and the others still run. The exception is a host `RegistryReader` whose `snapshot()` throws: the Harness cannot schedule without it, so it fails the Harness like a storage error.

`harness.closed` settles once the Harness has closed, by `close()` or after a storage error, so a host restarts on failure like this:

```typescript
harness.closed.then((end) => {
	if (end.kind === "failed") reopen(end.error);
});
```

A failure closes the Harness by itself; `closed` settles once that close is done, even if the storage could not close cleanly. Closing waits for running task code to return, so code that ignores its abort signal delays `closed`.

## Examples

Runnable examples live in [`test/examples`](test/examples). Run one from this package directory with:

```bash
node --conditions=source --experimental-strip-types test/examples/13-chat.ts
```

| Example | Shows |
|---|---|
| [13-chat](test/examples/13-chat.ts) | One question and answer |
| [15-real-model](test/examples/15-real-model.ts) | Streaming an answer from OpenAI |
| [16-coding-tools](test/examples/16-coding-tools.ts) | A tool-using turn on JSONL storage |
| [17-print](test/examples/17-print.ts) | Print mode: submit a prompt, print the answer |
| [18-json](test/examples/18-json.ts) | JSON mode: raw view operations, or appended entries and `pi.live` per change, on SQLite, JSONL, or memory |
| [19-inbox](test/examples/19-inbox.ts) | Steers, follow-ups, writes, and withdrawal while busy |
| [20-late-join](test/examples/20-late-join.ts) | Attaching a view mid-run: the running tool's output, then the streamed answer |
| [21-subagent-foreground](test/examples/21-subagent-foreground.ts) | A replay-safe subagent tool whose child the call owns, with the child's transcript under the call |
| [22-subagent-background](test/examples/22-subagent-background.ts) | Persistent subagents: spawn, steer, stop, list, answers reported back, restart-safe |
| [23-child-tasks](test/examples/23-child-tasks.ts) | A checkout that owns and waits for four payments: failFast, abort, restart |
| [24-compaction](test/examples/24-compaction.ts) | A long chat compacted in the background, manually, and after a context overflow |
| [25-coding-agent](test/examples/25-coding-agent.ts) | CodingTools, live settings from a settings object, an environment that follows the conversation's directory |
| [26-plan-mode](test/examples/26-plan-mode.ts) | A read-only plan mode as an extension with its own document, switched with `configure()` |
| [27-reviewer](test/examples/27-reviewer.ts) | A reviewer conversation with its own model, extensions, tools, directory, and review loop |
| [28-sandbox-per-conversation](test/examples/28-sandbox-per-conversation.ts) | An environment per conversation, looked up from an app document |
| [29-tool-override](test/examples/29-tool-override.ts) | A same-name bash for some conversations, and a wrapper that times whichever bash won |
| [30-reload-and-restart](test/examples/30-reload-and-restart.ts) | Reloading an extension mid-call, and stored choices surviving a restart |
| [31-transcript](test/examples/31-transcript.ts) | A client's transcript over the windowed view: live appends, a stall with a gap, loading it and earlier pages, and resuming with `from` |
| [32-tests-after-edits](test/examples/32-tests-after-edits.ts) | An `afterRun` hook that runs the tests after every run that edited files, a fix run when they fail, and input waiting for them |
| [33-turn-limit-and-continue](test/examples/33-turn-limit-and-continue.ts) | A per-conversation turn limit, `runFailure`, and continuing without a user message |
| [34-submit-in-commit](test/examples/34-submit-in-commit.ts) | Admitting a visitor's steer inside the host's own commit with `submit(tx, draft)` and `whenIdle: "reject"` |
| [35-durable-on-the-store](test/examples/35-durable-on-the-store.ts) | A Harness on `StoreStorage` in a Chord host's store, next to a Chord object's own table: one commit queue, one id allocator, one export |
| [36-durable-views](test/examples/36-durable-views.ts) | A Chord object following a Durable view with `self.follow`: its frames and a member reading the followed value |
| [00](test/examples/00-conversation.ts)–[12](test/examples/12-recovery.ts) | The layers underneath: sessions, documents, forks, watches, the Harness, agent configuration, reload, extension state, tasks, recovery |

Examples that call OpenAI need `OPENAI_API_KEY`; most use the faux provider otherwise.

## Design Documents

- [`docs/spec.md`](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md): the normative specification

Benchmarks: `npm run bench:storage`, `npm run bench:storage:memory`, `npm run bench:tool-output`, and `npm run bench:nested-tools`.

## License

MIT
