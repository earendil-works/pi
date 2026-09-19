# pico

Durable agent harness for pi: one session file, any number of conversations, every piece of work
recorded as a task that survives a crash, and a view any UI can render.

**Note**: this guide is about using the harness. `pico-simple-handoff.md` is the sole normative
implementation specification and the reference for why things are the way they are. Provider/system, hook, ordinary-tool, job and subagent facades remain gated
where marked; their examples show intended behavior, not permission to guess unsettled APIs. Required task output,
storage and cancellation guarantees are retained; the separate steps proposal has not been adopted.

## Table of Contents

- [The Mental Model](#the-mental-model)
- [Calls and Cancellation](#calls-and-cancellation)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Sessions and Conversations](#sessions-and-conversations)
  - [Opening](#opening)
  - [What Happens on Reopen](#what-happens-on-reopen)
  - [Closing](#closing)
  - [Cloudflare Durable Objects](#cloudflare-durable-objects)
- [Configuration](#configuration)
  - [Settings Exported Alongside Kinds](#settings-exported-alongside-kinds)
  - [Reading and Writing](#reading-and-writing)
  - [What Is Rewindable](#what-is-rewindable)
- [System Prompt and Tool Loadout](#system-prompt-and-tool-loadout)
  - [How It Works](#how-it-works)
  - [Answering the Hook](#answering-the-hook)
  - [Changing the Loadout](#changing-the-loadout)
  - [Sections from Plugins](#sections-from-plugins)
  - [Subagents Have Their Own](#subagents-have-their-own)
  - [Compaction, Forks and Restarts](#compaction-forks-and-restarts)
- [Sending Input](#sending-input)
  - [send and InputHandle](#send-and-inputhandle)
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
  compacting, running a background process, or anything a plugin wants done. A task has immutable input,
  pending/running/terminal lifecycle, optional complete checkpoints and optional task output. Those durable
  boundaries make a crash recoverable.
- **state**: keyed **values** and **lists**, for the model in use, plan mode, a game board, whatever
  a plugin needs to remember.

What the model sees, the **context**, is not stored as a list. Each entry may store `model`
messages, a **head** boundary, and **edits** that omit or replace earlier model messages. The harness
prepends the newest head, reads forward from its stored boundary, folds retained edits, then performs
request-local tool and provider normalization. Compaction appends a head; tool-result pruning
appends an edit. Forks, compaction and reset never mutate old entries.

Object identity and write order are separate:

```typescript
type Id = number;   // Storage-minted stable identity for committed conversations, entries, tasks and list elements
type Seq = number;  // storage-assigned committed write order
```

Creation and list-append builders synchronously call `Storage.nextId()` while holding the Session line. A
failed callback discards its writes but burns those IDs in the current open binding. They become valid object
identities only after commit succeeds. Reopen initializes after the greatest committed creation/list-append
ID and may therefore reuse IDs that were minted but never committed by an earlier process; committed IDs are
never reused. `commit` receives no allocator argument. Each write receives a `Seq`. Historical entry-ID
lookup resolves that entry's sequence internally. Watch barriers and commit envelopes use `Seq`, never
object IDs.

All main writes happen through **commits**: a closure that runs on the Session's single mutation line, where
everything inside it lands together or not at all. Tasks run concurrently; mutations never do.

Opening is inert. `resume()` activates one scheduler for every eligible task in every conversation. It stays
active while the Harness is open, and every successful main commit coalesces a scheduler kick. Foreground and
background tasks both execute; foreground only controls idle and ordinary abort reach. A UI **watches** a
conversation and gets one authoritative **view** it can render directly.

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
const input = await conversation.send({ content: 'Inspect the parser' }, call);
const waiting = input.wait(waitingCall);
cancel();                            // removes this waiter; does not abort durable work
await waiting;                       // rejects with cancellation
```

Tasks receive `(task, runtime: TaskRuntime, call: Call)` and forward `call`. Tools receive
`(toolCallId, params, out, runtime: ToolRuntime, call: Call)`. Environment/provider/hook operations
interpret the signal; custom handlers must cooperate. Derive a Call for nested telemetry or a tighter
deadline and pass it onward. The scheduler does not inherit a waiter caller's signal into task execution.

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

// One file per Session. Reopening restores it inert; send/wait/resume activates recovery.
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

// Watch the conversation. `view` is a plain object a UI renders from; subscribe whenever you like.
// The view is complete as of capture and commit envelopes follow from its Seq barrier.
const w = await h.watch(c.id, { tail: 100 }, call);
w.start(delivery => {
  if (delivery.type !== 'commit') return;
  for (const event of delivery.commit.events) {
    if (event.type === 'task_output') {
      const output = w.view.taskOutputs.find(value => value.id === event.id);
      process.stdout.write(renderTaskOutput(output));
    }
    if (event.type === 'entry') console.log(`\n[entry ${event.entry.id} ${event.entry.kind}]`);
  }
});

// Admission is durable and resumes the whole Session; waiting observes this input's explicit result.
const input = await c.send({
  requestId: 'cli-1',
  content: 'Inspect the parser and list the public API',
}, call);
const result = await input.wait(call);
const answer = result.status === 'done' && result.answer
  ? await h.getEntry(result.answer, call)
  : undefined;
console.log(answer?.model?.[0]?.content);

w.unsubscribe();
await h.close(call);   // cancels nothing durable; reopen restores here, then send/wait/resume continues
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
| `kinds` | ordinary plugin entry and task kinds, added beside the fixed built-ins; protected `pi.*` names reject |
| `rootValues` | explicit initial root configuration, applied only in the fresh root's creation commit |
| `sections` | initial custom typed section definitions, in addition to built-ins |

Registries supply implementations, not selections. Registering read/write/edit/bash does not
select them automatically. Supply initial model/thinking/selectedTools through `rootValues`, or
configure the fresh conversation before generation. On reopen, `rootValues` is ignored: durable
configuration wins. Children inherit the values selected by their spawn policy; forks inherit
rewindable configuration at the fork point. Missing required generation configuration is an error.

The built-in kinds are fixed and installed by `open` itself because `send`, safe-boundary admission and
`collapse` cannot work without them. They cannot be registered, replaced or removed. Their readonly
witnesses remain available through `h.kinds` for hooks and inspection:

```typescript
h.kinds.generation   // config: model, thinking, selectedTools, ...; hooks: system_instructions, before_request, on_yield
h.kinds.tool         // hooks: before_tool, after_tool
h.kinds.collapse     // hooks: before_collapse
h.kinds.job
```

Plugins extend these operations through their typed hooks and may register ordinary durable task kinds for
side work. They cannot supply an alternative generation/tool/post_tools graph or obtain the core transcript
transaction surface.

Open checks the recorded kind strings without scanning the transcript and reports live work, but
starts nothing. An unregistered historical entry kind is reported, not rejected: its stored
`model`, `head` and `edits` still build context, while its typed data and custom renderer are
unavailable. Open reconciles missing live task kinds before returning:

```typescript
const { pending, running, orphaned, unknownEntryKinds } = await h.inspect(call);
// pending:  tasks whose effects never began
// running:  tasks the prior process left in flight; recover() handles them after resume
// orphaned: live tasks whose kind was missing and was terminalized during open
// unknownEntryKinds: stored entries that retain generic facets but lack typed plugin narrowing
```

### What Happens on Reopen

Nothing runs during open. Resume once to start or recover every eligible foreground and background task in
every conversation. Activation is idempotent and returns after initial dispatch scheduling, not after idle:

```typescript
const h = await Harness.open(storage, opts, call);
await h.resume(call);
```

`send`, `InputHandle.wait`, `collapse`, task/input abort and foreground-idle waits also ensure this
session-wide resume.
Use explicit `resume()` when restored work must progress and no new progress-seeking command will be issued.
A read, inspection, fork without input, value lookup or watch capture does not activate recovery.

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
to disappear before closing. Preserved queues create no work merely from reopen or resume; a later explicit
idle send consumes queued writes/follow-ups/steering according to the normal boundary policy.

Once admitted, caller cancellation does not abandon shutdown. Repeated lifecycle calls share
completion; explicit close interrupting shutdown makes shutdown reject. Task calls cannot invoke
host lifecycle methods.

### Cloudflare Durable Objects

Use one Durable Object per Pico Session: one open Harness, one session scheduler, and any number of root,
forked and owned conversations. A request that calls `send` activates the scheduler. An alarm or one logical
Cloudflare Task wake should open Pico and call `resume`, which recovers all eligible Session work.

Platform wake-up is not Pico effect recovery. Do not create one Cloudflare lane/task per conversation, and
do not use Cloudflare replay as a second authority for provider/tool effects. If durable Pico admission and
the platform wake cannot share a transaction, add an ordered handoff or idempotent retry so acknowledged
work can always cause another wake. Pico checkpoints and `recover()` remain authoritative across process
and platform invocation limits.

## Configuration

### Settings Exported Alongside Kinds

There is no generic settings object and generic `TaskKind` does not capture configuration. Built-in/product
packages export typed address bundles alongside their kinds, so each address is still spelled once:

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

A UI can list built-in configuration from these exported bundles. A plugin defines and exports its own
addresses the same way; those values remain conversation state and are never copied wholesale into a task.

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
[Subagents](#subagents)). Generation tasks do not copy this generic configuration into their durable input.
They carry only minimal built-in effect-recovery evidence such as input IDs, context cutoff, selected model
identity, attempt/deferred IDs and offered tool-name/version evidence when required. A plugin needing exact
recovery persists its own compact key/version. Fork configuration remains built-in fork-aware conversation
state, so a fork sees the values in force at its selected entry and local overrides do not affect the parent.

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
not earlier handlers' changes; a half-finished refresh must not remove instructions. No discovery callback or private cache state is stored with sections.

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

The exact spawn helper is gated; this example fixes the required configuration semantics. Children
explicitly choose their durable configuration. Subtree handlers supply defaults, and inner
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
Entry/task registries follow the parallel `h.entryKinds`/`h.taskKinds` API. Replacing or removing an
ordinary task kind rejects while live tasks of that kind exist; after they are terminal, replacement affects
future tasks only. At open, every live task with a missing kind is terminalized as
`orphaned`, regardless of foreground/background; registered descendants selected by cleanup policy are
marked. Later registration never resurrects terminal tasks.

### Compaction, Forks and Restarts

Canonical section state is reconstructed from fork-visible managed system entries back to the most
recent baseline, then folded forward. Model heads and projection omissions do not erase these section
payloads. This uses existing indexed kind scans, with an optional prepared-state cache. A fresh baseline
checkpoints the whole state; no extra full-state value or token/renderer serialization is needed.

Consequently, restarting without a plugin retains its JSON payload and rendered text—even if compaction
removed its original baseline from model context. Untouched unknown sections also appear in the next
fresh baseline. Re-registering a compatible definition restores typed editing; explicit deletion is
how the host removes an abandoned section.

Every generation checkpoints `requestThrough`, an inclusive transcript cutoff. It captures canonical
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
const forkInput = await b.send({ content: '...' }, call); // toolsRemoved=[write]; 110 stays visible
await forkInput.wait(call);
```

`before_request` may transform a private request copy, which must remain messages-only. These changes
do not mutate stored section state. The transcript is not an exact audit of arbitrary transformed
requests without optional separate capture. Tool-call validation uses the actual offered definitions
after transformation, plus normal implementation and permission checks.

## Sending Input

### send and InputHandle

`send` is the application-facing admission operation. It first durably accepts or deduplicates content, then
non-abandoningly ensures the one Session scheduler is resumed, and returns an `InputHandle`; it does not wait
for a model answer. Caller cancellation after admission cannot strand the accepted input.

```typescript
const input = await c.send({
  requestId: 'req-42',
  content: 'Inspect the parser',
}, call);

const result = await input.wait(call); // done | unanswered
const answer = result.status === 'done' && result.answer
  ? await h.getEntry(assistantKind, result.answer, call)
  : undefined;
```

`input.id` is the stable ID of the protected inbox element allocated for acceptance, even when idle
admission appends and removes that element in one commit. `pi.inbox` is a conversation-scoped sticky,
non-rewindable list and is not inherited by forks. Ascending element IDs preserve Session admission order.
Generation and `post_tools` carry input IDs explicitly. Results are direct protected values keyed by input ID,
and request receipts are direct protected values keyed by the Session-wide request key; neither lookup scans
the transcript or inbox. `input.result(call)` is a point read and does not activate work.
`input.wait(call)` ensures resume, returns an existing terminal result immediately or installs one cancellable
observation waiter. Cancelling that Call removes only that waiter; it neither aborts the input nor changes
scheduler scope. Several waiters may join the same result.

Inbox reads return one complete current materialized ordered collection. Memory retains that collection
in process, JSONL replays operations once at open and then maintains it, and SQLite reads all current indexed
rows in element-ID order and may physically remove them on remove/clear. No inbox read replays history from
the last clear; rewindable list history is unrelated. An
admission or boundary decision commits its inbox removal together with result/receipt changes, entry
placement and successor task creation in one main transaction.

A result moves `queued -> placed -> done | unanswered`. Idle send may collapse absent directly to placed.
`done` names the answering entry when one was owed; an internal passive write is done with no answer.
Terminal results never change.

A request key is Session-wide and first-key-wins for the Session lifetime. Lookup happens before conversation,
busy mode or payload comparison. A retry through any conversation returns a handle bound to the original
conversation/input and writes nothing:

```typescript
const first = await c.send({ requestId: 'req-42', content }, call);
const same = await anotherConversation.send({ requestId: 'req-42', content: 'different' }, call);
console.assert(first.id === same.id && first.conversationId === same.conversationId);
const existing = await h.input('req-42', call);
```

Use `c.waitForIdle(call)` to observe that conversation's foreground cancellation closure, or
`h.waitForIdle(call)` for all foreground tasks in the Session. These waits ensure resume but do not wait for
background work. Background jobs/collapse still execute after foreground idle.

### Input While Busy

A conversation is admission-busy while a live generation/tool/`post_tools` turn task owns transcript
progress. A speculative background collapse has model-entry authority but is not admission-busy.

```typescript
const follow = await c.send({ content: 'Then write the tests' }, call); // default while busy
const steer = await c.send({
  content: 'Focus on the tokenizer first',
  whenBusy: 'steer',
}, call);
```

| mode | lands | asks for |
|---|---|---|
| `steer` | next complete post_tools boundary, or final boundary | joins the active input group when safe |
| `followUp` | after the final assistant answer | starts the successor input group |
| `write` | next safe boundary | passive transcript content; no generation |

`followUp` is the busy-send default. While idle, `whenBusy` is irrelevant: send starts one current input
group. `whenBusy:'reject'` throws without recording a request receipt. `steer` never mutates a provider
request already snapshotted or in flight. `write` is a protected agent/plugin admission mode rather than a
common public conversation method; built-ins compose it through internal transaction helpers when it must
land atomically with other state. An idle write appends and becomes done with no task. Applications needing
speculative staged context for a later explicit turn can keep it in their own sticky conversation list and
fold it into that later `send`; Pico does not standardize that application policy.

Safe chronology is preserved in full:

```text
send A while idle
TX[ user A; generation G1(inputs:[A]); result A=placed ]
kick -> G1

G1 returns calls X,Y
TX[ assistant calls; tool X; tool Y;
    post_tools P1(after:[X,Y],inputs:[A]); terminal G1 ]
kick -> X and Y concurrently

send B while busy -> TX[followUp B; result B=queued]
send S with steer -> TX[steer S; result S=queued]
internal write W  -> TX[write W; result W=queued]

X and Y finish in either order
TX[tool result X; terminal X]
TX[tool result Y; terminal Y]
model projection restores assistant call order

P1 terminal boundary
TX[write W; user steer S; generation G2(inputs:[A,S]); terminal P1]
kick -> G2

G2 final answer E2
TX[assistant E2; A/S=done(answer:E2); user followUp B; B=placed;
   generation G3(inputs:[B]); terminal G2]
kick -> G3
```

`steeringMode` and `followUpMode` independently use `"all" | "one-at-a-time"` and default to
`"one-at-a-time"`, matching the old lane harness. At each boundary, `"all"` selects every queued item of
that tag and `"one-at-a-time"` selects only its oldest item. All writes are selected. Selected tags are
merged in global inbox order; unselected items retain their relative order. Pico imposes no queue-size or
drain-size bound in v1. No giant turn task and no task-per-send dependency chain exists. A logical turn remains generation -> parallel tools -> post_tools -> continuation generation, with input
ownership transferred atomically at each stage. Each tool appends its own result entry atomically with
terminalization. Transcript chronology may reflect parallel completion; model projection restores the
assistant's call order before the continuation request.

The inbox exposes complete entry drafts to the authoritative conversation view. Any queued input can be
withdrawn until placement wins:

```typescript
const status = await follow.abort(call); // aborted | already_placed | not_found
```

Withdrawal and placement serialize. If withdrawal wins, only that element is removed and becomes
`unanswered/aborted`; later items retain order. If placement wins, abort returns `already_placed`. No task
dependency is rewired.

### Aborting

```typescript
await c.abort(call);          // active foreground graph in this cancellation ownership closure
await h.abortTask(id, call);  // one task, including a background job or schedule
```

Both operations first commit their durable mark/withdrawal, then non-abandoningly ensure the Session scheduler
is resumed so fresh cleanup can progress. An abort mark is a durable request, not terminal settlement:

```text
100 generation execute invocation A running
110 abort=true commits; A loses main/scratch/output write authority
    line releases; A's signal fires; provider exits; A returns
    scheduler releases A and reserves fresh abort invocation B
120 B commits display/result cleanup + full terminal aborted snapshot atomically
```

If normal settlement wins first, the task is terminal. If the mark wins, normal writes reject, the old
invocation is joined, and only fresh `abort()` performs durable cleanup. Cancellation does not undo external
effects.

Conversation abort marks its foreground cancellation closure, withdraws queued `steer`/`followUp` as
`unanswered/aborted`, and preserves `write`. Task abort preserves all queued future input unless a specific
built-in cleanup policy says otherwise. Abort terminalization never runs a normal final-answer
boundary, so it cannot accidentally start a queued successor. Shutdown marks all live tasks but preserves all
queued items/results.

Tool and generation kinds, not waiters or the scheduler, own their durable outcomes and input-result updates.
They recover only committed checkpoint/scratch evidence; missing final usage is unknown, not zero. Runtime
scratch writes reject after cancellation too: await or catch them. Harness producers drain their own pending
writes and never recreate retired scratch.

## Watching

Tool-facing convenience APIs remain provisional alongside the sink. Durable task output and per-commit watch
delivery are normative; delivery coalescing is deferred.

### The View

A UI never reads storage or parses commits. It watches a conversation and gets a **view**: a plain
JSON object the harness keeps current, plus typed events that say what changed.

```typescript
const w = await h.watch(c.id, { tail: 100, values: [myPlugin.config.mode] }, call);
w.view    // ConversationView, captured atomically with the subscription
w.start(listener);
w.unsubscribe();
// After overflow/failure, open a new watch and replace the client view atomically.
```

```typescript
interface ConversationView {
  conversation: Conversation;
  tail: number;
  entries: Entry[];                         // newest logical fork-visible tail
  context: Id[];                            // model-visible entry IDs
  tasks: Task[];                            // live tasks directly in this conversation
  taskOutputs: WatchedTaskOutput[];         // shared live generation/tool/job/collapse output
  inbox: Element<QueuedInput>[];            // queued followUp/steer/write
  values: WatchedValue[];                   // exactly the requested values
  readAt: Seq;                              // coherent storage sequence barrier
}
```

Task output is where streaming lives. A generation output contains its partial assistant message; tool and
job outputs contain their current output state. The same output ID may be referenced by more than one live
task during durable handoff. Entries, tasks, task outputs, inbox and values are captured and updated as one
authoritative replicated view.

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
  | { type: 'task_output'; id: Id; kind: string; delta: Op[] }
  | { type: 'value';       value: WatchedValue }
  | { type: 'inbox';       ops: InboxOp[] }
  | { type: 'context';     ids: Id[] };

interface CommitEnvelope {
  first: Seq;
  last: Seq;
  events: ConversationEvent[];
}
```

The view is authoritative and the event is a wake-up: when the listener runs, `w.view` has already
been folded. Deliveries are whole commit envelopes ordered after `view.readAt`. Inbox operations are
combined per commit; an idle send's append and immediate remove emits no inbox event. A renderer may ignore the event payload entirely and be correct.
Because every piece
of work is a task of a known kind, four task events cover what used to need a name per case:

| you want to know | look at |
|---|---|
| currently in a turn | `view.tasks` contains a fixed generation/tool/post_tools task after folding the whole commit; a continuation generation is not a new logical turn |
| a retry is scheduled | `task_update`, checkpoint phase `retry_wait`, attempt and `notBefore` |
| the response is streaming | `task_output` on the generation's output ID; `view.taskOutputs` |
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
function render(view: ConversationView) {
  transcript.sync(view.entries);
  const outputById = new Map(view.taskOutputs.map(output => [output.id, output.value]));
  const valueByAddress = new Map(view.values.map(value => [value.address, value.value]));

  const gen = view.tasks.find(t => generationKind.is(t));
  streaming.set(gen?.output ? outputById.get(gen.output.id) as AssistantMessage : undefined);
  status.set(
    gen?.checkpoint?.phase === 'retry_wait' ? `retrying (attempt ${gen.checkpoint.attempt})` :
    gen?.checkpoint?.phase === 'deferred'   ? 'waiting for provider' :
    view.tasks.some(collapseKind.is) ? 'compacting…' : undefined);

  for (const t of view.tasks.filter(toolKind.is))
    toolBlocks.upsert(t.id, { call: t.input.call, phase: t.checkpoint?.phase ?? t.status,
      output: t.output ? outputById.get(t.output.id) as ToolOutputState : undefined });

  for (const t of view.tasks.filter(jobKind.is))
    jobBlocks.upsert(t.id, { tool: t.input.origin?.tool ?? 'job',
      output: t.output ? outputById.get(t.output.id) as ToolOutputState : undefined });

  queue.set(view.inbox.map(i => i.value));
  working.set(view.tasks.some(t => !t.background));
  statusLine.set({ model: valueByAddress.get(generationKind.config.model) });
}
```

Tool components are registered once per tool name and fed one shape, `ToolOutputState`, whether it
comes from a live tool task's output, a settled `tool_result` entry, or a job the tool started
(`input.origin.tool` says which component).

### Remote Clients

The view is plain JSON and every event is proportional to its change, so a process without a
Harness (mini's TUI, a phone) runs the same fold over complete commit envelopes.
`applyConversationCommit(view, commit)` is exported and needs no kinds; task-output ops are Chord delta ops,
which the client applies with the same
module. Keep the original atomic watch subscribed. Do not snapshot, unsubscribe and invent a separate stream
cursor; reconnect after overflow with a fresh atomic watch and replace the client view.

```typescript
// worker                                               // UI process
const w = await h.watch(c.id, { tail: 100 }, call);     on('view', m => { view = m.view; render(view); });
send({ type: 'view', view: w.view });
w.start(delivery => send({ type: 'delivery', delivery }));
                                                       on('delivery', m => {
                                                         if (m.delivery.type === 'commit')
                                                           view = applyConversationCommit(view, m.delivery.commit);
                                                         render(view);
                                                       });
```

### Session Watch

What isn't one conversation's: the conversation list, session values, usage totals, faults, and
reports (a hook threw, a task kind misbehaved and was stopped).

```typescript
const sw = await h.watch(call);
sw.view.conversations; sw.view.values; sw.view.readAt;
sw.start(delivery => {
  if (delivery.type !== 'commit') return;
  for (const event of delivery.commit.events)
    if (event.type === 'conversation') tree.refresh();
});
```

## Forks

A fork is a new conversation whose transcript starts as a shared prefix of the source. Nothing is
copied and nothing in the source is deleted. It carries the context, canonical prepared instructions
and rewindable values visible at that entry. Its next preparation may append changes from current
host sources; it does not rewrite inherited messages.

```typescript
const alt = await c.fork({ at: answer.id }, call); // source work keeps running independently
const altInput = await alt.send({ content: 'Try a different implementation' }, call);
await altInput.wait(call);

const back = await c.fork({ at: earlier.id, abort: true }, call); // "go back": aborts the source's foreground first
```

Any transcript entry is a valid fork point, including an assistant with unanswered tool calls or one
of several results. The request projection supplies missing results for a successful incomplete
exchange without inheriting or executing the source tasks. Which conversation a UI treats as
"current" is the UI's business; the harness only has conversations.

```typescript
const all = await h.conversations(undefined, call);
const independent = all.items.filter(x => x.owner === undefined);   // root and forks; same Session scheduler
const children = await h.conversations({ parent: c.id }, call);           // forks of c; owned children use ownedFrom
```

## Compaction and Reset

Compaction appends a summary entry with its model message and first retained entry ID stored on the
entry. The context becomes the summary followed by the transcript from that boundary. Manual speculative
compaction is background; threshold/overflow compaction is foreground. Either executes automatically, and
speculative compaction may run while the model keeps working: ordinary entries landing meanwhile
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

**Gated:** exact model-tool commands and owned-conversation helper types below are illustrative until the
ordinary-tool capability design is settled. A subagent is a conversation. There is no separate object to talk to: the model gets one tool with
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
const childInput = await child.send({ content: 'also check CI' }, call);
await childInput.wait(call);
await child.abort(call);
```

`run` keeps the calling tool in flight while it waits for the child's `InputHandle`, so ownership makes the
child part of the parent's foreground cancellation reach. `spawn` settles the tool at once; the child is
excluded from that cleanup policy, runs while the parent goes on, and only `child.abort()` (or `stop`) ends
it. The one Session scheduler executes either child automatically, concurrently with unrelated
conversations. Both survive restart like any other durable work.

## Jobs and Schedules

**Gated:** exact job payloads and convenience methods remain unsettled; the scheduler/task-output behavior
here is required. A job is a background task that runs a process: durable, recoverable, killable, with its task output
streamed through the authoritative view. The model normally gets one from `bash` (asked to background, or run
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
  input: { cmd: 'npm run dev', cwd } }), call);

const nightly = await c.commit(tx => tx.task(jobKind, { background: true,
  input: { cmd: 'npm test', cwd, every: 24 * 3600_000, notBefore: tonightAt(2) } }), call);

await h.abortTask(nightly, call);          // ends the schedule wherever it is
```

A schedule is one running task updating its kind-defined named checkpoint phases across occurrences; there
is no trail of run IDs to chase. A job whose starting call returned early appends a `notice` entry when it finishes, so the
model learns of it on its next turn without polling. Live output stays in shared task-output state; the job
materializes terminal data into its outcome/notice before the final output reference retires.

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
const currentMoves = await c.list(moves).read(call);
const movesAtEntry = await c.list(moves).read(entryId, call); // rewindable only
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
not release the line. Never await external effects, task/input/idle waits or another commit inside a builder.
Known nested Pico line operations reject before queueing instead of deadlocking.

```typescript
const entry = await c.commit(tx => {
  tx.value(planMode).set(false);                                          // rewindable state first
  const id = tx.entry(myPlugin.noteKind, { data: { text: 'plan accepted' } });
  tx.value(expanded).set(true);                                           // sticky state may follow
  tx.task(myPlugin.reminderKind, { background: true,                      // tasks anywhere
    input: { about: id, at: Date.now() + 3600_000 } });
  return id;
}, call);
```

### Appending Entries

`tx.entry` appends immediately and returns the entry id. Use it for entries that are part of what
your task is doing, and for entries the model never sees (`data` only, no `model`).

For model-visible passive content written while a turn may be busy, trusted built-ins use the protected
transaction `write` helper. It appends immediately when admission is idle and otherwise queues for the next
complete post_tools or final-answer boundary. It is intentionally not a public conversation method;
application user input goes through `send`. That is not a style preference: appending a
model-visible entry between an assistant's tool calls and their results changes the prefix the next
request replays, which providers reject and which invalidates Anthropic thinking signatures.
`tx.entry` rejects that one case rather than corrupting the next request, and the error points here.

Only the fixed generation, tool, post_tools and collapse definitions receive the internal
`CoreTaskRuntime`, whose commits provide direct model-entry and protected admission authority. Ordinary
`defineTask` kinds receive `TaskRuntime`/`BaseTaskTx` without those methods. Generation, tool and post_tools
are the fixed turn-task set used for admission; speculative collapse is privileged but outside that set, so
it does not block an idle send.

Two more things when writing entries directly: appending a `user` entry is not the same as asking
for an answer (use `send`), and a head entry may only narrow context,
never widen it, and may not split an exchange.

### Write Order

One rule: rewindable conversation value/list writes must precede entries in the same commit. That
makes state written alongside an entry visible to a fork at that entry while excluding later
commits. Session state and sticky conversation state may appear anywhere because forks never
reconstruct their history; they may therefore reference a new entry id. Tasks may also appear
anywhere. A violating builder call throws before anything is persisted.

## Writing Tools

**Gated:** exact sink and ordinary-tool runtime names below are illustrative, not implementation
instructions. Durable task output and the required streaming, bounded capture, diagnostics, typed details,
usage, control outcomes and job/child cleanup semantics are normative. Do not implement this package until
the final mediated tool API is appended to the normative handoff.

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

A tool never touches the transcript, its siblings or the inbox. Ordinary tool code receives no task or host
commit authority. The built-in `pi.tool` adapter may eventually expose narrow keyed memo, child-task and
owned-conversation operations. Those mediated operations atomically update the parent checkpoint internally;
exact names and types remain gated.

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

A process-running tool is job-first; Pico never adopts an arbitrary unfinished tool promise. The required
trace is:

```text
pi.tool task T owns task output O
internal TX[create background job B sharing O; checkpoint T with B + abortWithTool policy]
kick -> Session scheduler runs B automatically
ordinary tool observes B for its local budget
adapter terminal closure rereads B on the line
  B terminal -> materialize normal result from O
  B live     -> materialize continues-as-B result; terminalize T while B retains O
B eventually materializes final O, terminalizes its last ref, and emits any passive notice atomically
```

Never trust stale timeout or `Promise.race` state. Creation records cleanup policy before returning a child
handle. Fresh tool abort reads that durable record and atomically marks a non-detached live job; an already
terminal job counts as cleaned. The scheduler already runs the job, so waits only observe. The same shared
task output lets the UI keep one `bash` component across tool-to-job handoff without copying a second live
output stream. Exact ordinary-tool handle methods remain gated.

## Hooks

**Gated:** exact hook names, task identity and namespaced scratch capability remain unsettled. The examples
show required semantics, not a final API. Hooks belong to the kind that runs them. A kind declares its points and their types; you register
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

An ordinary task kind declares immutable input, a complete optional checkpoint union,
completed/failed/aborted payloads, optional task-output state and three methods. The generic scheduler
interprets only pending/running/terminal, dependencies, background, abort mark and checkpoint presence. A
checkpoint's `phase` belongs to the kind; it is not a global workflow step.

Here is a reminder that fires once:

```typescript
type ReminderInput = { readonly about: Id; readonly at: number };
type ReminderCheckpoint = { readonly phase: 'firing'; readonly effectKey: string };

export const reminderKind = defineTask<
  ReminderInput,
  ReminderCheckpoint,
  { readonly fired: boolean },
  { readonly message: string },
  { readonly cleaned: boolean }
>()({
  kind: 'myplugin.reminder',

  async execute(task, runtime, call) {
    if (task.input.at > runtime.now()) await runtime.sleep(task.input.at, call);
    await runtime.commit(tx => {
      tx.checkpoint({ phase: 'firing', effectKey: `reminder:${task.id}` });
    }, call); // durable intent before the external effect

    await notifications.fire(task.input.about, `reminder:${task.id}`, call);
    return () => ({ status: 'completed', result: { fired: true } });
  },

  async recover(task, runtime, call) {
    if (!task.checkpoint) return reminderKind.execute(task, runtime, call);
    const fired = await notifications.recover(task.checkpoint.effectKey, call);
    return () => ({ status: 'completed', result: { fired } });
  },

  async abort() {
    return () => ({ cleaned: true });
  },
});
```

The scheduler reserves pending as running before `execute`, and reserves a restored running task for
`recover`, including one with no checkpoint. Methods perform effects outside the line and return a terminal
closure. The Harness invokes that closure once on the line and atomically commits its buffered writes, full
terminal task snapshot and scratch/output retirement. A throwing closure commits nothing and faults the
Session.

Pico's fixed privileged definitions use its internal `defineCoreTask` factory instead. Their callbacks
receive `CoreTaskRuntime`, so `runtime.commit` supplies `CoreTaskTx`. That transaction uses the same
`tx.task(...)` spelling but accepts both ordinary and fixed core tokens:

```typescript
const generationKind = defineCoreTask<GenerationInput, GenerationCheckpoint,
  GenerationResult, GenerationFailure, GenerationAbort, GenerationOutput>()({
  kind: 'pi.generation',

  async execute(task, runtime, call) {
    // ...provider effect...
    return (tx, current) => {
      const toolTaskIds = completedAssistant.toolCalls.map(call =>
        tx.task(toolKind, { input: makeToolInput(current, call) }));
      tx.task(postToolsKind, {
        input: makePostToolsInput(current),
        after: toolTaskIds,
      });
      return { status: 'completed', result: generationResult };
    };
  },

  recover,
  abort,
});
```

An ordinary `BaseTaskTx.task(...)` accepts only ordinary `defineTask` tokens. `defineCoreTask` is not a
plugin API; fixed core definitions cannot be registered, replaced or removed. The fixed dispatcher supplies
the core runtime implementation. The kernel does not inspect core input/checkpoint schemas.

Use `defineStateTask` when one ordinary kind has several named durable recovery phases. It compiles to the same
ordinary `TaskKind`; the scheduler still invokes one outer execute/recover operation and never interprets
those phases. Do not create a giant turn task: built-in conversation work remains generation -> parallel
individual tools -> post_tools -> continuation generation, plus independent collapse and job tasks.

Rules for task authors:

1. Commit a complete checkpoint before an uncertain external effect. Recovery uses immutable input and the
   latest committed checkpoint; it does not recover a JavaScript stack.
2. Effects, hooks, sleeps and waits happen outside transaction callbacks. Inside `runtime.commit`, perform
   explicit committed reads before the first buffered write and use only the supplied `tx` afterwards.
3. Return a terminal closure only after effects and producers finish. Cancellation may discard an uncommitted
   normal closure; fresh `abort` owns cleanup.
4. Prefer immutable `after` dependencies for task prerequisites. Task waits only observe and ensure Session
   resume. Direct self-wait and dependency cycles reject; never race away unfinished work.
5. Keep generic configuration in scoped values, not task snapshots. Persist only compact evidence required
   to recover this kind's effect.

The one scheduler keeps the complete Session live/dependency index on the mutation line and invokes task
methods outside it. Every successful main commit kicks it; scratch/task-output-only commits need not. It
reserves all eligible tasks in every conversation, runs distinct IDs concurrently, and allows at most one
invocation per task ID. Foreground and background both run. Foreground controls idle and ordinary abort
reach only.

A kind may declare task output with `TaskOutputSpec.initial(input)`. Runtime mutates the one authoritative
Chord-tracked output; each nonempty delta persists and appears as `task_output`. Shared refs let a tool hand
output to a background job without copying it. The last live reference materializes final data and retires
the output atomically. Task output is not scratch and there is no separate live-output subsystem.

An unexpected task-contract error faults the Session: observation waits reject, admission stops, running
invocations are signalled and joined, and the binding closes. Domain tool/provider failures must be returned
as typed outcomes. Supply every required ordinary kind during open; a missing live kind is already orphaned
before `inspect` returns and later registration cannot resurrect it. Fixed core kinds are never replaced.

## Recovery

There is nothing to write. After a crash:

```typescript
const h = await Harness.open(storage, opts, call);
await h.resume(call);
```

| what was running | what happens |
|---|---|
| a generation, streaming | its task output contains the partial assistant state; recovery publishes it, then retries within budget or fails |
| a generation, between retries | it sleeps out the remaining backoff and tries again |
| a tool with `replay: 'safe'` | runs again |
| any other tool | an "interrupted" error result; the turn continues |
| a `run` subagent tool | finds its child and waits on the existing input result again |
| a job | reruns if it said so, otherwise records `lost` |
| a scheduled job | sleeps until its time |

Successors are written in the same commit as the settlement that decides them, so a crash never
leaves "the tools finished but nobody started the next turn": post_tools already exists and is
startable.

## Storage Backends

| backend | loads | good for |
|---|---|---|
| `MemoryStorage` | everything | tests, ephemeral sessions |
| `JsonlStorage` | main log plus live scratch/task-output sidecars | local Sessions; the default |
| `SqliteStorage` | only what queries return | long sessions, many sessions in one file, servers |

All three answer the same queries with the same results. Entries are immutable and read whole; indexed
queries select the relevant entries before decoding. Values are stored whole on every set. Lists store
append/remove/clear operations and return one complete coherent logical list in ascending element-ID order;
v1 has no paged list scan. There is no automatic value diffing or Chord storage codec.
Chord deltas are used for task-output/watch delivery. Streaming task output appends compact operations, not
raw provider events with repeated growing partial snapshots.

JSONL reopens by replaying complete main commits, then sidecars for surviving live scratch and shared task
outputs. Per-file `Seq` gaps are expected. Reopen initializes `Storage.nextId()` after the greatest
conversation, entry, task or list-element ID in retained complete canonical writes, and separately restores
the last applied sequence from the greatest retained complete record endpoint. Retired sidecars are
ignored even if unlink failed; their later main settlement already proves retirement.
Only unterminated final lines are discarded and removed before further appends; malformed complete
main/live-scratch batches fail open.

```text
main through Seq 100; live scratch through Seq 150 -> reopen applied Seq 150 and initializes nextId
main settles at Seq 151; unlink fails -> ignore retired scratch; applied Seq remains 151
```

The conformance suite compares one mutation stream across all backends. A repeated whole-value set
can write quadratic bytes when the value grows; incremental lists avoid that without hidden encoding.

```typescript
const storage = await SqliteStorage.open('./sessions.db', { session: 'parser-work' });
```
