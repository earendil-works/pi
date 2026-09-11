# pico

Durable agent harness for pi: one session file, any number of conversations, every piece of work
recorded as a task that survives a crash, and a view any UI can render.

**Note**: this guide is about using the harness. `pico-v3.md` is the design and the reference for
why things are the way they are. Tool/sink/preview interfaces and their examples are provisional:
we still need a simpler authoring surface before implementing them. Their required capabilities and
storage/cancellation guarantees are retained; the separate steps proposal has not been adopted.

## Table of Contents

- [The Mental Model](#the-mental-model)
- [Calls and Cancellation](#calls-and-cancellation)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Sessions and Conversations](#sessions-and-conversations)
  - [Opening](#opening)
  - [What Happens on Reopen](#what-happens-on-reopen)
  - [Closing](#closing)
- [Configuration](#configuration)
  - [Settings Declared by Kinds](#settings-declared-by-kinds)
  - [Reading and Writing](#reading-and-writing)
  - [What Is Rewindable](#what-is-rewindable)
- [System Prompt and Tool Loadout](#system-prompt-and-tool-loadout)
  - [How It Works](#how-it-works)
  - [Answering the Hook](#answering-the-hook)
  - [Changing the Loadout](#changing-the-loadout)
  - [Sections from Plugins](#sections-from-plugins)
  - [Subagents Have Their Own](#subagents-have-their-own)
  - [Compaction, Forks and Restarts](#compaction-forks-and-restarts)
- [Prompting](#prompting)
  - [prompt, accept, drive](#prompt-accept-drive)
  - [Input While Busy](#input-while-busy)
  - [Aborting](#aborting)
- [Watching](#watching)
  - [The View](#the-view)
  - [Events](#events)
  - [Rendering](#rendering)
  - [Remote Clients](#remote-clients)
  - [Session Watch](#session-watch)
- [Forks](#forks)
- [Compaction and Reset](#compaction-and-reset)
- [Subagents](#subagents)
- [Jobs and Schedules](#jobs-and-schedules)
- [Plugin State](#plugin-state)
  - [Values and Lists](#values-and-lists)
  - [Atomic Commits](#atomic-commits)
- [Writing Tools](#writing-tools)
  - [The Sink](#the-sink)
  - [Diagnostics](#diagnostics)
  - [Long-Running Tools](#long-running-tools)
- [Hooks](#hooks)
- [Writing Kinds](#writing-kinds)
  - [Entry Kinds](#entry-kinds)
  - [Task Kinds](#task-kinds)
- [Recovery](#recovery)
- [Storage Backends](#storage-backends)

## The Mental Model

A **session** is one storage file (or one row set in SQLite). It holds **conversations**. A
conversation has three things:

- a **transcript**: an append-only list of immutable **entries**. User messages, assistant messages,
  tool results, summaries, system instructions, and anything a plugin wants to record. Entries are
  never edited or reordered.
- **tasks**: the units of work. Generating a response is a task, running a tool is a task, so is
  compacting, running a background process, or anything a plugin wants done. A task has a status
  that changes as it runs and is written to storage at every step, which is what makes a crash
  recoverable.
- **state**: keyed **values** and **lists**, for the model in use, plan mode, a game board, whatever
  a plugin needs to remember.

What the model sees, the **context**, is not stored as a list. Each entry may store `model`
messages, a **head** boundary, and **edits** that omit or replace earlier model messages. The harness
prepends the newest head, reads forward from its stored boundary, folds retained edits, then performs
request-local tool and provider normalization. Compaction appends a head; tool-result pruning
appends an edit. Forks, compaction and reset never mutate old entries.

Every id is a session sequence number, minted when the write is built and never changed:

```typescript
type Id = number;
```

All writes happen through **commits**: a closure that runs on the session's single write line,
where everything inside it lands together or not at all. Tasks run concurrently; writes never do.

Nothing runs by itself. Opening a session starts nothing. **Driving** a conversation is what makes
its tasks execute, and a `prompt` is just accept + drive + read the answer. A UI **watches** a
conversation and gets a **view** it can render from directly.

## Calls and cancellation

Every asynchronous harness, conversation and task-runtime operation takes a required final `Call`.
`Call` is a type alias of Chord `Context`: it carries an abort signal, telemetry parent and, for task
code, a private typed invocation identity. It is not model context. No casts or admission helpers
are needed. Pure accessors, synchronous registrations and methods inside a transaction take no Call.

```typescript
import type { Call } from '@earendil-works/pi-agent';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';

const call: Call = BACKGROUND_CONTEXT; // host call, without cancellation
const { context: waitingCall, cancel } = withCancel(call);
const waiting = conversation.drive(waitingCall);
cancel();                            // removes this waiter; does not abort durable work
await waiting;                       // rejects with cancellation
```

Tasks receive `(task, runtime: TaskRuntime, call: Call)` and forward `call`. Tools receive
`(toolCallId, params, out, runtime: ToolRuntime, call: Call)`. Environment/provider/hook operations
interpret the signal; custom handlers must cooperate. Derive a Call for nested telemetry or a tighter
deadline and pass it onward. The driver does not inherit a drive caller's signal into task execution.

The line reads task identity through a private `createContextKey<Invocation>`; Chord returns the
correct type from `call.value(key)`. Derived calls preserve that exact object. Stale task writes
reject. No invocation identity is serialized over RPC; trusted host bindings supply it locally.
Deliberately using an unrelated host Call or ignoring cancellation is an in-process escape, not
something a facade or type can prevent.

## Installation

```bash
npm install @earendil-works/pi-agent
```

## Quick Start

```typescript
import { Harness, JsonlStorage, systemSections, type Call } from '@earendil-works/pi-agent';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { readTool, writeTool, bashTool } from '@earendil-works/pi-agent/tools';
import { generationKind } from '@earendil-works/pi-agent/kinds';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const call: Call = BACKGROUND_CONTEXT;

// One file per session. Reopening the same file resumes it.
const storage = await JsonlStorage.open('./session.jsonl');

// The built-in kinds (generation, tool, post_tools, collapse, job; the entry kinds) and the
// subagent and job tools are registered by open. You add models and the tools you want. Nothing runs yet.
const h = await Harness.open(storage, {
  models: builtinModels(),
  tools: [readTool, writeTool, bashTool],
  // Address/value pairs, applied only when creating the root; reopening preserves stored settings.
  rootValues: [
    [generationKind.config.model, { provider: 'anthropic', modelId: 'claude-opus-5' }],
    [generationKind.config.thinking, 'high'],
    [generationKind.config.selectedTools, ['read', 'write', 'bash']],
  ],
}, call);

const c = await h.root(call);

// Configuration is durable state; this hook edits the prepared section payloads.
// The harness stores changed payloads and rendered system messages before each request.
c.hooks.on(generationKind, 'system_instructions', ({ sections, config }, call) => {
  sections.set(systemSections.identity, 'You are a careful engineer working in this repository.');
  sections.set(systemSections.environment, { cwd: process.cwd() });
  return { tools: h.tools.select(config.selectedTools) }; // complete tool definitions
}, { subtree: true });

// Watch the conversation. `view` is a plain object a UI renders from; attach whenever you like,
// the view is complete as of the moment you attach and events follow from there.
const w = await h.watch(c.id, { tail: 100 }, call);
w.start(event => {
  if (event.type === 'task_output') {
    // the generation's preview is the partial assistant message; a tool's is its output so far
    const preview = w.view.previews.get(event.task);
    process.stdout.write(renderPreview(preview));
  }
  if (event.type === 'entry') console.log(`\n[entry ${event.entry.id} ${event.entry.kind}]`);
});

// accept the input, drive the conversation until it is idle, return the answer to that input
const answer = await c.prompt({ input: 'Inspect the parser and list the public API' }, call);
console.log(answer?.model[0]?.content);

w.unsubscribe();
await h.close(call);   // cancels nothing durable; reopening the file continues exactly here
```

Run it, kill it in the middle, run it again: the second run recovers whatever was in flight
(publishing a partial answer, rerunning or reporting an interrupted tool) and continues. That is the
whole point.

Snippets below assume `h`, `c` and `call` set up like this. Optional options before Call are passed
as `undefined` when unused. A task or hook always forwards its supplied Call, not this host root.

## Sessions and Conversations

### Opening

`Harness.open(storage, options, call)` takes the storage backend and everything that defines behaviour:

| option | what it is |
|---|---|
| `models` | a pi-ai `Models` collection |
| `tools` | what the model may call, besides the built-in `subagent` and `job` tools; a `ToolRegistry` or an array |
| `kinds` | plugin entry and task kinds, added to the built-ins |
| `replace` | a built-in kind swapped by name (`{ generation: myGenerationKind }`); it must keep the statuses and hook names |
| `rootValues` | explicit initial root configuration, applied only in the fresh root's creation commit |
| `sections` | initial custom typed section definitions, in addition to built-ins |

Registries supply implementations, not selections. Registering read/write/edit/bash does not
select them automatically. Supply initial model/thinking/selectedTools through `rootValues`, or
configure the fresh conversation before generation. On reopen, `rootValues` is ignored: durable
configuration wins. Children inherit the values selected by their spawn policy; forks inherit
rewindable configuration at the fork point. Missing required generation configuration is an error.

The built-in kinds are registered by `open` itself, because `accept`, `prompt`, `steer` and
`collapse` cannot work without them. Refer to whatever is registered through `h.kinds`:

```typescript
h.kinds.generation   // config: model, thinking, selectedTools, ...; hooks: system_instructions, before_request, on_yield
h.kinds.tool         // hooks: before_tool, after_tool
h.kinds.collapse     // hooks: before_collapse
h.kinds.job
```

A replacement is usually a wrapper that delegates to the original for everything it doesn't
change:

```typescript
import { generationKind } from '@earendil-works/pi-agent/kinds';
const h = await Harness.open(storage, { models, tools, replace: {
  generation: { ...generationKind, async execute(task, runtime, call) { await audit(task); return generationKind.execute(task, runtime, call); } },
}}, call);
```

Open checks the recorded kind strings without scanning the transcript and reports live work, but
starts nothing. An unregistered historical entry kind is reported, not rejected: its stored
`model`, `head` and `edits` still build context, while its typed data and custom renderer are
unavailable. Missing live task kinds are handled according to foreground/background status:

```typescript
const { start, inflight, orphaned, parked } = await h.inspect(call);
// start: tasks that never began or must begin again (a planned tool, a retry, a scheduled job)
// inflight: tasks the last process was running when it stopped; recover() will handle them
// orphaned: foreground tasks whose kind is missing (a plugin was uninstalled); settled at open
// parked:   background tasks whose kind is missing; they resume when it is registered again
```

### What Happens on Reopen

Nothing, until something drives a conversation. `h.drive()` starts and recovers eligible foreground
and background work across the session; `c.drive()` does the same for one conversation's ownership
scope. Each promise resolves when its scope has no live foreground task. Its attached background
work remains served afterwards. A UI usually attaches a watch to what it shows and drives that.

```typescript
const h = await Harness.open(storage, opts, call);
void h.drive(call).catch(error => console.error(error)); // resume; report session faults
```

### Closing

```typescript
await h.close(call);         // cancel in-process work, write nothing; everything resumes on the next open
await h.shutdown(call);      // mark live tasks, wait for abort cleanup, close; queued input survives
```

`close` is the normal exit: it stops admission on the commit line, then signals and joins owned
invocations outside it, without writing task outcomes. Earlier line operations have already finished;
later mutations reject. Close waits for actual invocation completion, regardless of caller cancellation.
An uncooperative task can delay it indefinitely.

`shutdown` closes normal admission and atomically marks live tasks only. Queued input and its queued
result records remain stored, including in idle conversations. Fresh abort handlers resolve their
already-running input groups and finish cleanup. Built-in child cleanup marks tasks only, never drains
child queues, including after a crash and reopen. Shutdown waits for both live tasks and running calls
to disappear before closing. Preserved queues create no work by inference on reopen/drive.

Once admitted, caller cancellation does not abandon shutdown. Repeated lifecycle calls share
completion; explicit close interrupting shutdown makes shutdown reject. Task calls cannot invoke
host lifecycle methods.

## Configuration

### Settings Declared by Kinds

There is no settings object. A task kind declares the values it reads, typed, and that declaration
is the only place the address is spelled:

```typescript
generationKind.config
// {
//   model:         conversationValue<ModelRef>('pi.model', { rewind: true }),
//   thinking:      conversationValue<ThinkingLevel>('pi.thinking', { rewind: true }),
//   selectedTools: conversationValue<string[]>('pi.tools.selected', { rewind: true }),
//   profile:       conversationValue<string>('pi.prompt.profile', { rewind: true }),
//   budgetMs:      conversationValue<number>('pi.tool.budget', { rewind: false }),
// }
```

A UI can list what a conversation is configured with by walking the registered kinds' `config`;
a plugin declares its own values the same way (see [Task Kinds](#task-kinds)).

### Reading and Writing

```typescript
// all of a kind's values, one batched read
const { model, thinking } = await c.config(generationKind).get(call);

// some of them, one commit
await c.config(generationKind).set({ thinking: 'low' }, call);

// `settings` is config(generationKind), because that is what every UI touches
await c.settings.set({ model: { provider: 'openai', modelId: 'gpt-5.6' } }, call);

// one value, one point read, by its declared address
const tools = await c.value(generationKind.config.selectedTools).get(call);
```

A change is a normal commit: it appears in the watch stream as a `value` event, and the next
generation picks it up. Nothing is cached in memory that could disagree with storage.

### What Is Rewindable

A value is either **rewindable** (its history is kept, a fork at an entry sees the value in force
there) or **sticky** (current only; the UI's present, not the conversation's history). Model,
thinking and selected tools are rewindable: forking at yesterday's answer gets yesterday's model.
Something like `ui.expanded` is sticky.

Children created by `spawn` don't inherit history; they are initialized explicitly (see
[Subagents](#subagents)).

## System Prompt and Tool Loadout

### How It Works

Pico sends pi-ai only `{ messages }`: no parallel top-level `systemPrompt` or `tools`. Managed system
entries contain the exact rendered pi-ai messages, including complete tool additions/removals. Pi-ai
owns native/fallback translation and best-effort cache preservation.

Configuration changes remain ordinary durable value writes. System entries separately record the
instructions prepared for requests—not proof of delivery. Host files, discovery caches, callbacks and
renderer functions are not stored. Section JSON payloads and final rendered text are stored, so a
missing plugin cannot make historical requests depend on its renderer.

The target pi-ai system-message API and messages-only adapter behavior are integration prerequisites
([#9116](https://github.com/earendil-works/pi/pull/9116), with coding-agent integration in
[#9117](https://github.com/earendil-works/pi/pull/9117)). They were open when reviewed; this guide describes
the intended contract, not a claim that those PRs already implement the agreed adapter behavior.

### Answering the Hook

A typed section token names the payload and its append-time renderer:

```typescript
interface SystemSection<T> {
  readonly key: string;
  render(value: T): string;
}

const rulesSection = defineSystemSection<string[]>({
  key: 'myplugin.rules',
  render: rules => rules.map(rule => `- ${rule}`).join('\n'),
});
await h.sections.register(rulesSection, call);
```

Tokens use stable string keys in storage. Payloads must be JSON-representable; changing a registered
payload type requires a compatible replacement or migration. The typed token supplies normal get/set
inference without casts in plugin code. Built-ins export tokens through `systemSections`, such as
identity, environment and skills; their values come from the host, not from the registry.

Each generation seeds one private ordered section draft from the last durable prepared state. Handlers
run sequentially, harness-wide first and innermost conversation last, editing that same draft:

```typescript
c.hooks.on(generationKind, 'system_instructions', ({ sections, config }, call) => {
  sections.set(systemSections.identity, 'You are a coding assistant.');
  sections.set(systemSections.skills, skillsCache.current); // complete typed skill data
  sections.set(rulesSection, ['Run relevant tests.']);       // authoritative base for later transforms
  return { tools: h.tools.select(config.selectedTools) };  // complete selected JSON definitions
}, { subtree: true });
```

The draft provides:

```typescript
interface SystemSectionDraft {
  get<T>(section: SystemSection<T>): T | undefined;
  set<T>(section: SystemSection<T>, value: T): void;
  delete(section: string | { readonly key: string }): void;
  wrap<T>(section: SystemSection<T>, transform: (text: string) => string): void;
}
```

`get` returns an owned copy; use `set` to change the draft. Existing keys retain their position; new
keys append. `delete` is explicit—null remains a valid payload. Registered compatible definitions are
required for typed get/set/wrap; deletion can use a stable key even if its definition is unavailable.
No ordering configuration exists, and reordering alone emits no update.

After handlers finish, touched sections render outside the line. Wrappers apply in registration order
after rendering. The frozen result is diffed against stored payloads and rendered text. Changed data
with unchanged rendering produces a metadata-only system entry (`model: []`); changed rendering with
unchanged data still produces a system-message update. No historical read runs these functions.

### Sections from Plugins

A later handler can modify a built-in section's structured payload, not parse its prose:

```typescript
c.hooks.on(generationKind, 'system_instructions', ({ sections }, call) => {
  const skills = sections.get(systemSections.skills); // typed skill array | undefined
  sections.set(systemSections.skills,
    (skills ?? []).filter(skill => skill.name !== 'deploy'));
});
```

Appending to the same key is ordinary typed get-and-set:

```typescript
c.hooks.on(generationKind, 'system_instructions', ({ sections }, call) => {
  sections.set(rulesSection, [
    ...(sections.get(rulesSection) ?? []),
    'Check migration safety.',
  ]);
  sections.wrap(rulesSection, text => `Repository policy:\n${text}`);
});
```

This example relies on the earlier host handler resetting `rulesSection` to its authoritative base
on every preparation. Without that reset, repeatedly appending to a persisted seed accumulates text.
The whole transformation chain must produce the same result when applied again, or start from a
refreshed base; individually idempotent handlers are not sufficient when they interact.

Wrappers are preparation-local. Untouched sections keep their stored rendered text, including old
wrapper output when the contributing plugin disappears. Explicit set/wrap or a renderer replacement
recomputes it. Refreshing the base deliberately rebuilds wrappers from currently installed handlers;
we do not promise to preserve missing wrappers across that refresh.

Skills discovery can remain in the hook owner's closure or a host service. Watch local changes or poll
a remote source at a bounded interval; hook calls read the cached snapshot. Failed refresh is not
removal: retain the last successful snapshot. The base hook explicitly deletes its section when the
source really disappears. If a handler fails and is skipped, discard its draft mutations/wrappers,
not earlier handlers' changes; a half-finished refresh must not remove instructions. No discovery callback or private cache state is attached to stored sections.

### Changing the Loadout

Configuration is durably persisted when changed:

```typescript
await c.settings.set({ selectedTools: ['read', 'grep'] }, call);
```

The next preparation renders the final draft and compares it with previous prepared state. A transcript
might look like this (`readDefinition` etc. mean complete JSON definitions, not executable functions):

```text
100 user
110 system baseline: identity + rules; add read/write
120 assistant
125 config write: selectedTools=read/grep             (durable state, not a transcript entry)
130 user
140 system delta: changed rules; remove write; add grep
150 assistant
```

Stored baseline:

```typescript
const baseline: SystemEntry = {
  id: 110, conversationId: 1, kind: 'system',
  data: { baseline: true, sections: [
    { key: 'pi.identity', action: 'set',
      value: 'You are a coding assistant.', rendered: 'You are a coding assistant.' },
    { key: 'myplugin.rules', action: 'set',
      value: ['Run relevant tests.'], rendered: '- Run relevant tests.' },
  ] },
  model: [{
    role: 'system',
    content: '## pi.identity\nYou are a coding assistant.\n\n' +
      '## myplugin.rules\n- Run relevant tests.',
    toolsAdded: [readDefinition, writeDefinition], timestamp: 1000,
  }],
};
```

Stored change after a plugin modifies rules:

```typescript
const change: SystemEntry = {
  id: 140, conversationId: 1, kind: 'system',
  data: { sections: [{ key: 'myplugin.rules', action: 'set',
    value: ['Run relevant tests.', 'Check migration safety.'],
    rendered: '- Run relevant tests.\n- Check migration safety.',
  }] },
  model: [{
    role: 'system',
    content: 'The myplugin.rules section now reads:\n' +
      '- Run relevant tests.\n- Check migration safety.',
    toolsRemoved: [writeDefinition], toolsAdded: [grepDefinition], timestamp: 2000,
  }],
};
```

Tool definitions live only in SystemMessage fields, not duplicated in section data. Compare definitions
structurally by name; a changed schema/description is a complete `toolsAdded` upsert. Removal includes
the previous complete stored definition. Apply removals before additions. Tool-only changes may have
empty instruction content. Hooks supplying tools replace the complete desired loadout; the last
supplied list wins, and no list means no desired tools.

Explicit section deletion stores `{ key, action: 'remove' }` and a system message saying that section
no longer applies. Omitting a hook or unregistering its definition is not deletion.

Pico sends:

```typescript
const request = {
  messages: [user100, ...baseline.model, assistant120, user130, ...change.model],
}; // no top-level systemPrompt or tools
```

For unsupported provider/model combinations, pi-ai translates system messages to `<system>`-bracketed
user messages at their historical positions and derives any bulk wire tool declarations it needs.
Pico never hoists the baseline or flattens changes into a rewritten top-level prompt. Cache preservation
is best-effort; a fallback user message does not have native system priority.

### Subagents Have Their Own

Children explicitly choose their durable configuration. Subtree handlers supply defaults, and inner
hooks can replace built-in payloads or add sections:

```typescript
const childId = await c.spawn({ prompt: 'Audit the tests',
  values: { inherit: [generationKind.config.model],
    set: [[generationKind.config.selectedTools, ['read', 'grep']]] },
}, call);
const child = await h.conversation(childId, call);
child.hooks.on(generationKind, 'system_instructions', ({ sections }, call) => {
  sections.set(systemSections.identity, AUDITOR_IDENTITY);
});
```

Definitions can be supplied initially through `Harness.open(..., { sections: [...] }, call)` or changed
later through `h.sections.register/replace/remove`. Registration is mutable process state, serialized
on the line; an in-flight preparation retains its definition snapshot. `register` rejects duplicate
keys; `replace` is explicit and compatible; `remove` unregisters code without erasing stored sections.
Entry/task registries follow the parallel `h.entryKinds`/`h.taskKinds` API. Task-kind removal rejects
while live tasks of that kind exist. Missing kinds at open orphan foreground tasks and park background
tasks, as described under [Opening](#opening); registration restores recovery for parked work in an
attached scope, never resurrects terminal tasks.

### Compaction, Forks and Restarts

Canonical section state is reconstructed from fork-visible managed system entries back to the most
recent baseline, then folded forward. Model heads and projection omissions do not erase these section
payloads. This uses existing indexed kind scans, with an optional prepared-state cache. A fresh baseline
checkpoints the whole state; no extra full-state value or token/renderer serialization is needed.

Consequently, restarting without a plugin retains its JSON payload and rendered text—even if compaction
removed its original baseline from model context. Untouched unknown sections also appear in the next
fresh baseline. Re-registering a compatible definition restores typed editing; explicit deletion is
how the host removes an abandoned section.

Every generation stores `state.requestThrough`, an inclusive transcript cutoff. It captures canonical
section state and definitions before running hooks/renderers outside the line. Preparation then checks
on the line that no managed section write changed its seed; if one did, repeat preparation. A head-only
change does not stale the section data, but may require a baseline rather than a delta.

One line operation commits the system entry and inflight intent/cutoff, catches the live context cache
up, and captures an immutable array of effective entry references after the full batch is durable.
Later cache updates do not mutate that array or its replacement projections. Request-local transforms
copy what they modify. Reconstructing an older cutoff reads storage without rewinding the live cache.

```text
prepare through 51 → requestThrough=51; capture request snapshot
60 summary lands  → live cache changes, request snapshot does not
70 answer lands   → answer to the already prepared request
```

A usable model baseline must follow the newest head entry. Otherwise the next preparation appends a
full baseline carrying ordinary omission edits for superseded retained managed system entries:

```text
10 user; 11 baseline; 20 assistant; 30 user; 31 managed delta; 35 job notice; 40 assistant; 50 user
60 summary, head=30
context at 60: [60 summary, 30 user, 31 delta, 35 notice, 40 assistant, 50 user]
70 assistant
80 user
81 system baseline, edits:[{ target:31, action:omit }]
context at 81: [60 summary, 30 user, 35 notice, 40 assistant, 50 user, 70 assistant, 80 user, 81 baseline]
```

The baseline stays at its appended tail position. Its edits omit managed baselines/deltas, not unrelated
notifications with role=system. This atomic baseline supersession is the only permitted edit of managed
system projections; arbitrary omit/replace edits targeting them reject. Change their instructions through
the section draft instead. Before preparation, old retained deltas remain visible. Generic head writers
and context projection need no system-specific callbacks or hidden filtering.

Repeated heads use the same mechanism. Fold effective tool declarations after planned omissions; add
all desired tools and explicitly remove unwanted declarations that remain in other system messages.
`baseline:true` is pico metadata, not a reset command understood by pi-ai.

Already superseded entries omitted by the current baseline must not cause repeated baselines.

A crash after configuration changes preserves them. A crash after system append but before request
preserves prepared instructions; unchanged data/rendering yields no duplicate delta. Forks inherit
only their visible section history and rewindable config. Current host-source or renderer changes can
produce a new prepared update, but never re-render old model messages.

```typescript
// Fork the earlier loadout example at 120: baseline 110 selected read/write, before the grep change.
const b = await c.fork({ at: 120 }, call);
await b.settings.set({ selectedTools: ['read'] }, call);
await b.prompt({ input: '...' }, call); // toolsRemoved=[write]; 110 remains the visible baseline
```

`before_request` may transform a private request copy, which must remain messages-only. These changes
do not mutate stored section state. The transcript is not an exact audit of arbitrary transformed
requests without optional separate capture. Tool-call validation uses the actual offered definitions
after transformation, plus normal implementation and permission checks.

## Prompting

### prompt, accept, drive

`prompt` is three things: accept the input, drive the conversation until it is idle, read the
explicit result for that input.

```typescript
const answer = await c.prompt({ input: 'Inspect the parser' }, call);
// AssistantEntry | undefined (the run ended without an answer)
```

The pieces are available separately. `inputId` is always the id of the accepted `pi.inbox` list
element, even when idle acceptance places and removes it in the same commit. Generation and
`post_tools` carry input ids explicitly, so result lookup never scans the transcript. This is built-in
harness behavior; a replacement for these built-in kinds must retain their input-result responsibilities.
Removing an executable tool does not remove its task kind or the input owner: the built-in tool task
writes an unavailable-tool result and the turn continues through `post_tools`.

```typescript
const { inputId } = await c.accept({ input: 'Inspect the parser', requestId: 'req-42' }, call);
const outcome = await c.drive(call);                          // 'idle' | 'closed'
const result = await c.result(inputId, call);                 // one sticky-value point read
const answer = result?.status === 'done' && result.answer
  ? await h.getEntry(assistantKind, result.answer, call)
  : undefined;
```

A result moves from `queued` to `placed` (its entry is in the transcript), then to `done` or
`unanswered`. `done` carries the answering entry when one was owed; a context-only `write` is
`done` with no answer, in the commit that placed it. `unanswered` names the cause:

```typescript
switch (result.status) {
  case 'queued':     return 'waiting to start';
  case 'placed':     return 'working';
  case 'done':       return result.answer ? render(result.answer) : 'noted';
  case 'unanswered':
    return result.reason === 'terminated' ? 'the run stopped itself'
         : result.reason === 'aborted'    ? 'cancelled'
         : 'the model could not be reached';
}
```

Terminal results never change.

`accept` is "the user hit enter": idle, it places the entry and creates a generation in one commit;
busy, it queues, as `followUp` by default. Pass `whenBusy: 'steer'` to interrupt the running turn
instead, or `whenBusy: 'reject'` if the caller insists on knowing. Either way you get an `inputId`
and `result(inputId)` tells you which happened, so a caller never has to check whether a run is in
progress first.

A request key names one acceptance for the life of the session. A caller that lost the response
retries with the same key and gets the same `inputId` back; nothing is written twice and nothing is
compared:

```typescript
const { inputId } = await c.accept({ input, requestId: 'req-42' }, call);   // safe to repeat
const existing = await h.acceptance('req-42', call);                        // or look it up explicitly
```

`c.drive(call)` resolves when the conversation's foreground set is idle: no generation, tool or
automatic collapse in that ownership chain is live. `h.drive(call)` resolves when no foreground task
is live anywhere in the session. Both start eligible background work and keep serving it after they
resolve. A separate full-quiescence wait may intentionally never return while a recurring schedule
is live.

### Input While Busy

`accept` covers the common case. `queueInput` is the explicit form when the caller wants a specific
mode, and it is one method taking a tagged union rather than four methods:

```typescript
const steer  = await c.queueInput({ mode: 'steer', input: 'Focus on the tokenizer first' }, call);
const follow = await c.queueInput({ mode: 'followUp', input: 'Then write the tests' }, call);
const next   = await c.queueInput({ mode: 'nextRun', input: 'Remind me to commit' }, call);
const note   = await c.queueInput({ mode: 'write', kind: noteKind,
                                    entry: { data: { text: 'user stepped away' } } }, call);
```

| mode | lands | asks for |
|---|---|---|
| `steer` | next post_tools, or a final answer | joins the running group at post_tools; starts the next one after an answer |
| `followUp` | after a final answer | starts the next group |
| `nextRun` | the next idle `accept` | joins that acceptance's group |
| `write` | next safe boundary | nothing; `done` with no answer |

When a generation emits calls, its settlement creates every tool plus exactly one `post_tools`
carrying the current input ids. That task places writes and steering, extends the ids and creates
the continuation generation. A final-answer generation resolves its current group, then places
steer/followUp items into a new group. `nextRun` remains queued until a later idle `accept`.

The queue exposes complete entry drafts so a UI can render text and images directly. Durable and
watch updates are append/remove/clear operations, not whole-array replacements. Any item can be
withdrawn until it lands:

```typescript
await c.abortInput(steer.inputId, call);              // 'aborted' | 'not_found'
```

### Aborting

```typescript
await c.abort(call);          // every live foreground task of this conversation, and of conversations they own
await h.abortTask(id, call);    // one background task: a job, a schedule
```

An abort mark is a durable request, not terminal settlement:

```text
100 generation streaming, execute invocation A running
110 abort=true commits; A can no longer write main state or scratch
    line releases; A's signal fires; provider exits; A returns
    driver removes A and starts abort invocation B with a fresh Call
120 B commits optional display-only partial, cancelled input results, terminal aborted status
    scratch is retired; B returns
```

There is no mark/signal branch in normal settlement. If the mark wins, `runtime.commit` rejects
`TaskCancelled` before its closure runs; execute unwinds and the kind's `abort()` writes the durable
cancellation result. If normal settlement wins first, the task is already terminal. Standard effects
observe the signal cooperatively; no effect gate exists, so an operation may start before the signal
is delivered and then cancel. Cancellation does not undo external effects.

`abortTask` marks exactly one task; if not owned or attached, cleanup awaits a later drive. Conversation
abort marks the current foreground ownership closure. Fresh parent cleanup explicitly cancels its
foreground children and recorded non-detached jobs. Queued `steer`/`followUp` are removed and marked
cancelled; `write`/`nextRun` remain. This is the explicit conversation-abort policy. Shutdown and
built-in task abort cleanup mark tasks only and preserve all queued items and their queued results.

A generation's abort handler updates its explicit input group in the same commit as settlement.
Here `inputResult(id)` is the sticky value address holding that input's result:

```typescript
async abort(task, runtime, call) {
  await runtime.commit(async tx => {
    for (const id of task.state.inputs) {
      const address = inputResult(id);
      const r = await tx.value(address).get();
      if (r?.status !== 'placed') throw new Error(`Invalid active input ${id}`);
      tx.value(address).set({ status: 'unanswered', requestId: r.requestId, entry: r.entry, reason: 'aborted' });
    }
    tx.settle(task, 'aborted', { inputs: task.state.inputs });
  }, call);
}
```

The driver never resolves input results itself. Tool and generation kinds own their respective
outcomes. They can recover only committed scratch; missing final usage is unknown, not zero.
Runtime scratch writes reject after cancellation too: await/catch them. Harness sinks handle and
drain their own scratch promises and drop late callbacks, never silently recreate retired scratch.

## Watching

Tool-facing preview APIs remain provisional alongside the sink. Preview delivery coalescing is
deferred; the current per-commit watch behavior is unchanged.

### The View

A UI never reads storage or parses commits. It watches a conversation and gets a **view**: a plain
JSON object the harness keeps current, plus typed events that say what changed.

```typescript
const w = await h.watch(c.id, { tail: 100, values: [myPlugin.config.mode] }, call);
w.view    // ConversationView, captured atomically with the subscription
w.start(listener);
w.resnapshot(call);     // fresh capture, same subscription (if the client fell behind)
w.unsubscribe();
```

```typescript
interface ConversationView {
  conversation: Conversation;
  entries: Entry[];                        // the last `tail` entries; page older ones with h.entries(id, { before })
  context: Id[];                           // what the model currently sees, as entry ids
  tasks: Task[];                           // live tasks, typed by kind
  inbox: Element<QueuedInput>[];           // queued input
  values: Map<Address, JsonValue>;         // every value the registered kinds declare, plus the ones you asked for
  previews: Map<Id, JsonValue>;            // per live task: what it is producing right now
  faulted: boolean;
  readAt: Id;
}
```

`previews` is where streaming lives. Each task kind defines what its preview is: the generation's
is the partial `AssistantMessage`, a tool's is its `ToolOutputState` so far, a job's is the same
shape for its process output.

### Events

```typescript
type InboxOp =
  | { type: 'append'; item: Element<QueuedInput> }
  | { type: 'remove'; id: Id }
  | { type: 'clear' };

type ConversationEvent =
  | { type: 'entry';       entry: Entry }
  | { type: 'task_start';  task: Task }
  | { type: 'task_update'; task: Task; previous: Task }
  | { type: 'task_end';    task: Task }
  | { type: 'task_output'; task: Id; ops: DeltaOp[] }      // already applied to view.previews
  | { type: 'value';       addr: Address; value: JsonValue | undefined }
  | { type: 'inbox';       ops: InboxOp[] }
  | { type: 'context';     ids: Id[] }                      // a head or edit changed derived context
  | { type: 'fault';       error: unknown }
  | { type: 'closed' };
```

The view is authoritative and the event is a wake-up: when the listener runs, `w.view` has already
been folded. Inbox operations are combined per commit; an idle acceptance's append and immediate
remove emits no inbox event. A renderer may ignore the event payload entirely and be correct.
Because every piece
of work is a task of a known kind, four task events cover what used to need a name per case:

| you want to know | look at |
|---|---|
| a turn started / ended | `task_start` / `task_end` where `generationKind.is(task)` |
| a retry is scheduled | `task_update`, status `retry_wait`, `state.attempt`, `state.notBefore` |
| the response is streaming | `task_output` on the generation; `view.previews.get(task)` |
| a tool is running / its output | `task_start` / `task_output` / `task_end` on the tool task |
| compaction started / ended | `task_start` / `task_end` where `collapseKind.is(task)` |
| the model changed | `value` with `addr === generationKind.config.model` |
| queued input changed | `inbox` |

Events of one commit arrive together, in order, so a finished task and its successor never show
as an idle gap.

### Rendering

A renderer is a function of the view, diffing against what it last drew. Settled entries are keyed
by id and only appended; live things are keyed by task id, and a tool block keeps its key when the
task settles and its result entry appears, so nothing is torn down and rebuilt:

```typescript
function render(view: ConversationView, event?: ConversationEvent) {
  transcript.sync(view.entries);

  const gen = view.tasks.find(t => generationKind.is(t));
  streaming.set(gen ? view.previews.get(gen.id) as AssistantMessage : undefined);
  status.set(
    gen?.state.status === 'retry_wait' ? `retrying (${gen.state.attempt}/${gen.state.maxAttempts})` :
    gen?.state.status === 'deferred'   ? 'waiting for provider' :
    view.tasks.some(collapseKind.is) ? 'compacting…' : undefined);

  for (const t of view.tasks.filter(toolKind.is))
    toolBlocks.upsert(t.id, { call: t.state.call, phase: t.state.status, output: view.previews.get(t.id) as ToolOutputState });

  for (const t of view.tasks.filter(jobKind.is))
    jobBlocks.upsert(t.id, { tool: t.state.origin?.tool ?? 'job', output: view.previews.get(t.id) as ToolOutputState });

  queue.set(view.inbox.map(i => i.value));
  working.set(view.tasks.some(t => !t.background));
  statusLine.set({ model: view.values.get(generationKind.config.model) });
}
```

Tool components are registered once per tool name and fed one shape, `ToolOutputState`, whether it
comes from a live tool task's preview, a settled `tool_result` entry, or a job the tool started
(`state.origin.tool` says which component).

### Remote Clients

The view is plain JSON and every event is proportional to its change, so a process without a
harness (mini's TUI, a phone) runs the same fold on the same events. `applyEvent(view, event)` is
exported and needs no kinds; preview ops are Chord delta ops, which the client applies with the
same module.

```typescript
// worker (has the harness)                            // ui process
const w = await h.watch(c.id, { tail: 100 }, call);          on('view',  m => { view = m.view; render(view); });
send({ type: 'view', view: w.view });
w.start(e => send({ type: 'event', event: e }));       on('event', m => { applyEvent(view, m.event); render(view, m.event); });
```

### Session Watch

What isn't one conversation's: the conversation list, session values, usage totals, faults, and
reports (a hook threw, a task kind misbehaved and was stopped).

```typescript
const sw = await h.watch(call);
sw.view.conversations;  sw.view.values;  sw.view.faulted;
sw.start(e => {
  if (e.type === 'usage')  status.setCost(e.totals);
  if (e.type === 'report') log.warn(e.kind, e.task, e.error);
  if (e.type === 'conversation') tree.refresh();
});
```

## Forks

A fork is a new conversation whose transcript starts as a shared prefix of the source. Nothing is
copied and nothing in the source is deleted. It carries the context, canonical prepared instructions
and rewindable values visible at that entry. Its next preparation may append changes from current
host sources; it does not rewrite inherited messages.

```typescript
const alt = await c.fork({ at: answer.id }, call);                           // the source keeps running, untouched
await alt.prompt({ input: 'Try a different implementation' }, call);

const back = await c.fork({ at: earlier.id, abort: true }, call); // "go back": aborts the source's foreground first
```

Any transcript entry is a valid fork point, including an assistant with unanswered tool calls or one
of several results. The request projection supplies missing results for a successful incomplete
exchange without inheriting or executing the source tasks. Which conversation a UI treats as
"current" is the UI's business; the harness only has conversations.

```typescript
const all = await h.conversations(undefined, call);
const independent = all.items.filter(x => x.owner === undefined);   // root and forks: their own drive scopes
const children = await h.conversations({ parent: c.id }, call);           // forks of c; owned children use ownedFrom
```

## Compaction and Reset

Compaction appends a summary entry with its model message and first retained entry id stored on the
entry. The context becomes the summary followed by the transcript from that boundary. It runs as a
background task and may run while the model keeps working: ordinary entries landing meanwhile
remain after the prepared boundary. Only a competing head makes the summary stale; edit entries do
not.

```typescript
const collapseId = await c.collapse(undefined, call);
const collapseId = await c.collapse({ instructions: 'keep the API decisions verbatim' }, call);
```

Threshold and overflow compaction happen inside the generation; nothing to call. Reset starts the
context over, with or without a handoff message:

```typescript
await c.reset({ handoff: 'Continue from here: we settled on a recursive-descent parser.' }, call);
await c.reset(undefined, call);                                                        // /clear
```

The transcript keeps everything either way; only the context changes.

## Subagents

A subagent is a conversation. There is no separate object to talk to: the model gets one tool with
a `command` argument, and the API gets a conversation handle.

```typescript
// the model calls:
subagent({ command: 'run',    prompt: 'Audit the tests', context: 'fresh', tools: ['read', 'grep'] })  // waits for the answer
subagent({ command: 'spawn',  prompt: 'Profile the build' })                                            // returns the child's id
subagent({ command: 'send',   id: 88, text: 'also check CI' })
subagent({ command: 'status', id: 88 })
subagent({ command: 'wait',   id: 88 })
subagent({ command: 'stop',   id: 88 })
```

```typescript
// the API
const childId = await c.spawn({ prompt: 'Profile the build', context: 'fresh',
                                values: { inherit: [generationKind.config.model] } }, call);
const child = await h.conversation(childId, call);
await child.accept({ input: 'also check CI' }, call);
await child.drive(call);          // or let h.drive() / the parent's drive carry it
await child.abort(call);
```

`run` keeps the calling tool inflight while it drives the child, so the child is part of the
parent's foreground: aborting the parent reaches it. `spawn` settles the tool at once; the child is
detached, runs while the parent goes on, and only `child.abort()` (or the `stop` command) ends it.
Either way the child is driven by whatever drives the parent's tree, and it survives a restart like
any conversation.

## Jobs and Schedules

A job is a background task that runs a process: durable, recoverable, killable, with its output
streamed into its preview. The model normally gets one from `bash` (asked to background, or run
past its budget) and controls it through the `job` tool:

```typescript
job({ command: 'wait',   id: 91, budgetMs: 30_000 })
job({ command: 'status', id: 91 })
job({ command: 'stop',   id: 91 })
job({ command: 'list' })
```

From the API a job is a task; a schedule is a job with `every`:

```typescript
const dev = await c.commit(tx => tx.task(jobKind, { background: true,
  state: { status: 'planned', cmd: 'npm run dev', cwd } }), call);

const nightly = await c.commit(tx => tx.task(jobKind, { background: true,
  state: { status: 'planned', cmd: 'npm test', cwd, every: 24 * 3600_000, notBefore: tonightAt(2) } }), call);

await h.abortTask(nightly, call);          // ends the schedule wherever it is
```

A schedule is one task looping `planned → running → planned`; there is no trail of run ids to
chase. A job whose starting call returned early appends a `notice` entry when it finishes, so the
model learns of it on its next turn without polling. Its output stays in the task (preview while
live, terminal state after), not in the transcript.

## Plugin State

### Values and Lists

Declare an address once; read and write through handles or inside commits. The address carries the
scope (session or conversation), the rewind policy and the payload type.

```typescript
const planMode = conversationValue<boolean>('plan.mode', { rewind: true });
const moves    = conversationList<Move>('game.moves', { rewind: true });
const expanded = conversationValue<boolean>('ui.expanded', { rewind: false });
const name     = sessionValue<string>('pi.session.name');

await c.value(planMode).set(true, call);
const on = await c.value(planMode).get(call);
const then = await c.value(planMode).get(entryId, call);            // as of an entry: rewindable only

const elementId = await c.list(moves).append({ x: 1, y: 2 }, call);
const page = await c.list(moves).read({ limit: 50 }, call);
await c.list(moves).remove(elementId, call);
await c.list(moves).clear(call);

await h.value(name).set('parser work', call);
```

Rewindable state is what makes plugins survive forks: a fork before the move doesn't see the move,
a fork before plan mode was turned on doesn't have it on. Nothing to register, nothing to re-derive.

### Atomic Commits

Anything that must land together goes in one commit: a closure on the session's write line. Reads
inside it are asynchronous and see committed state; await them in an async builder. Writes are
synchronous and ids are final when returned; a throw discards everything. Awaiting storage reads does
not release the line. Never await external effects, driver waits or another commit inside a builder.

```typescript
const entry = await c.commit(tx => {
  tx.value(planMode).set(false);                                          // rewindable state first
  const id = tx.entry(myPlugin.noteKind, { data: { text: 'plan accepted' } });
  tx.value(expanded).set(true);                                           // sticky state may follow
  tx.task(myPlugin.reminderKind, { background: true,                      // tasks anywhere
    state: { status: 'scheduled', about: id, at: Date.now() + 3600_000 } });
  return id;
}, call);
```

### Appending Entries

`tx.entry` appends immediately and returns the entry id. Use it for entries that are part of what
your task is doing, and for entries the model never sees (`data` only, no `model`).

For an entry the model *will* read, written from outside a turn, use `tx.write` (or `c.write`):

```typescript
await c.write(noteKind, { data: { text: 'user stepped away' },
                          model: [noteMessage('user stepped away')] }, call);
```

It appends immediately when no turn task is live in the conversation, and otherwise queues and lands
at the next post_tools or final-answer boundary. That is not a style preference: appending a
model-visible entry between an assistant's tool calls and their results changes the prefix the next
request replays, which providers reject and which invalidates Anthropic thinking signatures.
`tx.entry` rejects that one case rather than corrupting the next request, and the error points here.

A kind that drives its own turn declares `turn: true`, which puts it in that check alongside the
built-in generation, tool, post_tools and collapse kinds.

Two more things when writing entries directly: appending a `user` entry is not the same as asking
for an answer (nothing runs by inference; use `accept`), and a head entry may only narrow context,
never widen it, and may not split an exchange.

### Write Order

One rule: rewindable conversation value/list writes must precede entries in the same commit. That
makes state written alongside an entry visible to a fork at that entry while excluding later
commits. Session state and sticky conversation state may appear anywhere because forks never
reconstruct their history; they may therefore reference a new entry id. Tasks may also appear
anywhere. A violating builder call throws before anything is persisted.

## Writing Tools

**Provisional:** the sink, runtime and preview interfaces are preserved below for discussion, not as
final implementation instructions. We will simplify them while retaining streaming output, bounded
capture, diagnostics, typed details, usage, control outcomes and durable job/child cleanup.

### The Sink

A tool's `execute` returns nothing. Everything it produces goes through a sink, so output streams
to the UI as it happens, is bounded once in one place, and settles into a `ToolOutputState` that
the transcript, the model and every renderer share. Failure is a throw; the harness sets `isError`.

```typescript
import { Type, type Tool } from '@earendil-works/pi-agent';

export const countLinesTool: Tool<{ i: string; path: string; pattern?: string }, { lines: number; matching: number }> = {
  name: 'count_lines',
  description: 'Count lines in a file, optionally only those matching a pattern',
  parameters: Type.Object({
    i: Type.String({ description: 'What you are trying to find out' }),   // intent: streams first, shows in the UI
    path: Type.String(),
    pattern: Type.Optional(Type.String()),
  }),
  output: { maxBytes: 64_000, maxLines: 200, retain: 'head' },            // the sink enforces this
  replay: 'safe',                                                         // read-only: may be rerun after a crash

  async execute(toolCallId, params, out, runtime, call) {
    const lines = getOrThrow(await runtime.env.readTextLines(params.path, {}, call));   // ExecutionEnv: FileSystem & Shell
    const re = params.pattern ? new RegExp(params.pattern) : undefined;
    let matching = 0;
    for (const [i, line] of lines.entries()) {
      if (re && !re.test(line)) continue;
      matching++;
      out.write(`${i + 1}: ${line}\n`);                                  // bounded by `output`; the sink truncates and diags
    }
    if (matching > 200) out.diag('warn', `showing 200 of ${matching} matching lines`, 'cap');
    out.details.lines = lines.length;                                     // typed, for UIs
    out.details.matching = matching;
  },
};
```

The sink:

| call | effect |
|---|---|
| `write(text)` / `replace(text)` / `image(img)` | the content the model reads |
| `details` | the tool's typed object for UIs; mutate it |
| `usage(u)` | accumulates |
| `addTools(names)` | change the loadout from the next turn on |
| `terminate(true)` | stop the turn after this exchange, whether or not the call failed |
| `handoff(message)` | ask for a context reset after the exchange (what `new_context` does) |
| `delegate(jobId)` | this call's work continues as that job |
| `diag(severity, message, code?)` | commentary about the call, kept out of the data |

A tool never touches the transcript, its siblings or the queue. What it may do is create things in
its own conversation through `runtime.commit(..., call)`: a job, a child conversation. The runtime
provides conversation lookup, reads and cancellation methods, not a raw host-lifecycle Harness.

### Diagnostics

Anything that is *about* the call rather than its output goes through `diag`: truncation, a spilled
file, a corrected path, "the file changed on disk since you read it". The harness emits the ones it
owns (the sink itself reports truncation and spill); a tool adds only what it alone knows.
Tool settlement puts the output first and the commentary after it and stores that exact message in
entry `model`. Non-message details, usage, control flags, diagnostics and truncation metadata become
entry `data`. A UI combines the two and renders diagnostics as callouts by severity:

```text
...last matching line
<harness>
[warn] stopped at 500 matches
</harness>
```

### Long-Running Tools

A call may not block a turn forever. Tools that run processes create a job first and wait on it
with the budget from config; if the budget runs out, the call settles with what it has and the work
goes on:

```typescript
async execute(toolCallId, params, out, runtime, call) {
  const job = await runtime.commit(async tx => {
    const task = await tx.getTask(toolKind, runtime.taskId);
    if (task?.state.status !== 'running') throw new Error('Expected a running tool');
    const { status, ...payload } = task.state;
    const id = tx.task(jobKind, { background: true,
      state: { status: 'planned', cmd: params.cmd, cwd: params.cwd ?? runtime.env.cwd,
               origin: { tool: 'bash', task: runtime.taskId, callId: toolCallId } } });
    tx.patch(task, status, { ...payload, jobId: id, cancelJobOnAbort: !params.background });
    return id;
  }, call);

  if (params.background) { out.delegate(job); out.write(`started job ${job}`); return; }

  const done = await runtime.waitForTask(job, { budgetMs: runtime.budgetMs }, call);
  const output = await runtime.jobOutput(job, call);
  out.replace(output.text); out.capture(output.truncation);
  if (done) {
    out.details.exitCode = output.exitCode;
    if (output.exitCode) out.diag('warn', `exit code ${output.exitCode}`, 'exit');
  } else {
    out.delegate(job);
    out.diag('info', `still running as job ${job}; use job wait / status / stop`, 'budget');
  }
}
```

The job owns its output from the first byte; the tool copies a snapshot. Creation stores the cleanup
reference on the tool atomically. A durable abort rejects execute mutations, including catch-handler
writes, so the fresh tool-kind abort handler reads that reference and cancels the non-detached job.
Already-terminal jobs count as successful cleanup; check-and-mark must be atomic or handle that result.

The tool kind's successful delegation settlement marks the job detached and requests a notice through
a separate sticky notification record keyed by job id. Job completion consumes it atomically; if the
job is already terminal when delegation commits, delegation places the notice itself. Apply this
protocol to exited, killed and lost outcomes, including abort and recovery. The parent never patches
a running job's state. This covers either completion/delegation order.

A UI renders the job's output with `bash`'s component. Adopting an arbitrary unfinished tool promise
after budget expiry is still an open integration design: it requires an explicit effect/sink ownership
transfer. The initial job-first path above does not race or abandon any invocation.

## Hooks

Hooks belong to the kind that runs them. A kind declares its points and their types; you register
handlers per kind and point, harness-wide or scoped to a conversation. Handlers run outside the
write line and their decisions are re-validated inside a commit, so they may take as long as they
like (a human approval is a hook that waits).

```typescript
// policy: everywhere
h.hooks.on(toolKind, 'before_tool', async ({ toolName, args, conversationId }, call) => {
  const conversation = await h.conversation(conversationId, call);
  if (toolName === 'write' && await conversation?.value(planMode).get(call))
    return { block: { reason: 'plan mode: no edits' } };
  if (toolName === 'bash' && !(await ui.approve(args, { signal: call.abortSignal })))
    return { block: { reason: 'denied by user' } };
  return { args };                                       // may rewrite arguments
});

h.hooks.on(toolKind, 'after_tool', async ({ toolCallId, output }, call) => { metrics.record(output.usage); });

h.hooks.on(generationKind, 'before_request', async ({ request }, call) => ({ request: withTracing(request) }));

h.hooks.on(generationKind, 'on_yield', async ({ answer, conversationId }, call) => {
  if (await goalIncomplete(conversationId, call)) return { continue: 'The goal is not met yet; continue.' };
});

h.hooks.on(collapseKind, 'before_collapse', async ({ reason, entries }, call) => {
  if (reason === 'manual' && entries.length < 10) return { decline: true };
});

// instructions: per conversation (see System Prompt and Tool Loadout)
c.hooks.on(generationKind, 'system_instructions', handler, { subtree: true });
```

Points and their fail behaviour:

| kind | point | returns | on throw |
|---|---|---|---|
| generation | `system_instructions` | edits section draft; optional complete tools | reported, skipped |
| generation | `before_request` | a transformed request | reported, skipped |
| generation | `after_response` | nothing | reported |
| generation | `on_yield` | `{ continue?: string }` | reported, skipped |
| tool | `before_tool` | `{ args? }` or `{ block }` | **blocks the tool** |
| tool | `after_tool` | nothing | reported |
| collapse | `before_collapse` | `{ decline? \| instructions? \| summary? }` | reported, skipped |

These failure policies exclude cancellation control errors, which propagate to unwind the invocation.
A handler receives the active Call as its final argument and must forward it to waits/effects. The
harness awaits its actual return, not an abandoned raced promise. A handler may run again after a
crash, so its external side effects need their own idempotence.

Approval/question policy, presentation and durable answer reuse belong to workspace/plugins, using
existing scratch or scoped values as appropriate. Pico does not add a separate memo subsystem. How
hooks receive task identity and authorized scratch access is still an integration question; the
examples do not establish a new hook-payload API.

## Writing Kinds

Kinds are how you extend the harness with new behaviour rather than new state. An entry kind is a
typed name for an immutable transcript shape; a task kind says how a kind of work runs.

### Entry Kinds

Entry facets combine. `data` is optional kind-specific JSON for logic and custom UI rendering;
`model` is an optional stored `Message[]`; `head` and `edits` are optional stored context controls.
No facet is derived while reading.

```typescript
interface NoteData { text: string; pinned?: boolean }
type NoteEntry = EntryBase & EntryData<NoteData>;

export const noteKind = defineEntryKind<NoteEntry>('myplugin.note');

await c.commit(tx => tx.entry(noteKind, {
  data: { text: 'Parser plan accepted', pinned: false },
}), call);                                                        // transcript/UI only; the model sees nothing
```

A plugin that wants both typed data and a model message keeps the append-time conversion in an
ordinary helper:

```typescript
type PinnedEntry = EntryBase & EntryData<NoteData> & ModelProjection<UserMessage>;
export const pinnedKind = defineEntryKind<PinnedEntry>('myplugin.pinned');

function appendPinned(tx: ConversationTx, data: NoteData, timestamp: number): Id {
  return tx.entry(pinnedKind, {
    data,
    model: [{ role: 'user', content: `<pinned>${data.text}</pinned>`, timestamp }],
  });
}
```

Heads and edits are supplied the same way:

```typescript
type WindowEntry = EntryBase & EntryData<{ retainFrom: Id }> & ContextHead;
export const windowKind = defineEntryKind<WindowEntry>('myplugin.window');

tx.entry(windowKind, {
  data: { retainFrom },
  head: retainFrom,                     // first retained entry, inclusive
});

type ToolResultEditEntry = EntryBase & ContextEdits;
export const toolResultEditKind = defineEntryKind<ToolResultEditEntry>('myplugin.tool_result_edit');

tx.entry(toolResultEditKind, {
  edits: replacement === undefined
    ? [{ target, action: 'omit' }]
    : [{ target, action: 'replace', messages: replacement }],
});
```

`head: 'self'` in an append draft stores the new entry id, which is how reset and handoff discard
everything earlier. Commit validation requires a stored head boundary not to move before the
previous visible boundary. Edits apply in transcript order; the newest edit per target wins. Append
another head or edit when context should change; no entry-kind callback runs during context reads.

Reads are typed by the kind, or untyped and narrowed:

```typescript
const note = await h.getEntry(noteKind, id, call);     // NoteEntry | undefined (also undefined for another kind)
const any = await h.getEntry(id, call);                // Entry | undefined
if (noteKind.is(any)) any.data.pinned;
```

A missing plugin removes that narrowing and its custom renderer, but not context behavior: the
entry's model messages, head and edits are stored independently of the kind.

### Task Kinds

A task kind declares its statuses and their roles, its config, its hooks, and three functions. Task
writes materialize the mapped role on the durable task row; storage and the driver read that field
without running kind code. Status graphs may contain cycles because one task is one logical
operation: retries, deferred polls and recurring schedules keep their stable task id. Recovery uses
only the current status, state, role and scratch.

Here is a reminder that fires once:

```typescript
type ReminderStates =
  | { status: 'scheduled'; about: Id; at: number }
  | { status: 'firing';    about: Id; at: number }
  | { status: 'done';      about: Id; at: number; fired: boolean }
  | { status: 'aborted';   about: Id; at: number };

export const reminderKind = defineTaskKind<ReminderStates>()({
  kind: 'myplugin.reminder',
  initialStatus: 'scheduled',
  roles: { scheduled: 'start', firing: 'inflight', done: 'terminal', aborted: 'terminal' },
  config: { intervalMs: conversationValue<number>('myplugin.reminder.interval', { rewind: false }) },
  hooks: { before_fire: { failClosed: false } },

  async execute(task, runtime, call) {
    if (task.state.at > runtime.now()) await runtime.sleep(task.state.at, call);        // throws on cancellation
    await runtime.commit(tx => tx.patch(task, 'firing', common(task)), call);   // intent before any effect
    const { skip } = await runtime.hooks(reminderKind).run('before_fire', { about: task.state.about }, call);
    await runtime.commit(tx => {
      if (!skip) tx.write(noticeKind, { model: [noticeMessage(`Reminder: see entry ${task.state.about}`)] });
      tx.settle(task, 'done', { ...common(task), fired: !skip });               // a marked task's commit rejects
    }, call);
  },

  async recover(task, runtime, call) { return this.execute(task, runtime, call); },      // safe to redo
  async abort(task, runtime, call)   {
    await runtime.commit(tx => tx.settle(task, 'aborted', common(task)), call);
  },

  // no preview: nothing to show while sleeping
});

const common = (t: Task<ReminderStates>) => ({ about: t.state.about, at: t.state.at });
```

`defineTaskKind<ReminderStates>()` binds the declared union; the following call infers the literal
role map. Keep that inferred kind type so the compiler knows which statuses patch and settle accept.
Kind definition rejects missing/extra role entries, a non-start initial status, a declared `orphaned`
status, and inconsistent types or optionality for fields shared by every variant.

State is a tagged union over status. **Both `patch` and `settle` take a status and its complete
payload, without a second status inside it.** Patch accepts nonterminal targets; settle accepts
terminal targets. There is no status-free partial patch or implicit merge with the old state:

```typescript
tx.patch(task, 'firing', { about: task.state.about, at: later });
tx.settle(task, 'done', { about: task.state.about, at: task.state.at, fired: true });
// Rejected: missing fired, extra fields, wrong field types, or using done with patch.
```

For a same-status update, narrow the state, destructure out `status`, and spread the remaining
payload with your changes. A transition must supply the target variant's fields, not spread the
previous variant's unrelated fields. Stored state becomes `{ ...payload, status }`. Task snapshots
remain immutable; read the task again if a later write needs state committed since that snapshot.

Typed tasks retain a compiler-only witness for the full state union and role map; no field or
callback is added to storage. Given only an id, read through its kind before patching or settling.
The type checks reject visible extra top-level keys even on variables/spreads and preserve correlation
between status and payload. They cannot detect fields erased by casts or a narrower static type;
wire validation and on-line invocation/liveness checks still apply.

The harness adds `orphaned` with fields common to every variant: for this reminder, `about` and `at`,
not `fired`. Common optional fields remain optional. This uses common keys (`keyof` on the union),
not a literal TypeScript intersection of incompatible statuses. Typed reads include orphaned; kind
execution methods receive only declared variants. You never write orphaned through patch/settle;
a dependent handles it in the same switch as the other terminal outcomes.

The rules an execution follows, and the driver enforces:

1. Commit an inflight status before any external effect. A crash before that re-runs `execute`; a
   crash after goes through `recover`.
2. You may block on the world: a provider stream, a process, a child conversation, a sleep. The
   driver runs executions concurrently; a blocked one holds up nothing.
3. Make a committed status transition or settle before returning, except cancellation/close unwind.
   The live task's epoch counts actual transitions, so `planned → running → planned` is valid.
   Same-status/state-only patches and abort marks do not count. An abort handler must settle.
4. Prefer `after` for prerequisites; drive children or use the bounded job-wait API. Forward Call
   to every wait. Known self/dependency waits reject; never race away an unfinished task/tool/hook.

A foreground task waiting on `after` is live, so its conversation stays busy until the dependency
settles. Depending on a background job is fine when the job ends; depending on a recurring schedule
keeps the conversation busy forever, so wait inside your own execute instead.

The scheduler runs on the commit line, keeps live-task/dependency indexes updated from whole committed
batches, and starts effects outside the line. It scans storage once at open, not after every call.
Only one invocation owns each task, but different tasks run concurrently. Repeated drives share an
attachment and create only temporary waiters. Historical completed children are never traversed.

An unexpected error escaping a task kind or an unchanged return faults the session: pending drives
reject immediately, admission stops, running invocations are signalled and joined, then storage closes.
Domain tool/provider errors must be settled by their kinds. Reopen starts nothing; inspect and mark
work before driving, or install a replacement kind that can settle a broken persisted task.

A kind with a `preview` decides what a UI sees while the task runs: `preview.init(scratch)` builds
it once on attach or reopen, and after that the kind mutates `runtime.preview.state` in place (the
generation applies stream events to a partial message; a tool's preview is its sink). The harness
flushes the Chord delta tracker after each scratch commit into `task_output` ops, so a token costs
one append op, not a diff of the whole object.

## Recovery

There is nothing to write. After a crash:

```typescript
const h = await Harness.open(storage, opts, call);
await h.drive(call);
```

| what was running | what happens |
|---|---|
| a generation, streaming | its frames were in scratch: the partial is published, then retry within budget or fail |
| a generation, between retries | it sleeps out the remaining backoff and tries again |
| a tool with `replay: 'safe'` | runs again |
| any other tool | an "interrupted" error result; the turn continues |
| a `run` subagent tool | finds its child and drives it again |
| a job | reruns if it said so, otherwise records `lost` |
| a scheduled job | sleeps until its time |

Successors are written in the same commit as the settlement that decides them, so a crash never
leaves "the tools finished but nobody started the next turn": post_tools already exists and is
startable.

## Storage Backends

| backend | loads | good for |
|---|---|---|
| `MemoryStorage` | everything | tests, ephemeral sessions |
| `JsonlStorage` | everything, from one append-only file plus a scratch file per live task | local sessions; the default |
| `SqliteStorage` | only what queries return | long sessions, many sessions in one file, servers |

All three answer the same queries with the same results. Entries are immutable and read whole;
indexed queries select the relevant entries before decoding. Values are stored whole on every set;
lists store append/remove/clear operations. There is no automatic value diffing or Chord storage codec.
Chord deltas are only for preview/watch delivery. Streaming scratch appends compact assistant frames
or explicit output operations, not raw provider events with repeated growing partial snapshots.

JSONL reopens by replaying complete main batches, then scratch for surviving live tasks. Per-file
sequence gaps are expected; the next id follows the maximum complete batch endpoint across both.
Retired scratch is ignored even if unlink failed; its later main settlement already covers its ids.
Only unterminated final lines are discarded and removed before further appends; malformed complete
main/live-scratch batches fail open.

```text
main ends at 100; live scratch ends at 150 → reopen lastSeq=150, next write=151
main settles task at 151; scratch unlink fails → ignore retired scratch, lastSeq=151
```

The conformance suite compares one mutation stream across all backends. A repeated whole-value set
can write quadratic bytes when the value grows; incremental lists avoid that without hidden encoding.

```typescript
const storage = await SqliteStorage.open('./sessions.db', { session: 'parser-work' });
```
