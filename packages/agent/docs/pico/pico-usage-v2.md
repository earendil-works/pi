# pico

Durable agent harness. One session file, any number of conversations, every piece of work is a task that
survives a crash, and a view a UI renders directly.

This guide shows how to use it. `pico-handoff-v2.md` is the implementation specification.

- [Mental model](#mental-model)
- [Quick start](#quick-start)
- [Opening, closing, recovery](#opening-closing-recovery)
- [Sending input](#sending-input)
- [Configuration](#configuration)
- [System prompt](#system-prompt)
- [Watching](#watching)
- [Forks, compaction, reset](#forks-compaction-reset)
- [Plugin state](#plugin-state)
- [Writing tools](#writing-tools)
- [Hooks](#hooks)
- [Writing entry kinds](#writing-entry-kinds)
- [Writing task kinds](#writing-task-kinds)
- [Subagents and jobs](#subagents-and-jobs)
- [Storage backends](#storage-backends)

## Mental model

A **session** holds **conversations**. A conversation has:

- a **transcript**: append-only immutable **entries** (user, assistant, tool result, summary, notice, ...);
- **tasks**: units of work (generate, run a tool, compact, run a process). Each survives a crash;
- **state**: keyed values and lists (model in use, plan mode, whatever a plugin needs).

The model **context** is derived from entries, not stored: the newest head entry says where context starts,
edits omit or replace earlier messages. Compaction appends a summary with a head; nothing is rewritten.

All writes go through **commits**: one callback, one atomic batch. Tasks run concurrently, commits serialize.

Every async call takes a Chord `Context` last (`ctx`). It carries cancellation and telemetry. Cancelling a
wait removes the waiter; it never cancels durable work.

## Quick start

```typescript
import { Harness, JsonlStorage, systemSections } from '@earendil-works/pi-agent/pico';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';

const storage = await JsonlStorage.open('./session.jsonl', ctx);
const h = await Harness.open(storage, {
  models: builtinModels(),
  // no `tools`: the ordinary tool API is not settled yet (see Writing tools); this is a tool-free agent
  root: {                                   // applied once, when the session file is new
    config: {
      model: { provider: 'anthropic', modelId: 'claude-opus-5' },
      thinkingLevel: 'high',
    },
  },
}, ctx);

const c = await h.root(ctx);

// System prompt: edit typed sections before each request. Stored when it changes, replayed after a restart.
// Registered on this conversation only: subagents get their own identity (see Subagents).
c.hook.systemInstructions(({ sections }) => {
  sections.set(systemSections.identity, 'You are a careful engineer working in this repository.');
  sections.set(systemSections.environment, { cwd: process.cwd() });
});

// Watch: `w.view` is always current; each delivery is one commit's events.
const w = await c.watch(ctx);
w.start((d) => {
  if (d.type !== 'commit') return;
  for (const e of d.events) {
    if (e.type === 'task_output') process.stdout.write(renderStreaming(w.view.taskOutputs));
    if (e.type === 'entry') console.log(`\n[${e.entry.kind} ${e.entry.id}]`);
    if (e.type === 'config' && e.key === 'model') statusLine.set(e.value);   // typed: ModelRef | undefined
  }
});

// Send: durable, returns at once. Wait for this input's answer.
const input = await c.send({ requestId: 'cli-1', content: 'List the public API of the parser' }, ctx);
const result = await input.wait(ctx);
if (result.status === 'done' && result.answer) console.log(result.answer.message);

// Change settings any time; the next request uses them.
await c.config.model.set({ provider: 'openai', modelId: 'gpt-5.6' }, ctx);

w.unsubscribe();
await h.close(ctx);
```

Kill it mid-run and run it again: the second run recovers the in-flight generation (or job) and continues;
tools will recover the same way once their API lands.

## Opening, closing, recovery

```typescript
const h = await Harness.open(storage, options, ctx);   // inert: nothing runs yet
await h.resume(ctx);                                    // start/recover every eligible task
```

`send`, `wait`, `waitForIdle`, `collapse` and abort operations call `resume` for you. Reads, inspection and
watch do not. After a crash, `open` + `resume` is the whole recovery procedure:

| was running | on resume |
|---|---|
| generation | partial output is restored; request retried or failed within budget |
| tool with `replay: 'safe'` | runs again (once the tool API lands) |
| other tool | "interrupted" error result; the turn continues (once the tool API lands) |
| tool waiting on a child | waits again on the same child (once the mediated child API lands) |
| job | asks the process host for the run's status; if the host still knows it, continues; if not, reruns under the same key if `rerun` (possibly duplicating the effect), else `interrupted`. `nodeProcessHost()` forgets runs on restart |

```typescript
const { pending, running, orphaned, unknownEntryKinds } = await h.inspect(ctx);
```

`orphaned` are live tasks whose kind was not registered at open; they were terminalized. Register all
kinds before opening.

```typescript
await h.close(ctx);      // stop, write nothing; everything resumes next open
await h.shutdown(ctx);   // abort every live task cleanly, keep queued input, then close
```

Options:

| option | |
|---|---|
| `models` | pi-ai models; `generationKind.config.model` is resolved against it |
| `tools` | tool declarations the model may call; not usable yet, the execution API is gated (see Writing tools) |
| `taskKinds`, `entryKinds`, `sections` | plugin kinds and system section definitions |
| `root.config` | initial built-in config (`model`, `thinkingLevel`, `selectedTools`, ...) for a fresh session; ignored on reopen |
| `root.values`, `root.sections`, `rootValues` | advanced: arbitrary initial values / section payloads for the fresh root |
| `processHost` | how `pi.job` runs processes; `nodeProcessHost()` for local jobs (in-memory: forgets runs on restart); omitted means every job fails with reason `spawn` |

Registries supply implementations, not selections: registering `bash` does not select it. Select through
`c.config.selectedTools`. `h.tools`, `h.taskKinds`, `h.entryKinds`, `h.sections` have
`register`/`replace`/`remove` for changes after open; replacing or removing a task kind with live tasks
rejects. Hooks are registered on `h.hooks` or `c.hooks` (below), not in open options.

## Sending input

```typescript
const input = await c.send({ content: 'Inspect the parser', requestId: 'req-1' }, ctx);
input.id;                              // stable input id
await input.result(ctx);               // queued | placed | done | unanswered, no waiting
const r = await input.wait(ctx);       // done | unanswered
await input.abort(ctx);                // aborted | already_placed | not_found

if (r.status === 'done') {
  r.input;                             // UserEntry: the placed user entry
  r.answer?.entry;                     // AssistantEntry, when an answer was owed
  r.answer?.message;                   // the stored AssistantMessage (entry.model[0]); text, thinking, tool calls, usage
} else {
  r.reason;                            // terminated | aborted | failed | stale
  r.input;                             // present if the input had been placed before it went unanswered
}
```

Outcomes come with their entries attached; there is nothing to look up afterwards. `message` is the message as
stored, not the current context projection, so a later edit or compaction does not change what `wait`
returned.

`requestId` makes `send` idempotent for the session: retrying returns the original handle and writes nothing.
`h.input(requestId, ctx)` finds it later.

While the conversation is busy (a generation or tool is live), input is queued:

```typescript
await c.send({ content: 'then write tests' }, ctx);                        // followUp: after the answer
await c.send({ content: 'focus on the tokenizer', whenBusy: 'steer' }, ctx); // steer: at the next tool boundary
await c.send({ content: '...', whenBusy: 'reject' }, ctx);                // throws ConversationBusy
```

Steer joins the current turn after the running tools finish. FollowUp starts a new turn after the final
answer. Both survive restarts. Passive content (a notice the model should see next time) uses `write`:

```typescript
await c.commit((tx) => tx.write(noticeKind, {
  model: [{ role: 'user', content: 'CI finished: 3 failures', timestamp: Date.now() }],
}), ctx);
```

`write` appends immediately if idle, otherwise queues for the next boundary. It never asks for an answer.

There is no "queue this for the next run" mode. If you accumulate context that should not trigger a turn yet
(observations, partial instructions), keep it in your own value or list and fold it into a single `send` when
you do want an answer; use `write` only when a passive transcript entry is the point.

```typescript
await c.waitForIdle(ctx);   // this conversation's foreground work
await h.waitForIdle(ctx);   // whole session
await c.abort(ctx);         // abort this conversation's foreground cancellation set (turn, foreground tasks, owned subagents); withdraws queued steer/followUp
await h.abortTask(id, ctx); // one task; queued input is kept
```

## Configuration

Built-in configuration is a set of typed properties on `c.config`, one per value, plus a batched setter:

```typescript
await c.config.model.set({ provider: 'openai', modelId: 'gpt-5.6' }, ctx);
await c.config.thinkingLevel.set('high', ctx);
await c.config.selectedTools.set(['read', 'grep'], ctx);
await c.config.followUpMode.set('all', ctx);

const model = await c.config.model.get(ctx);                 // current (or the definition's default)
const then  = await c.config.model.get(entryId, ctx);        // as of an entry (rewindable values only)
const mode  = await c.config.followUpMode.get(ctx);          // sticky: current only

// several at once, one commit; keys and value types are exact
await c.config.set({ model: { provider: 'openai', modelId: 'gpt-5.6' }, thinkingLevel: 'low', followUpMode: 'all' }, ctx);
const all = await c.config.get(ctx);
```

| property | type | default | rewindable |
|---|---|---|---|
| `model` | `ModelRef` (`{ provider, modelId }`) | none: generation fails `no_model` | yes |
| `thinkingLevel` | `ThinkingLevel` (`off` … `xhigh`, `max`) | `'off'` | yes |
| `selectedTools` | `string[]` | `[]` | yes |
| `profile` | `string` | `'default'` | yes |
| `retry` | pi-ai `RetryPolicy` | `{ enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000 }` | no |
| `steeringMode`, `followUpMode` | `'all' \| 'one-at-a-time'` | `'one-at-a-time'` | no |
| `threshold` | `number` (context tokens; 0 = never) | `0` | yes |
| `keepRecent` | `number` (tokens kept after compaction) | `20000` | yes |

Defaults live on the definitions and are what `get`, `view.config` and `config` events return when nothing is
set; `delete` restores them. The types say so: `c.config.followUpMode.get(ctx)` is `'all' | 'one-at-a-time'`,
never `undefined`; only `model` (no default) can be `undefined`.

These are the same definitions the built-in tasks read (`generationKind.config.model` and friends). Each kind
exports a typed bundle of reusable conversation-value definitions; `c.config` is assembled from all of them,
so there is no second schema, and a name clash between kinds or with `set`/`get` is a compile error. The
definitions carry no conversation ID; the handle binds them, and you can pass them anywhere a conversation
value is accepted (`c.value(generationKind.config.model)`, `root.values`, child seeds). Plugin configuration is
not in `c.config`; plugins declare their own values and use `c.value(token)`.

Rewindable means a fork at yesterday's answer gets yesterday's model. Queue modes are sticky: they describe
how you want the present handled, not history. The next generation reads current values; nothing is cached.

## System prompt

Pico sends pi-ai `{ messages }` only. Instructions and the tool loadout are system messages inside the
transcript at the position they took effect, so the model's cached prefix survives a change and a fork sees
exactly what its source saw.

Sections are typed tokens with a renderer. A `systemInstructions` hook edits a draft before each request:

```typescript
import { defineSystemSection, systemSections } from '@earendil-works/pi-agent/pico';
import { generationKind } from '@earendil-works/pi-agent/pico/kinds';

const rules = defineSystemSection<string[]>({
  key: 'myplugin.rules',
  render: (r) => r.map((x) => `- ${x}`).join('\n'),
});
await h.sections.register(rules, ctx);

// host, harness-wide: sets the authoritative base every time, so it runs first
h.hooks.on(generationKind, generationKind.hooks.systemInstructions, ({ sections }) => {
  sections.set(systemSections.identity, 'You are a coding assistant.');
  sections.set(systemSections.skills, skillsCache.current);
  sections.set(rules, ['Run relevant tests.']);
});

// plugin, on this conversation: runs after the host and modifies typed payloads, never parses prose
c.hook.systemInstructions(({ sections }) => {
  sections.set(rules, [...(sections.get(rules) ?? []), 'Check migration safety.']);
  sections.wrap(rules, (text) => `Repository policy:\n${text}`);
});

// rare: override the loadout for this request instead of c.config.selectedTools
c.hook.systemInstructions(({ tools }) => ({ tools: tools.filter((t) => t.name !== 'bash') }));
```

Handlers run harness-wide first, then outer conversation to inner, on one draft; the plugin above therefore
sees the host's base. Registration is synchronous and process-local (it returns an unsubscribe function);
`h.sections.register` is asynchronous because the section registry is shared state. `get` returns a copy;
`set` keeps an existing key's position; `delete` is explicit (null is a value); `wrap` transforms rendered
text and is not stored. A throwing handler loses only its own edits. The tool loadout is
`c.config.selectedTools` resolved against `h.tools`; a handler that returns `tools` overrides it for that
request.

After the hooks, the draft is compared to what was last stored. No change: nothing is written. A change:
one `pi.system` entry with the changed sections' payload and rendered text, and a system message with
`toolsRemoved`/`toolsAdded`. After a compaction or reset, the next request gets a fresh complete baseline.
A plugin that disappears leaves its rendered text in place until someone deletes the section.

Because handlers rerun on every preparation, a handler that appends to what it reads accumulates unless an
earlier handler resets the base. Make the chain idempotent as a set.

## Watching

```typescript
const w = await c.watch({ values: [planMode], lists: [moves] }, ctx);   // or c.watch(ctx); === h.watchConversation(c.id, ...)
w.view;                 // ConversationView, captured atomically with the subscription
w.start((d) => {        // one delivery per commit: { type: 'commit', first, last, events } | { type: 'closed', reason }
  if (d.type === 'commit') for (const e of d.events) { /* w.view is already updated */ }
});
w.unsubscribe();
```

```typescript
// abbreviated sketch; the exact readonly declarations are in the handoff, section 14
interface ConversationView {
  conversation: Conversation;
  entries: Entry[];           // the active transcript in order: everything from the newest head's boundary through now
  context: Id[];              // entry ids the model currently sees, derived from entries
  tasks: Task[];              // live tasks in this conversation
  taskOutputs: { id: Id; kind: string; value: OutputState }[];   // streaming assistant text, tool progress
  inbox: Element<QueuedInput>[];
  config: { model?, thinkingLevel, selectedTools, profile, retry, steeringMode, followUpMode, threshold, keepRecent };  // defaults resolved: every key except model is present and never undefined
  values: { address: Value; value?: JsonValue }[];       // only what you asked for in { values: [...] }
  lists:  { address: List; elements: Element[] }[];      // only what you asked for in { lists: [...] }
  readAt: Seq;
}
```

A requested list is captured whole and then kept current by `list` events (`append`/`remove`/`clear` ops in
commit order, already folded when the listener runs). Built-in config cannot be requested as a value; it is
always in `view.config`.

`view.config` has the same properties as `c.config`, so a status line reads `view.config.model` and a settings
panel binds to it directly; nothing needs to be requested. `values` is for your own state (`planMode` above).

Built-in config changes arrive as their own event, typed by key:

```typescript
w.start((d) => {
  if (d.type !== 'commit') return;
  for (const e of d.events) {
    if (e.type === 'config') {
      // e.key narrows e.value / e.previous
      if (e.key === 'model') statusLine.setModel(e.value);            // ModelRef | undefined
      if (e.key === 'selectedTools') toolbar.set(e.value);             // readonly string[]: defaulted, never undefined
    }
    if (e.type === 'value') plugins.update(e.value.address, e.value.value);           // your requested values
    if (e.type === 'list') board.render(w.view.lists);                                 // ops already folded
  }
});
```

`c.config.set({ model, followUpMode })` yields two `config` events in the same delivery; `w.view.config` already
reflects both when the listener runs. Read the initial state from `w.view.config`, then follow events.

The listener is a wake-up: `w.view` is already updated when it runs. A renderer that only looks at the view is
correct.

`entries` is what the conversation is currently working with, in transcript order, not a fixed number of
recent entries. It is captured once and then maintained incrementally: an ordinary entry appends; an entry that
carries a `head` (summary, reset, handoff) first drops the entries before its retained boundary and then
appends itself, all within the same delivery. A summary therefore sits after the entries it retains (the model
sees it first; that is context projection, not the view). A reset or handoff points at itself, so it clears the
list and becomes the first entry. The older transcript is still in storage and readable through `h.entries({ conversationId: c.id, limit: 50 }, ctx)` (newest first, paged) and `h.getEntry`, it just is
not part of the live view. There is no window size to tune.

| you want | look at |
|---|---|
| in a turn | `view.tasks` has a `pi.generation`/`pi.tool`/`pi.post_tools` |
| streaming text | `view.taskOutputs` entry for the generation's `output.id` |
| a tool running | `pi.tool` task; its `output` for progress |
| retrying | generation `checkpoint.phase === 'retrying'` |
| current model / tools / thinking | `view.config.model`, `.selectedTools`, `.thinkingLevel`; changes: `config` event with `key`/`value`/`previous` |
| compacting | `pi.collapse` task present |
| queued input | `view.inbox` |

Overflow (listener too slow, 256 commits buffered) closes the watch with `{ type: 'closed', reason:
'overflow' }`. Open a new one; its view is the fresh truth.

Remote UIs: ship `w.view` once, then every delivery. `applyConversationCommit(view, commit)` is exported and
needs no kinds.

```typescript
const sw = await h.watchSession({ values: [sessionName] }, ctx);   // conversation list, session values
```

### Plugin state in a UI

Requested Pico values and lists (as in the watch above) are for the process that owns the Harness: the plugin's
session-side facet, or a host renderer in the same process. Pico does not push plugin state to remote UIs. A
plugin that has something to show elsewhere follows the Chord facet pattern
used by `coding-agent/examples/plugins/pi-example-plugin` and the experimental `models-provider` /
`transcript-provider` services:

```typescript
// contract.ts: what the UI may see and call
export interface PlanService {
  readonly state: ReplicatedState<{ active: boolean; steps: string[] }>;
  toggle(input: { active: boolean }, ctx: Context): Promise<void>;
}
export const PlanService = defineService<PlanService>('myplugin.plan');

// session.ts: runs beside the Harness; Pico is the durable truth, the replicated state is a projection
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
export default defineFacet({
  id: 'myplugin/session',
  setup(env) {
    const state = env.replicatedState({ active: false, steps: [] });
    env.provide(PlanService, {
      state,
      async toggle({ active }, ctx) {
        await c.value(planMode).set(active, ctx);          // durable
        state.state.active = active; state.publish(ctx);    // live
      },
    });
    env.onActivate(async () => {                           // reopen: rebuild the projection from Pico
      state.state.active = (await c.value(planMode).get(BACKGROUND_CONTEXT)) ?? false;
      state.publish(BACKGROUND_CONTEXT);
    });
  },
});

// tui.ts: never sees the Harness or addresses
export default defineFacet({
  id: 'myplugin/tui',
  setup(env) {
    const plan = env.use(PlanService);
    env.onActivate(() => env.own(plan.state.subscribe((value) => badge.set(value.active))));   // (value, context, delivery) => void
  },
});
```

Built-in config is the exception and is automatic (`view.config`); everything else a UI should see is a
service DTO the plugin defines.

## Forks, compaction, reset

```typescript
const alt = await c.fork({ at: entryId }, ctx);              // shares history through entryId; independent after
const alt2 = await c.fork({ at: 'start' }, ctx);             // empty transcript, same session
const back = await c.fork({ at: earlier, abort: true }, ctx); // "go back": abort the source's turn first
await alt.send({ content: 'try recursive descent instead' }, ctx);
```

Forks inherit rewindable state (model, tools) and the system messages visible at the fork point. They inherit
no tasks and no queued input. Nothing in the source changes.

```typescript
const taskId = await c.collapse({ instructions: 'keep API decisions verbatim' }, ctx);
await h.getTask(taskId, ctx);
```

Manual compaction runs in the background while the model keeps working; it declines with `NothingToCollapse`
if everything already fits in `keepRecent`. Threshold compaction is created by generation automatically when the
context estimate crosses `threshold` and runs in the foreground (aborting the conversation aborts it too). Both append a `pi.summary` entry with a head; the transcript keeps everything.

```typescript
await c.reset({ handoff: 'We settled on recursive descent; continue from the lexer.' }, ctx);
await c.reset(ctx);              // /clear
```

Reset appends a `pi.handoff` or `pi.reset` entry with `head: self`. If the conversation is busy it is queued for
the next boundary; either way `reset` resolves once the request is durable, and the entry shows up in the watch
when it lands.

## Plugin state

```typescript
import { conversationValue, conversationList, sessionValue } from '@earendil-works/pi-agent/pico';

type Move = { readonly x: number; readonly y: number };
const planMode = conversationValue<boolean>('plan.mode', { rewind: true });
const moves    = conversationList<Move>('game.moves', { rewind: true });
const expanded = conversationValue<boolean>('ui.expanded', { rewind: false });
const name     = sessionValue<string>('app.name');

await c.value(planMode).set(true, ctx);                   // c binds it to its own conversation
await c.value(planMode).get(ctx);
await c.value(planMode).get(entryId, ctx);                // rewindable only
const id = await c.list(moves).append({ x: 1, y: 2 }, ctx);
await c.list(moves).read(entryId, ctx);
await c.list(moves).remove(id, ctx);
await h.value(name).set('parser work', ctx);

planMode.bind(otherConversationId)                        // explicit Value<boolean> when you need one
```

A conversation address is declared once and bound when used. It carries rewind policy and payload type.
Your definitions work everywhere: `c.value`, commits, `root.values`, child seeds, watch `values`. Pico's
built-in config tokens (`generationKind.config.model` and friends) are exported and work the same way. Pico's
internals (inbox, input results, request receipts, task output) are not addressable through any
generic handle; they surface only as `view.inbox`, `InputHandle` and `view.taskOutputs`, and you cannot define
values in those namespaces.

Anything that must land together goes in one commit (assumes `noteKind` and `reminderKind` are registered, see
below; a kind object that is not the registered one is rejected as `StaleDefinition`):

```typescript
const id = await c.commit(async (tx) => {
  const current = await tx.value(planMode).get();   // reads first
  tx.value(planMode).set(!current);                 // rewindable state before entries
  const note = await tx.write(noteKind, { data: { text: 'toggled' } });
  tx.task(reminderKind, { background: true, input: { about: note, at: Date.now() + 3600_000 } });
  return note;
}, ctx);
```

Rules inside a commit: reads before the first write (`ReadAfterWrite` otherwise); rewindable writes before
entry appends; no awaiting anything but `tx` reads; a throw discards everything.

## Writing tools

**The ordinary tool API is not settled.** This is the one deliberate gap in Pico v1: what a tool's `execute`
receives and how it streams progress is still being decided, so nothing in this section is a compile contract.
What *is* settled:

- A tool declares `name`, `description`, `parameters` (TypeBox schema), `replay: 'safe' | 'unsafe'` (may the
  call be rerun after a crash) and `output` bounds (`maxBytes`, `maxLines`, `retain`).
- A tool returns a `ToolResult`: `content` (text/images the model reads), typed `details` for UIs, `isError`,
  `usage`, `diagnostics` (commentary about the call, rendered after the output), and optional `control`.
- `control`: `{ terminate: true }` ends the turn after this exchange; `{ handoff: message }` ends it and resets
  context with that message (what `new_context` does); `{ addTools: [...] }` adds tools to `selectedTools` so
  the very next model request (normally the continuation right after this tool round) already offers them.
- Pico enforces the output bounds, reports truncation, stores the exact model message in the result entry and
  the rest in its data, and streams the tool's live progress as the tool task's output (`view.taskOutputs`).
- A throw becomes an `isError` result; it never faults the session. Tools cannot touch the transcript, the task
  or the inbox, and get no commit authority.
- Not yet available: durable per-call memos, starting a background job from a tool, starting a subagent from a
  tool. Requirements are fixed (keyed and idempotent across a crash, cleanup policy recorded before the tool
  returns, a wait timeout never cancels the child, a job is a task and a subagent is a conversation) but the
  API shape is not. Until it is, the built-in `bash` cannot background and there is no `subagent` tool.

Illustration only (the `execute` signature and the `tool` facade are the gated part):

```typescript
// ILLUSTRATIVE, not the final API
const params = Type.Object({ path: Type.String(), pattern: Type.Optional(Type.String()) });

export const countLines = {
  name: 'count_lines',
  description: 'Count lines in a file',
  parameters: params,
  replay: 'safe',
  output: { maxBytes: 64_000, maxLines: 200, retain: 'head' },
  async execute(args /* Static<typeof params> */, tool /* gated facade */, ctx) {
    const lines = (await fs.readFile(args.path, 'utf8')).split('\n');
    const matching = args.pattern ? lines.filter((l) => l.includes(args.pattern!)) : lines;
    return {
      content: [{ type: 'text', text: matching.join('\n') }],
      details: { lines: lines.length },
      diagnostics: matching.length > 200 ? [{ severity: 'warn', message: `showing 200 of ${matching.length}` }] : [],
    };
  },
};
```

## Hooks

Hooks belong to the task kind that runs them; each kind declares its own typed points. The built-in points are
flattened onto `c.hook`, one method each: `systemInstructions`, `beforeRequest`, `afterResponse`, `onYield`,
`beforeTool`, `afterTool`, `afterTools`, `beforeCollapse`. Each is the generic
`c.hooks.on(kind, kind.hooks.point, handler, { subtree })` with kind and point bound; `h.hooks.on(...)`
registers harness-wide. Plugin kinds use the generic form with their own point tokens. Input, output and
failure behaviour come from the point:

```typescript
import { toolKind } from '@earendil-works/pi-agent/pico/kinds';   // only for the generic form

// conversation-scoped, named
c.hook.beforeTool(async ({ call }, { conversationId }, ctx) => {   // a `block` from an earlier handler already stopped the chain
  if (call.name === 'write' && await c.config.profile.get(ctx) === 'plan')
    return { block: { reason: 'plan mode: no edits' } };
  if (call.name === 'bash' && !(await ui.approve(call.arguments, ctx)))
    return { block: { reason: 'denied by user' } };
  return { call: { ...call, arguments: normalize(call.arguments) } };   // may rewrite arguments
}, { subtree: true });                                     // shared policy: applies to subagents this conversation owns too

c.hook.afterTool(async ({ call, result }) => { metrics.record(call.name); });
c.hook.beforeRequest(async ({ request }) => ({ request: withTracing(request) }));
c.hook.onYield(async ({ answer }, { conversationId }, ctx) => {
  if (await goalIncomplete(conversationId, ctx)) return { continue: 'The goal is not met yet; continue.' };
});
c.hook.beforeCollapse(async ({ reason, entries }) => {
  if (reason === 'manual' && entries.length < 10) return { decline: true };
});

// harness-wide, generic
h.hooks.on(toolKind, toolKind.hooks.beforeTool, handler);   // same as c.hook.beforeTool, for every conversation
h.hooks.on(myKind, myKind.hooks.myPoint, handler);          // your own kinds' points, by token
```

| kind | point | returns | several handlers | on throw |
|---|---|---|---|---|
| generation | `systemInstructions` | draft edits; `{ tools? }` | all run | its edits dropped, skipped |
| generation | `beforeRequest` | `{ request? }` | chained: each output is shallow-merged into the input the next handler sees | skipped |
| generation | `onYield` | `{ continue: string }` or nothing | first non-void answer wins | skipped |
| generation | `afterResponse` | nothing | all run | reported |
| tool | `beforeTool` | `{ call? }` or `{ block }` | chained (patch); `block` stops the chain | **blocks the tool** |
| tool | `afterTool` | `{ result? }` | chained (patch) | skipped |
| post_tools | `afterTools` | nothing | all run | reported |
| collapse | `beforeCollapse` | `{ decline }` or `{ instructions?, summary? }` | first answer wins | skipped |

Hooks run outside the commit line and may take as long as they like (a human approval is a hook that waits).
They may run again after a crash; key external side effects. Cancellation always propagates. `onYield`'s
`continue` appends a user entry and starts another generation for the same input; if the user typed something
meanwhile, that wins and the yield decision is dropped.

Your own task kinds declare points the same way (see below); `h.hooks.on(myKind, myKind.hooks.myPoint, ...)` then
type-checks against your declaration.

## Writing entry kinds

```typescript
import { defineEntry, type EntryBase, type EntryData, type ModelProjection } from '@earendil-works/pi-agent/pico';

type NoteEntry = EntryBase & EntryData<{ text: string }>;
export const noteKind = defineEntry<NoteEntry>('myplugin.note');
await h.entryKinds.register(noteKind, ctx);   // or pass it in Harness.open({ entryKinds: [noteKind] })

// Data-only: the model sees nothing. `write` resolves with its admission/input id, not the later entry id;
// the committed entry appears in the watch.
await c.commit((tx) => tx.write(noteKind, { data: { text: 'plan accepted' } }), ctx);

type PinnedEntry = EntryBase & EntryData<{ text: string }> & ModelProjection<UserMessage>;
export const pinnedKind = defineEntry<PinnedEntry>('myplugin.pinned');
await h.entryKinds.register(pinnedKind, ctx);
const text = 'Always run the tests before claiming a fix works.';
await c.commit((tx) => tx.write(pinnedKind, {
  data: { text },
  model: [{ role: 'user', content: `<pinned>${text}</pinned>`, timestamp: Date.now() }],
}), ctx);

// later, from a watch event or an entry scan:
const entry = await h.getEntry(entryId, ctx);
if (noteKind.is(entry)) console.log(entry.data.text);
```

An entry may also carry `head` (context starts here) and `edits` (omit/replace earlier messages). A missing
plugin loses typed access, not context behaviour: facets are stored.

## Writing task kinds

```typescript
import { defineTask } from '@earendil-works/pi-agent/pico';

type Input = { readonly about: Id; readonly at: number };
type Checkpoint = { readonly phase: 'firing'; readonly key: string };

export const reminderKind = defineTask<Input, Checkpoint, { fired: boolean }, { message: string }, null>()({
  kind: 'myplugin.reminder',

  async execute(task, rt, ctx) {
    if (task.input.at > rt.now()) await rt.sleep(task.input.at, ctx);
    await rt.commit((tx) => tx.checkpoint({ phase: 'firing', key: `reminder:${task.id}` }), ctx);
    await notifications.fire(task.input.about, `reminder:${task.id}`, ctx);
    return () => ({ status: 'completed', result: { fired: true } });
  },

  async recover(task, rt, ctx) {
    if (!task.checkpoint) return reminderKind.execute(task, rt, ctx);   // crashed before the checkpoint: nothing external happened
    // the checkpoint proves we intended to fire; the call is keyed, so firing again is safe if it did not land
    if (!(await notifications.check(task.checkpoint.key, ctx))) {
      await notifications.fire(task.input.about, task.checkpoint.key, ctx);
    }
    return () => ({ status: 'completed', result: { fired: true } });
  },

  async abort() {
    return () => null;
  },
});

await h.taskKinds.register(reminderKind, ctx);   // fine for a fresh session. Once tasks of this kind can exist across restarts,
                                                 // pass it in Harness.open({ taskKinds: [reminderKind] }) on every open: open orphans
                                                 // live tasks whose kind is not registered *at open*, and nothing resurrects them
const id = await c.commit((tx) => tx.task(reminderKind, { background: true, input: { about: entryId, at: Date.now() + 3600_000 } }), ctx);
const task = await h.getTask(id, ctx);
```

The contract:

1. Pico marks the task `running` before calling `execute`. Commit a checkpoint before any external effect you
   would need to reconcile after a crash.
2. `execute`/`recover` do their effects, then return a closure. Pico runs the closure on the commit line; its
   writes, the outcome and scratch cleanup commit atomically. Do not perform effects in the closure.
3. `recover` is called instead of `execute` when a running task is found at open. Read `task.checkpoint` and
   decide.
4. On abort, the old invocation is signalled through `ctx` and its later writes rejected. `abort` then runs
   as a fresh call for cleanup and returns its own closure.
5. `after: [ids]` runs the task after those are terminal (any outcome). `rt.waitForTask(id, ctx)` observes.
6. Configuration lives in scoped values, not in task input. Task input is what recovery needs.
7. A task may `tx.write(...)` a passive entry (a notice) in any commit or in its terminal closure. It lands
   now if the conversation is idle, at the next boundary if busy. Tasks never append directly and never ask
   for an answer; that is `send`.

A kind may declare hook points. It decides when to run them; handlers registered on `h.hooks`/`c.hooks` for
this kind and point are invoked outside the line:

```typescript
import { defineHookPoint } from '@earendil-works/pi-agent/pico';

export const deployKind = defineTask<DeployInput, DeployCheckpoint, DeployResult, DeployFailure, null>()({
  kind: 'myplugin.deploy',
  hooks: {
    beforeDeploy: defineHookPoint<{ target: string }, { approve: false; reason: string } | { approve: true }>({
      fold: 'first', onThrow: 'abort',
    }),
  },
  async execute(task, rt, ctx) {
    const decision = await rt.hooks.run(deployKind.hooks.beforeDeploy, { target: task.input.target }, ctx);
    if (decision.threw || decision.output?.approve === false)
      return () => ({ status: 'failed', failure: { message: 'deployment declined' } });
    ...
  },
  ...
});

await h.taskKinds.register(deployKind, ctx);
h.hooks.on(deployKind, deployKind.hooks.beforeDeploy, async ({ target }, info, ctx) =>
  (await ui.approve(`deploy to ${target}?`, ctx)) ? { approve: true } : { approve: false, reason: 'denied' });
```

`fold` says how several handlers combine (`collect` all outputs, `first` non-void wins, `chain` shallow-merges
each handler's patch into the input the next handler sees). `onThrow` says whether a throwing handler is skipped
or stops the point.

Kinds declaring `output` get `rt.output` (read/mutate/replace) whose deltas stream to watchers:

```typescript
// abbreviated: recover/abort omitted
type Progress = { pct: number; log: string[] };
const progressKind = defineTaskOutput<Progress>('myplugin.progress');
defineTask<{ readonly steps: number }, never, { readonly done: true }, { readonly message: string }, null, Progress>()({
  kind: 'myplugin.long',
  output: { kind: progressKind, initial: () => ({ pct: 0, log: [] }) },
  async execute(task, rt, ctx) {
    await rt.output.mutate((o) => { o.pct = 50; o.log.push('halfway'); }, ctx);
    return () => ({ status: 'completed', result: { done: true } });
  },
  // ...
});
```

## Subagents and jobs

A subagent is a conversation owned by the task that created it. There is no subagent task and no subagent
object; the model will get one tool, the API gets a conversation handle. The tool-side operation is not yet
specified (see Writing tools). What is settled: a child never inherits the parent's `c.config` implicitly. Its
creator seeds `model`, `selectedTools`, `profile` and any other definitions it wants, plus initial system
section values, in the same commit that creates the child and accepts its first input, so the first
generation already sees them. A child created without a first input is inert; register its hooks and set its
config, then `send`. From the host a subagent is just another conversation: `h.conversation(id,
ctx)`, `h.conversations({ owner, limit: 100 }, ctx)`. Its own `systemInstructions` hooks (registered on the child
handle or inherited via `subtree`) give it its own identity. Aborting the owning tool call aborts it unless
the (gated) child API created it with `abortWithTool: false`.

A job is a process:

```typescript
// Harness.open(storage, { ..., processHost: nodeProcessHost() }, ctx)  -- without a host, jobs fail with reason 'spawn'
const id = await c.commit((tx) => tx.task(jobKind, {
  background: true,
  input: { command: 'npm', args: ['run', 'dev'], cwd, notify: false, rerun: true },
}), ctx);
await h.abortTask(id, ctx);   // SIGTERM, then SIGKILL
```

`nodeProcessHost()` keeps runs in memory only: after a restart it no longer knows them, so a job either
reruns (`rerun: true`, same key, possibly repeating the effect) or fails `interrupted`. A supervising host can
do better; that is the host's contract, not Pico's.

Its stdout/stderr tail (and how many bytes were dropped) is in its task output; `notify: true` appends a `pi.notice` when it finishes (per occurrence for a schedule) so the
model sees it on its next request (which may be the continuation of the current turn).

## Storage backends

```typescript
MemoryStorage.create()                                     // tests
await JsonlStorage.open('./session.jsonl', ctx)            // local; one file plus live sidecars
await SqliteStorage.open('./sessions.db', { session: 'parser' }, ctx)   // many sessions, servers
```

Same behaviour everywhere. JSONL and SQLite take a cross-process lock; a second writer fails rather than
racing.
