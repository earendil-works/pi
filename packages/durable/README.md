# @earendil-works/pi-durable

> **Experimental.** The API changes without notice between releases.

A durable agent harness. Conversations, model turns, tool calls, and your own state are committed to storage before anything is shown. If the process dies mid-turn, reopening the storage picks the work up where it stopped.

Built on [`@earendil-works/pi-ai`](../ai/README.md) for model access and `@earendil-works/chord` for document state.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Concepts](#concepts)
- [Persist and Resume](#persist-and-resume)
- [Tools](#tools)
- [System Prompt](#system-prompt)
- [Conversation Settings](#conversation-settings)
- [Watching a Conversation](#watching-a-conversation)
- [Busy Conversations](#busy-conversations)
- [Reset and Handoff](#reset-and-handoff)
- [Agent Events (Experimental)](#agent-events-experimental)
- [Hooks](#hooks)
- [More Conversations and Forks](#more-conversations-and-forks)
- [Your Own State](#your-own-state)
- [Usage and Cost](#usage-and-cost)
- [Storage](#storage)
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
const root = await harness.root(context);
await root.setModel({ provider: "openai", modelId: "gpt-6-sol" }, context);

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
- `root()` returns the root conversation, creating it on first use. A conversation is a transcript of immutable entries.
- `submit()` durably admits your input and returns a `Submission`. A built-in generation task calls the model and appends the answer.
- `wait()` resolves once the input is answered (`done`) or has failed (`unanswered`, with a reason).

Every async call takes a Chord `Context`, which carries cancellation. `BACKGROUND_CONTEXT` never cancels. Cancelling a wait only cancels that wait, never the work.

## Concepts

- **Harness**: one open storage plus the machinery that runs agents on it. All changes go through one line of atomic commits, and nothing is shown before its commit is stored.
- **Conversation**: a transcript. `root()` creates the root conversation on first use; you can create more and fork them. A `Conversation` handle holds no state; compare handles by `id`.
- **Entry**: one immutable transcript record, such as a user message (`pi.user`), a model response (`pi.assistant`), a tool result (`pi.tool-result`), a system prompt change (`pi.system`), a reset (`pi.reset`), or your own kind. The model sees the entries from the newest reset onward.
- **Commit**: an atomic write. `conversation.commit((tx) => ...)` can append entries, edit documents, and create tasks together; either all of it is stored or none of it.
- **Document**: typed JSON state stored next to the transcript and changed in commits. Built-in ones hold each conversation's settings (`pi.conversation.config`), the running generation and tools (`pi.live`), queued submissions (`pi.inbox`), and spend (`pi.usage`).
- **Task**: a durable state machine that saves a checkpoint at every step, so a restarted process continues from the last one. The Harness runs answers as built-in tasks: `pi.generation` calls the model, `pi.tool` runs one tool call, and `pi.post-tools` continues once a round's tools are done.
- **Submission**: something you hand to a conversation, either user input or an entry to write, which you can wait for.
- **Turn and run**: a turn is one model response and its tool calls; a run is the turns from an input to its final answer. A conversation is busy while a run is going.
- **Registry**: your tools, system prompt sections, hooks, and tasks. It can change while the Harness runs; new work uses the new state.

One answered input, as entries and tasks:

```text
submit(input) → pi.user
  pi.generation → pi.system (only if the prompt or tools changed), pi.assistant (tool calls)
  pi.tool × n   → pi.tool-result × n
  pi.post-tools
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

Work interrupted by a crash or close stays pending. `resume()` starts the task scheduler; submitting or waiting starts it too. A retried submission with the same `requestId` returns the existing submission instead of submitting twice:

```typescript
const submission = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// After a restart: the same request ID finds the same submission.
const again = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// again.id === submission.id
```

`harness.submission(id)` reacquires a submission by ID, for example to wait for it after a restart.

## Tools

`@earendil-works/pi-durable/tools` provides `read`, `bash`, `edit`, and `write`. They touch files and processes only through the execution environment passed as `env`:

```typescript
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

const registry = createRegistry();
for (const tool of [createReadTool(), createBashTool(), createEditTool(), createWriteTool()]) registry.tools.add(tool);
const env = new NodeExecutionEnv({ cwd: process.cwd() });
const harness = await Harness.open(storage, { models, registry, env }, context);
```

A new conversation activates every tool registered when it is created. Reading images is not supported yet.

Define your own tool with a TypeBox schema. `api.output()` streams running output, which becomes the result when `execute()` returns no `content`:

```typescript
import { Type } from "@earendil-works/pi-ai";

registry.tools.add({
	name: "count",
	description: "Count from 1 to n",
	parameters: Type.Object({ n: Type.Number() }),
	execute: async (args, api) => {
		for (let i = 1; i <= (args as { n: number }).n; i++) api.output(`${i}\n`);
		return {};
	},
});
```

Each call runs as its own durable task. Its intent is committed before `execute()` runs. If the process dies mid-call, the tool reruns on reopen only when it is declared `replay: "safe"`; otherwise the model gets an `interrupted` error result with the output committed so far. Throwing from `execute()` gives the model an error result. A result can also return `usage`, which is added to the conversation's [usage](#usage-and-cost). It can also return `control: { terminate: true }`: when every result of the round asks for it, the run ends without another model request.

## System Prompt

The system prompt is built from named sections, rendered before each request:

```typescript
registry.systemPrompt.section("preamble", () => "You are a concise coding assistant.", { tag: false });
registry.systemPrompt.section("cwd", () => process.cwd()); // rendered as <cwd>\n...\n</cwd>
```

Sections and tool changes are stored as positional system entries in the transcript. Only what changed is sent again, which keeps provider prompt caches warm. A section that returns something different every time, such as the current time, defeats that.

## Conversation Settings

Each conversation has durable settings, readable and writable through the handle:

```typescript
await root.setModel({ provider: "openai", modelId: "gpt-6-sol" }, context);
await root.setThinkingLevel("high", context);
await root.setActiveTools(["read", "bash"], context);
await root.setToolExecution("sequential", context); // default "parallel"
await root.setRetryPolicy({ enabled: true, maxRetries: 3, baseDelayMs: 2000 }, context);
await root.setStreamOptions({ timeoutMs: 120_000 }, context);
```

Changes apply when the next model request is prepared, not in the middle of one.

## Watching a Conversation

Everything a UI needs is committed state. `viewState()` returns the conversation's structural view as a read-only Chord state, updated after every commit that touches it:

```typescript
const view = await root.viewState(context);
view.subscribe((value) => {
	// value.entries: the active transcript
	// value.docs["pi.live"]: the running generation (streamed partial, retry, deferred) and tool calls (output, details)
	// value.docs["pi.inbox"], value.docs["pi.usage"], value.docs["pi.conversation.config"]
	render(value);
});
// later: view.dispose();
```

`watch()` delivers the same view with the exact Chord operations of each commit, one callback at a time:

```typescript
const watch = await root.watch(context);
render(watch.value); // the state at attachment
watch.start(async (value, ops) => {
	await send(ops); // for example to a remote client that applies them
});
// later: await watch.stop();
```

A slow watch keeps at most 100 undelivered frames. After that, the pending frames are replaced by one frame holding the whole newest view. A client that joins late or reconnects starts from the current view; nothing is replayed.

Partial answers and tool output are committed at most every 100 ms, so a crash loses at most that window.

## Busy Conversations

A conversation is busy while a run is working on an input. Submitting to a busy conversation queues the submission in the conversation's inbox, `docs["pi.inbox"]` in the view:

```typescript
await root.submit({ type: "input", content: "Also run the tests" }, context); // follow-up (default)
await root.submit({ type: "input", content: "Use pnpm, not npm", whenBusy: "steer" }, context);
await root.submit({ type: "input", content: "Only if idle", whenBusy: "reject" }, context); // throws ConversationBusy
await root.submit({ type: "write", entry: { kind: "app.note", data: "user opened a file" } }, context);
```

- **Steers** are placed after the current tool round and join the running work.
- **Follow-ups** are placed when the run answers, and start the next run.
- **Writes** append an entry without asking the model anything.
- `await submission.abort(context)` withdraws a queued submission.
- `setSteeringMode("all")` and `setFollowUpMode("all")` place every queued item at once instead of one per turn.

If a run fails, queued items stay in the inbox until the next submission places them, oldest first.

## Reset and Handoff

`reset()` starts a new context. The model no longer sees older entries, but they stay in storage:

```typescript
await root.reset(undefined, context);                                  // start from nothing
await root.reset("We were fixing the flaky login test. Continue.", context); // start from a handoff note
```

While busy, the reset is queued like a write. When it is placed during a tool round, the current run ends. A tool can request the same with `control: { handoff: "..." }`.

## Agent Events (Experimental)

For consumers that want coding-agent style events (`message_start`, `message_update`, `tool_execution_start`, ...) instead of structural state:

```typescript
import { watchEvents } from "@earendil-works/pi-durable";

const stream = await watchEvents(harness, root.id, context);
initialize(stream.snapshot); // entries, run, in-flight generation, tools, inbox, config, usage
stream.start(async (events) => {
	for (const event of events) console.log(JSON.stringify(event));
});
```

Events are derived from commits, one batch per commit, and apply on top of the snapshot. Message and tool updates carry deltas: text and thinking appends, appended tool-call argument text, and output trims and appends. When a consumer falls more than 100 batches behind, it receives a fresh `snapshot` event instead. See `test/examples/19-json.ts` for the full stream of one run.

## Hooks

Hooks let extensions observe or adjust the built-in tasks:

```typescript
import { GenerationTask, ToolTask } from "@earendil-works/pi-durable";

registry.hooks.add(ToolTask, {
	beforeTool: (call) => (call.name === "bash" ? { block: "bash is disabled here" } : undefined),
});
registry.hooks.add(GenerationTask, {
	onYield: (answer) => (needsMoreWork(answer) ? { continue: "Keep going." } : undefined),
});
```

- **Generation:** `beforeRequest` (replace the messages of one request), `afterResponse`, and `onYield` (continue the run with another user message).
- **Tools:** `beforeTool` (block or rewrite arguments) and `afterTool` (replace the result).
- **Post-tools:** `afterTools` (runs once a round's tools are done).

Pass `{ scope: { conversationId } }` to limit a hook to one conversation.

## More Conversations and Forks

```typescript
const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
const fork = await root.fork(entryId, { ownership: { kind: "ownerless" } }, context);
```

A fork sees its parent's entries up to `entryId` and continues independently. It keeps the parent's settings as of that entry.

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
});

await root.commit(async (tx) => {
	(await tx.doc(Todos, root.id)).items.push("write docs");
}, context);
console.log(await harness.snapshot(Todos, root.id, context));
```

`harness.watchDoc()` and `harness.documentState()` observe one document like the view above. `registry.conversations.setup()` creates your documents in every new conversation, and a tool reads them through its `api`.

## Usage and Cost

Each conversation keeps token and cost totals in `docs["pi.usage"]`: per `provider/model` for model responses, and per tool name for tool results that report usage. Failed and aborted attempts count too. For the whole Session:

```typescript
const usage = await harness.usage(context); // { models: { "openai/gpt-6-sol": Usage }, tools: {...} }
```

## Storage

| Backend | Import | Notes |
|---|---|---|
| Memory | `MemoryStorage` from the package root | Nothing is persisted. |
| SQLite | `openNodeSqliteStorage(file)` from `@earendil-works/pi-durable/storage/sqlite/node` | One database file. WAL mode with `synchronous = NORMAL`: commits survive process crashes; the newest may be lost on power or host failure. |
| JSONL | `openNodeJsonlStorage(directory, context)` from `@earendil-works/pi-durable/storage/jsonl/node` | Append-only files in one directory. Pass `{ fsync: true }` to flush before each commit marker. |

One process owns a storage at a time; there is no cross-process locking. The portable SQLite and JSONL cores (`/storage/sqlite`, `/storage/jsonl`) run without Node APIs, for example on Bun or in Cloudflare Durable Objects, given a synchronous SQLite database or a `FileSystem` from `@earendil-works/pi-durable/env`.

Custom backends can run the shared conformance suite with any Vitest- or Jest-compatible runner:

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

## Examples

Runnable examples live in [`test/examples`](test/examples). Run one from this package directory with:

```bash
node --conditions=source --experimental-strip-types test/examples/14-chat.ts
```

| Example | Shows |
|---|---|
| [14-chat](test/examples/14-chat.ts) | One question and answer |
| [16-real-model](test/examples/16-real-model.ts) | Streaming an answer from OpenAI |
| [17-coding-tools](test/examples/17-coding-tools.ts) | A tool-using turn on JSONL storage |
| [18-print](test/examples/18-print.ts) | Print mode: submit a prompt, print the answer |
| [19-json](test/examples/19-json.ts) | JSON mode: agent events or raw view operations, on SQLite, JSONL, or memory |
| [20-inbox](test/examples/20-inbox.ts) | Steers, follow-ups, writes, and withdrawal while busy |
| [21-late-join](test/examples/21-late-join.ts) | Attaching a view and an event stream mid-run |
| [00](test/examples/00-conversation.ts)–[13](test/examples/13-recovery.ts) | The layers underneath: sessions, documents, forks, watches, tasks, recovery |

Examples that call OpenAI need `OPENAI_API_KEY`; most use the faux provider otherwise.

## Design Documents

- [`docs/pico-v5.md`](docs/pico-v5.md): the normative specification
- [`docs/pico-v5-handoff.md`](docs/pico-v5-handoff.md): the implementation plan
- [`docs/pico-v5-chord-usage.md`](docs/pico-v5-chord-usage.md): how the package uses Chord

Benchmarks: `npm run bench:storage`, `npm run bench:storage:memory`, and `npm run bench:tool-output`.

## License

MIT
